import { describe, expect, it } from "vitest";
import { buildRelatedNotesCorpus, RelatedNotesCorpusCache, RELATED_NOTE_AUDIO_EXTENSIONS } from "../src/indexing/related-notes-corpus";
import type { RelatedNotesCorpusPort } from "../src/indexing/related-notes-corpus";

function makePort(): RelatedNotesCorpusPort {
  const files = [
    { path: "QnALog/Notes/one.md", basename: "one.md", mtime: 1 },
    { path: "QnALog/Notes/two.md", basename: "two.md", mtime: 2 },
    { path: "QnALog/Notes/· Merge.md", basename: "· Merge.md", mtime: 3 },
    { path: "QnALog/Notes/derived.md", basename: "derived.md", mtime: 4 },
    { path: "QnALog/Notes/old.md", basename: "old.md", mtime: 7 },
    { path: "QnALog/Notes/legacy-host.md", basename: "legacy-host.md", mtime: 9 },
    { path: "QnALog/Notes/legacy-derived.md", basename: "legacy-derived.md", mtime: 10 },
    { path: "QnALog/Notes/AI视频制作-分镜坐标系规范.md", basename: "AI视频制作-分镜坐标系规范.md", mtime: 8 },
    { path: "QnALog/Notes/topic-page.md", basename: "topic-page.md", mtime: 11 },
    { path: "QnALog/Notes/.versions/cache.md", basename: "cache.md", mtime: 6 },
  ];
  const contents: Record<string, string> = {
    "QnALog/Notes/one.md": "# One\n[[two]] [[Mira]] [[voice.m4a]] [[.versions/cache]] [[One]] [[Topic missing]]\nThe primary note records the linked subject, decisions, participants, and why the work changed. This body has enough authored context to be included in related-note searches.",
    "QnALog/Notes/two.md": "# Two\n[[one]]\nThis separate note contains enough authored context to remain available for retrieval alongside another note. It gives a clear explanation of its subject and conclusions.",
    "QnALog/Notes/· Merge.md": "# Merge\n<!-- qnalog-merge {\"sources\":[]} qnalog-merge-end -->",
    "QnALog/Notes/derived.md": "---\nqnalog_contains_raw: false\nqnalog_source_path: QnALog/Notes/one.md\n---\n[[one]]",
    "QnALog/Notes/old.md": "# Older note\nA body-only content source with enough text for the retrieval fallback. It contains an older observation and remains available without a structured note-index card.",
    "QnALog/Notes/legacy-host.md": "# Legacy host\nThis original note provides enough authored context for indexing and must remain the representative source when a newer derived copy has the same source identity.",
    "QnALog/Notes/legacy-derived.md": "# Legacy derived copy\nThis content belongs to a derived copy and should not be read into the source corpus.",
    "QnALog/Notes/AI视频制作-分镜坐标系规范.md": "# AI video production coordinate system\n<!-- qnalog-transcript-start:old -->\nTranscript content is intentionally long but belongs to a transcript ledger rather than the authored note body, so it must not rescue this short orphan note.\n<!-- qnalog-transcript-end:old -->",
    "QnALog/Notes/topic-page.md": "---\nqnalog_type: qnalog-topic\n---\n# Topic\nA topic page is not an original-note corpus member.",
  };
  return {
    listNoteFiles: () => files,
    getFrontmatter: (notePath) => {
      if (notePath.includes("/.versions/")) throw new Error("Excluded folder metadata was read");
      if (notePath === "QnALog/People/Mira.md") return { qnalog_type: "qnalog-person" };
      if (notePath.endsWith("topic-page.md")) return { qnalog_type: "qnalog-topic" };
      if (notePath.endsWith("legacy-host.md")) return { qnalog_source_id: "legacy-session" };
      if (notePath.endsWith("legacy-derived.md")) return {
        "类型": "QnALog派生版本",
        variant_kind: "minutes",
        source_path: "QnALog/Notes/legacy-host.md",
        source_id: "legacy-session",
        contains_raw: false,
      };
      return notePath.endsWith("derived.md") ? { qnalog_source_path: "QnALog/Notes/one.md" } : {};
    },
    getResolvedLinks: () => ({ "QnALog/Notes/one.md": { "QnALog/Notes/two.md": 2, "QnALog/People/Mira.md": 1, "QnALog/Notes/derived.md": 1, "QnALog/Notes/legacy-derived.md": 1, "QnALog/Notes/· Merge.md": 1, "QnALog/Audio/voice.m4a": 1, "QnALog/Notes/.versions/cache.md": 1, "QnALog/Notes/one.md": 1 }, "QnALog/Notes/two.md": { "QnALog/Notes/one.md": 1 } }),
    readText: async (notePath) => contents[notePath] || "",
    getUnresolvedLinks: () => ({ "QnALog/Notes/one.md": { "Topic missing": 1 } }),
    now: () => 10,
  };
}

describe("related note corpus", () => {
  it("uses configured note roots, filters merge/derived notes, excludes link noise and builds reverse links", async () => {
    const result = await buildRelatedNotesCorpus(makePort(), { roots: ["QnALog/Notes"] });
    expect(result.documents.map((doc) => doc.path)).toEqual(["QnALog/Notes/one.md", "QnALog/Notes/two.md", "QnALog/Notes/old.md", "QnALog/Notes/legacy-host.md"]);
    expect(result.documents.find((doc) => doc.path.endsWith("old.md"))?.precision).toBe("body-only");
    expect(result.documents.find((doc) => doc.path.endsWith("legacy-host.md"))?.sourceId).toBe("legacy-session");
    expect(result.documents[0].unresolvedTargets).toEqual(["topic missing"]);
    expect(result.documents[0].inLinks).toContain("QnALog/Notes/two.md");
    expect(result.documents[0].generatedOutLinks).toEqual(["QnALog/People/Mira.md"]);
    expect(result.documents[0].outLinks).not.toContain("QnALog/Notes/derived.md");
    expect(result.documents[0].outLinks).not.toContain("QnALog/Notes/legacy-derived.md");
    expect(result.documents[0].outLinks).not.toContain("QnALog/Notes/· Merge.md");
    expect(result.stats.excludedDerived).toBe(2);
    expect(result.stats.excludedDerivedLegacyAliases).toBe(1);
    expect(result.stats.excludedMerge).toBe(1);
    expect(result.stats.tooShort).toBe(1);
    expect(result.excludedTooShortPaths).toEqual(["QnALog/Notes/AI视频制作-分镜坐标系规范.md"]);
    expect(result.stats.noOutgoingLinks).toBe(2);
    expect(RELATED_NOTE_AUDIO_EXTENSIONS.has("m4a")).toBe(true);
  });

  it("invalidates cached documents on mtime changes and explicit invalidation", async () => {
    let mtime = 1;
    let builds = 0;
    const paths = ["a.md"];
    const cache = new RelatedNotesCorpusCache(async () => { builds++; return [{ path: "a.md", sourceId: "a", title: "a", timestamp: 1, tags: [], people: [], topics: [], summary: "", decisions: [], actions: [], questions: [], bodyExcerpt: "", outLinks: [], inLinks: [], inLinkOutDegrees: {}, unresolvedTargets: [], precision: "body-only", hasIndexCard: true }]; }, (path) => path === "a.md" ? mtime : null, () => paths);
    await cache.get(); await cache.get();
    expect(builds).toBe(1);
    mtime++;
    await cache.get();
    expect(builds).toBe(2);
    cache.invalidate("a.md"); await cache.get();
    expect(builds).toBe(3);
    paths.push("b.md");
    await cache.get();
    expect(builds).toBe(4);
    cache.invalidate(); await cache.rebuild();
    expect(builds).toBe(5);
});
});
