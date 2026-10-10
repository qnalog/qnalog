import { describe, expect, it } from "vitest";
import { normalizeTagKey, type OverviewCard } from "../src/topics/overview-card";
import { areTagKeysSimilar, isGenericTag, learnTopicTagSet, matchNoteToTopics } from "../src/topics/topic-tags";
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
    expect(normalizeTagKey("项目/Q&ALog")).toBe("qalog");
    expect(normalizeTagKey("ai and ml")).not.toBe(normalizeTagKey("aiml"));
    expect(normalizeTagKey("cloud platform")).not.toBe(normalizeTagKey("cloud platforms"));
  });

  it("learns identifying tags only and keeps similar spellings as aliases", () => {
    const selected = [card("a.md", ["项目/QALog", "亲子教育", "主题/AI工作流"]), card("b.md", ["项目/QnALog", "儿童教育", "主题/AI工作流"])];
    const corpus = [...selected, card("c.md", ["AI", "unselected"])];
    const learned = learnTopicTagSet(selected, corpus);
    expect(learned.tags).toContain("项目/QALog");
    expect(learned.tags).toContain("主题/AI工作流");
    expect(learned.tags).not.toContain("亲子教育");
    expect(learned.tags).not.toContain("儿童教育");
    expect(learned.aliases["项目/QALog"]).toEqual(["项目/QALog", "项目/QnALog"]);
    expect(areTagKeysSimilar("QALog", "QnALog")).toBe(true);
  });

  it("keeps short dissimilar keys separate", () => {
    expect(areTagKeysSimilar("ai", "api")).toBe(false);
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
