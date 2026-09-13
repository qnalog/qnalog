import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ setIcon: vi.fn() }));
vi.mock("../src/recruit", () => ({
  isRecruitFeatureUnlocked: (settings: { recruitFeatureUnlocked?: boolean } | null | undefined) =>
    Boolean(settings?.recruitFeatureUnlocked),
}));

import {
  getBuiltInVisiblePolishModeKeys,
  isKnownPolishMode,
} from "../src/shared/mode-meta";

describe("HR advanced feature gate", () => {
  it("hides recruitment and promotion review before the five-tap unlock", () => {
    const settings = { recruitFeatureUnlocked: false };
    const visible = getBuiltInVisiblePolishModeKeys(settings);

    expect(visible).not.toContain("recruit");
    expect(visible).not.toContain("recruit-needs");
    expect(visible).not.toContain("promotion-review");
    expect(isKnownPolishMode(settings, "promotion-review")).toBe(false);
  });

  it("reveals the complete HR evaluation bundle after unlock", () => {
    const settings = { recruitFeatureUnlocked: true };
    const visible = getBuiltInVisiblePolishModeKeys(settings);

    expect(visible).toContain("recruit");
    expect(visible).toContain("recruit-needs");
    expect(visible).toContain("promotion-review");
    expect(isKnownPolishMode(settings, "promotion-review")).toBe(true);
  });
});
