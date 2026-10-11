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
    legacyPropertyCleanup: false,
    completedBatches: 1, totalBatches: 2, partialFailure: "request failed",
    items: [
      { id: "item-1", type: "add_item", operation: { type: "add_item", section: "进展脉络", text: "Current fact", sourceId: "note-1" }, target: "Progress thread", text: "Current fact", sourceId: "note-1", cancellable: true },
      { id: "item-2", type: "add_conflict", operation: { type: "add_conflict", text: "Claim (unverified)", sourceId: "note-2" }, target: "conflict", text: "Claim（未核实）", sourceId: "note-2", cancellable: true },
    ],
    sourceLinks: { "note-1": "[[Notes/one.md|One]]", "note-2": "[[Notes/two.md|Two]]" },
  };
}

describe("topic preview dialog", () => {
  it("groups changes and shows the manual-edit, partial-batch, and unverified states", () => {
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), apply: vi.fn(), undoLastUpdate: vi.fn() };
    const preview = fixture();
    preview.legacyPropertyCleanup = true;
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    const text = allText(modal.contentEl as unknown as FakeTree);
    expect(text).toContain("The page may have been modified.");
    expect(text).toContain("Clean old topic properties");
    expect(text).toContain("1/2 completed batches");
    expect(text).toContain("Progress thread");
    expect(text).toContain("Disagreements and verification");
    expect(text).toContain("Unverified");
    expect(descendants(modal.contentEl as unknown as FakeTree).filter((item) => item.cls.includes("qnalog-topics-preview-item") && item.cls.includes("is-conflict"))).toHaveLength(1);
  });

  it("shows when unknown model enums were normalized", () => {
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), apply: vi.fn(), undoLastUpdate: vi.fn() };
    const preview = fixture();
    preview.validationWarnings = ["Unknown topic open-item kind was mapped to action."];
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    expect(allText(modal.contentEl as unknown as FakeTree)).toContain("Unknown topic values were normalized to safe defaults.");
  });
  it("shows assessment details and identifies program-completed conflict changes", () => {
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), apply: vi.fn(), cancel: vi.fn(), undoLastUpdate: vi.fn() };
    const preview = fixture();
    preview.assessments = [{ memberId: "note-1", claim: "The property decision changed.", relation: "conflict" }];
    preview.programGeneratedOperations = 1;
    preview.items = [{ ...preview.items[0], programGenerated: true }];
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    const tree = modal.contentEl as unknown as FakeTree;
    expect(allText(tree)).toContain("Assessment details");
    expect(allText(tree)).toContain("Conflict: The property decision changed.");
    expect(allText(tree)).toContain("Completed by program from conflict assessment");
  });

  it("shows the generated-overview notice", () => {
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), apply: vi.fn(), cancel: vi.fn(), undoLastUpdate: vi.fn() };
    const preview = fixture();
    preview.create = { title: "Topic", basis: "overview", tags: [], members: [], overviewGeneratedFromThreads: true };
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    const text = allText(modal.contentEl as unknown as FakeTree);
    expect(text).toContain("The overview was generated from the thread summaries by the program. You can edit it on the page.");
  });

  it("shows legacy status cleanup as a checked preview item", () => {
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), apply: vi.fn(), undoLastUpdate: vi.fn() };
    const preview = fixture();
    preview.legacyStatusCleanup = true;
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    expect(allText(modal.contentEl as unknown as FakeTree)).toContain("Clean old status line");
    expect(descendants(modal.contentEl as unknown as FakeTree).some((item) => item.checked)).toBe(true);
  });

  it("shows duplicate decisions in assessment details", () => {
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), apply: vi.fn(), cancel: vi.fn(), undoLastUpdate: vi.fn() };
    const preview = fixture();
    preview.duplicateDetails = [{ thread: "Font issue", discardedText: "A repeated claim.", keptText: "The existing claim.", reason: "existing-page" }];
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    const text = allText(modal.contentEl as unknown as FakeTree);
    expect(text).toContain("Assessment details");
    expect(text).toContain("Duplicate point omitted because it matches an existing page point");
    expect(text).toContain("The existing claim.");
  });

  it("explains an empty update, offers member-and-timeline-only apply, and shows degradations", () => {
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), apply: vi.fn(), undoLastUpdate: vi.fn() };
    const preview = fixture();
    preview.items = [];
    preview.degraded = 2;
    preview.updateDiagnostics = { requests: 2, rawResponseChars: [14, 14], jsonParsable: [true, true], rawOperations: 0, acceptedOperations: 0, discarded: {}, retried: true, duplicateOperations: 0 };
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    const tree = modal.contentEl as unknown as FakeTree;
    expect(allText(tree)).toContain("No page changes were proposed");
    expect(allText(tree)).toContain("2 changes were adjusted");
    expect(descendants(tree).some((item) => item.text === "Add member and timeline only")).toBe(true);
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

  it("shows each disagreement stance with its own source, date, and verification state", () => {
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), apply: vi.fn(), cancel: vi.fn(), undoLastUpdate: vi.fn() };
    const preview = fixture();
    preview.items = [{
      id: "disagreement", type: "add_disagreement",
      operation: { type: "add_disagreement", subject: "Property names", sourceId: "old", positions: [
        { text: "Names stay stable", sourceId: "old", date: "2026-09-29", sourceTitle: "Audit note" },
        { text: "Names follow language", sourceId: "fresh", date: "2026-10-11", sourceTitle: "New note" },
        { text: "Unsupported statement", sourceId: "fresh", date: "2026-10-11", provenance: "unverified" },
        { text: "Unattributed statement", sourceId: "", provenance: "source-pending" },
      ] }, target: "Property names", text: "", sourceId: "old", cancellable: true,
    }];
    preview.validationWarnings = ["A conflict assessment had no related page block; only the new claim was added for review."];
    preview.sourceLinks = { old: "[[Notes/a.md|Audit note]]", fresh: "[[Notes/b.md|New note]]" };
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    const tree = modal.contentEl as unknown as FakeTree;
    expect(allText(tree)).toContain("2026-09-29: Names stay stable");
    expect(allText(tree)).toContain("2026-10-11: Names follow language");
    expect(allText(tree)).toContain("Unsupported statement (Unverified)");
    expect(allText(tree)).toContain("Unattributed statement (Source pending verification)");
    expect(allText(tree)).toContain("Some disagreement details need verification. Review the marked positions.");
    expect(descendants(tree).filter((item) => item.cls === "qnalog-topics-source-link").map((item) => item.text)).toContain("Audit note");
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
  it("shows the exact open item that a grounded resolve operation will mark complete", () => {
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), apply: vi.fn(), cancel: vi.fn(), undoLastUpdate: vi.fn() };
    const preview = fixture();
    preview.items = [{
      id: "resolve", type: "resolve_open",
      operation: { type: "resolve_open", blockId: "tpc-a1b2c3", expectedText: "Outline generation is broken for multi-part recordings.", note: "The outline bug is fixed and recordings now combine correctly.", sourceId: "note-1" },
      target: "Outline generation is broken for multi-part recordings.", expectedText: "Outline generation is broken for multi-part recordings.", text: "The outline bug is fixed and recordings now combine correctly.", sourceId: "note-1", cancellable: true,
    }];
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    const tree = modal.contentEl as unknown as FakeTree;
    expect(allText(tree)).toContain("Will mark this item as resolved: Outline generation is broken for multi-part recordings.");
    expect(descendants(tree).find((item) => item.listeners.has("change"))?.checked).toBe(true);
  });
});
