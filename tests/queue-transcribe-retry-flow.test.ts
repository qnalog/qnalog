import { afterEach, describe, expect, it, vi } from "vitest";

const asr = vi.hoisted(() => ({ transcribe: vi.fn(), channels: vi.fn(), whole: vi.fn(), notices: [] as string[] }));
vi.mock("obsidian", () => ({
  TFile: class TFile {}, TFolder: class TFolder {}, Notice: class Notice { constructor(message?: string) { if (message) asr.notices.push(message); } },
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  requestUrl: vi.fn(async () => ({ status: 200, text: "{}" })),
}));
vi.mock("../src/asr/transcribe", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/asr/transcribe")>()), transcribeAudio: asr.transcribe }));
vi.mock("../src/asr/channel-transcription", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/asr/channel-transcription")>()), transcribeAudioByChannels: asr.channels }));
vi.mock("../src/asr/long-audio-transcription", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/asr/long-audio-transcription")>()), transcribeImportedAudio: asr.whole }));

import * as obsidian from "obsidian";
import { QueueRetryService } from "../src/queue/queue-retry-service";
import { TaskQueue } from "../src/queue/task-queue";
import type { TaskQueueHost } from "../src/queue/task-queue";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { MAX_SPEAKER_CHANNELS } from "../src/audio/channel-speakers";
import { labelText } from "../src/shared/note-labels";
import { nsMarker } from "../src/shared/namespace";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function setup(markdown = "", targetIsFile = true) {
  const file = Object.assign(new obsidian.TFile(), { path: "Notes/retry.md", name: "retry.md", basename: "retry", extension: "md" });
  const contents = new Map([[file.path, markdown]]);
  const audio = Object.assign(new obsidian.TFile(), { path: "Audio/clip.wav", name: "clip.wav", basename: "clip", extension: "wav" });
  const log: string[] = [];
  const vault = {
    getAbstractFileByPath: vi.fn((path: string) => path === file.path && targetIsFile ? file : path === audio.path ? audio : null),
    read: vi.fn(async (target: { path: string }) => contents.get(target.path) ?? ""),
    readBinary: vi.fn(async () => new ArrayBuffer(8)),
    process: vi.fn(async (_target: { path: string }, update: (text: string) => string) => {
      const next = update(contents.get(file.path) ?? ""); contents.set(file.path, next); return next;
    }),
  };
  const cleanup = vi.fn(async (...args: unknown[]) => { log.push("cleanup"); void args; });
  const refresh = vi.fn(async (_target: unknown, options: { reason: string }) => { log.push(options.reason); });
  const insertBeforeSegmentsEnd = vi.fn(async (...args: unknown[]) => { log.push("insert"); void args; });
  const diagnostics = { logDiagnostic: vi.fn(async () => undefined) };
  const host = {
    app: { vault }, settings: { ...DEFAULT_SETTINGS, audioFolder: "Audio", audioChannelMode: "mono" },
    diagnostics, asrPipeline: { maybeDeleteSegmentCacheFile: cleanup }, noteIndex: { refreshNoteIndexSafely: refresh },
    continuations: { runOnTarget: vi.fn(async (_file: unknown, operation: () => Promise<unknown>) => operation()) },
    noteWriter: { insertBeforeSegmentsEnd, detectModeFromMarkdown: vi.fn(() => "meeting") },
    repolish: { repolishMarkdownFile: vi.fn(async () => undefined), reorganizeNoteInPlace: vi.fn(async () => undefined) },
    queue: { tasks: [] }, confirmSpeakerNames: vi.fn(async () => undefined),
    profiles: { getActiveTranscribeProfile: vi.fn(() => null) },
  };
  asr.transcribe.mockResolvedValue({ text: "recognized words", rawText: "recognized words", providerId: "mock", units: [] });
  asr.channels.mockResolvedValue(null);
  asr.whole.mockResolvedValue({ text: "recognized words", rawText: "recognized words", providerId: "mock", units: [] });
  const service = new QueueRetryService(host as never);
  const task = { id: "retry-1", type: "transcribe" as const, sessionId: "session-1", mdPath: file.path, audioPath: audio.path, audioName: audio.name, segmentIndex: 0, startOffsetMs: 0, endOffsetMs: 1000 };
  vi.stubGlobal("window", { moment: () => ({ format: () => "00:00" }) });
  return { service, host, task, file, contents, vault, cleanup, refresh, insertBeforeSegmentsEnd, diagnostics, log };
}

describe("transcription retry consumer contract", () => {
  it("keeps an anomalous retry result out of the note and retains the retry audio", async () => {
    const fixture = setup("Original note.");
    fixture.task.wholeFileImport = true;
    fixture.task.providerId = "provider";
    fixture.task.endOffsetMs = 10_000;
    const repeatedMarkup = "<chinese>".repeat(4552);
    asr.whole.mockResolvedValueOnce({ text: repeatedMarkup, rawText: repeatedMarkup, providerId: "provider", durationMs: 10_000, units: [] });

    await expect(fixture.service.retryTranscribeTask(fixture.task as never)).rejects.toThrow("recording duration");

    expect(fixture.contents.get(fixture.file.path)).toBe("Original note.");
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.diagnostics.logDiagnostic).toHaveBeenCalledWith("warn", "asr.long_recording_anomaly", expect.any(String), expect.objectContaining({
      provider: "provider", model: expect.any(String), textLength: 40_968, durationMs: 10_000, signals: ["density", "repetition"],
    }));
    expect(asr.notices).toHaveLength(0);
  });

  it("leaves an anomalous retry failed in the queue without an automatic retry", async () => {
    const fixture = setup("Original failure placeholder.");
    fixture.task.wholeFileImport = true;
    fixture.task.providerId = "provider";
    fixture.task.endOffsetMs = 10_000;
    const repeatedMarkup = "<chinese>".repeat(4552);
    asr.whole.mockResolvedValueOnce({ text: repeatedMarkup, rawText: repeatedMarkup, providerId: "provider", durationMs: 10_000, units: [] });
    const host: TaskQueueHost = {
      getMaxRetries: () => 3,
      persistQueue: vi.fn(async () => undefined), updateBusyStatus: vi.fn(),
      retryTranscribeTask: (task) => fixture.service.retryTranscribeTask(task as never),
      retryMergeTask: vi.fn(async () => undefined), runGeneratePromptTask: vi.fn(async () => undefined),
      scheduleTaskQueueRetry: vi.fn(), isAsrServiceCircuitOpen: () => false,
      getAsrServiceRetryDelayMs: () => 0,
      getAsrServiceCircuitState: () => ({ consecutiveFailures: 0, openUntilMs: 0, lastError: "" }),
      recordAsrServiceAttemptSuccess: vi.fn(), recordAsrServiceAttemptFailure: () => ({ consecutiveFailures: 0, openUntilMs: 0, lastError: "" }),
      completeTaskActivity: vi.fn(), logCompletedWork: vi.fn(), logDiagnostic: vi.fn(async () => undefined),
    };
    const queue = new TaskQueue(host);
    const queued = await queue.add({ ...fixture.task, retries: 1 });

    await expect(queue.processOne(queued)).rejects.toMatchObject({ nonRetryable: true });
    await queue.processAll();

    expect(queue.snapshot()).toContain(queued);
    expect(queued).toMatchObject({ status: "failed", retries: 3, audioPath: fixture.task.audioPath, lastError: expect.stringContaining("recording duration") });
    expect(fixture.contents.get(fixture.file.path)).toBe("Original failure placeholder.");
    expect(fixture.contents.get(fixture.file.path)).not.toContain(repeatedMarkup);
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(asr.whole).toHaveBeenCalledOnce();
  });

  it("rejects repeated retry output when task duration is zero", async () => {
    const fixture = setup("Original note.");
    fixture.task.wholeFileImport = true;
    fixture.task.providerId = "provider";
    fixture.task.endOffsetMs = 0;
    const repeatedMarkup = "<chinese>".repeat(4552);
    asr.whole.mockResolvedValueOnce({ text: repeatedMarkup, rawText: repeatedMarkup, providerId: "provider", units: [] });

    await expect(fixture.service.retryTranscribeTask(fixture.task as never)).rejects.toThrow("recording duration");

    expect(fixture.contents.get(fixture.file.path)).toBe("Original note.");
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.diagnostics.logDiagnostic).toHaveBeenCalledWith("warn", "asr.long_recording_anomaly", expect.any(String), expect.objectContaining({
      durationMs: 0, signals: ["repetition"],
    }));
  });

  it("uses the transcription result duration when task offsets have zero duration", async () => {
    const fixture = setup("Original note.");
    fixture.task.wholeFileImport = true;
    fixture.task.endOffsetMs = 0;
    const denseTranscript = Array.from({ length: 130 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join("");
    asr.whole.mockResolvedValueOnce({ text: denseTranscript, rawText: denseTranscript, providerId: "provider", durationMs: 5_000, units: [] });

    await expect(fixture.service.retryTranscribeTask(fixture.task as never)).rejects.toThrow("recording duration");
    expect(fixture.diagnostics.logDiagnostic).toHaveBeenCalledWith("warn", "asr.long_recording_anomaly", expect.any(String), expect.objectContaining({
      durationMs: 5_000, signals: ["density"],
    }));
  });

  it("routes non-file targets through insertion and file targets through the serialized operation", async () => {
    const missing = setup("", false);
    await missing.service.retryTranscribeTask(missing.task as never);
    expect(missing.insertBeforeSegmentsEnd).toHaveBeenCalledWith(missing.task.mdPath, expect.stringContaining("recognized words"), missing.task.sessionId);
    expect(missing.host.continuations.runOnTarget).not.toHaveBeenCalled();

    const present = setup();
    await present.service.retryTranscribeTask(present.task as never);
    expect(present.host.continuations.runOnTarget).toHaveBeenCalledTimes(1);
  });

  it("records empty ASR output and preserves the note and audio for another retry", async () => {
    const fixture = setup("Original note.");
    asr.transcribe.mockResolvedValueOnce({ text: "", rawText: "", providerId: "mock", units: [] });
    await expect(fixture.service.retryTranscribeTask(fixture.task as never)).rejects.toThrow("Transcription retry returned an empty result (the service responded HTTP 200 with no text)");
    expect(fixture.contents.get(fixture.file.path)).toBe("Original note.");
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.diagnostics.logDiagnostic).toHaveBeenCalledWith("warn", "queue.transcribe_empty_result", expect.any(String), expect.objectContaining({ mdPath: fixture.task.mdPath, audioName: fixture.task.audioName }));
  });

  it("completes a quiet empty retry as a blank segment and replaces the failure placeholder", async () => {
    const taskMarker = nsMarker("transcribe-task", "retry-1");
    const placeholder = `${labelText("segment", 1)} (00:00–00:01)\n\n${taskMarker}\n\n${labelText("waitingBackground")}`;
    const fixture = setup(`## ✨ 整合版（meeting）\n\n真实整理正文。\n\n---\n\n## 原始材料\n\n### ${placeholder}\n`);
    asr.transcribe.mockResolvedValueOnce({ text: "", rawText: null, providerId: "mock", units: [], quiet: true });

    await expect(fixture.service.retryTranscribeTask(fixture.task as never)).resolves.toBeUndefined();

    const written = fixture.contents.get(fixture.file.path) ?? "";
    expect(written).toContain(labelText("noContentSegment"));
    expect(written).not.toContain(labelText("waitingBackground"));
    expect(fixture.diagnostics.logDiagnostic).not.toHaveBeenCalledWith("warn", "queue.transcribe_empty_result", expect.any(String), expect.anything());
    expect(fixture.diagnostics.logDiagnostic).not.toHaveBeenCalledWith("warn", "asr.long_recording_anomaly", expect.any(String), expect.anything());
    expect(fixture.cleanup).toHaveBeenCalledWith(fixture.task.audioPath, fixture.task.id, false);
    expect(fixture.host.repolish.repolishMarkdownFile).toHaveBeenCalledTimes(1);
  });

  it("completes a no-speech empty retry as a blank segment and replaces the failure placeholder", async () => {
    const taskMarker = nsMarker("transcribe-task", "retry-1");
    const placeholder = `${labelText("segment", 1)} (00:00–00:01)\n\n${taskMarker}\n\n${labelText("waitingBackground")}`;
    const fixture = setup(`Original note.\n\n### ${placeholder}\n`);
    asr.transcribe.mockResolvedValueOnce({ text: "", rawText: null, providerId: "mock", units: [], noSpeech: true });

    await expect(fixture.service.retryTranscribeTask(fixture.task as never)).resolves.toBeUndefined();

    const written = fixture.contents.get(fixture.file.path) ?? "";
    expect(written).toContain(labelText("noContentSegment"));
    expect(written).not.toContain(labelText("waitingBackground"));
    expect(fixture.diagnostics.logDiagnostic).not.toHaveBeenCalledWith("warn", "queue.transcribe_empty_result", expect.any(String), expect.anything());
    expect(fixture.cleanup).toHaveBeenCalledWith(fixture.task.audioPath, fixture.task.id, false);
  });

  it("keeps throwing for a non-quiet empty retry result", async () => {
    const fixture = setup("Original note.");
    asr.transcribe.mockResolvedValueOnce({ text: "", rawText: null, providerId: "mock", units: [] });
    await expect(fixture.service.retryTranscribeTask(fixture.task as never)).rejects.toThrow("Transcription retry returned an empty result");
    expect(fixture.contents.get(fixture.file.path)).toBe("Original note.");
    expect(fixture.cleanup).not.toHaveBeenCalled();
  });

  it("uses the same host object for ASR calls and preserves the three-argument segment call", async () => {
    const fixture = setup();
    await fixture.service.retryTranscribeTask(fixture.task as never);
    expect(asr.transcribe).toHaveBeenCalledWith(fixture.host, expect.any(Blob), "audio/wav");
    expect(asr.transcribe.mock.calls[0]).toHaveLength(3);
  });
  it("uses channel transcription only for probing microphone captures", async () => {
    const fixture = setup();
    fixture.task.captureMode = "mic";
    fixture.task.audioChannelMode = "auto";
    fixture.task.audioChannelRuntimeMode = "probing";
    fixture.task.audioChannelCount = 2;
    asr.channels.mockResolvedValueOnce({ text: "channel words", rawText: "channel words", providerId: "mock", units: [] });
    await fixture.service.retryTranscribeTask(fixture.task as never);
    expect(asr.channels).toHaveBeenCalledWith(fixture.host, expect.any(Blob), "audio/wav", MAX_SPEAKER_CHANNELS, { requireSeparatedChannels: true });
    expect(asr.transcribe).not.toHaveBeenCalled();
  });

  it("passes whole-file import options and confirms speaker names after persistence", async () => {
    const fixture = setup();
    fixture.task.wholeFileImport = true;
    fixture.task.providerId = "provider";
    fixture.task.speakerCount = 2;
    fixture.task.sourceAudioName = "source.wav";
    fixture.task.speakerDiarization = true;
    fixture.task.ephemeralAudio = true;
    await fixture.service.retryTranscribeTask(fixture.task as never);
    expect(asr.whole).toHaveBeenCalledWith(fixture.host, expect.any(Blob), "audio/wav", {
      providerId: "provider", diarization: true, speakerCount: 2, fileName: "source.wav",
    });
    expect(fixture.host.confirmSpeakerNames).toHaveBeenCalledWith(
      { id: fixture.task.sessionId, mdPath: fixture.task.mdPath, source: "import", importTranscribeProviderId: "provider" },
      [expect.objectContaining({ text: "recognized words" })],
    );
    expect(fixture.cleanup).toHaveBeenCalledWith(fixture.task.audioPath, fixture.task.id, true);
  });

  it("rejects segment retries for streaming profiles before ASR", async () => {
    const fixture = setup();
    fixture.host.profiles.getActiveTranscribeProfile.mockReturnValue({ transcribeMode: "streaming", title: "Live" } as never);
    await expect(fixture.service.retryTranscribeTask(fixture.task as never)).rejects.toThrow("The current transcription service is a streaming service");
    expect(asr.transcribe).not.toHaveBeenCalled();
  });
});

describe("automatic re-organization after backfilling the last failed segment", () => {
  const failedNoteBody = `## 整合版（meeting）\n\n_[AI 整理失败：没有可用于整理的有效转写文本；录音和失败切片已保留]_\n\n---\n\n## 原始材料\n\n`;
  function placeholderFor(taskId: string) {
    const taskMarker = nsMarker("transcribe-task", taskId);
    return `${labelText("segment", 1)} (00:00–00:01)\n\n${taskMarker}\n\n${labelText("waitingBackground")}`;
  }

  it("re-organizes the original note in place when it has only the failure placeholder", async () => {
    const fixture = setup(`${failedNoteBody}### ${placeholderFor("retry-1")}\n`);
    await expect(fixture.service.retryTranscribeTask(fixture.task as never)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fixture.host.repolish.reorganizeNoteInPlace).toHaveBeenCalledTimes(1));
    expect(fixture.host.repolish.reorganizeNoteInPlace).toHaveBeenCalledWith(fixture.file, { firstOrganizing: true });
    expect(fixture.host.repolish.repolishMarkdownFile).not.toHaveBeenCalled();
    expect(fixture.contents.get(fixture.file.path)).toContain("recognized words");
  });

  it("keeps the derived re-organization when the original note already has an organized body", async () => {
    const fixture = setup(`## ✨ 整合版（meeting）\n\n真实整理正文。\n\n---\n\n## 原始材料\n\n### ${placeholderFor("retry-1")}\n`);
    await expect(fixture.service.retryTranscribeTask(fixture.task as never)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fixture.host.repolish.repolishMarkdownFile).toHaveBeenCalledTimes(1));
    expect(fixture.host.repolish.reorganizeNoteInPlace).not.toHaveBeenCalled();
  });

  it("logs a failed in-place re-organization without rejecting the retry", async () => {
    const fixture = setup(`${failedNoteBody}### ${placeholderFor("retry-1")}\n`);
    fixture.host.repolish.reorganizeNoteInPlace.mockRejectedValueOnce(new Error("organize failed"));
    await expect(fixture.service.retryTranscribeTask(fixture.task as never)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fixture.diagnostics.logDiagnostic).toHaveBeenCalledWith("error", "queue.auto_repolish_failed", expect.any(String), expect.objectContaining({ mdPath: fixture.file.path })));
    expect(fixture.host.repolish.repolishMarkdownFile).not.toHaveBeenCalled();
  });

  it("does not re-organize while other transcribe tasks for the same note remain queued", async () => {
    const fixture = setup(`${failedNoteBody}### ${placeholderFor("retry-1")}\n`);
    fixture.host.queue.tasks.push({ id: "retry-2", type: "transcribe", mdPath: fixture.file.path } as never);
    await expect(fixture.service.retryTranscribeTask(fixture.task as never)).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.host.repolish.reorganizeNoteInPlace).not.toHaveBeenCalled();
    expect(fixture.host.repolish.repolishMarkdownFile).not.toHaveBeenCalled();
  });
});
