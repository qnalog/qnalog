import { describe, expect, it } from "vitest";
import { pluginSourceText } from "./plugin-source";

const source = pluginSourceText();

describe("纪要提示词的标题层级与编号纪律", () => {
  it("全局规则写明层级、禁止正文输出一级标题、禁止手工编号", () => {
    expect(source).toContain("标题层级与编号");
    expect(source).toContain("正文不要输出");
    expect(source).toContain("不加");
    expect(source).not.toContain("连续编号");
    expect(source).not.toContain("用三级标题 + 散文段落叙述");
  });

  it("模式模板不残留四级标题示例与编号章节", () => {
    expect(source).not.toContain("#### <");
    expect(source).not.toMatch(/\n## \d+\. </);
    expect(source).not.toMatch(/\n#{2,3} [一二三四五六七八九十]+、/);
  });

  it("callout 收尾纪律写入提示词", () => {
    expect(source).toContain("不要用空的 \\`>\\` 行收尾");
  });
});
