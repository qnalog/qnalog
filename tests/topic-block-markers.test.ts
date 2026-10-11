import { describe, expect, it } from "vitest";
import { dedupeBlockIds, stripBlockMarkers, withBlockId } from "../src/topics/topic-block-markers";
import { generateTopicPageUpdateOperations } from "../src/topics/topic-integration";
import { applyTopicOps, parseTopicPageBlocks } from "../src/topics/topic-page";

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length || 0;

describe("stripBlockMarkers", () => {
  it("removes block IDs, footnote references, and list or checkbox prefixes while keeping other text", () => {
    expect(stripBlockMarkers("关于 Front Matter 元信息标准化存在争议。 ^tpc-bf65c5 ^tpc-bf65c5")).toBe("关于 Front Matter 元信息标准化存在争议。");
    expect(stripBlockMarkers("结论一[^s8c08]，结论二 ^tpc-a1b2c3")).toBe("结论一，结论二");
    expect(stripBlockMarkers("- [ ] 行动：补充截图验证。[^s8c08] ^tpc-a1b2c3")).toBe("行动：补充截图验证。");
    expect(stripBlockMarkers("- [x] 已完成的事项")).toBe("已完成的事项");
    expect(stripBlockMarkers("* 列表前缀\n- 第二行")).toBe("列表前缀\n第二行");
    expect(stripBlockMarkers("保持其余文字不变：Obsidian 与 front matter。")).toBe("保持其余文字不变：Obsidian 与 front matter。");
  });

  it("matches block IDs case-insensitively", () => {
    expect(stripBlockMarkers("text ^TPC-ABCDEF")).toBe("text");
  });
});

describe("withBlockId", () => {
  it("appends a block ID once and leaves a line that already carries it unchanged", () => {
    expect(withBlockId("正文", "tpc-a1b2c3")).toBe("正文 ^tpc-a1b2c3");
    expect(withBlockId("正文 ^tpc-a1b2c3", "tpc-a1b2c3")).toBe("正文 ^tpc-a1b2c3");
  });
});

describe("dedupeBlockIds", () => {
  it("keeps the first occurrence of an ID in the page, including duplicates inside one line and across lines", () => {
    const page = "第一段 ^tpc-a1b2c3 ^tpc-a1b2c3\n普通段落\n第三段 ^tpc-a1b2c3\n第四段 ^tpc-d4e5f6";
    const result = dedupeBlockIds(page);
    expect(result.markdown).toBe("第一段 ^tpc-a1b2c3\n普通段落\n第三段\n第四段 ^tpc-d4e5f6");
    expect(result.duplicates).toEqual(["tpc-a1b2c3", "tpc-a1b2c3"]);
  });
});

describe("rendering writes one block ID per block", () => {
  const page = "---\nqnalog_topic_layout: 2\n---\n## 进展脉络\n### 属性名\n线索摘要 ^tpc-0a0a0a\n- 旧要点[^sa8f6] ^tpc-0b0b0b\n## 时间线\n";

  it("revise_block drops IDs and footnotes that the model supplied", () => {
    const result = applyTopicOps(page, [{
      type: "revise_block", blockId: "tpc-0a0a0a", expectedText: "线索摘要", sourceId: "new",
      newText: "关于 Front Matter 元信息标准化存在争议：新的做法。 ^tpc-bf65c5 ^tpc-bf65c5",
      reason: "update",
    }]);
    const revised = result.markdown.split("\n").find((line) => line.includes("关于 Front Matter"))!;
    expect(revised).toBe("关于 Front Matter 元信息标准化存在争议：新的做法。 ^tpc-0a0a0a");
    expect(count(result.markdown, /\^tpc-/g)).toBe(2);
    expect(result.duplicateBlockIds).toBeUndefined();
  });

  it("the page-wide check keeps the first ID when a block ID is repeated across lines", () => {
    const repeated = "---\nqnalog_topic_layout: 2\n---\n## 进展脉络\n- 第一条 ^tpc-0c0c0c\n- 第二条 ^tpc-0c0c0c\n## 时间线\n";
    const result = applyTopicOps(repeated, []);
    expect(result.duplicateBlockIds).toEqual(["tpc-0c0c0c"]);
    expect(count(result.markdown, /\^tpc-0c0c0c/g)).toBe(1);
    expect(result.markdown).toContain("- 第一条 ^tpc-0c0c0c");
    expect(parseTopicPageBlocks(result.markdown).map((block) => block.id)).toEqual(["tpc-0c0c0c"]);
  });
});

describe("model text is cleaned before rendering", () => {
  it("a point with a checkbox prefix, footnote and block ID gets one renderer footnote and one block ID", async () => {
    const page = "---\nqnalog_topic_layout: 2\n---\n## 进展脉络\n### 线索\n线索摘要。 ^tpc-0a0a0a\n## 时间线\n";
    const member = { card: { sourceId: "fresh", path: "Notes/fresh.md", title: "Fresh", date: "2026-10-11", tags: [], overview: "补充阅读视图的截图验证。" } as never, content: "补充阅读视图的截图验证。" };
    const payload = { operations: [{ type: "add_point", thread: "线索", text: "- [ ] 补充阅读视图的截图验证。[^s8c08] ^tpc-bf65c5", sources: ["fresh"], sourceId: "fresh" }] };
    const port = { request: async () => JSON.stringify(payload) };
    const result = await generateTopicPageUpdateOperations(port, { basis: "overview", members: [member], currentPage: page });
    const applied = applyTopicOps(page, result.operations).markdown;
    const line = applied.split("\n").find((item) => item.includes("补充阅读视图"))!;
    expect(line).toMatch(/^- 补充阅读视图的截图验证。\[\^s[\da-f]{4}\] \^tpc-[\da-f]{6}$/);
    expect(applied).not.toContain("s8c08");
    expect(applied.match(/\^tpc-/g)).toHaveLength(2);
  });
});
