export type AudioImportStageId =
  | "prepare"
  | "transcribe"
  | "persist"
  | "organize"
  | "write";

export type ActivityStageStatus = "done" | "active" | "pending";

export type ActivityLiveness =
  | "pending"
  | "running"
  | "waiting"
  | "slow"
  | "stalled"
  | "retrying"
  | "failed"
  | "done";

export type ActivityRequestStatus =
  | "pending"
  | "requesting"
  | "streaming"
  | "retry-wait"
  | "failed"
  | "done";

export interface ActivityStage {
  id: AudioImportStageId;
  label: string;
  status: ActivityStageStatus;
}

export interface ActivityLifecycleEvent {
  id: string;
  at: number;
  stageId: AudioImportStageId;
  type: string;
  label: string;
  detail?: string;
  chunkIndex?: number;
  attempt?: number;
}

export interface ActivityRequestState {
  key: string;
  chunkIndex: number;
  chunkCount: number;
  status: ActivityRequestStatus;
  attempt: number;
  maxAttempts: number;
  startedAt: number;
  updatedAt: number;
  deadlineAt: number;
  retryAt: number;
  receivedChars: number;
  error: string;
}

const ACTIVITY_REQUEST_STATUSES = new Set<ActivityRequestStatus>([
  "pending",
  "requesting",
  "streaming",
  "retry-wait",
  "failed",
  "done",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeActivityRequestStatus(value: unknown): ActivityRequestStatus {
  return typeof value === "string" && ACTIVITY_REQUEST_STATUSES.has(value as ActivityRequestStatus)
    ? value as ActivityRequestStatus
    : "pending";
}

function isActivityStage(value: unknown): value is ActivityStage {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.label === "string"
    && (value.status === "done" || value.status === "active" || value.status === "pending");
}

const AUDIO_IMPORT_STAGE_DEFINITIONS: ReadonlyArray<{
  id: AudioImportStageId;
  label: string;
}> = [
  { id: "prepare", label: "准备音频" },
  { id: "transcribe", label: "语音转写" },
  { id: "persist", label: "写入原文" },
  { id: "organize", label: "AI 整理" },
  { id: "write", label: "写入纪要" },
];

export function normalizeAudioImportStage(value: unknown): AudioImportStageId {
  const phase = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (phase === "transcribing" || phase === "transcribe") return "transcribe";
  if (phase === "persisting" || phase === "persist" || phase === "write-transcript") return "persist";
  if (phase === "organizing" || phase === "organize" || phase === "ai") return "organize";
  if (phase === "writing" || phase === "write" || phase === "done") return "write";
  return "prepare";
}

export function audioImportStageFromWorkProgress(value: unknown): AudioImportStageId {
  const stage = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (stage === "write-note" || stage === "done") return "write";
  return "organize";
}

export function buildAudioImportStages(
  current: unknown,
  complete = false,
): ActivityStage[] {
  const activeId = normalizeAudioImportStage(current);
  const activeIndex = AUDIO_IMPORT_STAGE_DEFINITIONS.findIndex((item) => item.id === activeId);
  return AUDIO_IMPORT_STAGE_DEFINITIONS.map((item, index) => ({
    id: item.id,
    label: item.label,
    status: complete || index < activeIndex
      ? "done"
      : index === activeIndex
        ? "active"
        : "pending",
  }));
}

export function getActivityStagePosition(stages: unknown): {
  current: number;
  total: number;
  completed: number;
} {
  if (!Array.isArray(stages) || stages.length === 0) {
    return { current: 0, total: 0, completed: 0 };
  }
  const validStages = stages.filter(isActivityStage);
  const activeIndex = validStages.findIndex((item) => item.status === "active");
  const completed = validStages.filter((item) => item.status === "done").length;
  return {
    current: activeIndex >= 0 ? activeIndex + 1 : Math.min(validStages.length, completed),
    total: validStages.length,
    completed,
  };
}

function toFiniteTimestamp(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeStoredActivityRequest(value: unknown): ActivityRequestState | null {
  if (!isRecord(value) || typeof value.key !== "string" || !value.key.trim()) return null;
  return {
    key: value.key,
    chunkIndex: Math.max(0, Math.floor(Number(value.chunkIndex) || 0)),
    chunkCount: Math.max(0, Math.floor(Number(value.chunkCount) || 0)),
    status: normalizeActivityRequestStatus(value.status),
    attempt: Math.max(0, Math.floor(Number(value.attempt) || 0)),
    maxAttempts: Math.max(0, Math.floor(Number(value.maxAttempts) || 0)),
    startedAt: toFiniteTimestamp(value.startedAt),
    updatedAt: toFiniteTimestamp(value.updatedAt),
    deadlineAt: toFiniteTimestamp(value.deadlineAt),
    retryAt: toFiniteTimestamp(value.retryAt),
    receivedChars: Math.max(0, Math.floor(Number(value.receivedChars) || 0)),
    error: typeof value.error === "string" ? value.error : "",
  };
}

export function appendActivityEvent(
  events: unknown,
  event: Partial<ActivityLifecycleEvent>,
  limit = 80,
): ActivityLifecycleEvent[] {
  const at = toFiniteTimestamp(event.at) || Date.now();
  const chunkIndex = Number.isFinite(Number(event.chunkIndex))
    ? Math.max(0, Math.floor(Number(event.chunkIndex)))
    : undefined;
  const attempt = Number.isFinite(Number(event.attempt))
    ? Math.max(1, Math.floor(Number(event.attempt)))
    : undefined;
  const next: ActivityLifecycleEvent = {
    id: String(event.id || `${at}:${event.type || "event"}:${chunkIndex ?? ""}:${attempt ?? ""}`),
    at,
    stageId: normalizeAudioImportStage(event.stageId),
    type: String(event.type || "event"),
    label: String(event.label || "任务状态已更新"),
    detail: String(event.detail || ""),
    chunkIndex,
    attempt,
  };
  const list = Array.isArray(events)
    ? events.filter((item): item is ActivityLifecycleEvent => !!item && typeof item === "object")
    : [];
  const previous = list[list.length - 1];
  if (previous
    && previous.stageId === next.stageId
    && previous.type === next.type
    && previous.label === next.label
    && String(previous.detail || "") === String(next.detail || "")
    && previous.chunkIndex === next.chunkIndex
    && previous.attempt === next.attempt) {
    const replaced = list.slice();
    replaced[replaced.length - 1] = next;
    return replaced.slice(Math.max(0, replaced.length - Math.max(1, Math.floor(limit))));
  }
  const bounded = list.concat(next);
  return bounded.slice(Math.max(0, bounded.length - Math.max(1, Math.floor(limit))));
}

export function upsertActivityRequest(
  requests: unknown,
  patch: Partial<ActivityRequestState> & { key: string },
  limit = 200,
): ActivityRequestState[] {
  const list = Array.isArray(requests)
    ? requests.map(normalizeStoredActivityRequest).filter((item): item is ActivityRequestState => item !== null)
    : [];
  const now = toFiniteTimestamp(patch.updatedAt) || Date.now();
  const index = list.findIndex((item) => item.key === patch.key);
  const previous = index >= 0 ? list[index] : null;
  const attemptChanged = !!previous
    && patch.attempt !== undefined
    && Math.max(0, Math.floor(Number(patch.attempt) || 0)) !== previous.attempt;
  const next: ActivityRequestState = {
    key: patch.key,
    chunkIndex: Math.max(0, Math.floor(Number(patch.chunkIndex ?? previous?.chunkIndex) || 0)),
    chunkCount: Math.max(0, Math.floor(Number(patch.chunkCount ?? previous?.chunkCount) || 0)),
    status: normalizeActivityRequestStatus(patch.status ?? previous?.status),
    attempt: Math.max(0, Math.floor(Number(patch.attempt ?? previous?.attempt) || 0)),
    maxAttempts: Math.max(0, Math.floor(Number(patch.maxAttempts ?? previous?.maxAttempts) || 0)),
    startedAt: toFiniteTimestamp(patch.startedAt)
      || (attemptChanged ? now : toFiniteTimestamp(previous?.startedAt))
      || now,
    updatedAt: now,
    deadlineAt: patch.deadlineAt === 0
      ? 0
      : toFiniteTimestamp(patch.deadlineAt) || toFiniteTimestamp(previous?.deadlineAt),
    retryAt: patch.retryAt === 0
      ? 0
      : toFiniteTimestamp(patch.retryAt) || toFiniteTimestamp(previous?.retryAt),
    receivedChars: Math.max(0, Math.floor(Number(patch.receivedChars ?? previous?.receivedChars) || 0)),
    error: String(patch.error ?? previous?.error ?? ""),
  };
  const result = list.slice();
  if (index >= 0) result[index] = next;
  else result.push(next);
  return result.slice(Math.max(0, result.length - Math.max(1, Math.floor(limit))));
}

export function classifyActivityRequest(
  request: Partial<ActivityRequestState> | null | undefined,
  now = Date.now(),
): ActivityLiveness {
  if (!request) return "pending";
  if (request.status === "done") return "done";
  if (request.status === "failed") return "failed";
  if (request.status === "pending") return "pending";
  if (request.status === "retry-wait") {
    return toFiniteTimestamp(request.retryAt) > now ? "retrying" : "waiting";
  }

  const deadlineAt = toFiniteTimestamp(request.deadlineAt);
  if (deadlineAt > 0 && now > deadlineAt) return "stalled";

  const startedAt = toFiniteTimestamp(request.startedAt);
  const updatedAt = toFiniteTimestamp(request.updatedAt) || startedAt;
  const requestAge = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
  const quietAge = updatedAt > 0 ? Math.max(0, now - updatedAt) : 0;
  const expectedWindow = deadlineAt > startedAt ? deadlineAt - startedAt : 0;
  const slowAfter = expectedWindow > 0
    ? Math.max(20_000, Math.min(90_000, expectedWindow * 0.6))
    : 45_000;

  if (requestAge >= slowAfter || quietAge >= 30_000) return "slow";
  if (requestAge >= 3_000 || quietAge >= 3_000) return "waiting";
  return "running";
}

export function summarizeActivityRequests(
  requests: unknown,
  now = Date.now(),
): Record<ActivityLiveness, number> {
  const summary: Record<ActivityLiveness, number> = {
    pending: 0,
    running: 0,
    waiting: 0,
    slow: 0,
    stalled: 0,
    retrying: 0,
    failed: 0,
    done: 0,
  };
  if (!Array.isArray(requests)) return summary;
  for (const rawRequest of requests) {
    const request = normalizeStoredActivityRequest(rawRequest);
    if (!request) continue;
    summary[classifyActivityRequest(request, now)] += 1;
  }
  return summary;
}

export function getDominantActivityLiveness(
  summary: Partial<Record<ActivityLiveness, number>> | null | undefined,
): ActivityLiveness {
  const order: ActivityLiveness[] = [
    "stalled",
    "slow",
    "retrying",
    "waiting",
    "running",
    "failed",
    "pending",
    "done",
  ];
  for (const state of order) {
    if (Number(summary && summary[state]) > 0) return state;
  }
  return "pending";
}
