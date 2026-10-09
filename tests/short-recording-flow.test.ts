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
    Platform: { isMobile: false, isMobileApp: false },
  };
});

import * as obsidian from "obsidian";
import { RecordingService } from "../src/audio/recording-service";
import type { RecordingHost } from "../src/audio/recording-service";
import { ensureVaultFolder } from "../src/shared/util-vault";
import { SessionFinalizeService } from "../src/notes/session-finalize-service";
import { SessionStore } from "../src/session/session-store";
import { ContinuationService } from "../src/session/continuation-service";
import { TaskQueue } from "../src/queue/task-queue";
import type { TaskQueueHost } from "../src/queue/task-queue";
import { QueueRetryService } from "../src/queue/queue-retry-service";
import { LiveAsrPipelineService } from "../src/asr/live-asr-pipeline-service";
import { NoteWriter } from "../src/notes/note-writer";
import type { NoteWriterHost } from "../src/notes/note-writer";
import type { ContinuationPreparation } from "../src/session/continuation-service";
import * as recordingIssues from "../src/notes/recording-issues";
import { normalizeRealtimeOutlineState } from "../src/notes/realtime-outline";
 
import { PcmStreamEncoder } from "../src/asr/clients";
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
  } as unknown as SessionFinalizeHost & {
    asrPipeline: LiveAsrPipelineService;
    saveSettings: () => Promise<void>;
    processRecordedSegment: RecordingHost["processRecordedSegment"];
    finalizeRecordedSession: RecordingHost["finalizeRecordedSession"];
  };

  const finalizeService = new SessionFinalizeService(host);
  host.processRecordedSegment = (session, segment) => finalizeService.processSegment(session, segment);
  host.finalizeRecordedSession = (session) => finalizeService.finalizeSession(session);
  const recordingHost: RecordingHost = {
    ensureFolder: (path) => ensureVaultFolder(app, path),
    getFileByPath: (path) => app.vault.getAbstractFileByPath(path),
    get settings() { return host.settings; },
    get diagnostics() { return host.diagnostics; },
    get meetingWorkbench() { return host.meetingWorkbench as RecordingHost["meetingWorkbench"]; },
    get noteWriter() { return host.noteWriter; },
    get profiles() { return host.profiles; },
    get continuations() { return host.continuations; },
    get recorder() { return host.recorder; },
    saveSettings: () => host.saveSettings(),
    get sessionStore() { return host.sessionStore; },
    get asrPipeline() { return host.asrPipeline; },
    processRecordedSegment: (session, segment) => host.processRecordedSegment(session, segment),
    finalizeRecordedSession: (session) => host.finalizeRecordedSession(session),
    requestOutlineRefresh: () => host.requestOutlineRefresh(),
    requestOpenOutlineView: () => host.requestOpenOutlineView(),
    resolveRuntimeAudioInputMode: recordingIssues.resolveRuntimeAudioInputMode,
    normalizeRealtimeOutlineState,
    classifyRecordingIssue: recordingIssues.classifyRecordingIssue,
    createStreamingTranscriptionClient: recordingIssues.createStreamingTranscriptionClient,
    createPcmEncoder: (stream, options) => new PcmStreamEncoder(stream, options),
  };
  let recordingService: RecordingService;
  recordingService = new RecordingService(recordingHost);
  host.asrPipeline = new LiveAsrPipelineService({
    getSettings: () => host.settings,
    vault: app.vault,
    fileManager: app.fileManager,
    diagnostics: host.diagnostics,
    queueTasks: () => host.queue.tasks as never,
    queueRecoveryEntries: () => host.queue.recoveryEntries(),
    addQueueTask: (task) => host.queue.add(task) as never,
    updateQueueTask: (id, patch) => host.queue.update(id, patch),
    removeQueueTask: (id) => host.queue.remove(id),
    removeLiveTranscriptBlock: (path, sessionId) => host.meetingWorkbench.removeLiveTranscriptBlock(path, sessionId),
    getRecorderBufferSummary: () => recordingService.getRecorderBufferSummary(),
    syncImportBusyFromSessionProgress: () => undefined,
    requestOutlineRefresh: () => host.requestOutlineRefresh(),
    requestBubbleUpdate: () => undefined,
  });
  return { host, files, folders, app, transcriptionCalls, diagnostics, finalizeService, recordingService };

}
function makeNoteWriterHost(host: {
  app: { vault: unknown; metadataCache: { getFileCache: (file: obsidian.TFile) => { frontmatter?: obsidian.CachedMetadata["frontmatter"] } | null } };
  settings: NoteWriterHost["settings"];
}): NoteWriterHost {
  return {
    vault: host.app.vault as never,
    settings: host.settings,
    noteIndex: { refreshNoteIndexSafely: async () => undefined },
    getFileFrontmatter: (file) => host.app.metadataCache.getFileCache(file)?.frontmatter,
    ensureFolder: async (path) => ensureVaultFolder(host.app as never, path),
    findAvailableMarkdownPath: () => { throw new Error("unexpected path allocation"); },
    renameFile: async () => { throw new Error("unexpected rename"); },
    openFile: async () => { throw new Error("unexpected file open"); },
    confirm: async () => { throw new Error("unexpected confirmation"); },
    getRecentNotes: () => { throw new Error("unexpected recent-note lookup"); },
    generateTitleTag: async () => { throw new Error("unexpected title generation"); },
    polishTranscript: async () => { throw new Error("unexpected transcript polish"); },
    mergeAndPolish: async () => { throw new Error("unexpected note merge"); },
    clearCommittedBriefingCheckpoint: async () => { throw new Error("unexpected checkpoint cleanup"); },
  };
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
      persistedQueue = JSON.stringify(queue.persistedSnapshot());
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
    queueRecoveryEntries: () => queue.recoveryEntries(),
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
  it("sends the configured Bailian Flash request through segment finalization into the note", async () => {
    notices.length = 0;
    const { host, files, finalizeService } = makeHost();
    const mdPath = "QnALog/转写纪要/bailian-flash-smoke.md";
    files.set(mdPath, { content: sessionHeader("2026-09-18 12:00") });
    const session = makeSession(mdPath);
    host.sessionStore.begin(session);
    host.settings.activeTranscribeProvider = "dashscope-flash";
    host.settings.transcribeProviders["dashscope-flash"] = {
      ...DEFAULT_SETTINGS.transcribeProviders["dashscope-flash"],
      apiKey: "test-key",
    };
    host.settings.vocabularyFile = "";
    host.settings.customVocabulary = "";
    host.noteWriter = new NoteWriter(makeNoteWriterHost(host));

    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("window", {
      fetch: vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ output: { text: "模拟模型返回的转写。" } }) };
      }),
      AudioContext: class {
        decodeAudioData = async () => ({ duration: 15, sampleRate: 48000, numberOfChannels: 1 });
        close = async () => undefined;
      },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });

    try {
      await finalizeService.processSegment(session as never, {
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" }),
        index: 0,
        startOffsetMs: 0,
        endOffsetMs: 15_000,
        isFinal: false,
        ext: "webm",
      } as never);

      const markdown = files.get(mdPath)?.content || "";
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
      expect(JSON.parse(String(requests[0].init.body)).model).toBe("qwen-audio-3.1-asr-flash");
      expect(JSON.parse(String(requests[0].init.body)).input.messages[0].content[0].input_audio.data).toMatch(/^data:audio\/webm;base64,/);
      expect(session.segments[0].text).toBe("模拟模型返回的转写。");
      expect(markdown).toContain("模拟模型返回的转写。");
      expect(markdown).toContain("qnalog-transcript-start");
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
  it("starts a continuation in the prepared stage and seeds the prior outline without modifying the target", async () => {
    const fixture = makeHost();
    const targetPath = "QnALog/转写纪要/continuation-target.md";
    const stagePath = "QnALog/转写纪要/continuation-stage.md";
    const targetBody = "# Existing minutes\n\nTarget body must remain unchanged.\n";
    const priorOutline = "- [[qnalog-prior.webm|00:00]] Prior decision";
    fixture.files.set(targetPath, { content: targetBody });
    fixture.files.set(stagePath, { content: "" });
    const target = fixture.app.vault.getAbstractFileByPath(targetPath) as obsidian.TFile;
    const stageFile = fixture.app.vault.getAbstractFileByPath(stagePath) as obsidian.TFile;
    const preparation: ContinuationPreparation = {
      stageFile,
      taskId: "continuation-task",
      continuation: { targetPath, targetSourceId: "source-1", recordedAt: "2026-09-18T12:00:00.000Z" },
      dependsOnSessionIds: [],
      mode: "synthesis",
      priorOutline,
    };
    Object.assign(fixture.host.continuations, {
      resolveTarget: () => target,
      prepare: async () => preparation,
    });
    fixture.host.recorder.start = async () => { fixture.host.recorder.state = "recording"; };
    vi.stubGlobal("window", {
      moment: () => ({
        format: (pattern: string) => pattern === "YYYYMMDD-HHmmss" ? "20260918-120000" : "2026-09-18 12:00",
        toDate: () => new Date("2026-09-18T12:00:00.000Z"),
      }),
    });

    try {
      await fixture.recordingService.startRecording({ appendToFile: target });
      const session = fixture.host.sessionStore.get();
      expect(session).toMatchObject({
        mdPath: stagePath,
        continuationSourcePath: targetPath,
        realtimeOutline: priorOutline,
      });
      expect(session?.realtimeOutlineState.nodes).toHaveLength(1);
      expect(session?.realtimeOutlineState.nodes[0]).toMatchObject({
        title: "Prior decision",
        anchor: "[[qnalog-prior.webm|00:00]]",
      });
      expect(fixture.files.get(targetPath)?.content).toBe(targetBody);
      expect(fixture.files.get(stagePath)?.content).toBe("");
      expect(fixture.recordingService.starting).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
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
  it("masterOnly finalization saves the full recording without retranscribing existing segments", async () => {
    const { host, files, transcriptionCalls, recordingService } = makeHost();
    const mdPath = "QnALog/转写纪要/master-only.md";
    const prior = attachTextTranscript(
      { index: 0, startOffsetMs: 0, endOffsetMs: 8000, text: "Existing transcript must remain unchanged" },
      "session-1",
      "text-import",
    );
    const initialBody = `${sessionHeader("master-only")}${serializeTranscriptBlock(prior, "### Original transcript", prior.text)}\n`;
    files.set(mdPath, { content: initialBody });
    const session = makeSession(mdPath);
    session.segments = [prior];
    host.sessionStore.begin(session);
    host.finalizeRecordedSession = async () => undefined;
    const payload = {
      ...finalPayload(12_000),
      blob: new Blob([], { type: "audio/webm" }),
      masterOnly: true,
      masterBlob: new Blob(["complete recording"], { type: "audio/webm" }),
    };

    await recordingService.handleSegment(session as never, payload as never);

    expect(files.get(mdPath)?.content).toBe(initialBody);
    expect(session.segments).toEqual([prior]);
    expect([...files.keys()].filter((path) => path.startsWith("QnALog/.cache/segments/"))).toEqual([]);
    expect([...files.keys()].filter((path) => path.startsWith("QnALog/录音/"))).toHaveLength(1);
    expect(transcriptionCalls).toEqual([]);
  });
  it("RecordingService releases ordinary-cut audio after real saves and waits through final processing", async () => {
    const { host, files, recordingService } = makeHost();
    let releaseSpool!: () => void;
    let releaseMaster!: () => void;
    let releaseProcessing!: () => void;
    let releaseFinalize!: () => void;
    const spoolGate = new Promise<void>((resolve) => { releaseSpool = resolve; });
    const masterGate = new Promise<void>((resolve) => { releaseMaster = resolve; });
    const processingGate = new Promise<void>((resolve) => { releaseProcessing = resolve; });
    const finalizeGate = new Promise<void>((resolve) => { releaseFinalize = resolve; });
    const pipeline = host.asrPipeline;
    const saveSegment = pipeline.queueLiveSegmentPersistence.bind(pipeline);
    const saveMaster = pipeline.startMasterAudioSave.bind(pipeline);
    let cachePath = "";
    pipeline.queueLiveSegmentPersistence = (session, descriptor, blob) => {
      cachePath = descriptor.segmentAudioPath || "";
      return spoolGate.then(() => saveSegment(session, descriptor, blob));
    };
    pipeline.startMasterAudioSave = (session, segment) => masterGate.then(() => saveMaster(session, segment));

    const processedSegments: number[] = [];
    host.processRecordedSegment = async (_session, segment) => {
      processedSegments.push(Number(segment.endOffsetMs));
      await processingGate;
    };
    let finalizeStarted = false;
    host.finalizeRecordedSession = async () => {
      finalizeStarted = true;
      await finalizeGate;
    };

    const session = makeSession("QnALog/转写纪要/segment-flow.md");
    files.set(session.mdPath, { content: sessionHeader("segment-flow") });
    host.sessionStore.begin(session);
    let ordinaryReturned = false;
    const ordinaryResult = recordingService.handleSegment(session as never, {
      ...finalPayload(8000),
      index: 0,
      isFinal: false,
    } as never);
    if (!ordinaryResult) throw new Error("ordinary segment unexpectedly skipped");
    void ordinaryResult.then(() => { ordinaryReturned = true; });

    for (let attempt = 0; attempt < 20 && !cachePath; attempt += 1) await Promise.resolve();
    expect(cachePath).not.toBe("");
    expect(ordinaryReturned).toBe(false);
    releaseSpool();
    for (let attempt = 0; attempt < 20 && !files.has(cachePath); attempt += 1) await Promise.resolve();
    expect(files.has(cachePath)).toBe(true);
    expect(ordinaryReturned).toBe(false);
    releaseMaster();
    await ordinaryResult;
    expect(ordinaryReturned).toBe(true);
    expect(processedSegments).toEqual([8000]);

    let finalReturned = false;
    const finalResult = recordingService.handleSegment(session as never, {
      ...finalPayload(12_000),
      index: 1,
      masterOnly: true,
    } as never);
    if (!finalResult) throw new Error("final segment unexpectedly skipped");
    void finalResult.then(() => { finalReturned = true; });
    await Promise.resolve();
    expect(processedSegments).toEqual([8000]);
    expect(finalReturned).toBe(false);

    releaseProcessing();
    for (let attempt = 0; attempt < 20 && !finalizeStarted; attempt += 1) await Promise.resolve();
    expect(processedSegments).toEqual([8000, 12_000]);
    expect(finalizeStarted).toBe(true);
    expect(finalReturned).toBe(false);
    releaseFinalize();
    await finalResult;
    expect(finalReturned).toBe(true);
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
  it("reads replacement recording settings when starting and creates the note only in the new folder", async () => {
    const { host, files, recordingService } = makeHost();
    host.settings = {
      ...host.settings,
      audioFolder: "QnALog/New Audio",
      mdFolder: "QnALog/New Notes",
      noteFileNameFormatNew: "fixed-note",
    };
    vi.spyOn(host.recorder!, "start").mockImplementation(async () => {
      host.recorder!.state = "recording";
      return undefined as never;
    });
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260918-120400" : format === "fixed-note" ? "fixed-note" : "2026-09-18 12:04",
        toDate: () => new Date("2026-09-18T12:04:00.000Z"),
      }),
    });
    try {
      await recordingService.startRecording();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(host.sessionStore.get()?.mdPath).toBe("QnALog/New Notes/fixed-note.md");
    expect(files.has("QnALog/New Notes/fixed-note.md")).toBe(true);
    expect(files.has("QnALog/转写纪要/fixed-note.md")).toBe(false);
  });

  it("ignores a second continuation target while the first preparation is pending", async () => {
    const { host, files, recordingService } = makeHost();
    const firstTarget = new (obsidian.TFile as never)("QnALog/转写纪要/first-target.md");
    const secondTarget = new (obsidian.TFile as never)("QnALog/转写纪要/second-target.md");
    const firstBody = "FIRST TARGET MUST REMAIN UNCHANGED";
    const secondBody = "SECOND TARGET MUST REMAIN UNCHANGED";
    files.set(firstTarget.path, { content: firstBody });
    files.set(secondTarget.path, { content: secondBody });
    const { promise: preparation, resolve: finishPreparation } = Promise.withResolvers<unknown>();
    const prepare = vi.spyOn(host.continuations, "prepare").mockReturnValue(preparation as never);
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260918-120500" : "2026-09-18 12:05",
        toDate: () => new Date("2026-09-18T12:05:00.000Z"),
      }),
    });
    try {
      const firstStart = recordingService.startRecording({ appendToFile: firstTarget });
      await Promise.resolve();
      await recordingService.startRecording({ appendToFile: secondTarget });
      finishPreparation({
        stageFile: new (obsidian.TFile as never)("QnALog/.staging/first.md"),
        taskId: "pending-first",
        continuation: {},
        dependsOnSessionIds: [],
        mode: "synthesis",
        priorOutline: "",
      } as never);
      await firstStart;
    } finally {
      vi.unstubAllGlobals();
    }

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(files.get(firstTarget.path)?.content).toBe(firstBody);
    expect(files.get(secondTarget.path)?.content).toBe(secondBody);
    expect(recordingService.starting).toBe(false);
  });

  it("keeps a replacement session and its note when the earlier device start fails", async () => {
    const { host, files, recordingService } = makeHost();
    const replacement = makeSession("QnALog/转写纪要/replacement.md");
    files.set(replacement.mdPath, { content: "REPLACEMENT NOTE BODY" });
    vi.spyOn(host.recorder!, "start").mockImplementation(async () => {
      host.sessionStore.begin(replacement);
      throw new Error("fixed device failure");
    });
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260918-120600" : "2026-09-18 12:06",
        toDate: () => new Date("2026-09-18T12:06:00.000Z"),
      }),
    });
    try {
      await recordingService.startRecording();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(host.sessionStore.get()).toBe(replacement);
    expect(files.has("QnALog/转写纪要/2026-09-18 12:06.md")).toBe(false);
    expect(files.get(replacement.mdPath)?.content).toBe("REPLACEMENT NOTE BODY");
    expect(notices.join("\n")).toContain("fixed device failure");
    expect(recordingService.starting).toBe(false);
  });

  it("clears a recording issue only after stop resolves and retains it when stop rejects", async () => {
    const { host, recordingService } = makeHost();
    host.recorder!.state = "recording";
    host.asrPipeline.setRecordingIssue("service", { message: "pending stop issue" });
    const { promise: stopping, resolve: finishStop } = Promise.withResolvers<null>();
    vi.spyOn(host.recorder!, "stop").mockReturnValue(stopping);
    const stop = recordingService.stopRecording();
    expect(recordingService.getRecordingIssue()).not.toBeNull();
    finishStop();
    await stop;
    expect(recordingService.getRecordingIssue()).toBeNull();

    host.asrPipeline.setRecordingIssue("service", { message: "failed stop issue" });
    vi.spyOn(host.recorder!, "stop").mockRejectedValueOnce(new Error("stop failed"));
    await expect(recordingService.stopRecording()).rejects.toThrow("stop failed");
    expect(recordingService.getRecordingIssue()).not.toBeNull();

    host.recorder!.state = "idle";
    await recordingService.stopRecording();
    expect(recordingService.getRecordingIssue()).not.toBeNull();
  });
  it("does not start a second recording while the recorder is recording or paused", async () => {
    const { host, files, recordingService } = makeHost();
    const path = "QnALog/转写纪要/existing-during-recording.md";
    files.set(path, { content: "KEEP EXISTING NOTE" });
    host.recorder!.state = "recording";
    host.asrPipeline.setRecordingIssue("service", { message: "existing issue" });
    const start = vi.spyOn(host.recorder!, "start");
    for (const state of ["recording", "paused"]) {
      host.recorder!.state = state;
      await recordingService.startRecording();
      expect(start).not.toHaveBeenCalled();
      expect(host.sessionStore.get()).toBeNull();
      expect(files.get(path)?.content).toBe("KEEP EXISTING NOTE");
      expect(recordingService.getRecordingIssue()).toMatchObject({ message: "existing issue" });
      expect(recordingService.starting).toBe(false);
    }
    expect(notices.join("\n")).toContain("already in progress");
  });

  it("reads recording settings and recorder at their original post-await access points", async () => {
    const { host, files, recordingService } = makeHost();
    const { promise: folderGate, resolve: releaseFolder } = Promise.withResolvers<void>();
    const ensured: string[] = [];
    vi.spyOn(recordingService.host, "ensureFolder").mockImplementation(async (path) => {
      ensured.push(path);
      if (ensured.length === 1) await folderGate;
    });
    const oldRecorder = host.recorder!;
    const replacementRecorder = {
      state: "idle",
      _voicedTicks: 0,
      _silentTicks: 0,
      getInfo: () => ({ elapsed: 0, issue: null }),
      start: vi.fn(async () => { replacementRecorder.state = "recording"; }),
      stop: async () => undefined,
      releaseStream: () => undefined,
    };
    const oldStart = vi.spyOn(oldRecorder, "start");
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260918-120700" : format === "fixed-new" ? "fixed-new" : "2026-09-18 12:07",
        toDate: () => new Date("2026-09-18T12:07:00.000Z"),
      }),
    });
    try {
      const starting = recordingService.startRecording();
      await Promise.resolve();
      host.settings = {
        ...host.settings,
        audioFolder: "QnALog/New Audio",
        mdFolder: "QnALog/New Notes",
        noteFileNameFormatNew: "fixed-new",
        captureMode: "virtualCable",
      };
      host.recorder = replacementRecorder as never;
      releaseFolder();
      await starting;
    } finally {
      vi.unstubAllGlobals();
    }
    expect(ensured).toEqual(["QnALog/录音", "QnALog/New Notes"]);
    expect(host.sessionStore.get()).toMatchObject({
      mdPath: "QnALog/New Notes/fixed-new.md",
      mode: "synthesis",
      captureMode: "virtualCable",
    });
    expect(files.has("QnALog/New Notes/fixed-new.md")).toBe(true);
    expect(replacementRecorder.start).toHaveBeenCalledOnce();
    expect(replacementRecorder.state).toBe("recording");
    expect(oldStart).not.toHaveBeenCalled();
  });

  it("keeps the original continuation note and releases starting after preparation rejects", async () => {
    notices.length = 0;
    const { host, files, recordingService } = makeHost();
    const target = new (obsidian.TFile as never)("QnALog/转写纪要/prepare-failure.md");
    files.set(target.path, { content: "ORIGINAL NOTE BYTES" });
    vi.spyOn(host.continuations, "prepare").mockRejectedValueOnce(new Error("fixed preparation failure"));
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-18", toDate: () => new Date() }) });
    try {
      await recordingService.startRecording({ appendToFile: target });
      expect(files.get(target.path)?.content).toBe("ORIGINAL NOTE BYTES");
      expect(host.sessionStore.get()).toBeNull();
      expect(recordingService.starting).toBe(false);
      expect(notices.join("\n")).toContain("fixed preparation failure");
      vi.spyOn(host.recorder!, "start").mockImplementation(async () => { host.recorder!.state = "recording"; });
      await recordingService.startRecording();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(host.sessionStore.get()).not.toBeNull();
    expect(recordingService.starting).toBe(false);
  });

  it("clears the dynamically current pipeline issue only after stop resolves", async () => {
    const first = makeHost();
    const second = makeHost();
    first.host.recorder!.state = "recording";
    first.host.asrPipeline.setRecordingIssue("service", { message: "first pipeline issue" });
    second.host.asrPipeline.setRecordingIssue("service", { message: "replacement pipeline issue" });
    const { promise: stopping, resolve: releaseStop } = Promise.withResolvers<void>();
    vi.spyOn(first.host.recorder!, "stop").mockReturnValue(stopping);
    const startStop = first.recordingService.stopRecording();
    first.recordingService.host = second.recordingService.host;
    releaseStop();
    await startStop;
    expect(first.host.asrPipeline.getRecordingIssue()).toMatchObject({ message: "first pipeline issue" });
    expect(second.host.asrPipeline.getRecordingIssue()).toBeNull();
  });

  it("retains a streaming session and classifies a rejected connection as a network issue", async () => {
    notices.length = 0;
    const connectError = new Error("Failed to fetch: fixed streaming connection failure");
    const createClient = vi.spyOn(recordingIssues, "createStreamingTranscriptionClient").mockReturnValue({
      connect: async () => { throw connectError; },
      sendAudioFrame: () => undefined,
      finish: async () => undefined,
      getFullText: () => "",
    } as never);
    const { host, recordingService } = makeHost();
    host.profiles.getActiveTranscribeProfile = () => ({
      transcribeMode: "streaming",
      sampleRate: 16000,
      title: "Streaming test",
    });
    let streamOptions: { onStreamReady?: (stream: MediaStream) => Promise<void> } | undefined;
    vi.spyOn(host.recorder!, "start").mockImplementation(async (options: never) => {
      streamOptions = options;
      host.recorder!.state = "recording";
      await streamOptions?.onStreamReady?.({} as MediaStream);
    });
    const trackSession = vi.spyOn(host.continuations, "trackSession");
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-18", toDate: () => new Date() }) });
    try {
      await recordingService.startRecording();
    } finally {
      createClient.mockRestore();
      vi.unstubAllGlobals();
    }
    const session = host.sessionStore.get();
    expect(session).not.toBeNull();
    expect(session?.streamingClient).toBeNull();
    expect(session?.pcmEncoder).toBeUndefined();
    expect(trackSession).toHaveBeenCalledWith(session, expect.anything());
    expect(recordingService.getRecordingIssue()).toMatchObject({
      kind: "network",
      message: expect.stringContaining("fixed streaming connection failure"),
    });
    expect(recordingService.starting).toBe(false);
  });

  it("preserves caught-error interpolation and conversion failures", async () => {
    const runPreparationFailure = async (reason: unknown) => {
      notices.length = 0;
      const { host, files, recordingService } = makeHost();
      const target = new (obsidian.TFile as never)("QnALog/转写纪要/error-interpolation.md");
      files.set(target.path, { content: "ORIGINAL" });
      vi.spyOn(host.continuations, "prepare").mockRejectedValueOnce(reason);
      vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-18", toDate: () => new Date() }) });
      try {
        await recordingService.startRecording({ appendToFile: target });
        return { files, recordingService, notice: notices.join("\n") };
      } finally {
        vi.unstubAllGlobals();
      }
    };
    const raw = await runPreparationFailure("raw preparation failure");
    expect(raw.notice).toContain("raw preparation failure");
    expect(raw.files.get("QnALog/转写纪要/error-interpolation.md")?.content).toBe("ORIGINAL");
    expect(raw.recordingService.starting).toBe(false);
    const custom = await runPreparationFailure({ message: "custom message", toString: () => "wrong fallback" });
    expect(custom.notice).toContain("custom message");
    expect(custom.files.get("QnALog/转写纪要/error-interpolation.md")?.content).toBe("ORIGINAL");
    expect(custom.recordingService.starting).toBe(false);
    const primitive = await runPreparationFailure({ message: "", [Symbol.toPrimitive]: () => "custom primitive" });
    expect(primitive.notice).toContain("custom primitive");
    expect(primitive.files.get("QnALog/转写纪要/error-interpolation.md")?.content).toBe("ORIGINAL");
    expect(primitive.recordingService.starting).toBe(false);
    const symbolFailure = { message: "", [Symbol.toPrimitive]: () => Symbol("invalid interpolation") };
    notices.length = 0;
    const symbolFixture = makeHost();
    const symbolTarget = new (obsidian.TFile as never)("QnALog/转写纪要/symbol-error.md");
    vi.spyOn(symbolFixture.host.continuations, "prepare").mockRejectedValueOnce(symbolFailure);
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-18", toDate: () => new Date() }) });
    try {
      await expect(symbolFixture.recordingService.startRecording({ appendToFile: symbolTarget })).rejects.toThrow(TypeError);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(symbolFixture.recordingService.starting).toBe(false);
    expect(notices).toHaveLength(0);
    const getterFailure = new Error("message getter failure");
    const badGetter = Object.defineProperty({}, "message", { get() { throw getterFailure; } });
    const getterFixture = makeHost();
    const getterTarget = new (obsidian.TFile as never)("QnALog/转写纪要/getter-error.md");
    vi.spyOn(getterFixture.host.continuations, "prepare").mockRejectedValueOnce(badGetter);
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-18", toDate: () => new Date() }) });
    try {
      await expect(getterFixture.recordingService.startRecording({ appendToFile: getterTarget })).rejects.toBe(getterFailure);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(getterFixture.recordingService.starting).toBe(false);
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
  it("hands a completed continuation back to its existing queue task with all session metadata", async () => {
    const fixture = await makeContinuationDiscardFixture();
    const segments = [{ index: 4, startOffsetMs: 12000, endOffsetMs: 16000, text: "continued transcript", audioPath: "audio.webm" }];
    Object.assign(fixture.session, {
      shortRecordingTier: undefined,
      shortRecordingDurationMs: undefined,
      segments,
      realtimeOutline: "continued outline",
      masterAudioPath: "master.webm",
      masterAudioName: "master.webm",
      meetingWorkbench: { notes: "handoff metadata", entries: [] },
    });
    fixture.finalizeService._finalizeSessionImpl = async () => undefined;

    await fixture.finalizeService.finalizeSession(fixture.session as never);

    const task = fixture.queue.tasks.find((candidate) => candidate.id === (fixture.session as never).continuationTaskId);
    const saved = JSON.parse(fixture.persistedQueue()).find((candidate: { id: string }) => candidate.id === task?.id);
    expect(task).toMatchObject({ status: "pending", mdPath: fixture.session.mdPath, temporarySourcePath: fixture.session.mdPath });
    expect(saved).toMatchObject({
      status: "pending",
      segments,
      continuation: { realtimeOutline: "continued outline", masterAudioPath: "master.webm", masterAudioName: "master.webm" },
      sessionMeta: { startedAt: fixture.session.startedAt, meetingWorkbench: { notes: "handoff metadata", entries: [], draft: "", materials: [] } },
    });
    expect(fixture.files.get(fixture.targetPath)?.content).toBe(fixture.oldBody);
    expect(fixture.files.has(fixture.session.mdPath)).toBe(true);
    expect(fixture.continuations.isSessionTracked(fixture.session.id)).toBe(false);
    expect(fixture.session.finalized).toBe(true);
  });

  it("keeps a failed ordinary continuation pending with its error, then clears it after retry", async () => {
    notices.length = 0;
    const fixture = await makeContinuationDiscardFixture();
    const segments = [{ index: 4, startOffsetMs: 12000, endOffsetMs: 16000, text: "retryable transcript", audioPath: "retryable.webm" }];
    Object.assign(fixture.session, { shortRecordingTier: undefined, shortRecordingDurationMs: undefined, segments });
    let failOnce = true;
    fixture.finalizeService._finalizeSessionImpl = async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("final note write failed");
      }
    };

    await fixture.finalizeService.finalizeSession(fixture.session as never);

    const taskId = (fixture.session as never).continuationTaskId;
    expect(fixture.queue.tasks.find((candidate) => candidate.id === taskId)).toMatchObject({
      status: "pending",
      segments,
      lastError: "final note write failed",
    });
    expect(fixture.files.get(fixture.targetPath)?.content).toBe(fixture.oldBody);
    expect(fixture.files.has(fixture.session.mdPath)).toBe(true);
    expect(fixture.session.finalized).toBe(false);
    expect(fixture.session.finalizationError).toBe("final note write failed");
    expect(fixture.session.workProgress).toMatchObject({ stage: "finalize-failed", percent: null });
    expect(notices.join("\n")).toContain("Failed to finalize minutes");

    await fixture.finalizeService.finalizeSession(fixture.session as never);

    expect(fixture.queue.tasks.find((candidate) => candidate.id === taskId)).toMatchObject({ status: "pending", lastError: "" });
    expect(fixture.files.get(fixture.targetPath)?.content).toBe(fixture.oldBody);
    expect(fixture.files.has(fixture.session.mdPath)).toBe(true);
    expect(fixture.session).toMatchObject({ finalized: true, finalizationError: "", finalizePromise: null });
  });

  it("keeps the in-memory continuation update when persistence fails and preserves staged materials", async () => {
    const fixture = await makeContinuationDiscardFixture();
    const segments = [{ index: 4, startOffsetMs: 12000, endOffsetMs: 16000, text: "continued transcript" }];
    Object.assign(fixture.session, { shortRecordingTier: undefined, shortRecordingDurationMs: undefined, segments });
    fixture.finalizeService._finalizeSessionImpl = async () => undefined;
    const taskId = (fixture.session as never).continuationTaskId;
    const savedBefore = JSON.parse(fixture.persistedQueue());
    fixture.failNextSave("handoff save failed");

    await fixture.finalizeService.finalizeSession(fixture.session as never);

    expect(fixture.queue.tasks.find((candidate) => candidate.id === taskId)).toMatchObject({ status: "pending", segments });
    expect(JSON.parse(fixture.persistedQueue())).toEqual(savedBefore);
    expect(fixture.files.get(fixture.targetPath)?.content).toBe(fixture.oldBody);
    expect(fixture.files.has(fixture.session.mdPath)).toBe(true);
    expect(fixture.continuations.isSessionTracked(fixture.session.id)).toBe(false);
    expect(fixture.session.finalizePromise).toBeNull();
  });
});

describe("session note block cleanup consumers", () => {
  const mdPath = "QnALog/转写纪要/session-cleanup.md";
  const completeBlock = "## Disposable\n<!-- qnalog-session:session-1 -->\n<!-- qnalog-segments-start:session-1 -->\n<!-- qnalog-segments-end:session-1 -->";
  const fullInput = `KEEP-A\n\n${completeBlock}\n\nKEEP-B\n`;
  const expected = "KEEP-A\n\nKEEP-B\n";

  it("NoteWriter removes only its session range and leaves a repeated cleanup unchanged", async () => {
    const { host, files } = makeHost();
    const writer = new NoteWriter(makeNoteWriterHost(host));
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
    const writer = new NoteWriter(makeNoteWriterHost(host));
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
    const writer = new NoteWriter(makeNoteWriterHost(writerHost.host));
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
    const writer = new NoteWriter(makeNoteWriterHost(host));
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
    const writer = new NoteWriter(makeNoteWriterHost(host));
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
