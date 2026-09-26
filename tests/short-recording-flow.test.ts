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
import { SessionFinalizeService } from "../src/notes/session-finalize-service";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";

/** 只实现短录音路径真正会碰到的部分；其余能力一旦被调用即抛出，避免测试掩盖真实依赖。 */
function makeHost() {
  const files = new Map<string, { content?: string; binary?: ArrayBuffer }>();
  const folders = new Set<string>();
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => {
        const p = String(path || "");
        if (files.has(p)) return new (obsidian.TFile as never)(p);
        if (folders.has(p)) return new (obsidian.TFolder as never)(p);
        return null;
      },
      read: async (file: { path: string }) => String(files.get(file.path)?.content ?? ""),
      create: async (path: string, content: string) => {
        files.set(path, { content: String(content) });
        return new (obsidian.TFile as never)(path);
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

  const sessionFinalize = { finalizeSession: async () => undefined, processSegment: async () => undefined, confirmSpeakerNamesBeforeFinal: async () => ({ segments: [], frontmatter: null }) };

  const host: Record<string, unknown> = {
    app,
    session: null,
    settings: { ...DEFAULT_SETTINGS, audioFolder: "QnALog/录音", mdFolder: "QnALog/转写纪要", segmentCacheFolder: "QnALog/.cache/segments" },
    bubble: null,
    recorder: { state: "idle", _voicedTicks: 0, _silentTicks: 0, getInfo: () => ({ elapsed: 0, issue: null }) },
    meetingWorkbench: { removeLiveTranscriptBlock: async () => undefined, processPendingMeetingWorkbenchInteractions: async () => undefined, scheduleMeetingWorkbenchInteraction: () => undefined },
    noteWriter: {
      appendToNote: async (path: string, content: string) => {
        const cur = String(files.get(path)?.content ?? "");
        files.set(path, { content: cur + content });
      },
      insertBeforeSegmentsEnd: async () => undefined,
      removeEmptySessionBlock: async () => undefined,
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
    queueRetry: { readVaultAudioBlob: async () => null, scheduleDeferredAsrRetry: () => undefined, scheduleTaskQueueRetry: () => undefined },
    diagnostics: { logDiagnostic: async (_level: string, event: string, message: string, data: unknown) => { diagnostics.push({ event, message, data }); } },
    tasks: { beginTaskMeter: () => null, endTaskMeter: () => null, logCompletedWork: () => undefined, _importBusy: null, updateImportActivity: () => undefined },
    requestOutlineRefresh: () => undefined,
    requestOpenOutlineView: async () => undefined,
    outline: { scheduleRealtimeOutline: () => undefined, ensureRealtimeOutlineForFinalNote: async () => undefined },
    noteIndex: { refreshNoteIndexSafely: async () => undefined, appendDailyMeetingOverview: async () => undefined, autoExtractSedimentAfterFinalize: () => undefined },
    saveSettings: async () => undefined,
    recording: null as unknown,
  };

  const finalizeService = new SessionFinalizeService(host);
  host.sessionFinalize = finalizeService;
  const recordingService = new RecordingService(host);
  host.recording = recordingService;
  finalizeService.host.recording = recordingService;

  return { host, files, folders, app, transcriptionCalls, diagnostics, finalizeService, recordingService };
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
    const { host, files, transcriptionCalls, recordingService } = makeHost();
    const mdPath = "QnALog/转写纪要/2026-09-18 1200.md";
    files.set(mdPath, { content: sessionHeader("2026-09-18 12:00") });
    const session = makeSession(mdPath);
    (host as Record<string, unknown>).session = session;

    await recordingService.handleSegment(session as never, finalPayload(4000) as never);
    await (session as unknown as { writeQueue: Promise<void> }).writeQueue;
    await host.sessionFinalize.finalizeSession(session as never);

    const audioFiles = [...files.keys()].filter((p) => p.startsWith("QnALog/录音/"));
    expect(audioFiles).toHaveLength(1);
    expect(audioFiles[0]).toContain("qnalog-20260918-120000");
    expect(trashed).toContain(mdPath);
    expect(transcriptionCalls).toEqual([]);
    expect(host.session).toBeNull();
    expect(notices.join("\n")).toContain("audio kept in the recording folder");
  });

  it("2 秒录音：不写音频文件，纪要文件被清除", async () => {
    notices.length = 0;
    trashed.length = 0;
    const { host, files, recordingService } = makeHost();
    const mdPath = "QnALog/转写纪要/2026-09-18 1201.md";
    files.set(mdPath, { content: sessionHeader("2026-09-18 12:01") });
    const session = makeSession(mdPath);
    (host as Record<string, unknown>).session = session;

    await recordingService.handleSegment(session as never, finalPayload(2000) as never);
    await (session as unknown as { writeQueue: Promise<void> }).writeQueue;
    await host.sessionFinalize.finalizeSession(session as never);

    expect([...files.keys()].filter((p) => p.startsWith("QnALog/录音/"))).toEqual([]);
    expect(trashed).toContain(mdPath);
    expect(notices.join("\n")).toContain("Filtered out recordings shorter than three seconds");
  });

  it("12 秒录音仍走正常流程：切片进缓存并登记转写任务，纪要保留", async () => {
    notices.length = 0;
    trashed.length = 0;
    const { host, files, transcriptionCalls, recordingService } = makeHost();
    const mdPath = "QnALog/转写纪要/2026-09-18 1202.md";
    files.set(mdPath, { content: sessionHeader("2026-09-18 12:02") });
    const session = makeSession(mdPath);
    (host as Record<string, unknown>).session = session;

    await recordingService.handleSegment(session as never, finalPayload(12_000) as never);

    // 切片写入分段缓存目录并登记队列任务，是「正常整理」与「只留音频」两条路径的分界。
    const cacheFiles = [...files.keys()].filter((p) => p.startsWith("QnALog/.cache/segments/"));
    expect(cacheFiles).toHaveLength(1);
    expect(cacheFiles[0]).toContain("seg01");
    expect(transcriptionCalls).toContain("queue");
    expect(trashed).toEqual([]);
    expect(files.get(mdPath)?.content).toContain("qnalog-segments-start:session-1");
  });
});
