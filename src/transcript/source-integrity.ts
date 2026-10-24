import { sha256ArrayBuffer, type Sha256ChunkOptions } from "../shared/sha256";

/**
 * 录音完整性记录：录音写入并读回核对后（或导入音频首次读取时）的 SHA-256 与字节数。
 * 存在转写账本 `TranscriptSegmentRecord.sourceIntegrity`，对应同一条记录的 `sourcePath`。
 * 只用于日后确认录音文件未被替换或改动，不参与转写来源修订号的计算。
 */
export interface SourceIntegrity {
  algo: "sha256";
  /** 64 位小写十六进制。 */
  sha256: string;
  bytes: number;
  /** 计算时间，ISO 8601。 */
  at: string;
}

/** 写入侧的耗时上限：超过后放弃本次记录并写诊断日志，不影响录音保存与转写。 */
export const SOURCE_INTEGRITY_TIME_BUDGET_MS = 60_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** 形状合法时返回副本，否则返回 null。账本读取时用它丢弃非法值，不判整条记录损坏。 */
export function readSourceIntegrity(value: unknown): SourceIntegrity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.algo !== "sha256") return null;
  if (typeof row.sha256 !== "string" || !SHA256_HEX.test(row.sha256)) return null;
  if (typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 0) return null;
  if (typeof row.at !== "string" || !row.at || Number.isNaN(Date.parse(row.at))) return null;
  return { algo: "sha256", sha256: row.sha256, bytes: row.bytes, at: row.at };
}

export function sameSourceIntegrity(left: SourceIntegrity | null | undefined, right: SourceIntegrity | null | undefined): boolean {
  if (!left || !right) return !left && !right;
  return left.algo === right.algo && left.sha256 === right.sha256 && left.bytes === right.bytes && left.at === right.at;
}

/** 计算一份已在内存中的录音的完整性记录。失败时抛出，由调用方记日志。 */
export async function computeSourceIntegrity(
  buffer: ArrayBuffer,
  options: Sha256ChunkOptions & { at?: Date } = {},
): Promise<SourceIntegrity> {
  const sha256 = await sha256ArrayBuffer(buffer, { timeBudgetMs: SOURCE_INTEGRITY_TIME_BUDGET_MS, ...options });
  return { algo: "sha256", sha256, bytes: buffer.byteLength, at: (options.at ?? new Date()).toISOString() };
}
