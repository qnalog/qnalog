import { describe, expect, it } from "vitest";
import {
  applyTopicOps,
  appendTopicMemberMetadata,
  createTopicPage,
  parseTopicPage,
  serializeTopicPage,
  hashTopicPage,
  buildTopicBlockIndex,
  stableTopicBlockId,
  parseTopicPageBlocks,
  renderTopicPage,
  TOPIC_SECTIONS,
  updateTopicFrontmatter,
  topicMemberMetadataCounts,
  contributingMemberPaths,
  noContributionMembers,
  type TopicOperation,
} from "../src/topics/topic-page";

describe("topic pages", () => {
  const source = (title: string, day: string, id = title.toLowerCase().replace(/\W+/g, "-")) => ({
    path: `QnALog/${title}.md`, title, sourceId: id, date: day, summary: `${title} provides project context.`,
  });
  const memberFixture = () => {
    const members = [source("Middle note", "2026-09-30"), source("Last note", "2026-10-03")];
    const page = createTopicPage({ id: "metadata-location", title: "Metadata location", tags: [], members, basis: "overview" });
    page.layout = 2;
    page.body = renderTopicPage({ overview: "Overview.", threads: [], disagreements: [], open: [], unsorted: [] }, members);
    return { members, markdown: serializeTopicPage(page) };
  };
  const sectionLines = (markdown: string, heading: string) => {
    const lines = markdown.split("\n");
    const start = lines.findIndex((line) => line === `## ${heading}` || line.startsWith(`## ${heading} /`));
    const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
    return lines.slice(start + 1, end < 0 ? lines.length : end).filter(Boolean);
  };

  it("derives contributing members only from block-referenced footnotes", () => {
    const members = [source("Cited note", "2026-09-30", "cited"), source("Uncited note", "2026-10-01", "uncited")];
    const page = createTopicPage({ id: "contribution", title: "Contribution", tags: [], members, basis: "overview" });
    page.layout = 2;
    page.body = renderTopicPage({ overview: "Overview.", threads: [{ id: "thread", title: "Thread", summary: "Summary.", points: [
      { id: "point", text: "A fact from the cited note.", sources: ["cited"] },
    ] }], disagreements: [], open: [], unsorted: [] }, members);
    const markdown = serializeTopicPage(page);
    expect(contributingMemberPaths(markdown, page.members)).toEqual(new Set(["QnALog/Cited note.md"]));
    expect(noContributionMembers(page, markdown)).toEqual(["QnALog/Uncited note.md"]);

    const handEdited = markdown.replace("A fact from the cited note.", "A manually edited fact from the cited note.");
    expect(contributingMemberPaths(handEdited, page.members)).toEqual(new Set(["QnALog/Cited note.md"]));
  });

  it("does not count an unused source definition or judge v1 topic pages", () => {
    const members = [source("Only footnote", "2026-09-30", "only-footnote")];
    const page = createTopicPage({ id: "unused-definition", title: "Unused definition", tags: [], members, basis: "overview" });
    page.layout = 2;
    page.body = renderTopicPage({ overview: "Overview without citations.", threads: [], disagreements: [], open: [], unsorted: [] }, members);
    const markdown = serializeTopicPage(page).replace("## 来源笔记 / Source notes", "[^unused]: [[QnALog/Only footnote|Only footnote]]\n\n## 来源笔记 / Source notes");
    expect(contributingMemberPaths(markdown, page.members)).toEqual(new Set());
    expect(noContributionMembers(page, markdown)).toEqual(["QnALog/Only footnote.md"]);

    const legacy = createTopicPage({ id: "legacy", title: "Legacy", tags: [], members, basis: "overview" });
    expect(noContributionMembers(legacy, serializeTopicPage(legacy))).toEqual([]);
  });

  it.each([
    { name: "earliest", member: source("First note", "2026-09-20"), expected: ["First note", "Middle note", "Last note"] },
    { name: "middle", member: source("Between note", "2026-10-01"), expected: ["Middle note", "Between note", "Last note"] },
    { name: "latest", member: source("Final note", "2026-10-08"), expected: ["Middle note", "Last note", "Final note"] },
  ])("inserts a new member in date order when the date is $name", ({ member, expected }) => {
    const { members, markdown } = memberFixture();
    const updated = appendTopicMemberMetadata(markdown, [...members, member]);
    expect(sectionLines(updated, "时间线").map((line) => line.match(/\|([^\]]+)\]\]/)?.[1])).toEqual(expected);
    expect(sectionLines(updated, "来源笔记").map((line) => line.match(/\|([^\]]+)\]\]/)?.[1])).toEqual(["Middle note", "Last note", member.title].sort((a, b) => {
      const dates = new Map([["Middle note", "2026-09-30"], ["Last note", "2026-10-03"], [member.title, member.date]]);
      return dates.get(a)!.localeCompare(dates.get(b)!) || a.localeCompare(b);
    }));
    expect(topicMemberMetadataCounts(updated)).toEqual({ members: 3, timeline: 3, sources: 3 });
  });

  it("puts timeline rows before user prose and removes blank gaps between adjacent rows", () => {
    const { markdown } = memberFixture();
    const withUserText = markdown.replace("## 来源笔记", "A user note after the timeline.\n\n## 来源笔记").replace("- 2026-10-03", "\n\n- 2026-10-03");
    const updated = appendTopicMemberMetadata(withUserText, [source("Early note", "2026-09-15")]);
    const timeline = sectionLines(updated, "时间线");
    expect(timeline.slice(0, 3).every((line) => line.startsWith("- "))).toBe(true);
    expect(timeline.at(-1)).toBe("A user note after the timeline.");
    expect(timeline).not.toContain("");
  });

  it("repairs a missing source section and keeps two new members in both lists", () => {
    const { markdown } = memberFixture();
    const withoutSources = markdown.replace(/\n## 来源笔记[\s\S]*$/, "\nUser text at page end.\n\n");
    const members = [source("Newer note", "2026-10-05"), source("Earlier note", "2026-09-18")];
    const { members: existing } = memberFixture();
    const updated = appendTopicMemberMetadata(withoutSources, [...existing, ...members]);
    expect(updated).toContain("## 来源笔记");
    expect(sectionLines(updated, "来源笔记").map((line) => line.match(/\|([^\]]+)\]\]/)?.[1])).toEqual(["Earlier note", "Middle note", "Last note", "Newer note"]);
    expect(topicMemberMetadataCounts(updated)).toEqual({ members: 4, timeline: 4, sources: 4 });
    const timeline = sectionLines(updated, "时间线");
    expect(timeline.filter((line) => line.startsWith("- ")).slice(-2).map((line) => line.match(/\|([^\]]+)\]\]/)?.[1])).toEqual(["Last note", "Newer note"]);
  });

  it("repairs a missing timeline section at the page end without moving user text", () => {
    const { members, markdown } = memberFixture();
    const withoutTimeline = markdown.replace(/\n## 时间线[\s\S]*?(?=\n## 来源笔记)/, "\nUser-owned timeline note.");
    const updated = appendTopicMemberMetadata(withoutTimeline, [...members, source("Added note", "2026-10-04")]);
    expect(updated).toContain("User-owned timeline note.");
    expect(updated.indexOf("## 时间线 / Timeline")).toBeGreaterThan(updated.indexOf("## 来源笔记"));
    expect(sectionLines(updated, "时间线").filter((line) => line.startsWith("- "))).toHaveLength(3);
    expect(sectionLines(updated, "来源笔记").filter((line) => line.startsWith("[^s"))).toHaveLength(3);
    expect(topicMemberMetadataCounts(updated)).toEqual({ members: 3, timeline: 3, sources: 3 });
  });

  it("sorts same-day additions by title regardless of input order", () => {
    const { members, markdown } = memberFixture();
    const sameDay = [source("Zebra note", "2026-09-30"), source("Apple note", "2026-09-30")];
    const updated = appendTopicMemberMetadata(markdown, [...members, ...sameDay]);
    expect(sectionLines(updated, "时间线").slice(0, 3).map((line) => line.match(/\|([^\]]+)\]\]/)?.[1])).toEqual(["Apple note", "Middle note", "Zebra note"]);
  });

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

  it("stores v2 block addresses in the page property without inline anchors", () => {
    const body = renderTopicPage({ overview: "A useful overview.", status: "active", threads: [{ id: "t1", title: "Progress", summary: "A thread summary.", points: [{ id: "p1", text: "A point.", sources: [] }] }], disagreements: [], open: [], unsorted: [] }, []);
    const page = createTopicPage({ id: "indexed", title: "Indexed", tags: [], members: [], basis: "overview" });
    page.layout = 2;
    page.body = body;
    const rendered = serializeTopicPage(page);
    expect(rendered).not.toMatch(/\^tpc-/);
    expect(rendered).not.toContain("<!--");
    expect(rendered).not.toContain("%%");
    expect(rendered).not.toContain("qnalog_topic_blocks:");
    expect(buildTopicBlockIndex(rendered).length).toBeGreaterThan(0);
    expect(parseTopicPageBlocks(rendered).map((block) => block.type)).toContain("point");
  });

  it("locates edited and moved blocks by content and degrades after deletion", () => {
    const page = createTopicPage({ id: "locate", title: "Locate", tags: [], members: [], basis: "overview" });
    page.layout = 2;
    page.body = renderTopicPage({ overview: "Overview.", status: "active", threads: [{ id: "t1", title: "Progress", summary: "Summary.", points: [{ id: "p1", text: "A sufficiently descriptive original point.", sources: [] }] }], disagreements: [], open: [], unsorted: [] }, []);
    const original = serializeTopicPage(page);
    const index = buildTopicBlockIndex(original).find((block) => block.kind === "point");
    expect(index).toBeDefined();
    const bodyAt = original.indexOf("\n#");
    const edited = original.slice(0, bodyAt) + original.slice(bodyAt).replace("A sufficiently descriptive original point.", "A sufficiently descriptive original poinx.");
    expect(parseTopicPageBlocks(updateTopicFrontmatter(edited, { qnalog_topic_blocks: JSON.stringify([index]) })).some((block) => block.id === index?.id)).toBe(true);
    const moved = original.replace("### Progress", "### Another thread");
    expect(parseTopicPageBlocks(updateTopicFrontmatter(moved, { qnalog_topic_blocks: JSON.stringify([index]) })).some((block) => block.id === index?.id)).toBe(true);
    const deleted = original.replace("A sufficiently descriptive original point.", "");
    expect(parseTopicPageBlocks(updateTopicFrontmatter(deleted, { qnalog_topic_blocks: JSON.stringify([index]) })).filter((block) => block.id === index?.id)).toEqual([]);
  });

  it("cleans legacy v2 anchors and stores the refreshed index", () => {
    const page = createTopicPage({ id: "legacy-v2", title: "Legacy v2", tags: [], members: [], basis: "overview" });
    page.layout = 2;
    page.body = `## 进展脉络 / Progress thread\n\n### Progress\nA useful summary. ^tpc-a1b2c3\n- A useful point. ^tpc-b2c3d4\n`;
    const legacy = updateTopicFrontmatter(serializeTopicPage(page), { qnalog_topic_blocks: JSON.stringify(buildTopicBlockIndex(page.body)) });
    const cleaned = applyTopicOps(legacy, []).markdown;
    expect(cleaned).not.toMatch(/\^tpc-/);
    expect(cleaned).not.toContain("qnalog_topic_blocks:");
    expect(parseTopicPageBlocks(cleaned).map((block) => block.type)).toContain("point");
  });

  it("validates v2 revisions against indexed content without visible block IDs", () => {
    const page = createTopicPage({ id: "revise", title: "Revise", tags: [], members: [], basis: "overview" });
    page.layout = 2;
    page.body = renderTopicPage({ overview: "Overview.", status: "active", threads: [{ id: "t1", title: "Progress", summary: "A sufficiently long summary sentence.", points: [] }], disagreements: [], open: [], unsorted: [] }, []);
    const initial = serializeTopicPage(page);
    const block = parseTopicPageBlocks(initial).find((item) => item.type === "thread-summary");
    expect(block).toBeDefined();
    const result = applyTopicOps(initial, [{ type: "revise_block", blockId: block!.id, newText: "A sufficiently long revised sentence.", reason: "update", expectedText: block!.text, sourceId: "source" }]);
    expect(result.skipped).toEqual([]);
    expect(result.markdown).toContain("A sufficiently long revised sentence.");
    expect(result.markdown).not.toMatch(/\^tpc-/);
    const changed = applyTopicOps(initial.replace("A sufficiently long summary sentence.", "A user edit."), [{ type: "revise_block", blockId: block!.id, newText: "A sufficiently long revised sentence.", reason: "update", expectedText: block!.text, sourceId: "source" }]);
    expect(changed.skipped).toHaveLength(1);
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
    const add: TopicOperation = { type: "add_item", section: "进展脉络", text: "A current fact", sourceId: "note-a" };
    const result = applyTopicOps(initial, [
      add,
      { type: "annotate_item", targetId: "missing", text: "Loose annotation", sourceId: "note-b" },
      { type: "add_conflict", text: "Two accounts differ", sourceId: "note-c", date: "2026-04-05" },
      { type: "resolve_question", targetId: "missing", text: "Loose resolution", sourceId: "note-d" },
      { type: "add_timeline", text: "Milestone", sourceId: "note-e", date: "2026-04-06" },
    ]);
    expect(result.applied).toHaveLength(5);
    expect(result.applied.map(({ location }) => location)).toEqual([
      "进展脉络", "待整理", "分歧与待核实", "待整理", "时间线",
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
    page.body = page.body.replace("## 进展脉络 / Progress thread", "## 进展脉络 / Progress thread\n- [ ] Keep this exact sentence. ^tpc-a1b2c3");
    const source = serializeTopicPage(page);
    const result = applyTopicOps(source, [
      { type: "annotate_item", targetId: "^tpc-a1b2c3", text: "Supporting detail", sourceId: "note-x" },
      { type: "resolve_question", targetId: "tpc-a1b2c3", text: "Resolution detail", sourceId: "note-y" },
    ]);
    expect(result.applied.map(({ blockId, location }) => [blockId, location])).toEqual([
      ["tpc-a1b2c3", "进展脉络"], ["tpc-a1b2c3", "进展脉络"],
    ]);
    expect(result.markdown).toContain("- [ ] Keep this exact sentence. ^tpc-a1b2c3");
    expect(result.markdown).toContain("  - Supporting detail — 来源：[[note-x]]");
    expect(result.markdown).toContain("  - Resolution detail — 来源：[[note-y]]");
  });

  it("tolerates pages with missing sections and preserves original sentences", () => {
    const originalLines = ["- Original sentence one, with punctuation!", "- Original sentence two: exactly as written."];
    const markdown = `---\nqnalog_type: "qnalog-topic"\nqnalog_topic_id: "partial"\n---\n# Partial\n\n## 进展脉络 / Progress thread\n${originalLines.join("\n")}`;
    const result = applyTopicOps(markdown, [
      { type: "add_item", section: "进展脉络", text: "Inserted fact", sourceId: "note-z" },
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

  it("keeps topic tag aliases out of page properties", () => {
    const page = createTopicPage({ id: "alias", title: "Aliases", tags: ["项目/QALog"], members: [], basis: "overview", created: "", updated: "" });
    page.tagAliases = { "项目/QALog": ["项目/QALog", "项目/QnALog"] };
    expect(serializeTopicPage(page)).not.toContain("qnalog_topic_tag_aliases:");
    expect(parseTopicPage(serializeTopicPage(page))?.tagAliases).toEqual({});
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
