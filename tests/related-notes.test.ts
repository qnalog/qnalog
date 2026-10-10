import { describe, expect, it } from "vitest";
import { buildQueryFromDocument, findRelatedNotes, tokenize, type RelatedNoteDocument } from "../src/indexing/related-notes";
import { createRelatedNoteEvalFixture } from "../scripts/related-notes-fixture.mjs";

function doc(path: string, overrides: Partial<RelatedNoteDocument> = {}): RelatedNoteDocument {
  return {
    path, sourceId: path, title: "", timestamp: 0, tags: [], people: [], topics: [], summary: "",
    decisions: [], actions: [], questions: [], bodyExcerpt: "", outLinks: [], inLinks: [],
    unresolvedTargets: [], precision: "full", ...overrides,
  };
}

describe("related note ranking core", () => {
  it("tokenizes Han bigrams and lowercase English/digit words while dropping conservative stop-bigrams", () => {
    expect(tokenize("机器学习 AI-2025 然后处理")).toEqual(["机器", "器学", "学习", "ai", "2025", "后处", "处理"]);
    expect(tokenize("个人笔记 会议 项目 进展")).toEqual([]);
  });

  it("builds query text from title, topics, people, decisions, and summary only", () => {
    const note = doc("a.md", { title: "2026-03-10 1156 Title", tags: ["tag"], people: ["person"], topics: ["topic"], summary: "summary", decisions: ["decision"], actions: ["action"], questions: ["question"], bodyExcerpt: "body" });
    expect(buildQueryFromDocument(note)).toBe("Title topic person decision summary");
  });

  it("ranks boosted lexical overlap above unrelated notes and reports matched terms", () => {
    const current = doc("current.md", { title: "机器学习", summary: "transformer model" });
    const relevant = doc("relevant.md", { title: "机器学习 transformer", summary: "model" });
    const irrelevant = doc("other.md", { title: "园艺花草" });
    const results = findRelatedNotes([irrelevant, relevant], current);
    expect(results[0].path).toBe("relevant.md");
    expect(results[0].matchedTerms).toEqual(expect.arrayContaining(["机器", "学习", "transformer", "model"]));
    expect(results[0].reasons).toContain("lexical-overlap");
  });

  it("uses direct, shared, unresolved, and co-linked graph evidence", () => {
    const current = doc("current.md", { outLinks: ["target.md", "shared.md"], inLinks: ["index.md"], unresolvedTargets: ["Missing topic"] });
    const direct = doc("direct.md", { outLinks: ["current.md"] });
    const shared = doc("shared-note.md", { outLinks: ["shared.md"], unresolvedTargets: ["Missing topic"] });
    const co = doc("co.md", { inLinks: ["index.md"] });
    const results = findRelatedNotes([direct, shared, co], current, { minScore: 0 });
    expect(results.find((item) => item.path === "direct.md")?.reasons).toContain("direct-link");
    expect(results.find((item) => item.path === "shared-note.md")?.reasons).toContain("shared-target");
    expect(results.find((item) => item.path === "shared-note.md")?.reasons).toContain("shared-unresolved");
    expect(results.find((item) => item.path === "co.md")?.reasons).toContain("co-linked");
  });
  it("counts duplicate links between a pair once", () => {
    const current = doc("current.md", { outLinks: ["target.md", "target.md"] });
    const duplicated = doc("duplicated.md", { outLinks: ["target.md", "target.md"] });
    const single = doc("single.md", { outLinks: ["target.md"] });
    const results = findRelatedNotes([current, duplicated, single], current, { minScore: 0 });
    expect(results.find((item) => item.path === "duplicated.md")?.score).toBe(results.find((item) => item.path === "single.md")?.score);
  });
  it("downweights known generated person and todo-card targets versus user links", () => {
    const current = doc("current.md", { outLinks: ["QnALog/People/Ada.md", "topic.md"], generatedOutLinks: ["QnALog/People/Ada.md"] });
    const generated = doc("generated.md", { outLinks: ["QnALog/People/Ada.md"], generatedOutLinks: ["QnALog/People/Ada.md"] });
    const handwritten = doc("handwritten.md", { outLinks: ["topic.md"] });
    const results = findRelatedNotes([generated, handwritten], current, { minScore: 0 });
    expect(results.find((item) => item.path === "generated.md")?.score).toBeLessThan(results.find((item) => item.path === "handwritten.md")?.score ?? 0);
  });
  it("allows link-only retrieval but keeps ubiquitous targets below the default floor", () => {
    const current = doc("current.md", { unresolvedTargets: ["same-topic"] });
    const linked = doc("linked.md", { unresolvedTargets: ["same-topic"] });
    const context = [current, linked, ...Array.from({ length: 6 }, (_, index) => doc(`context-${index}.md`))];
    expect(findRelatedNotes(context, current)[0]?.reasons).toContain("link-only");
    expect(findRelatedNotes(context, current, { minScore: 100 })).toEqual([]);
    const ubiquitous = doc("ubiquitous.md", { outLinks: ["index.md"] });
    const strangers = Array.from({ length: 6 }, (_, index) => doc(`noise-${index}.md`, { outLinks: ["index.md"] }));
    expect(findRelatedNotes([ubiquitous, ...strangers], current).some((item) => item.path === "ubiquitous.md")).toBe(false);
  });

  it("applies limits and minimum score, excludes current/source duplicates/merge notes and collapses duplicate IDs", () => {
    const current = doc("current.md", { sourceId: "current", title: "planning roadmap" });
    const corpus = [
      current,
      doc("same-source.md", { sourceId: "current", title: "planning roadmap" }),
      doc("old.md", { sourceId: "duplicate", title: "planning roadmap", timestamp: 1 }),
      doc("new.md", { sourceId: "duplicate", title: "planning roadmap", timestamp: 2 }),
      doc("merge.md", { title: "planning roadmap", isMergeNote: true }),
      doc("unrelated.md", { title: "flowers" }),
    ];
    const results = findRelatedNotes(corpus, current, { limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("new.md");
    expect(findRelatedNotes(corpus, current, { minScore: 1000 })).toEqual([]);
    expect(findRelatedNotes(corpus, current, { limit: 0 })).toEqual([]);
  });

  it("retains direct-link candidates and orders ties by recency", () => {
    const current = doc("current.md", { title: "common project", outLinks: ["excluded.md"] });
    const directlyLinked = doc("excluded.md", { title: "common project" });
    const old = doc("old.md", { title: "common project", timestamp: 1 });
    const recent = doc("recent.md", { title: "common project", timestamp: 2 });
    const results = findRelatedNotes([old, directlyLinked, recent], current);
    expect(results.map(({ path }) => path)).toEqual(["excluded.md", "recent.md", "old.md"]);
    expect(results[0].reasons).toContain("direct-link");
  });
  it("recalls a legacy note from its body when structured fields are absent", () => {
    const current = doc("current.md", { title: "机器学习模型" });
    const legacy = doc("legacy.md", { title: "Untitled", bodyExcerpt: "机器学习模型推理方案", precision: "body-only" });
    expect(findRelatedNotes([legacy], current).map((item) => item.path)).toEqual(["legacy.md"]);
  });
  it("meets the shared synthetic fixture's recall@5 threshold and link scenarios", () => {
    const fixture = createRelatedNoteEvalFixture();
    const corpus = fixture.corpus as RelatedNoteDocument[];
    let correct = 0, expected = 0;
    for (const group of fixture.goldGroups) for (const currentPath of group) {
      const current = corpus.find((item) => item.path === currentPath)!;
      const results = findRelatedNotes(corpus, current, { limit: 5 });
      const desired = group.filter((item) => item !== currentPath);
      expected += desired.length;
      correct += results.filter((item) => desired.includes(item.path)).length;
    }
    // At least 17 of 18 relevant pairs must survive the top-five cutoff despite six distractors.
    expect(correct / expected).toBeGreaterThanOrEqual(0.9);
    const [pathA, pathB, pathC, pathD, pathE, pathF] = fixture.linkPaths;
    const noteA = corpus.find((item) => item.path === pathA)!;
    const noteB = corpus.find((item) => item.path === pathB)!;
    const noteC = corpus.find((item) => item.path === pathC)!;
    const noteD = corpus.find((item) => item.path === pathD)!;
    const noteE = corpus.find((item) => item.path === pathE)!;
    const noteF = corpus.find((item) => item.path === pathF)!;
    expect(findRelatedNotes(corpus, noteA).find((item) => item.path === pathB)?.reasons).toEqual(expect.arrayContaining(["shared-unresolved", "link-only"]));
    expect(findRelatedNotes(corpus, noteC).some((item) => item.path === pathD)).toBe(false);
    expect(findRelatedNotes(corpus, noteE).find((item) => item.path === pathF)?.reasons).toContain("direct-link");
    expect(noteE.inLinks).not.toContain("derived.md");
  });
});
