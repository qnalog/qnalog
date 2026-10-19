import { describe, expect, it } from "vitest";
import { missingSafeAreaTop } from "../src/ui/safe-area";

describe("missingSafeAreaTop", () => {
  it("adds the full inset when the content starts at the top of the screen (status bar overlap)", () => {
    expect(missingSafeAreaTop(59, 0)).toBe(59);
  });
  it("adds only the uncovered part when the host already offsets the view", () => {
    expect(missingSafeAreaTop(59, 20)).toBe(39);
  });
  it("adds nothing when the title bar already clears the status bar", () => {
    expect(missingSafeAreaTop(59, 100)).toBe(0);
  });
  it("adds nothing without a safe area (desktop, Android) or on invalid input", () => {
    expect(missingSafeAreaTop(0, 0)).toBe(0);
    expect(missingSafeAreaTop(Number.NaN, 0)).toBe(0);
    expect(missingSafeAreaTop(59, Number.NaN)).toBe(59);
  });
});
