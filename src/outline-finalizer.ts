export type OutlineDrainStopReason =
  | "complete"
  | "batch-failed"
  | "no-progress"
  | "max-batches";

export interface OutlineDrainAttempt {
  batchIndex: number;
  attemptIndex: number;
  beforeCommittedCount: number;
}

export interface OutlineDrainFailure extends OutlineDrainAttempt {
  error: unknown;
}

export interface OutlineDrainResult {
  complete: boolean;
  reason: OutlineDrainStopReason;
  totalSegmentCount: number;
  committedSegmentCount: number;
  completedBatches: number;
  attemptCount: number;
  retryCount: number;
  lastError: unknown;
}

interface DrainRealtimeOutlineBacklogOptions {
  totalSegmentCount: number;
  getCommittedCount: () => number;
  isComplete: () => boolean;
  runBatch: (attempt: OutlineDrainAttempt) => Promise<void>;
  maxAttemptsPerBatch?: number;
  maxBatches?: number;
  shouldRetryAttempt?: (failure: OutlineDrainFailure) => boolean;
  onAttemptFailed?: (failure: OutlineDrainFailure) => void | Promise<void>;
  onBatchCompleted?: (result: OutlineDrainResult) => void | Promise<void>;
}

function clampCommittedCount(value: number, total: number): number {
  const numeric = Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.min(total, Math.max(0, numeric));
}

function isAbortError(error: unknown): boolean {
  return !!error
    && typeof error === "object"
    && "name" in error
    && typeof error.name === "string"
    && error.name === "AbortError";
}

export async function drainRealtimeOutlineBacklog(
  options: DrainRealtimeOutlineBacklogOptions
): Promise<OutlineDrainResult> {
  const totalSegmentCount = Math.max(0, Math.floor(Number(options.totalSegmentCount) || 0));
  const initialCommittedCount = clampCommittedCount(options.getCommittedCount(), totalSegmentCount);
  const remainingSegmentCount = Math.max(0, totalSegmentCount - initialCommittedCount);
  const maxAttemptsPerBatch = Math.max(1, Math.floor(Number(options.maxAttemptsPerBatch) || 2));
  // A successful batch must advance by at least one source segment. Using the
  // remaining count as the safety ceiling supports long imports without an
  // arbitrary eight-batch cutoff while still making infinite loops impossible.
  const maxBatches = Math.max(1, Math.floor(Number(options.maxBatches) || Math.min(16, remainingSegmentCount + 1)));

  let completedBatches = 0;
  let attemptCount = 0;
  let retryCount = 0;
  let lastError: unknown = null;

  const makeResult = (reason: OutlineDrainStopReason): OutlineDrainResult => ({
    complete: reason === "complete",
    reason,
    totalSegmentCount,
    committedSegmentCount: clampCommittedCount(options.getCommittedCount(), totalSegmentCount),
    completedBatches,
    attemptCount,
    retryCount,
    lastError,
  });

  if (options.isComplete()) return makeResult("complete");

  while (!options.isComplete() && completedBatches < maxBatches) {
    const beforeCommittedCount = clampCommittedCount(options.getCommittedCount(), totalSegmentCount);
    let advanced = false;
    let resolvedWithoutProgress = false;

    for (let attemptIndex = 0; attemptIndex < maxAttemptsPerBatch; attemptIndex++) {
      if (attemptIndex > 0) retryCount += 1;
      attemptCount += 1;
      try {
        await options.runBatch({
          batchIndex: completedBatches,
          attemptIndex,
          beforeCommittedCount,
        });
        const afterCommittedCount = clampCommittedCount(options.getCommittedCount(), totalSegmentCount);
        advanced = afterCommittedCount > beforeCommittedCount || options.isComplete();
        resolvedWithoutProgress = !advanced;
        if (advanced) break;
        lastError = new Error("实时大纲批次未推进已提交游标");
        break;
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastError = error;
        const failure: OutlineDrainFailure = {
          batchIndex: completedBatches,
          attemptIndex,
          beforeCommittedCount,
          error,
        };
        await options.onAttemptFailed?.(failure);
        if (attemptIndex + 1 < maxAttemptsPerBatch && options.shouldRetryAttempt && !options.shouldRetryAttempt(failure)) {
          break;
        }
      }
    }

    if (!advanced) {
      return makeResult(resolvedWithoutProgress ? "no-progress" : "batch-failed");
    }

    completedBatches += 1;
    await options.onBatchCompleted?.(makeResult(options.isComplete() ? "complete" : "max-batches"));
  }

  return makeResult(options.isComplete() ? "complete" : "max-batches");
}
