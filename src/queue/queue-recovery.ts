import type {
  ContinuationContext, QueueRecoveryEntrySummary, QueueTask, QueueTaskLifecycle, QueueTaskStatus, Segment,
} from "../shared/types";
import { getAsrTransportTaskRecoveryPatch } from "../shared/util-audio";
import { isLlmNonRetryableError } from "../llm/failure-policy";
import { t } from "../shared/i18n";
import { isTranscriptSegmentRecord } from "../transcript/transcript-markdown";

export interface QueueRecoveryResult {
  tasks: QueueTask[];
  retained: Array<{ raw: unknown; summary: QueueRecoveryEntrySummary }>;
  order: Array<{ kind: "task"; id: string } | { kind: "retained"; entryIndex: number }>;
}
export interface RestoreQueueOptions { createId(): string; nowIso(): string; getMaxRetries(): number }
type Row = Record<string, unknown>;
const isRecord = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown): value is number => finite(value) && Number.isInteger(value) && value >= 0;
const optional = (r: Row, k: string, pred: (v: unknown) => boolean): boolean => r[k] === undefined || pred(r[k]);

function segmentValid(value: unknown): value is Segment {
  if (!isRecord(value)) return false;
  const strings = ["audioName", "audioPath", "segmentAudioName", "segmentAudioPath", "source", "sourceName", "sourcePath", "sourceUrl", "sourceTitle", "sourcePlatform", "rawText", "queueTaskId"];
  return integer(value.index) && finite(value.startOffsetMs) && finite(value.endOffsetMs) && typeof value.text === "string"
    && strings.every((k) => optional(value, k, (v) => typeof v === "string"))
    && ["audioStartOffsetMs", "audioEndOffsetMs", "audioChannelCount"].every((k) => optional(value, k, finite))
    && optional(value, "speakerIds", (v) => Array.isArray(v) && v.every((x) => typeof x === "string"))
    && optional(value, "error", (v) => v === null || typeof v === "string")
    && optional(value, "isFinal", (v) => typeof v === "boolean")
    && optional(value, "transcript", isTranscriptSegmentRecord);
}
function coverageValid(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return v.version === 1 && typeof v.outlineHash === "string" && typeof v.sourceHash === "string"
    && integer(v.committedSegmentCount) && integer(v.totalSegmentCount);
}
function cleanContinuation(value: unknown): ContinuationContext {
  if (!isRecord(value)) throw new Error("Validated continuation is not a record");
  const c: Row = { ...value };
  if (c.realtimeOutline !== undefined && typeof c.realtimeOutline !== "string") delete c.realtimeOutline;
  if (c.priorOutlineHash !== undefined && typeof c.priorOutlineHash !== "string") delete c.priorOutlineHash;
  if (c.realtimeOutlineSegmentCount !== undefined && !integer(c.realtimeOutlineSegmentCount)) delete c.realtimeOutlineSegmentCount;
  if (c.realtimeOutlineSourceCoverage !== undefined && !coverageValid(c.realtimeOutlineSourceCoverage)) delete c.realtimeOutlineSourceCoverage;
  if (!nonempty(c.targetPath) || !nonempty(c.targetSourceId) || typeof c.recordedAt !== "string") throw new Error("Validated continuation fields changed");
  return { ...c, targetPath: c.targetPath, targetSourceId: c.targetSourceId, recordedAt: c.recordedAt };
}
function lifecycleIssue(r: Row): string | undefined {
  for (const k of ["id", "createdAt", "updatedAt", "status", "lastError", "startedAt", "lastEventAt", "nextRetryAt", "attempt", "transportFailures", "retries", "dependsOnSessionIds"]) {
    const v = r[k];
    if (v === undefined) continue;
    if (v === null) {
      if (["id", "createdAt", "updatedAt", "retries", "status"].includes(k)) continue;
      return k;
    }
    if ((["id", "createdAt", "updatedAt", "retries", "status"].includes(k) && v === "")) continue;
    if (["id", "createdAt", "updatedAt", "lastError", "startedAt", "lastEventAt", "nextRetryAt"].includes(k) && typeof v !== "string") return k;
    if (["attempt", "transportFailures"].includes(k) && !finite(v)) return k;
    if (k === "retries") {
      if (typeof v !== "number" && typeof v !== "string") return k;
      if (!Number.isFinite(Math.max(0, Number(v) || 0))) return k;
    }
    if (k === "dependsOnSessionIds" && (!Array.isArray(v) || !v.every((x) => nonempty(x)))) return k;
    if (k === "status" && typeof v !== "string") return k;
  }
  return undefined;
}

function isLifecycle(r: Row): r is Row & QueueTaskLifecycle {
  return typeof r.id === "string" && typeof r.createdAt === "string" && typeof r.updatedAt === "string"
    && typeof r.status === "string" && typeof r.retries === "number";
}
function isRestoredTask(r: Row): r is Row & QueueTask {
  if (!isLifecycle(r)) return false;
  if (r.type === "transcribe") return payloadIssue(r, "transcribe") === undefined;
  if (r.type === "merge") return payloadIssue(r, "merge") === undefined && validateContinuation(r) === undefined;
  if (r.type === "generate-prompt") return payloadIssue(r, "generate-prompt") === undefined;
  return false;
}

function payloadIssue(r: Row, type: string): string | undefined {
  if (type === "transcribe") {
    for (const k of ["sessionId", "mdPath", "audioPath"]) if (!nonempty(r[k])) return k;
    if (!integer(r.segmentIndex)) return "segmentIndex";
    for (const k of ["audioName", "sourceAudioPath", "sourceAudioName", "masterAudioPath", "masterAudioName", "temporarySourcePath", "mode", "deferredReason", "source", "sourceUrl", "sourceTitle", "sourcePlatform", "captureMode", "providerId"]) if (!optional(r, k, (v) => typeof v === "string")) return k;
    for (const k of ["startOffsetMs", "endOffsetMs", "audioStartOffsetMs", "audioEndOffsetMs", "audioChannelCount", "speakerCount"]) if (!optional(r, k, finite)) return k;
    for (const k of ["isFinal", "liveSegment", "wholeFileImport", "ephemeralAudio", "speakerDiarization"]) if (!optional(r, k, (v) => typeof v === "boolean")) return k;
    if (!optional(r, "audioChannelMode", (v) => v === "auto" || v === "mono" || v === "multichannel")) return "audioChannelMode";
    if (!optional(r, "audioChannelRuntimeMode", (v) => v === "mono" || v === "probing" || v === "multichannel")) return "audioChannelRuntimeMode";
  } else if (type === "generate-prompt") {
    if (!nonempty(r.mode)) return "mode";
    if (!optional(r, "activate", (v) => typeof v === "boolean")) return "activate";
    if (!optional(r, "mdPath", (v) => typeof v === "string")) return "mdPath";
  } else {
    if (!nonempty(r.sessionId)) return "sessionId";
    if (!nonempty(r.mdPath)) return "mdPath";
    if (!nonempty(r.mode)) return "mode";
    if (!Array.isArray(r.segments)) return "segments";
    if (r.segments.length === 0 && r.continuation === undefined) return "segments";
    for (let i = 0; i < r.segments.length; i++) if (!segmentValid(r.segments[i])) return `segments.${i}`;
    for (const k of ["source", "temporarySourcePath"]) if (!optional(r, k, (v) => typeof v === "string")) return k;
    if (!optional(r, "textImportSources", (v) => Array.isArray(v))) return "textImportSources";
    if (!optional(r, "speakerFrontmatter", (v) => v === null || isRecord(v))) return "speakerFrontmatter";
    if (!optional(r, "continuation", isRecord)) return "continuation";
    if (!optional(r, "continuationDisposition", (v) => v === "discard")) return "continuationDisposition";
  }
  return undefined;
}
function summaryFor(raw: unknown, entryIndex: number, issue: QueueRecoveryEntrySummary["issue"], field?: string): QueueRecoveryEntrySummary {
  const r = isRecord(raw) ? raw : {};
  const c = isRecord(r.continuation) ? r.continuation : {};
  const audioPaths = new Set<string>();
  const add = (v: unknown) => { if (nonempty(v)) audioPaths.add(v); };
  add(r.audioPath); add(r.segmentAudioPath); add(r.sourceAudioPath); add(r.masterAudioPath);
  if (Array.isArray(r.segments)) for (const s of r.segments) if (isRecord(s)) {
    add(s.audioPath); add(s.segmentAudioPath); add(s.sourceAudioPath); add(s.masterAudioPath);
    const tr = isRecord(s.transcript) ? s.transcript : {};
    if (Array.isArray(tr.revisions)) for (const rev of tr.revisions) if (isRecord(rev) && Array.isArray(rev.utterances)) for (const u of rev.utterances) if (isRecord(u) && isRecord(u.audioRef)) add(u.audioRef.path);
  }
  add(c.masterAudioPath);
  return {
    entryIndex,
    issue,
    ...(field !== undefined ? { field } : {}),
    ...(nonempty(r.id) ? { storedId: r.id } : {}),
    ...(r.type === "transcribe" || r.type === "merge" || r.type === "generate-prompt" ? { taskType: r.type } : {}),
    ...(nonempty(r.sessionId) ? { sessionId: r.sessionId } : {}),
    ...(nonempty(r.mdPath) ? { mdPath: r.mdPath } : {}),
    ...(nonempty(r.temporarySourcePath) ? { temporarySourcePath: r.temporarySourcePath } : {}),
    ...(nonempty(c.targetPath) ? { targetPath: c.targetPath } : {}),
    audioPaths: [...audioPaths],
  };
}
function isQueueTaskStatus(value: unknown): value is QueueTaskStatus {
  return value === "pending" || value === "running" || value === "processing" || value === "live"
    || value === "failed" || value === "missing" || value === "blocked";
}
function normalizeLifecycle(r: Row, id: string, nowIso: () => string): Row {
  const createdAt = r.createdAt === undefined || r.createdAt === null || r.createdAt === "" ? nowIso() : r.createdAt;
  const rawRetries = r.retries === undefined || r.retries === null || r.retries === "" ? 0 : r.retries;
  const status = isQueueTaskStatus(r.status) ? r.status : "pending";
  return { ...r, id, retries: Math.max(0, Number(rawRetries) || 0), createdAt,
    updatedAt: r.updatedAt === undefined || r.updatedAt === null || r.updatedAt === "" ? createdAt : r.updatedAt, status };
}
function validateContinuation(r: Row): "invalid-continuation" | "invalid-disposition" | undefined {
  if (r.continuationDisposition !== undefined && (r.continuationDisposition !== "discard" || !isRecord(r.continuation))) return "invalid-disposition";
  if (r.continuation !== undefined) {
    const c = r.continuation;
    if (!isRecord(c) || !nonempty(c.targetPath) || !nonempty(c.targetSourceId) || typeof c.recordedAt !== "string" || !Number.isFinite(Date.parse(c.recordedAt))
      || !optional(c, "masterAudioPath", (v) => typeof v === "string") || !optional(c, "masterAudioName", (v) => typeof v === "string")) return "invalid-continuation";
  }
  return undefined;
}

export function restoreQueue(saved: unknown, options: RestoreQueueOptions): QueueRecoveryResult {
  const rows: unknown[] = Array.isArray(saved) ? saved : [];
  const idCounts = new Map<string, number>();
  for (const raw of rows) if (isRecord(raw) && nonempty(raw.id)) idCounts.set(raw.id, (idCounts.get(raw.id) ?? 0) + 1);
  const usedIds = new Set(idCounts.keys());
  const result: QueueRecoveryResult = { tasks: [], retained: [], order: [] };
  const retain = (raw: unknown, index: number, issue: QueueRecoveryEntrySummary["issue"], field?: string) => {
    result.retained.push({ raw, summary: summaryFor(raw, index, issue, field) }); result.order.push({ kind: "retained", entryIndex: index });
  };
  rows.forEach((raw, index) => {
    const r = isRecord(raw) ? raw : undefined;
    if (r && nonempty(r.id) && (idCounts.get(r.id) ?? 0) > 1) { retain(raw, index, "duplicate-id"); return; }
    if (!r || r.type === undefined || r.type === null || r.type === "") { retain(raw, index, "invalid-entry"); return; }
    if (r.type !== "transcribe" && r.type !== "merge" && r.type !== "generate-prompt") { retain(raw, index, "unsupported-type"); return; }
    const continuationIssue = r.type === "merge" ? validateContinuation(r) : undefined;
    if (continuationIssue) { retain(raw, index, continuationIssue); return; }
    const life = lifecycleIssue(r);
    if (life) { retain(raw, index, "invalid-field", life); return; }
    const issue = payloadIssue(r, r.type);
    if (issue) { retain(raw, index, "invalid-field", issue); return; }
    let id: string;
    if (r.id === undefined || r.id === null || r.id === "") { do { id = options.createId(); } while (usedIds.has(id)); usedIds.add(id); }
    else if (nonempty(r.id)) id = r.id;
    else { retain(raw, index, "invalid-field", "id"); return; }
    const task = normalizeLifecycle(r, id, () => options.nowIso());
    if (task.status === "running" || task.status === "processing" || task.status === "live") { task.status = "pending"; task.lastError = task.lastError || t("Interrupted during the last run; restored to pending"); }
    if (!isRestoredTask(task)) { retain(raw, index, "invalid-field", "payload"); return; }
    if (task.type === "merge" && task.continuation !== undefined) task.continuation = cleanContinuation(task.continuation);
    const maxRetries = options.getMaxRetries() || 3;
    if (task.type === "transcribe" && task.status === "failed" && task.retries >= maxRetries && /音频不存在|Audio missing/.test(String(task.lastError || ""))) {
      task.status = "pending"; task.retries = Math.max(0, maxRetries - 1); task.lastError = t("Temporary clip missing; upgraded to recover the clip from the full recording and retry");
    }
    const transport = getAsrTransportTaskRecoveryPatch(task, maxRetries);
    if (transport) Object.assign(task, transport);
    if (task.type === "merge" && task.status === "failed" && isLlmNonRetryableError(task.lastError || "")) { task.status = "blocked"; task.lastError = task.lastError || t("LLM unavailable; waiting for you to resolve it before retrying"); }
    if (task.type === "merge" && task.status === "failed" && task.retries >= maxRetries && !isLlmNonRetryableError(task.lastError || "") && /Failed to fetch|LLM 调用超时|LLM request timed out|429|500|502|503|504/.test(String(task.lastError || ""))) {
      task.status = "pending"; task.retries = Math.max(0, maxRetries - 1); task.lastError = t("The last organizing attempt looks like a transient network or server failure; upgraded to retryable");
    }
    result.tasks.push(task);
    result.order.push({ kind: "task", id });
  });
  return result;
}
