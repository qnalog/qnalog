import { describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({ messages: [] as string[], undoClicks: [] as Array<() => void> }));
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
    removeClass(cls: string) { this.cls = this.cls.replace(cls, ""); }
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
    titleEl = new FakeElement();
    constructor(public app: unknown) {}
    open() { this.onOpen(); }
    close() { this.onClose(); }
    onOpen() {}
    onClose() {}
  }
  class Notice {
    messageEl = new FakeElement();
    noticeEl = new FakeElement();
    constructor(message: string) {
      notices.messages.push(message);
      if (message === "Topic updated. Undo is available.") notices.undoClicks.push(() => this.messageEl.children[0]?.listeners.get("click")?.());
    }
  }
  return { Modal, Notice, setIcon: () => undefined };
});
vi.mock("../src/ui/helpers", () => ({ qnalogConfirm: vi.fn() }));

import { topicMemberExcludeSelectionId, type TopicChangePreview } from "../src/topics/topic-integration";
import { qnalogConfirm } from "../src/ui/helpers";
import { TopicPreviewModal, topicPreviewTargetLabel } from "../src/ui/topic-preview-modal";

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
    expect(modal.titleEl.text).toBe("QnALog · Topics");
    const text = allText(modal.contentEl as unknown as FakeTree);
    expect(text).toContain("The page may have been modified.");
    expect(text).toContain("Clean old topic properties");
    expect(text).toContain("1/2 completed batches");
    expect(text).toContain("Progress thread");
    expect(text).toContain("Disagreements and verification");
    expect(text).toContain("Unverified");
    expect(descendants(modal.contentEl as unknown as FakeTree).filter((item) => item.cls.includes("qnalog-topics-preview-item") && item.cls.includes("is-conflict"))).toHaveLength(1);
  });

  it("offers optional exclusion for a member removal and passes the choice to apply", () => {
    const preview = fixture();
    const itemId = "remove-note-b";
    preview.items = [{ id: itemId, type: "remove_member", operation: { type: "remove_member", path: "Notes/b.md" }, target: "B", text: "B", sourceId: "Notes/b.md", cancellable: true }];
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), undoLastUpdate: vi.fn(), cancel: vi.fn(), apply: vi.fn(() => new Promise<never>(() => undefined)) };
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    const inputs = descendants(modal.contentEl as unknown as FakeTree).filter((item) => item.listeners.has("change"));
    expect(inputs).toHaveLength(2);
    expect(inputs[1].checked).toBe(false);
    expect(allText(modal.contentEl as unknown as FakeTree)).toContain("Also exclude from future suggestions");
    inputs[1].checked = true;
    inputs[1].listeners.get("change")?.();
    const apply = descendants(modal.contentEl as unknown as FakeTree).find((item) => item.text === "Apply selected");
    apply?.listeners.get("click")?.();
    expect(port.apply).toHaveBeenCalledWith(preview, [itemId, topicMemberExcludeSelectionId(itemId)]);
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

  it("offers body retry for an overview empty preview and preserves the original request", async () => {
    vi.mocked(qnalogConfirm).mockResolvedValue(true);
    const preview = fixture();
    preview.items = [];
    preview.request = { startPath: "Notes/a.md", memberPaths: ["Notes/a.md", "Notes/b.md"], basis: "overview", topicId: "topic-1" };
    const port = {
      text: (key: string) => key,
      estimate: vi.fn(async () => ({ chars: 500, requests: 1 })),
      preview: vi.fn(async () => fixture()),
      openSource: vi.fn(), openTopic: vi.fn(async () => undefined), cancel: vi.fn(), apply: vi.fn(), undoLastUpdate: vi.fn(),
    };
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    const tree = modal.contentEl as unknown as FakeTree;
    expect(allText(tree)).toContain("This preview used: Overview");
    expect(allText(tree)).toContain("This note will not contribute content.");
    expect(descendants(tree).some((item) => item.text === "Retry with body")).toBe(true);
    expect(descendants(tree).some((item) => item.text === "Add member and timeline only")).toBe(true);

    descendants(tree).find((item) => item.text === "Retry with body")?.listeners.get("click")?.();
    await vi.waitFor(() => expect(port.preview).toHaveBeenCalledOnce());
    expect(port.estimate).toHaveBeenCalledWith({ memberPaths: ["Notes/a.md", "Notes/b.md"], basis: "body" });
    expect(qnalogConfirm).toHaveBeenCalledWith(
      expect.anything(), "Retry with body", "Estimated input: 500 characters, about 125 tokens.", "Continue", "QnALog · Topics",
    );
    expect(port.preview).toHaveBeenCalledWith({
      startPath: "Notes/a.md", memberPaths: ["Notes/a.md", "Notes/b.md"], basis: "body", topicId: "topic-1", bodyConfirmed: true,
    });
  });

  it("does not offer another body retry for a body-mode empty preview", () => {
    const preview = fixture();
    preview.items = [];
    preview.request = { startPath: "Notes/a.md", memberPaths: ["Notes/a.md"], basis: "body", topicId: "topic-1" };
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), apply: vi.fn(), cancel: vi.fn(), undoLastUpdate: vi.fn() };
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    const tree = modal.contentEl as unknown as FakeTree;
    expect(allText(tree)).toContain("This preview used: Body");
    expect(allText(tree)).toContain("This note will not contribute content.");
    expect(descendants(tree).some((item) => item.text === "Retry with body")).toBe(false);
    expect(descendants(tree).some((item) => item.text === "Add member and timeline only")).toBe(true);
  });

  it("keeps member-and-timeline-only apply available for an empty body preview", async () => {
    const preview = fixture();
    preview.items = [];
    preview.request = { startPath: "Notes/a.md", memberPaths: ["Notes/a.md"], basis: "body", topicId: "topic-1" };
    const port = {
      text: (key: string) => key,
      openSource: vi.fn(), openTopic: vi.fn(async () => undefined), cancel: vi.fn(),
      apply: vi.fn(async () => ({ path: "Topics/Topic.md", markdown: "", pageChangedDuringGeneration: false })),
      undoLastUpdate: vi.fn(async () => ({ restored: true as const })),
    };
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    descendants(modal.contentEl as unknown as FakeTree).find((item) => item.text === "Add member and timeline only")?.listeners.get("click")?.();
    await vi.waitFor(() => expect(port.apply).toHaveBeenCalledOnce());
    expect(port.apply).toHaveBeenCalledWith(preview, []);
  });

  it("does nothing when body-mode retry cost confirmation is cancelled", async () => {
    vi.mocked(qnalogConfirm).mockResolvedValue(false);
    const preview = fixture();
    preview.items = [];
    preview.request = { startPath: "Notes/a.md", memberPaths: ["Notes/a.md"], basis: "overview", topicId: "topic-1" };
    const port = {
      text: (key: string) => key,
      estimate: vi.fn(async () => ({ chars: 100, requests: 1 })),
      preview: vi.fn(), openSource: vi.fn(), openTopic: vi.fn(), cancel: vi.fn(), apply: vi.fn(), undoLastUpdate: vi.fn(),
    };
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    descendants(modal.contentEl as unknown as FakeTree).find((item) => item.text === "Retry with body")?.listeners.get("click")?.();
    await vi.waitFor(() => expect(qnalogConfirm).toHaveBeenCalledOnce());
    expect(port.preview).not.toHaveBeenCalled();
    expect(port.cancel).not.toHaveBeenCalled();
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
    expect(allText(tree)).toContain("2026-09-29");
    expect(allText(tree)).toContain("2026-10-11");
    expect(allText(tree)).toContain("Names stay stable");
    expect(allText(tree)).toContain("Names follow language");
    expect(allText(tree)).toContain("Unsupported statement");
    expect(allText(tree)).toContain("Unverified");
    expect(allText(tree)).toContain("Unattributed statement");
    expect(allText(tree)).toContain("Source pending verification");
    expect(allText(tree)).toContain("Some disagreement details need verification. Review the marked positions.");
    expect(descendants(tree).filter((item) => item.cls === "qnalog-topics-source-link").map((item) => item.text)).toContain("Audit note");
    expect(descendants(tree).filter((item) => item.cls.includes("qnalog-topics-preview-stance"))).toHaveLength(4);
  });

  it("keeps disagreement, resolved action, revision, and progress in one readable layout without operation codes", () => {
    const port = { text: (key: string) => key, openSource: vi.fn(), openTopic: vi.fn(), apply: vi.fn(), cancel: vi.fn(), undoLastUpdate: vi.fn() };
    const preview = fixture();
    preview.items = [
      { id: "disagreement", type: "add_disagreement", operation: { type: "add_disagreement", subject: "Front Matter property naming", positions: [
        { text: "Keep the existing names.", sourceId: "note-1", sourceTitle: "A very long source title that can wrap", date: "2026-10-01" },
        { text: "Use localized names.", sourceId: "note-2", sourceTitle: "Page data", date: "2026-10-02", fromPage: true },
      ], sourceId: "note-1" }, target: "add_disagreement", text: "", sourceId: "note-1", cancellable: true },
      { id: "resolved", type: "resolve_open", operation: { type: "resolve_open", blockId: "tpc-a1b2c3", note: "The issue is resolved.", expectedText: "The issue remains open.", sourceId: "note-1" }, target: "resolve_open", text: "The issue is resolved.", expectedText: "The issue remains open.", sourceId: "note-1", cancellable: true },
      { id: "revision", type: "revise_block", operation: { type: "revise_block", blockId: "tpc-a1b2c3", newText: "Revised summary.", expectedText: "Old summary.", reason: "new evidence", sourceId: "note-2" }, target: "tpc-a1b2c3", text: "Revised summary.", expectedText: "Old summary.", sourceId: "note-2", cancellable: true },
      { id: "progress", type: "add_item", operation: { type: "add_item", section: "进展脉络", text: "A new progress item.", sourceId: "note-1" }, target: "Progress thread", text: "A new progress item.", sourceId: "note-1", cancellable: true },
    ];
    preview.sourceLinks = { "note-1": "[[Notes/one.md|A very long source title that can wrap]]", "note-2": "[[Notes/two.md|Page data]]" };
    preview.sourceDates = { "note-1": "2026-10-01", "note-2": "2026-10-02" };
    const modal = new TopicPreviewModal({} as never, port as never, preview, () => undefined);
    modal.onOpen();
    const tree = modal.contentEl as unknown as FakeTree;
    const text = allText(tree);
    expect(text).not.toMatch(/(?:add_|revise_|resolve_)[a-z_]+/);
    const disagreement = descendants(tree).find((item) => item.cls.includes("qnalog-topics-preview-main is-disagreement"));
    expect(disagreement).toBeDefined();
    expect(descendants(disagreement as FakeTree).filter((item) => item.cls === "qnalog-topics-preview-stance")).toHaveLength(2);
    expect(topicPreviewTargetLabel(preview.items[0])).toBe("");
    expect(topicPreviewTargetLabel(preview.items[2])).toBe("");
    expect(topicPreviewTargetLabel(preview.items[3])).toBe("Progress thread");
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

  it("reports an undo rejection without showing the success notice", async () => {
    notices.messages.length = 0;
    notices.undoClicks.length = 0;
    const port = {
      text: (key: string) => key,
      openSource: vi.fn(), openTopic: vi.fn(async () => undefined), cancel: vi.fn(),
      apply: vi.fn(async () => ({ path: "Topics/Topic.md", markdown: "", pageChangedDuringGeneration: false, skipped: [] })),
      undoLastUpdate: vi.fn(async () => { throw new Error("storage failure"); }),
    };
    const modal = new TopicPreviewModal({} as never, port as never, fixture(), () => undefined);
    modal.onOpen();
    descendants(modal.contentEl as unknown as FakeTree).find((item) => item.text === "Apply selected")?.listeners.get("click")?.();
    await vi.waitFor(() => expect(notices.undoClicks).toHaveLength(1));

    notices.undoClicks[0]();

    await vi.waitFor(() => expect(notices.messages).toContain("Undo could not be confirmed. Check the topic page and its errata, then retry Undo."));
    expect(notices.messages).not.toContain("Topic update undone.");
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
