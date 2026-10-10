import { describe, expect, it } from "vitest";
import { findTopicCandidates } from "../src/topics/topic-candidates";
import { t } from "../src/shared/i18n";
import type { OverviewCard } from "../src/topics/overview-card";

const card = (path: string, options: Partial<OverviewCard> = {}): OverviewCard => ({
  path, sourceId: path, title: path, date: "2024-01-10", overview: "Shared planning notes", overviewSource: "abstract",
  tags: [], people: [], outLinks: [], inLinks: [], unresolvedTargets: [], mtime: Date.parse("2024-01-10"), precision: "full",
  ...options,
});

describe("topic candidates", () => {
  it("groups by shared tags with the start first and stable relevance ordering", () => {
    const start = card("start.md", { tags: ["主题/AI", "主题/Policy"] });
    const cards = [
      card("same-date-z.md", { tags: ["主题/ai"] }),
      card("two-tags.md", { tags: ["主题/policy", "主题/ai"] }),
      card("same-date-a.md", { tags: ["主题/AI"] }),
      card("unrelated.md", { tags: ["other"] }),
      start,
    ];
    const result = findTopicCandidates({ start, cards }).byTag;
    expect(result.map((candidate) => candidate.path)).toEqual(["start.md", "two-tags.md", "same-date-a.md", "same-date-z.md"]);
    expect(result.map((candidate) => candidate.matchedTags)).toEqual([[], ["主题/policy", "主题/ai"], ["主题/AI"], ["主题/ai"]]);
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
    const start = card("start.md", { tags: ["行业/common", "主题/specific"], overview: "Unique opening summary" });
    const genericOnly = card("generic.md", { tags: ["行业/common"], overview: "Other subject entirely" });
    const result = findTopicCandidates({ start, cards: [...corpus, start, genericOnly] });
    expect(result.byTag.map((item) => item.path)).toEqual(["start.md"]);
    expect(result.byTag[0]).toMatchObject({ defaultSelected: true, cancellable: false });
    expect(result.byContent.some((item) => item.path === "generic.md")).toBe(false);
  });

  it("groups similar project spellings and gives generic labels no tag tier", () => {
    const start = card("start.md", { tags: ["项目/QnALog", "行业/软件开发", "主题/AI工作流"] });
    const similar = card("similar.md", { tags: ["项目/QALog", "行业/软件开发"] });
    const onlyIndustry = card("holiday.md", { tags: ["行业/软件开发"] });
    const onlyTheme = card("video.md", { tags: ["主题/AI工作流"] });
    const result = findTopicCandidates({ start, cards: [start, similar, onlyIndustry, onlyTheme] });
    expect(result.project.map((item) => item.path)).toEqual(["start.md", "similar.md"]);
    expect(result.project[1].reasons[1]).toContain(t("Similar tag spelling: "));
    expect(result.topic.map((item) => item.path)).toContain("video.md");
    expect(result.project.map((item) => item.path)).not.toContain("holiday.md");
  });
});
