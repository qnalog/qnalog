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

  it("研讨报告提取器的章节映射与去编号后的模板一致", () => {
    expect(source).toContain("`问题意识` →");
    expect(source).toContain("`观点谱系`(分立场小标题)");
    expect(source).toContain("`概念、方法与案例` →");
    expect(source).toContain("`后续问题`(列表)");
    expect(source).toContain("`可转化为笔记的条目` →");
    expect(source).not.toContain("`一、问题意识`");
    expect(source).not.toContain("`六、可转化为笔记的条目`");
  });

  it("callout 收尾纪律写入提示词", () => {
    expect(source).toContain("不要用空的 \\`>\\` 行收尾");
  });
});
