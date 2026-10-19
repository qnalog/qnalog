vi.mock("obsidian", () => ({ normalizePath: (p: string) => String(p || ""), Notice: class {}, TFile: class {}, TFolder: class {} }));

import { describe, expect, it, vi } from "vitest";
import {
  MasterPartialSession,
  parseMasterPartialMeta,
  parsePartName,
  removePartialDirectory,
  type MasterPartialAdapter,
  type MasterPartialMeta,
} from "../src/audio/master-partial";
import { recoverInterruptedMasterPartials, formatRecoveryStamp } from "../src/audio/master-partial-recovery";
import { MemoryAdapter } from "./helpers/memory-partial-adapter";

const AUDIO_FOLDER = "QnALog/录音";
const ROOT = `${AUDIO_FOLDER}/.partial`;
const STARTED_AT = new Date(2026, 9, 6, 12, 0, 0).getTime();
const MIME = "audio/webm;codecs=opus";

function sessionDir(sessionId: string): string {
  return `${ROOT}/${sessionId}`;
}

function stagePath(sessionId: string, ext = "webm"): string {
  return `${sessionDir(sessionId)}/recovered.stage.${ext}`;
}

function metaFor(sessionId: string, partCount: number, overrides: Partial<MasterPartialMeta> = {}): MasterPartialMeta {
  return {
    version: 1,
    sessionId,
    notePath: "QnALog/notes/a.md",
    startedAt: STARTED_AT,
    mime: MIME,
    ext: "webm",
    partCount,
    flushedBytes: 0,
    lastFlushAt: STARTED_AT,
    sourceMode: "mic",
    mode: "meeting",
    ...overrides,
  };
}

/** 在适配器里放入一个分片目录：meta 与 part-0001... 文件，内容为各分片文本。 */
function seedSession(io: MemoryAdapter, sessionId: string, parts: string[], overrides: Partial<MasterPartialMeta> = {}, names?: string[]): void {
  const dir = sessionDir(sessionId);
  io.dirs.add(ROOT);
  io.dirs.add(dir);
  const flushedBytes = parts.reduce((sum, part) => sum + new TextEncoder().encode(part).byteLength, 0);
  io.files.set(`${dir}/meta.json`, JSON.stringify(metaFor(sessionId, parts.length, { flushedBytes, ...overrides })));
  parts.forEach((text, index) => {
    const name = names ? names[index]! : `part-${String(index + 1).padStart(4, "0")}.webm`;
    io.files.set(`${dir}/${name}`, new TextEncoder().encode(text).buffer as ArrayBuffer);
  });
}

function port(io: MemoryAdapter, extra: { isActiveSession?: (id: string) => boolean } = {}) {
  const logs: Array<{ level: string; code: string; data: unknown }> = [];
  return {
    logs,
    port: {
      adapter: io,
      audioFolder: AUDIO_FOLDER,
      isActiveSession: extra.isActiveSession ?? (() => false),
      logDiagnostic: vi.fn(async (level: string, code: string, _message: string, data: unknown) => { logs.push({ level, code, data }); }),
    },
  };
}

const LETTERS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];

describe("MasterPartialSession writes", () => {
  it("writes meta first, then numbered parts, and refreshes meta after every part", async () => {
    const io = new MemoryAdapter();
    const session = new MasterPartialSession(io, {
      sessionId: "s1", audioFolder: AUDIO_FOLDER, notePath: "QnALog/notes/a.md", startedAt: STARTED_AT, sourceMode: "mic", mode: "meeting",
    });
    const first = await session.append(new Blob(["aa"], { type: MIME }), MIME);
    const second = await session.append(new Blob(["bbb"], { type: MIME }), MIME);
    expect(first).toMatchObject({ ok: true, partCount: 1, bytes: 2 });
    expect(second).toMatchObject({ ok: true, partCount: 2, bytes: 5 });
    expect(io.text(`${sessionDir("s1")}/part-0001.webm`)).toBe("aa");
    expect(io.text(`${sessionDir("s1")}/part-0002.webm`)).toBe("bbb");
    const meta = parseMasterPartialMeta(io.text(`${sessionDir("s1")}/meta.json`));
    expect(meta).toMatchObject({ partCount: 2, flushedBytes: 5, ext: "webm", notePath: "QnALog/notes/a.md", startedAt: STARTED_AT, mode: "meeting" });
  });

  it("keeps the part count after a failed write, so the retry reuses the number and loses no chunk", async () => {
    const io = new MemoryAdapter();
    let failNext = true;
    io.hooks.writeBinary = () => {
      if (failNext) { failNext = false; throw new Error("disk full"); }
    };
    const session = new MasterPartialSession(io, {
      sessionId: "s2", audioFolder: AUDIO_FOLDER, notePath: "n.md", startedAt: STARTED_AT, sourceMode: "mic", mode: "meeting",
    });
    const failed = await session.append(new Blob(["aa"], { type: MIME }), MIME);
    expect(failed).toMatchObject({ ok: false, reason: "write-failed" });
    // 调用方会用同一批起点加上新分片重试。
    const retried = await session.append(new Blob(["aabb"], { type: MIME }), MIME);
    expect(retried).toMatchObject({ ok: true, partCount: 1, bytes: 4 });
    expect(io.text(`${sessionDir("s2")}/part-0001.webm`)).toBe("aabb");
    expect(io.files.has(`${sessionDir("s2")}/part-0002.webm`)).toBe(false);
  });

  it("writes nothing after close, and drain waits for a write already in flight", async () => {
    const io = new MemoryAdapter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    io.hooks.writeBinary = async () => { entered(); await gate; };
    const session = new MasterPartialSession(io, {
      sessionId: "s3", audioFolder: AUDIO_FOLDER, notePath: "n.md", startedAt: STARTED_AT, sourceMode: "mic", mode: "meeting",
    });
    const inFlight = session.append(new Blob(["xx"], { type: MIME }), MIME);
    await started;
    session.close();
    let drained = false;
    const drain = session.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await drain;
    expect(await inFlight).toMatchObject({ ok: true, partCount: 1 });
    const late = await session.append(new Blob(["yy"], { type: MIME }), MIME);
    expect(late).toMatchObject({ ok: false, reason: "closed" });
    expect(io.files.has(`${sessionDir("s3")}/part-0002.webm`)).toBe(false);
  });
});

describe("partial helpers", () => {
  it("parses only well-formed part names and rejects malformed meta", () => {
    expect(parsePartName("part-0007.webm")).toEqual({ index: 7, ext: "webm" });
    expect(parsePartName("meta.json")).toBeNull();
    expect(parsePartName("part-0.webm")).toBeNull();
    expect(() => parseMasterPartialMeta("{not json")).toThrow();
    expect(() => parseMasterPartialMeta(JSON.stringify({ version: 2 }))).toThrow();
  });

  it("rejects fractional and unsafe part counters", () => {
    const valid = metaFor("s-counter", 0);
    for (const [key, value] of [["partCount", 0.5], ["partCount", Number.MAX_SAFE_INTEGER + 1], ["flushedBytes", 0.5], ["flushedBytes", Number.MAX_SAFE_INTEGER + 1]] as const) {
      expect(() => parseMasterPartialMeta(JSON.stringify({ ...valid, [key]: value }))).toThrow();
    }
  });

  it("rejects invalid handled-target byte counts", () => {
    const valid = metaFor("s-target-size", 0);
    for (const [key, value] of [["savedBytes", -1], ["savedBytes", 1.5], ["savedBytes", Number.MAX_SAFE_INTEGER + 1], ["recoveredBytes", -1], ["recoveredBytes", 1.5], ["recoveredBytes", Number.MAX_SAFE_INTEGER + 1]] as const) {
      expect(() => parseMasterPartialMeta(JSON.stringify({ ...valid, [key]: value }))).toThrow();
    }
  });

  it("requires pending recovery target and byte count together", () => {
    const valid = metaFor("s-pending-pair", 0);
    expect(() => parseMasterPartialMeta(JSON.stringify({ ...valid, pendingRecoveryPath: "audio.webm" }))).toThrow();
    expect(() => parseMasterPartialMeta(JSON.stringify({ ...valid, pendingRecoveryBytes: 1 }))).toThrow();
  });

  it("removes only the given session folder", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "keep", ["k"]);
    seedSession(io, "drop", ["d"]);
    await removePartialDirectory(io, sessionDir("drop"));
    expect(io.dirs.has(sessionDir("drop"))).toBe(false);
    expect(io.files.has(`${sessionDir("drop")}/meta.json`)).toBe(false);
    expect(io.files.has(`${sessionDir("keep")}/part-0001.webm`)).toBe(true);
  });
});

describe("recoverInterruptedMasterPartials", () => {
  it("concatenates parts in numeric order into a -recovered file and removes the folder", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-ok", LETTERS);
    const { port: recoveryPort, logs } = port(io);
    const outcomes = await recoverInterruptedMasterPartials(recoveryPort);
    expect(outcomes).toEqual([
      expect.objectContaining({ sessionId: "s-ok", status: "recovered", bytes: 11, parts: 11, cleanupPending: false }),
    ]);
    const path = `${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`;
    expect(io.text(path)).toBe("abcdefghijk");
    expect(io.dirs.has(sessionDir("s-ok"))).toBe(false);
    expect(logs.map((entry) => entry.code)).toEqual(["recording.recovered"]);
  });

  it("publishes through a fixed stage and records a pending target before rename", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-publish", ["ab", "cd"]);
    const events: string[] = [];
    io.hooks.writeBinary = (path) => { events.push(`binary:${path}`); };
    io.hooks.write = (path, data) => {
      if (path.endsWith("meta.json")) {
        const meta = JSON.parse(data) as Record<string, unknown>;
        events.push(meta.pendingRecoveryPath ? "pending" : meta.recoveredPath ? "final" : "meta");
      }
    };
    io.hooks.read = (path) => {
      if (path.endsWith("meta.json") && io.text(path).includes("\"recoveredPath\"")) events.push("read-final");
    };
    io.hooks.rename = (from, to) => { events.push(`rename:${from}->${to}`); };
    io.hooks.rmdir = (path) => { if (path === sessionDir("s-publish")) events.push("rmdir"); };
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "recovered", bytes: 4 });
    expect(events).toContain(`binary:${stagePath("s-publish")}`);
    expect(events.indexOf("pending")).toBeLessThan(events.findIndex((event) => event.startsWith("rename:")));
    expect(events.indexOf("final")).toBeGreaterThan(events.findIndex((event) => event.startsWith("rename:")));
    expect(events.indexOf("read-final")).toBeGreaterThan(events.indexOf("final"));
    expect(events.indexOf("read-final")).toBeLessThan(events.indexOf("rmdir"));
    expect(io.files.has(`${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`)).toBe(true);
    expect(io.files.has(stagePath("s-publish"))).toBe(false);
  });

  it("keeps stage and parts when pending intent cannot be written", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-pending-write", ["audio"]);
    io.hooks.write = (path, data) => {
      if (path.endsWith("meta.json") && JSON.parse(data).pendingRecoveryPath) throw new Error("disk unavailable");
    };
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed" });
    expect(io.text(stagePath("s-pending-write"))).toBe("audio");
    expect(io.files.has(`${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`)).toBe(false);
    expect(io.files.has(`${sessionDir("s-pending-write")}/part-0001.webm`)).toBe(true);
    io.hooks.write = undefined;
    const retry = await recoverInterruptedMasterPartials(port(io).port);
    expect(retry[0]).toMatchObject({ status: "recovered" });
    expect([...io.files.keys()].filter((path) => path.includes("-recovered")).length).toBe(1);
  });

  it("accepts pending intent written before the adapter throws", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-pending-after-effect", ["audio"]);
    let throwAfterPending = true;
    io.hooks.write = (path, data) => {
      if (!path.endsWith("meta.json")) return;
      const record = JSON.parse(data) as Record<string, unknown>;
      if (record.pendingRecoveryPath && throwAfterPending) {
        throwAfterPending = false;
        io.files.set(path, data);
        throw new Error("write response lost");
      }
    };
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "recovered" });
    expect([...io.files.keys()].filter((path) => path.includes("-recovered")).length).toBe(1);
  });

  it("accepts a stage write that took effect before throwing", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-stage-after-effect", ["audio"]);
    let throwAfterStage = true;
    io.hooks.writeBinary = (path, data) => {
      if (path === stagePath("s-stage-after-effect") && throwAfterStage) {
        throwAfterStage = false;
        io.files.set(path, data.slice(0));
        throw new Error("write response lost");
      }
    };
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "recovered" });
    expect([...io.files.keys()].filter((path) => path.includes("-recovered")).length).toBe(1);
  });

  it("rejects a stage write whose stored bytes differ from the source parts", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-stage-corrupt", ["abc"]);
    io.hooks.writeBinaryAfter = (path) => {
      if (path === stagePath("s-stage-corrupt")) io.files.set(path, new TextEncoder().encode("xyz").buffer as ArrayBuffer);
    };
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "stage-content-mismatch" });
    expect(io.text(stagePath("s-stage-corrupt"))).toBe("xyz");
    expect(io.files.has(`${sessionDir("s-stage-corrupt")}/part-0001.webm`)).toBe(true);
    expect(io.files.has(`${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`)).toBe(false);
  });

  it("recognizes rename that moved the stage before throwing and does not publish twice", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-rename-after", ["wav"]);
    let failAfterMove = true;
    io.hooks.rename = (from, to) => {
      if (!failAfterMove) return;
      failAfterMove = false;
      const value = io.files.get(from);
      if (value === undefined) throw new Error("stage missing");
      io.files.set(to, value);
      io.files.delete(from);
      throw new Error("rename returned late error");
    };
    const first = await recoverInterruptedMasterPartials(port(io).port);
    expect(first[0]).toMatchObject({ status: "recovered" });
    const second = await recoverInterruptedMasterPartials(port(io).port);
    expect(second).toEqual([]);
    expect([...io.files.keys()].filter((path) => path.includes("-recovered")).length).toBe(1);
  });

  it("keeps pending stage after rename fails before moving, then publishes it on retry", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-rename-before", ["wav"]);
    let failBeforeMove = true;
    io.hooks.rename = () => {
      if (failBeforeMove) { failBeforeMove = false; throw new Error("rename unavailable"); }
    };
    const first = await recoverInterruptedMasterPartials(port(io).port);
    expect(first[0]).toMatchObject({ status: "failed" });
    expect(io.files.has(stagePath("s-rename-before"))).toBe(true);
    expect(io.files.has(`${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`)).toBe(false);
    expect(io.files.has(`${sessionDir("s-rename-before")}/part-0001.webm`)).toBe(true);
    io.hooks.rename = undefined;
    const retry = await recoverInterruptedMasterPartials(port(io).port);
    expect(retry[0]).toMatchObject({ status: "recovered" });
    expect([...io.files.keys()].filter((path) => path.includes("-recovered")).length).toBe(1);
  });

  it("adopts matching target and stage after a copy-then-throw rename", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-rename-copy", ["wav"]);
    let failAfterCopy = true;
    io.hooks.rename = (from, to) => {
      if (!failAfterCopy) return;
      failAfterCopy = false;
      const value = io.files.get(from);
      if (value === undefined) throw new Error("stage missing");
      io.files.set(to, value);
      throw new Error("rename interrupted after copy");
    };
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "recovered" });
    expect([...io.files.keys()].filter((path) => path.includes("-recovered")).length).toBe(1);
    expect(io.files.has(stagePath("s-rename-copy"))).toBe(false);
  });

  it("keeps pending state when final marker write fails, then finalizes without another output", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-final-write", ["wav"]);
    let failFinal = true;
    io.hooks.write = (path, data) => {
      if (!path.endsWith("meta.json")) return;
      const meta = JSON.parse(data) as Record<string, unknown>;
      if (meta.recoveredPath && failFinal) { failFinal = false; throw new Error("disk unavailable"); }
    };
    const first = await recoverInterruptedMasterPartials(port(io).port);
    expect(first[0]).toMatchObject({ status: "failed" });
    expect(io.files.has(stagePath("s-final-write"))).toBe(false);
    expect(io.files.has(`${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`)).toBe(true);
    expect(io.files.has(`${sessionDir("s-final-write")}/part-0001.webm`)).toBe(true);
    io.hooks.write = undefined;
    const retry = await recoverInterruptedMasterPartials(port(io).port);
    expect(retry[0]).toMatchObject({ status: "recovered" });
    expect([...io.files.keys()].filter((path) => path.includes("-recovered")).length).toBe(1);
  });

  it("accepts a final marker write that took effect before throwing", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-final-after-effect", ["wav"]);
    let throwAfterFinal = true;
    io.hooks.write = (path, data) => {
      if (!path.endsWith("meta.json")) return;
      const record = JSON.parse(data) as Record<string, unknown>;
      if (record.recoveredPath && throwAfterFinal) {
        throwAfterFinal = false;
        io.files.set(path, data);
        throw new Error("write response lost");
      }
    };
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "recovered", cleanupPending: false });
    expect(io.dirs.has(sessionDir("s-final-after-effect"))).toBe(false);
    expect([...io.files.keys()].filter((path) => path.includes("-recovered")).length).toBe(1);
  });

  it("does not clean partials when final marker readback fails", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-final-readback", ["wav"]);
    io.hooks.read = (path) => {
      if (path.endsWith("meta.json") && io.text(path).includes("\"recoveredPath\"")) throw new Error("read unavailable");
    };
    const first = await recoverInterruptedMasterPartials(port(io).port);
    expect(first[0]).toMatchObject({ status: "failed" });
    expect(io.dirs.has(sessionDir("s-final-readback"))).toBe(true);
    expect(io.files.has(`${sessionDir("s-final-readback")}/part-0001.webm`)).toBe(true);
    expect(io.files.has(`${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`)).toBe(true);
    io.hooks.read = undefined;
    const retry = await recoverInterruptedMasterPartials(port(io).port);
    expect(retry[0]).toMatchObject({ status: "already-handled", reason: "recovered" });
    expect([...io.files.keys()].filter((path) => path.includes("-recovered")).length).toBe(1);
  });

  it("preserves an existing pending target when it conflicts with the staged bytes", async () => {
    const io = new MemoryAdapter();
    const target = `${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`;
    seedSession(io, "s-target-conflict", ["abc"], { pendingRecoveryPath: target, pendingRecoveryBytes: 3 });
    io.files.set(stagePath("s-target-conflict"), new TextEncoder().encode("abc").buffer as ArrayBuffer);
    io.files.set(target, "xyz");
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed" });
    expect(io.text(target)).toBe("xyz");
    expect(io.text(stagePath("s-target-conflict"))).toBe("abc");
    expect(io.files.has(`${sessionDir("s-target-conflict")}/part-0001.webm`)).toBe(true);
  });

  it("rejects pending target paths outside the session recovery naming scope", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-target-scope", ["abc"], {
      pendingRecoveryPath: "other/folder/user-audio.webm",
      pendingRecoveryBytes: 3,
    });
    io.files.set(stagePath("s-target-scope"), new TextEncoder().encode("abc").buffer as ArrayBuffer);
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "pending-target-invalid" });
    expect(io.files.has(stagePath("s-target-scope"))).toBe(true);
    expect(io.files.has(`${sessionDir("s-target-scope")}/part-0001.webm`)).toBe(true);
  });

  it("rejects pending bytes that do not equal the verified part total", async () => {
    const io = new MemoryAdapter();
    const target = `${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`;
    seedSession(io, "s-pending-size", ["abc"], { pendingRecoveryPath: target, pendingRecoveryBytes: 4 });
    io.files.set(stagePath("s-pending-size"), new TextEncoder().encode("abc").buffer as ArrayBuffer);
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "pending-size-mismatch" });
    expect(io.files.has(stagePath("s-pending-size"))).toBe(true);
    expect(io.files.has(`${sessionDir("s-pending-size")}/part-0001.webm`)).toBe(true);
  });

  it("preserves an empty session when a stage exists without parts", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-empty-stage", []);
    io.files.set(stagePath("s-empty-stage"), "unknown");
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "recovery-state-without-parts" });
    expect(io.dirs.has(sessionDir("s-empty-stage"))).toBe(true);
    expect(io.files.has(stagePath("s-empty-stage"))).toBe(true);
  });

  it("reports cleanup complete when rmdir removes the folder before throwing", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-clean-after-effect", ["wav"]);
    const { port: recoveryPort, logs } = port(io);
    io.hooks.rmdir = (path) => {
      if (path !== sessionDir("s-clean-after-effect")) return;
      for (const key of [...io.files.keys()]) if (key.startsWith(`${path}/`)) io.files.delete(key);
      for (const dir of [...io.dirs]) if (dir === path || dir.startsWith(`${path}/`)) io.dirs.delete(dir);
      throw new Error("response lost after removal");
    };
    const outcomes = await recoverInterruptedMasterPartials(recoveryPort);
    expect(outcomes[0]).toMatchObject({ status: "recovered", cleanupPending: false });
    expect(io.dirs.has(sessionDir("s-clean-after-effect"))).toBe(false);
    expect(logs.some((entry) => entry.code === "recording.recovery_cleanup_failed")).toBe(false);
  });

  it("does not adopt a same-size modified stage or pending target", async () => {
    const io = new MemoryAdapter();
    const target = `${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`;
    seedSession(io, "s-stage-changed", ["abc"]);
    io.files.set(stagePath("s-stage-changed"), new TextEncoder().encode("xyz").buffer as ArrayBuffer);
    const stageResult = await recoverInterruptedMasterPartials(port(io).port);
    expect(stageResult[0]).toMatchObject({ status: "failed" });
    expect(io.files.has(`${sessionDir("s-stage-changed")}/part-0001.webm`)).toBe(true);
    expect(io.text(stagePath("s-stage-changed"))).toBe("xyz");

    seedSession(io, "s-target-changed", ["abc"], {
      pendingRecoveryPath: target,
      pendingRecoveryBytes: 3,
    } as Partial<MasterPartialMeta>);
    io.files.set(target, "xyz");
    const targetResult = await recoverInterruptedMasterPartials(port(io).port);
    expect(targetResult.find((item) => item.sessionId === "s-target-changed")).toMatchObject({ status: "failed" });
    expect(io.text(target)).toBe("xyz");
    expect(io.files.has(`${sessionDir("s-target-changed")}/part-0001.webm`)).toBe(true);
  });

  it("does not recreate a pending target when both target and stage are missing", async () => {
    const io = new MemoryAdapter();
    const target = `${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`;
    seedSession(io, "s-pending-missing", ["abc"], {
      pendingRecoveryPath: target,
      pendingRecoveryBytes: 3,
    } as Partial<MasterPartialMeta>);
    const before = io.text(`${sessionDir("s-pending-missing")}/meta.json`);
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed" });
    expect(io.text(`${sessionDir("s-pending-missing")}/meta.json`)).toBe(before);
    expect(io.files.has(`${sessionDir("s-pending-missing")}/part-0001.webm`)).toBe(true);
    expect(io.files.has(target)).toBe(false);
  });

  it("is a no-op on the second run", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-once", ["x", "y"]);
    await recoverInterruptedMasterPartials(port(io).port);
    const filesAfterFirst = [...io.files.keys()].sort();
    const second = await recoverInterruptedMasterPartials(port(io).port);
    expect(second).toEqual([]);
    expect([...io.files.keys()].sort()).toEqual(filesAfterFirst);
  });

  it("keeps every partial file when the written size does not match", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-size", ["abc", "def"]);
    io.hooks.statSize = (path, size) => (path.endsWith("-recovered.webm") ? size + 1 : size);
    const { port: recoveryPort, logs } = port(io);
    const outcomes = await recoverInterruptedMasterPartials(recoveryPort);
    expect(outcomes[0]).toMatchObject({ sessionId: "s-size", status: "failed", reason: "published-target-size-mismatch" });
    expect(io.files.has(`${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`)).toBe(true);
    expect(io.files.has(`${sessionDir("s-size")}/part-0001.webm`)).toBe(true);
    expect(io.files.has(`${sessionDir("s-size")}/part-0002.webm`)).toBe(true);
    expect(logs).toEqual([expect.objectContaining({ level: "error", code: "recording.recovery_failed" })]);
    // 诊断数据只含场次与原因，不含音频内容。
    expect(JSON.stringify(logs[0]!.data)).not.toContain("abc");
  });

  it("keeps partials when a committed part is truncated", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-truncated", ["abc", "d"], { partCount: 2, flushedBytes: 6 });
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "committed-size-mismatch" });
    expect(io.files.has(`${sessionDir("s-truncated")}/part-0001.webm`)).toBe(true);
    expect(io.files.has(`${sessionDir("s-truncated")}/part-0002.webm`)).toBe(true);
    expect([...io.files.keys()].some((key) => key.includes("-recovered"))).toBe(false);
  });

  it("keeps the committed prefix when the last committed part is missing", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-missing-tail", ["abc"], { partCount: 2, flushedBytes: 7 });
    const metaBefore = io.text(`${sessionDir("s-missing-tail")}/meta.json`);
    const partBefore = io.text(`${sessionDir("s-missing-tail")}/part-0001.webm`);
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "parts-missing" });
    expect(io.text(`${sessionDir("s-missing-tail")}/meta.json`)).toBe(metaBefore);
    expect(io.text(`${sessionDir("s-missing-tail")}/part-0001.webm`)).toBe(partBefore);
    expect([...io.files.keys()].some((key) => key.includes("-recovered"))).toBe(false);
  });

  it("recovers one complete uncommitted tail after the committed prefix", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-tail", ["abc", "d"], { partCount: 1, flushedBytes: 3 });
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "recovered", bytes: 4, parts: 2 });
    expect(io.text(`${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`)).toBe("abcd");
  });

  it("recovers one uncommitted tail when metadata records an empty prefix", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-zero-tail", ["d"], { partCount: 0, flushedBytes: 0 });
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "recovered", bytes: 1, parts: 1 });
  });

  it("keeps partials when more than one uncommitted tail exists", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-extra-tails", ["a", "b", "c"], { partCount: 1, flushedBytes: 1 });
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "unexpected-part-count" });
    expect(io.files.has(`${sessionDir("s-extra-tails")}/part-0001.webm`)).toBe(true);
    expect(io.files.has(`${sessionDir("s-extra-tails")}/part-0003.webm`)).toBe(true);
  });

  it("keeps an empty folder when metadata declares bytes without committed parts", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-zero-bytes-mismatch", [], { partCount: 0, flushedBytes: 2 });
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "committed-size-mismatch" });
    expect(io.dirs.has(sessionDir("s-zero-bytes-mismatch"))).toBe(true);
  });

  it("checks the committed prefix even when a tail makes the combined byte count match", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-prefix-only", ["ab", "c"], { partCount: 1, flushedBytes: 3 });
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "committed-size-mismatch" });
    expect(io.files.has(`${sessionDir("s-prefix-only")}/part-0001.webm`)).toBe(true);
    expect(io.files.has(`${sessionDir("s-prefix-only")}/part-0002.webm`)).toBe(true);
  });

  it("keeps the folder when cleanup fails, records the recovered file, and never recovers it twice", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-clean", ["p", "q"]);
    let failRemoval = true;
    io.hooks.rmdir = () => {
      if (failRemoval) { failRemoval = false; throw new Error("locked"); }
    };
    const first = await recoverInterruptedMasterPartials(port(io).port);
    expect(first[0]).toMatchObject({ status: "recovered", cleanupPending: true });
    const meta = parseMasterPartialMeta(io.text(`${sessionDir("s-clean")}/meta.json`));
    expect(meta.recoveredPath).toBe(`${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`);
    expect(meta.recoveredBytes).toBe(2);

    const second = await recoverInterruptedMasterPartials(port(io).port);
    expect(second).toEqual([expect.objectContaining({ sessionId: "s-clean", status: "already-handled", reason: "recovered" })]);
    expect(io.dirs.has(sessionDir("s-clean"))).toBe(false);
    const recoveredFiles = [...io.files.keys()].filter((key) => key.includes("-recovered"));
    expect(recoveredFiles).toHaveLength(1);
  });

  it("keeps a folder whose meta cannot be parsed, and logs the failure", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-bad-meta", ["z"]);
    io.files.set(`${sessionDir("s-bad-meta")}/meta.json`, "{broken");
    const { port: recoveryPort, logs } = port(io);
    const outcomes = await recoverInterruptedMasterPartials(recoveryPort);
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "meta-invalid" });
    expect(io.files.has(`${sessionDir("s-bad-meta")}/part-0001.webm`)).toBe(true);
    expect(logs[0]).toMatchObject({ code: "recording.recovery_failed" });
  });

  it("refuses a gap in part numbering and keeps the folder", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-gap", ["one", "three"], {}, ["part-0001.webm", "part-0003.webm"]);
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "part-gap" });
    expect(io.files.has(`${sessionDir("s-gap")}/part-0003.webm`)).toBe(true);
  });

  it("refuses parts whose extension differs from the meta", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-ext", ["a"], {}, ["part-0001.m4a"]);
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "ext-mismatch" });
  });

  it("removes an empty folder that recorded no parts, but keeps one that recorded parts", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "s-empty", []);
    seedSession(io, "s-lost", []);
    io.files.set(`${sessionDir("s-lost")}/meta.json`, JSON.stringify(metaFor("s-lost", 2)));
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    const byId = Object.fromEntries(outcomes.map((item) => [item.sessionId, item]));
    expect(byId["s-empty"]).toMatchObject({ status: "removed-empty" });
    expect(io.dirs.has(sessionDir("s-empty"))).toBe(false);
    expect(byId["s-lost"]).toMatchObject({ status: "failed", reason: "parts-missing" });
    expect(io.dirs.has(sessionDir("s-lost"))).toBe(true);
  });

  it("skips the active session and leaves its folder untouched", async () => {
    const io = new MemoryAdapter();
    seedSession(io, "live", ["l1", "l2"]);
    const outcomes = await recoverInterruptedMasterPartials(port(io, { isActiveSession: (id) => id === "live" }).port);
    expect(outcomes).toEqual([{ sessionId: "live", status: "active" }]);
    expect(io.files.has(`${sessionDir("live")}/part-0002.webm`)).toBe(true);
    expect([...io.files.keys()].some((key) => key.includes("-recovered"))).toBe(false);
  });

  it("adds a numeric suffix instead of overwriting an existing file with the same name", async () => {
    const io = new MemoryAdapter();
    io.files.set(`${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`, "existing");
    seedSession(io, "s-collide", ["n"]);
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "recovered", path: `${AUDIO_FOLDER}/qnalog-20261006-120000-recovered-2.webm` });
    expect(io.text(`${AUDIO_FOLDER}/qnalog-20261006-120000-recovered.webm`)).toBe("existing");
  });

  it("removes a folder already marked as saved without writing a recovered file", async () => {
    const io = new MemoryAdapter();
    const path = `${AUDIO_FOLDER}/qnalog-x.webm`;
    seedSession(io, "s-saved", ["s"], { savedAs: path, savedBytes: 1 });
    io.files.set(path, "s");
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes).toEqual([{ sessionId: "s-saved", status: "already-handled", reason: "saved" }]);
    expect(io.dirs.has(sessionDir("s-saved"))).toBe(false);
    expect([...io.files.keys()].some((key) => key.includes("-recovered"))).toBe(false);
  });

  it("treats an already-handled cleanup as complete when rmdir removes the folder before throwing", async () => {
    const io = new MemoryAdapter();
    const path = `${AUDIO_FOLDER}/qnalog-handled-cleanup.webm`;
    seedSession(io, "s-handled-cleanup-after-effect", ["x"], { recoveredPath: path, recoveredBytes: 1 });
    io.files.set(path, "x");
    const { port: recoveryPort, logs } = port(io);
    io.hooks.rmdir = (dir) => {
      if (dir !== sessionDir("s-handled-cleanup-after-effect")) return;
      for (const key of [...io.files.keys()]) if (key.startsWith(`${dir}/`)) io.files.delete(key);
      for (const child of [...io.dirs]) if (child === dir || child.startsWith(`${dir}/`)) io.dirs.delete(child);
      throw new Error("response lost after removal");
    };
    const outcomes = await recoverInterruptedMasterPartials(recoveryPort);
    expect(outcomes[0]).toMatchObject({ status: "already-handled", reason: "recovered" });
    expect(io.dirs.has(sessionDir("s-handled-cleanup-after-effect"))).toBe(false);
    expect(logs).toEqual([]);
  });

  it("preserves partials when a recovered target is missing or shorter than its recorded size", async () => {
    const io = new MemoryAdapter();
    const missingPath = `${AUDIO_FOLDER}/qnalog-missing-recovered.webm`;
    const shortPath = `${AUDIO_FOLDER}/qnalog-short-recovered.webm`;
    seedSession(io, "s-recovered-missing", ["abc"], { recoveredPath: missingPath, recoveredBytes: 3 });
    seedSession(io, "s-recovered-short", ["def"], { recoveredPath: shortPath, recoveredBytes: 3 });
    io.files.set(shortPath, "de");
    const before = ["s-recovered-missing", "s-recovered-short"].map((id) => ({
      meta: io.text(`${sessionDir(id)}/meta.json`),
      part: io.text(`${sessionDir(id)}/part-0001.webm`),
    }));
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.status === "failed")).toBe(true);
    for (const [index, id] of ["s-recovered-missing", "s-recovered-short"].entries()) {
      expect(io.text(`${sessionDir(id)}/meta.json`)).toBe(before[index]!.meta);
      expect(io.text(`${sessionDir(id)}/part-0001.webm`)).toBe(before[index]!.part);
    }
  });

  it("preserves partials for a legacy saved marker without a recorded target size", async () => {
    const io = new MemoryAdapter();
    const path = `${AUDIO_FOLDER}/qnalog-legacy.webm`;
    seedSession(io, "s-saved-legacy", ["abc"], { savedAs: path });
    io.files.set(path, "abc");
    const metaBefore = io.text(`${sessionDir("s-saved-legacy")}/meta.json`);
    const partBefore = io.text(`${sessionDir("s-saved-legacy")}/part-0001.webm`);
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed" });
    expect(io.text(`${sessionDir("s-saved-legacy")}/meta.json`)).toBe(metaBefore);
    expect(io.text(`${sessionDir("s-saved-legacy")}/part-0001.webm`)).toBe(partBefore);
  });

  it("preserves partials when a saved target is missing or shorter than its recorded size", async () => {
    const io = new MemoryAdapter();
    const missingPath = `${AUDIO_FOLDER}/qnalog-missing-saved.webm`;
    const shortPath = `${AUDIO_FOLDER}/qnalog-short-saved.webm`;
    seedSession(io, "s-saved-missing", ["abc"], { savedAs: missingPath, savedBytes: 5 });
    seedSession(io, "s-saved-short", ["xyz"], { savedAs: shortPath, savedBytes: 5 });
    io.files.set(shortPath, "abcd");
    const before = ["s-saved-missing", "s-saved-short"].map((id) => ({
      meta: io.text(`${sessionDir(id)}/meta.json`),
      part: io.text(`${sessionDir(id)}/part-0001.webm`),
    }));
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.status === "failed")).toBe(true);
    for (const [index, id] of ["s-saved-missing", "s-saved-short"].entries()) {
      expect(io.text(`${sessionDir(id)}/meta.json`)).toBe(before[index]!.meta);
      expect(io.text(`${sessionDir(id)}/part-0001.webm`)).toBe(before[index]!.part);
    }
  });

  it("preserves partials when the handled target stat fails", async () => {
    const io = new MemoryAdapter();
    const path = `${AUDIO_FOLDER}/qnalog-stat-failure.webm`;
    seedSession(io, "s-stat-failure", ["abc"], { recoveredPath: path, recoveredBytes: 3 });
    io.files.set(path, "abc");
    io.stat = async () => { throw new Error("temporarily unavailable"); };
    const metaBefore = io.text(`${sessionDir("s-stat-failure")}/meta.json`);
    const partBefore = io.text(`${sessionDir("s-stat-failure")}/part-0001.webm`);
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed" });
    expect(io.text(`${sessionDir("s-stat-failure")}/meta.json`)).toBe(metaBefore);
    expect(io.text(`${sessionDir("s-stat-failure")}/part-0001.webm`)).toBe(partBefore);
  });

  it("preserves partials when the handled target is a folder", async () => {
    const io = new MemoryAdapter();
    const path = `${AUDIO_FOLDER}/qnalog-folder-target.webm`;
    seedSession(io, "s-folder-target", ["abc"], { recoveredPath: path, recoveredBytes: 3 });
    io.files.set(path, "abc");
    io.stat = async () => ({ size: 3, type: "folder" });
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes[0]).toMatchObject({ status: "failed" });
    expect(io.files.has(`${sessionDir("s-folder-target")}/part-0001.webm`)).toBe(true);
  });

  it("rejects handled target sizes smaller than the committed prefix", async () => {
    const io = new MemoryAdapter();
    const savedPath = `${AUDIO_FOLDER}/qnalog-underreported-saved.webm`;
    const recoveredPath = `${AUDIO_FOLDER}/qnalog-underreported-recovered.webm`;
    seedSession(io, "s-saved-underreported", ["abc"], { savedAs: savedPath, savedBytes: 0 });
    seedSession(io, "s-recovered-underreported", ["abc"], { recoveredPath, recoveredBytes: 0 });
    io.files.set(savedPath, "");
    io.files.set(recoveredPath, "");
    const outcomes = await recoverInterruptedMasterPartials(port(io).port);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.status === "failed")).toBe(true);
    for (const id of ["s-saved-underreported", "s-recovered-underreported"]) {
      expect(io.files.has(`${sessionDir(id)}/part-0001.webm`)).toBe(true);
      expect(io.files.has(`${sessionDir(id)}/meta.json`)).toBe(true);
    }
  });

  it("uses the recording file timestamp format for the recovered name", () => {
    expect(formatRecoveryStamp(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe("20260102-030405");
  });
});
