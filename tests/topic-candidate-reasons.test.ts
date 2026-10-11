import { describe, expect, it } from "vitest";
import type { TopicCandidate } from "../src/topics/topic-candidates";
import { formatTopicCandidateReasons } from "../src/ui/topics-ui-port";

function candidate(overrides: Partial<TopicCandidate> = {}): TopicCandidate {
  return {
    tier: "project", path: "Notes/a.md", title: "A", date: "", overview: "", matchedTags: [], matchedTerms: [], reasons: [],
    reasonDetails: [{ kind: "project-tags", labels: ["项目/Q&ALog", "项目/QnALog", "项目/Long label", "项目/Extra"], similar: true }],
    alreadyInTopics: [], missingOverview: false, score: 1, defaultSelected: false, cancellable: true, ...overrides,
  };
}

describe("topic candidate reason formatting", () => {
  it("renders one concise project reason with three labels and a similarity marker", () => {
    expect(formatTopicCandidateReasons(candidate(), (key) => key === "Project tags: " ? "项目标签：" : "（写法相近）"))
      .toEqual(["项目标签：Q&ALog、QnALog、Long label…（写法相近）"]);
  });

  it("renders one reason for topic tags or content similarity", () => {
    expect(formatTopicCandidateReasons(candidate({ tier: "topic", reasonDetails: [{ kind: "topic-tags", labels: ["主题/AI工作流", "概念/Obsidian"], similar: false }] }), (key) => key === "Topic tags: " ? "主题标签：" : key))
      .toEqual(["主题标签：AI工作流、Obsidian"]);
    expect(formatTopicCandidateReasons(candidate({ tier: "content", reasonDetails: [{ kind: "content", terms: ["workflow"] }] }), (key) => key))
      .toEqual(["Similar content"]);
  });
});
