import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { applyReplacements, removeNoise } from "../src/errata/errata-apply";

describe("errata application", () => {
  it("replaces Chinese literally and English case-insensitively on word boundaries", () => {
    expect(applyReplacements("朱子 FS / juicefs / main ai", [
      { from: "朱子 FS", to: "JuiceFS" }, { from: "JuiceFS", to: "Store" }, { from: "ai", to: "AI" },
    ])).toBe("JuiceFS / Store / main AI");
  });

  it("protects frontmatter, comments, code fences, transcript metadata and transcript blocks", () => {
    const note = [
      "---\ntitle: JuiceFS\n---", "正文 JuiceFS", "<!-- JuiceFS -->", "```txt\nJuiceFS\n```",
      "<!-- qnalog-transcript-start:x -->\nmetadata JuiceFS\n<!-- qnalog-transcript-end:x -->",
      "<details><summary>原始转写</summary>\n\n<!-- qnalog-segments-start:x -->\nJuiceFS\n<!-- qnalog-segments-end:x -->\n</details>",
    ].join("\n\n");
    const result = applyReplacements(note, [{ from: "JuiceFS", to: "Storage" }]);
    expect(result).toContain("title: JuiceFS");
    expect(result).toContain("正文 Storage");
    expect(result).toContain("<!-- JuiceFS -->");
    expect(result).toContain("```txt\nJuiceFS\n```");
    expect(result).toContain("metadata JuiceFS");
    expect(result).toContain("\nJuiceFS\n<!-- qnalog-segments-end:x -->");
  });

  it("applies longer rules first", () => {
    expect(applyReplacements("A.+(B) Ltd.", [
      { from: "A.+(B)", to: "Alice" }, { from: "A.+(B) Ltd.", to: "Alice Company" },
    ])).toBe("Alice Company");
  });

  it("removes only an exactly matching paragraph after whitespace folding", () => {
    const text = "保留段落\n\n噪音内容\n继续噪音\n\n相似噪音内容但不同";
    expect(removeNoise(text, ["噪音内容 继续噪音"]).text).toBe("保留段落\n\n\n\n相似噪音内容但不同");
    expect(removeNoise("噪音内容略有不同", ["噪音内容"]).removed).toBe(0);
    expect(removeNoise("短噪音", ["短噪音"]).removed).toBe(0);
  });
});
