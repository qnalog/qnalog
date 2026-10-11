import { describe, expect, it } from "vitest";
import { generateTopicPageUpdateOperations, type TopicIntegrationMember, type TopicIntegrationPort } from "../src/topics/topic-integration";
import type { OverviewCard } from "../src/topics/overview-card";
import { renderTopicPage } from "../src/topics/topic-page";

function member(id: string, overview: string): TopicIntegrationMember {
  const card = { sourceId: id, path: `Notes/${id}.md`, title: `Title ${id}`, date: "2025-03-04", tags: ["tag"], overview } as OverviewCard;
  return { card };
}

function portFor(operations: unknown[]): TopicIntegrationPort {
  return { request: async () => JSON.stringify({ operations }) };
}

describe("topic point deduplication", () => {
  it("keeps one similar add-point with more source footnotes", async () => {
    const first = "确认纪要列表字体变小的问题已彻底修复。";
    const second = "纪要列表字体变小的问题已确认彻底修复。";
    const fresh = member("fresh-point", `${first} ${second}`);
    const old = member("old-point", "旧版复测也确认纪要列表字体变小的问题已修复。");
    const result = await generateTopicPageUpdateOperations(portFor([
      { type: "add_point", thread: "纪要列表字体", text: first, sources: ["fresh-point"] },
      { type: "add_point", thread: "纪要列表字体", text: second, sources: ["fresh-point", "old-point"] },
    ]), { basis: "overview", members: [fresh], existingMembers: [old], currentPage: "" });
    expect(result.operations).toEqual([{ type: "add_point", thread: "纪要列表字体", text: second, sources: ["fresh-point", "old-point"], sourceId: "fresh-point" }]);
    expect(result.updateDiagnostics).toMatchObject({ duplicateOperations: 1, discarded: { duplicate: 1 } });
    expect(result.duplicateDetails).toEqual([{ thread: "纪要列表字体", discardedText: first, keptText: second, reason: "same-update" }]);
  });

  it("keeps clearly different points in the same thread", async () => {
    const fresh = member("fresh-points", "字体修复完成。搜索筛选仍待测试。");
    const result = await generateTopicPageUpdateOperations(portFor([
      { type: "add_point", thread: "客户端", text: "字体修复完成。", sources: ["fresh-points"] },
      { type: "add_point", thread: "客户端", text: "搜索筛选仍待测试。", sources: ["fresh-points"] },
    ]), { basis: "overview", members: [fresh], currentPage: "" });
    expect(result.operations).toHaveLength(2);
    expect(result.updateDiagnostics?.duplicateOperations).toBe(0);
  });

  it("drops a paraphrased point that repeats an existing page point in the same thread", async () => {
    const existing = "确认纪要列表字体变小的问题已彻底修复。";
    const paraphrase = "纪要列表字体变小的问题已确认彻底修复。";
    const fresh = member("fresh-page-point", paraphrase);
    const currentPage = renderTopicPage({ overview: "页面概述。", status: "active", threads: [{ id: "font", title: "纪要列表字体", summary: "记录字体问题。", points: [{ id: "font-fix", text: existing, sources: [] }] }], disagreements: [], open: [], unsorted: [] }, []);
    const result = await generateTopicPageUpdateOperations(portFor([
      { type: "add_point", thread: "纪要列表字体", text: paraphrase, sources: ["fresh-page-point"] },
    ]), { basis: "overview", members: [fresh], currentPage });
    expect(result.operations).toEqual([]);
    expect(result.updateDiagnostics).toMatchObject({ duplicateOperations: 1, discarded: { duplicate: 1 } });
    expect(result.duplicateDetails).toEqual([{ thread: "纪要列表字体", discardedText: paraphrase, keptText: existing, reason: "existing-page" }]);
  });
});
