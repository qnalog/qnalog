import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  parseYaml: () => ({}),
  Notice: class Notice {},
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import { setTaskLineChecked, toggleTodo, type TodoTogglePort } from "../src/tasks/todo-toggle";
import { collectNoteTodos, type TodoEntry } from "../src/tasks/todo-summary";
import { replaceActiveVersionBlock } from "../src/versions/active-version-block";
import { sanitizeActiveVersionBody } from "../src/versions/version-content";

const PATH = "QnALog/Notes/Pilot.md";

function memoryPort(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const port: TodoTogglePort = {
    read: async (path) => files.get(path) ?? null,
    process: async (path, update) => {
      const current = files.get(path);
      if (current === undefined) return false;
      const next = update(current);
      if (next !== current) { files.set(path, next); writes.push(path); }
      return true;
    },
  };
  return { port, files, writes };
}

function entriesOf(text: string): TodoEntry[] {
  return collectNoteTodos({ path: PATH, title: "Pilot", noteTime: 0, noteDate: "", frontmatter: {}, listItems: null, text });
}

const NOTE = [
  "# Pilot",
  "",
  "- [ ] Prepare the checklist",
  "* [x] Send the invite",
  "  12. [ ] Book the room",
  "> - [X] Call the vendor",
  "- [-] Cancelled item",
  "",
].join("\n");

describe("toggling one to-do", () => {
  it("ticks and unticks in both directions and changes only the bracket character", async () => {
    const { port, files } = memoryPort({ [PATH]: NOTE });
    const [prepare, invite, room, vendor] = entriesOf(NOTE);
    expect(await toggleTodo(port, prepare, true)).toEqual({ status: "ok", rawLine: "- [x] Prepare the checklist" });
    expect(await toggleTodo(port, invite, false)).toEqual({ status: "ok", rawLine: "* [ ] Send the invite" });
    expect(await toggleTodo(port, room, true)).toEqual({ status: "ok", rawLine: "  12. [x] Book the room" });
    expect(await toggleTodo(port, vendor, false)).toEqual({ status: "ok", rawLine: "> - [ ] Call the vendor" });
    const after = files.get(PATH)!;
    expect(after.length).toBe(NOTE.length);
    const changed = [...after].map((char, index) => (char === NOTE[index] ? -1 : index)).filter((index) => index >= 0);
    expect(changed).toHaveLength(4);
    expect(changed.every((index) => NOTE[index - 1] === "[" && NOTE[index + 1] === "]")).toBe(true);
  });

  it("keeps Windows line endings", async () => {
    const crlf = NOTE.replace(/\n/g, "\r\n");
    const { port, files } = memoryPort({ [PATH]: crlf });
    const [prepare] = entriesOf(crlf);
    expect(prepare.rawLine).toBe("- [ ] Prepare the checklist");
    expect((await toggleTodo(port, prepare, true)).status).toBe("ok");
    expect(files.get(PATH)).toBe(crlf.replace("- [ ] Prepare", "- [x] Prepare"));
  });

  it("does not write when the line text changed", async () => {
    const { port, files, writes } = memoryPort({ [PATH]: NOTE });
    const [prepare] = entriesOf(NOTE);
    files.set(PATH, NOTE.replace("Prepare the checklist", "Prepare the final checklist"));
    expect(await toggleTodo(port, prepare, true)).toEqual({ status: "conflict", reason: "changed" });
    expect(writes).toEqual([]);
  });

  it("does not write when the to-do moved to another line", async () => {
    const { port, files, writes } = memoryPort({ [PATH]: NOTE });
    const [prepare] = entriesOf(NOTE);
    files.set(PATH, `New first line\n${NOTE}`);
    expect(await toggleTodo(port, prepare, true)).toEqual({ status: "conflict", reason: "changed" });
    expect(await toggleTodo(port, { ...prepare, line: 400 }, true)).toEqual({ status: "conflict", reason: "changed" });
    expect(writes).toEqual([]);
  });

  it("does not write when the note is missing", async () => {
    const { port, writes } = memoryPort({});
    const [prepare] = entriesOf(NOTE);
    expect(await toggleTodo(port, prepare, true)).toEqual({ status: "conflict", reason: "missing" });
    expect(writes).toEqual([]);
  });

  it("re-checks inside the atomic write and leaves the note unchanged when it changed in between", async () => {
    const { port, files, writes } = memoryPort({ [PATH]: NOTE });
    const [prepare] = entriesOf(NOTE);
    const racing: TodoTogglePort = {
      read: port.read,
      process: async (path, update) => {
        files.set(path, NOTE.replace("- [ ] Prepare the checklist", "- [ ] Prepare the checklist today"));
        return port.process(path, update);
      },
    };
    expect(await toggleTodo(racing, prepare, true)).toEqual({ status: "conflict", reason: "changed" });
    expect(writes).toEqual([]);
  });

  it("leaves custom status marks and already-matching states alone", async () => {
    const { port, writes } = memoryPort({ [PATH]: NOTE });
    const entries = entriesOf(NOTE);
    const cancelled = entries.find((entry) => entry.mark === "-")!;
    expect(await toggleTodo(port, cancelled, false)).toEqual({ status: "conflict", reason: "unsupported" });
    expect(await toggleTodo(port, entries[0], false)).toEqual({ status: "unchanged" });
    expect(writes).toEqual([]);
  });

  it("sets the mark of a task line", () => {
    expect(setTaskLineChecked("> 1) [ ] Item", true)).toBe("> 1) [x] Item");
    expect(setTaskLineChecked("- [X] Item", false)).toBe("- [ ] Item");
    expect(setTaskLineChecked("Plain text", true)).toBeNull();
  });
});

describe("to-dos inside an active-version block", () => {
  const storedBody = "- [ ] Task in the version body\n\nOrganized text.";
  const mother = replaceActiveVersionBlock(`---\nqnalog_mode: meeting\n---\n# Pilot\n\nBody\n`, { label: "Clean copy" }, storedBody);

  it("a version switch rewrites the block from the stored snapshot, so a tick written there would be lost", () => {
    // VersionActivationStore.applyToSource writes the mother note through replaceActiveVersionBlock with the
    // body stored in .versions; the stored body is never updated from the mother note.
    const ticked = mother.replace("- [ ] Task in the version body", "- [x] Task in the version body");
    const switchedBack = replaceActiveVersionBlock(ticked, { label: "Clean copy" }, sanitizeActiveVersionBody(storedBody));
    expect(switchedBack).toContain("- [ ] Task in the version body");
    expect(switchedBack).not.toContain("- [x] Task in the version body");
  });

  it("refuses to toggle there and writes nothing", async () => {
    const { port, writes, files } = memoryPort({ [PATH]: mother });
    const inside = entriesOf(mother).find((entry) => entry.text === "Task in the version body")!;
    expect(inside.inActiveVersion).toBe(true);
    expect(await toggleTodo(port, inside, true)).toEqual({ status: "conflict", reason: "active-version" });
    expect(writes).toEqual([]);
    expect(files.get(PATH)).toBe(mother);
  });

  it("still toggles lines outside the block in the same note", async () => {
    const withOutside = mother.replace("# Pilot\n", "# Pilot\n\n- [ ] Task before the block\n");
    const { port } = memoryPort({ [PATH]: withOutside });
    const outside = entriesOf(withOutside).find((entry) => entry.text === "Task before the block")!;
    expect(outside.inActiveVersion).toBe(false);
    expect((await toggleTodo(port, outside, true)).status).toBe("ok");
  });
});
