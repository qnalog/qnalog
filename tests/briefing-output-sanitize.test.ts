import { describe, expect, it } from "vitest";
import { sanitizeBriefingModelOutput } from "../src/briefing/output-sanitize";

describe("sanitizeBriefingModelOutput", () => {
  it("removes segment references in the supported brackets and ranges", () => {
    const input = "A (SEG 1), B（SEG 1–2）, C（SEG 2）, D（seg 3-5）, E[SEG 2], F（SEG 1, 2）、G（SEG 1—3）, H（SEG 1~3）, I（SEG 1，2）, J（SEG 1、2）, K（SEG 1;2）, L（SEG 1；2）";
    expect(sanitizeBriefingModelOutput(input)).toBe("A, B, C, D, E, F、G, H, I, J, K, L");
  });

  it("removes references in prose and at list item ends without leaving trailing spaces", () => {
    expect(sanitizeBriefingModelOutput("结论（SEG 1）。句中（SEG 1–2）仍有内容。\n- 事项：周五完成（SEG 2）"))
      .toBe("结论。句中仍有内容。\n- 事项：周五完成");
  });

  it("removes standalone SEG separator lines", () => {
    expect(sanitizeBriefingModelOutput("正文\n===SEG 2===\n下一段"))
      .toBe("正文\n下一段");
  });

  it("preserves fenced code, inline code, frontmatter, and HTML comments", () => {
    const input = "---\ntitle: （SEG 1）\n---\n正文（SEG 2）\n`（SEG 3）`\n```text\n（SEG 4）\n===SEG 5===\n```\n<!-- （SEG 6） -->";
    expect(sanitizeBriefingModelOutput(input)).toBe("---\ntitle: （SEG 1）\n---\n正文\n`（SEG 3）`\n```text\n（SEG 4）\n===SEG 5===\n```\n<!-- （SEG 6） -->");
  });

  it("preserves SEG words that are not segment references", () => {
    expect(sanitizeBriefingModelOutput("Use the SEG protocol for the handoff."))
      .toBe("Use the SEG protocol for the handoff.");
  });
});
