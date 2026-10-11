import { describe, expect, it } from "vitest";
import { TopicStore, type TopicStorePort } from "../src/topics/topic-store";
import { createTopicPage, hashTopicPage, parseTopicPageBlocks, renderTopicPage, serializeTopicPage, type TopicPage, type TopicPageV2Model } from "../src/topics/topic-page";
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
    expect(historyBefore.every((item) => port.files.has(item))).toBe(true);
  });

  it("skips a changed summary block while applying other changes and updates generated sources and timeline", async () => {
    const port = new MemoryPort();
    const store = new TopicStore({ folder: "Topics", port });
    const model: TopicPageV2Model = { overview: "The project is testing the new storage path.", status: "In progress", threads: [], disagreements: [], open: [], unsorted: [] };
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
        { id: "open", type: "add_open", operation: { type: "add_open", kind: "Action", text: "Run rollback checks.", sources: ["new"], sourceId: "new" }, target: "open", text: "Run rollback checks.", sourceId: "new", cancellable: true },
      ], sourceLinks: { new: "[[Notes/new|New]]" },
    }, ["revise", "open"]);
    expect(result.skipped).toEqual([{ id: overviewBlock.id, reason: "block-modified" }]);
    expect(result.markdown).toContain("A user changed this summary.");
    expect(result.markdown).toContain("Run rollback checks.");
    expect(result.markdown).toContain("2026-10-03 · [[Notes/new|New]]");
    expect(result.markdown).toMatch(/\[\^s[\da-f]{4}\]: \[\[Notes\/new\|New\]\]/);
    expectNoLegacyV2Headings(result.markdown);
    expect(result.markdown).toContain("## 待整理\n\n用户自己补充的内容。");
    expect(await store.undoLastUpdate("v2")).toEqual({ restored: true });
    expect(port.files.get(path)).toBe(changed);
    expectNoLegacyV2Headings(port.files.get(path) || "");
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
    expect(port.files.get("Notes/a.md")).toBe(sourceNote);
    expect(port.files.get("Notes/b.md")).toBe("Other note");
    expect(port.files.get("Notes/c.md")).toBe("Another note");
    expect(target?.appliedHash).toBeDefined();
    expect(target?.undoSnapshot).toContain("topic-history/target/");
    expect(port.files.has(target?.undoSnapshot || "")).toBe(true);
  });
});
