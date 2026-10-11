import { describe, expect, it } from "vitest";
import { syncActiveRow } from "../src/ui/row-active";

class FakeRow {
  classes = new Set<string>();
  attrs = new Map<string, string>();
  constructor(readonly path: string) { this.attrs.set("data-path", path); }
  get classList() {
    return {
      toggle: (name: string, force: boolean) => { if (force) this.classes.add(name); else this.classes.delete(name); },
    };
  }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  get active() { return this.classes.has("is-active"); }
}

function fakeList(paths: string[]) {
  const rows = paths.map((path) => new FakeRow(path));
  const root = { querySelectorAll: () => ({ forEach: (fn: (row: FakeRow) => void) => rows.forEach(fn) }) } as unknown as ParentNode;
  return { rows, root };
}

describe("active row sync", () => {
  it("highlights exactly the row whose path is open", () => {
    const { rows, root } = fakeList(["a.md", "b.md", "c.md"]);
    syncActiveRow(root, ["b.md"]);
    expect(rows.map((row) => row.active)).toEqual([false, true, false]);
    expect(rows[1].getAttribute("aria-current")).toBe("true");
  });

  it("moves the highlight when another row is opened and clears the previous one", () => {
    const { rows, root } = fakeList(["a.md", "b.md", "c.md"]);
    syncActiveRow(root, ["a.md"]);
    syncActiveRow(root, ["c.md"]);
    expect(rows.map((row) => row.active)).toEqual([false, false, true]);
    expect(rows[0].getAttribute("aria-current")).toBeNull();
  });

  it("clears every highlight when the open file matches no row", () => {
    const { rows, root } = fakeList(["a.md", "b.md"]);
    syncActiveRow(root, ["a.md"]);
    syncActiveRow(root, ["QnALog/other.md"]);
    expect(rows.map((row) => row.active)).toEqual([false, false]);
  });

  it("accepts two open paths, such as a topic page and a minutes source, and ignores empty paths", () => {
    const { rows, root } = fakeList(["a.md", "b.md"]);
    syncActiveRow(root, ["a.md", "b.md"]);
    expect(rows.map((row) => row.active)).toEqual([true, true]);
    syncActiveRow(root, ["", ""]);
    expect(rows.map((row) => row.active)).toEqual([false, false]);
  });
});
