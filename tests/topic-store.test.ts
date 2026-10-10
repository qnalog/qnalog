import { describe, expect, it } from "vitest";
import { TopicStore, type TopicStorePort } from "../src/topics/topic-store";
import { createTopicPage, serializeTopicPage, type TopicPage } from "../src/topics/topic-page";
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
