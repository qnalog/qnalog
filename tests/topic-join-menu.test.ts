import { describe, expect, it, vi } from "vitest";
import { addTopicJoinSubmenu } from "../src/ui/topic-join-menu";
import { TopicSummarySnapshot, type TopicSummary } from "../src/ui/topics-ui-port";

interface FakeItem { title: string; submenu?: FakeMenu; click?: () => void; setTitle(value: string): FakeItem; setIcon(_value: string): FakeItem; onClick(callback: () => void): FakeItem; setSubmenu(): FakeMenu }
class FakeMenu {
  items: FakeItem[] = [];
  events: string[];
  constructor(events: string[]) { this.events = events; }
  addItem(build: (item: FakeItem) => void): this {
    this.events.push("addItem");
    const item: FakeItem = {
      title: "", setTitle(value) { this.title = value; return this; }, setIcon() { return this; },
      onClick(callback) { this.click = callback; return this; },
      setSubmenu: () => { item.submenu = new FakeMenu(this.events); return item.submenu; },
    };
    this.items.push(item);
    build(item);
    return this;
  }
  show(): void { this.events.push("show"); }
}
const topic = (id: string, updated: number, members: string[] = [], excluded: string[] = []): TopicSummary => ({ id, title: `Topic ${id}`, members, excluded, updated: new Date(updated).toISOString() });

describe("synchronous topic join menu", () => {
  it("adds every root and submenu item before the parent menu is shown", () => {
    const events: string[] = [];
    const menu = new FakeMenu(events);
    addTopicJoinSubmenu(menu as never, [topic("a", 1)], "note.md", { join: "Join topic…", more: "More…" }, vi.fn(), vi.fn());
    menu.show();
    expect(events.at(-1)).toBe("show");
    expect(events.slice(0, -1).every((entry) => entry === "addItem")).toBe(true);
    expect(menu.items[0].submenu?.items.map(({ title }) => title)).toEqual(["Topic a"]);
  });

  it("sorts recent topics, hides current members and exclusions, and appends More after eight", () => {
    const topics = [topic("member", 100, ["note.md"]), topic("excluded", 99, [], ["note.md"]), ...Array.from({ length: 10 }, (_, i) => topic(String(i), i))];
    const menu = new FakeMenu([]);
    addTopicJoinSubmenu(menu as never, topics, "note.md", { join: "Join", more: "More…" }, vi.fn(), vi.fn());
    const items = menu.items[0].submenu?.items || [];
    expect(items).toHaveLength(9);
    expect(items.slice(0, 8).map(({ title }) => title)).toEqual(["Topic 9", "Topic 8", "Topic 7", "Topic 6", "Topic 5", "Topic 4", "Topic 3", "Topic 2"]);
    expect(items.at(-1)?.title).toBe("More…");
  });

  it("shows a newly created topic after the refreshed list replaces the snapshot", () => {
    const snapshot = new TopicSummarySnapshot();
    const created = { id: "created", title: "Created topic", members: [], excluded: [], updated: "2026-10-11" };
    snapshot.replace([{ path: "Topics/Created.md", page: { ...created, memberLinks: [], tags: [], basis: "overview", created: "2026-10-11", body: "" } as never }]);
    const menu = new FakeMenu([]);
    addTopicJoinSubmenu(menu as never, snapshot.get(), "note.md", { join: "Join", more: "More…" }, vi.fn(), vi.fn());
    expect(menu.items[0].submenu?.items.map(({ title }) => title)).toEqual(["Created topic"]);
  });

  it("adds no menu item for an empty snapshot", () => {
    const menu = new FakeMenu([]);
    addTopicJoinSubmenu(menu as never, [], "note.md", { join: "Join", more: "More…" }, vi.fn(), vi.fn());
    expect(menu.items).toHaveLength(0);
  });
});
