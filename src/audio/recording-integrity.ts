import { t } from "../shared/i18n";
import { sha256ArrayBuffer } from "../shared/sha256";
import { readTranscriptBlocks } from "../transcript/transcript-markdown";
import { readSourceIntegrity, type SourceIntegrity } from "../transcript/source-integrity";

/**
 * 核对笔记转写账本里记录的录音完整性（SHA-256 与字节数）。
 *
 * 只读：端口只有读取能力，不改录音、不改账本、不删任何文件。
 * 结果只提示用户；不一致时不自动修复，也不判断原因。
 */

/** 核对时整份读入录音，超过此大小不读，提示「文件过大，未核对」。 */
export const INTEGRITY_CHECK_MAX_BYTES = 256 * 1024 * 1024;

export type IntegrityCheckStatus = "match" | "differs" | "missing" | "too-large" | "read-failed";

export interface RecordedSource {
  path: string;
  name: string;
  integrity: SourceIntegrity;
}

export interface IntegrityCheckItem extends RecordedSource {
  status: IntegrityCheckStatus;
}

/** 核对所需的读取能力；不含任何写入或删除方法。 */
export interface RecordingIntegrityReadPort {
  readNote(path: string): Promise<string>;
  /** 文件不存在时返回 null。 */
  statFile(path: string): Promise<{ size: number } | null>;
  readBinary(path: string): Promise<ArrayBuffer>;
}

export interface RecordingIntegrityPort extends RecordingIntegrityReadPort {
  notify(message: string, timeoutMs?: number): void;
}

/** Obsidian `DataAdapter` 中核对用到的只读方法。 */
export interface IntegrityVaultAdapter {
  read(path: string): Promise<string>;
  stat(path: string): Promise<{ size: number } | null>;
  readBinary(path: string): Promise<ArrayBuffer>;
}

export function createAdapterIntegrityReadPort(adapter: IntegrityVaultAdapter): RecordingIntegrityReadPort {
  return {
    readNote: (path) => adapter.read(path),
    statFile: async (path) => {
      const stat = await adapter.stat(path);
      return stat ? { size: Number(stat.size) } : null;
    },
    readBinary: (path) => adapter.readBinary(path),
  };
}

/** 列出账本中带合法完整性记录的录音；同一路径与同一摘要只列一次。账本无法解析时返回空列表。 */
export function listRecordedSources(markdown: string): RecordedSource[] {
  let blocks: ReturnType<typeof readTranscriptBlocks>;
  try {
    blocks = readTranscriptBlocks(markdown);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const sources: RecordedSource[] = [];
  for (const block of blocks) {
    const record = block.segment.transcript;
    const integrity = readSourceIntegrity(record?.sourceIntegrity);
    const path = String(record?.sourcePath || "");
    if (!record || !integrity || !path) continue;
    const key = `${path}\n${integrity.sha256}\n${integrity.bytes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ path, name: String(record.sourceName || path.split("/").pop() || path), integrity });
  }
  return sources;
}

export function hasRecordedSources(markdown: string): boolean {
  return listRecordedSources(markdown).length > 0;
}

async function checkOne(port: RecordingIntegrityReadPort, source: RecordedSource): Promise<IntegrityCheckStatus> {
  let stat: { size: number } | null;
  try {
    stat = await port.statFile(source.path);
  } catch {
    return "read-failed";
  }
  if (!stat) return "missing";
  if (stat.size > INTEGRITY_CHECK_MAX_BYTES) return "too-large";
  if (stat.size !== source.integrity.bytes) return "differs";
  let bytes: ArrayBuffer;
  try {
    bytes = await port.readBinary(source.path);
  } catch {
    return "read-failed";
  }
  if (bytes.byteLength > INTEGRITY_CHECK_MAX_BYTES) return "too-large";
  if (bytes.byteLength !== source.integrity.bytes) return "differs";
  let digest: string;
  try {
    digest = await sha256ArrayBuffer(bytes);
  } catch {
    return "read-failed";
  }
  return digest === source.integrity.sha256 ? "match" : "differs";
}

/** 核对一篇笔记记录的全部录音。返回空数组表示笔记没有完整性记录。 */
export async function checkNoteRecordingIntegrity(port: RecordingIntegrityReadPort, notePath: string): Promise<IntegrityCheckItem[]> {
  const sources = listRecordedSources(await port.readNote(notePath));
  const items: IntegrityCheckItem[] = [];
  for (const source of sources) items.push({ ...source, status: await checkOne(port, source) });
  return items;
}

function statusText(status: IntegrityCheckStatus): string {
  switch (status) {
    case "match": return t("matches the record");
    case "differs": return t("the file differs from when it was recorded");
    case "missing": return t("file not found");
    case "too-large": return t("file is larger than 256 MiB; not checked");
    case "read-failed": return t("could not be read; not checked");
  }
}

export function formatIntegrityReport(items: readonly IntegrityCheckItem[]): string {
  if (!items.length) return t("This note has no recording checksum record.");
  const lines = items.map((item) => `${item.name}${t(": ")}${statusText(item.status)}`);
  return [t("Recording integrity check"), ...lines, t("No files were changed.")].join("\n");
}

/** 命令与右键菜单共用的入口：提示开始、核对、提示结果。 */
export async function runRecordingIntegrityCheck(port: RecordingIntegrityPort, notePath: string): Promise<IntegrityCheckItem[]> {
  port.notify(t("Checking recording integrity…"), 3000);
  let items: IntegrityCheckItem[];
  try {
    items = await checkNoteRecordingIntegrity(port, notePath);
  } catch {
    port.notify(t("Could not read this note; recording integrity was not checked."), 8000);
    return [];
  }
  const allMatch = items.length > 0 && items.every((item) => item.status === "match");
  port.notify(formatIntegrityReport(items), allMatch ? 6000 : 15000);
  return items;
}

/**
 * 菜单与命令在同步回调里决定是否显示，因此按路径与修改时间缓存「笔记是否有完整性记录」。
 * 未缓存或已过期时返回 undefined，由调用方触发 `refresh` 后在下一次显示。
 */
export class IntegrityRecordAvailability {
  private readonly entries = new Map<string, { mtime: number; has: boolean }>();

  constructor(private readonly readNote: (path: string) => Promise<string>, private readonly limit = 200) {}

  get(path: string, mtime: number): boolean | undefined {
    const entry = this.entries.get(path);
    return entry && entry.mtime === mtime ? entry.has : undefined;
  }

  /** 同步回调用：已知时直接返回；未知或过期时返回 false 并在后台刷新。 */
  availableNow(path: string, mtime: number): boolean {
    const known = this.get(path, mtime);
    if (known === undefined) void this.refresh(path, mtime);
    return known === true;
  }

  async refresh(path: string, mtime: number): Promise<boolean> {
    let has = false;
    try {
      has = hasRecordedSources(await this.readNote(path));
    } catch {
      has = false;
    }
    this.entries.delete(path);
    this.entries.set(path, { mtime, has });
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.entries.delete(key);
    }
    return has;
  }
}
