import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Obsidian's base button rule sets height: var(--input-height), box-shadow: var(--input-shadow)
// and a hover background. An inline text action must reset all three, or it renders as a raised box
// that is taller than the line of text it sits in.
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector},`);
  const open = css.indexOf("{", start);
  return start < 0 ? "" : css.slice(open + 1, css.indexOf("}", open));
}

describe("qnalog-text-action style", () => {
  const css = readFileSync("styles.css", "utf8");
  const body = ruleBody(css, "button.qnalog-text-action");

  it("resets Obsidian's button height, shadow and background, including on hover and mobile tap", () => {
    expect(css).toMatch(/button\.qnalog-text-action,\s*button\.qnalog-text-action:hover,\s*button\.qnalog-text-action\.mobile-tap\s*\{/);
    expect(body).toMatch(/height:\s*auto;/);
    expect(body).toMatch(/min-height:\s*0;/);
    expect(body).toMatch(/box-shadow:\s*none;/);
    expect(body).toMatch(/background:\s*transparent;/);
    expect(body).toMatch(/line-height:\s*inherit;/);
  });
});
