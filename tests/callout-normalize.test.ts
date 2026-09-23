import { describe, expect, it } from "vitest";
import { normalizeCallouts } from "../src/notes/callout-normalize";

describe("callout 收尾与间距", () => {
  it("callout 收尾的空引用行在边界处清掉，并补一个真行首空行", () => {
    const input = ["> [!abstract] 摘要", ">", "### 标题", "正文"].join("\n");
    expect(normalizeCallouts(input)).toBe(["> [!abstract] 摘要", "", "### 标题", "正文"].join("\n"));
  });

  it("文档以 callout 收尾时去掉尾部悬空的空引用行", () => {
    expect(normalizeCallouts("> [!info] 卡片\n> 内容\n>")).toBe("> [!info] 卡片\n> 内容");
  });

  it("多段 callout 内部的空引用行保留不动", () => {
    const multi = "> [!abstract] 第一段\n>\n> 第二段";
    expect(normalizeCallouts(multi)).toBe(multi);
  });

  it("连续 callout 之间仍用真空行隔开", () => {
    const two = "> [!info] A\n> a\n\n> [!abstract] B\n> b";
    expect(normalizeCallouts(two)).toBe(two);
  });

  it("代码围栏内容不参与收尾清理", () => {
    const fenced = "```md\n> [!abstract] 示例\n>\n```";
    expect(normalizeCallouts(fenced)).toBe(fenced);
  });
});
