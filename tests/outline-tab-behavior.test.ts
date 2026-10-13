import { describe, expect, it, vi } from "vitest";
import { resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

vi.mock("obsidian", () => {
  class ItemView {}
  class Modal {}
  class SuggestModal {}
  class FuzzySuggestModal {}
  class PluginSettingTab {}
  class Menu {
    items: Array<{ title?: string; icon?: string; onClick?: () => unknown }> = [];
    addItem(callback: (item: Record<string, unknown>) => void) {
      const item = {
        setTitle(title: string) { this.title = title; return this; },
        setIcon(icon: string) { this.icon = icon; return this; },
        setDisabled(disabled: boolean) { this.disabled = disabled; return this; },
        setChecked() { return this; },
        setSubmenu() { return new Menu(); },
        onClick(handler: () => unknown) { this.onClick = handler; return this; },
      };
      callback(item);
      this.items.push(item);
      return this;
    }
    addSeparator() { this.items.push({}); }
  }
  return {
    ItemView, Modal, SuggestModal, FuzzySuggestModal, PluginSettingTab, Menu,
    normalizePath: (path: string) => path.replace(/\\/g, "/"),
    setIcon: () => undefined,
  };
});
vi.mock("../src/recent/recent-notes", async () => {
  const actual = await vi.importActual<typeof import("../src/recent/recent-notes")>("../src/recent/recent-notes");
  return { ...actual, getQueueTasksForMarkdown: () => [], getRecentQueueProcessingState: () => null };
});

import { OutlineView } from "../src/ui/outline-view";

const TABS = ["", "outline", "extract", "ask", "recent", "topics"];
const BROWSE = new Set(["recent", "topics"]);

function viewWith(tab: string, sessionId: string, showRecentHome = true): OutlineView {
  const view = Object.create(OutlineView.prototype) as OutlineView;
  Object.assign(view, { idlePanelTab: tab, outlineSessionId: sessionId, showRecentHome });
  return view;
}

describe("outline sidebar tab on note, session and recording events", () => {
  for (const tab of TABS) {
    const label = tab || "(default)";
    it(`${label}: opening or focusing a note keeps browse tabs and resets the others to the default`, () => {
      const view = viewWith(tab, "");
      view.handleActiveLeafChange();
      expect(view.idlePanelTab).toBe(BROWSE.has(tab) ? tab : "");
      if (!BROWSE.has(tab)) expect(view.showRecentHome).toBe(true);
    });

    it(`${label}: starting a recording shows the outline`, () => {
      const view = viewWith(tab, "");
      view.syncSessionOutline({ id: "session-a", segments: [] });
      expect(view.idlePanelTab).toBe("outline");
      expect(view.showRecentHome).toBe(false);
    });

    it(`${label}: ending a session (recording stop or finalization) shows the outline`, () => {
      const view = viewWith(tab, "session-a", false);
      view.syncSessionOutline(null);
      expect(view.idlePanelTab).toBe("outline");
      expect(view.showRecentHome).toBe(false);
    });

    it(`${label}: switching to another session keeps browse tabs and shows the outline otherwise`, () => {
      const view = viewWith(tab, "session-a", true);
      view.syncSessionOutline({ id: "session-b", segments: [] });
      expect(view.idlePanelTab).toBe(BROWSE.has(tab) ? tab : "outline");
    });
  }

  it("an unchanged session id leaves the tab alone", () => {
    const view = viewWith("recent", "session-a");
    view.syncSessionOutline({ id: "session-a", segments: [] });
    expect(view.idlePanelTab).toBe("recent");
  });
});

describe("idle sidebar tab order", () => {
  it("renders notes, outline, distill, Q&A, and topics in that order", () => {
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    const labels: string[] = [];
    const tabs = {
      createEl: (_tag: string, options: { text: string }) => {
        labels.push(options.text);
        return { onclick: undefined as (() => void) | undefined };
      },
    };
    const root = { createDiv: () => tabs };
    const view = Object.create(OutlineView.prototype) as OutlineView;
    Object.assign(view, { topicPromptRefreshPaths: new Set<string>() });
    view.renderIdleTabs(root, "outline");
    expect(labels).toEqual(["Notes", "Outline", "Distill", "Q&A", "Topics"]);
  });
});

describe("recent note sidebar context actions", () => {
  async function setup(hasPipelineStarted: boolean) {
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    const file = { path: "Notes/example.md" };
    const openFile = vi.fn(async () => undefined);
    const requestSedimentExtraction = vi.fn();
    const view = Object.create(OutlineView.prototype) as OutlineView;
    const menuHolder: { menu?: { items: Array<{ title?: string; icon?: string; disabled?: boolean; onClick?: () => unknown }> } } = {};
    Object.assign(view, {
      plugin: { noteWriter: { detectModeFromMarkdown: () => "" }, settings: {} },
      app: { workspace: { getActiveFile: () => null, getLeaf: () => ({ openFile }) } },
      getSedimentPanelState: () => ({ hasPipelineStarted, scanning: false }),
      requestSedimentExtraction,
      render: vi.fn(),
      showMenuAtMouse: (menu: typeof menuHolder.menu) => { menuHolder.menu = menu; },
    });
    view.showRecentNoteContextMenu({}, file, () => undefined);
    const menu = menuHolder.menu!;
    const outline = menu.items.find((item) => item.title === "Open outline");
    const extract = menu.items.find((item) => item.title === "Distill content");
    return { file, openFile, requestSedimentExtraction, view, outline, extract, menu };
  }

  it("offers in-place reorganization and labels the existing submenu as derived versions", async () => {
    const h = await setup(false);
    expect(h.menu.items.find((item) => item.title === "Reorganize")).toMatchObject({ icon: "refresh-cw", disabled: true });
    expect(h.menu.items.some((item) => item.title === "Generate derived version")).toBe(true);
  });

  it("opens the note before selecting the outline tab", async () => {
    const h = await setup(false);
    h.outline?.onClick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.openFile).toHaveBeenCalledWith(h.file);
    expect(h.view.idlePanelTab).toBe("outline");
    expect(h.view.showRecentHome).toBe(false);
    expect(h.requestSedimentExtraction).not.toHaveBeenCalled();
  });

  it("selects distill and requests a scan only when the note has no scan state", async () => {
    const fresh = await setup(false);
    fresh.extract?.onClick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(fresh.view.idlePanelTab).toBe("extract");
    expect(fresh.view.showRecentHome).toBe(false);
    expect(fresh.requestSedimentExtraction).toHaveBeenCalledWith(fresh.file, false);

    const scanned = await setup(true);
    scanned.extract?.onClick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(scanned.view.idlePanelTab).toBe("extract");
    expect(scanned.requestSedimentExtraction).not.toHaveBeenCalled();
  });
});
