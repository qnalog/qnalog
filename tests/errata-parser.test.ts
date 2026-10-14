import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (path: string) => String(path || "").replace(/\\/g, "/") }));
import { parseErrata } from "../src/errata/errata-parser";

describe("errata parser", () => {
  it("parses arrows, list markers, noise paragraphs and notes", () => {
    expect(parseErrata(`
      ﻿笔记：[[Meeting]]
      # 忽略的标题
      随意文字
      ## 替换
      - 「朱子 FS」 => 「JuiceFS」
      * Hugging Face -> Hyperframes
      3. 原词 → 新词
      无效行
      ## 噪音
      > 第一段噪音，包含多行
      > 仍然是同一段。

      第二段噪音。
      ## 说明
      全文只有一位说话人。
      ## 未知
      不纳入说明。
    `)).toMatchObject({
      replacements: [
        { from: "朱子 FS", to: "JuiceFS" },
        { from: "Hugging Face", to: "Hyperframes" },
        { from: "原词", to: "新词" },
      ],
      noise: ["第一段噪音，包含多行 仍然是同一段。", "第二段噪音。"],
      notes: ["全文只有一位说话人。"],
      truncated: false,
    });
  });

  it("recognizes English headings with case and surrounding whitespace", () => {
    const expected = parseErrata("## 替换\nwrong => right\n## 噪音\nnoise text\n## 说明\na note");
    const variants = [
      "## Replace\nwrong => right\n## Noise\nnoise text\n## Notes\na note",
      "  ##   rEpLaCe   \nwrong => right\n  ## nOiSe  \nnoise text\n ## NOTES   \na note",
      "## Replace\nwrong => right\n## 噪音\nnoise text\n## Notes\na note",
    ];
    for (const markdown of variants) expect(parseErrata(markdown)).toEqual(expected);
  });

  it("continues to ignore unknown section headings", () => {
    expect(parseErrata("## 替换\nknown => value\n## Other\nunknown => value").replacements)
      .toEqual([{ from: "known", to: "value" }]);
  });

  it("rejects short, identical and overlong replacement terms", () => {
    const parsed = parseErrata(`## 替换\na => b\nlonger => longer\n${"x".repeat(61)} => ok\nok => ${"x".repeat(61)}`);
    expect(parsed.replacements).toEqual([]);
  });

  it("caps valid replacements at 200 and marks the result truncated", () => {
    const lines = Array.from({ length: 205 }, (_, index) => `錯誤${index} => 正确${index}`).join("\n");
    const parsed = parseErrata(`## 替换\n${lines}`);
    expect(parsed.replacements).toHaveLength(200);
    expect(parsed.truncated).toBe(true);
  });

  it("ignores unknown sections and accepts empty text and a BOM", () => {
    expect(parseErrata("\uFEFF")).toEqual({ replacements: [], noise: [], notes: [], truncated: false });
    expect(parseErrata("## 其他\n内容\n## 替换\n甲 => 乙").replacements).toEqual([]);
  });
});
