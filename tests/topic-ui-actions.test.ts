import { describe, expect, it, vi } from "vitest";

const modalState = vi.hoisted(() => ({ opened: [] as Array<{ titleEl: { text: string }; contentEl: { text: string; cls: string; children: Array<{ text: string }> }; close(): void }>, previews: 0 }));

vi.mock("obsidian", () => {
  class FakeElement {
    text = "";
    cls = "";
    children: FakeElement[] = [];
    createDiv(options: { cls?: string; text?: string } = {}) { const child = new FakeElement(); child.cls = options.cls || ""; child.text = options.text || ""; this.children.push(child); return child; }
    createEl(_tag: string, options: { cls?: string; text?: string } = {}) { const child = new FakeElement(); child.cls = options.cls || ""; child.text = options.text || ""; this.children.push(child); return child; }
    addClass(value: string) { this.cls += ` ${value}`; }
    empty() { this.children = []; }
    setText(value: string) { this.text = value; }
    addEventListener() { /* Clicks are driven through close() in these tests. */ }
  }
  class Modal {
    titleEl = new FakeElement();
    contentEl = new FakeElement();
    constructor(_app: unknown) {}
    open() { this.onOpen(); modalState.opened.push(this as unknown as typeof modalState.opened[number]); }
    close() { this.onClose(); }
    onOpen(): void { /* Lifecycle hook. */ }
    onClose(): void { /* Lifecycle hook. */ }
  }
  class Notice { constructor(_message: string) { /* No UI is needed in the test. */ } }
  return { Modal, Notice };
});
vi.mock("../src/ui/topic-preview-modal", () => ({
  TopicPreviewModal: class {
    constructor() { modalState.previews += 1; }
    open() { /* Preview opening is recorded by the constructor. */ }
  },
}));

import type { TopicChangePreview } from "../src/topics/topic-integration";
import { runTopicPreviewRequest } from "../src/ui/topic-ui-actions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("topic preview waiting dialog", () => {
  it("does not open a preview after the user closes the waiting dialog", async () => {
    modalState.opened.length = 0;
    modalState.previews = 0;
    const pending = deferred<TopicChangePreview>();
    const port = { text: (key: string) => key };
    const task = runTopicPreviewRequest({} as never, port as never, () => pending.promise, () => undefined);
    const waiting = modalState.opened[0];
    expect(waiting.titleEl.text).toBe("QnALog · Topics");
    expect(waiting.contentEl.children[0].text).toBe("Generating preview");
    waiting.close();
    pending.resolve({ topicId: "t", expectedHash: "h", pageWasManuallyEdited: false, items: [], completedBatches: 1, totalBatches: 1 });
    await task;
    expect(modalState.previews).toBe(0);
  });
});
