import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

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
  style = { setProperty: () => undefined };
  cls: string;
  parentNode: FakeElement | null = null;
  constructor(cls = "") { this.cls = cls; }
  createDiv(options: { cls?: string; text?: string } = {}): FakeElement {
    const child = new FakeElement(options.cls || "");
    child.text = options.text || "";
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  addEventListener(name: string, handler: Handler): void { this.handlers.set(name, handler); }
  addClass(name: string): void { this.cls += ` ${name}`; }
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

const initialLanguage = getActiveUiLanguage();
afterEach(() => {
  setActiveUiLanguage(initialLanguage);
  vi.unstubAllGlobals();
});

function renderVariants(language: "en" | "zh", variants: Array<{ file: { path: string; basename: string }; sourcePath: string; kind: string; label: string }>, snapshot: { path: string; mode: string; label: string } | null) {
  setActiveUiLanguage(resolveUiLanguage(language, language));
  vi.stubGlobal("document", { createComment: () => new FakeComment() });
  const source = { path: "Notes/source.md", basename: "source", parent: { path: "Notes" } };
  const switchVersion = vi.fn(async () => undefined);
  const findOriginalVersionForSource = vi.fn(async () => snapshot);
  const view = Object.create(OutlineView.prototype) as OutlineView;
  Object.assign(view, {
    plugin: { settings: {}, versions: { findOriginalVersionForSource, switchVersion } },
    app: { workspace: { getLeaf: () => ({ openFile: vi.fn() }) } },
    createRecentActionButton: () => undefined,
    syncRecentNoteProcessingState: () => undefined,
    showVariantContextMenu: () => undefined,
  });
  const parent = new FakeElement();
  view.renderRecentNoteRow(parent, { file: source, title: "source title", mode: "monologue", variants }, "");
  return { parent, source, switchVersion, findOriginalVersionForSource };
}

async function flushSnapshotLookup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function getVariantRows(parent: FakeElement): FakeElement[] {
  return parent.children.filter((child): child is FakeElement => child instanceof FakeElement && child.cls.split(" ").includes("qnalog-outline-recent-variant"));
}
function getVariantName(row: FakeElement): string | undefined {
  return row.children.find((child): child is FakeElement => child instanceof FakeElement && child.cls === "qnalog-outline-recent-variant-name")?.text;
}

describe("recent note variant rows", () => {
  it.each([
    ["zh", "个人笔记", "个人笔记", "初稿"],
    ["en", "Personal notes", "Personal notes", "Original"],
  ] as const)("distinguishes original from a same-type derived note in %s", async (language, derivedLabel, expectedDerived, expectedOriginal) => {
    const sourcePath = "Notes/source.md";
    const derived = { path: "Notes/derived.md", basename: "derived" };
    const original = "Notes/.versions/source/source-original.md";
    const { parent, source, switchVersion, findOriginalVersionForSource } = renderVariants(language, [
      { file: derived, sourcePath, kind: "minutes", label: derivedLabel },
    ], { path: original, mode: "monologue", label: derivedLabel });
    await flushSnapshotLookup();

    const rows = getVariantRows(parent);
    expect(rows.map(getVariantName)).toEqual([expectedOriginal, expectedDerived]);
    const parentRow = parent.children.find((child): child is FakeElement => child instanceof FakeElement && child.cls.includes("qnalog-outline-recent-row"));
    const body = parentRow?.children.find((child): child is FakeElement => child instanceof FakeElement && child.cls === "qnalog-outline-recent-body");
    expect(body?.children.find((child): child is FakeElement => child instanceof FakeElement && child.cls === "qnalog-outline-recent-meta")?.text).toBe(expectedDerived);
    expect(body?.children.find((child): child is FakeElement => child instanceof FakeElement && child.cls === "qnalog-outline-recent-title-line")?.children
      .find((child): child is FakeElement => child instanceof FakeElement && child.cls === "qnalog-outline-recent-name")?.text).toBe("source title");
    rows[0].handlers.get("click")?.();
    expect(switchVersion).toHaveBeenCalledWith(original, source.path);
    rows[1].handlers.get("click")?.();
    expect(switchVersion).toHaveBeenLastCalledWith(derived, source.path);
    expect(findOriginalVersionForSource).toHaveBeenCalledWith(source);
  });

  it.each([
    ["zh", "初稿"],
    ["en", "Original"],
  ] as const)("keeps original identity distinct from a different derived type in %s", async (language, expectedOriginal) => {
    const sourcePath = "Notes/source.md";
    const clean = { path: "Notes/clean.md", basename: "clean" };
    const { parent, source, switchVersion } = renderVariants(language, [
      { file: clean, sourcePath, kind: "clean", label: "Clean transcript" },
    ], { path: "Notes/.versions/source/source-original.md", mode: "meeting", label: "Work notes" });
    await flushSnapshotLookup();
    const rows = getVariantRows(parent);
    expect(rows.map(getVariantName)).toEqual([expectedOriginal, "Clean transcript"]);
    rows[0].handlers.get("click")?.();
    expect(switchVersion).toHaveBeenCalledWith("Notes/.versions/source/source-original.md", source.path);
    rows[1].handlers.get("click")?.();
    expect(switchVersion).toHaveBeenLastCalledWith(clean, source.path);
  });

  it("does not render an original row when no valid snapshot exists", async () => {
    const sourcePath = "Notes/source.md";
    const derived = { path: "Notes/derived.md", basename: "derived" };
    const { parent, switchVersion, findOriginalVersionForSource } = renderVariants("zh", [
      { file: derived, sourcePath, kind: "minutes", label: "综合纪要" },
    ], null);
    await flushSnapshotLookup();
    const rows = getVariantRows(parent);
    expect(rows.map(getVariantName)).toEqual(["综合纪要"]);
    rows[0].handlers.get("click")?.();
    expect(switchVersion).toHaveBeenCalledWith(derived, sourcePath);
    expect(findOriginalVersionForSource).toHaveBeenCalledOnce();
  });

  it("does not look up or render an original row when there are no derived variants", async () => {
    const { parent, findOriginalVersionForSource } = renderVariants("zh", [], {
      path: "Notes/.versions/source/source-original.md", mode: "monologue", label: "个人笔记",
    });
    await flushSnapshotLookup();
    expect(getVariantRows(parent)).toHaveLength(0);
    expect(findOriginalVersionForSource).not.toHaveBeenCalled();
  });
});
