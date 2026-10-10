import { describe, expect, it } from "vitest";
import { normalizeTagKey, type OverviewCard } from "../src/topics/overview-card";
import { isGenericTag, learnTopicTagSet, matchNoteToTopics } from "../src/topics/topic-tags";
import type { TopicPage } from "../src/topics/topic-page";

const card = (path: string, tags: string[]): OverviewCard => ({
  path, sourceId: path, title: path, date: "2024-01-01", overview: "", overviewSource: "abstract",
  tags, people: [], outLinks: [], inLinks: [], unresolvedTargets: [], mtime: 1, precision: "full",
});

const topic = (overrides: Partial<TopicPage> = {}): TopicPage => ({
  id: "topic", title: "Topic", tags: [], members: [], memberLinks: [], excluded: [],
  basis: "overview", created: "2024-01-01", updated: "2024-01-01", body: "", ...overrides,
});

describe("topic tags", () => {
  it("normalizes equivalent spelling while keeping near-matches distinct", () => {
    expect(normalizeTagKey("  #主题/ＡＩ & ML  ")).toBe("aiandml");
    expect(normalizeTagKey("云计算")).toBe("云计算");
    expect(normalizeTagKey("ml n ai")).toBe("aiandml");
    expect(normalizeTagKey("ai and ml")).not.toBe(normalizeTagKey("aiml"));
    expect(normalizeTagKey("cloud platform")).not.toBe(normalizeTagKey("cloud platforms"));
  });

  it("learns the normalized tag union and counts corpus document frequencies once per note", () => {
    const selected = [card("a.md", ["#主题/ＡＩ", "ai", "Cloud & Data"]), card("b.md", ["cloud n data", "Research"])];
    const corpus = [
      card("a.md", ["#主题/ＡＩ", "ai", "Cloud & Data"]),
      card("b.md", ["cloud n data", "Research"]),
      card("c.md", ["AI", "unselected"]),
    ];
    expect(learnTopicTagSet(selected, corpus)).toEqual({
      tags: ["ai", "cloudanddata", "research"],
      documentFrequency: { ai: 2, cloudanddata: 2, research: 1 },
    });
  });

  it("applies both generic-tag thresholds", () => {
    expect(isGenericTag("x", 8, 40)).toBe(true);
    expect(isGenericTag("x", 7, 40)).toBe(false);
    expect(isGenericTag("x", 8, 41)).toBe(false);
    expect(isGenericTag("x", 1, 4)).toBe(false);
    expect(isGenericTag("x", 8, 0)).toBe(false);
  });

  it("matches specific tags or multiple generic tags, excluding members and excluded notes", () => {
    const docs = Array.from({ length: 10 }, (_, index) => card(`doc-${index}.md`, ["Common", "frequent"]));
    const candidate = card("candidate.md", ["common", "niche"]);
    const doubleGeneric = card("double.md", ["common", "frequent"]);
    const topics = [
      topic({ id: "a-generic", title: "Generic only", tags: ["common"] }),
      topic({ id: "b-niche", title: "Specific", tags: ["niche"] }),
      topic({ id: "c-double", title: "Two generic", tags: ["common", "frequent"] }),
      topic({ id: "d-member", title: "Already member", tags: ["niche"], members: [candidate.path] }),
      topic({ id: "e-excluded", title: "Excluded pair", tags: ["niche"], excluded: [candidate.path] }),
    ];
    expect(matchNoteToTopics(candidate, topics, [...docs, candidate, doubleGeneric])).toEqual([
      { topicId: "b-niche", title: "Specific", matchedTags: ["niche"] },
    ]);
    expect(matchNoteToTopics(doubleGeneric, topics, [...docs, candidate, doubleGeneric]).map((match) => match.topicId)).toContain("c-double");
  });
});
