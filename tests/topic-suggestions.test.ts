import { describe, expect, it, vi } from "vitest";
import { suggestTopics, suggestTopicsAsync } from "../src/topics/topic-suggestions";
import type { OverviewCard } from "../src/topics/overview-card";

const make = (path: string, topic: string): OverviewCard => ({
  path, sourceId: path, title: topic, date: "2024-01-01", overview: topic, overviewSource: "abstract",
  tags: [topic], people: [], outLinks: [], inLinks: [], unresolvedTargets: [], mtime: 1, precision: "full",
});

describe("topic suggestions", () => {
  it("is deterministic independent of input order and stable for identical members", () => {
    const cards = [make("a.md", "climate"), make("b.md", "climate"), make("z.md", "finance"), make("y.md", "finance")];
    const result = suggestTopics(cards).map(({ id, memberPaths }) => ({ id, memberPaths }));
    expect(result).toEqual(suggestTopics([...cards].reverse()).map(({ id, memberPaths }) => ({ id, memberPaths })));
  });

  it("honors ignored IDs, limits and excludes isolated notes", () => {
    const cards = [make("a.md", "climate"), make("b.md", "climate"), make("solo.md", "unrelated")];
    const result = suggestTopics(cards);
    expect(result.every((suggestion) => !suggestion.memberPaths.includes("solo.md"))).toBe(true);
    expect(suggestTopics(cards, new Map(), { ignoredIds: new Set(result.map((suggestion) => suggestion.id)) })).toEqual([]);
    expect(suggestTopics(cards, new Map(), { limit: 0 })).toEqual([]);
  });

  it("keeps each note in at most one bounded-size suggestion", () => {
    const cards = Array.from({ length: 8 }, (_, index) => make(`${index}.md`, "climate policy"));
    const result = suggestTopics(cards, new Map(), { maxMembers: 3 });
    const paths = result.flatMap((suggestion) => suggestion.memberPaths);
    expect(new Set(paths).size).toBe(paths.length);
    expect(result.every((suggestion) => suggestion.memberPaths.length <= 3)).toBe(true);
  });

  it("splits weak chains when the merged cluster's average edge score is too low", () => {
    const cards = ["甲乙", "丙丁", "戊己", "庚辛"].map((title, index) => ({
      ...make(`${String.fromCharCode(97 + index)}.md`, title),
      title, overview: "", tags: [],
    }));
    cards[0].outLinks = ["b.md"];
    cards[1].outLinks = ["a.md", "c.md"];
    cards[2].outLinks = ["b.md", "d.md"];
    cards[3].outLinks = ["c.md"];
    const result = suggestTopics(cards, new Map(), { edgeThreshold: 0.5, minCohesion: 0.55 });
    expect(result.map((suggestion) => suggestion.memberPaths).sort((left, right) => left[0].localeCompare(right[0])))
      .toEqual([["a.md", "b.md"], ["c.md", "d.md"]]);
  });

  it("uses readable title fragments after date and mode prefixes, with a shorter-name tie break", () => {
    const cards = [
      { ...make("a.md", "unused"), title: "2026-09-15 2056 · 综合纪要-问答日志-数据结构优化", tags: [], overview: "问答日志" },
      { ...make("b.md", "unused"), title: "2026-09-16 0810 · 个人笔记-问答日志-额度管理", tags: [], overview: "问答日志" },
    ];
    // "额度管理" wins the specified cluster-frequency × inverse-document-frequency score.
    expect(suggestTopics(cards)[0].draftName).toBe("额度管理");
    const tied = [
      { ...make("c.md", "unused"), title: "2026-01-01 · 综合纪要", tags: ["cloud", "cloudplatform"] },
      { ...make("d.md", "unused"), title: "2026-01-02 · 个人笔记", tags: ["cloud", "cloudplatform"] },
      make("z.md", "orchid"),
    ];
    expect(suggestTopics(tied)[0].draftName).toBe("cloud");
  });

  it("reports missing overviews without downweighting their edges", () => {
    const cards = [make("a.md", "climate"), { ...make("b.md", "climate"), overview: "", overviewSource: "none" }];
    const result = suggestTopics(cards);
    expect(result[0].draftName).toContain("climate");
    expect(result[0].missingOverview).toBe(1);
    expect(result[0].reasons).toContain("missing-overview");
    expect(result[0].cohesion).toBeGreaterThanOrEqual(0.07);
  });

  it("shares the synchronous algorithm, yields between async batches, and honors cancellation", async () => {
    const cards = Array.from({ length: 8 }, (_, index) => make(`${index}.md`, "climate policy"));
    vi.useFakeTimers();
    try {
      let timerFired = false;
      setTimeout(() => { timerFired = true; }, 0);
      const pending = suggestTopicsAsync(cards, new Map(), { batchSize: 1 });
      await vi.runAllTimersAsync();
      const asynchronous = await pending;
      expect(timerFired).toBe(true);
      expect(asynchronous).toEqual(suggestTopics(cards, new Map(), { batchSize: 1 }));

      const controller = new AbortController();
      const canceled = suggestTopicsAsync(cards, new Map(), { batchSize: 1, signal: controller.signal });
      const cancellation = expect(canceled).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await vi.runAllTimersAsync();
      await cancellation;
    } finally {
      vi.useRealTimers();
    }
  });
});
