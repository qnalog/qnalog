import { describe, expect, it, vi } from "vitest";

const dialogs = vi.hoisted(() => ({ snapshots: [] as Array<{ title: string; children: Array<{ tag: string; cls: string; text: string }> }> }));

vi.mock("obsidian", () => {
  class FakeElement {
    children: FakeElement[] = [];
    textContent = "";
    className = "";
    tagName: string;
    constructor(tagName = "div") { this.tagName = tagName.toUpperCase(); }
    createDiv(options: { cls?: string; text?: string } = {}) { const node = this.add(new FakeElement("div")); node.className = options.cls || ""; node.textContent = options.text || ""; return node; }
    createEl(tag: string, options: { cls?: string; text?: string } = {}) { const node = this.add(new FakeElement(tag)); node.className = options.cls || ""; node.textContent = options.text || ""; return node; }
    add(node: FakeElement) { this.children.push(node); return node; }
    addClass(value: string) { this.className += ` ${value}`; }
    setText(value: string) { this.textContent = value; }
    empty() { this.children = []; }
    addEventListener() { /* The tests inspect structure and title behavior. */ }
  }
  class Modal {
    contentEl = new FakeElement("div");
    modalEl = new FakeElement("div");
    titleEl = new FakeElement("div");
    onOpen(): void { /* Lifecycle hook. */ }
    onClose(): void { /* Lifecycle hook. */ }
    constructor(_app: unknown) {}
    open() { this.onOpen(); dialogs.snapshots.push({ title: this.titleEl.textContent, children: this.contentEl.children.map((node) => ({ tag: node.tagName, cls: node.className, text: node.textContent })) }); }
    close() { this.onClose(); }
  }
  return { Modal };
});

import { qnalogConfirm } from "../src/ui/helpers";

describe("topic confirmation title opt-in", () => {
  it("keeps other confirmation dialogs unchanged when no window title is passed", () => {
    qnalogConfirm({} as never, "Clear queue", "Remove all items?", "Clear");
    const dialog = dialogs.snapshots.at(-1);
    expect(dialog?.title).toBe("");
    expect(dialog?.children[0]).toMatchObject({ tag: "H3", text: "Clear queue" });
  });

  it("uses the topic title bar and compact action heading when opted in", () => {
    qnalogConfirm({} as never, "Delete topic", "Delete this topic?", "Delete", "QnALog · Topics");
    const dialog = dialogs.snapshots.at(-1);
    expect(dialog?.title).toBe("QnALog · Topics");
    expect(dialog?.children[0]).toMatchObject({ tag: "DIV", cls: "qnalog-topics-dialog-heading", text: "Delete topic" });
    expect(dialog?.children.at(-1)).toMatchObject({ tag: "DIV", cls: "modal-button-container qnalog-modal-actions" });
  });
});
