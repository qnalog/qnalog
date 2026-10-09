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
import { QueueRetryService } from "../src/queue/queue-retry-service";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { MAX_SPEAKER_CHANNELS } from "../src/audio/channel-speakers";

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
    repolish: { repolishMarkdownFile: vi.fn(async () => undefined) },
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
