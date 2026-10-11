import { describe, expect, it } from "vitest";
import { generateTopicPageUpdateOperations, type TopicIntegrationMember, type TopicIntegrationPort } from "../src/topics/topic-integration";
import type { OverviewCard } from "../src/topics/overview-card";
import { applyTopicOps, parseTopicPageBlocks, type TopicOperation } from "../src/topics/topic-page";

const OLD_CLAIM = "Front matter 主要用于日后信息索引和结构化使用，属性名称越稳定越好，经常变化会导致检索失败。";
const NEW_CLAIM = "front matter 属性名称最终决定仍然按 Obsidian 语言动态切换，不再强制保持稳定";

function member(sourceId: string, path: string, date: string, text: string): TopicIntegrationMember {
  const card = { sourceId, path, title: `Title ${sourceId}`, date, tags: ["tag"], overview: text } as OverviewCard;
  return { card, content: text };
}

function fakePort(responses: unknown[]): TopicIntegrationPort {
  return { request: async () => responses.shift() as string };
}

// A v2 page: one point block with a footnote to the old member (2026-09-29).
const oldMember = member("old", "Notes/old.md", "2026-09-29", OLD_CLAIM);
const PAGE = [
  "---", "qnalog_topic_layout: 2", "---",
  "## 进展脉络", "### 属性名", `- ${OLD_CLAIM}[^sa8f6] ^tpc-cd7864`,
  "## 时间线", "## 来源笔记", "[^sa8f6]: [[Notes/old.md|Title old]] · 2026-09-29", "",
].join("\n");
const oldBlock = () => parseTopicPageBlocks(PAGE).find((block) => block.id === "tpc-cd7864")!;

const newMember = member("fresh", "Notes/fresh.md", "2026-10-11", `对 QnALog 项目的进展做了确认：${NEW_CLAIM}，因为用户体验优先。`);

function disagreementOf(operations: TopicOperation[]) {
  const found = operations.filter((item) => item.type === "add_disagreement");
  expect(found).toHaveLength(1);
  return found[0] as Extract<TopicOperation, { type: "add_disagreement" }>;
}

describe("disagreement existing side comes from the page block", () => {
  it("uses the block's text, footnote, and member date when relatedBlockId is present", async () => {
    const block = oldBlock();
    const payload = {
      assessments: [{ memberId: "fresh", claim: NEW_CLAIM, relation: "conflict", relatedBlockId: block.id }],
      operations: [{ type: "add_disagreement", subject: "Front Matter 属性命名策略", relatedBlockId: block.id, positions: [
        { text: "为解决检索稳定性问题，决定放弃按 Obsidian 语言动态切换属性名的做法。", sourceId: "" },
        { text: NEW_CLAIM, sourceId: "fresh" },
      ] }],
    };
    const result = await generateTopicPageUpdateOperations(fakePort([JSON.stringify(payload), JSON.stringify(payload)]), { basis: "overview", members: [newMember], existingMembers: [oldMember], currentPage: PAGE });
    const disagreement = disagreementOf(result.operations);
    expect(disagreement.positions).toEqual([
      expect.objectContaining({ text: OLD_CLAIM, sourceId: "old", sourceIds: ["old"], footnotes: ["sa8f6"], date: "2026-09-29", fromPage: true }),
      expect.objectContaining({ text: NEW_CLAIM, sourceId: "fresh", date: "2026-10-11" }),
    ]);

    const rendered = applyTopicOps(PAGE, result.operations).markdown;
    const callout = rendered.slice(rendered.indexOf("> [!warning] Front Matter 属性命名策略"));
    expect(callout).toMatch(new RegExp(`^> \\[!warning\\] Front Matter 属性命名策略\\n> - \\*\\*2026-09-29\\*\\*：${OLD_CLAIM}\\[\\^sa8f6\\] \\^tpc-[\\da-f]{6}\\n> - \\*\\*2026-10-11\\*\\*：${NEW_CLAIM}\\[\\^s[\\da-f]{4}\\] \\^tpc-[\\da-f]{6}`));
    expect(rendered).not.toContain("来源待核实");
    expect(rendered).not.toContain("为解决检索稳定性问题");
  });

  it("falls back to the best matching point block when relatedBlockId is missing", async () => {
    const payload = {
      assessments: [{ memberId: "fresh", claim: NEW_CLAIM, relation: "conflict" }],
      operations: [{ type: "add_disagreement", subject: "Front Matter 属性命名策略", positions: [{ text: NEW_CLAIM, sourceId: "fresh" }] }],
    };
    const result = await generateTopicPageUpdateOperations(fakePort([JSON.stringify(payload), JSON.stringify(payload)]), { basis: "overview", members: [newMember], existingMembers: [oldMember], currentPage: PAGE });
    const disagreement = disagreementOf(result.operations);
    expect(disagreement.relatedBlockId).toBe("tpc-cd7864");
    expect(disagreement.positions.map((position) => [position.sourceId, position.date])).toEqual([["old", "2026-09-29"], ["fresh", "2026-10-11"]]);
    expect(result.validationWarnings ?? []).not.toContain("A conflict assessment had no related page block; only the new claim was added for review.");
  });

  it("keeps only the new side and warns when no page block matches", async () => {
    const payload = { assessments: [{ memberId: "fresh", claim: NEW_CLAIM, relation: "conflict" }], operations: [] };
    const page = "---\nqnalog_topic_layout: 2\n---\n## 进展脉络\n- 完全无关的一条要点。[^sa8f6] ^tpc-eeeeee\n## 时间线\n";
    const result = await generateTopicPageUpdateOperations(fakePort([JSON.stringify(payload), JSON.stringify(payload)]), { basis: "overview", members: [newMember], existingMembers: [oldMember], currentPage: page });
    const disagreement = disagreementOf(result.operations);
    expect(disagreement.positions).toHaveLength(1);
    expect(disagreement.positions[0]).toMatchObject({ sourceId: "fresh", date: "2026-10-11" });
    expect(result.validationWarnings).toContain("A conflict assessment had no related page block; only the new claim was added for review.");
  });

  it("marks a narrative block as page narrative without a date or a pending-verification mark", () => {
    const page = "---\nqnalog_topic_layout: 2\n---\n## 进展脉络\n### 线索\n线索叙述段落。 ^tpc-aaaaaa\n## 时间线\n";
    const rendered = applyTopicOps(page, [{ type: "add_disagreement", subject: "线索冲突", relatedBlockId: "tpc-aaaaaa", sourceId: "fresh", positions: [
      { text: "线索叙述段落。", sourceId: "", provenance: "page-narrative", fromPage: true },
      { text: NEW_CLAIM, sourceId: "fresh", date: "2026-10-11" },
    ] }]).markdown;
    expect(rendered).toContain("> - 线索叙述段落。（来自页面叙述）");
    expect(rendered).not.toContain("来源待核实");
    expect(rendered).not.toMatch(/> - \*\*[^*]+\*\*：线索叙述段落/);
  });

  it("uses the earliest member date and keeps every footnote of a page block with several sources", async () => {
    const early = member("early", "Notes/early.md", "2026-09-20", "属性名称应保持稳定。");
    const late = member("late", "Notes/late.md", "2026-10-01", "属性名称应保持稳定。");
    const page = [
      "---", "qnalog_topic_layout: 2", "---",
      "## 进展脉络", "### 属性名", "- 属性名称应保持稳定。[^sa1111][^sb2222] ^tpc-ffffff",
      "## 时间线", "## 来源笔记",
      "[^sa1111]: [[Notes/late.md|Title late]] · 2026-10-01",
      "[^sb2222]: [[Notes/early.md|Title early]] · 2026-09-20", "",
    ].join("\n");
    const payload = {
      assessments: [{ memberId: "fresh", claim: NEW_CLAIM, relation: "conflict", relatedBlockId: "tpc-ffffff" }],
      operations: [{ type: "add_disagreement", subject: "属性名", relatedBlockId: "tpc-ffffff", positions: [{ text: NEW_CLAIM, sourceId: "fresh" }] }],
    };
    const result = await generateTopicPageUpdateOperations(fakePort([JSON.stringify(payload), JSON.stringify(payload)]), { basis: "overview", members: [newMember], existingMembers: [early, late], currentPage: page });
    const disagreement = disagreementOf(result.operations);
    expect(disagreement.positions[0]).toMatchObject({ sourceId: "early", date: "2026-09-20", footnotes: ["sa1111", "sb2222"] });
    const rendered = applyTopicOps(page, result.operations).markdown;
    expect(rendered).toContain("> - **2026-09-20**：属性名称应保持稳定。[^sa1111][^sb2222]");
  });
});

describe("page edits around generated text", () => {
  it("a revise_block whose newText carries block IDs and footnotes writes exactly one ID at the end", async () => {
    const page = "---\nqnalog_topic_layout: 2\n---\n## 进展脉络\n### 线索\n原摘要内容。 ^tpc-0a0a0a\n## 时间线\n";
    const payload = { operations: [{ type: "revise_block", blockId: "tpc-0a0a0a", newText: "关于 Front Matter 元信息标准化存在争议：修订后的做法。 ^tpc-bf65c5 ^tpc-bf65c5[^sc0c0c]", reason: "update", sourceId: "fresh" }] };
    const result = await generateTopicPageUpdateOperations(fakePort([JSON.stringify(payload)]), { basis: "overview", members: [newMember], existingMembers: [oldMember], currentPage: page });
    const applied = applyTopicOps(page, result.operations).markdown;
    expect(applied.split("\n").find((line) => line.includes("修订后的做法"))).toBe("关于 Front Matter 元信息标准化存在争议：修订后的做法。 ^tpc-0a0a0a");
    expect(applied.match(/\^tpc-/g)).toHaveLength(1);
  });

  it("skips a revision whose target block was edited after the preview and keeps user paragraphs verbatim", () => {
    const page = "---\nqnalog_topic_layout: 2\n---\n## 进展脉络\n### 线索\n用户手改后的摘要。 ^tpc-0a0a0a\n用户新增的段落，逐字保留。\n## 时间线\n";
    const result = applyTopicOps(page, [{ type: "revise_block", blockId: "tpc-0a0a0a", expectedText: "原摘要内容。", newText: "模型修订。", reason: "update", sourceId: "fresh" }]);
    expect(result.skipped).toEqual([{ id: "tpc-0a0a0a", reason: "block-modified" }]);
    expect(result.markdown).toContain("用户新增的段落，逐字保留。");
    expect(result.markdown).toContain("用户手改后的摘要。 ^tpc-0a0a0a");
  });
});
