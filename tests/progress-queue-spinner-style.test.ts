import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The queue row's icon column is 10px wide. The base spinner is 20px square, so inside the row's
// flex icon container its width is shrunk while its height is kept, and it renders as an ellipse.
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  const open = css.indexOf("{", start);
  return start < 0 ? "" : css.slice(open + 1, css.indexOf("}", open));
}

function px(body: string, prop: string): number {
  const match = body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*([\\d.]+)px`));
  return match ? Number(match[1]) : NaN;
}

describe("progress queue row spinner style", () => {
  const css = readFileSync("styles.css", "utf8");
  const column = Number((ruleBody(css, ".qnalog-progress-queue-row").match(/grid-template-columns:\s*([\d.]+)px/) || [])[1]);
  const spinner = ruleBody(css, ".qnalog-progress-queue-row .qnalog-progress-spinner");

  it("keeps the spinner square and no wider than the icon column", () => {
    expect(spinner).not.toBe("");
    const width = px(spinner, "width");
    const height = px(spinner, "height");
    expect(width).toBe(height);
    expect(width).toBeLessThanOrEqual(column);
    expect(spinner).toMatch(/flex:\s*0 0 auto;/);
  });
});
