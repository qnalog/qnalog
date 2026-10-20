const masterNoticeMessages = vi.hoisted(() => [] as string[]);

vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || ""),
  Notice: class {
    messageEl = { createEl: () => ({ addEventListener: () => undefined }) };
    constructor(public message: string) { masterNoticeMessages.push(message); }
  },
  TFile: class {},
  TFolder: class {},
  Platform: { isMobile: false, isMobileApp: false },
}));

import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { MasterPartialService, type MasterPartialHost, type MasterPartialNotice } from "../src/audio/master-partial-service";
import { parseMasterPartialMeta, type MasterPartialSessionInit } from "../src/audio/master-partial";
import { RecordingService } from "../src/audio/recording-service";
import type { MasterFlushPayload } from "../src/audio/recorder-service";
import { LiveAsrPipelineService } from "../src/asr/live-asr-pipeline-service";
import { MemoryAdapter } from "./helpers/memory-partial-adapter";

const AUDIO_FOLDER = "QnALog/录音";
const MIME = "audio/webm;codecs=opus";
const STARTED_AT = new Date(2026, 9, 6, 12, 0, 0).getTime();

function init(sessionId: string): MasterPartialSessionInit {
  return { sessionId, audioFolder: AUDIO_FOLDER, notePath: "QnALog/notes/a.md", startedAt: STARTED_AT, sourceMode: "mic", mode: "meeting" };
}

function makeHost(io: MemoryAdapter) {
  const notices: Array<{ message: string; timeoutMs: number; buttons: Array<{ label: string; click: () => void }> }> = [];
  const logs: Array<{ level: string; code: string }> = [];
  const importAudioFiles = vi.fn(async (_paths: string[]) => undefined);
  const host: MasterPartialHost = {
    adapter: io,
    getAudioFolder: () => AUDIO_FOLDER,
    logDiagnostic: vi.fn(async (level: string, code: string) => { logs.push({ level, code }); }),
    importAudioFiles,
    showNotice: (message: string, timeoutMs: number): MasterPartialNotice => {
      const record = { message, timeoutMs, buttons: [] as Array<{ label: string; click: () => void }> };
      notices.push(record);
      return { addButton: (label, click) => { record.buttons.push({ label, click }); } };
    },
  };
  return { host, notices, logs, importAudioFiles };
}

function dirOf(sessionId: string): string {
  return `${AUDIO_FOLDER}/.partial/${sessionId}`;
}

describe("MasterPartialService discard after a saved master audio", () => {
  it("removes the folder after the in-flight write finishes, and rejects writes that arrive later", async () => {
    const io = new MemoryAdapter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    io.hooks.writeBinary = async () => { entered(); await gate; };
    const { host } = makeHost(io);
    const service = new MasterPartialService(host);
    const session = service.createSession(init("s-discard"));
    const inFlight = session.append(new Blob(["0123"], { type: MIME }), MIME);
    await started;

    let discarded = false;
    const savedPath = `${AUDIO_FOLDER}/qnalog-x.webm`;
    io.files.set(savedPath, "0123");
    const discard = service.discard("s-discard", savedPath, 4).then(() => { discarded = true; });
    await Promise.resolve();
    expect(discarded).toBe(false);
    release();
    await discard;
    expect(await inFlight).toMatchObject({ ok: true, partCount: 1 });
    expect(io.dirs.has(dirOf("s-discard"))).toBe(false);
    expect([...io.files.keys()].filter((key) => key.startsWith(dirOf("s-discard")))).toEqual([]);

    // 场次结束后迟到的写入不会重新创建目录。
    const late = await session.append(new Blob(["late"], { type: MIME }), MIME);
    expect(late).toMatchObject({ ok: false, reason: "closed" });
    expect(io.dirs.has(dirOf("s-discard"))).toBe(false);
  });

  it("removes the empty partial root after the last session is discarded, and keeps it while another session remains", async () => {
    const io = new MemoryAdapter();
    const { host } = makeHost(io);
    const service = new MasterPartialService(host);
    const first = service.createSession(init("s-first"));
    const second = service.createSession(init("s-second"));
    await first.append(new Blob(["1"], { type: MIME }), MIME);
    await second.append(new Blob(["2"], { type: MIME }), MIME);
    io.files.set(`${AUDIO_FOLDER}/qnalog-1.webm`, "1");
    io.files.set(`${AUDIO_FOLDER}/qnalog-2.webm`, "2");
    const root = `${AUDIO_FOLDER}/.partial`;

    await service.discard("s-first", `${AUDIO_FOLDER}/qnalog-1.webm`, 1);
    expect(io.dirs.has(root)).toBe(true);
    await service.discard("s-second", `${AUDIO_FOLDER}/qnalog-2.webm`, 1);
    expect(io.dirs.has(root)).toBe(false);
    expect([...io.dirs, ...io.files.keys()].some((key) => key.includes(".partial"))).toBe(false);
  });

  it("logs a warning and still succeeds when only the empty root cannot be removed", async () => {
    const io = new MemoryAdapter();
    const { host, logs } = makeHost(io);
    const service = new MasterPartialService(host);
    const session = service.createSession(init("s-root"));
    await session.append(new Blob(["r"], { type: MIME }), MIME);
    io.files.set(`${AUDIO_FOLDER}/qnalog-root.webm`, "r");
    io.hooks.rmdir = (path) => { if (path === `${AUDIO_FOLDER}/.partial`) throw new Error("root busy"); };

    await expect(service.discard("s-root", `${AUDIO_FOLDER}/qnalog-root.webm`, 1)).resolves.toBeUndefined();
    expect(io.dirs.has(dirOf("s-root"))).toBe(false);
    expect(io.dirs.has(`${AUDIO_FOLDER}/.partial`)).toBe(true);
    expect(logs.map((entry) => entry.code)).toEqual(["recording.partial_root_kept"]);
  });

  it("marks the folder as saved when removal fails, so a later start does not recover the same audio", async () => {
    const io = new MemoryAdapter();
    const { host, logs } = makeHost(io);
    const service = new MasterPartialService(host);
    const session = service.createSession(init("s-stuck"));
    await session.append(new Blob(["aa"], { type: MIME }), MIME);
    io.files.set(`${AUDIO_FOLDER}/qnalog-stuck.webm`, "full");
    io.hooks.rmdir = () => { throw new Error("locked"); };

    await expect(service.discard("s-stuck", `${AUDIO_FOLDER}/qnalog-stuck.webm`, 4)).resolves.toBeUndefined();
    expect(logs.map((entry) => entry.code)).toContain("recording.partial_cleanup_failed");
    const meta = parseMasterPartialMeta(io.text(`${dirOf("s-stuck")}/meta.json`));
    expect(meta.savedAs).toBe(`${AUDIO_FOLDER}/qnalog-stuck.webm`);
    expect(meta.savedBytes).toBe(4);

    io.hooks.rmdir = undefined;
    const { host: nextHost, notices, importAudioFiles } = makeHost(io);
    const next = new MasterPartialService(nextHost);
    const outcomes = await next.recoverInterrupted();
    expect(outcomes).toEqual([{ sessionId: "s-stuck", status: "already-handled", reason: "saved" }]);
    expect(notices).toEqual([]);
    expect(importAudioFiles).not.toHaveBeenCalled();
    expect(io.dirs.has(dirOf("s-stuck"))).toBe(false);
  });

  it("keeps partials and reports when the saved target is truncated", async () => {
    const io = new MemoryAdapter();
    const { host, logs, notices } = makeHost(io);
    const service = new MasterPartialService(host);
    const session = service.createSession(init("s-short-target"));
    await session.append(new Blob(["abc"], { type: MIME }), MIME);
    const savedPath = `${AUDIO_FOLDER}/qnalog-short-target.webm`;
    io.files.set(savedPath, "abcd");

    await expect(service.discard("s-short-target", savedPath, 5)).rejects.toThrow();
    expect(io.files.has(`${dirOf("s-short-target")}/part-0001.webm`)).toBe(true);
    expect(parseMasterPartialMeta(io.text(`${dirOf("s-short-target")}/meta.json`))).toMatchObject({ savedAs: savedPath, savedBytes: 5 });
    expect(logs.map((entry) => entry.code)).toContain("recording.partial_target_invalid");
    expect(notices.map((notice) => notice.message)).toContain("The saved recording could not be verified; its partial audio was kept");
  });

  it("references a byte-verified master when partial cleanup alone fails", async () => {
    const io = new MemoryAdapter();
    const { host, logs } = makeHost(io);
    const partials = new MasterPartialService(host);
    const sessionId = "s-pipeline-cleanup";
    const partial = partials.createSession(init(sessionId));
    await partial.append(new Blob(["part"], { type: MIME }), MIME);
    io.hooks.rmdir = (path) => { if (path === dirOf(sessionId)) throw new Error("locked"); };
    const pipeline = new LiveAsrPipelineService({
      getSettings: () => ({ audioFolder: AUDIO_FOLDER }) as never,
      vault: {
        adapter: { readBinary: (path: string) => io.readBinary(path) },
        getAbstractFileByPath: () => null,
        createFolder: async () => undefined,
        createBinary: async (path: string, data: ArrayBuffer) => { io.files.set(path, data.slice(0)); return {} as never; },
      } as never,
      discardMasterPartials: (id: string, path: string, bytes: number) => partials.discard(id, path, bytes),
    } as never);
    const pipelineSession = {
      id: sessionId,
      sessionStamp: "20261006-120000",
      segments: [{ audioName: "segment.webm", audioPath: "segment.webm" }],
    };

    await pipeline.saveMasterAudio(pipelineSession as never, { masterBlob: new Blob(["complete"], { type: MIME }), masterMime: MIME, masterExt: "webm" } as never);

    const savedPath = `${AUDIO_FOLDER}/qnalog-20261006-120000.webm`;
    expect(pipelineSession.masterAudioPath).toBe(savedPath);
    expect(pipelineSession.segments[0]!.audioPath).toBe(savedPath);
    expect(io.dirs.has(dirOf(sessionId))).toBe(true);
    expect(parseMasterPartialMeta(io.text(`${dirOf(sessionId)}/meta.json`))).toMatchObject({ savedAs: savedPath, savedBytes: 8 });
    expect(logs.map((entry) => entry.code)).toContain("recording.partial_cleanup_failed");
  });
});

describe("MasterPartialService startup recovery notices", () => {
  it("shows one persistent notice per recovered recording, and its button imports only that file", async () => {
    const io = new MemoryAdapter();
    io.dirs.add(`${AUDIO_FOLDER}/.partial`);
    io.dirs.add(dirOf("s-crash"));
    io.files.set(`${dirOf("s-crash")}/meta.json`, JSON.stringify({
      version: 1, sessionId: "s-crash", notePath: "QnALog/notes/a.md", startedAt: STARTED_AT, mime: MIME, ext: "webm",
      partCount: 1, flushedBytes: 3, lastFlushAt: STARTED_AT, sourceMode: "mic", mode: "meeting",
    }));
    io.files.set(`${dirOf("s-crash")}/part-0001.webm`, new TextEncoder().encode("abc").buffer as ArrayBuffer);

    const { host, notices, importAudioFiles } = makeHost(io);
    const service = new MasterPartialService(host);
    await service.recoverInterrupted();

    const recovered = `${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`;
    expect(notices).toHaveLength(1);
    expect(notices[0]!.timeoutMs).toBe(0);
    expect(notices[0]!.message).toContain("qnalog-20261006-120000-recovered.webm");
    expect(notices[0]!.buttons.map((button) => button.label)).toEqual(["Import and transcribe"]);
    expect(importAudioFiles).not.toHaveBeenCalled();

    expect(io.dirs.has(`${AUDIO_FOLDER}/.partial`)).toBe(false);
    notices[0]!.buttons[0]!.click();
    expect(importAudioFiles).toHaveBeenCalledTimes(1);
    expect(importAudioFiles).toHaveBeenCalledWith([recovered]);

    // 第二次启动：目录已删除，不再通知。
    const again = makeHost(io);
    await new MasterPartialService(again.host).recoverInterrupted();
    expect(again.notices).toEqual([]);
  });

  it("shows a persistent notice when a folder cannot be recovered and keeps it", async () => {
    const io = new MemoryAdapter();
    io.dirs.add(`${AUDIO_FOLDER}/.partial`);
    io.dirs.add(dirOf("s-broken"));
    io.files.set(`${dirOf("s-broken")}/meta.json`, "{broken");
    const { host, notices, logs } = makeHost(io);
    await new MasterPartialService(host).recoverInterrupted();
    expect(notices).toEqual([expect.objectContaining({ timeoutMs: 0 })]);
    expect(logs).toEqual([expect.objectContaining({ level: "error", code: "recording.recovery_failed" })]);
    expect(io.dirs.has(dirOf("s-broken"))).toBe(true);
  });

  it("does not recover the session that is still registered as active", async () => {
    const io = new MemoryAdapter();
    const { host, notices } = makeHost(io);
    const service = new MasterPartialService(host);
    const session = service.createSession(init("s-live"));
    await session.append(new Blob(["live"], { type: MIME }), MIME);
    const outcomes = await service.recoverInterrupted();
    expect(outcomes).toEqual([{ sessionId: "s-live", status: "active" }]);
    expect(notices).toEqual([]);
    expect(io.files.has(`${dirOf("s-live")}/part-0001.webm`)).toBe(true);
  });
});

describe("RecordingService master flush result handling", () => {
  function makeRecordingService() {
    const issues: Array<{ kind: string; patch: { reason?: string } }> = [];
    const cleared: string[] = [];
    const logs: Array<{ level: string; code: string }> = [];
    const service = new RecordingService({
      asrPipeline: {
        setRecordingIssue: (kind: string, patch: { reason?: string }) => { issues.push({ kind, patch }); },
        clearRecordingIssue: (kind?: string) => { if (kind) cleared.push(kind); },
      },
      diagnostics: { logDiagnostic: async (level: string, code: string) => { logs.push({ level, code }); } },
    } as never);
    return { service, issues, cleared, logs };
  }
  const payload: MasterFlushPayload = { blob: new Blob(["x"], { type: MIME }), mime: MIME, chunkCount: 1, elapsedMs: 20_000 };

  it("maps a failed partial write to a recording issue, and clears it after the next success", async () => {
    const { service, issues, cleared, logs } = makeRecordingService();
    const append = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "write-failed", error: new Error("disk full") })
      .mockResolvedValueOnce({ ok: true, partCount: 1, bytes: 1, writeMs: 3 });
    const partial = { append } as never;

    expect(await service.flushMasterPartial("s-flush", partial, payload)).toBe(false);
    expect(issues).toEqual([expect.objectContaining({ kind: "service", patch: expect.objectContaining({ reason: "partial-save-failed" }) })]);
    expect(logs).toContainEqual({ level: "error", code: "recording.partial_flush_failed" });

    expect(await service.flushMasterPartial("s-flush", partial, payload)).toBe(true);
    expect(cleared).toEqual(["service"]);
    expect(issues).toHaveLength(1);
  });

  it("treats a write to a closed session as not an error", async () => {
    const { service, issues } = makeRecordingService();
    const partial = { append: vi.fn().mockResolvedValue({ ok: false, reason: "closed", error: null }) } as never;
    expect(await service.flushMasterPartial("s-closed", partial, payload)).toBe(false);
    expect(issues).toEqual([]);
  });
});

describe("LiveAsrPipelineService master audio save", () => {
  function makePipeline(createBinary: (path: string, data: ArrayBuffer, files: Map<string, ArrayBuffer>) => Promise<unknown>, discardAction: (sessionId: string, savedPath: string, savedBytes: number) => Promise<void> = async () => undefined) {
    const discards: Array<[string, string, number]> = [];
    masterNoticeMessages.length = 0;
    const files = new Map<string, ArrayBuffer>();
    const pipeline = new LiveAsrPipelineService({
      getSettings: () => ({ audioFolder: AUDIO_FOLDER }) as never,
      vault: {
        adapter: {
          readBinary: async (path: string) => {
            const data = files.get(path);
            if (!data) throw new Error(`missing ${path}`);
            return data.slice(0);
          },
        },
        getAbstractFileByPath: () => null,
        createFolder: async () => undefined,
        createBinary: (path: string, data: ArrayBuffer) => createBinary(path, data, files),
      } as never,
      discardMasterPartials: async (sessionId: string, savedPath: string, savedBytes: number) => {
        discards.push([sessionId, savedPath, savedBytes]);
        await discardAction(sessionId, savedPath, savedBytes);
      },
    } as never);
    return { pipeline, discards, notices: masterNoticeMessages, files };
  }
  const makeSession = (segments: Array<{ audioName?: string; audioPath?: string }> = []) => ({ id: "s-save", sessionStamp: "20261006-120000", segments });
  const seg = { masterBlob: new Blob(["full"], { type: MIME }), masterMime: MIME, masterExt: "webm" } as never;

  async function makeIntegratedSaveFlow(options: { writeMode?: "exact" | "same-size-corrupt" | "truncate"; readFails?: boolean; flushedPart?: boolean } = {}) {
    masterNoticeMessages.length = 0;
    const io = new MemoryAdapter();
    const partialHost = makeHost(io);
    const partials = new MasterPartialService(partialHost.host);
    const sessionId = "s-integrated-save";
    const partialSession = partials.createSession(init(sessionId));
    if (options.flushedPart) await partialSession.append(new Blob([new Uint8Array([1, 2, 3])], { type: MIME }), MIME);
    const masterPath = `${AUDIO_FOLDER}/qnalog-20261006-120000.webm`;
    const cachePath = "QnALog/.cache/segments/segment.webm";
    io.files.set(cachePath, new Uint8Array([9, 8, 7]).buffer);
    const expected = new Uint8Array([1, 2, 3, 4]);
    const pipeline = new LiveAsrPipelineService({
      getSettings: () => ({ audioFolder: AUDIO_FOLDER, keepSegmentAudioFiles: false, consolidatedLayout: true }) as never,
      vault: {
        adapter: {
          exists: (path: string) => io.exists(path),
          readBinary: async (path: string) => {
            if (options.readFails && path === masterPath) throw new Error("readback unavailable");
            return io.readBinary(path);
          },
          stat: (path: string) => io.stat(path),
          remove: (path: string) => io.remove(path),
        },
        getAbstractFileByPath: () => null,
        createFolder: async () => undefined,
        createBinary: async (path: string, data: ArrayBuffer) => {
          let bytes = new Uint8Array(data.slice(0));
          if (options.writeMode === "same-size-corrupt") bytes[bytes.length - 1] = 99;
          if (options.writeMode === "truncate") bytes = bytes.slice(0, bytes.length - 1);
          io.files.set(path, bytes.buffer);
          return Object.assign(new TFile(), { path });
        },
      },
      fileManager: { trashFile: async () => undefined },
      diagnostics: { logDiagnostic: async () => undefined },
      queueTasks: () => [],
      queueRecoveryEntries: () => [],
      addQueueTask: async () => ({ id: "task" }),
      updateQueueTask: async () => undefined,
      removeQueueTask: async () => undefined,
      removeLiveTranscriptBlock: async () => undefined,
      discardMasterPartials: (id: string, path: string, bytes: number) => partials.discard(id, path, bytes),
      getRecorderBufferSummary: () => ({ masterChunkCount: 1, masterChunkBytes: expected.byteLength, currentSegmentChunkCount: 1, currentSegmentChunkBytes: expected.byteLength }),
      syncImportBusyFromSessionProgress: () => undefined,
      requestOutlineRefresh: () => undefined,
      requestBubbleUpdate: () => undefined,
    } as never);
    const session = {
      id: sessionId,
      sessionStamp: "20261006-120000",
      segments: [{ segmentAudioPath: cachePath, audioPath: cachePath, audioName: "segment.webm" }],
    };
    return { io, partials, pipeline, session, sessionId, masterPath, cachePath, expected };
  }

  it("discards the partial files only after the full master audio is written", async () => {
    const createBinary = vi.fn(async (path: string, data: ArrayBuffer, files: Map<string, ArrayBuffer>) => {
      files.set(path, data.slice(0));
      return {};
    });
    const { pipeline, discards } = makePipeline(createBinary);
    await pipeline.saveMasterAudio(makeSession() as never, seg);
    expect(createBinary).toHaveBeenCalledTimes(1);
    expect(discards).toEqual([["s-save", `${AUDIO_FOLDER}/qnalog-20261006-120000.webm`, 4]]);
  });

  it("keeps the partial files when the full master audio cannot be written", async () => {
    const createBinary = vi.fn(async (_path: string, _data: ArrayBuffer, _files: Map<string, ArrayBuffer>) => { throw new Error("vault locked"); });
    const { pipeline, discards } = makePipeline(createBinary);
    await pipeline.saveMasterAudio(makeSession() as never, seg);
    expect(discards).toEqual([]);
  });

  it("does not reference a master target when partial verification fails", async () => {
    const createBinary = vi.fn(async (path: string, data: ArrayBuffer, files: Map<string, ArrayBuffer>) => {
      files.set(path, data.slice(0));
      return {};
    });
    const { pipeline } = makePipeline(createBinary, async () => { throw new Error("target size mismatch"); });
    const session = makeSession([{ audioName: "segment.webm", audioPath: "segment.webm" }]);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await pipeline.saveMasterAudio(session as never, seg);
    } finally {
      errorLog.mockRestore();
    }
    expect(session).not.toHaveProperty("masterAudioPath");
    expect(session).not.toHaveProperty("masterAudioName");
    expect(session.segments[0]).toEqual({ audioName: "segment.webm", audioPath: "segment.webm" });
  });

  it.each([
    ["keeps segment audio when same-size master content differs without partials", { writeMode: "same-size-corrupt" as const }],
    ["keeps segment audio when master readback fails without partials", { readFails: true }],
  ])("%s", async (_label, options) => {
    const fixture = await makeIntegratedSaveFlow(options);

    await fixture.pipeline.saveMasterAudio(fixture.session as never, {
      masterBlob: new Blob([fixture.expected], { type: MIME }), masterMime: MIME, masterExt: "webm",
    } as never);
    await fixture.pipeline.cleanupSuccessfulSegmentAudio(fixture.session as never);

    expect(fixture.session).not.toHaveProperty("masterAudioPath");
    expect([...new Uint8Array(await fixture.io.readBinary(fixture.cachePath))]).toEqual([9, 8, 7]);
    expect(fixture.session.segments[0]).toEqual({ segmentAudioPath: fixture.cachePath, audioPath: fixture.cachePath, audioName: "segment.webm" });
    expect(fixture.io.dirs.has(dirOf(fixture.sessionId))).toBe(false);
    expect(masterNoticeMessages).toContain("The full recording could not be verified. Check the recording segments before closing Obsidian.");
  });

  it("keeps persisted partial bytes and segment audio when master content differs", async () => {
    const fixture = await makeIntegratedSaveFlow({ writeMode: "same-size-corrupt", flushedPart: true });

    await fixture.pipeline.saveMasterAudio(fixture.session as never, {
      masterBlob: new Blob([fixture.expected], { type: MIME }), masterMime: MIME, masterExt: "webm",
    } as never);
    await fixture.pipeline.cleanupSuccessfulSegmentAudio(fixture.session as never);

    expect(fixture.session).not.toHaveProperty("masterAudioPath");
    expect([...new Uint8Array(await fixture.io.readBinary(fixture.cachePath))]).toEqual([9, 8, 7]);
    expect([...new Uint8Array(await fixture.io.readBinary(`${dirOf(fixture.sessionId)}/part-0001.webm`))]).toEqual([1, 2, 3]);
    expect(fixture.io.files.has(`${dirOf(fixture.sessionId)}/meta.json`)).toBe(true);
    expect(fixture.io.dirs.has(dirOf(fixture.sessionId))).toBe(true);
    expect(fixture.session.segments[0]).toEqual({ segmentAudioPath: fixture.cachePath, audioPath: fixture.cachePath, audioName: "segment.webm" });
    expect(masterNoticeMessages).toContain("The full recording could not be verified. Check the recording segments before closing Obsidian.");
  });

  it("cleans partials and segment audio after byte-identical master readback", async () => {
    const fixture = await makeIntegratedSaveFlow({ flushedPart: true });

    await fixture.pipeline.saveMasterAudio(fixture.session as never, {
      masterBlob: new Blob([fixture.expected], { type: MIME }), masterMime: MIME, masterExt: "webm",
    } as never);
    await fixture.pipeline.cleanupSuccessfulSegmentAudio(fixture.session as never);

    expect(fixture.session.masterAudioPath).toBe(fixture.masterPath);
    expect([...new Uint8Array(await fixture.io.readBinary(fixture.masterPath))]).toEqual([...fixture.expected]);
    expect(fixture.session.segments[0]).toEqual({ segmentAudioPath: fixture.cachePath, audioPath: fixture.masterPath, audioName: "qnalog-20261006-120000.webm" });
    expect(fixture.io.files.has(fixture.cachePath)).toBe(false);
    expect(fixture.io.files.has(`${dirOf(fixture.sessionId)}/part-0001.webm`)).toBe(false);
    expect(fixture.io.dirs.has(dirOf(fixture.sessionId))).toBe(false);
  });

  it("keeps segment audio and persisted partials when the master is truncated", async () => {
    const fixture = await makeIntegratedSaveFlow({ writeMode: "truncate", flushedPart: true });

    await fixture.pipeline.saveMasterAudio(fixture.session as never, {
      masterBlob: new Blob([fixture.expected], { type: MIME }), masterMime: MIME, masterExt: "webm",
    } as never);
    await fixture.pipeline.cleanupSuccessfulSegmentAudio(fixture.session as never);

    expect(fixture.session).not.toHaveProperty("masterAudioPath");
    expect([...new Uint8Array(await fixture.io.readBinary(fixture.cachePath))]).toEqual([9, 8, 7]);
    expect([...new Uint8Array(await fixture.io.readBinary(`${dirOf(fixture.sessionId)}/part-0001.webm`))]).toEqual([1, 2, 3]);
    expect(fixture.io.files.has(`${dirOf(fixture.sessionId)}/meta.json`)).toBe(true);
  });
});
