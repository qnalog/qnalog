import { describe, expect, it } from "vitest";
import { suggestTopics } from "../src/topics/topic-suggestions";
import type { OverviewCard } from "../src/topics/overview-card";
const make = (path: string, topic: string): OverviewCard => ({ path, sourceId: path, title: `${topic} notes`, date: "2024-01-01", overview: `${topic} discussion decision`, overviewSource: "abstract", tags: [topic], people: [], outLinks: [], inLinks: [], unresolvedTargets: [], mtime: 1, precision: "full" });
describe("topic suggestions", () => {
  it("is deterministic independent of input order and stable for identical members", () => {
    const cards = [make("a.md", "climate"), make("b.md", "climate"), make("z.md", "finance"), make("y.md", "finance")];
    expect(suggestTopics(cards).map((s) => s.memberPaths)).toEqual(suggestTopics([...cards].reverse()).map((s) => s.memberPaths));
    expect(suggestTopics(cards)[0].id).toBe(suggestTopics([...cards].reverse())[0].id);
  });
  it("honors ignored IDs, limits and excludes isolated notes", () => {
    const cards = [make("a.md", "climate"), make("b.md", "climate"), make("solo.md", "unrelated")];
    const result = suggestTopics(cards);
    expect(result.every((s) => !s.memberPaths.includes("solo.md"))).toBe(true);
    expect(suggestTopics(cards, new Map(), { ignoredIds: new Set(result.map((s) => s.id)) })).toEqual([]);
    expect(suggestTopics(cards, new Map(), { limit: 0 })).toEqual([]);
  });
  it("keeps each note in at most one bounded-size suggestion", () => {
    const cards = Array.from({ length: 8 }, (_, index) => make(`${index}.md`, "climate policy"));
    const result = suggestTopics(cards, new Map(), { maxMembers: 3 });
    const paths = result.flatMap((suggestion) => suggestion.memberPaths);
    expect(new Set(paths).size).toBe(paths.length);
    expect(result.every((suggestion) => suggestion.memberPaths.length <= 3)).toBe(true);
  });
  it("creates readable deterministic names and reports missing overviews", () => {
    const cards = [make("a.md", "climate"), { ...make("b.md", "climate"), overview: "", overviewSource: "none" }];
    const result = suggestTopics(cards);
    expect(result[0].draftName).toContain("climate"); expect(result[0].missingOverview).toBe(1); expect(result[0].reasons).toContain("missing-overview");
  });
});
