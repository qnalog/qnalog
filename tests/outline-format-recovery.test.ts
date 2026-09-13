import { describe, expect, it } from "vitest";
import {
  normalizeRealtimeOutlineList,
  validateRealtimeOutlineMarkdown,
} from "../src/outline-text";

describe("normalizeRealtimeOutlineList - common model list syntax", () => {
  it("normalizes headings, numbered lists, and Unicode bullets", () => {
    const heading = normalizeRealtimeOutlineList("### Data foundation\n### Team alignment");
    const numbered = normalizeRealtimeOutlineList("1. Data foundation\n2、Team alignment");
    const unicodeBullets = normalizeRealtimeOutlineList("• Data foundation\n▪ Team alignment");

    expect(heading).toBe("- Data foundation\n- Team alignment");
    expect(numbered).toBe("- Data foundation\n- Team alignment");
    expect(unicodeBullets).toBe("- Data foundation\n- Team alignment");
    expect(validateRealtimeOutlineMarkdown(heading, { allowUntimedTopLevel: true }).ok).toBe(true);
    expect(validateRealtimeOutlineMarkdown(numbered, { allowUntimedTopLevel: true }).ok).toBe(true);
    expect(validateRealtimeOutlineMarkdown(unicodeBullets, { allowUntimedTopLevel: true }).ok).toBe(true);
  });
});
