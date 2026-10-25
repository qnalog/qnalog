import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dom = vi.hoisted(() => {
  /** Minimal stand-in for the Obsidian-augmented DOM the view uses. */
  class FakeElement {
    children: FakeElement[] = [];
    text = "";
    value = "";
    checked = false;
    classes = new Set<string>();
    attrs: Record<string, string> = {};
    listeners: Record<string, Array<(evt: unknown) => void>> = {};
    constructor(readonly tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
      this.text = options.text || "";
      for (const name of (options.cls || "").split(/\s+/).filter(Boolean)) this.classes.add(name);
      Object.assign(this.attrs, options.attr || {});
      if (tag === "option") this.value = this.attrs.value ?? "";
    }
    createEl(tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
      const child = new FakeElement(tag, options);
      this.children.push(child);
      return child;
    }
    createDiv(options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) { return this.createEl("div", options); }
    createSpan(options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) { return this.createEl("span", options); }
    empty() { this.children = []; }
    addClass(cls: string) { this.classes.add(cls); }
    addEventListener(type: string, listener: (evt: unknown) => void) { (this.listeners[type] ||= []).push(listener); }
    dispatch(type: string, evt: Record<string, unknown> = {}) {
      const event = { preventDefault: () => undefined, ...evt };
      for (const listener of this.listeners[type] || []) listener(event);
    }
    all(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.all()]); }
    find(cls: string): FakeElement[] { return this.all().filter((element) => element.classes.has(cls)); }
    textContent(): string { return [this.text, ...this.children.map((child) => child.textContent())].join(""); }
  }
  return { FakeElement };
});

vi.mock("obsidian", () => {
  class ItemView {
    contentEl = new dom.FakeElement("div");
    constructor(readonly leaf: unknown) {}
  }
  return {
    ItemView,
    normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
    parseYaml: () => ({}),
    setIcon: () => undefined,
    Notice: class Notice {},
    TFile: class TFile {},
    TFolder: class TFolder {},
  };
});

import { TodoSummaryView, openTodoSummaryView, type TodoSummaryViewPort } from "../src/ui/todo-summary-view";
import { TODO_SUMMARY_REFRESH_DEBOUNCE_MS, loadTodoSummaryEntries } from "../src/tasks/todo-summary-controller";
import { NS_VIEW_TODO_SUMMARY } from "../src/shared/namespace";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { AUDIO, buildNote, lineOf } from "./helpers/todo-summary-fixture";

type FakeElement = InstanceType<typeof dom.FakeElement>;

const previousLanguage = getActiveUiLanguage();
beforeAll(() => setActiveUiLanguage(resolveUiLanguage("en", "en")));
afterAll(() => setActiveUiLanguage(previousLanguage));

const NEW_PATH = "QnALog/Notes/2026-10-20 1000 Pilot.md";
const OLD_PATH = "QnALog/Notes/2026-10-01 0900 Kickoff.md";
const OLD_NOTE = ["---", "qnalog_mode: meeting", "---", "# Kickoff", "", "- [x] Draft the kickoff memo", "- [ ] Collect feedback", ""].join("\n");

function setup() {
  const files = new Map<string, string>([[NEW_PATH, buildNote()], [OLD_PATH, OLD_NOTE]]);
  const notices: string[] = [];
  const timers: Array<{ id: number; callback: () => void; ms: number }> = [];
  let nextTimer = 1;
  let listener: ((paths: string[]) => void) | null = null;
  const port: TodoSummaryViewPort = {
    listNotes: () => [
      { path: NEW_PATH, title: "Pilot", timestamp: 20, dateLabel: "2026-10-20" },
      { path: OLD_PATH, title: "Kickoff", timestamp: 1, dateLabel: "2026-10-01" },
    ],
    getScope: () => ({ notesFolder: "QnALog/Notes", excludedFolders: [] }),
    getListItems: () => null,
    getFrontmatter: () => ({ qnalog_mode: "meeting" }),
    readCached: async (path) => files.get(path) ?? null,
    read: async (path) => files.get(path) ?? null,
    process: async (path, update) => {
      const current = files.get(path);
      if (current === undefined) return false;
      files.set(path, update(current));
      return true;
    },
    openNoteAtLine: vi.fn(async () => undefined),
    openTimeLink: vi.fn(async () => undefined),
    notify: (message) => { notices.push(message); },
    subscribe: (onChange) => { listener = onChange; return () => { listener = null; }; },
    timers: {
      set: (callback, ms) => { const id = nextTimer++; timers.push({ id, callback, ms }); return id; },
      clear: (id) => { const index = timers.findIndex((timer) => timer.id === id); if (index >= 0) timers.splice(index, 1); },
    },
  };
  const view = new TodoSummaryView({} as never, port);
  const root = view.contentEl as unknown as FakeElement;
  return { view, root, port, files, notices, timers, emit: (paths: string[]) => listener?.(paths), hasListener: () => !!listener };
}

const rowTexts = (root: FakeElement) => root.find("qnalog-todo-summary-text").map((element) => element.text);
const selects = (root: FakeElement) => root.all().filter((element) => element.tag === "select");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("to-do summary view", () => {
  it("renders counts, note groups newest first, and rows with owner, due, acceptance and time", async () => {
    const { view, root } = setup();
    await view.onOpen();
    expect(root.find("qnalog-todo-summary-counts")[0].text).toBe("Open 5 / Total 7");
    expect(root.find("qnalog-todo-summary-group-title").map((element) => element.text)).toEqual(["Pilot", "Kickoff"]);
    expect(rowTexts(root)).toEqual([
      "Prepare the launch checklist", "Book the review room", "Draft the review agenda", "Call the vendor about pricing", "Collect feedback",
    ]);
    const firstRow = root.find("qnalog-todo-summary-row")[0];
    expect(firstRow.find("qnalog-todo-summary-owner")[0].text).toBe("Owner: [Speaker 2]");
    expect(firstRow.find("qnalog-todo-summary-due")[0].text).toBe("Due: by Friday");
    expect(firstRow.find("qnalog-todo-summary-acceptance")[0].text).toBe("Not explicitly accepted");
    expect(firstRow.find("qnalog-todo-summary-time")[0].text).toBe("00:42 approx.");
  });

  it("filters by status, owner and due, and groups by owner with the source note on each row", async () => {
    const { view, root } = setup();
    await view.onOpen();
    const [grouping, status] = selects(root);
    status.value = "done";
    status.dispatch("change");
    expect(rowTexts(root)).toEqual(["Send the pilot invite to the partners", "Draft the kickoff memo"]);

    const owner = selects(root)[2];
    owner.value = "bob";
    owner.dispatch("change");
    expect(rowTexts(root)).toEqual(["Send the pilot invite to the partners"]);

    const ownerReset = selects(root)[2];
    ownerReset.value = "";
    ownerReset.dispatch("change");
    const statusAll = selects(root)[1];
    statusAll.value = "all";
    statusAll.dispatch("change");
    const due = root.find("qnalog-todo-summary-due-filter")[0].children[0];
    due.checked = true;
    due.dispatch("change");
    expect(rowTexts(root)).toEqual(["Prepare the launch checklist"]);

    const dueAgain = root.find("qnalog-todo-summary-due-filter")[0].children[0];
    expect(dueAgain.checked).toBe(true);
    dueAgain.checked = false;
    dueAgain.dispatch("change");
    expect(rowTexts(root)).toHaveLength(7);
    const groupingNow = selects(root)[0];
    expect(grouping.value).toBe("note");
    groupingNow.value = "owner";
    groupingNow.dispatch("change");
    const titles = root.find("qnalog-todo-summary-group-title").map((element) => element.text);
    expect(titles[titles.length - 1]).toBe("No owner");
    expect(root.find("qnalog-todo-summary-source")[0].text).toMatch(/^(Pilot · 2026-10-20|Kickoff · 2026-10-01)$/);
  });

  it("opens the source note at the to-do's line from the text, the source and the time link", async () => {
    const { view, root, port } = setup();
    await view.onOpen();
    root.find("qnalog-todo-summary-text")[1].dispatch("click");
    expect(port.openNoteAtLine).toHaveBeenCalledWith(NEW_PATH, lineOf(buildNote(), "Book the review room"));
    root.find("qnalog-todo-summary-text")[4].dispatch("keydown", { key: "Enter" });
    expect(port.openNoteAtLine).toHaveBeenLastCalledWith(OLD_PATH, 6);
    root.find("qnalog-todo-summary-group-title")[1].dispatch("click");
    expect(port.openNoteAtLine).toHaveBeenLastCalledWith(OLD_PATH, 0);
    root.find("qnalog-todo-summary-time")[0].dispatch("click");
    expect(port.openTimeLink).toHaveBeenCalledWith(AUDIO, "00:42", NEW_PATH);
  });

  it("writes a toggle to the note and re-renders the counts", async () => {
    const { view, root, files } = setup();
    await view.onOpen();
    const checkbox = root.find("qnalog-todo-summary-checkbox")[0];
    checkbox.checked = true;
    checkbox.dispatch("change");
    await flush();
    expect(files.get(NEW_PATH)).toContain("- [x] Prepare the launch checklist");
    expect(root.find("qnalog-todo-summary-counts")[0].text).toBe("Open 4 / Total 7");
    expect(rowTexts(root)).not.toContain("Prepare the launch checklist");
  });

  it("shows a notice, writes nothing and reloads when the line changed", async () => {
    const { view, root, files, notices } = setup();
    await view.onOpen();
    files.set(OLD_PATH, OLD_NOTE.replace("- [ ] Collect feedback", "- [ ] Collect written feedback"));
    const before = files.get(OLD_PATH);
    const checkbox = root.find("qnalog-todo-summary-checkbox")[4];
    checkbox.checked = true;
    checkbox.dispatch("change");
    await flush();
    await flush();
    expect(notices).toEqual(["The note has changed; open it to update this to-do."]);
    expect(files.get(OLD_PATH)).toBe(before);
    expect(rowTexts(root)).toContain("Collect written feedback");
  });

  it("reloads once after a burst of changes to notes in scope and ignores other files", async () => {
    const { view, root, files, timers, emit, hasListener } = setup();
    await view.onOpen();
    emit(["Elsewhere/unrelated.md"]);
    expect(timers).toHaveLength(0);
    files.set(OLD_PATH, `${OLD_NOTE}- [ ] Added later\n`);
    emit([OLD_PATH]);
    emit([OLD_PATH]);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(TODO_SUMMARY_REFRESH_DEBOUNCE_MS);
    timers[0].callback();
    await flush();
    expect(rowTexts(root)).toContain("Added later");
    await view.onClose();
    expect(hasListener()).toBe(false);
  });
});

describe("loading", () => {
  it("reads only notes in scope whose cached list items hold a task, and notes without a cache", async () => {
    const { port, files } = setup();
    const read = vi.fn(async (path: string) => files.get(path) ?? null);
    const entries = await loadTodoSummaryEntries({
      ...port,
      listNotes: () => [
        { path: NEW_PATH, title: "Pilot", timestamp: 20, dateLabel: "2026-10-20" },
        { path: OLD_PATH, title: "Kickoff", timestamp: 1, dateLabel: "2026-10-01" },
        { path: "QnALog/Notes/2026-09-01 No tasks.md", title: "No tasks", timestamp: 0, dateLabel: "" },
        { path: "Elsewhere/2026-09-01 Outside.md", title: "Outside", timestamp: 0, dateLabel: "" },
      ],
      getListItems: (path) => path === OLD_PATH ? null : path.includes("No tasks") ? [{ line: 3 }] : [{ line: lineOf(buildNote(), "Book the review room"), task: " " }],
      readCached: read,
    });
    expect(read.mock.calls.map(([path]) => path)).toEqual([NEW_PATH, OLD_PATH]);
    expect(entries.map((entry) => entry.text)).toEqual(["Book the review room", "Draft the kickoff memo", "Collect feedback"]);
  });
});

describe("opening the view", () => {
  it("reveals an open summary or opens one in a new tab", async () => {
    const existing = { setViewState: vi.fn() };
    const fresh = { setViewState: vi.fn(async () => undefined) };
    const workspace = {
      getLeavesOfType: vi.fn(() => [existing] as never[]),
      getLeaf: vi.fn(() => fresh as never),
      revealLeaf: vi.fn(async () => undefined),
    };
    await openTodoSummaryView(workspace);
    expect(workspace.revealLeaf).toHaveBeenCalledWith(existing);
    expect(workspace.getLeaf).not.toHaveBeenCalled();

    workspace.getLeavesOfType.mockReturnValue([]);
    await openTodoSummaryView(workspace);
    expect(workspace.getLeaf).toHaveBeenCalledWith("tab");
    expect(fresh.setViewState).toHaveBeenCalledWith({ type: NS_VIEW_TODO_SUMMARY, active: true });
    expect(workspace.revealLeaf).toHaveBeenLastCalledWith(fresh);
  });
});
