import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Literal px font sizes ignore the user's Obsidian font-size setting. Text sizes use
// --font-ui-* variables (or the plugin's --qnalog-font-ui-smallest); a px value is allowed only for
// rules listed here, each with the reason the size must stay fixed.
const PX_ALLOWLIST: Array<{ selector: string; reason: string }> = [
  { selector: ".qnalog-bubble-btn.append::after", reason: "plus glyph inside a fixed 12px circle" },
  {
    selector: ".qnalog-meeting-composer.is-mobile .qnalog-meeting-composer-input",
    reason: "iOS zooms the page when an input font is under 16px",
  },
  {
    selector: ".qnalog-outline.is-mobile .qnalog-recording-search-input",
    reason: "iOS zooms the page when an input font is under 16px",
  },
  { selector: ".qnalog-sediment-pipeline-circle", reason: "digit inside a fixed 24px circle" },
  { selector: "qnalog-outline-leading-time", reason: "time label in a fixed 42px column" },
  { selector: ".qnalog-outline-recent-filter-badge", reason: "digit inside a fixed 16px badge" },
];

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function pxFontSizeRules(css: string): string[] {
  const selectors: string[] = [];
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/font-size:\s*[\d.]+px/.test(match[2])) {
      selectors.push(match[1].trim().replace(/\s+/g, " "));
    }
  }
  return selectors;
}

describe("font-size tokens in styles.css", () => {
  const css = readFileSync("styles.css", "utf8");

  it("does not use the undefined --font-ui-smallest variable", () => {
    expect(stripComments(css)).not.toMatch(/--font-ui-smallest/);
  });

  it("defines --qnalog-font-ui-smallest on body", () => {
    expect(css).toMatch(/body\s*\{\s*--qnalog-font-ui-smallest:\s*calc\(var\(--font-ui-smaller\)/);
  });

  it("uses literal px font sizes only in allowlisted rules", () => {
    const offenders = pxFontSizeRules(css).filter(
      (selector) => !PX_ALLOWLIST.some((entry) => selector.includes(entry.selector)),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps every allowlist entry in use", () => {
    const rules = pxFontSizeRules(css);
    for (const entry of PX_ALLOWLIST) {
      expect(rules.some((selector) => selector.includes(entry.selector)), entry.reason).toBe(true);
    }
  });
});
