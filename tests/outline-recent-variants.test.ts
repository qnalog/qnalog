import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class ItemView {}
  class Modal {}
  class SuggestModal {}
  class FuzzySuggestModal {}
  class PluginSettingTab {}
  return {
    ItemView, Modal, SuggestModal, FuzzySuggestModal, PluginSettingTab,
    normalizePath: (path: string) => path.replace(/\\/g, "/"),
    setIcon: () => undefined,
  };
});
vi.mock("../src/recent/recent-notes", () => ({
  getQueueTasksForMarkdown: () => [],
  getRecentQueueProcessingState: () => null,
}));

import { OutlineView } from "../src/ui/outline-view";

type Handler = (event?: { preventDefault(): void; stopPropagation(): void }) => void;

class FakeElement {
  children: Array<FakeElement | FakeComment> = [];
  handlers = new Map<string, Handler>();
  text = "";
  isConnected = true;
  parentNode: FakeElement | null = null;
  style = { setProperty: () => undefined };
  constructor(readonly cls = "") {}
  createDiv(options: { cls?: string; text?: string } = {}): FakeElement {
    const child = new FakeElement(options.cls || "");
    child.text = options.text || "";
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  addEventListener(name: string, handler: Handler): void { this.handlers.set(name, handler); }
  addClass(name: string): void { this.cls.concat(name); }
  appendChild(child: FakeComment): void { child.parentNode = this; this.children.push(child); }
  insertBefore(child: FakeElement, before: FakeComment): void {
    this.children = this.children.filter((item) => item !== child);
    this.children.splice(this.children.indexOf(before), 0, child);
  }
}

class FakeComment {
  parentNode: FakeElement | null = null;
  remove(): void {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
}

describe("recent note variant rows", () => {
  it("inserts a clickable original row before derived rows and switches the master note", async () => {
    vi.stubGlobal("document", { createComment: () => new FakeComment() });
    const source = { path: "Notes/source.md", basename: "source", parent: { path: "Notes" } };
    const original = "Notes/.versions/source/source-original.md";
    const derived = { path: "Notes/【综合纪要】source.md", basename: "derived" };
    const switchVersion = vi.fn(async () => undefined);
    const view = Object.create(OutlineView.prototype) as OutlineView;
    Object.assign(view, {
      plugin: { settings: {}, versions: {
        findOriginalVersionForSource: vi.fn(async () => ({ path: original, mode: "monologue", label: "个人笔记" })),
        switchVersion,
      } },
      app: { workspace: { getLeaf: () => ({ openFile: vi.fn() }) } },
      createRecentActionButton: () => undefined,
      syncRecentNoteProcessingState: () => undefined,
      showVariantContextMenu: () => undefined,
    });
    const parent = new FakeElement();
    view.renderRecentNoteRow(parent, {
      file: source, title: "source", mode: "monologue", variants: [{ file: derived, sourcePath: source.path, kind: "minutes", label: "综合纪要" }],
    }, "");
    await Promise.resolve();
    await Promise.resolve();

    const variantRows = parent.children.filter((child): child is FakeElement => child instanceof FakeElement && child.cls === "qnalog-outline-recent-variant");
    expect(variantRows.map((row) => row.children.find((child): child is FakeElement => child instanceof FakeElement && child.cls === "qnalog-outline-recent-variant-name")?.text))
      .toEqual(["个人笔记", "综合纪要"]);
    variantRows[0].handlers.get("click")?.();
    expect(switchVersion).toHaveBeenCalledWith(original, source.path);
    variantRows[1].handlers.get("click")?.();
    expect(switchVersion).toHaveBeenLastCalledWith(derived, source.path);
  });
  it("does not render an original row when no valid snapshot exists", async () => {
    vi.stubGlobal("document", { createComment: () => new FakeComment() });
    const source = { path: "Notes/source.md", basename: "source", parent: { path: "Notes" } };
    const derived = { path: "Notes/【综合纪要】source.md", basename: "derived" };
    const switchVersion = vi.fn(async () => undefined);
    const view = Object.create(OutlineView.prototype) as OutlineView;
    Object.assign(view, {
      plugin: { settings: {}, versions: {
        findOriginalVersionForSource: vi.fn(async () => null),
        switchVersion,
      } },
      app: { workspace: { getLeaf: () => ({ openFile: vi.fn() }) } },
      createRecentActionButton: () => undefined,
      syncRecentNoteProcessingState: () => undefined,
      showVariantContextMenu: () => undefined,
    });
    const parent = new FakeElement();
    view.renderRecentNoteRow(parent, {
      file: source,
      title: "source",
      mode: "monologue",
      variants: [{ file: derived, sourcePath: source.path, kind: "minutes", label: "综合纪要" }],
    }, "");
    await Promise.resolve();
    await Promise.resolve();

    const variantRows = parent.children.filter((child): child is FakeElement => child instanceof FakeElement && child.cls === "qnalog-outline-recent-variant");
    expect(variantRows).toHaveLength(1);
    expect(variantRows[0].children.find((child): child is FakeElement => child instanceof FakeElement && child.cls === "qnalog-outline-recent-variant-name")?.text)
      .toBe("综合纪要");
    variantRows[0].handlers.get("click")?.();
    expect(switchVersion).toHaveBeenCalledWith(derived, source.path);
  });
});
