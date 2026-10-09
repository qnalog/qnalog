import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class TFile {},
  TFolder: class TFolder {},
  Notice: class Notice {},
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  requestUrl: vi.fn(async () => ({ status: 200, text: "{}" })),
}));
const { mergeAndPolishMock, clearCheckpointMock } = vi.hoisted(() => ({
  mergeAndPolishMock: vi.fn(),
  clearCheckpointMock: vi.fn(async () => undefined),
}));
vi.mock("../src/briefing/merge-pipeline", () => ({ mergeAndPolish: mergeAndPolishMock }));
vi.mock("../src/prompts/briefing-prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/prompts/briefing-prompts")>()),
  clearCommittedBriefingCheckpoint: clearCheckpointMock,
}));

import * as obsidian from "obsidian";
import { QueueRetryService } from "../src/queue/queue-retry-service";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { readSessionKnowledge } from "../src/briefing/session-knowledge";
import { labelText } from "../src/shared/note-labels";
import { matchUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { getModeMeta } from "../src/shared/mode-meta";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setActiveUiLanguage(matchUiLanguage("en"));
  mergeAndPolishMock.mockReset();
  clearCheckpointMock.mockReset().mockResolvedValue(undefined);
});

function makeFile(TFile: new () => object, path: string): Record<string, unknown> {
  return Object.assign(new TFile(), { path, name: path.split("/").pop(), basename: path.split("/").pop()?.replace(/\\.md$/, ""), extension: "md" });
}

function setup(options: { text?: string; layout?: boolean; task?: Record<string, unknown>; onTarget?: (op: () => Promise<unknown>) => Promise<unknown> } = {}) {
  const note = makeFile(obsidian.TFile, "Notes/retry.md");
  const files = new Map<string, Record<string, unknown>>([[String(note.path), note]]);
  const contents = new Map<string, string>([[String(note.path), options.text ?? "Original note."]]);
  const log: string[] = [];
  const vault = {
    getAbstractFileByPath: vi.fn((path: string) => files.get(path) ?? null),
    read: vi.fn(async (file: { path: string }) => { log.push("read"); return contents.get(file.path) ?? ""; }),
    modify: vi.fn(async (file: { path: string }, text: string) => { log.push("modify"); contents.set(file.path, text); }),
  };
  const rewritten = vi.fn(async () => { log.push("rewrite"); });
  const renamed = vi.fn(async () => { log.push("rename"); return note; });
  const refresh = vi.fn(async () => { log.push("refresh"); });
  const host = {
    app: { vault }, settings: { ...DEFAULT_SETTINGS, consolidatedLayout: options.layout ?? false },
    continuations: { runOnTarget: vi.fn(async (_target: unknown, operation: () => Promise<unknown>) => {
      log.push("runOnTarget");
      return options.onTarget ? options.onTarget(operation) : operation();
    }) },
    noteWriter: { rewriteConsolidated: rewritten, renameMarkdownWithGeneratedTitle: renamed },
    noteIndex: { refreshNoteIndexSafely: refresh },
  };
  mergeAndPolishMock.mockImplementation(async () => { log.push("merge"); return "---\ntitle: polished\n---\n\nPolished body."; });
  const service = new QueueRetryService(host as never);
  const task = { mdPath: String(note.path), mode: "meeting", source: "recording", segments: [], ...(options.task ?? {}) };
  vi.stubGlobal("window", { moment: (value?: unknown) => ({ format: () => `stamp:${String(value ?? "now")}` }) });
  return { service, host, note, files, contents, vault, log, rewritten, renamed, refresh, task };
}

describe("merge queue retry consumer contract", () => {
  it("delegates continuation tasks unchanged without looking up a note", async () => {
    const { service, host, task } = setup({ task: { continuation: { targetPath: "elsewhere.md" } } });
    const deferred = { deferred: true, reason: "x" };
    const append = vi.spyOn(service, "runAppendTask").mockResolvedValue(deferred as never);
    await expect(service.retryMergeTask(task as never)).resolves.toBe(deferred);
    expect(append).toHaveBeenCalledWith(task);
    expect(host.app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
    expect(host.continuations.runOnTarget).not.toHaveBeenCalled();
  });

  it.each(["missing", "folder"]) ("rejects a missing or non-file target (%s)", async (kind) => {
    const { service, host, task } = setup();
    if (kind === "missing") task.mdPath = "missing.md";
    else host.app.vault.getAbstractFileByPath.mockReturnValue({} as never);
    await expect(service.retryMergeTask(task as never)).rejects.toThrow(`Note not found: ${task.mdPath}`);
    expect(host.continuations.runOnTarget).not.toHaveBeenCalled();
    expect(mergeAndPolishMock).not.toHaveBeenCalled();
  });

  it("rechecks the target inside the serialized operation", async () => {
    const { service, files, host, task } = setup({ onTarget: async (operation) => {
      files.clear();
      return operation();
    } });
    await expect(service.retryMergeTask(task as never)).rejects.toThrow(`Note not found: ${task.mdPath}`);
    expect(host.app.vault.getAbstractFileByPath).toHaveBeenCalledTimes(2);
    expect(mergeAndPolishMock).not.toHaveBeenCalled();
  });

  it("passes copied metadata and default segments/frontmatter to merge", async () => {
    const originalMeta = { startedAt: "2026-10-09T10:00:00.000Z" };
    const { service, task, contents, note } = setup({ text: "# Note\n\nKnowledge text.", task: { sessionMeta: originalMeta } });
    await service.retryMergeTask(task as never);
    const passed = mergeAndPolishMock.mock.calls[0][3] as Record<string, unknown>;
    expect(passed).not.toBe(originalMeta);
    expect(passed).toEqual({ ...originalMeta, _previousKnowledge: readSessionKnowledge(contents.get(String(note.path))!) });
    expect(originalMeta).not.toHaveProperty("_previousKnowledge");
    expect(mergeAndPolishMock.mock.calls[0][1]).toEqual([]);
    expect(mergeAndPolishMock.mock.calls[0][4]).toBeNull();
  });

  it("rejects empty model output before any note mutation or cleanup", async () => {
    const { service, task, vault, rewritten, renamed, refresh } = setup();
    mergeAndPolishMock.mockResolvedValueOnce("");
    await expect(service.retryMergeTask(task as never)).rejects.toThrow("Merge returned an empty result");
    expect(vault.modify).not.toHaveBeenCalled();
    expect(rewritten).not.toHaveBeenCalled();
    expect(clearCheckpointMock).not.toHaveBeenCalled();
    expect(renamed).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("constructs a rewrite session with original defaults and startedAt precedence", async () => {
    const startedAt = "2026-10-01T10:00:00.000Z";
    const { service, task, rewritten, vault } = setup({ layout: true, task: {
      sessionId: "session", createdAt: "2026-09-01", sessionMeta: { startedAt, meetingWorkbench: { enabled: true } },
      source: "merged-notes",
    } });
    await service.retryMergeTask(task as never);
    expect(rewritten).toHaveBeenCalledTimes(1);
    expect(rewritten.mock.calls[0][0]).toEqual({
      id: "session", sessionStamp: `stamp:${startedAt}`, mdPath: "Notes/retry.md", mode: "meeting", startedAt,
      finalized: true, source: "merged-notes", sourceMeta: null, externalAudioSource: null,
      textImportSources: [], meetingWorkbench: { enabled: true }, segments: [], multiSourceAudio: true,
    });
    expect(vault.modify).not.toHaveBeenCalled();
  });
  it.each([
    { createdAt: "2026-09-02T03:04:05.000Z", startedAt: "2026-09-02T03:04:05.000Z" },
    { createdAt: undefined, startedAt: "2026-10-09T12:30:00.000Z" },
  ])("uses a createdAt fallback or current time and generates a missing session id", async ({ createdAt, startedAt }) => {
    const { service, task, rewritten } = setup({ layout: true, task: { sessionId: "", createdAt } });
    if (!createdAt) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(startedAt));
    }
    await service.retryMergeTask(task as never);
    const session = rewritten.mock.calls[0][0];
    expect(session.startedAt).toBe(startedAt);
    expect(session.sessionStamp).toBe(`stamp:${startedAt}`);
    expect(session.id).toEqual(expect.any(String));
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.multiSourceAudio).toBe(false);
  });

  it.each([null, "not-a-file"])("uses the original file for a non-file rename result (%s)", async (renameResult) => {
    const { service, task, note, renamed, refresh } = setup({ task: { sessionMeta: null, createdAt: "2026-10-09" } });
    renamed.mockResolvedValueOnce(renameResult as never);
    await service.retryMergeTask(task as never);
    expect(refresh.mock.calls[0][0]).toBe(note);
    expect(refresh.mock.calls[0][1]).toEqual({ meetingDate: "2026-10-09", reason: "merge-retry" });
  });


  it.each(["en", "zh"])("appends the localized heading and separator when no marker exists (%s)", async (language) => {
    const { service, task, contents, note, host } = setup({ task: { source: "recording" } });
    setActiveUiLanguage(matchUiLanguage(language));
    host.settings.uiLanguage = language;
    await service.retryMergeTask(task as never);
    const heading = `## ${labelText("mergedVersionAt", `${labelText("supplementaryRecording")} · ${getModeMeta(host.settings, "meeting").prefix}`)}`;
    expect(contents.get(String(note.path))).toContain(`${heading}\n\nPolished body.\n\n---\n`);
  });

  it("preserves operation ordering, checkpoint identity, and renamed index target", async () => {
    const { service, task, note, log, renamed, refresh } = setup({ task: { sessionMeta: { startedAt: "2026-10-09" } } });
    const moved = makeFile(obsidian.TFile, "Notes/renamed.md");
    renamed.mockImplementationOnce(async () => { log.push("rename"); return moved; });
    clearCheckpointMock.mockImplementationOnce(async (host: unknown, meta: unknown) => {
      expect(meta).toBe(task.sessionMeta);
      log.push("clear");
      void host;
    });
    await service.retryMergeTask(task as never);
    expect(log).toEqual(["runOnTarget", "read", "merge", "read", "modify", "clear", "rename", "refresh"]);
    expect(refresh.mock.calls[0][0]).toBe(moved);
    expect(refresh.mock.calls[0][1]).toEqual({ meetingDate: "2026-10-09", reason: "merge-retry" });
    expect(note.path).toBe("Notes/retry.md");
  });

  it.each(["read", "merge", "modify", "rewrite", "rename", "refresh"]) ("propagates the original %s failure and stops later work", async (stage) => {
    const error = new Error(`${stage} failed`);
    const { service, task, vault, rewritten, renamed, refresh, log } = setup({ layout: stage === "rewrite" });
    if (stage === "read") vault.read.mockRejectedValueOnce(error);
    if (stage === "merge") mergeAndPolishMock.mockRejectedValueOnce(error);
    if (stage === "modify") vault.modify.mockRejectedValueOnce(error);
    if (stage === "rewrite") rewritten.mockRejectedValueOnce(error);
    if (stage === "rename") renamed.mockRejectedValueOnce(error);
    if (stage === "refresh") refresh.mockRejectedValueOnce(error);
    await expect(service.retryMergeTask(task as never)).rejects.toBe(error);
    if (["read", "merge", "modify", "rewrite"].includes(stage)) expect(clearCheckpointMock).not.toHaveBeenCalled();
    if (stage === "modify" || stage === "rewrite") expect(renamed).not.toHaveBeenCalled();
    if (stage === "rename") expect(refresh).not.toHaveBeenCalled();
    if (stage === "modify") expect(log).not.toContain("clear");
  });

  it("reads replacement vault and layout settings after construction", async () => {
    const { service, host, task, rewritten, contents, note } = setup();
    const secondNote = makeFile(obsidian.TFile, "Notes/second.md");
    const secondContents = new Map([[String(secondNote.path), "Second note."]]);
    host.app.vault = {
      getAbstractFileByPath: vi.fn((path: string) => path === secondNote.path ? secondNote : null),
      read: vi.fn(async (file: { path: string }) => secondContents.get(file.path) ?? ""),
      modify: vi.fn(async (file: { path: string }, text: string) => { secondContents.set(file.path, text); }),
    } as never;
    task.mdPath = String(secondNote.path);
    host.settings.consolidatedLayout = true;
    await service.retryMergeTask(task as never);
    expect(rewritten).toHaveBeenCalledTimes(1);
    expect(rewritten.mock.calls[0][0].mdPath).toBe(secondNote.path);
    expect(contents.get(String(note.path))).toBe("Original note.");
  });
});
