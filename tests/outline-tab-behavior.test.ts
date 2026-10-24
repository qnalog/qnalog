import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

const uiMocks = vi.hoisted(() => ({ confirm: vi.fn(async () => true), notices: [] as string[], modals: [] as unknown[] }));

vi.mock("obsidian", () => {
  class FakeElement {
    children: FakeElement[] = [];
    text = "";
    value = "";
    disabled = false;
    checked = false;
    onclick?: () => void | Promise<void>;
    onchange?: () => void;
    className = "";
    constructor(options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
      this.text = options.text || "";
      this.className = options.cls || "";
      this.value = options.attr?.value || "";
    }
    empty() { this.children = []; }
    addClass(cls: string) { this.className += ` ${cls}`; }
    createEl(_tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
      const child = new FakeElement(options);
      this.children.push(child);
      return child;
    }
    createDiv(options: { text?: string; cls?: string } = {}) {
      const child = new FakeElement(options);
      this.children.push(child);
      return child;
    }
    createSpan(options: { text?: string } = {}) {
      const child = new FakeElement(options);
      this.children.push(child);
      return child;
    }
    setText(text: string) { this.text = text; }
  }
  class ItemView {}
  class Modal {
    contentEl = new FakeElement();
    closed = false;
    constructor(_app: unknown) { uiMocks.modals.push(this); }
    open() {}
    close() { this.closed = true; }
  }
  class TFile {}
  class SuggestModal {}
  class FuzzySuggestModal {}
  class PluginSettingTab {}
  class Notice { constructor(message: string) { uiMocks.notices.push(String(message)); } }
  class Menu {
    items: Array<{ title?: string; icon?: string; checked?: boolean; submenu?: Menu; onClick?: () => unknown }> = [];
    addItem(callback: (item: Record<string, unknown>) => void) {
      const item = {
        setTitle(title: string) { this.title = title; return this; },
        setIcon(icon: string) { this.icon = icon; return this; },
        setDisabled(disabled: boolean) { this.disabled = disabled; return this; },
        setChecked(checked: boolean) { this.checked = checked; return this; },
        setSubmenu() { this.submenu = new Menu(); return this.submenu; },
        onClick(handler: () => unknown) { this.onClick = handler; return this; },
      };
      callback(item);
      this.items.push(item);
      return this;
    }
    addSeparator() { this.items.push({}); }
  }
  return {
    ItemView, Modal, TFile, SuggestModal, FuzzySuggestModal, PluginSettingTab, Menu, Notice,
    normalizePath: (path: string) => path.replace(/\\/g, "/"),
    parseYaml: (yaml: string) => JSON.parse(yaml),
    setIcon: () => undefined,
  };
});
vi.mock("../src/ui/helpers", async () => {
  const actual = await vi.importActual<typeof import("../src/ui/helpers")>("../src/ui/helpers");
  return { ...actual, qnalogConfirm: uiMocks.confirm };
});
vi.mock("../src/recent/recent-notes", async () => {
  const actual = await vi.importActual<typeof import("../src/recent/recent-notes")>("../src/recent/recent-notes");
  return { ...actual, getQueueTasksForMarkdown: () => [], getRecentQueueProcessingState: () => null };
});

import { OutlineView } from "../src/ui/outline-view";
import * as obsidian from "obsidian";

const initialUiLanguage = getActiveUiLanguage();
afterEach(() => setActiveUiLanguage(initialUiLanguage));

const TABS = ["", "outline", "extract", "ask", "recent", "topics"];
const BROWSE = new Set(["recent", "topics"]);

function viewWith(tab: string, sessionId: string, showRecentHome = true): OutlineView {
  const view = Object.create(OutlineView.prototype) as OutlineView;
  Object.assign(view, { idlePanelTab: tab, outlineSessionId: sessionId, showRecentHome });
  return view;
}

describe("outline sidebar tab on note, session and recording events", () => {
  it("starts on notes when there is no session and shows the outline when recording starts or ends", () => {
    const view = new OutlineView({} as never, {} as never);
    expect(view.idlePanelTab || "outline").toBe("recent");

    view.syncSessionOutline({ id: "session-a", segments: [] });
    expect(view.idlePanelTab || "outline").toBe("outline");

    view.syncSessionOutline(null);
    expect(view.idlePanelTab || "outline").toBe("outline");
  });

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
  async function setup(hasPipelineStarted: boolean, markdown = "", withErrataUi = false, withRename = true) {
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    const file = { path: "Notes/example.md" };
    const openFile = vi.fn(async () => undefined);
    const cachedRead = vi.fn(async () => markdown);
    const requestSedimentExtraction = vi.fn();
    const reorganizeNoteInPlace = vi.fn(async () => true);
    const saveAsNewVersion = vi.fn(async () => true);
    const view = Object.create(OutlineView.prototype) as OutlineView;
    const menuHolder: { menu?: { items: Array<{ title?: string; icon?: string; disabled?: boolean; onClick?: () => unknown }> } } = {};
    Object.assign(view, {
      plugin: { noteWriter: { detectModeFromMarkdown: () => "" }, repolish: { reorganizeNoteInPlace }, settings: {}, app: {} },
      app: { vault: { cachedRead }, workspace: { getActiveFile: () => null, getLeaf: () => ({ openFile }) } },
      sediment: { getSedimentPanelState: () => ({ hasPipelineStarted, scanning: false }), requestSedimentExtraction },
      errataUi: withErrataUi ? { openForFile: vi.fn(async () => undefined) } : null,
      regenerateUi: {
        app: { vault: { cachedRead } },
        settings: { repolishPreference: "" },
        saveSettings: vi.fn(async () => undefined),
        detectNoteMode: () => "learning",
        reorganizeNoteInPlace,
        saveAsNewVersion,
      },
      render: vi.fn(),
      showMenuAtMouse: (menu: typeof menuHolder.menu) => { menuHolder.menu = menu; },
    });
    view.showRecentNoteContextMenu({}, file, withRename ? () => undefined : undefined);
    const menu = menuHolder.menu!;
    const outline = menu.items.find((item) => item.title === "Open outline");
    const extract = menu.items.find((item) => item.title === "Distill content");
    return { file, openFile, cachedRead, reorganizeNoteInPlace, saveAsNewVersion, requestSedimentExtraction, view, outline, extract, menu };
  }

  it("offers Reorganize and Save as new version, each listing the note's own mode first", async () => {
    const h = await setup(false);
    const reorganize = h.menu.items.find((item) => item.title === "Reorganize");
    const saveAs = h.menu.items.find((item) => item.title === "Save as new version");
    expect(reorganize).toMatchObject({ icon: "refresh-cw" });
    expect(h.cachedRead).not.toHaveBeenCalled();
    for (const sub of [reorganize?.submenu, saveAs?.submenu]) {
      expect(sub?.items[0]).toMatchObject({ checked: true });
      expect(sub?.items.filter((item) => item.checked)).toHaveLength(1);
    }
    expect(saveAs?.submenu?.items.at(-1)?.title).toBe("Clean copy");
    expect(h.menu.items.some((item) => item.title === "Generate derived version" || item.title === "Generate Clean Copy")).toBe(false);
  });

  it("routes a mode pick to the matching action with that mode", async () => {
    uiMocks.confirm.mockClear();
    const h = await setup(false, "# Note\n\nNo transcript here.");
    const reorganizeFirst = h.menu.items.find((item) => item.title === "Reorganize")?.submenu?.items[0];
    await reorganizeFirst?.onClick?.();
    await vi.waitFor(() => expect(h.reorganizeNoteInPlace).toHaveBeenCalledWith(h.file, { mode: "learning", preference: null }));
    const saveFirst = h.menu.items.find((item) => item.title === "Save as new version")?.submenu?.items[0];
    await saveFirst?.onClick?.();
    expect(h.saveAsNewVersion).toHaveBeenCalledWith(h.file, "learning", null);
  });

  it("shows Open errata only when the UI port is available", async () => {
    const withoutPort = await setup(false);
    expect(withoutPort.menu.items.some((item) => item.title === "Open errata")).toBe(false);

    const withPort = await setup(false, "", true);
    expect(withPort.menu.items.find((item) => item.title === "Open errata")).toMatchObject({ icon: "file-warning" });
    const labels = withPort.menu.items.map((item) => item.title).filter(Boolean);
    expect(labels.indexOf("Open errata")).toBe(labels.indexOf("Merge with Previous Recording") + 1);
  });

  it("orders recent-note menu groups and keeps separators between non-empty groups", async () => {
    const h = await setup(false, "", true);
    expect(h.menu.items.map((item) => item.title).filter(Boolean)).toEqual([
      "Open outline",
      "Distill content",
      "Continue Recording into This Note",
      "Merge with Previous Recording",
      "Open errata",
      "Reorganize",
      "Save as new version",
      "Rename",
      "Delete Transcript Record",
    ]);
    const withoutRename = await setup(false, "", false, false);
    const entries = withoutRename.menu.items;
    expect(entries[0]?.title).toBe("Open outline");
    expect(entries.at(-1)?.title).toBe("Delete Transcript Record");
    expect(entries.every((entry, index) => entry.title || (index > 0 && index < entries.length - 1
      && entries[index - 1]?.title && entries[index + 1]?.title))).toBe(true);
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

interface ModalElement {
  text: string;
  children: ModalElement[];
  disabled?: boolean;
  onclick?: () => void | Promise<void>;
  className?: string;
}

interface TestModal {
  contentEl: ModalElement;
  closed: boolean;
}

function modalElements(root: ModalElement): ModalElement[] {
  return [root, ...root.children.flatMap(modalElements)];
}

describe("recent note deletion confirmation", () => {
  it("keeps the source when an unindexed derived note appears after plain-delete confirmation opens", async () => {
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    uiMocks.modals.length = 0;
    uiMocks.notices.length = 0;
    const source = Object.assign(new obsidian.TFile(), {
      path: "Notes/source.md", basename: "source", extension: "md",
    });
    const variant = Object.assign(new obsidian.TFile(), {
      path: "Notes/derived.md", basename: "derived", extension: "md",
    });
    const files: InstanceType<typeof obsidian.TFile>[] = [source];
    const content = new Map<object, string>([[source, "---\n{}\n---\nsource body"]]);
    const metadataCache = {
      getFileCache: (file: object) => file === source ? { frontmatter: {} } : null,
    };
    const trashFile = vi.fn(async () => undefined);
    const view = Object.create(OutlineView.prototype) as OutlineView;
    Object.assign(view, {
      app: {
        vault: {
          getMarkdownFiles: () => files,
          cachedRead: async (file: object) => content.get(file) || "",
        },
        metadataCache,
        fileManager: { trashFile, processFrontMatter: vi.fn() },
      },
      plugin: { queue: { tasks: [] }, settings: {} },
      render: vi.fn(),
    });

    await view.confirmDeleteRecentNote(source as never);
    const modal = uiMocks.modals[0] as TestModal;
    const confirm = modalElements(modal.contentEl).find((element) => element.text === "Confirm delete");
    expect(confirm).toBeDefined();

    content.set(variant, `---\n${JSON.stringify({
      qnalog_type: "QnALog派生版本", variant_kind: "minutes", qnalog_source_path: source.path,
      source_id: "source-id", qnalog_contains_raw: false,
    })}\n---\nderived body`);
    files.push(variant);
    await confirm?.onclick?.();

    expect(trashFile).not.toHaveBeenCalled();
    expect(modal.closed).toBe(false);
    expect(confirm?.disabled).toBe(false);
    expect(uiMocks.notices.at(-1)).toContain("Derived versions changed while the dialog was open");
  });
});

describe("outline sidebar repaint on workspace focus changes", () => {
  it("schedules a repaint when the view opens and whenever the active leaf changes", async () => {
    const handlers = new Map<string, () => void>();
    const view = Object.create(OutlineView.prototype) as OutlineView;
    const scheduleUpdate = vi.fn();
    const syncActiveRows = vi.fn();
    Object.assign(view, {
      containerEl: { children: [null, { empty: () => undefined }] },
      app: {
        workspace: { on: (name: string, handler: () => void) => { handlers.set(name, handler); return name; } },
        vault: { on: (name: string) => name },
        metadataCache: { on: (name: string) => name },
      },
      plugin: {
        recorder: { on: () => () => undefined },
        getCurrentSession: () => null,
        settings: { enableRealtimeOutline: false },
      },
      registerEvent: () => undefined,
      render: () => undefined,
      scheduleUpdate,
      syncActiveRows,
    });

    await view.onOpen();
    expect(scheduleUpdate).toHaveBeenCalledTimes(1);

    view.idlePanelTab = "ask";
    handlers.get("active-leaf-change")?.();
    expect(view.idlePanelTab).toBe("");
    expect(syncActiveRows).toHaveBeenCalledTimes(1);
    expect(scheduleUpdate).toHaveBeenCalledTimes(2);
  });
});

describe("note panel after a property change", () => {
  it("drops the cached panel data of that note when its metadata changes, so saved speaker names show", async () => {
    const metaHandlers = new Map<string, (file: unknown) => void>();
    const view = Object.create(OutlineView.prototype) as OutlineView;
    const render = vi.fn();
    Object.assign(view, {
      containerEl: { children: [null, { empty: () => undefined }] },
      app: {
        workspace: { on: (name: string) => name },
        vault: { on: (name: string) => name },
        metadataCache: { on: (name: string, handler: (file: unknown) => void) => { metaHandlers.set(name, handler); return name; } },
      },
      plugin: {
        recorder: { on: () => () => undefined },
        getCurrentSession: () => null,
        settings: { enableRealtimeOutline: false },
      },
      registerEvent: () => undefined,
      render,
      scheduleUpdate: vi.fn(),
      syncActiveRows: vi.fn(),
      isRecentNotePath: () => false,
    });
    await view.onOpen();
    render.mockClear();
    const file = Object.assign(new obsidian.TFile(), { path: "QnALog/a.md" });
    const other = Object.assign(new obsidian.TFile(), { path: "QnALog/b.md" });

    view.notePanelCacheKey = "QnALog/a.md|100";
    view.notePanelCacheData = { speakerMappings: {} } as never;
    view.notePanelLoading = false;
    metaHandlers.get("changed")?.(other);
    expect(view.notePanelCacheKey).toBe("QnALog/a.md|100");
    expect(render).not.toHaveBeenCalled();

    metaHandlers.get("changed")?.(file);
    expect(view.notePanelCacheKey).toBe("");
    expect(view.notePanelCacheData).toBeUndefined();
    expect(render).toHaveBeenCalledTimes(1);
  });
});
