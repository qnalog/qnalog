import { describe, expect, it, vi } from "vitest";

const menuState = vi.hoisted(() => ({ titles: [] as string[], actions: [] as Array<{ title: string; onClick?: () => void }>, notices: [] as string[] }));
vi.mock("obsidian", () => {
  class FakeElement {
    children: FakeElement[] = [];
    text = "";
    cls = "";
    listeners = new Map<string, (event?: MouseEvent | KeyboardEvent) => void>();
    constructor(text = "", cls = "") { this.text = text; this.cls = cls; }
    createDiv(options: { cls?: string; text?: string } = {}) { return this.add(new FakeElement(options.text || "", options.cls || "")); }
    createEl(_tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) { return this.add(new FakeElement(options.text || "", options.cls || "")); }
    createSpan(options: { cls?: string; text?: string } = {}) { return this.add(new FakeElement(options.text || "", options.cls || "")); }
    add(child: FakeElement) { this.children.push(child); return child; }
    addEventListener(name: string, fn: (event?: MouseEvent | KeyboardEvent) => void) { this.listeners.set(name, fn); }
    setText(text: string) { this.text = text; }
    addClass(cls: string) { this.cls += ` ${cls}`; }
    remove() { this.text = ""; }
  }
  class Menu {
    items: Array<{ title: string; onClick?: () => void }> = [];
    addItem(build: (item: { setTitle(text: string): this; setIcon(icon: string): this; onClick(fn: () => void): this }) => void) {
      const item = { title: "", onClick: undefined as (() => void) | undefined, setTitle(text: string) { this.title = text; menuState.titles.push(text); return this; }, setIcon() { return this; }, onClick(fn: () => void) { this.onClick = fn; return this; } };
      build(item);
      this.items.push(item);
    }
    addSeparator() {}
    showAtMouseEvent() { menuState.actions = [...this.items]; }
  }
  class Modal { contentEl = new FakeElement(); constructor(public app: unknown) {} }
  class Notice { constructor(message: string) { menuState.notices.push(message); } }
  return { Menu, Modal, Notice, setIcon: () => undefined };
});
vi.mock("../src/ui/helpers", () => ({ qnalogConfirm: vi.fn(async () => true) }));

import { TopicsPanel } from "../src/ui/topics-panel";

interface FakeTree { text: string; cls: string; children: FakeTree[]; listeners: Map<string, (event?: MouseEvent | KeyboardEvent) => void> }
function allText(node: FakeTree): string { return `${node.text} ${node.children.map(allText).join(" ")}`; }
function descendants(node: FakeTree): FakeTree[] { return node.children.flatMap((child) => [child, ...descendants(child)]); }

describe("topics panel", () => {
  it("renders topic members, recency, pending badge, and contextual actions", async () => {
    const port = {
      isConfigured: () => true, getVersion: () => "x", text: (key: string) => key,
      listTopics: vi.fn(async () => [{ path: "Topics/Planning.md", page: { id: "one", title: "Planning", updated: "2026-10-10T00:00:00Z", members: ["a.md", "b.md"] } }]),
      getUncontributedMembers: vi.fn(async () => []), previewOrphanMembers: vi.fn(),
      countPending: vi.fn(async () => 3),
      scanUnintegrated: vi.fn(), preview: vi.fn(), apply: vi.fn(), cancel: vi.fn(), getCandidates: vi.fn(), estimate: vi.fn(), undoLastUpdate: vi.fn(),
      deleteTopic: vi.fn(), mergeTopics: vi.fn(), ignoreNote: vi.fn(), noteArrived: vi.fn(), refreshPrompt: vi.fn(), getPrompts: vi.fn(), removePrompt: vi.fn(), isSourceNote: vi.fn(), openTopic: vi.fn(), openSource: vi.fn(),
    };
    const root = new FakePanelEl() as unknown as HTMLElement;
    const panel = new TopicsPanel({} as never, port as never, () => undefined);
    await panel.render(root);
    await vi.waitFor(() => expect(allText((root as unknown as { children: FakeTree[] }).children[0])).toContain("3 pending"));
    const section = (root as unknown as { children: FakeTree[] }).children[0];
    const row = descendants(section).find((item) => item.cls.includes("qnalog-outline-recent-row"));
    expect(row).toBeDefined();
    row?.listeners.get("contextmenu")?.({ preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent);
    await vi.waitFor(() => expect(menuState.titles).toContain("Scan for notes to integrate"));
    expect(menuState.titles).toEqual(expect.arrayContaining(["Scan for notes to integrate", "Undo last update", "Merge into…", "Delete topic"]));
  });

  it("shows an error notice when undo rejects and does not show undo success", async () => {
    menuState.notices.length = 0;
    menuState.actions = [];
    const port = {
      isConfigured: () => true, getVersion: () => "x", text: (key: string) => key,
      listTopics: vi.fn(async () => [{ path: "Topics/Planning.md", page: { id: "one", title: "Planning", layout: 2, updated: "2026-10-10T00:00:00Z", members: ["a.md"] } }]),
      getUncontributedMembers: vi.fn(async () => []), previewOrphanMembers: vi.fn(), countPending: vi.fn(async () => 0),
      scanUnintegrated: vi.fn(), preview: vi.fn(), apply: vi.fn(), cancel: vi.fn(), getCandidates: vi.fn(), estimate: vi.fn(), undoLastUpdate: vi.fn(async () => { throw new Error("storage failure"); }),
      deleteTopic: vi.fn(), mergeTopics: vi.fn(), isSourceNote: vi.fn(), openTopic: vi.fn(), openSource: vi.fn(),
    };
    const root = new FakePanelEl() as unknown as HTMLElement;
    await new TopicsPanel({} as never, port as never, () => undefined).render(root);
    const row = descendants((root as unknown as { children: FakeTree[] }).children[0]).find((item) => item.cls.includes("qnalog-outline-recent-row"));
    row?.listeners.get("contextmenu")?.({ preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent);
    await vi.waitFor(() => expect(menuState.actions.some((item) => item.title === "Undo last update")).toBe(true));

    menuState.actions.find((item) => item.title === "Undo last update")?.onClick?.();

    await vi.waitFor(() => expect(menuState.notices).toContain("Undo could not be confirmed. Check the topic page and its errata, then retry Undo."));
    expect(menuState.notices).not.toContain("Topic update undone.");
  });

  it("uses the minutes row structure: chip, body with name and meta, and actions with the badge and ⋯", async () => {
    const port = {
      isConfigured: () => true, getVersion: () => "x", text: (key: string) => key,
      listTopics: vi.fn(async () => [{ path: "Topics/Planning.md", page: { id: "one", title: "Planning", updated: "2026-10-10T00:00:00Z", members: ["a.md", "b.md"] } }]),
      getUncontributedMembers: vi.fn(async () => []), previewOrphanMembers: vi.fn(),
      countPending: vi.fn(async () => 3),
      scanUnintegrated: vi.fn(), preview: vi.fn(), apply: vi.fn(), cancel: vi.fn(), getCandidates: vi.fn(), estimate: vi.fn(), undoLastUpdate: vi.fn(),
      deleteTopic: vi.fn(), mergeTopics: vi.fn(), ignoreNote: vi.fn(), noteArrived: vi.fn(), refreshPrompt: vi.fn(), getPrompts: vi.fn(), removePrompt: vi.fn(), isSourceNote: vi.fn(), openTopic: vi.fn(), openSource: vi.fn(),
    };
    const root = new FakePanelEl() as unknown as HTMLElement;
    await new TopicsPanel({} as never, port as never, () => undefined, "Topics/Planning.md").render(root);
    await vi.waitFor(() => expect(allText((root as unknown as { children: FakeTree[] }).children[0])).toContain("3 pending"));
    const section = (root as unknown as { children: FakeTree[] }).children[0];
    const row = descendants(section).find((item) => item.cls.includes("qnalog-outline-recent-row")) as unknown as FakePanelEl;
    expect(row.cls).toContain("is-active");
    expect(row.children.map((child) => child.cls)).toEqual(["qnalog-outline-recent-chip", "qnalog-outline-recent-body"]);
    const body = row.children[1];
    expect(body.children.map((child) => child.cls)).toEqual(["qnalog-outline-recent-title-line", "qnalog-outline-recent-meta", "qnalog-outline-recent-actions"]);
    expect(body.children[0].children[0].text).toBe("Planning");
    const local = new Date("2026-10-10T00:00:00Z");
    const monthDay = `${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
    expect(body.children[1].text).toBe(`2 member notes · Updated ${monthDay}`);
    const actions = body.children[2];
    expect(actions.children.map((child) => child.cls)).toEqual(expect.arrayContaining(["qnalog-topics-pending is-visible", "qnalog-outline-recent-action qnalog-topics-more"]));
    const more = actions.children.find((child) => child.cls.includes("qnalog-topics-more")) as unknown as FakePanelEl;
    more.listeners.get("click")?.({ preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent);
    await vi.waitFor(() => expect(menuState.titles).toContain("Scan for notes to integrate"));
    expect(menuState.titles).toEqual(expect.arrayContaining(["Scan for notes to integrate", "Delete topic"]));
  });

  it("shows the organizer action with the number of uncited members", async () => {
    const port = {
      isConfigured: () => true, getVersion: () => "x", text: (key: string) => key,
      listTopics: vi.fn(async () => [{ path: "Topics/Planning.md", page: { id: "one", title: "Planning", updated: "2026-10-10T00:00:00Z", members: ["a.md", "b.md"] } }]),
      getUncontributedMembers: vi.fn(async () => [{ path: "b.md", title: "B" }]), previewOrphanMembers: vi.fn(),
      countPending: vi.fn(async () => 0),
      scanUnintegrated: vi.fn(), preview: vi.fn(), apply: vi.fn(), cancel: vi.fn(), getCandidates: vi.fn(), estimate: vi.fn(), undoLastUpdate: vi.fn(),
      deleteTopic: vi.fn(), mergeTopics: vi.fn(), ignoreNote: vi.fn(), noteArrived: vi.fn(), refreshPrompt: vi.fn(), getPrompts: vi.fn(), removePrompt: vi.fn(), isSourceNote: vi.fn(), openTopic: vi.fn(), openSource: vi.fn(),
    };
    const root = new FakePanelEl() as unknown as HTMLElement;
    await new TopicsPanel({} as never, port as never, () => undefined).render(root);
    const row = descendants((root as unknown as { children: FakeTree[] }).children[0]).find((item) => item.cls.includes("qnalog-outline-recent-row"));
    row?.listeners.get("contextmenu")?.({ preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent);
    await vi.waitFor(() => expect(menuState.titles).toContain("Organize notes with no contributed content (1)"));
  });

  it("offers removing member notes from the topic menu", async () => {
    const preview = { topicId: "one", expectedHash: "h", pageWasManuallyEdited: false, items: [], completedBatches: 0, totalBatches: 0 };
    const port = {
      isConfigured: () => true, getVersion: () => "x", text: (key: string) => key,
      listTopics: vi.fn(async () => [{ path: "Topics/Planning.md", page: { id: "one", title: "Planning", updated: "2026-10-10T00:00:00Z", members: ["a.md", "b.md"], memberLinks: ["[[a|Alpha]]", "[[b|Beta]]"] } }]),
      getUncontributedMembers: vi.fn(async () => []), previewOrphanMembers: vi.fn(), previewRemoveMembers: vi.fn(async () => preview),
      countPending: vi.fn(async () => 0),
      scanUnintegrated: vi.fn(), preview: vi.fn(), apply: vi.fn(), cancel: vi.fn(), getCandidates: vi.fn(), estimate: vi.fn(), undoLastUpdate: vi.fn(),
      deleteTopic: vi.fn(), mergeTopics: vi.fn(), ignoreNote: vi.fn(), noteArrived: vi.fn(), refreshPrompt: vi.fn(), getPrompts: vi.fn(), removePrompt: vi.fn(), isSourceNote: vi.fn(), openTopic: vi.fn(), openSource: vi.fn(),
    };
    const root = new FakePanelEl() as unknown as HTMLElement;
    await new TopicsPanel({} as never, port as never, () => undefined).render(root);
    const row = descendants((root as unknown as { children: FakeTree[] }).children[0]).find((item) => item.cls.includes("qnalog-outline-recent-row"));
    row?.listeners.get("contextmenu")?.({ preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent);
    await vi.waitFor(() => expect(menuState.titles).toContain("Remove notes from this topic…"));
  });

  it("shows the pending badge only when notes are waiting", async () => {
    const port = {
      isConfigured: () => true, getVersion: () => "x", text: (key: string) => key,
      listTopics: vi.fn(async () => [{ path: "Topics/Quiet.md", page: { id: "quiet", title: "Quiet", updated: "2026-10-10T00:00:00Z", members: [] } }]),
      getUncontributedMembers: vi.fn(async () => []), previewOrphanMembers: vi.fn(),
      countPending: vi.fn(async () => 0),
      scanUnintegrated: vi.fn(), preview: vi.fn(), apply: vi.fn(), cancel: vi.fn(), getCandidates: vi.fn(), estimate: vi.fn(), undoLastUpdate: vi.fn(),
      deleteTopic: vi.fn(), mergeTopics: vi.fn(), ignoreNote: vi.fn(), noteArrived: vi.fn(), refreshPrompt: vi.fn(), getPrompts: vi.fn(), removePrompt: vi.fn(), isSourceNote: vi.fn(), openTopic: vi.fn(), openSource: vi.fn(),
    };
    const root = new FakePanelEl() as unknown as HTMLElement;
    await new TopicsPanel({} as never, port as never, () => undefined).render(root);
    await vi.waitFor(() => expect(port.countPending).toHaveBeenCalled());
    const section = (root as unknown as { children: FakeTree[] }).children[0];
    const badges = descendants(section).filter((item) => item.cls.includes("qnalog-topics-pending"));
    expect(badges.some((badge) => badge.cls.includes("is-visible"))).toBe(false);
    expect(descendants(section).find((item) => item.cls.includes("qnalog-outline-recent-row") && !item.cls.includes("is-active"))).toBeDefined();
  });

  it("renders a guided empty state when no topic folder exists", async () => {
    const port = { isConfigured: () => false, text: (key: string) => key };
    const root = new FakePanelEl() as unknown as HTMLElement;
    await new TopicsPanel({} as never, port as never, () => undefined).render(root);
    expect(allText((root as unknown as { children: FakeTree[] }).children[0])).toContain("Right-click a note and choose Create topic.");
  });
});

class FakePanelEl {
  children: FakePanelEl[] = [];
  text = "";
  cls = "";
  listeners = new Map<string, (event?: MouseEvent | KeyboardEvent) => void>();
  constructor(text = "", cls = "") { this.text = text; this.cls = cls; }
  createDiv(options: { cls?: string; text?: string } = {}) { return this.add(new FakePanelEl(options.text || "", options.cls || "")); }
  createEl(_tag: string, options: { cls?: string; text?: string } = {}) { return this.add(new FakePanelEl(options.text || "", options.cls || "")); }
  createSpan(options: { cls?: string; text?: string } = {}) { return this.add(new FakePanelEl(options.text || "", options.cls || "")); }
  add(child: FakePanelEl) { this.children.push(child); return child; }
  addEventListener(name: string, fn: (event?: MouseEvent | KeyboardEvent) => void) { this.listeners.set(name, fn); }
  setText(text: string) { this.text = text; }
  addClass(cls: string) { this.cls += ` ${cls}`; }
  remove() { this.text = ""; }
}
