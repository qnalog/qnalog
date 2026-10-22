import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class TFile {
    path: string;
    basename: string;
    constructor(path: string) {
      this.path = path;
      this.basename = path.split("/").pop()?.replace(/\.md$/, "") || "";
    }
  }
  return { TFile, Notice: class {}, normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/") };
});

import * as obsidian from "obsidian";
import { writeSedimentObjectCards } from "../src/sediment";

const TFile = obsidian.TFile as unknown as new (path: string) => { path: string; basename: string };

function makePlugin(dailyNotesEnabled: boolean) {
  const files = new Map<string, { file: object; content: string }>();
  const vault = {
    getAbstractFileByPath: (path: string) => files.get(path)?.file ?? null,
    create: vi.fn(async (path: string, content: string) => {
      const file = new TFile(path);
      files.set(path, { file, content });
      return file;
    }),
    createFolder: vi.fn(async () => undefined),
    read: vi.fn(async (file: { path: string }) => files.get(file.path)?.content ?? ""),
    modify: vi.fn(async (file: { path: string }, content: string) => {
      const entry = files.get(file.path);
      if (entry) entry.content = content;
    }),
  };
  const dailyNotes = { enabled: dailyNotesEnabled, options: { folder: "Daily", format: "YYYY-MM-DD" } };
  const app = { vault, internalPlugins: { getPluginById: (id: string) => (id === "daily-notes" ? dailyNotes : null) } };
  return { plugin: { app, settings: {} }, files, vault };
}

const todo = { task: "Send the draft", owner: "Pat", due: "", sourceTime: "00:10" };

describe("confirmed to-do write", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses with a reason and creates no file when Daily notes is off", async () => {
    const { plugin, vault } = makePlugin(false);
    await expect(writeSedimentObjectCards(plugin, new TFile("Notes/source.md"), { todos: [todo] }))
      .rejects.toThrow(/Daily notes/);
    expect(vault.create).not.toHaveBeenCalled();
    expect(vault.modify).not.toHaveBeenCalled();
  });

  it("adds the to-do as a task in today's daily note with a source link", async () => {
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-10-22" }) });
    const { plugin, files } = makePlugin(true);
    const result = await writeSedimentObjectCards(plugin, new TFile("Notes/source.md"), { todos: [todo] });
    expect(result.todos).toBe(1);
    expect(result.entries[0]).toMatchObject({ kind: "todo", target: "daily", path: "Daily/2026-10-22.md" });
    const daily = files.get("Daily/2026-10-22.md")?.content || "";
    expect(daily).toContain("- [ ] Send the draft");
    expect(daily).toContain("[[Notes/source");
    expect([...files.keys()]).toEqual(["Daily/2026-10-22.md"]);
  });

  it("writes nothing when there are no to-dos", async () => {
    const { plugin, vault } = makePlugin(false);
    await expect(writeSedimentObjectCards(plugin, new TFile("Notes/source.md"), { todos: [] })).resolves.toEqual({ todos: 0, entries: [] });
    expect(vault.create).not.toHaveBeenCalled();
  });
});
