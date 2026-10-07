import { describe, expect, it, vi } from "vitest";

const notices: string[] = [];
vi.mock("obsidian", () => ({
  TFile: class TFile {
    path: string;
    name: string;
    basename: string;
    extension: string;
    constructor(path: string) {
      this.path = path;
      this.name = path.split("/").pop() || path;
      this.basename = this.name.replace(/\.[^.]+$/, "");
      this.extension = this.name.split(".").pop() || "";
    }
  },
  Notice: class Notice { constructor(message: string) { notices.push(String(message)); } },
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
}));
import * as obsidian from "obsidian";
import { NoteWriter } from "../src/notes/note-writer";
import type { NoteWriterHost, NoteWriterSettings, NoteWriterVault } from "../src/notes/note-writer";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import { readTranscriptBlocks, serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
import { splitLeadingFrontmatter } from "../src/notes/note-document";
import type { RecordingSession, Segment } from "../src/shared/types";

type File = InstanceType<typeof obsidian.TFile>;

function memoryVault(initial: Array<{ file: File; markdown: string }> = []) {
  const files = new Map(initial.map((entry) => [entry.file.path, entry]));
  const adapterFiles = new Map<string, string>();
  const folders = new Set<string>();
  const vault = {
    configDir: ".obsidian",
    adapter: {
      exists: async (path: string) => folders.has(path) || adapterFiles.has(path),
      mkdir: async (path: string) => { folders.add(path); },
      write: async (path: string, value: string) => { adapterFiles.set(path, value); },
      read: async (path: string) => {
        const value = adapterFiles.get(path);
        if (value === undefined) throw new Error(`Missing adapter file ${path}`);
        return value;
      },
    },
    getAbstractFileByPath: (path: string) => files.get(path)?.file ?? null,
    read: async (file: File) => {
      const entry = files.get(file.path);
      if (!entry) throw new Error(`Missing note ${file.path}`);
      return entry.markdown;
    },
    modify: async (file: File, markdown: string) => {
      const entry = files.get(file.path);
      if (!entry) throw new Error(`Missing note ${file.path}`);
      entry.markdown = markdown;
    },
    create: async (path: string, markdown: string) => {
      const file = new obsidian.TFile(path);
      files.set(path, { file, markdown });
      return file;
    },
    process: async (file: File, transform: (markdown: string) => string) => {
      const current = await vault.read(file);
      const next = transform(current);
      await vault.modify(file, next);
      return next;
    },
  };
  return {
    vault: vault as unknown as NoteWriterVault,
    files,
    adapterFiles,
  };
}

function unexpectedHost(vault: NoteWriterVault, settings: NoteWriterSettings, overrides: Partial<NoteWriterHost> = {}): NoteWriterHost {
  return {
    vault,
    settings,
    noteIndex: { refreshNoteIndexSafely: async () => { throw new Error("unexpected index refresh"); } },
    getFileFrontmatter: () => undefined,
    ensureFolder: async () => { throw new Error("unexpected folder creation"); },
    findAvailableMarkdownPath: () => { throw new Error("unexpected path allocation"); },
    renameFile: async () => { throw new Error("unexpected rename"); },
    openFile: async () => { throw new Error("unexpected file open"); },
    confirm: async () => { throw new Error("unexpected confirmation"); },
    getRecentNotes: () => { throw new Error("unexpected recent-note lookup"); },
    generateTitleTag: async () => { throw new Error("unexpected title generation"); },
    polishTranscript: async () => { throw new Error("unexpected transcript polish"); },
    mergeAndPolish: async () => { throw new Error("unexpected note merge"); },
    clearCommittedBriefingCheckpoint: async () => { throw new Error("unexpected checkpoint cleanup"); },
    ...overrides,
  };
}


describe("NoteWriter narrow host capabilities", () => {
  it("preserves the transcript ledger and frontmatter ordering across rewrite and append", async () => {
    const path = "QnALog/Minutes/content.md";
    const file = new obsidian.TFile(path);
    const sourceText = "Q&A：第一行\n第二行 $& `$` $$ literal $' ending";
    const segment: Segment = attachTextTranscript({
      index: 0,
      startOffsetMs: 0,
      endOffsetMs: 12_000,
      text: sourceText,
      isFinal: true,
    }, "content-session", "text-import");
    const ledger = serializeTranscriptBlock(segment, "### Source transcript", sourceText);
    const oldMarker = "<!-- qnalog-continuation-committed:prior-session -->";
    const original = [
      "---",
      "title: old",
      "---",
      "",
      "# Existing note",
      ledger,
      oldMarker,
      oldMarker,
    ].join("\n");
    const vault = memoryVault([{ file, markdown: original }]);
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-10-07 12:00" }) });
    try {
      const writer = new NoteWriter(unexpectedHost(vault.vault, {
        ...DEFAULT_SETTINGS,
        llmModel: "consumer-test-model",
      }));
      const session: RecordingSession = {
        id: "content-session",
        sessionStamp: "content-session",
        startedAt: "2026-10-07T12:00:00.000Z",
        mdPath: path,
        mode: "meeting",
        segments: [segment],
        finalized: true,
      };

      await writer.rewriteConsolidated(session, "---\ntitle: polished\n---\n\nRewrite body", "new-session");
      const rewritten = (await vault.vault.read(file));
      expect(splitLeadingFrontmatter(rewritten).frontmatter).toContain("title: polished");
      expect(rewritten.indexOf("Rewrite body")).toBeLessThan(rewritten.indexOf("## Original material"));
      expect(readTranscriptBlocks(rewritten).map(block => block.visibleBlock)).toEqual([sourceText]);
      expect(rewritten.match(/<!-- qnalog-continuation-committed:prior-session -->/g)).toHaveLength(1);
      expect(rewritten.match(/<!-- qnalog-continuation-committed:new-session -->/g)).toHaveLength(1);

      const appendOriginal = [
        "---",
        "title: old",
        "---",
        "",
        "# Existing note",
        ledger,
      ].join("\n");
      await vault.vault.modify(file, appendOriginal);
      await writer.appendPolishBlock(session, "---\ntitle: appended\n---\n\nAppend body", null, false, "append-session", appendOriginal);
      const appended = await vault.vault.read(file);
      expect(splitLeadingFrontmatter(appended).frontmatter).toContain("title: appended");
      expect(appended.indexOf("# Existing note")).toBeLessThan(appended.indexOf("Append body"));
      expect(readTranscriptBlocks(appended).map(block => block.visibleBlock)).toEqual([sourceText]);
      expect(appended.endsWith("<!-- qnalog-continuation-committed:append-session -->\n")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("uses the current vault, settings, and frontmatter provider after construction", async () => {
    const file = new obsidian.TFile("QnALog/Minutes/current.md");
    const oldVault = memoryVault([{ file, markdown: "old vault bytes" }]);
    const activeVault = memoryVault([{ file, markdown: "new vault bytes" }]);
    let vault: NoteWriterVault = oldVault.vault;
    let settings: NoteWriterSettings = { ...DEFAULT_SETTINGS, polishMode: "meeting" };
    let frontmatter: obsidian.CachedMetadata["frontmatter"] = { qnalog_mode: "monologue" };
    const host = unexpectedHost(oldVault.vault, settings, {
      get getFileFrontmatter() { return () => frontmatter; },
    });
    Object.defineProperty(host, "vault", { get: () => vault });
    Object.defineProperty(host, "settings", { get: () => settings });
    const writer = new NoteWriter(host);

    vault = activeVault.vault;
    settings = {
      ...settings,
      polishMode: "seminar",
      llmModel: "active model",
      promptTemplates: {
        ...settings.promptTemplates,
        "custom-writer": {
          id: "custom-writer",
          mode: "custom-writer",
          customMode: true,
          name: "Writer template",
          prompt: "Custom prompt body",
        },
      },
    };
    frontmatter = { qnalog_mode: "meeting" };
    await writer.appendToNote(file.path, "new write");
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 11:00:00" }) });
    try {
      await writer.appendPolishBlock({
        id: "writer-session",
        mdPath: file.path,
        mode: "custom-writer",
        startedAt: "2026-09-14T11:00:00.000Z",
        segments: [],
        source: "text-import",
      } as never, "organized user-visible body", null);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(activeVault.files.get(file.path)?.markdown).toContain("active model · Custom prompt:Writer template");
    expect(activeVault.files.get(file.path)?.markdown).toContain("organized user-visible body");
  });

  it("continues a delayed title callback with the current rename capability and storage", async () => {
    const file = new obsidian.TFile("QnALog/Minutes/original.md");
    const oldVault = memoryVault([{ file, markdown: "old title source" }]);
    const newVault = memoryVault([{ file, markdown: "current title source" }]);
    let activeVault = oldVault;
    let settings: NoteWriterSettings = { ...DEFAULT_SETTINGS, autoRenameWithTitle: true };
    let renameCalls = 0;
    const gate = Promise.withResolvers<string>();
    const host = unexpectedHost(oldVault.vault, settings, {
      get vault() { return activeVault.vault; },
      get settings() { return settings; },
      generateTitleTag: async () => gate.promise,
      findAvailableMarkdownPath: (target) => target,
      renameFile: async (targetFile, path) => {
        renameCalls += 1;
        const entry = activeVault.files.get(targetFile.path);
        activeVault.files.delete(targetFile.path);
        targetFile.path = path;
        targetFile.name = path.split("/").pop() || path;
        targetFile.basename = targetFile.name.replace(/\.[^.]+$/, "");
        activeVault.files.set(path, { file: targetFile, markdown: entry.markdown });
      },
    });
    const writer = new NoteWriter(host);
    const rename = writer.renameMarkdownWithGeneratedTitle(file, "polished body", "meeting");

    activeVault = newVault;
    settings = { ...settings, autoRenameWithTitle: false };
    gate.resolve("topic");
    const renamed = await rename;

    expect(renameCalls).toBe(1);
    expect(renamed).toBe(file);
    expect(file.path).toContain("topic");
    expect(newVault.files.get(file.path)?.markdown).toBe("current title source");
    expect(oldVault.files.get("QnALog/Minutes/original.md")?.markdown).toBe("old title source");
  });

  it("polishes only the selected editor range and reports a rejected request without changing text", async () => {
    const vault = memoryVault();
    const settings: NoteWriterSettings = { ...DEFAULT_SETTINGS, polishMode: "meeting" };
    const host = unexpectedHost(vault.vault, settings, {
      polishTranscript: async (raw) => {
        if (raw === "reject me") throw new Error("service unavailable");
        return `organized ${raw}`;
      },
    });
    const writer = new NoteWriter(host);
    let replacement = "";
    const editor = {
      getSelection: () => "selected text",
      getValue: () => "whole document",
      replaceSelection: (value: string) => { replacement = value; },
      setValue: () => { throw new Error("unexpected full-document replacement"); },
    };
    await writer.polishEditor(editor as never);
    expect(replacement).toBe("organized selected text");
    let fullText = "";
    const emptySelectionEditor = {
      getSelection: () => "",
      getValue: () => "standalone transcript",
      replaceSelection: () => { throw new Error("empty selection must use full-document replacement"); },
      setValue: (value: string) => { fullText = value; },
    };
    await writer.polishEditor(emptySelectionEditor as never);
    expect(fullText).toBe("organized standalone transcript");


    const before = notices.length;
    const rejectedEditor = {
      getSelection: () => "reject me",
      getValue: () => "whole document",
      replaceSelection: () => { throw new Error("rejected result must not be written"); },
      setValue: () => { throw new Error("rejected result must not be written"); },
    };
    await writer.polishEditor(rejectedEditor as never);
    expect(notices.slice(before)).toContain("Polish failed: service unavailable");
  });
  it("leaves both sources untouched when confirmation is canceled or merging fails", async () => {
    const oldFile = new obsidian.TFile("QnALog/Minutes/older.txt");
    const currentFile = new obsidian.TFile("QnALog/Minutes/current.md");
    const oldText = "older source";
    const currentText = "current source";
    const vault = memoryVault([
      { file: oldFile, markdown: oldText },
      { file: currentFile, markdown: currentText },
    ]);
    let accepted = false;
    const host = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS }, {
      getRecentNotes: () => [
        { file: currentFile, timestamp: 2 },
        { file: oldFile, timestamp: 1 },
      ],
      confirm: async () => accepted,
    });
    const writer = new NoteWriter(host);

    await writer.mergeMarkdownFileWithPrevious(currentFile);
    expect(vault.files.size).toBe(2);
    expect(await vault.vault.read(oldFile)).toBe(oldText);
    expect(await vault.vault.read(currentFile)).toBe(currentText);

    accepted = true;
    const beforeFailure = notices.length;
    await writer.mergeMarkdownFileWithPrevious(currentFile);
    expect(vault.files.size).toBe(2);
    expect(await vault.vault.read(oldFile)).toBe(oldText);
    expect(await vault.vault.read(currentFile)).toBe(currentText);
    expect(notices.slice(beforeFailure).some((notice) => notice.includes("Merging minutes failed:"))).toBe(true);
  });
  it("returns the original note when title generation or rename fails", async () => {
    const file = new obsidian.TFile("QnALog/Minutes/unchanged.md");
    const vault = memoryVault([{ file, markdown: "original body" }]);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const titleFailure = new NoteWriter(unexpectedHost(vault.vault, {
        ...DEFAULT_SETTINGS,
        autoRenameWithTitle: true,
      }, {
        generateTitleTag: async () => { throw new Error("title unavailable"); },
      }));
      expect(await titleFailure.renameMarkdownWithGeneratedTitle(file, "body", "meeting")).toBe(file);

      const renameFailure = new NoteWriter(unexpectedHost(vault.vault, {
        ...DEFAULT_SETTINGS,
        autoRenameWithTitle: true,
      }, {
        generateTitleTag: async () => "topic",
        findAvailableMarkdownPath: (target) => target,
        renameFile: async () => { throw new Error("rename unavailable"); },
      }));
      expect(await renameFailure.renameMarkdownWithGeneratedTitle(file, "body", "meeting")).toBe(file);
      expect(file.path).toBe("QnALog/Minutes/unchanged.md");
      expect(await vault.vault.read(file)).toBe("original body");
    } finally {
      error.mockRestore();
    }
  });
});
