import { describe, expect, it } from "vitest";
import { elapsedSeconds, previewProgressView } from "../src/ui/topic-preview-progress";

describe("topic preview progress view", () => {
  it("is determinate only when several batches are planned", () => {
    expect(previewProgressView({ completed: 1, total: 3 })).toEqual({ determinate: true, completed: 1, total: 3, fraction: 1 / 3 });
  });

  it("is indeterminate for a single batch, so it shows no fake fraction", () => {
    expect(previewProgressView({ completed: 1, total: 1 })).toMatchObject({ determinate: false, fraction: 0 });
  });

  it("is indeterminate before the batch count is known", () => {
    expect(previewProgressView(null)).toEqual({ determinate: false, completed: 0, total: 0, fraction: 0 });
  });

  it("clamps out-of-range reports", () => {
    expect(previewProgressView({ completed: 9, total: 4 })).toMatchObject({ completed: 4, total: 4, fraction: 1 });
    expect(previewProgressView({ completed: -2, total: 4 })).toMatchObject({ completed: 0, fraction: 0 });
  });

  it("counts elapsed whole seconds and never goes negative", () => {
    expect(elapsedSeconds(1_000, 3_999)).toBe(2);
    expect(elapsedSeconds(5_000, 1_000)).toBe(0);
  });
});
