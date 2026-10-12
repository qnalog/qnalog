import { describe, expect, it } from "vitest";
import type { TopicCandidate } from "../src/topics/topic-candidates";
import { renderTopicCandidateGroupHeading, renderTopicCandidateRow } from "../src/ui/topic-candidate-rows";

class FakeElement {
  children: FakeElement[] = [];
  text = "";
  cls = "";
  tag = "div";
  constructor(tag = "div", options: { cls?: string; text?: string } = {}) { this.tag = tag; this.cls = options.cls || ""; this.text = options.text || ""; }
  createDiv(options: { cls?: string; text?: string } = {}) { return this.add(new FakeElement("div", options)); }
  createEl(tag: string, options: { cls?: string; text?: string } = {}) { return this.add(new FakeElement(tag, options)); }
  createSpan(options: { cls?: string; text?: string } = {}) { return this.add(new FakeElement("span", options)); }
  add(child: FakeElement) { this.children.push(child); return child; }
  addEventListener() { /* Event behavior is covered by modal tests. */ }
}

const candidate: TopicCandidate = {
  tier: "project", path: "QnALog/Note.md", title: "QnALog note", date: "2026-10-11", overview: "A short note summary.",
  matchedTags: ["项目/Q&ALog"], matchedTerms: [], reasons: ["Shared project identifier tag"],
  reasonDetails: [{ kind: "project-tags", labels: ["项目/Q&ALog"], similar: false }], alreadyInTopics: ["topic-1"], missingOverview: false,
  score: 1, defaultSelected: true, cancellable: true,
};

function flatten(node: FakeElement): FakeElement[] { return [node, ...node.children.flatMap(flatten)]; }

describe("topic candidate rows", () => {
  it("shares group heading and candidate metadata structure between scan and create dialogs", () => {
    const root = new FakeElement();
    const heading = renderTopicCandidateGroupHeading(root as unknown as HTMLElement, "Project tags (5)");
    const row = renderTopicCandidateRow(root as unknown as HTMLElement, candidate, true, new Map([["topic-1", "Existing topic"]]), { text: (key) => key }, () => undefined);
    const descendants = flatten(root);
    expect(heading.cls).toContain("qnalog-topics-preview-heading is-section");
    expect(row.tag).toBe("label");
    expect(row.children.map((child) => child.tag)).toEqual(["input", "div"]);
    const details = row.children[1];
    expect(details.children.map((child) => child.cls)).toEqual([
      "qnalog-topics-candidate-title", "qnalog-topics-candidate-summary", "qnalog-topics-candidate-meta",
    ]);
    expect(descendants.some((item) => item.cls === "qnalog-topics-membership" && item.text.includes("Existing topic"))).toBe(true);
  });
});
