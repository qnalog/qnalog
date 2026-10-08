import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
  Notice: class Notice {},
  requestUrl: async () => ({ status: 200, text: "{}" }),
}));
const { mergeAndPolishMock } = vi.hoisted(() => ({ mergeAndPolishMock: vi.fn() }));
vi.mock("../src/briefing/merge-pipeline", () => ({ mergeAndPolish: mergeAndPolishMock }));

import { QueueRetryService } from "../src/queue/queue-retry-service";
import { attachTranscriptResult } from "../src/transcript/session-transcript";
import { serializeTranscriptBlock, readTranscriptBlocks } from "../src/transcript/transcript-markdown";
import { getTranscribeSegmentPlaceholder } from "../src/shared/util-audio";
import { SessionStore } from "../src/session/session-store";

afterEach(() => vi.unstubAllGlobals());
import { DEFAULT_SETTINGS } from "../src/shared/defaults";

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
describe("merge queue retry literal preservation", () => {
  it.each([
    "_[Merge failed (queued for retry): temporary]_",
    "_[合并润色失败（已加入重试队列）：temporary]_",
  ])("replaces only the retry marker and preserves model text and surrounding note after a write failure: %s", async (failure) => {
    const obsidian = await import("obsidian") as unknown as { TFile: new () => object };
    const note = makeFile(obsidian.TFile, "Notes/merge-retry.md", "merge-retry.md", "md");
    const files = new Map<string, Record<string, unknown>>([[String(note.path), note]]);
    const transcript = "<!-- qnalog-transcript-data {\"source\":\"ledger\"} -->\nTranscript body.";
    const original = [
      "---\ntitle: existing\n---",
      "KEEP BEFORE",
      failure,
      "KEEP AFTER",
      transcript,
    ].join("\n\n");
    const contents = new Map<string, string>([[String(note.path), original]]);
    const body = "整理正文：多行\n$&\n$` 与反引号\n$'\n$$";
    const polished = `---\ntitle: updated\n---\n\n${body}`;
    mergeAndPolishMock.mockReset().mockResolvedValue(polished);
    let rejectModify = true;
    const vault = {
      getAbstractFileByPath: (path: string) => files.get(path) || null,
      read: async (file: { path: string }) => contents.get(file.path) || "",
      modify: async (file: { path: string }, text: string) => {
        if (rejectModify) {
          rejectModify = false;
          throw new Error("vault write failed");
        }
        contents.set(file.path, text);
      },
    };
    const writer = {
      renameMarkdownWithGeneratedTitle: async () => note,
    };
    const host = {
      app: { vault },
      settings: { ...DEFAULT_SETTINGS, consolidatedLayout: false, autoRenameWithTitle: false },
      noteWriter: writer,
      continuations: { runOnTarget: (_target: unknown, operation: () => Promise<unknown>) => operation() },
      noteIndex: { refreshNoteIndexSafely: async () => undefined },
      clearCommittedBriefingCheckpoint: async () => undefined,
    };
    const task = { mdPath: String(note.path), mode: "meeting", source: "recording", segments: [] };
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-10-07T12:00:00.000Z" }) });
    const service = new QueueRetryService(host as never);

    await expect(service.retryMergeTask(task as never)).rejects.toThrow("vault write failed");
    expect(contents.get(String(note.path))).toBe(original);
    await service.retryMergeTask(task as never);

    expect(contents.get(String(note.path))).toBe([
      "---\ntitle: updated\n---",
      "KEEP BEFORE",
      body,
      "KEEP AFTER",
      transcript,
    ].join("\n\n").replace("---\n\nKEEP BEFORE", "---\nKEEP BEFORE"));
    expect(mergeAndPolishMock).toHaveBeenCalledTimes(2);
  });
  it("appends the merged body when the note has no failure marker", async () => {
    const obsidian = await import("obsidian") as unknown as { TFile: new () => object };
    const note = makeFile(obsidian.TFile, "Notes/merge-append.md", "merge-append.md", "md");
    const files = new Map<string, Record<string, unknown>>([[String(note.path), note]]);
    const transcript = "<!-- qnalog-transcript-data {\"source\":\"ledger\"} -->\nTranscript body.";
    const original = `---\ntitle: existing\n---\n\nKEEP EXISTING\n\n${transcript}`;
    const contents = new Map<string, string>([[String(note.path), original]]);
    const body = "Append literal $& $` $' $$\n多行正文";
    mergeAndPolishMock.mockReset().mockResolvedValue(`---\ntitle: updated\n---\n\n${body}`);
    const vault = {
      getAbstractFileByPath: (path: string) => files.get(path) || null,
      read: async (file: { path: string }) => contents.get(file.path) || "",
      modify: async (file: { path: string }, text: string) => { contents.set(file.path, text); },
    };
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-10-07T12:00:00.000Z" }) });
    const host = {
      app: { vault },
      settings: { ...DEFAULT_SETTINGS, consolidatedLayout: false, autoRenameWithTitle: false },
      noteWriter: { renameMarkdownWithGeneratedTitle: async () => note },
      continuations: { runOnTarget: (_target: unknown, operation: () => Promise<unknown>) => operation() },
      noteIndex: { refreshNoteIndexSafely: async () => undefined },
    };

    await new QueueRetryService(host as never).retryMergeTask({
      mdPath: String(note.path), mode: "meeting", source: "recording", segments: [],
    } as never);

    const saved = contents.get(String(note.path)) || "";
    expect(saved).toContain("KEEP EXISTING");
    expect(saved).toContain(transcript);
    expect(saved).toContain(body);
    expect(saved).toMatch(/## Merged version/i);
  });
});
});
