import { describe, expect, it } from "vitest";
import {
  applyTopicOps,
  createTopicPage,
  parseTopicPage,
  serializeTopicPage,
  hashTopicPage,
  stableTopicBlockId,
  TOPIC_SECTIONS,
  updateTopicFrontmatter,
  type TopicOperation,
} from "../src/topics/topic-page";

describe("topic pages", () => {
  it("round-trips page metadata and sections through serialization", () => {
    const page = createTopicPage({
      id: "topic-42",
      title: "Shared planning",
      tags: ["planning", "climate", "planning"],
      members: [
        { path: "QnALog/one.md", title: "First note", sourceId: "one" },
        { path: "QnALog/two.MD", title: "Second note", sourceId: "two" },
      ],
      basis: "body",
      created: "2026-03-01",
      updated: "2026-03-02",
    });
    page.excluded = ["QnALog/old.md"];
    page.body += "- A sentence worth keeping.\n";

    const markdown = serializeTopicPage(page);
    const parsed = parseTopicPage(markdown, "fallback.md");
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      id: page.id,
      title: page.title,
      tags: ["planning", "climate"],
      members: ["QnALog/one.md", "QnALog/two.md"],
      memberLinks: ["[[QnALog/one|First note]]", "[[QnALog/two|Second note]]"],
      excluded: page.excluded,
      basis: page.basis,
      created: page.created,
      updated: page.updated,
    });
    for (const section of TOPIC_SECTIONS) expect(parsed?.body).toContain(`## ${section} /`);
    expect(parsed?.body).toContain("- A sentence worth keeping.");
    expect(parseTopicPage("# not a topic", "folder/name.md")).toBeNull();
  });
  it("parses and safely replaces user-edited block-style frontmatter lists", () => {
    const page = createTopicPage({ id: "yaml-topic", title: "YAML topic", tags: [], members: [], basis: "overview" });
    const yaml = serializeTopicPage(page)
      .replace('qnalog_topic_tags: []', 'qnalog_topic_tags:\n  - "one"\n  - "two"')
      .replace('qnalog_topic_members: []', 'qnalog_topic_members:\n  - "[[Notes/a|A]]"\n  - "[[Notes/b|B]]"');
    expect(parseTopicPage(yaml)).toMatchObject({ tags: ["one", "two"], members: ["Notes/a.md", "Notes/b.md"] });
    const updated = updateTopicFrontmatter(yaml, { qnalog_topic_tags: ["replacement"] });
    expect(parseTopicPage(updated)?.tags).toEqual(["replacement"]);
    expect(updated).not.toContain('  - "one"');
    expect(updated).toContain('qnalog_topic_members:\n  - "[[Notes/a|A]]"');
  });

  it("creates stable block IDs and avoids existing-ID collisions", () => {
    const first = stableTopicBlockId("add_item", "note-a", "Same sentence", new Set());
    expect(first).toMatch(/^tpc-[\da-f]{6}$/);
    expect(stableTopicBlockId("add_item", "note-a", "Same sentence", new Set())).toBe(first);
    expect(stableTopicBlockId("add_item", "note-a", "Same sentence", new Set([first]))).not.toBe(first);
    expect(stableTopicBlockId("add_item", "note-a", "Same sentence", new Set([first]))).toBe(
      stableTopicBlockId("add_item", "note-a", "Same sentence", new Set([first])),
    );
    expect(stableTopicBlockId("add_item", "note-b", "Same sentence", new Set())).not.toBe(first);
  });

  it("applies each operation and routes missing targets to Unsorted", () => {
    const page = createTopicPage({ id: "ops", title: "Operations", tags: [], members: [], basis: "overview", created: "", updated: "" });
    const initial = serializeTopicPage(page);
    const add: TopicOperation = { type: "add_item", section: "当前状态", text: "A current fact", sourceId: "note-a" };
    const result = applyTopicOps(initial, [
      add,
      { type: "annotate_item", targetId: "missing", text: "Loose annotation", sourceId: "note-b" },
      { type: "add_conflict", text: "Two accounts differ", sourceId: "note-c", date: "2026-04-05" },
      { type: "resolve_question", targetId: "missing", text: "Loose resolution", sourceId: "note-d" },
      { type: "add_timeline", text: "Milestone", sourceId: "note-e", date: "2026-04-06" },
    ]);
    expect(result.applied).toHaveLength(5);
    expect(result.applied.map(({ location }) => location)).toEqual([
      "当前状态", "待整理", "分歧与待核实", "待整理", "时间线",
    ]);
    expect(result.applied.every(({ blockId }) => typeof blockId === "string")).toBe(true);
    expect(result.markdown).toContain("A current fact — 来源：[[note-a]]");
    expect(result.markdown).toContain("Loose annotation — 来源：[[note-b]]");
    expect(result.markdown).toContain("Two accounts differ — 来源：[[note-c]]");
    expect(result.markdown).toContain("Loose resolution — 来源：[[note-d]]");
    expect(result.markdown).toContain("2026-04-06 — Milestone — 来源：[[note-e]]");
    expect(result.markdown).toContain("2026-04-05 — Two accounts differ");
  });

  it("annotates and resolves an existing block without changing its sentence", () => {
    const page = createTopicPage({ id: "target", title: "Targets", tags: [], members: [], basis: "overview", created: "", updated: "" });
    page.body = page.body.replace("## 当前状态 / Current status", "## 当前状态 / Current status\n- [ ] Keep this exact sentence. ^tpc-a1b2c3");
    const source = serializeTopicPage(page);
    const result = applyTopicOps(source, [
      { type: "annotate_item", targetId: "^tpc-a1b2c3", text: "Supporting detail", sourceId: "note-x" },
      { type: "resolve_question", targetId: "tpc-a1b2c3", text: "Resolution detail", sourceId: "note-y" },
    ]);
    expect(result.applied.map(({ blockId, location }) => [blockId, location])).toEqual([
      ["tpc-a1b2c3", "当前状态"], ["tpc-a1b2c3", "当前状态"],
    ]);
    expect(result.markdown).toContain("- [ ] Keep this exact sentence. ^tpc-a1b2c3");
    expect(result.markdown).toContain("  - Supporting detail — 来源：[[note-x]]");
    expect(result.markdown).toContain("  - Resolution detail — 来源：[[note-y]]");
  });

  it("tolerates pages with missing sections and preserves original sentences", () => {
    const originalLines = ["- Original sentence one, with punctuation!", "- Original sentence two: exactly as written."];
    const markdown = `---\nqnalog_type: "qnalog-topic"\nqnalog_topic_id: "partial"\n---\n# Partial\n\n## 当前状态 / Current status\n${originalLines.join("\n")}`;
    const result = applyTopicOps(markdown, [
      { type: "add_item", section: "当前状态", text: "Inserted fact", sourceId: "note-z" },
      { type: "add_timeline", text: "Inserted event", sourceId: "note-z", date: "2026-04-07" },
    ]);
    for (const line of originalLines) expect(result.markdown).toContain(line);
    for (const section of TOPIC_SECTIONS) expect(result.markdown).toContain(`## ${section} /`);
    expect(result.markdown).toContain("Inserted fact — 来源：[[note-z]]");
    expect(result.markdown).toContain("2026-04-07 — Inserted event");
  });

  it("adds a timeline date once when the model includes the same prefix", () => {
    const page = createTopicPage({ id: "dated", title: "Dated", tags: [], members: [], basis: "overview", created: "", updated: "" });
    const result = applyTopicOps(serializeTopicPage(page), [{ type: "add_timeline", text: "2026-10-01 — Event happened", date: "2026-10-01", sourceId: "note" }]);
    expect(result.markdown.match(/2026-10-01/g)).toHaveLength(1);
    expect(result.markdown).toContain("2026-10-01 — Event happened");
  });

  it("round-trips topic tag aliases in frontmatter", () => {
    const page = createTopicPage({ id: "alias", title: "Aliases", tags: ["项目/QALog"], members: [], basis: "overview", created: "", updated: "" });
    page.tagAliases = { "项目/QALog": ["项目/QALog", "项目/QnALog"] };
    expect(parseTopicPage(serializeTopicPage(page))?.tagAliases).toEqual(page.tagAliases);
  });

  it("preserves original page lines as an ordered subsequence for generated pages and operations", () => {
    for (let seed = 0; seed < 32; seed++) {
      let state = seed + 1;
      const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state; };
      const blockId = `tpc-${next().toString(16).padStart(8, "0").slice(0, 6)}`;
      const sentences = Array.from({ length: next() % 5 + 1 }, (_, index) => `- User sentence ${seed}-${index}: preserve exactly${index === 0 ? ` ^${blockId}` : ""}`);
      const page = createTopicPage({ id: `generated-${seed}`, title: `Generated ${seed}`, tags: [], members: [], basis: "overview", created: "", updated: "" });
      const section = TOPIC_SECTIONS[next() % TOPIC_SECTIONS.length];
      page.body = `${page.body}\n## User-owned section ${seed}\n\n- User-specific paragraph ${seed}\n`;
      const sectionHeading = `## ${section} /`;
      page.body = page.body.replace(sectionHeading, `${sectionHeading}\n${sentences.join("\n")}`);
      const source = serializeTopicPage(page);
      const originalLines = source.split("\n");
      const operations: TopicOperation[] = [
        { type: "add_item", section, text: `Generated fact ${next()}`, sourceId: `source-${seed}` },
        { type: "annotate_item", targetId: blockId, text: `New supporting detail ${next()}`, sourceId: `source-${seed}` },
        { type: "add_conflict", text: `Generated conflict ${next()}`, sourceId: `source-${seed}`, date: `2026-05-${String(seed + 1).padStart(2, "0")}` },
      ];
      const result = applyTopicOps(source, operations);
      expect(result.applied.map(({ operation }) => operation.type)).toEqual(["add_item", "annotate_item", "add_conflict"]);
      const updatedLines = result.markdown.split("\n");
      let cursor = 0;
      for (const line of originalLines) {
        const foundAt = updatedLines.indexOf(line, cursor);
        expect(foundAt, `seed ${seed} lost or reordered original line: ${line}`).toBeGreaterThanOrEqual(cursor);
        cursor = foundAt + 1;
      }
    }
  });
  it("persists an edit-detection hash that ignores only its own metadata field", () => {
    const page = createTopicPage({ id: "hash-topic", title: "Hash topic", tags: [], members: [], basis: "overview" });
    const markdown = serializeTopicPage(page);
    const initialHash = hashTopicPage(markdown);
    const withAppliedHash = updateTopicFrontmatter(markdown, { qnalog_topic_hash: initialHash });
    expect(hashTopicPage(withAppliedHash)).toBe(initialHash);
    expect(parseTopicPage(withAppliedHash)?.appliedHash).toBe(initialHash);
    expect(hashTopicPage(withAppliedHash.replace("Hash topic", "User-edited title"))).not.toBe(initialHash);
  });
});
