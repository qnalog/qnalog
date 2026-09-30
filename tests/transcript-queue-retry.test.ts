import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
  Notice: class Notice {},
  requestUrl: async () => ({ status: 200, text: "{}" }),
}));

import { QueueRetryService } from "../src/queue/queue-retry-service";
import { attachTranscriptResult } from "../src/transcript/session-transcript";
import { serializeTranscriptBlock, readTranscriptBlocks } from "../src/transcript/transcript-markdown";
import { getTranscribeSegmentPlaceholder } from "../src/shared/util-audio";
import { SessionStore } from "../src/session/session-store";

afterEach(() => vi.unstubAllGlobals());

function makeFile(TFile: new () => object, path: string, name: string, extension: string): Record<string, unknown> {
  return Object.assign(new TFile(), { path, name, basename: name.replace(/\.[^.]+$/, ""), extension });
}

describe("transcript queue retry persistence", () => {
  it("commits source text before cleanup and skips ASR after a write-before-delete interruption", async () => {
    const obsidian = await import("obsidian") as unknown as { TFile: new () => object };
    const note = makeFile(obsidian.TFile, "Notes/retry.md", "retry.md", "md");
    const audio = makeFile(obsidian.TFile, "Audio/clip.wav", "clip.wav", "wav");
    const files = new Map<string, Record<string, unknown>>([
      [String(note.path), note],
      [String(audio.path), audio],
    ]);
    const contents = new Map<string, string>();
    const task = {
      id: "task-retry",
      type: "transcribe",
      sessionId: "session-retry",
      mdPath: String(note.path),
      audioPath: String(audio.path),
      audioName: String(audio.name),
      segmentIndex: 0,
      startOffsetMs: 0,
      endOffsetMs: 10_000,
      audioStartOffsetMs: 0,
      audioEndOffsetMs: 10_000,
      mode: "meeting",
      source: "recording",
      providerId: "test-asr",
      captureMode: "system",
      audioChannelRuntimeMode: "mono",
      wholeFileImport: false,
    };
    const placeholder = getTranscribeSegmentPlaceholder(new Error("first attempt failed"), { retryable: true });
    const emptyRecord = attachTranscriptResult({
      index: 0,
      startOffsetMs: 0,
      endOffsetMs: 10_000,
      audioName: String(audio.name),
      audioPath: String(audio.path),
      segmentAudioName: String(audio.name),
      segmentAudioPath: String(audio.path),
      text: "",
      error: "first attempt failed",
      queueTaskId: task.id,
      source: "recording",
    }, task.sessionId, null, "asr");
    const originalParentId = emptyRecord.transcript?.id;
    contents.set(String(note.path), [
      "# Minutes",
      "",
      "<!-- qnalog-session:session-retry -->",
      "<!-- qnalog-segments-start:session-retry -->",
      serializeTranscriptBlock(
        emptyRecord,
        `### Segment 1 (00:00–00:10) [[clip.wav|00:00]]\n\n<!-- qnalog-transcribe-task:${task.id} -->`,
        placeholder,
      ),
      "<!-- qnalog-segments-end:session-retry -->",
    ].join("\n"));
    const sessionStore = new SessionStore();
    const currentSession = { id: "current-recording" };
    sessionStore.begin(currentSession as never);

    let asrRequests = 0;
    vi.stubGlobal("window", {
      fetch: async () => {
        asrRequests += 1;
        if (asrRequests === 1) throw new Error("network down");
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({ text: "Recovered source phrase." }),
          text: async () => "",
        };
      },
      setTimeout,
      clearTimeout,
    });
    let failNextProcess = true;
    const vault = {
      getAbstractFileByPath: (path: string) => files.get(path) || null,
      read: async (file: { path: string }) => contents.get(file.path) || "",
      readBinary: async () => new Uint8Array([1, 2, 3]),
      modify: async (file: { path: string }, text: string) => { contents.set(file.path, text); },
      process: async (file: { path: string }, transform: (current: string) => string) => {
        const current = contents.get(file.path) || "";
        const next = transform(current);
        if (failNextProcess) {
          failNextProcess = false;
          throw new Error("vault write failed");
        }
        if (next !== current) contents.set(file.path, next);
        return next;
      },
    };
    const deleteAudio = vi.fn().mockResolvedValue(undefined);
    const refreshIndex = vi.fn().mockResolvedValue(undefined);
    const host = {
      app: { vault },
      sessionStore,
      settings: {
        activeTranscribeProvider: "test-asr",
        transcribeProviders: {
          "test-asr": {
            id: "test-asr",
            endpoint: "https://asr.example.com/v1/audio/transcriptions",
            apiKey: "test-key",
            model: "whisper-test",
          },
        },
        customVocabulary: "",
        peopleContextMode: "privacy",
        audioChannelMode: "mono",
      },
      profiles: { getActiveTranscribeProfile: () => ({ transcribeMode: "segmented" }) },
      asrPipeline: { maybeDeleteSegmentCacheFile: deleteAudio },
      noteIndex: { refreshNoteIndexSafely: refreshIndex },
      continuations: {
        runOnTarget: (_target: unknown, operation: () => Promise<unknown>) => operation(),
      },
      diagnostics: { logDiagnostic: vi.fn().mockResolvedValue(undefined) },
      queue: { snapshot: () => [task, { id: "other-task", type: "transcribe", mdPath: task.mdPath }] },
      confirmSpeakerNames: vi.fn().mockResolvedValue(undefined),
      settingsTab: null,
      requestOutlineRefresh: vi.fn(),
    };
    const service = new QueueRetryService(host as never);

    await expect(service.retryTranscribeTask(task)).rejects.toThrow("network down");
    expect(deleteAudio).not.toHaveBeenCalled();
    expect(contents.get(String(note.path))).toContain(placeholder);

    await expect(service.retryTranscribeTask(task)).rejects.toThrow("vault write failed");
    expect(asrRequests).toBe(2);
    expect(deleteAudio).not.toHaveBeenCalled();
    expect(contents.get(String(note.path))).toContain(placeholder);

    await service.retryTranscribeTask(task);

    const saved = contents.get(String(note.path)) || "";
    const [committed] = readTranscriptBlocks(saved);
    expect(asrRequests).toBe(3);
    expect(committed.segment.transcript?.id).toBe(originalParentId);
    expect(committed.segment.error).toBeNull();
    expect(committed.segment.transcript?.revisions).toHaveLength(2);
    expect(committed.segment.transcript?.revisions[1].rawText).toBe("Recovered source phrase.");
    expect(committed.visibleBlock).toBe("Recovered source phrase.");
    expect(deleteAudio).toHaveBeenCalledTimes(1);
    expect(refreshIndex).toHaveBeenCalledTimes(1);

    await service.retryTranscribeTask(task);
    expect(asrRequests).toBe(3);
    expect(deleteAudio).toHaveBeenCalledTimes(2);
    expect(sessionStore.get()).toBe(currentSession);
    expect(refreshIndex).toHaveBeenCalledTimes(2);
});
});
