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

describe("v2 pages keep block addresses in the topic cache", () => {
  const page = "---\nqnalog_topic_layout: 2\n---\n## 进展脉络\n### 属性名\n线索摘要 ^tpc-0a0a0a\n- 旧要点[^sa8f6] ^tpc-0b0b0b\n## 时间线\n";

  it("revise_block removes model markers and leaves no inline IDs", () => {
    const result = applyTopicOps(page, [{
      type: "revise_block", blockId: "tpc-0a0a0a", expectedText: "线索摘要", sourceId: "new",
      newText: "关于 Front Matter 元信息标准化存在争议：新的做法。 ^tpc-bf65c5 ^tpc-bf65c5",
      reason: "update",
    }]);
    const revised = result.markdown.slice(result.markdown.indexOf("\n##")).split("\n").find((line) => line.includes("关于 Front Matter"))!;
    expect(revised).toBe("关于 Front Matter 元信息标准化存在争议：新的做法。");
    expect(count(result.markdown, /\^tpc-/g)).toBe(0);
    expect(result.markdown).not.toContain("qnalog_topic_blocks:");
    expect(result.blockIndex?.length).toBeGreaterThan(0);
    expect(result.duplicateBlockIds).toBeUndefined();
  });

  it("cleans repeated legacy IDs across the full v2 page", () => {
    const repeated = "---\nqnalog_topic_layout: 2\n---\n## 进展脉络\n- 第一条 ^tpc-0c0c0c\n- 第二条 ^tpc-0c0c0c\n## 时间线\n";
    const result = applyTopicOps(repeated, []);
    expect(result.duplicateBlockIds).toBeUndefined();
    expect(count(result.markdown, /\^tpc-/g)).toBe(0);
    expect(result.markdown).toContain("- 第一条");
    expect(result.markdown).not.toContain("qnalog_topic_blocks:");
    expect(result.blockIndex).toHaveLength(2);
    expect(parseTopicPageBlocks(result.markdown)).toHaveLength(2);
  });
});

describe("model text is cleaned before rendering", () => {
  it("a point with model markers keeps its footnote and returns its address outside the page", async () => {
    const page = "---\nqnalog_topic_layout: 2\n---\n## 进展脉络\n### 线索\n线索摘要。 ^tpc-0a0a0a\n## 时间线\n";
    const member = { card: { sourceId: "fresh", path: "Notes/fresh.md", title: "Fresh", date: "2026-10-11", tags: [], overview: "补充阅读视图的截图验证。" } as never, content: "补充阅读视图的截图验证。" };
    const payload = { operations: [{ type: "add_point", thread: "线索", text: "- [ ] 补充阅读视图的截图验证。[^s8c08] ^tpc-bf65c5", sources: ["fresh"], sourceId: "fresh" }] };
    const port = { request: async () => JSON.stringify(payload) };
    const result = await generateTopicPageUpdateOperations(port, { basis: "overview", members: [member], currentPage: page });
    const applied = applyTopicOps(page, result.operations).markdown;
    const line = applied.slice(applied.indexOf("\n##")).split("\n").find((item) => item.includes("补充阅读视图"))!;
    expect(line).toMatch(/^- 补充阅读视图的截图验证。\[\^s[\da-f]{4}\]$/);
    expect(applied).not.toContain("s8c08");
    expect(applied).not.toMatch(/\^tpc-/);
    expect(applied).not.toContain("qnalog_topic_blocks:");
  });
});
