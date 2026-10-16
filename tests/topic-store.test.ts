import { describe, expect, it } from "vitest";
import { TopicStore, type TopicStorePort } from "../src/topics/topic-store";
import { buildTopicBlockIndex, createTopicPage, hashTopicPage, parseTopicPageBlocks, renderTopicPage, serializeTopicPage, topicMemberMetadataCounts, type TopicPage, type TopicPageV2Model } from "../src/topics/topic-page";
import type { TopicChangePreview } from "../src/topics/topic-integration";

class MemoryPort implements TopicStorePort {
  processCalls: string[] = [];
  files = new Map<string, string>();
  trashed: string[] = [];
  historyDeletes: string[] = [];
  creates: string[] = [];
  clock = 1000;
  onProcess?: (path: string) => void;
  read(path: string): Promise<string> { const value = this.files.get(path); if (value === undefined) throw new Error(`missing ${path}`); return Promise.resolve(value); }
  async create(path: string, content: string): Promise<void> { this.files.set(path, content); this.creates.push(path); }
  async readCache(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async writeCache(path: string, content: string): Promise<void> { this.files.set(path, content); }
  async deleteCache(path: string): Promise<void> { this.files.delete(path); }
  async readMemberTags(_paths: readonly string[]): Promise<string[]> { return []; }
  async process(path: string, transform: (content: string) => string): Promise<void> {
    this.processCalls.push(path);
    this.onProcess?.(path);
    const current = await this.read(path);
    this.files.set(path, transform(current));
  }
  async listMarkdown(folder: string): Promise<Array<{ path: string; name: string }>> {
    return [...this.files.keys()].filter((path) => path.startsWith(`${folder}/`) && path.endsWith(".md")).map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1) }));
  }
  async ensureFolder(_path: string): Promise<void> {}
  async deleteHistory(path: string): Promise<void> { this.historyDeletes.push(path); this.files.delete(path); }
  async trashFile(path: string): Promise<void> { this.trashed.push(path); this.files.delete(path); }
  now(): number { return this.clock++; }
}
const page = (id: string, title = id, tags: string[] = [], members: string[] = []): TopicPage => createTopicPage({ id, title, tags, basis: "overview", members: members.map((path) => ({ path, title: path, sourceId: path })), created: "2025-01-01", updated: "2025-01-01" });
const preview = (id: string, expectedHash: string, text = "Evidence supports the plan."): TopicChangePreview => ({
  topicId: id, expectedHash, pageWasManuallyEdited: false, completedBatches: 1, totalBatches: 1,
  items: [{ id: "add", type: "add_item", operation: { type: "add_item", section: "概要", text, sourceId: "source-id" }, target: "概要", text, sourceId: "source-id", cancellable: true }],
});
const setup = (id = "topic") => {
  const port = new MemoryPort();
  const store = new TopicStore({ folder: "Topics", port });
  const markdown = serializeTopicPage(page(id));
  port.files.set(`Topics/${id}.md`, markdown);
  return { port, store, path: `Topics/${id}.md`, markdown };
};
const expectNoLegacyV2Headings = (markdown: string) => {
  for (const heading of ["## 概要 / Overview", "## 当前状态 / Current status", "## 分歧与待核实 / Disagreements and verification", "## 未决问题与未完成行动 / Open questions and actions", "## 待整理 / Unsorted"]) {
    expect(markdown).not.toContain(heading);
  }
};

describe("topic store", () => {
  it("snapshots and applies via process read-modify-write, reapplying after an in-flight change", async () => {
    const { port, store, path, markdown } = setup();
    const outsider = markdown.replace("# topic", "# concurrently edited");
    let injected = false;
    port.onProcess = (target) => { if (target === path && !injected) { injected = true; port.files.set(path, outsider); } };
    const result = await store.apply(path, preview("topic", "stale-hash"), ["add"]);
    expect(injected).toBe(true);
    expect(result.pageChangedDuringGeneration).toBe(true);
    expect(result.markdown).toContain("# concurrently edited");
    expect(result.markdown).toContain("Evidence supports the plan.");
    expect(port.creates.filter((item) => item.includes("topic-history"))).toHaveLength(2);
    expect(port.files.get(path)).toBe(result.markdown);
  });

  it("retains five snapshots and guards undo against intervening edits", async () => {
    const { port, store, path } = setup();
    for (let index = 0; index < 6; index++) await store.apply(path, preview("topic", "ignored", `Evidence supports plan ${index}.`), ["add"]);
    const history = [...port.files.keys()].filter((item) => item.includes("topic-history/") && item.endsWith(".md"));
    expect(history).toHaveLength(5);
    expect(port.historyDeletes).toHaveLength(1);
    port.files.set(path, `${port.files.get(path)}\nmanual edit`);
    expect(await store.undoLastUpdate("topic")).toEqual({ restored: false, reason: "page-modified" });
  });

  it("undoes an unchanged application after store reconstruction and deletes only the topic page", async () => {
    const { port, store, path, markdown } = setup();
    await store.apply(path, preview("topic", "ignored"), ["add"]);
    const reloadedStore = new TopicStore({ folder: "Topics", port });
    expect(await reloadedStore.undoLastUpdate("topic")).toEqual({ restored: true });
    expect(port.files.get(path)).toBe(markdown);
    const historyBefore = [...port.files.keys()].filter((item) => item.includes("topic-history/"));
    await reloadedStore.deleteTopic("topic");
    expect(port.trashed).toEqual([path]);
    expect([...port.files.keys()].some((item) => item.includes("topic-index/topic.json"))).toBe(false);
    expect(historyBefore.every((item) => port.files.has(item))).toBe(true);
  });

  it("binds undo errata to the matching snapshot and clears that record when a later update replaces it", async () => {
    const { port, store } = setup();
    const first = await store.apply("Topics/topic.md", preview("topic", "ignored", "First update."), ["add"]);
    const entry = { path: "QnALog/勘误表/topic · 主题勘误.md", description: "Off-topic aspect", memberLink: "Notes/a" };
    await store.recordSnapshotErrata("topic", first.snapshotPath, [entry]);
    const cachePath = "QnALog/.cache/topic-index/topic.json";
    expect(JSON.parse(port.files.get(cachePath) || "{}").lastSnapshotErrata).toEqual({ snapshotPath: first.snapshotPath, entries: [entry] });

    const second = await store.apply("Topics/topic.md", preview("topic", "ignored", "Second update."), ["add"]);
    expect(second.snapshotPath).not.toBe(first.snapshotPath);
    expect(JSON.parse(port.files.get(cachePath) || "{}").lastSnapshotErrata).toBeUndefined();
    await store.recordSnapshotErrata("topic", first.snapshotPath, [entry]);
    expect(JSON.parse(port.files.get(cachePath) || "{}").lastSnapshotErrata).toBeUndefined();
  });

  it("returns snapshot errata only after a successful page restoration", async () => {
    const { store } = setup();
    const result = await store.apply("Topics/topic.md", preview("topic", "ignored"), ["add"]);
    const entry = { path: "QnALog/勘误表/topic · 主题勘误.md", description: "Off-topic aspect", memberLink: null };
    await store.recordSnapshotErrata("topic", result.snapshotPath, [entry]);
    expect(await store.undoLastUpdate("topic")).toEqual({ restored: true, errataEntries: [entry] });
  });

  it("snapshots block removals and restores the page on undo", async () => {
    const { port, store, path } = setup("remove");
    const model: TopicPageV2Model = { overview: "Overview.", threads: [{ id: "work", title: "Work", summary: "Current work summary.", points: [{ id: "point", text: "Off-topic device repair detail.", sources: ["Notes/a.md"] }] }], disagreements: [], open: [], unsorted: [] };
    const topic = page("remove", "Remove", [], ["Notes/a.md"]);
    topic.layout = 2;
    topic.body = renderTopicPage(model, [{ path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" }]);
    const initial = serializeTopicPage(topic);
    port.files.set(path, initial);
    const block = parseTopicPageBlocks(initial).find((item) => item.text.includes("Off-topic device repair"))!;
    const operation = { type: "remove_block" as const, blockId: block.id, expectedText: block.text, sourceId: "Notes/a.md" };
    const change: TopicChangePreview = { topicId: "remove", expectedHash: hashTopicPage(initial), pageWasManuallyEdited: false, items: [{ id: "remove", type: operation.type, operation, target: "Work", text: block.text, sourceId: operation.sourceId, expectedText: block.text, cancellable: true }], completedBatches: 0, totalBatches: 0 };
    const applied = await store.apply(path, change, ["remove"]);
    expect(applied.markdown).not.toContain("Off-topic device repair");
    expect((await store.undoLastUpdate("remove")).restored).toBe(true);
    expect(port.files.get(path)).toBe(initial);
  });

  it("skips a changed summary block while applying other changes and updates generated sources and timeline", async () => {
    const port = new MemoryPort();
    const store = new TopicStore({ folder: "Topics", port });
    const model: TopicPageV2Model = { overview: "The project is testing the new storage path.", threads: [], disagreements: [], open: [], unsorted: [] };
    const page = createTopicPage({ id: "v2", title: "V2", tags: [], basis: "overview", members: [{ path: "Notes/old.md", title: "Old", sourceId: "old", date: "2026-09-27", summary: "The project began storage testing." }] });
    page.layout = 2;
    page.body = renderTopicPage(model, [{ path: "Notes/old.md", title: "Old", sourceId: "old", date: "2026-09-27", summary: "The project began storage testing." }]);
    const original = `${serializeTopicPage(page)}\n## 待整理\n\n用户自己补充的内容。`;
    const path = "Topics/V2.md";
    port.files.set(path, original);
    const overviewBlock = parseTopicPageBlocks(original).find((block) => block.type === "overview")!;
    const changed = original.replace("The project is testing the new storage path.", "A user changed this summary.");
    port.files.set(path, changed);
    const member = { path: "Notes/new.md", title: "New", sourceId: "new", date: "2026-10-03", summary: "The team added rollback checks." };
    const result = await store.apply(path, {
      topicId: "v2", expectedHash: hashTopicPage(original), pageWasManuallyEdited: false, completedBatches: 1, totalBatches: 1,
      newMembers: [member], memberLinks: ["[[Notes/old|Old]]", "[[Notes/new|New]]"],
      items: [
        { id: "revise", type: "revise_block", operation: { type: "revise_block", blockId: overviewBlock.id, expectedText: overviewBlock.text, newText: "A revised overview.", reason: "new evidence", sourceId: "new" }, target: overviewBlock.id, text: "A revised overview.", expectedText: overviewBlock.text, sourceId: "new", cancellable: true },
        { id: "open", type: "add_open", operation: { type: "add_open", kind: "action", text: "Run rollback checks.", sources: ["new"], sourceId: "new" }, target: "open", text: "Run rollback checks.", sourceId: "new", cancellable: true },
      ], sourceLinks: { new: "[[Notes/new|New]]" },
    }, ["revise", "open"]);
    expect(result.skipped).toEqual([{ id: overviewBlock.id, reason: "block-modified" }]);
    expect(result.markdown).toContain("A user changed this summary.");
    expect(result.markdown).toContain("Run rollback checks.");
    expect(result.markdown).toContain("2026-10-03 · [[Notes/new|New]]");
    expect(result.markdown).toMatch(/\[\^s[\da-f]{4}\]: \[\[Notes\/new\|New\]\]/);
    expect(topicMemberMetadataCounts(result.markdown)).toEqual({ members: 2, timeline: 2, sources: 2 });
    expectNoLegacyV2Headings(result.markdown);
    expect(result.markdown).toContain("## 待整理\n\n用户自己补充的内容。");
    expect(await store.undoLastUpdate("v2")).toEqual({ restored: true });
    expect(port.files.get(path)).toBe(changed);
    expectNoLegacyV2Headings(port.files.get(path) || "");
  });

  it("cleans an exact legacy status line after snapshot and restores it on undo", async () => {
    const { port, store, path, markdown } = setup("legacy-status");
    const legacy = `${markdown.replace("# legacy-status", "# legacy-status")}\n**状态**：进行中 · **最近更新** 2026-10-08 · 4篇笔记\n`;
    port.files.set(path, legacy);
    const result = await store.apply(path, {
      topicId: "legacy-status", expectedHash: hashTopicPage(legacy), pageWasManuallyEdited: false,
      legacyStatusCleanup: true, legacyStatusPrefixes: ["**状态**：", "**Status**: "],
      completedBatches: 1, totalBatches: 1, items: [],
    }, ["__clean-legacy-status__"]);
    expect(result.markdown).not.toContain("**状态**");
    expect(port.creates.some((item) => item.includes("topic-history"))).toBe(true);
    expect(await store.undoLastUpdate("legacy-status")).toEqual({ restored: true });
    expect(port.files.get(path)).toBe(legacy);
  });

  it("snapshots, clears, indexes, and undoes legacy v2 inline anchors", async () => {
    const port = new MemoryPort();
    const store = new TopicStore({ folder: "Topics", port });
    const topic = page("legacy-anchor", "Legacy anchor");
    topic.layout = 2;
    topic.body = "## 进展脉络\n\n### 线索\n一段摘要。 ^tpc-a1b2c3\n- 一条要点。 ^tpc-b2c3d4\n## 时间线\n";
    const original = serializeTopicPage(topic);
    const path = "Topics/Legacy anchor.md";
    port.files.set(path, original);
    const result = await store.apply(path, {
      topicId: topic.id, expectedHash: hashTopicPage(original), pageWasManuallyEdited: false,
      completedBatches: 1, totalBatches: 1, items: [], legacyAnchorCleanup: true,
    }, ["__clean-legacy-markers__"]);
    expect(result.markdown).not.toMatch(/\^tpc-/);
    expect(result.markdown).not.toContain("qnalog_topic_blocks:");
    expect(JSON.parse(port.files.get("QnALog/.cache/topic-index/legacy-anchor.json") || "{}").blocks.length).toBeGreaterThan(0);
    expect(port.creates.some((item) => item.includes("topic-history"))).toBe(true);
    expect(await store.undoLastUpdate(topic.id)).toEqual({ restored: true });
    expect(port.files.get(path)).toBe(original);
  });

  it("merges unique members and tags, records provenance, trashes source, and never writes source notes", async () => {
    const port = new MemoryPort();
    const store = new TopicStore({ folder: "Topics", port });
    const targetPath = "Topics/target.md", sourcePath = "Topics/source.md";
    port.files.set(targetPath, serializeTopicPage(page("target", "Target", ["shared", "target"], ["Notes/a.md", "Notes/b.md"])));
    port.files.set(sourcePath, serializeTopicPage(page("source", "Source", ["shared", "source"], ["Notes/b.md", "Notes/c.md"])));
    const sourceNote = "Source note contents";
    port.files.set("Notes/a.md", sourceNote);
    port.files.set("Notes/b.md", "Other note");
    port.files.set("Notes/c.md", "Another note");
    await store.mergeTopics("source", "target");
    const target = await store.read(targetPath);
    expect(target?.memberLinks).toEqual(["[[Notes/a|Notes/a.md]]", "[[Notes/b|Notes/b.md]]", "[[Notes/c|Notes/c.md]]"]);
    expect(target?.tags).toEqual(["shared", "target", "source"]);
    expect(port.files.get(targetPath)).toContain("已合并自 [[Topics/source|Source]]");
    expect(port.files.get(targetPath)).toContain("- [[Notes/c|Notes/c.md]]");
    expect(port.processCalls).toEqual([targetPath]);
    expect(port.trashed).toEqual([sourcePath]);
    expect(port.files.has("QnALog/.cache/topic-index/source.json")).toBe(false);
    expect(port.files.has("QnALog/.cache/topic-index/target.json")).toBe(true);
    expect(port.files.get("Notes/a.md")).toBe(sourceNote);
    expect(port.files.get("Notes/b.md")).toBe("Other note");
    expect(port.files.get("Notes/c.md")).toBe("Another note");
    expect(target?.appliedHash).toBeDefined();
    expect(target?.undoSnapshot).toContain("topic-history/target/");
    expect(port.files.has(target?.undoSnapshot || "")).toBe(true);
  });

  it("rebuilds missing, corrupt, and stale machine caches without changing the page", async () => {
    const { port, store, path } = setup("cache-rebuild");
    const original = port.files.get(path)!;
    const cachePath = "QnALog/.cache/topic-index/cache-rebuild.json";
    const keys = (value: string) => Object.keys(JSON.parse(value) as Record<string, unknown>).sort();
    expect(await store.read(path)).toMatchObject({ cacheStatus: "missing" });
    let cacheText = port.files.get(cachePath)!;
    expect(keys(cacheText)).toEqual(["blocks", "lastSnapshot", "pageHash", "tagAliases", "topicId", "updatedAt", "version"]);
    expect(JSON.parse(cacheText).blocks.length).toBe(0);
    expect(port.files.get(path)).toBe(original);

    port.files.set(cachePath, "not-json");
    expect(await store.read(path)).toMatchObject({ cacheStatus: "corrupt" });
    cacheText = port.files.get(cachePath)!;
    expect(JSON.parse(cacheText).topicId).toBe("cache-rebuild");

    port.files.set(path, original.replace("# cache-rebuild", "# Renamed by user"));
    const stalePage = port.files.get(path)!;
    expect(await store.read(path)).toMatchObject({ cacheStatus: "stale" });
    expect(port.files.get(path)).toBe(stalePage);
    expect(JSON.parse(port.files.get(cachePath)!).pageHash).not.toBe(hashTopicPage(stalePage));
  });

  it("writes only user-facing properties and moves index and aliases to cache", async () => {
    const port = new MemoryPort();
    const store = new TopicStore({ folder: "Topics", port });
    const topic = page("property-set", "Properties", ["项目/QnALog"]);
    topic.layout = 2;
    topic.tagAliases = { "项目/QnALog": ["项目/QnALog", "项目/Q&ALog"] };
    topic.body = renderTopicPage({ overview: "Overview.", threads: [{ id: "thread", title: "Progress", summary: "A useful summary.", points: [{ id: "point", text: "A useful point.", sources: [] }] }], disagreements: [], open: [], unsorted: [] }, []);
    const createdPath = await store.create(topic);
    const markdown = port.files.get(createdPath)!;
    const propertyKeys = markdown.match(/^([\w-]+):/gm)?.map((line) => line.slice(0, line.indexOf(":"))).sort();
    expect(propertyKeys).toEqual(["cssclasses", "qnalog_topic_basis", "qnalog_topic_created", "qnalog_topic_excluded", "qnalog_topic_id", "qnalog_topic_layout", "qnalog_topic_members", "qnalog_topic_tags", "qnalog_topic_updated", "qnalog_type"].sort());
    for (const key of ["qnalog_topic_tag_aliases", "qnalog_topic_blocks", "qnalog_topic_hash", "qnalog_topic_undo_snapshot"]) expect(markdown).not.toContain(`${key}:`);
    const cache = JSON.parse(port.files.get("QnALog/.cache/topic-index/property-set.json") || "{}") as { blocks: Array<{ normalizedPreview: string }>; tagAliases: Record<string, string[]> };
    expect(cache.blocks.length).toBeGreaterThan(0);
    expect(cache.blocks.every((block) => [...block.normalizedPreview].length <= 40)).toBe(true);
    expect(cache.tagAliases).toEqual(topic.tagAliases);
    expect(createdPath).toBe("Topics/Properties.md");
  });

  it("migrates legacy machine properties with a snapshot and undo while preserving the body", async () => {
    const { port, store, path } = setup("legacy-properties");
    const original = port.files.get(path)!;
    const legacy = original.replace("---\n", `---\nqnalog_topic_tag_aliases: ${JSON.stringify(JSON.stringify({ topic: ["topic"] }))}
qnalog_topic_blocks: ${JSON.stringify(JSON.stringify(buildTopicBlockIndex(original)))}
qnalog_topic_hash: "legacy-hash"
qnalog_topic_undo_snapshot: "QnALog/.cache/topic-history/legacy-properties/old.md"
`);
    port.files.set(path, legacy);
    const cachedPage = await store.read(path);
    expect(cachedPage?.legacyMachineProperties).toBe(true);
    const beforeBody = legacy.slice(legacy.indexOf("\n---\n") + 5);
    const result = await store.apply(path, { topicId: "legacy-properties", expectedHash: hashTopicPage(legacy), pageWasManuallyEdited: false, completedBatches: 0, totalBatches: 0, items: [], legacyPropertyCleanup: true }, ["__clean-legacy-properties__"]);
    expect(result.markdown.slice(result.markdown.indexOf("\n---\n") + 5)).toBe(beforeBody);
    for (const key of ["qnalog_topic_tag_aliases", "qnalog_topic_blocks", "qnalog_topic_hash", "qnalog_topic_undo_snapshot"]) expect(result.markdown).not.toContain(`${key}:`);
    expect(port.creates.some((item) => item.includes("topic-history/legacy-properties/"))).toBe(true);
    expect(await store.undoLastUpdate("legacy-properties")).toEqual({ restored: true });
    expect(port.files.get(path)).toBe(legacy);
  });
});
