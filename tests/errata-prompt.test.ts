import { describe, expect, it } from "vitest";
import { buildErrataPrompt } from "../src/errata/errata-prompt";

describe("errata prompt", () => {
  it("renders only sections with content", () => {
    expect(buildErrataPrompt({
      replacements: [{ from: "朱子 FS", to: "JuiceFS" }], noise: [], notes: [], truncated: false,
    }).text).toContain("「朱子 FS」应写作「JuiceFS」");
    expect(buildErrataPrompt({ replacements: [], noise: [], notes: [], truncated: false }).text).toBe("");
  });

  it("limits prompt text to 3000 characters and reports used entries", () => {
    const result = buildErrataPrompt({
      replacements: [], noise: [], notes: Array.from({ length: 10 }, (_, index) => `${index}: ${"说明".repeat(400)}`), truncated: false,
    });
    expect(result.text.length).toBeLessThanOrEqual(3000);
    expect(result.truncated).toBe(true);
    expect(result.usedCount).toBeLessThan(10);
  });
});
