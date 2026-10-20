import { afterEach, describe, expect, it, vi } from "vitest";

const modalState = vi.hoisted(() => ({
  createdUrls: [] as unknown[],
  revokedUrls: [] as unknown[],
  elements: [] as FakeElement[],
}));

class FakeElement {
  children: FakeElement[] = [];
  text = "";
  src = "";
  currentTime = 0;
  duration = 10;
  preload = "";
  attributes: Record<string, unknown> = {};
  listeners = new Map<string, () => void>();
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => { delete this.attributes[name]; });
  addEventListener = vi.fn((name: string, callback: () => void) => { this.listeners.set(name, callback); });
  constructor(tag = "div") { this.attributes.tag = tag; modalState.elements.push(this); }
  empty() { this.children = []; }
  addClass() { /* DOM surface used by the modal */ }
  createDiv() { const child = new FakeElement(); this.children.push(child); return child; }
  createEl(tag: string, options: { text?: string; attr?: Record<string, unknown> } = {}) {
    const child = new FakeElement(tag);
    child.text = options.text || "";
    child.attributes = { ...child.attributes, ...(options.attr || {}) };
    this.children.push(child);
    return child;
  }
}

vi.mock("obsidian", () => ({
  Modal: class Modal {
    app: unknown;
    contentEl = new FakeElement();
    constructor(app: unknown) { this.app = app; }
  },
}));

import { AudioTimeModal } from "../src/ui/modals";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  modalState.createdUrls.length = 0;
  modalState.revokedUrls.length = 0;
  modalState.elements.length = 0;
});

describe("adapter-backed audio time modal", () => {
  it("reads the exact source and revokes its URL on close without offering an indexed-file action", async () => {
    const readBinary = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => { modalState.createdUrls.push("blob:qnalog-audio"); return "blob:qnalog-audio"; }),
      revokeObjectURL: vi.fn((url: string) => { modalState.revokedUrls.push(url); }),
    });
    const modal = new AudioTimeModal({}, {
      kind: "adapter", path: "QnALog/.cache/segments/hidden.wav", name: "hidden.wav", extension: "wav", readBinary,
    }, 0, "00:00");
    await modal.onOpen();

    expect(readBinary).toHaveBeenCalledOnce();
    expect(modalState.createdUrls).toEqual(["blob:qnalog-audio"]);
    expect(modalState.elements.some(element => element.attributes.tag === "button" && element.text === "Open audio file")).toBe(false);
    const audio = modalState.elements.find(element => element.attributes.tag === "audio");
    modal.onClose();
    audio?.listeners.get("loadedmetadata")?.();
    expect(audio?.pause).toHaveBeenCalledOnce();
    expect(audio?.removeAttribute).toHaveBeenCalledWith("src");
    expect(audio?.play).not.toHaveBeenCalled();
    expect(modalState.revokedUrls).toEqual(["blob:qnalog-audio"]);
  });

  it("does not create a playback URL or start playback when a pending read resolves after close", async () => {
    let resolveRead!: (value: ArrayBuffer) => void;
    const readBinary = vi.fn(() => new Promise<ArrayBuffer>(resolve => { resolveRead = resolve; }));
    const createObjectURL = vi.fn(() => "blob:qnalog-audio");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const modal = new AudioTimeModal({}, {
      kind: "adapter", path: "QnALog/.cache/segments/hidden.wav", name: "hidden.wav", extension: "wav", readBinary,
    }, 0, "00:00");
    const opening = modal.onOpen();
    modal.onClose();
    resolveRead(new Uint8Array([1]).buffer);
    await opening;

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(modalState.elements.find(element => element.attributes.tag === "audio")?.play).not.toHaveBeenCalled();
  });
});
