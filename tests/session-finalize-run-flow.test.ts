import { afterEach, describe, expect, it, vi } from "vitest";

const notices: Array<[string, number | undefined]> = [];
vi.mock("obsidian", () => {
  class TFile { constructor(public path = "") {} }
  return {
    TFile,
    Notice: class Notice { constructor(message: unknown, timeout?: number) { notices.push([String(message), timeout]); } },
    normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
  };
});

import * as obsidian from "obsidian";
import { runSessionFinalization, type SessionFinalizeRunPort } from "../src/notes/session-finalize-run-flow";
import type { RecordingSession, Segment } from "../src/shared/types";
import { t } from "../src/shared/i18n";

afterEach(() => { notices.length = 0; });

function setup(options: { layout?: boolean; configIssue?: string; segments?: Segment[]; source?: string } = {}) {
  const file = new obsidian.TFile("Notes/session.md");
  const session: RecordingSession = {
    id: "session-1", sessionStamp: "stamp", startedAt: "2026-10-09T10:00:00.000Z", mdPath: file.path,
    mode: "synthesis", segments: options.segments ?? [{ index: 0, startOffsetMs: 0, endOffsetMs: 60_000, text: "A usable transcript." }], finalized: false,
    source: options.source,
  };
  const events: string[] = [];
  const queue: unknown[] = [];
  const settings = { autoOpenNoteAfterFinish: false, sedimentAutoExtract: false, llmEndpoint: "", llmModel: "", consolidatedLayout: options.layout ?? true };
  const port: SessionFinalizeRunPort = {
    hasQueue: () => true,
    updateQueueTask: vi.fn(async () => undefined), removeQueueTask: vi.fn(async () => undefined),
    discardShortRecordingNote: vi.fn(async () => undefined), logDiagnostic: vi.fn(async (_level, code) => { events.push(`diag:${code}`); }),
    endSession: vi.fn(() => { events.push("end"); }), requestOutlineRefresh: vi.fn(() => { events.push("refresh-outline"); }),
    getSettings: () => settings,
    getLlmConfigIssue: () => options.configIssue ?? "",
    getVault: () => ({ getAbstractFileByPath: vi.fn(() => file), read: vi.fn(async () => "A note body") }),
    openFile: vi.fn(async () => undefined), readSilenceTicks: () => ({ voiced: 0, silent: 0 }),
    setProgress: vi.fn((_session, patch) => { events.push(`stage:${patch.stage}`); }),
    cleanupSuccessfulSegmentAudio: vi.fn(async () => undefined), removeEmptySessionBlock: vi.fn(async () => { events.push("remove-empty"); }),
    appendPolishBlock: vi.fn(async () => { events.push("append"); }), rewriteConsolidated: vi.fn(async () => { events.push("rewrite"); }),
    renameWithGeneratedTitle: vi.fn(async () => null), refreshNoteIndex: vi.fn(async () => undefined), autoExtractSediment: vi.fn(),
    syncTranscriptAudioSource: vi.fn(async () => undefined), confirmSpeakerNames: vi.fn(async (_session, segments) => ({ segments, frontmatter: null })),
    processMeetingWorkbench: vi.fn(async () => undefined), ensureRealtimeOutline: vi.fn(async () => undefined),
    mergeAndPolish: vi.fn(async () => { events.push("merge"); return "Polished note"; }), clearCommittedBriefingCheckpoint: vi.fn(async () => undefined),
    addQueueTask: vi.fn(async (task) => { queue.push(task); }), requestDeferredAsrRetry: vi.fn(), requestTaskQueueRetry: vi.fn(),
    beginTaskMeter: vi.fn(() => null), endTaskMeter: vi.fn(() => null), logCompletedWork: vi.fn(),
    saveVersion: vi.fn(async () => undefined), formatNow: (format) => `M:${format}`, buildTitleSource: () => "Fallback title",
  };
  return { port, session, events, queue, settings, file };
}

describe("session finalization flow consumer contract", () => {
  it("removes empty recording notes and ends the session without attempting merge", async () => {
    const fixture = setup({ segments: [] });
    await runSessionFinalization(fixture.port, fixture.session);
    expect(fixture.port.removeEmptySessionBlock).toHaveBeenCalledWith(fixture.session);
    expect(fixture.port.mergeAndPolish).not.toHaveBeenCalled();
    expect(fixture.port.endSession).toHaveBeenCalledWith(fixture.session);
    expect(notices).toEqual([[t("⏭ This recording was too short or had no valid audio; skipped"), undefined]]);
  });

  it("preserves non-retryable configuration failures as blocked tasks and writes the failure marker", async () => {
    const fixture = setup({ configIssue: "model configuration is invalid" });
    await runSessionFinalization(fixture.port, fixture.session);
    expect(fixture.port.mergeAndPolish).not.toHaveBeenCalled();
    expect(fixture.queue).toHaveLength(1);
    expect(fixture.queue[0]).toMatchObject({ type: "merge", status: "blocked", lastError: "model configuration is invalid" });
    expect(fixture.port.requestTaskQueueRetry).not.toHaveBeenCalled();
    expect(fixture.port.appendPolishBlock).toHaveBeenCalledWith(fixture.session, "", expect.any(Error), true);
    expect(fixture.session.finalizationError).toBe("model configuration is invalid");
    expect(fixture.events).toContain("stage:merge-failed");
  });

  it("runs the success path in order and publishes completion before ending the session", async () => {
    const fixture = setup();
    await runSessionFinalization(fixture.port, fixture.session);
    expect(fixture.events).toContain("merge");
    expect(fixture.port.rewriteConsolidated).toHaveBeenCalledWith(fixture.session, "Polished note");
    expect(fixture.port.cleanupSuccessfulSegmentAudio).toHaveBeenCalledWith(fixture.session);
    expect(fixture.events.indexOf("rewrite")).toBeLessThan(fixture.events.indexOf("end"));
    expect(fixture.events.indexOf("stage:done")).toBeLessThan(fixture.events.indexOf("end"));
    expect(notices.at(-1)?.[0]).toBe(t("QnALog processing completed"));
  });

  it("queues retryable merge failures and retains the retry reason", async () => {
    const fixture = setup();
    vi.mocked(fixture.port.mergeAndPolish).mockRejectedValueOnce(new Error("request timed out"));
    await runSessionFinalization(fixture.port, fixture.session);
    expect(fixture.queue[0]).toMatchObject({ status: "pending", lastError: "request timed out" });
    expect(fixture.port.requestTaskQueueRetry).toHaveBeenCalledWith(1500, "briefing-finalization-failure");
    expect(fixture.events).toContain("stage:merge-retrying");
    expect(fixture.port.appendPolishBlock).toHaveBeenCalledWith(fixture.session, "", expect.any(Error), false);
  });

  it("keeps write failures retryable without claiming the task is a model-merge failure", async () => {
    const fixture = setup();
    vi.mocked(fixture.port.rewriteConsolidated).mockRejectedValueOnce(new Error("disk is read-only"));
    await runSessionFinalization(fixture.port, fixture.session);
    expect(fixture.queue[0]).toMatchObject({ type: "merge", lastError: t("Failed to write the minutes: {0}").replace("{0}", "disk is read-only") });
    expect(fixture.queue[0]).not.toHaveProperty("status");
    expect(fixture.port.requestTaskQueueRetry).toHaveBeenCalledWith(1500, "briefing-write-failure");
    expect(fixture.port.refreshNoteIndex).not.toHaveBeenCalled();
    expect(fixture.session.finalizationError).toBe("disk is read-only");
    expect(fixture.events).toContain("diag:briefing.commit_failed");
  });

  it("skips realtime outline generation for text imports and uses the text-import completion label", async () => {
    const fixture = setup({ source: "text-import" });
    await runSessionFinalization(fixture.port, fixture.session);
    expect(fixture.port.ensureRealtimeOutline).not.toHaveBeenCalled();
    expect(fixture.events).not.toContain("stage:outline");
    expect(fixture.port.mergeAndPolish.mock.calls[0][2].duration).toBe("");
    expect(fixture.port.logCompletedWork).toHaveBeenCalledWith(t("Text organization completed"), fixture.session.mdPath, null);
  });

  it("keeps continuation recordings separate and does not clean or index the target", async () => {
    const fixture = setup();
    fixture.session.continuation = { targetPath: "Notes/target.md" } as never;
    vi.mocked(fixture.port.beginTaskMeter).mockReturnValue({ meter: true });
    await runSessionFinalization(fixture.port, fixture.session);
    expect(fixture.port.mergeAndPolish).not.toHaveBeenCalled();
    expect(fixture.port.refreshNoteIndex).not.toHaveBeenCalled();
    expect(fixture.port.cleanupSuccessfulSegmentAudio).not.toHaveBeenCalled();
    expect(fixture.port.endTaskMeter).toHaveBeenCalled();
    expect(notices.at(-1)?.[0]).toContain("target");
  });
  it("runs optional sediment extraction only when the execution-time setting enables it", async () => {
    const fixture = setup();
    fixture.settings.sedimentAutoExtract = true;
    await runSessionFinalization(fixture.port, fixture.session);
    expect(fixture.port.autoExtractSediment).toHaveBeenCalledWith(fixture.session.mdPath);
  });

  it("writes a no-transcript marker, records diagnostics, and schedules deferred transcription", async () => {
    const fixture = setup({ segments: [{ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: " ", error: "ASR failed" }] });
    await runSessionFinalization(fixture.port, fixture.session);
    expect(fixture.events).toContain("stage:transcript-empty");
    expect(fixture.events).toContain("diag:session.no_transcript");
    expect(fixture.port.appendPolishBlock).toHaveBeenCalledWith(fixture.session, "", expect.any(Error), true);
    expect(fixture.port.requestDeferredAsrRetry).toHaveBeenCalledWith(fixture.session);
    expect(fixture.port.mergeAndPolish).not.toHaveBeenCalled();
  });

  it("archives the prior draft before appending and skips rename for an append session", async () => {
    const fixture = setup({ layout: true });
    fixture.session.continuationSourcePath = "Notes/prior.md";
    fixture.session.continuationBaseSegments = [{ index: 9, startOffsetMs: 0, endOffsetMs: 500, text: "Previous text." }];
    vi.mocked(fixture.port.saveVersion).mockImplementation(async () => { fixture.events.push("archive"); });
    vi.mocked(fixture.port.rewriteConsolidated).mockImplementation(async () => { fixture.events.push("rewrite"); });
    await runSessionFinalization(fixture.port, fixture.session);
    expect(fixture.port.saveVersion).toHaveBeenCalledWith(fixture.file, "A note body", fixture.session.continuationBaseSegments, expect.objectContaining({ kind: "pre-append", activate: false }));
    expect(fixture.events.indexOf("archive")).toBeLessThan(fixture.events.indexOf("rewrite"));
    expect(fixture.port.renameWithGeneratedTitle).not.toHaveBeenCalled();
  });

  it("uses the execution-time sediment setting changed during merge", async () => {
    const fixture = setup();
    vi.mocked(fixture.port.mergeAndPolish).mockImplementation(async () => {
      fixture.settings.sedimentAutoExtract = true;
      return "Polished note";
    });
    await runSessionFinalization(fixture.port, fixture.session);
    expect(fixture.port.autoExtractSediment).toHaveBeenCalledWith(fixture.session.mdPath);
  });

  it("uses raw imported text for fallback title and synchronizes renamed paths", async () => {
    const fixture = setup({ source: "import" });
    const renamed = new obsidian.TFile("Notes/renamed.md");
    vi.mocked(fixture.port.renameWithGeneratedTitle)
      .mockResolvedValueOnce(fixture.file)
      .mockResolvedValueOnce(renamed);
    await runSessionFinalization(fixture.port, fixture.session);
    expect(fixture.port.renameWithGeneratedTitle).toHaveBeenNthCalledWith(2, "Notes/session.md", "Fallback title", fixture.session.mode);
    expect(fixture.session.mdPath).toBe("Notes/renamed.md");
  });
});
