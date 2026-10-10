import { describe, expect, it } from "vitest";
import { buildOverviewCard, normalizeTagKey } from "../src/topics/overview-card";
import type { RelatedNoteDocument } from "../src/indexing/related-notes";

const doc: RelatedNoteDocument = { path: "QnALog/a.md", sourceId: "a", title: "A 2024-01-01", timestamp: 1, tags: [], people: ["Bo"], topics: [], summary: "index fallback", decisions: [], actions: [], questions: [], bodyExcerpt: "", outLinks: ["b"], inLinks: [], unresolvedTargets: ["missing"], precision: "full", hasIndexCard: true };
describe("overview cards", () => {
  it("prefers abstract and falls back to index summary, then no overview", () => {
    expect(buildOverviewCard({ document: doc, markdown: "> [!abstract] 概要\n> Hello", frontmatter: {}, mtime: 1 }).overviewSource).toBe("abstract");
    expect(buildOverviewCard({ document: doc, markdown: "", frontmatter: {}, mtime: 1 }).overviewSource).toBe("index-summary");
    expect(buildOverviewCard({ document: { ...doc, summary: "" }, markdown: "", frontmatter: {}, mtime: 1 }).overviewSource).toBe("none");
  });
  it("uses meetingDate, qnalog_time, then file creation time", () => {
    expect(buildOverviewCard({ document: doc, markdown: "", frontmatter: { meetingDate: "2023-02-03", qnalog_time: "2022-01-01" }, mtime: 1 }).date).toBe("2023-02-03");
    expect(buildOverviewCard({ document: doc, markdown: "", frontmatter: { qnalog_time: "2022-01-01" }, mtime: 1 }).date).toBe("2022-01-01");
    expect(buildOverviewCard({ document: doc, markdown: "", frontmatter: {}, mtime: 1, ctime: Date.parse("2020-01-02") }).date).toBe("2020-01-02");
  });
  it("normalizes explicit aliases but keeps unrelated concepts separate", () => {
    expect(normalizeTagKey("#行业/AI & Data")).toBe(normalizeTagKey("data and ai"));
    expect(normalizeTagKey("AI")).not.toBe(normalizeTagKey("A1"));
  });
  it("retains link graph fields and labels missing overview", () => {
    const card = buildOverviewCard({ document: { ...doc, summary: "" }, markdown: "", frontmatter: {}, mtime: 1 });
    expect(card.outLinks).toEqual(["b"]); expect(card.unresolvedTargets).toEqual(["missing"]); expect(card.overviewSource).toBe("none");
  });
});
