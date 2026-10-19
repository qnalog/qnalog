// 启动时恢复中断录音：把 `录音/.partial/<场次>/` 中按编号排列的分片合并为一个录音文件（文件名带 -recovered）。
// 只有合并结果的字节数与分片合计一致，并已写入 meta.json 的恢复记录之后，才删除分片目录。
// 任何一步失败都保留分片目录并记录诊断（不含音频与文字内容）。

import { NS_AUDIO_PREFIX } from "../shared/namespace";
import { t } from "../shared/i18n";
import { diagnosticError } from "../shared/util-key-diag";
import {
  PARTIAL_META_FILE,
  checkMasterPartialTarget,
  parseMasterPartialMeta,
  parsePartName,
  partialRootPath,
  removePartialDirectory,
  type MasterPartialAdapter,
  type MasterPartialMeta,
} from "./master-partial";

export interface MasterPartialRecoveryPort {
  adapter: MasterPartialAdapter;
  audioFolder: string;
  /** 正在录音的场次不属于中断录音，跳过。 */
  isActiveSession(sessionId: string): boolean;
  logDiagnostic(level: string, code: string, message: string, data: unknown): Promise<void>;
}

export type MasterPartialRecoveryOutcome =
  /** 已写入恢复文件。cleanupPending 为真时分片目录未能删除，下次启动只会清理目录，不会再次通知。 */
  | { sessionId: string; status: "recovered"; path: string; bytes: number; parts: number; cleanupPending: boolean }
  /** 之前已经处理过（已正式保存或已恢复），目标校验通过后删除残留目录。 */
  | { sessionId: string; status: "already-handled"; reason: "saved" | "recovered" }
  /** 目录中没有任何分片且 meta 记录分片数为 0，没有音频可丢失，已删除。 */
  | { sessionId: string; status: "removed-empty" }
  | { sessionId: string; status: "active" }
  | { sessionId: string; status: "failed"; reason: string };

function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || "";
}

/** 本地时间的 YYYYMMDD-HHmmss，与录音文件名的时间段格式一致。 */
export function formatRecoveryStamp(startedAtMs: number): string {
  const date = new Date(startedAtMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function availableAudioPath(adapter: MasterPartialAdapter, folder: string, stamp: string, ext: string): Promise<string> {
  const base = `${folder.replace(/\/+$/, "")}/${NS_AUDIO_PREFIX}-${stamp}-recovered`;
  let candidate = `${base}.${ext}`;
  for (let n = 2; await adapter.exists(candidate); n++) candidate = `${base}-${n}.${ext}`;
  return candidate;
}

/**
 * 扫描 `<录音目录>/.partial/`，逐个处理非活动场次。
 * 每个场次的结果都会通过返回值给出；单个场次失败不影响其他场次。
 */
export async function recoverInterruptedMasterPartials(port: MasterPartialRecoveryPort): Promise<MasterPartialRecoveryOutcome[]> {
  const root = partialRootPath(port.audioFolder);
  if (!(await port.adapter.exists(root))) return [];
  const listing = await port.adapter.list(root);
  const outcomes: MasterPartialRecoveryOutcome[] = [];
  for (const dir of listing.folders) {
    const sessionId = baseName(dir);
    if (!sessionId) continue;
    if (port.isActiveSession(sessionId)) {
      outcomes.push({ sessionId, status: "active" });
      continue;
    }
    outcomes.push(await recoverOneSession(port, dir, sessionId));
  }
  return outcomes;
}

async function recoverOneSession(port: MasterPartialRecoveryPort, dir: string, sessionId: string): Promise<MasterPartialRecoveryOutcome> {
  const adapter = port.adapter;
  const fail = async (reason: string, error: unknown = null): Promise<MasterPartialRecoveryOutcome> => {
    await port.logDiagnostic("error", "recording.recovery_failed", t("An interrupted recording could not be recovered; its partial files were kept"), {
      sessionId,
      reason,
      ...(error ? { error: diagnosticError(error) } : {}),
    });
    return { sessionId, status: "failed", reason };
  };

  const metaPath = `${dir}/${PARTIAL_META_FILE}`;
  let meta: MasterPartialMeta;
  try {
    if (!(await adapter.exists(metaPath))) return await fail("meta-missing");
    meta = parseMasterPartialMeta(await adapter.read(metaPath));
  } catch (error) {
    return await fail("meta-invalid", error);
  }

  if (meta.savedAs || meta.recoveredPath) {
    const targetPath = meta.savedAs || meta.recoveredPath;
    const expectedBytes = meta.savedAs ? meta.savedBytes : meta.recoveredBytes;
    if (expectedBytes === undefined) return await fail("handled-target-size-unknown");
    const targetCheck = await checkMasterPartialTarget(adapter, targetPath, expectedBytes, meta.flushedBytes);
    if (targetCheck.ok === false) return await fail(`handled-target-${targetCheck.reason}`, targetCheck.error);
    try {
      await removePartialDirectory(adapter, dir);
    } catch (error) {
      return await fail("cleanup-failed", error);
    }
    return { sessionId, status: "already-handled", reason: meta.savedAs ? "saved" : "recovered" };
  }

  let names: string[];
  try {
    const listed = await adapter.list(dir);
    names = listed.files.map(baseName);
  } catch (error) {
    return await fail("list-failed", error);
  }
  const parts = names
    .map((name) => ({ name, parsed: parsePartName(name) }))
    .filter((item): item is { name: string; parsed: { index: number; ext: string } } => item.parsed !== null)
    .sort((a, b) => a.parsed.index - b.parsed.index);

  if (parts.length === 0) {
    if (meta.partCount !== 0) return await fail("parts-missing");
    if (meta.flushedBytes !== 0) return await fail("committed-size-mismatch");
    try {
      await removePartialDirectory(adapter, dir);
    } catch (error) {
      return await fail("cleanup-failed", error);
    }
    return { sessionId, status: "removed-empty" };
  }
  if (parts.length < meta.partCount) return await fail("parts-missing");
  if (parts.length > meta.partCount + 1) return await fail("unexpected-part-count");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].parsed.index !== i + 1) return await fail("part-gap");
    if (parts[i].parsed.ext !== meta.ext) return await fail("ext-mismatch");
  }

  let buffers: ArrayBuffer[];
  try {
    buffers = [];
    for (const part of parts) buffers.push(await adapter.readBinary(`${dir}/${part.name}`));
  } catch (error) {
    return await fail("read-failed", error);
  }
  const committedBytes = buffers.slice(0, meta.partCount).reduce((sum, buffer) => sum + buffer.byteLength, 0);
  if (committedBytes !== meta.flushedBytes) return await fail("committed-size-mismatch");
  const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  if (total === 0) return await fail("empty-parts");

  let target: string;
  try {
    target = await availableAudioPath(adapter, port.audioFolder, formatRecoveryStamp(meta.startedAt), meta.ext);
    const merged = await new Blob(buffers, { type: meta.mime }).arrayBuffer();
    await adapter.writeBinary(target, merged);
    const written = await adapter.stat(target);
    if (!written || written.size !== total) {
      try { await adapter.remove(target); } catch { /* the partial files are still kept */ }
      return await fail("size-mismatch");
    }
  } catch (error) {
    return await fail("write-failed", error);
  }

  // 先记录恢复结果，再删除分片：即使删除失败，下次启动也不会重复恢复。
  try {
    const recorded: MasterPartialMeta = { ...meta, recoveredPath: target, recoveredBytes: total };
    await adapter.write(metaPath, JSON.stringify(recorded));
  } catch (error) {
    await port.logDiagnostic("warn", "recording.recovery_meta_failed", t("The recovery record could not be written; the partial files are still kept"), {
      sessionId,
      error: diagnosticError(error),
    });
  }

  let cleanupPending = false;
  try {
    await removePartialDirectory(adapter, dir);
  } catch (error) {
    cleanupPending = true;
    await port.logDiagnostic("warn", "recording.recovery_cleanup_failed", t("The recovered recording was saved, but its partial files could not be removed"), {
      sessionId,
      error: diagnosticError(error),
    });
  }
  await port.logDiagnostic("info", "recording.recovered", t("Interrupted recording was recovered from its partial files"), {
    sessionId,
    parts: parts.length,
    bytes: total,
  });
  return { sessionId, status: "recovered", path: target, bytes: total, parts: parts.length, cleanupPending };
}
