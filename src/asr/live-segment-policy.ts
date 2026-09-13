export const LIVE_ASR_BACKLOG_WARN_MS = 10 * 60 * 1000;
export const LIVE_ASR_BACKLOG_CRITICAL_MS = 30 * 60 * 1000;
export const LIVE_ASR_CIRCUIT_FAILURE_THRESHOLD = 3;
export const LIVE_ASR_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
export const LIVE_ASR_CIRCUIT_MAX_COOLDOWN_MS = 30 * 60 * 1000;
export const LIVE_ASR_TASK_STATUS = "live";

export type LiveAsrJobState = "spooling" | "queued" | "transcribing";

export type LiveAsrJob = {
  id: string;
  queuedAtMs: number;
  sizeBytes: number;
  durationMs: number;
  state: LiveAsrJobState;
};

export type LiveAsrBacklogSummary = {
  count: number;
  totalBytes: number;
  totalDurationMs: number;
  oldestAgeMs: number;
  spoolingCount: number;
  queuedCount: number;
  transcribingCount: number;
};

export type LiveAsrCircuitState = {
  consecutiveFailures: number;
  openUntilMs: number;
  lastError: string;
};

export function summarizeLiveAsrJobs(jobs: Iterable<LiveAsrJob>, nowMs = Date.now()): LiveAsrBacklogSummary {
  const summary: LiveAsrBacklogSummary = {
    count: 0,
    totalBytes: 0,
    totalDurationMs: 0,
    oldestAgeMs: 0,
    spoolingCount: 0,
    queuedCount: 0,
    transcribingCount: 0,
  };
  let oldestQueuedAt = Number.POSITIVE_INFINITY;
  for (const job of jobs || []) {
    if (!job) continue;
    summary.count++;
    summary.totalBytes += Math.max(0, Number(job.sizeBytes) || 0);
    summary.totalDurationMs += Math.max(0, Number(job.durationMs) || 0);
    oldestQueuedAt = Math.min(oldestQueuedAt, Math.max(0, Number(job.queuedAtMs) || nowMs));
    if (job.state === "spooling") summary.spoolingCount++;
    else if (job.state === "transcribing") summary.transcribingCount++;
    else summary.queuedCount++;
  }
  if (Number.isFinite(oldestQueuedAt)) summary.oldestAgeMs = Math.max(0, nowMs - oldestQueuedAt);
  return summary;
}

export function classifyLiveAsrBacklog(summary: LiveAsrBacklogSummary): "normal" | "warning" | "critical" {
  const durationMs = Math.max(0, Number(summary && summary.totalDurationMs) || 0);
  if (durationMs >= LIVE_ASR_BACKLOG_CRITICAL_MS) return "critical";
  if (durationMs >= LIVE_ASR_BACKLOG_WARN_MS) return "warning";
  return "normal";
}

export function createLiveAsrCircuitState(): LiveAsrCircuitState {
  return { consecutiveFailures: 0, openUntilMs: 0, lastError: "" };
}

export function recordLiveAsrSuccess(): LiveAsrCircuitState {
  return createLiveAsrCircuitState();
}

export function getLiveAsrCircuitCooldownMs(consecutiveFailures: number): number {
  const failures = Math.max(0, Math.floor(Number(consecutiveFailures) || 0));
  if (failures < LIVE_ASR_CIRCUIT_FAILURE_THRESHOLD) return 0;
  const exponent = Math.max(0, failures - LIVE_ASR_CIRCUIT_FAILURE_THRESHOLD);
  return Math.min(LIVE_ASR_CIRCUIT_MAX_COOLDOWN_MS, LIVE_ASR_CIRCUIT_COOLDOWN_MS * (2 ** exponent));
}

export function recordLiveAsrFailure(
  current: LiveAsrCircuitState,
  errorMessage: string,
  transient: boolean,
  nowMs = Date.now(),
): LiveAsrCircuitState {
  if (!transient) return current || createLiveAsrCircuitState();
  const nextFailures = Math.max(0, Number(current && current.consecutiveFailures) || 0) + 1;
  const cooldownMs = getLiveAsrCircuitCooldownMs(nextFailures);
  return {
    consecutiveFailures: nextFailures,
    openUntilMs: cooldownMs > 0
      ? Math.max(Math.max(0, Number(current && current.openUntilMs) || 0), nowMs + cooldownMs)
      : 0,
    lastError: String(errorMessage || "").slice(0, 240),
  };
}

export function isLiveAsrCircuitOpen(state: LiveAsrCircuitState, nowMs = Date.now()): boolean {
  return Math.max(0, Number(state && state.openUntilMs) || 0) > nowMs;
}
