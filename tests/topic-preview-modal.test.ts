import { describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("obsidian", () => {
  class FakeElement {
    children: FakeElement[] = [];
    text = "";
    cls = "";
    checked = false;
    disabled = false;
    listeners = new Map<string, (event?: { stopPropagation(): void }) => void>();
    constructor(text = "", cls = "") { this.text = text; this.cls = cls; }
    empty() { this.children = []; }
    addClass(cls: string) { this.cls += ` ${cls}`; }
    createEl(_tag: string, options: { cls?: string; text?: string } = {}) { return this.add(new FakeElement(options.text || "", options.cls || "")); }
    createDiv(options: { cls?: string; text?: string } = {}) { return this.add(new FakeElement(options.text || "", options.cls || "")); }
    createSpan(options: { cls?: string; text?: string } = {}) { return this.add(new FakeElement(options.text || "", options.cls || "")); }
    add(child: FakeElement) { this.children.push(child); return child; }
    addEventListener(name: string, callback: (event?: { stopPropagation(): void }) => void) { this.listeners.set(name, callback); }
    setText(text: string) { this.text = text; }
    remove() { this.text = ""; }
  }
  class Modal {
    contentEl = new FakeElement();
    constructor(public app: unknown) {}
    close() { this.onClose(); }
    onOpen() {}
    onClose() {}
  }
  class Notice {
    noticeEl = new FakeElement();
    constructor(message: string) { notices.messages.push(message); }
  }
  return { Modal, Notice, setIcon: () => undefined };
});

import type { TopicChangePreview } from "../src/topics/topic-integration";
import { TopicPreviewModal } from "../src/ui/topic-preview-modal";

interface FakeTree { text: string; cls: string; checked: boolean; children: FakeTree[]; listeners: Map<string, (event?: { stopPropagation(): void }) => void> }
function allText(node: FakeTree): string { return `${node.text} ${node.children.map(allText).join(" ")}`; }
function descendants(node: FakeTree): FakeTree[] { return node.children.flatMap((child) => [child, ...descendants(child)]); }

function fixture(): TopicChangePreview {
  return {
    topicId: "topic-1", expectedHash: "hash", pageWasManuallyEdited: true,
    completedBatches: 1, totalBatches: 2, partialFailure: "request failed",
    items: [
      { id: "item-1", type: "add_item", operation: { type: "add_item", section: "当前状态", text: "Current fact", sourceId: "note-1" }, target: "Current status", text: "Current fact", sourceId: "note-1", cancellable: true },
      { id: "item-2", type: "add_conflict", operation: { type: "add_conflict", text: "Claim (unverified)", sourceId: "note-2" }, target: "conflict", text: "Claim（未核实）", sourceId: "note-2", cancellable: true },
    ],
    sourceLinks: { "note-1": "[[Notes/one.md|One]]", "note-2": "[[Notes/two.md|Two]]" },
  };
}

describe("topic preview dialog", () => {
  it("groups changes and shows the manual-edit, partial-batch, and unverified states", () => {
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), apply: vi.fn(), undoLastUpdate: vi.fn() };
    const modal = new TopicPreviewModal({} as never, port as never, fixture(), () => undefined);
    modal.onOpen();
    const text = allText(modal.contentEl as unknown as FakeTree);
    expect(text).toContain("The page was manually edited since the last update.");
    expect(text).toContain("1/2 completed batches");
    expect(text).toContain("Current status");
    expect(text).toContain("Disagreements and verification");
    expect(text).toContain("Unverified");
    expect(descendants(modal.contentEl as unknown as FakeTree).filter((item) => item.cls.includes("qnalog-topics-preview-item") && item.cls.includes("is-conflict"))).toHaveLength(1);
  });

  it("applies only checked operations and opens the resulting topic page", async () => {
    const port = {
      text: (key: string) => key,
      openSource: vi.fn(), openTopic: vi.fn(async () => undefined),
      cancel: vi.fn(),
      apply: vi.fn(async () => ({ path: "Topics/Topic.md", markdown: "", pageChangedDuringGeneration: true })),
      undoLastUpdate: vi.fn(async () => ({ restored: false as const, reason: "page-modified" as const })),
    };
    const modal = new TopicPreviewModal({} as never, port as never, fixture(), () => undefined);
    modal.onOpen();
    const boxes = descendants(modal.contentEl as unknown as FakeTree).filter((item) => item.cls === "" && item.checked !== undefined);
    const checkboxes = descendants(modal.contentEl as unknown as FakeTree).filter((item) => item.listeners.has("change"));
    checkboxes[1].checked = false;
    checkboxes[1].listeners.get("change")?.();
    const apply = descendants(modal.contentEl as unknown as FakeTree).find((item) => item.text === "Apply selected");
    apply?.listeners.get("click")?.();
    await vi.waitFor(() => expect(port.apply).toHaveBeenCalledOnce());
    expect(port.apply.mock.calls[0][1]).toEqual(["item-1"]);
    await vi.waitFor(() => expect(port.openTopic).toHaveBeenCalledWith("Topics/Topic.md"));
    expect(port.cancel).not.toHaveBeenCalled();
    expect(notices.messages).toContain("The topic page changed during generation. Changes were positioned on the latest version.");
    void boxes;
  });

  it.each(["close icon", "Escape", "Cancel button"]) ("cancels and discards an unapplied preview through %s once", (path) => {
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), apply: vi.fn(), cancel: vi.fn(), undoLastUpdate: vi.fn() };
    const modal = new TopicPreviewModal({} as never, port as never, fixture(), () => undefined);
    modal.onOpen();
    if (path === "Cancel button") {
      descendants(modal.contentEl as unknown as FakeTree).find((item) => item.text === "Cancel")?.listeners.get("click")?.();
    } else {
      modal.close();
    }
    modal.onClose();
    expect(port.cancel).toHaveBeenCalledOnce();
    expect(port.cancel).toHaveBeenCalledWith("topic-1");
  });

  it("shows only the linked source title and date in the metadata row", () => {
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), apply: vi.fn(), cancel: vi.fn(), undoLastUpdate: vi.fn() };
    const preview = fixture();
    preview.sourceDates = { "note-1": "2026-10-01", "note-2": "2026-10-02" };
    preview.sourceLinks = { "note-1": "[[QnALog/Very/Long/Path/Note.md|Readable title]]", "note-2": "[[Other/Claim.md|Claim title]]" };
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    const texts = descendants(modal.contentEl as unknown as FakeTree).map((item) => item.text);
    expect(texts).toContain("Readable title");
    expect(texts).toContain("2026-10-01");
    expect(texts).not.toContain("QnALog/Very/Long/Path/Note.md");
  });

  it("shows old and new summary text and reports block edits skipped during apply", async () => {
    const port = {
      text: (key: string) => key,
      openSource: vi.fn(), openTopic: vi.fn(async () => undefined), cancel: vi.fn(),
      apply: vi.fn(async () => ({ path: "Topics/Topic.md", markdown: "", pageChangedDuringGeneration: false, skipped: [{ id: "tpc-a1b2c3", reason: "block-modified" as const }] })),
      undoLastUpdate: vi.fn(async () => ({ restored: true as const })),
    };
    const preview = fixture();
    preview.items = [{
      id: "revision", type: "revise_block", operation: { type: "revise_block", blockId: "tpc-a1b2c3", expectedText: "Old summary.", newText: "Updated summary.", reason: "new evidence", sourceId: "note-1" },
      target: "tpc-a1b2c3", text: "Updated summary.", expectedText: "Old summary.", sourceId: "note-1", cancellable: true,
    }];
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    const items = descendants(modal.contentEl as unknown as FakeTree);
    expect(allText(modal.contentEl as unknown as FakeTree)).toContain("Old summary.");
    expect(allText(modal.contentEl as unknown as FakeTree)).toContain("Updated summary.");
    expect(items.some((item) => item.cls.includes("qnalog-topics-revision-old"))).toBe(true);
    descendants(modal.contentEl as unknown as FakeTree).find((item) => item.text === "Apply selected")?.listeners.get("click")?.();
    await vi.waitFor(() => expect(notices.messages).toContain("Some revisions were skipped because their blocks changed: tpc-a1b2c3"));
  });
});
