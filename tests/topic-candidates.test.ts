import { describe, expect, it } from "vitest";
import { findTopicCandidates } from "../src/topics/topic-candidates";
import type { OverviewCard } from "../src/topics/overview-card";

const card = (path: string, options: Partial<OverviewCard> = {}): OverviewCard => ({
  path, sourceId: path, title: path, date: "2024-01-10", overview: "Shared planning notes", overviewSource: "abstract",
  tags: [], people: [], outLinks: [], inLinks: [], unresolvedTargets: [], mtime: Date.parse("2024-01-10"), precision: "full",
  ...options,
});

describe("topic candidates", () => {
  it("groups by shared tags with the start first and stable relevance ordering", () => {
    const start = card("start.md", { tags: ["AI", "Policy"] });
    const cards = [
      card("same-date-z.md", { tags: ["ai"] }),
      card("two-tags.md", { tags: ["policy", "ai"] }),
      card("same-date-a.md", { tags: ["AI"] }),
      card("unrelated.md", { tags: ["other"] }),
      start,
    ];
    const result = findTopicCandidates({ start, cards }).byTag;
    expect(result.map((candidate) => candidate.path)).toEqual(["start.md", "two-tags.md", "same-date-a.md", "same-date-z.md"]);
    expect(result.map((candidate) => candidate.matchedTags)).toEqual([["ai", "policy"], ["ai", "policy"], ["ai"], ["ai"]]);
  });

  it("annotates candidate membership in sorted topic IDs", () => {
    const start = card("start.md", { tags: ["planning"] });
    const candidate = card("candidate.md", { tags: ["planning"] });
    const result = findTopicCandidates({
      start, cards: [start, candidate],
      members: { "topic-z": ["candidate.md"], "topic-a": ["candidate.md"], other: ["start.md"] },
    });
    expect(result.byTag.find((item) => item.path === "candidate.md")?.alreadyInTopics).toEqual(["topic-a", "topic-z"]);
    expect(result.byTag.find((item) => item.path === "start.md")?.alreadyInTopics).toEqual(["other"]);
  });

  it("filters candidates outside the time window but keeps the start note and honors exclusions", () => {
    const start = card("start.md", { date: "2024-01-10", tags: ["planning"] });
    const recent = card("recent.md", { date: "2024-01-09", tags: ["planning"] });
    const old = card("old.md", { date: "2023-01-01", tags: ["planning"] });
    const result = findTopicCandidates({ start, cards: [old, recent], windowDays: 3, excluded: ["recent.md"] });
    expect(result.byTag.map((item) => item.path)).toEqual(["start.md"]);
    const zeroWindow = findTopicCandidates({ start, cards: [old, recent], windowDays: 0 });
    expect(zeroWindow.byTag.map((item) => item.path)).toEqual(["start.md"]);
  });

  it("does not return content candidates whose score is below the configured threshold", () => {
    const start = card("start.md", { overview: "quasar lattice telemetry convergence", tags: ["start-only"] });
    const contentOnly = card("content.md", { overview: "quasar lattice telemetry convergence", tags: ["different"] });
    const result = findTopicCandidates({ start, cards: [start, contentOnly], minScore: 100 });
    expect(result.byContent).toEqual([]);
  });

  it("keeps the unremovable start selected and excludes generic-tag-only matches", () => {
    const corpus = Array.from({ length: 10 }, (_, index) =>
      card(`note-${index}.md`, { tags: ["common"], overview: `Unrelated evidence ${index}` }));
    const start = card("start.md", { tags: ["common", "specific"], overview: "Unique opening summary" });
    const genericOnly = card("generic.md", { tags: ["common"], overview: "Other subject entirely" });
    const result = findTopicCandidates({ start, cards: [...corpus, start, genericOnly] });
    expect(result.byTag.map((item) => item.path)).toEqual(["start.md"]);
    expect(result.byTag[0]).toMatchObject({ defaultSelected: true, cancellable: false });
    expect(result.byContent.some((item) => item.path === "generic.md")).toBe(false);
  });
});
