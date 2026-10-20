import { afterEach, describe, expect, it, vi } from "vitest";

const asr = vi.hoisted(() => ({ transcribe: vi.fn(), channels: vi.fn(), whole: vi.fn() }));
vi.mock("obsidian", () => ({
  TFile: class TFile {}, TFolder: class TFolder {}, Notice: class Notice {},
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  requestUrl: vi.fn(async () => ({ status: 200, text: "{}" })),
}));
vi.mock("../src/asr/transcribe", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/asr/transcribe")>()), transcribeAudio: asr.transcribe }));
vi.mock("../src/asr/channel-transcription", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/asr/channel-transcription")>()), transcribeAudioByChannels: asr.channels }));
vi.mock("../src/asr/long-audio-transcription", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/asr/long-audio-transcription")>()), transcribeImportedAudio: asr.whole }));

import * as obsidian from "obsidian";
import { LiveAsrPipelineService } from "../src/asr/live-asr-pipeline-service";
import { QueueRetryService } from "../src/queue/queue-retry-service";
import { TaskQueue } from "../src/queue/task-queue";
import type { TaskQueueHost } from "../src/queue/task-queue";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import { serializeTranscriptBlock } from "../src/transcript/transcript-markdown";

afterEach(() => vi.clearAllMocks());

const CACHE_PATH = "QnALog/.cache/segments/clip.wav";
const AUDIO_BYTES = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 5, 6]);
const noteFile = () => Object.assign(new obsidian.TFile(), { path: "Notes/retry.md", name: "retry.md", basename: "retry", extension: "md" });
const cacheFile = () => Object.assign(new obsidian.TFile(), { path: CACHE_PATH, name: "clip.wav", basename: "clip", extension: "wav" });

function makeRetentionScenario(route: "adapter" | "indexed", markdown: string, options: { masterAudioPath?: string; raceCommit?: boolean; keepSegmentAudioFiles?: boolean } = {}) {
  const note = noteFile();
  const cache = cacheFile();
  const files = new Map([[note.path, note], ...(route === "indexed" ? [[CACHE_PATH, cache] as const] : [])]);
  const bytes = new Map([[CACHE_PATH, AUDIO_BYTES.slice()]]);
  if (options.masterAudioPath) {
    const masterName = options.masterAudioPath.split("/").pop() || "recording.wav";
    files.set(options.masterAudioPath, Object.assign(new obsidian.TFile(), { path: options.masterAudioPath, name: masterName, basename: masterName.replace(/\.[^.]+$/, ""), extension: "wav" }));
    bytes.set(options.masterAudioPath, new Uint8Array([1, 2, 3]));
  }
  let contents = markdown;
  let queue: TaskQueue;
  const vault = {
    getAbstractFileByPath: (path: string) => files.get(path) || null,
    read: vi.fn(async (file: { path: string }) => file.path === note.path ? contents : ""),
    readBinary: vi.fn(async (file: { path: string }) => bytes.get(file.path)?.slice().buffer as ArrayBuffer),
    process: vi.fn(async (_file: { path: string }, update: (value: string) => string) => {
      if (options.raceCommit) {
        const committed = attachTextTranscript({ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "already committed" }, "session-1", "asr");
        contents = `Original note.\n\n${serializeTranscriptBlock(committed, "### Segment 1 (00:00–00:01)", "already committed")}\n`;
        options.raceCommit = false;
      }
      contents = update(contents);
      return contents;
    }),
    adapter: {
      exists: vi.fn(async (path: string) => bytes.has(path)),
      readBinary: vi.fn(async (path: string) => bytes.get(path)?.slice().buffer as ArrayBuffer),
      remove: vi.fn(async (path: string) => { bytes.delete(path); }),
      mkdir: vi.fn(async () => undefined), writeBinary: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ files: [], folders: [] })), stat: vi.fn(async () => ({ mtime: 0 })),
    },
  };
  const settings = { ...DEFAULT_SETTINGS, segmentCacheFolder: "QnALog/.cache/segments", keepSegmentAudioFiles: options.keepSegmentAudioFiles === true, audioFolder: "QnALog/Audio", audioChannelMode: "mono" };
  const pipeline = new LiveAsrPipelineService({
    getSettings: () => settings, vault,
    fileManager: { trashFile: vi.fn(async (file: { path: string }) => { bytes.delete(file.path); }) },
    diagnostics: { logDiagnostic: vi.fn(async () => undefined) },
    queueTasks: () => queue?.snapshot() || [], queueRecoveryEntries: () => [],
    addQueueTask: vi.fn(async (task: never) => task), updateQueueTask: vi.fn(async () => undefined), removeQueueTask: vi.fn(async () => undefined),
    removeLiveTranscriptBlock: vi.fn(async () => undefined), discardMasterPartials: vi.fn(async () => undefined),
    getRecorderBufferSummary: () => ({ masterChunkCount: 0, masterChunkBytes: 0, currentSegmentChunkCount: 0, currentSegmentChunkBytes: 0 }),
    syncImportBusyFromSessionProgress: vi.fn(), requestOutlineRefresh: vi.fn(), requestBubbleUpdate: vi.fn(),
  } as never);
  const retry = new QueueRetryService({
    app: { vault }, settings, asrPipeline: pipeline,
    diagnostics: { logDiagnostic: vi.fn(async () => undefined) },
    continuations: { runOnTarget: (_target: unknown, operation: () => Promise<unknown>) => operation() },
    noteIndex: { refreshNoteIndexSafely: vi.fn(async () => undefined) },
    noteWriter: { insertBeforeSegmentsEnd: vi.fn(async () => undefined), detectModeFromMarkdown: vi.fn(() => "meeting") },
    repolish: { repolishMarkdownFile: vi.fn(async () => undefined), reorganizeNoteInPlace: vi.fn(async () => undefined) },
    queue: null, profiles: { getActiveTranscribeProfile: vi.fn(() => null) }, confirmSpeakerNames: vi.fn(async () => undefined),
  } as never);
  const queueHost: TaskQueueHost = {
    getMaxRetries: () => 1, persistQueue: vi.fn(async () => undefined), updateBusyStatus: vi.fn(),
    retryTranscribeTask: (task) => retry.retryTranscribeTask(task as never),
    retryMergeTask: vi.fn(async () => undefined), runGeneratePromptTask: vi.fn(async () => undefined),
    scheduleTaskQueueRetry: vi.fn(), isAsrServiceCircuitOpen: () => false, getAsrServiceRetryDelayMs: () => 0,
    getAsrServiceCircuitState: () => ({ consecutiveFailures: 0, openUntilMs: 0, lastError: "" }),
    recordAsrServiceAttemptSuccess: vi.fn(), recordAsrServiceAttemptFailure: () => ({ consecutiveFailures: 0, openUntilMs: 0, lastError: "" }),
    completeTaskActivity: vi.fn(), logCompletedWork: vi.fn(), logDiagnostic: vi.fn(async () => undefined),
  };
  queue = new TaskQueue(queueHost);
  asr.transcribe.mockResolvedValue({ text: "recognized words", rawText: "recognized words", providerId: "mock", units: [] });
  asr.channels.mockResolvedValue(null);
  asr.whole.mockResolvedValue({ text: "recognized words", rawText: "recognized words", providerId: "mock", units: [] });
  vi.stubGlobal("window", { moment: () => ({ format: () => "00:00" }) });
  return { note, contents: () => contents, bytes, queue, vault, retry, task: {
    id: "retry-1", type: "transcribe" as const, sessionId: "session-1", mdPath: note.path,
    audioPath: CACHE_PATH, audioName: "clip.wav", segmentIndex: 0, startOffsetMs: 0, endOffsetMs: 1000,
    ...(options.masterAudioPath === undefined ? {} : { masterAudioPath: options.masterAudioPath }),
    // Ordinary recordings commonly have no source field and no master path.
  } };
}

describe.each(["adapter", "indexed"] as const)("ordinary segment retry retains cache bytes through %s storage", (route) => {
  it.each([
    ["successful transcription", "Original note.", {}, "recognized words", 1],
    ["existing transcript idempotency", `Original note.\n\n${serializeTranscriptBlock(attachTextTranscript({ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "already saved" }, "session-1", "asr"), "### Segment 1 (00:00–00:01)", "already saved")}\n`, {}, "already saved", 0],
    ["legacy task marker", "### Segment 1 (00:00–00:01)\n\n<!-- qnalog-transcribe-task:retry-1 -->\nRecognized legacy text\n", {}, "Recognized legacy text", 0],
    ["commit race after ASR", "Original note.", { raceCommit: true }, "already committed", 1],
    ["stale master path", "Original note.", { masterAudioPath: "QnALog/Audio/missing.wav" }, "recognized words", 1],
    ["existing but unverified master path", "Original note.", { masterAudioPath: "QnALog/Audio/recording.wav" }, "recognized words", 1],
  ] as const)("preserves audio after %s", async (_label, markdown, options, expectedNoteText, expectedAsrCalls) => {
    const fixture = makeRetentionScenario(route, markdown, options);
    const queued = await fixture.queue.add(fixture.task);
    await fixture.queue.processOne(queued);

    expect(fixture.queue.snapshot()).not.toContain(queued);
    expect(fixture.bytes.get(CACHE_PATH)).toEqual(AUDIO_BYTES);
    expect(fixture.contents()).toContain(expectedNoteText);
    expect(fixture.vault.adapter.remove).not.toHaveBeenCalled();
    expect(asr.transcribe).toHaveBeenCalledTimes(expectedAsrCalls);
  });

  it("keeps an ordinary recording cache when the user enabled segment retention", async () => {
    const fixture = makeRetentionScenario(route, "Original note.", { keepSegmentAudioFiles: true });
    const queued = await fixture.queue.add(fixture.task);
    await fixture.queue.processOne(queued);
    expect(fixture.queue.snapshot()).not.toContain(queued);
    expect(fixture.contents()).toContain("recognized words");
    expect(fixture.bytes.get(CACHE_PATH)).toEqual(AUDIO_BYTES);
  });

  it("retains cleanup for a successfully retried ephemeral whole-file import", async () => {
    const fixture = makeRetentionScenario(route, "Original note.");
    fixture.task.wholeFileImport = true;
    fixture.task.ephemeralAudio = true;
    const queued = await fixture.queue.add(fixture.task);
    await fixture.queue.processOne(queued);
    expect(fixture.queue.snapshot()).not.toContain(queued);
    expect(fixture.contents()).toContain("recognized words");
    expect(fixture.bytes.has(CACHE_PATH)).toBe(false);
  });

  it("honors keepSegmentAudioFiles for an idempotent ephemeral whole-file import", async () => {
    const saved = attachTextTranscript({ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "already saved" }, "session-1", "asr");
    const markdown = `Original note.\n\n${serializeTranscriptBlock(saved, "### Segment 1 (00:00–00:01)", "already saved")}\n`;
    const fixture = makeRetentionScenario(route, markdown, { keepSegmentAudioFiles: true });
    fixture.task.wholeFileImport = true;
    fixture.task.ephemeralAudio = true;
    const queued = await fixture.queue.add(fixture.task);
    await fixture.queue.processOne(queued);
    expect(fixture.queue.snapshot()).not.toContain(queued);
    expect(fixture.bytes.get(CACHE_PATH)).toEqual(AUDIO_BYTES);
  });

  it("keeps a whole-file import cache when it is not marked ephemeral", async () => {
    const fixture = makeRetentionScenario(route, "Original note.");
    fixture.task.wholeFileImport = true;
    fixture.task.ephemeralAudio = false;
    const queued = await fixture.queue.add(fixture.task);
    await fixture.queue.processOne(queued);
    expect(fixture.queue.snapshot()).not.toContain(queued);
    expect(fixture.contents()).toContain("recognized words");
    expect(fixture.bytes.get(CACHE_PATH)).toEqual(AUDIO_BYTES);
  });
});
