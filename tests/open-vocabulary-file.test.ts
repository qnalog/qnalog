import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class TFile { constructor(public path: string) {} },
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, ""),
}));

import * as obsidian from "obsidian";
import { openVocabularyFile } from "../src/vocabulary/open-vocabulary-file";

class TFile extends obsidian.TFile {
  constructor(path: string) { super(path); }
}

function createHarness(path: string, initial?: string) {
  const files = new Map<string, TFile>();
  if (initial !== undefined) files.set(path, new TFile(path));
  const folders: string[] = [];
  let content = initial || "";
  const file = new TFile(path);
  const leaves: Array<{ view: { file: { path: string } | null } }> = [];
  const openLeaf = { openFile: vi.fn(async (_openedFile: TFile) => undefined), view: { file: null as { path: string } | null } };
  openLeaf.openFile = vi.fn(async (openedFile: TFile) => { openLeaf.view.file = openedFile; leaves.push(openLeaf); });
  const openFile = openLeaf.openFile;
  const revealLeaf = vi.fn(async () => undefined);
  const setActiveLeaf = vi.fn();
  const notify = vi.fn();
  const vault = {
    getAbstractFileByPath: vi.fn((target: string) => files.get(target) || null),
    createFolder: vi.fn(async (folder: string) => { folders.push(folder); }),
    create: vi.fn(async (target: string) => { files.set(target, file); return file; }),
    cachedRead: vi.fn(async () => content),
    modify: vi.fn(async (_target: TFile, next: string) => { content = next; }),
  };
  const options = {
    vault,
    workspace: {
      getLeaf: vi.fn(() => openLeaf),
      getLeavesOfType: vi.fn(() => leaves),
      revealLeaf,
      setActiveLeaf,
    },
    getSettings: () => ({ vocabularyFile: path, industryProfile: { industry: "教育" } }),
    notify,
  };
  return { options, files, folders, file, openFile, openLeaf, leaves, revealLeaf, setActiveLeaf, notify, vault, getContent: () => content };
}

afterEach(() => vi.unstubAllGlobals());

describe("openVocabularyFile", () => {
  it("creates a missing file and its parent folders, then opens it", async () => {
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-10-13 12:00:00" }) });
    const h = createHarness("Glossary/Terms.md");
    await openVocabularyFile(h.options);
    expect(h.folders).toEqual(["Glossary"]);
    expect(h.vault.create).toHaveBeenCalledWith("Glossary/Terms.md", expect.stringContaining("## 易错写法"));
    expect(h.openFile).toHaveBeenCalledWith(h.file);
    expect(h.options.workspace.getLeaf).toHaveBeenCalledWith(false);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Glossary/Terms.md"));
  });

  it("opens a structured file without modifying it", async () => {
    const source = "# Terms\n\n## 易错写法\n- typo => term\n";
    const h = createHarness("Terms.md", source);
    await openVocabularyFile(h.options);
    expect(h.vault.modify).not.toHaveBeenCalled();
    expect(h.openFile).toHaveBeenCalledWith(h.file);
    expect(h.getContent()).toBe(source);
  });

  it("focuses an existing Markdown leaf that already displays the glossary", async () => {
    const h = createHarness("Terms.md", "# Terms\n\n## 易错写法\n- typo => term\n");
    const existingLeaf = { view: { file: h.file } };
    h.leaves.push(existingLeaf);
    await openVocabularyFile(h.options);
    expect(h.openFile).not.toHaveBeenCalled();
    expect(h.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(h.setActiveLeaf).toHaveBeenCalledWith(existingLeaf, { focus: true });
  });

  it("keeps one glossary leaf after three consecutive clicks", async () => {
    const h = createHarness("Terms.md", "# Terms\n\n## 易错写法\n- typo => term\n");
    await openVocabularyFile(h.options);
    await openVocabularyFile(h.options);
    await openVocabularyFile(h.options);
    expect(h.openFile).toHaveBeenCalledTimes(1);
    expect(h.openFile).toHaveBeenCalledWith(h.file);
    expect(h.leaves).toHaveLength(1);
    expect(h.options.workspace.getLeaf).toHaveBeenCalledTimes(1);
  });

  it("organizes an unstructured file before opening it", async () => {
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-10-13 12:00:00" }) });
    const h = createHarness("Terms.md", "## 业务词\n- QnALog\n");
    await openVocabularyFile(h.options);
    expect(h.vault.modify).toHaveBeenCalledOnce();
    expect(h.getContent()).toContain("## 行业术语");
    expect(h.openFile).toHaveBeenCalledWith(h.file);
    expect(h.notify).toHaveBeenCalledWith("Organized into a sectioned hotword table");
  });

  it("notifies for an empty path without creating a file", async () => {
    const h = createHarness("");
    await openVocabularyFile(h.options);
    expect(h.vault.create).not.toHaveBeenCalled();
    expect(h.openFile).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith("Please fill in the file path first");
  });

  it("reports a file creation error instead of marking the path invalid", async () => {
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-10-13 12:00:00" }) });
    const h = createHarness("Terms.md");
    h.vault.create.mockRejectedValueOnce(new Error("disk is read-only"));
    await openVocabularyFile(h.options);
    expect(h.notify).toHaveBeenCalledWith("Open transcription glossary failed: disk is read-only");
    expect(h.notify).not.toHaveBeenCalledWith("Invalid transcription glossary path");
  });
});
