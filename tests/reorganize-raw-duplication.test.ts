import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// 回归：真实测试中「原地重新整理」每次都把原始材料复制一份（2026-10-24，S1 合成会议）。
// 夹具是该笔记各时刻的整篇快照（合成内容）：13:39 重新整理前、13:43 重新整理前，以及重复后的母本。

const { notices } = vi.hoisted(() => ({ notices: [] as string[] }));

vi.mock("obsidian", () => {
  class TFile {
    path: string;
    name: string;
    basename: string;
    extension: string;
    parent: { path: string };
    data: string;
    constructor(path: string, data = "") {
      this.path = path;
      this.name = path.split("/").pop() || path;
      this.basename = this.name.replace(/\.md$/i, "");
      this.extension = this.name.includes(".") ? this.name.split(".").pop() || "" : "";
      this.parent = { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" };
      this.data = data;
    }
  }
  return {
    TFile,
    TFolder: class TFolder {
      path: string;
      constructor(path = "") { this.path = path; }
    },
    Modal: class Modal { open(): void {} },
    Notice: class Notice { constructor(message: string) { notices.push(String(message)); } },
    normalizePath: (value: string) => String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, ""),
    stringifyYaml: (value: Record<string, unknown>) => Object.entries(value)
      .map(([key, item]) => `${key}: ${typeof item === "string" ? JSON.stringify(item) : String(item)}`)
      .join("\n"),
    parseYaml: (yaml: string) => {
      if (/:\s*\[$/m.test(yaml)) throw new Error("Invalid YAML");
      return Object.fromEntries(String(yaml || "").split(/\r?\n/)
      .filter((line) => line.includes(":"))
      .map((line) => {
        const separator = line.indexOf(":");
        const key = line.slice(0, separator).trim();
        const raw = line.slice(separator + 1).trim();
        let value: unknown = raw;
        if (raw === "true") value = true;
        else if (raw === "false") value = false;
        else if (/^".*"$/.test(raw)) {
          try { value = JSON.parse(raw); } catch { value = raw.slice(1, -1); }
        }
        return [key, value];
      }));
    },
  };
});

import * as obsidian from "obsidian";
import type { PluginSettings, Segment } from "../src/shared/types";
import { reorganizeNoteInPlace } from "../src/notes/reorganize-in-place-flow";
import { VersionStore, type VersionStoreHost } from "../src/versions/version-store";
import { splitVersionPayload } from "../src/versions/version-content";
import { getVersionStoreFolder, normalizeVersionId, buildSegmentStatusList } from "../src/versions/version-identity";
import { replaceActiveVersionBlock } from "../src/versions/active-version-block";
import { splitLeadingFrontmatter, findActiveVersionBlock } from "../src/notes/note-document";
import { foldNoteMachineData } from "../src/indexing/note-index";
import { getSourceIdFromMarkdown } from "../src/notes/note-source-metadata";
import { assertSingleRawMaterial } from "../src/notes/reorganize-in-place-flow";
import { repairDuplicatedRawMaterial } from "../src/notes/raw-duplication-repair";
import { extractTranscriptSegments } from "../src/notes/note-transcript-ledger";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

type MemoryFile = InstanceType<typeof obsidian.TFile>;
type MemoryFolder = InstanceType<typeof obsidian.TFolder>;
type VersionFixtureApp = {
  vault: VersionStoreHost["vault"];
  metadataCache: {
    getFileCache(file: MemoryFile): { frontmatter?: Record<string, unknown> } | null | undefined;
  };
  workspace?: { getLeaf(create: boolean): { openFile(file: MemoryFile): unknown } };
};

function makeVersionHost(
  app: VersionFixtureApp,
  getSettings: () => {
    mdFolder: string;
    promptTemplates?: Pick<PluginSettings, "promptTemplates">["promptTemplates"];
  },
  refreshIndex?: VersionStoreHost["refreshNoteIndexSafely"],
): VersionStoreHost {
  return {
    vault: {
      adapter: app.vault.adapter,
      getAbstractFileByPath: (path) => app.vault.getAbstractFileByPath(path),
      getMarkdownFiles: () => app.vault.getMarkdownFiles(),
      read: (file) => app.vault.read(file),
      create: (path, content) => app.vault.create(path, content),
      modify: async (file, content) => { await app.vault.modify(file, content); },
    },
    getSettings: () => {
      const current = getSettings();
      return { mdFolder: current.mdFolder, promptTemplates: current.promptTemplates || {} };
    },
    getFileFrontmatter: (file) => app.metadataCache.getFileCache(file)?.frontmatter,
    refreshNoteIndexSafely: refreshIndex || (async () => {
      throw new Error("Unexpected index refresh in version fixture");
    }),
    openSourceFile: async (file) => {
      if (!app.workspace) throw new Error("Unexpected source open in version fixture");
      await app.workspace.getLeaf(false).openFile(file);
    },
    getVersionStoreFolder, normalizeVersionId, buildSegmentStatusList, replaceActiveVersionBlock,
  };
}

function createMemoryVault() {
  const files = new Map<string, MemoryFile>();
  const unindexedFiles = new Set<string>();
  const folders = new Set<string>();
  const vault = {
    getAbstractFileByPath: (path: string): MemoryFile | MemoryFolder | null =>
      !unindexedFiles.has(path) ? files.get(path) || (folders.has(path) ? new obsidian.TFolder(path) : null) : null,
    getMarkdownFiles: () => [...files.values()].filter((file) => !unindexedFiles.has(file.path)),
    read: async (file: MemoryFile) => file.data,
    cachedRead: async (file: MemoryFile) => file.data,
    process: async (file: MemoryFile, transform: (content: string) => string) => { file.data = transform(file.data); },
    modify: async (file: MemoryFile, content: string): Promise<void> => { file.data = content; },
    createFolder: async (path: string) => { folders.add(path); return new obsidian.TFolder(path); },
    create: async (path: string, content: string) => {
      if (files.has(path)) throw new Error(`File already exists: ${path}`);
      const file = new obsidian.TFile(path, content);
      files.set(path, file);
      unindexedFiles.delete(path);
      return file;
    },
    adapter: {
      exists: async (path: string) => files.has(path) || folders.has(path),
      read: async (path: string) => {
        const file = files.get(path);
        if (!file) throw new Error(`File not found: ${path}`);
        return file.data;
      },
      write: async (path: string, content: string) => {
        const file = files.get(path);
        if (file) file.data = content;
        else files.set(path, new obsidian.TFile(path, content));
      },
      mkdir: async (path: string) => { folders.add(path); },
    },
  };
  return { files, unindexedFiles, vault };
}


function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/reorganize-dup/${name}`, import.meta.url), "utf8");
}
/** Version cache file → the mother note it was taken from. */
function motherFromCache(cache: string): string {
  const payload = splitVersionPayload(splitLeadingFrontmatter(cache).body);
  return `${payload.frontmatter.trimEnd()}\n\n${payload.body}`;
}
function count(text: string, re: RegExp): number { return (text.match(re) || []).length; }
const TRANSCRIPT_START = /qnalog-transcript-start:/g;
const HEADING = /^## (?:原始材料|Original material)\s*$/gm;

/** The organized body a reorganize returns: body, evidence block and knowledge comment, as in the real note. */
function generatedFrom(mother: string, marker: string): string {
  const active = findActiveVersionBlock(mother);
  if (!active) throw new Error("fixture has no active block");
  // A model returns only organized text: drop anything from the first raw block on.
  const rawAt = active.body.search(/<details\b|<span\s+hidden\b/i);
  const visible = rawAt < 0 ? active.body : active.body.slice(0, rawAt);
  const body = visible.replace(/^>[^\n]*\n/gm, "").replace(/^## 轮次：[^\n]*\n+/m, "").replace(/\n---\s*$/, "").trim();
  return `## 轮次：${marker}\n\n${body}`;
}

async function setup(motherText: string) {
  const { files, vault } = createMemoryVault();
  const path = "QnALog/转写纪要/2026-10-24 2102 · 导入 · 通用-版本发布-导出问题修复.md";
  // Seed the version store the way the note got it: the original snapshot holds the active body.
  const active = findActiveVersionBlock(motherText);
  const plain = active
    ? motherText.slice(0, active.start) + active.body.replace(/^>[^\n]*\n/gm, "") + motherText.slice(active.end)
    : motherText;
  const sourceFile = new obsidian.TFile(path, plain);
  files.set(path, sourceFile);
  const settings: Pick<PluginSettings, "mdFolder" | "promptTemplates"> = { mdFolder: "QnALog/转写纪要", promptTemplates: {} };
  const app = {
    vault,
    metadataCache: {
      getFileCache: (file: MemoryFile) => {
        const match = file.data.match(/^---\n([\s\S]*?)\n---/);
        return { frontmatter: match ? obsidian.parseYaml(match[1] || "") as Record<string, unknown> : {} };
      },
    },
    workspace: { getLeaf: () => ({ openFile: vi.fn(async () => undefined) }) },
  };
  const refresh = async (file: MemoryFile) => { file.data = foldNoteMachineData(file.data); };
  const versions = new VersionStore(makeVersionHost(app, () => settings, refresh as VersionStoreHost["refreshNoteIndexSafely"]));
  const originalPath = await versions.ensureOriginalVersionForSource(sourceFile);
  if (!originalPath) throw new Error("Original snapshot was not created");
  sourceFile.data = motherText;
  // The derived "工作纪要" version exists, as in the real note.
  await versions.saveVersion(sourceFile, motherText, [] as Segment[], { kind: "minutes", label: "工作纪要", mode: "meeting", body: "## 工作纪要\n\n派生正文。", activate: false });
  const sourceId = getSourceIdFromMarkdown(motherText, sourceFile);
  const folder = getVersionStoreFolder(settings, sourceId);
  const reorganize = async (marker: string) => {
    const inFlight = new Set<string>();
    const noop = vi.fn();
    const before = await vault.read(sourceFile);
    const ok = await reorganizeNoteInPlace({
      getVault: () => vault as unknown as Pick<obsidian.Vault, "read" | "process">,
      getCachedFrontmatter: (file) => app.metadataCache.getFileCache(file)?.frontmatter,
      loadErrata: async () => null,
      getDefaultMode: () => "general",
      detectNoteMode: () => "general",
      formatNoteFileName: () => null,
      getModeDisplayName: () => "通用",
      getInFlight: () => inFlight,
      mergeAndPolish: async () => generatedFrom(before, marker),
      saveReorganizeSnapshot: async (file, content, snapshotSegments, mode) => {
        await versions.saveVersion(file, content, snapshotSegments, { kind: "pre-reorganize", label: "整理前", mode, idLabel: `pre-reorganize-${marker}`, body: content, activate: false });
      },
      stripModeSuggestionBlocks: (text) => text,
      validateOriginalVersionForReorganization: (file) => versions.validateOriginalVersionForReorganization(file),
      replaceOriginalVersionBody: (file, payload) => versions.replaceOriginalVersionBody(file, payload),
      restoreOriginalVersionBody: (file, update) => versions.restoreOriginalVersionBody(file, update),
      switchVersion: (target, fallback) => versions.switchVersion(target, fallback),
      refreshNoteIndex: refresh as never,
      clearCommittedBriefingCheckpoint: async () => undefined,
      recoverOriginalTranscript: async () => false,
      getModeOptions: () => [],
      resolveLinkPath: () => null,
      getAutoRenameWithTitle: () => false,
      renameWithGeneratedTitle: async () => null,
      tasks: { startTaskActivity: noop, patchTaskActivity: noop, completeTaskActivity: noop, failTaskActivity: noop },
    }, sourceFile);
    return { ok, note: await vault.read(sourceFile), original: files.get(originalPath)?.data || "" };
  };
  return { reorganize, files, folder, originalPath, versions, sourceFile, vault };
}

vi.stubGlobal("window", { moment: undefined });
const previousLanguage = getActiveUiLanguage();
beforeAll(() => setActiveUiLanguage(resolveUiLanguage("zh", "zh")));
afterAll(() => setActiveUiLanguage(previousLanguage));

describe("reorganize in place keeps exactly one copy of the raw material", () => {
  for (const name of ["mother-before-1339.md", "mother-before-1343.md"]) {
    it(`stays at two transcript blocks over repeated reorganizes (${name})`, async () => {
      const mother = motherFromCache(fixture(name));
      expect(count(mother, TRANSCRIPT_START)).toBe(2);
      const { reorganize } = await setup(mother);
      for (const round of ["第一轮", "第二轮", "第三轮"]) {
        const result = await reorganize(round);
        expect(result.ok).toBe(true);
        expect(result.note).toContain(round);
        expect(count(result.note, TRANSCRIPT_START)).toBe(2);
        expect(count(result.note, HEADING)).toBe(1);
        // Raw material sits after the heading, so the organized part holds only the new body.
        expect(result.note.search(HEADING)).toBeLessThan(result.note.search(/qnalog-transcript-start:/));
        // The original snapshot is a body-only version (containsRaw:false).
        expect(splitVersionPayload(splitLeadingFrontmatter(result.original).body).body).not.toMatch(/<details|qnalog-transcript-start/);
      }
    });
  }

  it("refuses to write when the note already holds duplicated raw material and leaves it unchanged", async () => {
    const duplicated = fixture("mother-duplicated.md");
    expect(count(duplicated, TRANSCRIPT_START)).toBe(10);
    const { reorganize } = await setup(duplicated);
    const result = await reorganize("拒绝");
    expect(result.ok).toBe(false);
    expect(result.note).toBe(duplicated);
    expect(notices.at(-1)).toMatch(/重新整理会(?:复制原始材料|丢失原始转写分段)/);
  });
});

describe("write guard against duplicated raw material", () => {
  const healthy = motherFromCache(fixture("mother-before-1343.md"));
  const duplicated = fixture("mother-duplicated.md");
  const segments = extractTranscriptSegments(healthy).length;

  it("accepts a single copy and refuses duplicated blocks, a second heading, raw material in the body or more segments", () => {
    const repaired = repairDuplicatedRawMaterial(duplicated).markdown;
    expect(() => assertSingleRawMaterial(healthy, repaired, segments)).not.toThrow();
    expect(() => assertSingleRawMaterial(healthy, duplicated, segments)).toThrow(/复制原始材料/);
    expect(() => assertSingleRawMaterial(healthy, `${repaired}\n---\n\n## 原始材料\n`, segments)).toThrow(/复制原始材料/);
    const bodyWithRaw = repaired.replace("## 原始材料", "## 原始材料").replace(/(# [^\n]+\n)/, "$1\n<!-- qnalog-transcript-start:extra -->\n");
    expect(() => assertSingleRawMaterial(healthy, bodyWithRaw, segments)).toThrow(/复制原始材料/);
    expect(() => assertSingleRawMaterial(healthy, repaired, segments - 1 > 0 ? segments - 1 : 0)).not.toThrow();
  });

  it("never writes raw material into body-only versions", async () => {
    const { versions, sourceFile, vault } = await setup(healthy);
    await expect(versions.replaceOriginalVersionBody(sourceFile, "正文\n\n<details>\n<summary>原始转写 · 段落 1</summary>\n<!-- qnalog-transcript-start:x -->\n</details>"))
      .rejects.toThrow(/只含正文的版本不能带原始材料/);
    await expect(versions.saveVersion(sourceFile, await vault.read(sourceFile), [], { kind: "minutes", label: "纪要", body: "正文\n\n---\n\n## 原始材料\n" }))
      .rejects.toThrow(/只含正文的版本不能带原始材料/);
    // Whole-note snapshots keep the full note by design.
    await expect(versions.saveVersion(sourceFile, healthy, [], { kind: "pre-reorganize", label: "整理前", body: healthy, activate: false })).resolves.toBeTruthy();
  });
});

describe("recovery of a duplicated mother note (pure function, not run on any vault)", () => {
  it("rebuilds one body and one raw material from the real duplicated note", () => {
    const duplicated = fixture("mother-duplicated.md");
    const result = repairDuplicatedRawMaterial(duplicated);
    expect(result.maxCopiesBefore).toBe(5);
    expect(result.transcriptBlocks).toBe(2);
    const text = result.markdown;
    expect(count(text, TRANSCRIPT_START)).toBe(2);
    expect(count(text, HEADING)).toBe(1);
    expect(count(text, /data-qnalog-transcript-data=/g)).toBe(1);
    expect(count(text, /<summary>录音信息<\/summary>/g)).toBe(1);
    expect(count(text, /<summary>索引数据<\/summary>/g)).toBe(1);
    expect(text).toContain("第 1/2 部分");
    expect(text).toContain("第 2/2 部分");
    expect(text).not.toMatch(/第 \d+\/10 部分/);
    expect(count(text, /data-qnalog="active-version-start"/g)).toBe(1);
    expect(count(text, /evidence-links-start/g)).toBe(1);
    expect(count(text, /qnalog-session-knowledge /g)).toBe(1);
    expect(text.indexOf("active-version-end")).toBeLessThan(text.search(HEADING));
    expect(splitLeadingFrontmatter(text).frontmatter).toBe(splitLeadingFrontmatter(duplicated).frontmatter);
    // The ledger still reads back with the same segments, and repairing again changes nothing.
    expect(extractTranscriptSegments(text).length).toBe(extractTranscriptSegments(motherFromCache(fixture("mother-before-1343.md"))).length);
    expect(repairDuplicatedRawMaterial(text).markdown).toBe(text);
  });

  it("the 21:43 pre-reorganize snapshot is a single-copy restore point with the speaker names", () => {
    const restore = motherFromCache(fixture("mother-before-1343.md"));
    expect(repairDuplicatedRawMaterial(restore).maxCopiesBefore).toBe(1);
    expect(count(restore, TRANSCRIPT_START)).toBe(2);
    expect(count(restore, /data-qnalog-transcript-data=/g)).toBe(1);
    const active = findActiveVersionBlock(restore);
    expect(active && /<details|qnalog-transcript-start/.test(active.body)).toBe(false);
    expect(restore).toContain("personName: 周韵平");
  });

  it("leaves a repaired note stable over further reorganizes", async () => {
    const repaired = repairDuplicatedRawMaterial(fixture("mother-duplicated.md")).markdown;
    const { reorganize } = await setup(repaired);
    for (const round of ["修复后一", "修复后二"]) {
      const result = await reorganize(round);
      expect(result.ok).toBe(true);
      expect(count(result.note, TRANSCRIPT_START)).toBe(2);
      expect(count(result.note, HEADING)).toBe(1);
    }
  });
});
