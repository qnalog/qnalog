// 启动时恢复中断录音：把 `录音/.partial/<场次>/` 中按编号排列的分片合并为一个录音文件（文件名带 -recovered）。
// 只有合并结果通过逐字节核对，且 meta.json 的最终恢复记录写入并读回确认后，才删除分片目录。
// 恢复状态无法核实时保留分片目录并记录诊断（不含音频与文字内容）；清理异常后按目录实际状态报告结果。

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

function stagePath(dir: string, ext: string): string {
  return `${dir}/recovered.stage.${ext}`;
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function recoveryTargetPathAllowed(path: string, folder: string, stamp: string, ext: string): boolean {
  const stem = `${folder.replace(/\/+$/, "")}/${NS_AUDIO_PREFIX}-${stamp}-recovered`;
  if (path === `${stem}.${ext}`) return true;
  if (!path.startsWith(`${stem}-`) || !path.endsWith(`.${ext}`)) return false;
  const suffix = path.slice(stem.length + 1, -(ext.length + 1));
  const number = Number(suffix);
  return Number.isSafeInteger(number) && number >= 2 && String(number) === suffix;
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

  const stagedPath = stagePath(dir, meta.ext);
  let hasStage: boolean;
  try {
    hasStage = await adapter.exists(stagedPath);
  } catch (error) {
    return await fail("stage-check-failed", error);
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
    if (hasStage || meta.pendingRecoveryPath) return await fail("recovery-state-without-parts");
    if (meta.savedAs || meta.recoveredPath) return await fail("handled-parts-missing");
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
  if (!Number.isSafeInteger(committedBytes) || committedBytes !== meta.flushedBytes) return await fail("committed-size-mismatch");
  const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  if (!Number.isSafeInteger(total)) return await fail("parts-size-invalid");
  if (total === 0) return await fail("empty-parts");

  let merged: ArrayBuffer;
  try { merged = await new Blob(buffers, { type: meta.mime }).arrayBuffer(); }
  catch (error) { return await fail("merge-failed", error); }
  if (merged.byteLength !== total) return await fail("merged-size-mismatch");

  if (meta.savedAs || meta.recoveredPath) {
    const targetPath = meta.savedAs || meta.recoveredPath;
    const expectedBytes = meta.savedAs ? meta.savedBytes : meta.recoveredBytes;
    if (expectedBytes === undefined) return await fail("handled-target-size-unknown");
    if (expectedBytes !== merged.byteLength) return await fail("handled-target-parts-size-mismatch");
    const targetCheck = await checkMasterPartialTarget(adapter, targetPath, expectedBytes, meta.flushedBytes);
    if (targetCheck.ok === false) return await fail(`handled-target-${targetCheck.reason}`, targetCheck.error);
    try {
      if (!sameBytes(await adapter.readBinary(targetPath), merged)) return await fail("handled-target-content-mismatch");
    } catch (error) {
      return await fail("handled-target-read-failed", error);
    }
    try {
      await removePartialDirectory(adapter, dir);
    } catch (error) {
      try {
        if (!(await adapter.exists(dir))) {
          return { sessionId, status: "already-handled", reason: meta.savedAs ? "saved" : "recovered" };
        }
      } catch (checkError) {
        return await fail("cleanup-state-check-failed", checkError);
      }
      return await fail("cleanup-failed", error);
    }
    return { sessionId, status: "already-handled", reason: meta.savedAs ? "saved" : "recovered" };
  }

  let target: string;
  let hasPending = meta.pendingRecoveryPath !== undefined;
  if (hasPending) {
    const pendingPath = meta.pendingRecoveryPath;
    if (!pendingPath) return await fail("pending-target-invalid");
    target = pendingPath;
    if (!recoveryTargetPathAllowed(target, port.audioFolder, formatRecoveryStamp(meta.startedAt), meta.ext)) {
      return await fail("pending-target-invalid");
    }
    if (meta.pendingRecoveryBytes !== total) return await fail("pending-size-mismatch");
  } else {
    let stageMatches = false;
    if (hasStage) {
      try {
        stageMatches = sameBytes(await adapter.readBinary(stagedPath), merged);
      } catch (error) {
        return await fail("stage-read-failed", error);
      }
      if (!stageMatches) return await fail("stage-content-mismatch");
    } else {
      try {
        await adapter.writeBinary(stagedPath, merged);
      } catch (error) {
        // A write may finish before the adapter reports an error; inspect the fixed stage before deciding.
        try {
          hasStage = await adapter.exists(stagedPath);
          if (hasStage) stageMatches = sameBytes(await adapter.readBinary(stagedPath), merged);
        } catch (checkError) {
          return await fail("stage-write-check-failed", checkError);
        }
        if (!stageMatches) return await fail("stage-write-failed", error);
      }
      if (!stageMatches) {
        try { stageMatches = sameBytes(await adapter.readBinary(stagedPath), merged); }
        catch (error) { return await fail("stage-read-failed", error); }
        if (!stageMatches) return await fail("stage-content-mismatch");
      }
      hasStage = true;
    }
    try {
      target = await availableAudioPath(adapter, port.audioFolder, formatRecoveryStamp(meta.startedAt), meta.ext);
    } catch (error) {
      return await fail("target-path-failed", error);
    }
    const pending: MasterPartialMeta = { ...meta, pendingRecoveryPath: target, pendingRecoveryBytes: total };
    try { await adapter.write(metaPath, JSON.stringify(pending)); } catch { /* Read back to detect writes that completed before throwing. */ }
    try {
      const persisted = parseMasterPartialMeta(await adapter.read(metaPath));
      if (persisted.sessionId !== sessionId || persisted.pendingRecoveryPath !== target || persisted.pendingRecoveryBytes !== total || persisted.recoveredPath) {
        return await fail("pending-meta-not-committed");
      }
      meta = persisted;
      hasPending = true;
    } catch (error) {
      return await fail("pending-meta-unverified", error);
    }
  }

  if (!hasPending) return await fail("pending-meta-not-committed");

  let targetExists: boolean;
  try { targetExists = await adapter.exists(target); }
  catch (error) { return await fail("target-check-failed", error); }
  try { hasStage = await adapter.exists(stagedPath); }
  catch (error) { return await fail("stage-check-failed", error); }

  let stageMatches = false;
  let targetMatches = false;
  if (hasStage) {
    try { stageMatches = sameBytes(await adapter.readBinary(stagedPath), merged); }
    catch (error) { return await fail("stage-read-failed", error); }
    if (!stageMatches) return await fail("stage-content-mismatch");
  }
  if (targetExists) {
    const targetCheck = await checkMasterPartialTarget(adapter, target, total, meta.flushedBytes);
    if (targetCheck.ok === false) return await fail(`pending-target-${targetCheck.reason}`, targetCheck.error);
    try { targetMatches = sameBytes(await adapter.readBinary(target), merged); }
    catch (error) { return await fail("pending-target-read-failed", error); }
    if (!targetMatches) return await fail("pending-target-content-mismatch");
  }

  if (!hasStage && !targetExists) return await fail("pending-publish-missing");
  if (hasStage && !targetExists) {
    try { await adapter.rename(stagedPath, target); } catch { /* Inspect both paths; rename can fail after taking effect. */ }
    try {
      hasStage = await adapter.exists(stagedPath);
      targetExists = await adapter.exists(target);
    } catch (error) {
      return await fail("publish-state-check-failed", error);
    }
    if (!targetExists) return await fail("publish-not-complete");
    const targetCheck = await checkMasterPartialTarget(adapter, target, total, meta.flushedBytes);
    if (targetCheck.ok === false) return await fail(`published-target-${targetCheck.reason}`, targetCheck.error);
    try { targetMatches = sameBytes(await adapter.readBinary(target), merged); }
    catch (error) { return await fail("published-target-read-failed", error); }
    if (!targetMatches) return await fail("published-target-content-mismatch");
    if (hasStage) {
      try { stageMatches = sameBytes(await adapter.readBinary(stagedPath), merged); }
      catch (error) { return await fail("stage-read-failed", error); }
      if (!stageMatches) return await fail("stage-content-mismatch");
      // A copy-then-throw adapter can leave both files. Finalize the verified target; directory cleanup removes the duplicate stage.
    }
  }

  let finalMetaConfirmed = false;
  const finalized: MasterPartialMeta = { ...meta, recoveredPath: target, recoveredBytes: total };
  delete finalized.pendingRecoveryPath;
  delete finalized.pendingRecoveryBytes;
  try { await adapter.write(metaPath, JSON.stringify(finalized)); } catch { /* Read back below; do not infer failure from the thrown call alone. */ }
  try {
    const persisted = parseMasterPartialMeta(await adapter.read(metaPath));
    finalMetaConfirmed = persisted.sessionId === sessionId
      && persisted.recoveredPath === target
      && persisted.recoveredBytes === total
      && persisted.pendingRecoveryPath === undefined
      && persisted.pendingRecoveryBytes === undefined;
  } catch (error) {
    return await fail("final-meta-unverified", error);
  }
  if (!finalMetaConfirmed) return await fail("final-meta-not-committed");

  const finalTargetCheck = await checkMasterPartialTarget(adapter, target, total, meta.flushedBytes);
  if (finalTargetCheck.ok === false) return await fail(`final-target-${finalTargetCheck.reason}`, finalTargetCheck.error);
  try {
    if (!sameBytes(await adapter.readBinary(target), merged)) return await fail("final-target-content-mismatch");
  } catch (error) {
    return await fail("final-target-read-failed", error);
  }

  let cleanupPending = false;
  try {
    await removePartialDirectory(adapter, dir);
  } catch (error) {
    try { cleanupPending = await adapter.exists(dir); }
    catch { cleanupPending = true; }
    if (cleanupPending) {
      await port.logDiagnostic("warn", "recording.recovery_cleanup_failed", t("The recovered recording was saved, but its partial files could not be removed"), {
        sessionId,
        error: diagnosticError(error),
      });
    }
  }
  await port.logDiagnostic("info", "recording.recovered", t("Interrupted recording was recovered from its partial files"), {
    sessionId,
    parts: parts.length,
    bytes: total,
  });
  return { sessionId, status: "recovered", path: target, bytes: total, parts: parts.length, cleanupPending };
}
