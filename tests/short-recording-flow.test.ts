import { describe, expect, it, vi } from "vitest";

// 短录音整条路径的冒烟测试：真的调用 RecordingService.handleSegment 与 SessionFinalizeService，
// 观察知识库里发生了什么。判据是用户能观察到的结果：录音文件在不在、纪要文件在不在、
// 是否向转写服务发出了请求。单测分级函数只能证明阈值算对了，证明不了这两个服务真的按它走。

const notices: string[] = [];
const trashed: string[] = [];

vi.mock("obsidian", () => {
  class TFile {
    constructor(path: string) { this.path = path; this.extension = String(path).split(".").pop(); }
  }
  class TFolder { constructor(path = "") { this.path = path; } }
  class Notice { constructor(message: string) { notices.push(String(message ?? "")); } }
  class Modal { constructor() {} open() {} close() {} }
  class Setting { constructor() {} setName() { return this; } setDesc() { return this; } addButton() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } setHeading() { return this; } setClass() { return this; } }
  return {
    TFile,
    TFolder,
    Notice,
    Modal,
    Setting,
    PluginSettingTab: class {},
    normalizePath: (p: string) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, ""),
    requestUrl: async () => ({ status: 200, text: "{}", json: {} }),
  };
});

import * as obsidian from "obsidian";
import { RecordingService } from "../src/audio/recording-service";
import type { RecordingHost } from "../src/audio/recording-service";
import { SessionFinalizeService } from "../src/notes/session-finalize-service";
import { SessionStore } from "../src/session/session-store";
import { ContinuationService } from "../src/session/continuation-service";
import { TaskQueue } from "../src/queue/task-queue";
import type { TaskQueueHost } from "../src/queue/task-queue";
import { QueueRetryService } from "../src/queue/queue-retry-service";
import { LiveAsrPipelineService } from "../src/asr/live-asr-pipeline-service";
import { NoteWriter } from "../src/notes/note-writer";
import type { NoteWriterHost } from "../src/notes/note-writer";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import { serializeTranscriptBlock } from "../src/transcript/transcript-markdown";

/** 只实现短录音路径真正会碰到的部分；其余能力一旦被调用即抛出，避免测试掩盖真实依赖。 */
function makeHost() {
  const files = new Map<string, { content?: string; binary?: ArrayBuffer }>();
  const folders = new Set<string>();
  const fileRefs = new Map<string, obsidian.TFile>();
  const getFileRef = (path: string) => {
    let file = fileRefs.get(path);
    if (!file) {
      file = new (obsidian.TFile as never)(path);
      fileRefs.set(path, file);
    }
    return file;
  };
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => {
        const p = String(path || "");
        if (files.has(p)) return getFileRef(p);
        if (folders.has(p)) return new (obsidian.TFolder as never)(p);
        return null;
      },
      read: async (file: { path: string }) => String(files.get(file.path)?.content ?? ""),
      create: async (path: string, content: string) => {
        files.set(path, { content: String(content) });
        return getFileRef(path);
      },
      modify: async (file: { path: string }, content: string) => { files.set(file.path, { content: String(content) }); },
      createBinary: async (path: string, data: ArrayBuffer) => {
        files.set(path, { binary: data });
        return new (obsidian.TFile as never)(path);
      },
      createFolder: async (path: string) => { folders.add(path); },
      adapter: {
        exists: async (path: string) => folders.has(path) || files.has(path),
        mkdir: async (path: string) => { folders.add(path); },
        writeBinary: async (path: string, data: ArrayBuffer) => { files.set(path, { binary: data }); },
        remove: async (path: string) => { files.delete(path); },
        list: async () => ({ files: [], folders: [] }),
        stat: async () => ({ mtime: 0 }),
      },
    },
    fileManager: {
      trashFile: async (file: { path: string }) => { trashed.push(file.path); files.delete(file.path); },
      processFrontMatter: async () => undefined,
    },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
    metadataCache: { getFileCache: () => null },
  };

  const transcriptionCalls: string[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];


  const sessionStore = new SessionStore();
  const continuationCalls: string[] = [];
  const continuations = {
    trackSession: (session: { id: string }) => { continuationCalls.push(`track:${session.id}`); },
    releaseSession: (sessionId: string) => { continuationCalls.push(`release:${sessionId}`); },
    resolveTarget: () => null,
    prepare: async () => { throw new Error("unexpected continuation preparation"); },
    isSessionTracked: () => false,
    hasActiveSessions: () => false,
    getTrackedSessionIds: () => [],
    runOnTarget: async (_target: unknown, operation: () => Promise<unknown>) => operation(),
    notifyQueueChanged: () => undefined,
    onRename: () => undefined,
    cancelPrepared: async () => undefined,
  };
  const host = {
    app,
    sessionStore,
    continuations,
    settings: { ...DEFAULT_SETTINGS, audioFolder: "QnALog/录音", mdFolder: "QnALog/转写纪要", segmentCacheFolder: "QnALog/.cache/segments" },
    bubble: null,
    recorder: { state: "idle", _voicedTicks: 0, _silentTicks: 0, getInfo: () => ({ elapsed: 0, issue: null }), start: async () => { throw new Error("microphone unavailable"); }, stop: async () => undefined, releaseStream: () => undefined },
    meetingWorkbench: { removeLiveTranscriptBlock: async () => undefined, processPendingMeetingWorkbenchInteractions: async () => undefined, scheduleMeetingWorkbenchInteraction: () => undefined, makeStreamingNoteUpdater: () => () => undefined },
    noteWriter: {
      appendToNote: async (path: string, content: string) => {
        const cur = String(files.get(path)?.content ?? "");
        files.set(path, { content: cur + content });
      },
      insertBeforeSegmentsEnd: async () => undefined,
      removeEmptySessionBlock: async (session: { mdPath: string }) => { files.delete(session.mdPath); },
      appendPolishBlock: async () => undefined,
      rewriteConsolidated: async () => undefined,
      renameMarkdownWithGeneratedTitle: async () => null,
      detectModeFromMarkdown: () => "synthesis",
    },
    profiles: {
      getActiveTranscribeProfile: () => ({ transcribeMode: "segmented", model: "test" }),
      getTranscribeProviderProfile: () => ({ transcribeMode: "segmented" }),
    },
    queue: {
      tasks: [] as unknown[],
      add: async (task: unknown) => { transcriptionCalls.push("queue"); return Object.assign({ id: "task" }, task); },
      update: async () => undefined,
      remove: async () => undefined,
      snapshot: () => [],
    },
    requestDeferredAsrRetry: () => undefined,
    requestTaskQueueRetry: () => undefined,
    readVaultAudioBlob: async () => null,
    diagnostics: { logDiagnostic: async (_level: string, event: string, message: string, data: unknown) => { diagnostics.push({ event, message, data }); } },
    taskMeters: { beginTaskMeter: () => null, endTaskMeter: () => null, logCompletedWork: () => undefined },
    syncImportBusyFromSessionProgress: () => undefined,
    requestOutlineRefresh: () => undefined,
    requestOpenOutlineView: async () => undefined,
    outline: { scheduleRealtimeOutline: () => undefined, ensureRealtimeOutlineForFinalNote: async () => undefined },
    noteIndex: { refreshNoteIndexSafely: async () => undefined, autoExtractSedimentAfterFinalize: () => undefined },
    saveSettings: async () => undefined,
  } as unknown as RecordingHost & SessionFinalizeHost;

  const finalizeService = new SessionFinalizeService(host);
  let recordingService: RecordingService;
  host.asrPipeline = new LiveAsrPipelineService({
    getSettings: () => host.settings,
    vault: app.vault,
    fileManager: app.fileManager,
    diagnostics: host.diagnostics,
    queueTasks: () => host.queue.tasks as never,
    addQueueTask: (task) => host.queue.add(task) as never,
    updateQueueTask: (id, patch) => host.queue.update(id, patch),
    removeQueueTask: (id) => host.queue.remove(id),
    removeLiveTranscriptBlock: (path, sessionId) => host.meetingWorkbench.removeLiveTranscriptBlock(path, sessionId),
    getRecorderBufferSummary: () => recordingService.getRecorderBufferSummary(),
    syncImportBusyFromSessionProgress: () => undefined,
    requestOutlineRefresh: () => host.requestOutlineRefresh(),
    requestBubbleUpdate: () => undefined,
  });
  host.processRecordedSegment = (session, segment) => finalizeService.processSegment(session, segment);
  host.finalizeRecordedSession = (session) => finalizeService.finalizeSession(session);
  recordingService = new RecordingService(host);
  return { host, files, folders, app, transcriptionCalls, diagnostics, finalizeService, recordingService };

}
async function makeContinuationDiscardFixture() {
  const fixture = makeHost();
  let persistedQueue = "[]";
  let queue: TaskQueue;
  let retryService: QueueRetryService;
  let nextSaveError = "";
  const queueHost: TaskQueueHost = {
    getMaxRetries: () => fixture.host.settings.maxRetries,
    persistQueue: async () => {
      if (nextSaveError) {
        const error = nextSaveError;
        nextSaveError = "";
        throw new Error(error);
      }
      persistedQueue = JSON.stringify(queue.snapshot());
    },
    updateBusyStatus: () => undefined,
    retryTranscribeTask: async () => { throw new Error("Unexpected transcription task in discard fixture"); },
    retryMergeTask: (task) => retryService.retryMergeTask(task),
    runGeneratePromptTask: async () => { throw new Error("Unexpected prompt task in discard fixture"); },
    scheduleTaskQueueRetry: () => undefined,
    isAsrServiceCircuitOpen: () => false,
    getAsrServiceRetryDelayMs: () => 0,
    getAsrServiceCircuitState: () => ({ consecutiveFailures: 0, openUntilMs: 0, lastError: "" }),
    recordAsrServiceAttemptSuccess: () => undefined,
    recordAsrServiceAttemptFailure: () => ({ consecutiveFailures: 0, openUntilMs: 0, lastError: "" }),
    completeTaskActivity: () => undefined,
    logCompletedWork: () => undefined,
    logDiagnostic: async (level, code, message, data) => fixture.host.diagnostics.logDiagnostic(level, code, message, data),
  };
  queue = new TaskQueue(queueHost);
  const continuations = new ContinuationService({
    vault: fixture.app.vault as never,
    fileManager: fixture.app.fileManager as never,
    getSettings: () => fixture.host.settings as never,
    detectModeFromMarkdown: () => "synthesis",
    queueTasks: () => queue.tasks,
    addTask: task => queue.add(task as never) as never,
    removeTask: id => queue.remove(id),
    scheduleTaskQueueRetry: () => undefined,
  });
  fixture.host.queue = queue;
  fixture.host.continuations = continuations;
  retryService = new QueueRetryService({
    app: fixture.app,
    continuations,
    queue,
    asrPipeline: fixture.host.asrPipeline,
  } as never);
  const prior = attachTextTranscript({ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "OLD BODY MUST STAY" }, "old-session", "text-import");
  const oldBody = `# Existing minutes\n\n${serializeTranscriptBlock(prior, "### Original transcript", prior.text)}\n`;
  const targetPath = "QnALog/转写纪要/existing.md";
  fixture.files.set(targetPath, { content: oldBody });
  const target = fixture.app.vault.getAbstractFileByPath(targetPath) as obsidian.TFile;
  vi.stubGlobal("window", {
    moment: () => ({
      format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260918-120000" : "2026-09-18 12:00",
    }),
  });
  const prepared = await continuations.prepare(target, "session-1", "20260918-120000", "2026-09-18T12:00:00.000Z");
  const session = Object.assign(makeSession(prepared.stageFile.path), {
    shortRecordingTier: "discard",
    shortRecordingDurationMs: 2000,
    continuationTaskId: prepared.taskId,
    continuation: prepared.continuation,
    continuationSourcePath: target.path,
  });
  fixture.host.sessionStore.begin(session);
  continuations.trackSession(session as never, target);
  const reloadQueue = () => {
    queue = new TaskQueue(queueHost);
    queue.load(JSON.parse(persistedQueue));
    return queue;
  };
  return { ...fixture, get queue() { return queue; }, reloadQueue, retryService, continuations, targetPath, oldBody, session, persistedQueue: () => persistedQueue, failNextSave: (message: string) => { nextSaveError = message; } };
}

/** 与 startRecording 写入磁盘的纪要头一致：标题 + 会话标记 + 分段区标记。 */
function sessionHeader(stamp: string) {
  return `# ${stamp} · 综合纪要（录音中…）\n\n<!-- qnalog-session:session-1 -->\n<!-- qnalog-segments-start:session-1 -->\n<!-- qnalog-segments-end:session-1 -->\n`;
}

/** 会话对象取 startRecording 里那批字段的短录音相关子集。 */
function makeSession(mdPath: string) {
  return {
    id: "session-1",
    sessionStamp: "20260918-120000",
    startedAt: new Date().toISOString(),
    mdPath,
    mode: "synthesis",
    segments: [] as unknown[],
    writeQueue: Promise.resolve(),
    segmentPersistQueue: Promise.resolve(),
    liveAsrJobs: new Map(),
    activeSegmentJobs: 0,
    finalized: false,
    captureMode: "mic",
  } as never;
}

const finalPayload = (endOffsetMs: number) => ({
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
  index: 0,
  startOffsetMs: 0,
  endOffsetMs,
  isFinal: true,
  ext: "webm",
  masterBlob: new Blob([new Uint8Array([4, 5, 6, 7])], { type: "audio/webm" }),
  masterMime: "audio/webm",
  masterExt: "webm",
});

describe("短录音整条路径", () => {
  it("4 秒录音：音频写入录音目录，纪要文件被清除，不发出转写请求", async () => {
    notices.length = 0;
    trashed.length = 0;
    const { host, files, transcriptionCalls, recordingService, finalizeService } = makeHost();
    const mdPath = "QnALog/转写纪要/2026-09-18 1200.md";
    files.set(mdPath, { content: sessionHeader("2026-09-18 12:00") });
    const session = makeSession(mdPath);
    host.sessionStore.begin(session);

    await recordingService.handleSegment(session as never, finalPayload(4000) as never);
    await (session as unknown as { writeQueue: Promise<void> }).writeQueue;
    await finalizeService.finalizeSession(session as never);

    const audioFiles = [...files.keys()].filter((p) => p.startsWith("QnALog/录音/"));
    expect(audioFiles).toHaveLength(1);
    expect(audioFiles[0]).toContain("qnalog-20260918-120000");
    expect(trashed).toContain(mdPath);
    expect(transcriptionCalls).toEqual([]);
    expect(host.sessionStore.get()).toBeNull();
    expect(notices.join("\n")).toContain("audio kept in the recording folder");
  });

  it("2 秒录音：不写音频文件，纪要文件被清除", async () => {
    notices.length = 0;
    trashed.length = 0;
    const { host, files, recordingService, finalizeService } = makeHost();
    const mdPath = "QnALog/转写纪要/2026-09-18 1201.md";
    files.set(mdPath, { content: sessionHeader("2026-09-18 12:01") });
    const session = makeSession(mdPath);
    host.sessionStore.begin(session);

    await recordingService.handleSegment(session as never, finalPayload(2000) as never);
    await (session as unknown as { writeQueue: Promise<void> }).writeQueue;
    await finalizeService.finalizeSession(session as never);

    expect([...files.keys()].filter((p) => p.startsWith("QnALog/录音/"))).toEqual([]);
    expect(trashed).toContain(mdPath);
    expect(notices.join("\n")).toContain("Filtered out recordings shorter than three seconds");
  });
  it("a two-second continuation leaves the target untouched and removes its persisted merge task", async () => {
    const fixture = await makeContinuationDiscardFixture();
    try {
      await fixture.recordingService.handleSegment(fixture.session as never, finalPayload(2000) as never);
      await fixture.session.writeQueue;
      expect(fixture.files.get(fixture.targetPath)?.content).toBe(fixture.oldBody);
      expect(fixture.files.has(fixture.session.mdPath)).toBe(false);
      expect(fixture.session.finalized).toBe(true);
      expect(fixture.host.sessionStore.get()).toBeNull();
      expect(fixture.queue.tasks).toEqual([]);
      expect(JSON.parse(fixture.persistedQueue())).toEqual([]);
      expect(fixture.transcriptionCalls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("does not remove the stage when saving discard intent fails and permits same-session finalization retry", async () => {
    const fixture = await makeContinuationDiscardFixture();
    fixture.failNextSave("intent save failed");
    try {
      await fixture.recordingService.handleSegment(fixture.session as never, finalPayload(2000) as never);
      await fixture.session.writeQueue;

      expect(fixture.files.has(fixture.session.mdPath)).toBe(true);
      expect(fixture.files.get(fixture.targetPath)?.content).toBe(fixture.oldBody);
      expect(fixture.session.finalized).toBe(false);
      expect(fixture.session.finalizationError).toContain("intent save failed");
      expect(fixture.continuations.isSessionTracked(fixture.session.id)).toBe(false);

      await fixture.finalizeService.finalizeSession(fixture.session as never);
      expect(fixture.files.has(fixture.session.mdPath)).toBe(false);
      expect(fixture.files.get(fixture.targetPath)?.content).toBe(fixture.oldBody);
      expect(fixture.session.finalized).toBe(true);
      expect(fixture.queue.tasks).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("persists discard intent across cleanup failure and retries only stage cleanup after reload", async () => {
    const fixture = await makeContinuationDiscardFixture();
    const trashFile = fixture.app.fileManager.trashFile;
    let trashFailures = 2;
    fixture.app.fileManager.trashFile = async (file: { path: string }) => {
      if (trashFailures > 0) {
        trashFailures--;
        throw new Error("trash I/O failed");
      }
      await trashFile(file);
    };
    try {
      await fixture.recordingService.handleSegment(fixture.session as never, finalPayload(2000) as never);
      await fixture.session.writeQueue;

      expect(fixture.files.get(fixture.targetPath)?.content).toBe(fixture.oldBody);
      expect(fixture.files.has(fixture.session.mdPath)).toBe(true);
      expect(fixture.session.finalized).toBe(false);
      const savedAfterFailure = JSON.parse(fixture.persistedQueue());
      expect(savedAfterFailure).toHaveLength(1);
      expect(savedAfterFailure[0]).toMatchObject({
        continuationDisposition: "discard",
        status: "failed",
        lastError: "trash I/O failed",
        segments: [],
      });
      const restoredQueue = fixture.reloadQueue();
      await expect(restoredQueue.processOne(restoredQueue.tasks[0])).rejects.toThrow("trash I/O failed");
      expect(restoredQueue.tasks[0]).toMatchObject({ status: "failed", retries: 1, lastError: "trash I/O failed" });
      expect(fixture.files.get(fixture.targetPath)?.content).toBe(fixture.oldBody);
      expect(restoredQueue.tasks[0].continuationDisposition).toBe("discard");
      await restoredQueue.processOne(restoredQueue.tasks[0]);
      expect(fixture.files.get(fixture.targetPath)?.content).toBe(fixture.oldBody);
      expect(fixture.files.has(fixture.session.mdPath)).toBe(false);
      expect(restoredQueue.tasks).toEqual([]);
      expect(JSON.parse(fixture.persistedQueue())).toEqual([]);
      expect(fixture.transcriptionCalls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("removes a discard task after reload when stage trash succeeded but queue removal was not saved", async () => {
    const fixture = await makeContinuationDiscardFixture();
    const trashFile = fixture.app.fileManager.trashFile;
    fixture.app.fileManager.trashFile = async (file: { path: string }) => {
      await trashFile(file);
      fixture.failNextSave("remove save failed");
    };
    try {
      await fixture.recordingService.handleSegment(fixture.session as never, finalPayload(2000) as never);
      await fixture.session.writeQueue;

      expect(fixture.files.get(fixture.targetPath)?.content).toBe(fixture.oldBody);
      expect(fixture.files.has(fixture.session.mdPath)).toBe(false);
      expect(fixture.session.finalized).toBe(false);
      expect(fixture.queue.tasks).toEqual([]);
      expect(JSON.parse(fixture.persistedQueue())).toMatchObject([
        { continuationDisposition: "discard", temporarySourcePath: fixture.session.mdPath },
      ]);

      const restoredQueue = fixture.reloadQueue();
      await restoredQueue.processAll();
      expect(fixture.files.get(fixture.targetPath)?.content).toBe(fixture.oldBody);
      expect(restoredQueue.tasks).toEqual([]);
      expect(JSON.parse(fixture.persistedQueue())).toEqual([]);
      expect(fixture.transcriptionCalls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("validates discard cleanup paths and treats an already missing stage as complete", async () => {
    const fixture = await makeContinuationDiscardFixture();
    try {
      const task = fixture.queue.tasks[0];
      if (!task || task.type !== "merge") throw new Error("continuation task missing");
      task.continuationDisposition = "discard";
      const tracked = await fixture.retryService.runAppendTask(task as never);
      expect(tracked).toMatchObject({ deferred: true });

      fixture.continuations.releaseSession(task.sessionId);
      task.temporarySourcePath = fixture.targetPath;
      expect(await fixture.retryService.runAppendTask(task as never)).toMatchObject({ status: "blocked" });
      task.temporarySourcePath = "QnALog/folder";
      fixture.folders.add("QnALog/folder");
      expect(await fixture.retryService.runAppendTask(task as never)).toMatchObject({ status: "blocked" });
      task.temporarySourcePath = fixture.session.mdPath;
      task.continuationDisposition = "unexpected" as never;
      expect(await fixture.retryService.runAppendTask(task as never)).toMatchObject({ status: "blocked" });

      task.continuationDisposition = "discard";
      fixture.files.delete(fixture.targetPath);
      expect(await fixture.retryService.runAppendTask(task as never)).toBeUndefined();
      expect(fixture.files.has(fixture.session.mdPath)).toBe(false);
      expect(fixture.files.has(fixture.targetPath)).toBe(false);
      expect(await fixture.retryService.runAppendTask(task as never)).toBeUndefined();
      expect(fixture.transcriptionCalls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("12 秒录音仍走正常流程：切片进缓存并登记转写任务，纪要保留", async () => {
    notices.length = 0;
    trashed.length = 0;
    const { host, files, transcriptionCalls, recordingService } = makeHost();
    const mdPath = "QnALog/转写纪要/2026-09-18 1202.md";
    files.set(mdPath, { content: sessionHeader("2026-09-18 12:02") });
    const session = makeSession(mdPath);
    host.sessionStore.begin(session);

    await recordingService.handleSegment(session as never, finalPayload(12_000) as never);

    // 切片写入分段缓存目录并登记队列任务，是「正常整理」与「只留音频」两条路径的分界。
    const cacheFiles = [...files.keys()].filter((p) => p.startsWith("QnALog/.cache/segments/"));
    expect(cacheFiles).toHaveLength(1);
    expect(cacheFiles[0]).toContain("seg01");
    expect(transcriptionCalls).toContain("queue");
    expect(trashed).toEqual([]);
    expect(files.get(mdPath)?.content).toContain("qnalog-segments-start:session-1");
  });

  it("an old short-recording finalizer does not clear the replacement session", async () => {
    const { host, files, finalizeService } = makeHost();
    const first = Object.assign(makeSession("QnALog/转写纪要/first.md"), {
      shortRecordingTier: "discard",
      shortRecordingDurationMs: 2000,
    });
    const second = makeSession("QnALog/转写纪要/second.md");
    files.set(first.mdPath, { content: sessionHeader("first") });
    host.sessionStore.begin(first);
    host.sessionStore.begin(second);

    await finalizeService.finishShortRecording(first as never);

    expect(host.sessionStore.get()).toBe(second);
  });
  it("a failed recording start removes its placeholder and ends only its own session", async () => {
    notices.length = 0;
    const { host, files, recordingService } = makeHost();
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260918-120300" : "2026-09-18 12:03",
        toDate: () => new Date("2026-09-18T12:03:00.000Z"),
      }),
    });
    try {
      await recordingService.startRecording();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(host.sessionStore.get()).toBeNull();
    expect(files.has("QnALog/转写纪要/2026-09-18 12:03.md")).toBe(false);
    expect(notices.join("\n")).toContain("Cannot start recording");
  });
});

describe("session note block cleanup consumers", () => {
  const mdPath = "QnALog/转写纪要/session-cleanup.md";
  const completeBlock = "## Disposable\n<!-- qnalog-session:session-1 -->\n<!-- qnalog-segments-start:session-1 -->\n<!-- qnalog-segments-end:session-1 -->";
  const fullInput = `KEEP-A\n\n${completeBlock}\n\nKEEP-B\n`;
  const expected = "KEEP-A\n\nKEEP-B\n";

  it("NoteWriter removes only its session range and leaves a repeated cleanup unchanged", async () => {
    const { host, files } = makeHost();
    const writer = new NoteWriter({ app: host.app, settings: host.settings } as NoteWriterHost);
    files.set(mdPath, { content: fullInput });

    await writer.removeEmptySessionBlock(makeSession(mdPath));

    expect(files.get(mdPath)?.content).toBe(expected);
    expect(files.has(mdPath)).toBe(true);
    await writer.removeEmptySessionBlock(makeSession(mdPath));
    expect(files.get(mdPath)?.content).toBe(expected);
  });

  it("short-recording cleanup removes a matching session and trashes a file emptied by removal", async () => {
    trashed.length = 0;
    const { host, files } = makeHost();
    const session = { id: "session-1", mdPath };
    files.set(mdPath, { content: sessionHeader("short") });

    await host.asrPipeline.discardShortRecordingNote(session as never);

    expect(files.has(mdPath)).toBe(false);
    expect(trashed).toContain(mdPath);
  });

  it("both consumers retain an incomplete target range and preserve the next session", async () => {
    const { host, files } = makeHost();
    const writer = new NoteWriter({ app: host.app, settings: host.settings } as NoteWriterHost);
    files.set(mdPath, { content: fullInput.replace("qnalog-segments-end:session-1", "qnalog-segments-end:session-other") });
    await writer.removeEmptySessionBlock(makeSession(mdPath));
    expect(files.get(mdPath)?.content).toBe(fullInput.replace("qnalog-segments-end:session-1", "qnalog-segments-end:session-other"));

    const streaming = { _safeClose: vi.fn() };
    const encoder = { stop: vi.fn() };
    const session = { id: "session-1", mdPath, pcmEncoder: encoder, streamingClient: streaming };
    await host.asrPipeline.discardShortRecordingNote(session as never);

    expect(files.get(mdPath)?.content).toBe(fullInput.replace("qnalog-segments-end:session-1", "qnalog-segments-end:session-other"));
    expect(encoder.stop).toHaveBeenCalledOnce();
    expect(streaming._safeClose).toHaveBeenCalledOnce();
    expect(session.pcmEncoder).toBeNull();
    expect(session.streamingClient).toBeNull();
  });

  it("both consumers remove the second block while retaining the first session", async () => {
    const first = completeBlock.replace("Disposable", "First").replaceAll("session-1", "session-first");
    const second = completeBlock.replace("Disposable", "Second").replaceAll("session-1", "session-2");
    const input = `${first}\n\n${second}\n`;
    const expectedAfter = `${first}\n`;

    const writerHost = makeHost();
    const writer = new NoteWriter({ app: writerHost.host.app, settings: writerHost.host.settings } as NoteWriterHost);
    writerHost.files.set(mdPath, { content: input });
    await writer.removeEmptySessionBlock(Object.assign(makeSession(mdPath), { id: "session-2" }) as never);
    expect(writerHost.files.get(mdPath)?.content).toBe(expectedAfter);

    const asrHost = makeHost();
    asrHost.files.set(mdPath, { content: input });
    await asrHost.host.asrPipeline.discardShortRecordingNote(Object.assign(makeSession(mdPath), { id: "session-2" }) as never);
    expect(asrHost.files.get(mdPath)?.content).toBe(expectedAfter);
    expect(asrHost.files.has(mdPath)).toBe(true);
  });
});

describe("NoteWriter segment insertion consumer", () => {
  const mdPath = "QnALog/转写纪要/segments-insert.md";
  const content = "Literal $&; $` and $' plus $$ stays literal.";

  it("inserts literally before the first matching session marker and preserves other sessions", async () => {
    const { host, files } = makeHost();
    const writer = new NoteWriter({ app: host.app, settings: host.settings } as NoteWriterHost);
    const input = [
      "FIRST",
      "<!-- qnalog-segments-end:other -->",
      "MIDDLE",
      "<!-- qnalog-segments-end:target -->",
      "BETWEEN",
      "<!-- qnalog-segments-end:target -->",
      "LAST",
    ].join("\n");
    files.set(mdPath, { content: input });

    await writer.insertBeforeSegmentsEnd(mdPath, content, "target");

    expect(files.get(mdPath)?.content).toBe([
      "FIRST",
      "<!-- qnalog-segments-end:other -->",
      "MIDDLE",
      `${content}`,
      "<!-- qnalog-segments-end:target -->",
      "BETWEEN",
      "<!-- qnalog-segments-end:target -->",
      "LAST",
    ].join("\n"));
  });

  it("inserts before the last no-session marker and appends when no marker exists", async () => {
    const { host, files } = makeHost();
    const writer = new NoteWriter({ app: host.app, settings: host.settings } as NoteWriterHost);
    const input = "BEFORE\n<!-- qnalog-segments-end -->\nMIDDLE\n<!-- qnalog-segments-end -->\nAFTER";
    files.set(mdPath, { content: input });

    await writer.insertBeforeSegmentsEnd(mdPath, content, "missing-session");

    expect(files.get(mdPath)?.content).toBe(
      "BEFORE\n<!-- qnalog-segments-end -->\nMIDDLE\n" +
      `${content}\n<!-- qnalog-segments-end -->\nAFTER`,
    );

    files.set(mdPath, { content: "NO MARKER\n" });
    await writer.insertBeforeSegmentsEnd(mdPath, content, "missing-session");
    expect(files.get(mdPath)?.content).toBe(`NO MARKER\n${content}`);
  });
});
