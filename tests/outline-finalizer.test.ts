import { describe, expect, it, vi } from "vitest";
import { drainRealtimeOutlineBacklog } from "../src/outline-finalizer";

describe("drainRealtimeOutlineBacklog", () => {
  it("retries only the malformed batch and then drains all segments", async () => {
    let committed = 8;
    let failedOnce = false;
    const runBatch = vi.fn(async ({ beforeCommittedCount, attemptIndex }) => {
      if (beforeCommittedCount === 14 && attemptIndex === 0 && !failedOnce) {
        failedOnce = true;
        throw new Error("实时大纲输出格式不合格：no_top_level_bullets");
      }
      committed = Math.min(34, beforeCommittedCount + 6);
    });

    const result = await drainRealtimeOutlineBacklog({
      totalSegmentCount: 34,
      getCommittedCount: () => committed,
      isComplete: () => committed >= 34,
      maxAttemptsPerBatch: 2,
      maxBatches: 8,
      shouldRetryAttempt: ({ error }) => String((error as Error).message).includes("输出格式不合格"),
      runBatch,
    });

    expect(result.complete).toBe(true);
    expect(result.committedSegmentCount).toBe(34);
    expect(result.retryCount).toBe(1);
    expect(runBatch).toHaveBeenCalledTimes(6);
  });

  it("does not add an outer retry for a transport failure", async () => {
    const committed = 8;
    const runBatch = vi.fn(async () => {
      throw new Error("network timeout");
    });

    const result = await drainRealtimeOutlineBacklog({
      totalSegmentCount: 34,
      getCommittedCount: () => committed,
      isComplete: () => committed >= 34,
      maxAttemptsPerBatch: 2,
      maxBatches: 8,
      shouldRetryAttempt: ({ error }) => String((error as Error).message).includes("输出格式不合格"),
      runBatch,
    });

    expect(result.complete).toBe(false);
    expect(result.reason).toBe("batch-failed");
    expect(result.committedSegmentCount).toBe(8);
    expect(result.retryCount).toBe(0);
    expect(runBatch).toHaveBeenCalledTimes(1);
  });

  it("stops if a resolved batch does not advance the cursor", async () => {
    const committed = 8;
    const runBatch = vi.fn(async () => undefined);

    const result = await drainRealtimeOutlineBacklog({
      totalSegmentCount: 34,
      getCommittedCount: () => committed,
      isComplete: () => committed >= 34,
      maxAttemptsPerBatch: 2,
      maxBatches: 8,
      runBatch,
    });

    expect(result.complete).toBe(false);
    expect(result.reason).toBe("no-progress");
    expect(result.committedSegmentCount).toBe(8);
    expect(runBatch).toHaveBeenCalledTimes(1);
  });
});
