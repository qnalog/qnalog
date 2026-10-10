import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ Notice: class Notice {} }));
import { TopicPromptStore } from "../src/topics/topic-prompt-store";
import { renderTopicPromptRow } from "../src/ui/topic-prompt-row";

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  text = "";
  cls = "";
  handlers = new Map<string, (event: { stopPropagation(): void }) => void>();
  constructor(text = "", cls = "") { this.text = text; this.cls = cls; }
  createDiv(options: { cls?: string; text?: string } = {}) { return this.add(new FakeElement(options.text || "", options.cls || "")); }
  createEl(_tag: string, options: { cls?: string; text?: string } = {}) { return this.add(new FakeElement(options.text || "", options.cls || "")); }
  createSpan(options: { cls?: string; text?: string } = {}) { return this.add(new FakeElement(options.text || "", options.cls || "")); }
  add(item: FakeElement) { item.parent = this; this.children.push(item); return item; }
  addEventListener(name: string, callback: (event: { stopPropagation(): void }) => void) { this.handlers.set(name, callback); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this); }
}
function flatten(node: FakeElement): FakeElement[] { return [node, ...node.children.flatMap(flatten)]; }
function text(node: FakeElement): string { return `${node.text} ${node.children.map(text).join(" ")}`; }

describe("topic prompt row", () => {
  it("adds a separate hint row without changing note rows, and removes ignored pairs", async () => {
    const path = "Minutes/new-note.md";
    const store = new TopicPromptStore();
    store.set(path, [
      { path, topicId: "a", title: "Alpha", matchedTags: ["project/qalog"] },
      { path, topicId: "b", title: "Beta", matchedTags: ["topic/workflow"] },
      { path, topicId: "c", title: "Gamma", matchedTags: ["topic/ai"] },
    ]);
    const port = {
      isSourceNote: () => true, text: (key: string) => key, getPrompts: (note: string) => store.get(note),
      ignoreNote: vi.fn(async (topicId: string, note: string) => store.remove(note, topicId)), removePrompt: (note: string, topicId: string) => store.remove(note, topicId),
    };
    const parent = new FakeElement();
    parent.createDiv({ cls: "qnalog-outline-recent-row", text: "note one" });
    parent.createDiv({ cls: "qnalog-outline-recent-row", text: "note two" });
    renderTopicPromptRow(parent as never, path, port as never, vi.fn(), vi.fn());
    expect(parent.children.filter((item) => item.cls === "qnalog-outline-recent-row").map((item) => item.text)).toEqual(["note one", "note two"]);
    expect(text(parent)).toContain("May belong to topic “Alpha”");
    expect(text(parent)).toContain("+1");

    const firstIgnore = flatten(parent).find((item) => item.text === "Ignore");
    firstIgnore?.handlers.get("click")?.({ stopPropagation() {} });
    await vi.waitFor(() => expect(store.get(path).map((entry) => entry.topicId)).toEqual(["b", "c"]));
    expect(parent.children.filter((item) => item.cls === "qnalog-outline-recent-row").map((item) => item.text)).toEqual(["note one", "note two"]);
    expect(text(parent)).toContain("Beta");
    expect(text(parent)).toContain("Gamma");
    expect(port.ignoreNote).toHaveBeenCalledWith("a", path);
  });
});
