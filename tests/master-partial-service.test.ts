vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || ""),
  Notice: class {
    messageEl = { createEl: () => ({ addEventListener: () => undefined }) };
    constructor(public message: string) {}
  },
  TFile: class {},
  TFolder: class {},
  Platform: { isMobile: false, isMobileApp: false },
}));

import { describe, expect, it, vi } from "vitest";
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
    const discard = service.discard("s-discard", `${AUDIO_FOLDER}/qnalog-x.webm`).then(() => { discarded = true; });
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

  it("marks the folder as saved when removal fails, so a later start does not recover the same audio", async () => {
    const io = new MemoryAdapter();
    const { host, logs } = makeHost(io);
    const service = new MasterPartialService(host);
    const session = service.createSession(init("s-stuck"));
    await session.append(new Blob(["aa"], { type: MIME }), MIME);
    io.hooks.rmdir = () => { throw new Error("locked"); };

    await expect(service.discard("s-stuck", `${AUDIO_FOLDER}/qnalog-stuck.webm`)).resolves.toBeUndefined();
    expect(logs.map((entry) => entry.code)).toContain("recording.partial_cleanup_failed");
    const meta = parseMasterPartialMeta(io.text(`${dirOf("s-stuck")}/meta.json`));
    expect(meta.savedAs).toBe(`${AUDIO_FOLDER}/qnalog-stuck.webm`);

    io.hooks.rmdir = undefined;
    const { host: nextHost, notices, importAudioFiles } = makeHost(io);
    const next = new MasterPartialService(nextHost);
    const outcomes = await next.recoverInterrupted();
    expect(outcomes).toEqual([{ sessionId: "s-stuck", status: "already-handled", reason: "saved" }]);
    expect(notices).toEqual([]);
    expect(importAudioFiles).not.toHaveBeenCalled();
    expect(io.dirs.has(dirOf("s-stuck"))).toBe(false);
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
  function makePipeline(createBinary: () => Promise<unknown>) {
    const discards: Array<[string, string]> = [];
    const notices: string[] = [];
    const pipeline = new LiveAsrPipelineService({
      getSettings: () => ({ audioFolder: AUDIO_FOLDER }) as never,
      vault: {
        getAbstractFileByPath: () => null,
        createFolder: async () => undefined,
        createBinary,
      } as never,
      discardMasterPartials: async (sessionId: string, savedPath: string) => { discards.push([sessionId, savedPath]); },
    } as never);
    return { pipeline, discards, notices };
  }
  const session = { id: "s-save", sessionStamp: "20261006-120000", segments: [] } as never;
  const seg = { masterBlob: new Blob(["full"], { type: MIME }), masterMime: MIME, masterExt: "webm" } as never;

  it("discards the partial files only after the full master audio is written", async () => {
    const createBinary = vi.fn(async () => ({}));
    const { pipeline, discards } = makePipeline(createBinary);
    await pipeline.saveMasterAudio(session, seg);
    expect(createBinary).toHaveBeenCalledTimes(1);
    expect(discards).toEqual([["s-save", `${AUDIO_FOLDER}/qnalog-20261006-120000.webm`]]);
  });

  it("keeps the partial files when the full master audio cannot be written", async () => {
    const createBinary = vi.fn(async () => { throw new Error("vault locked"); });
    const { pipeline, discards } = makePipeline(createBinary);
    await pipeline.saveMasterAudio(session, seg);
    expect(discards).toEqual([]);
  });
});
