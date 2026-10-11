import type { TopicPreviewProgress } from "../topics/topics-service";

/**
 * What the "generating preview" view shows for a progress report.
 *
 * The bar is determinate only when the batch count is known and above one.
 * Otherwise it is an indeterminate animation: a single batch or an unknown
 * total does not give a real fraction, so no percentage is shown.
 */
export interface TopicPreviewProgressView {
  determinate: boolean;
  /** Batches finished, clamped to the total. */
  completed: number;
  /** Batches planned; 0 when unknown. */
  total: number;
  /** Bar fill between 0 and 1; meaningful only when determinate. */
  fraction: number;
}

export function previewProgressView(progress: TopicPreviewProgress | null): TopicPreviewProgressView {
  const total = Math.max(0, Math.floor(progress?.total ?? 0));
  const completed = Math.min(total, Math.max(0, Math.floor(progress?.completed ?? 0)));
  const determinate = total > 1;
  return { determinate, completed, total, fraction: determinate ? completed / total : 0 };
}

/** Whole seconds since the generation started; never negative. */
export function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}
