// 录音母带的增量分片：录音中把新增的音频分片写入 `<录音目录>/.partial/<场次>/`。
// 正常停止并保存完整母带后删除该目录；进程中断后残留的分片由 master-partial-recovery.ts 恢复。
// 本文件只做单场次的写入与删除，不调用 Obsidian 的 Vault 接口（通过 MasterPartialAdapter 传入适配器）。

import { extFromMime } from "../shared/util-audio";

export const PARTIAL_DIR_NAME = ".partial";
export const PARTIAL_META_FILE = "meta.json";
const PART_NAME_RE = /^part-(\d{4,})\.([a-z0-9]+)$/i;

/** 适配器的最小接口：只包含本功能用到的方法（Obsidian 的 DataAdapter 满足此接口）。 */
export interface MasterPartialAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  write(path: string, data: string): Promise<void>;
  read(path: string): Promise<string>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  rename(path: string, newPath: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ size: number; type?: "file" | "folder" } | null>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
}

/** 写入 meta.json 的内容。每写一个分片后刷新；恢复时用于判断是否已经恢复或已被正式保存。 */
export interface MasterPartialMeta {
  version: 1;
  sessionId: string;
  /** 本场录音对应的笔记路径（续录时为暂存文件路径）。 */
  notePath: string;
  /** 录音开始的时间（毫秒，Unix 时间）；用于生成恢复文件名。 */
  startedAt: number;
  mime: string;
  ext: string;
  /** 已成功写入的分片数量。 */
  partCount: number;
  /** 已成功写入的分片字节合计。 */
  flushedBytes: number;
  lastFlushAt: number;
  /** 采集模式（麦克风 / 混合 / 电脑音频）。 */
  sourceMode: string;
  /** 整理模式 id。 */
  mode: string;
  /** 已正式保存的母带路径与写入字节数；清理前按目标文件类型和字节数核对。 */
  savedAs?: string;
  savedBytes?: number;
  /** 恢复后的文件路径与写入字节数；清理前按目标文件类型和字节数核对。 */
  recoveredPath?: string;
  recoveredBytes?: number;
  /** 恢复发布期间的目标意图；最终标记写入前保留，用于重启后判断 stage 与目标状态。 */
  pendingRecoveryPath?: string;
  pendingRecoveryBytes?: number;
}

export type MasterPartialTargetCheck =
  | { ok: true }
  | { ok: false; reason: "size-invalid" | "size-below-prefix" | "missing" | "size-unavailable" | "size-mismatch" | "check-failed"; error?: unknown };

export interface MasterPartialSessionInit {
  sessionId: string;
  audioFolder: string;
  notePath: string;
  startedAt: number;
  sourceMode: string;
  mode: string;
}

export type MasterPartialAppendResult =
  | { ok: true; partCount: number; bytes: number; writeMs: number }
  | { ok: false; reason: "closed" | "write-failed"; error: unknown };

export function partialRootPath(audioFolder: string): string {
  return `${audioFolder.replace(/\/+$/, "")}/${PARTIAL_DIR_NAME}`;
}

export function partialSessionPath(audioFolder: string, sessionId: string): string {
  return `${partialRootPath(audioFolder)}/${sessionId}`;
}

export function partPathFor(dir: string, index: number, ext: string): string {
  return `${dir}/part-${String(index).padStart(4, "0")}.${ext}`;
}

/** 解析分片文件名；不是分片文件时返回 null。 */
export function parsePartName(name: string): { index: number; ext: string } | null {
  const match = PART_NAME_RE.exec(name);
  if (!match) return null;
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index < 1) return null;
  return { index, ext: match[2].toLowerCase() };
}

/** 检查 meta.json 的结构；不符合时抛错，由调用方保留目录并记录诊断。 */
export function parseMasterPartialMeta(text: string): MasterPartialMeta {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object") throw new Error("meta is not an object");
  const record = value as Record<string, unknown>;
  const str = (key: string): string => {
    const field = record[key];
    if (typeof field !== "string") throw new Error(`meta.${key} is not a string`);
    return field;
  };
  const num = (key: string): number => {
    const field = record[key];
    if (typeof field !== "number" || !Number.isFinite(field) || field < 0) throw new Error(`meta.${key} is not a number`);
    return field;
  };
  const counter = (key: string): number => {
    const field = num(key);
    if (!Number.isSafeInteger(field)) throw new Error(`meta.${key} is not a safe integer`);
    return field;
  };
  if (record.version !== 1) throw new Error("unsupported meta version");
  const meta: MasterPartialMeta = {
    version: 1,
    sessionId: str("sessionId"),
    notePath: str("notePath"),
    startedAt: num("startedAt"),
    mime: str("mime"),
    ext: str("ext"),
    partCount: counter("partCount"),
    flushedBytes: counter("flushedBytes"),
    lastFlushAt: num("lastFlushAt"),
    sourceMode: str("sourceMode"),
    mode: str("mode"),
  };
  if (typeof record.savedAs === "string") {
    if (!record.savedAs) throw new Error("meta.savedAs is empty");
    meta.savedAs = record.savedAs;
  }
  if (record.savedBytes !== undefined) meta.savedBytes = counter("savedBytes");
  if (typeof record.recoveredPath === "string") {
    if (!record.recoveredPath) throw new Error("meta.recoveredPath is empty");
    meta.recoveredPath = record.recoveredPath;
  }
  if (record.recoveredBytes !== undefined) meta.recoveredBytes = counter("recoveredBytes");
  const hasPendingPath = record.pendingRecoveryPath !== undefined;
  const hasPendingBytes = record.pendingRecoveryBytes !== undefined;
  if (hasPendingPath !== hasPendingBytes) throw new Error("meta pending recovery fields must be paired");
  if (hasPendingPath) {
    const pendingPath = str("pendingRecoveryPath");
    if (!pendingPath) throw new Error("meta.pendingRecoveryPath is empty");
    meta.pendingRecoveryPath = pendingPath;
    meta.pendingRecoveryBytes = counter("pendingRecoveryBytes");
  }
  if ((meta.savedAs !== undefined || meta.recoveredPath !== undefined) && hasPendingPath) {
    throw new Error("meta cannot be pending and handled");
  }
  return meta;
}

/**
 * 单场录音的分片写入器。同一时间只执行一次写入；写入失败时计数不前进，
 * 下一次请求会用同一个文件名重新写入，因此不会留下编号空洞。
 */
export class MasterPartialSession {
  private readonly adapter: MasterPartialAdapter;
  private readonly init: MasterPartialSessionInit;
  private readonly dir: string;
  private partCount = 0;
  private flushedBytes = 0;
  private metaWritten = false;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(adapter: MasterPartialAdapter, init: MasterPartialSessionInit) {
    this.adapter = adapter;
    this.init = init;
    this.dir = partialSessionPath(init.audioFolder, init.sessionId);
  }

  get directory(): string {
    return this.dir;
  }

  /** 追加一个分片。第一次写入前先写 meta（分片数为 0），保证目录里总有可读的元数据。 */
  append(blob: Blob, mime: string): Promise<MasterPartialAppendResult> {
    const run = async (): Promise<MasterPartialAppendResult> => {
      if (this.closed) return { ok: false, reason: "closed", error: null };
      const started = Date.now();
      try {
        const ext = extFromMime(mime);
        const data = await blob.arrayBuffer();
        if (!this.metaWritten) {
          await this.ensureFolders();
          await this.writeMeta({ partCount: 0, flushedBytes: 0, ext, mime });
          this.metaWritten = true;
        }
        const index = this.partCount + 1;
        await this.adapter.writeBinary(partPathFor(this.dir, index, ext), data);
        const nextBytes = this.flushedBytes + data.byteLength;
        await this.writeMeta({ partCount: index, flushedBytes: nextBytes, ext, mime });
        this.partCount = index;
        this.flushedBytes = nextBytes;
        return { ok: true, partCount: index, bytes: nextBytes, writeMs: Date.now() - started };
      } catch (error) {
        return { ok: false, reason: "write-failed", error };
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** 等待已排队的写入全部结束（成功或失败）。 */
  drain(): Promise<void> {
    return this.queue.then(() => undefined, () => undefined);
  }

  /** 此后的 append 直接返回 closed，不再写入。 */
  close(): void {
    this.closed = true;
  }

  private async ensureFolders(): Promise<void> {
    const root = partialRootPath(this.init.audioFolder);
    if (!(await this.adapter.exists(root))) await this.adapter.mkdir(root);
    if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
  }

  private async writeMeta(patch: { partCount: number; flushedBytes: number; ext: string; mime: string }): Promise<void> {
    const meta: MasterPartialMeta = {
      version: 1,
      sessionId: this.init.sessionId,
      notePath: this.init.notePath,
      startedAt: this.init.startedAt,
      mime: patch.mime,
      ext: patch.ext,
      partCount: patch.partCount,
      flushedBytes: patch.flushedBytes,
      lastFlushAt: Date.now(),
      sourceMode: this.init.sourceMode,
      mode: this.init.mode,
    };
    await this.adapter.write(`${this.dir}/${PARTIAL_META_FILE}`, JSON.stringify(meta));
  }
}

/** 删除一场录音的分片目录（含 meta）。目录不存在时不做任何事。 */
export async function removePartialDirectory(adapter: MasterPartialAdapter, dir: string): Promise<void> {
  if (!(await adapter.exists(dir))) return;
  await adapter.rmdir(dir, true);
}

/**
 * 录音目录下已没有任何场次目录时删除 `.partial` 根目录；仍有内容时保留。返回是否已删除。
 * 只能用递归删除：桌面端 `rmdir(路径, false)` 对目录报 EISDIR（实测），不会删除空目录。
 * 递归删除前已列出目录确认为空；列出与删除之间若有新场次目录出现，会一并删除，
 * 但新场次要到第一次落盘（录音约 20 秒后）才创建目录，正常使用中不会在这一瞬间出现。
 */
export async function removeEmptyPartialRoot(adapter: MasterPartialAdapter, audioFolder: string): Promise<boolean> {
  const root = partialRootPath(audioFolder);
  if (!(await adapter.exists(root))) return false;
  const listing = await adapter.list(root);
  if (listing.files.length > 0 || listing.folders.length > 0) return false;
  await adapter.rmdir(root, true);
  return true;
}

export async function checkMasterPartialTarget(
  adapter: MasterPartialAdapter,
  path: string,
  expectedBytes: number,
  minimumBytes: number,
): Promise<MasterPartialTargetCheck> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) return { ok: false, reason: "size-invalid" };
  if (expectedBytes < minimumBytes) return { ok: false, reason: "size-below-prefix" };
  try {
    if (!(await adapter.exists(path))) return { ok: false, reason: "missing" };
    const stat = await adapter.stat(path);
    if (!stat || !Number.isSafeInteger(stat.size) || stat.size < 0) return { ok: false, reason: "size-unavailable" };
    if (stat.type !== undefined && stat.type !== "file") return { ok: false, reason: "size-unavailable" };
    if (stat.size !== expectedBytes) return { ok: false, reason: "size-mismatch" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "check-failed", error };
  }
}

/** 在分片目录的 meta.json 中记录正式母带路径与写入时的字节数。 */
export async function markPartialSaved(adapter: MasterPartialAdapter, dir: string, savedPath: string, savedBytes: number): Promise<number | null> {
  const metaPath = `${dir}/${PARTIAL_META_FILE}`;
  if (!(await adapter.exists(metaPath))) return null;
  const meta = parseMasterPartialMeta(await adapter.read(metaPath));
  if (!Number.isSafeInteger(savedBytes) || savedBytes < 0) throw new Error("savedBytes is not a safe integer");
  await adapter.write(metaPath, JSON.stringify({ ...meta, savedAs: savedPath, savedBytes }));
  return meta.flushedBytes;
}
