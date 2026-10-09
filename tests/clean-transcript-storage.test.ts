import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { buildSegmentStatusList, getVersionStoreFolder, normalizeVersionId } from "../src/versions/version-identity";
import { replaceActiveVersionBlock } from "../src/versions/active-version-block";
import { ensureTranscriptBlocks } from "../src/notes/note-transcript-ledger";
import { getSourceIdFromMarkdown } from "../src/notes/note-source-metadata";
import { getSegmentsHash } from "../src/notes/audio-refs";

const { cleanTranscriptMock, mergeAndPolishMock, notices } = vi.hoisted(() => ({
  cleanTranscriptMock: vi.fn(),
  mergeAndPolishMock: vi.fn(),
  notices: [] as string[],
}));


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

vi.mock("../src/briefing/merge-pipeline", () => ({
  cleanTranscript: cleanTranscriptMock,
  mergeAndPolish: mergeAndPolishMock,
}));
import * as obsidian from "obsidian";
import type { PluginSettings, Segment } from "../src/shared/types";
import { cleanTranscript } from "../src/briefing/merge-pipeline";
import { RepolishService } from "../src/notes/repolish-service";
import { VersionStore, type VersionStoreHost } from "../src/versions/version-store";
import { TaskActivityService } from "../src/tasks/task-activity-service";
import { TaskActivityStore } from "../src/shared/task-activity";

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

const sourceContent = [
  "---",
  "qnalog_time: 2026-09-29T21:49:00",
  "qnalog_mode: meeting",
  "qnalog_custom: keep-me",
  "---",
  "",
  "# 2026-09-29 21:49 · 会议纪要",
  "",
  "First generated minutes must stay visible.",
  "",
  "## 原始材料",
  "",
  "<details>",
  "<summary>分段原始转写 (1)</summary>",
  "",
  "### Segment 1 (00:00–00:05)",
  "",
  "Original ASR transcript.",
  "",
  "</details>",
].join("\n");

function createActivationFixture() {
  const { files, vault } = createMemoryVault();
  const sourceFile = new obsidian.TFile("QnALog/notes/activation-source.md", sourceContent);
  files.set(sourceFile.path, sourceFile);
  const settings: Pick<PluginSettings, "mdFolder" | "promptTemplates"> = {
    mdFolder: "QnALog/notes",
    promptTemplates: {},
  };
  const openFile = vi.fn(async () => undefined);
  const app = {
    vault,
    metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
    workspace: { getLeaf: () => ({ openFile }) },
  };
  const refresh = vi.fn(async () => undefined);
  const versions = new VersionStore(makeVersionHost(app, () => settings, refresh));
  return { files, vault, sourceFile, settings, openFile, refresh, versions };
}



let languageBeforeTest = getActiveUiLanguage();

beforeEach(() => {
  cleanTranscriptMock.mockReset().mockResolvedValue({ text: "Readable cleaned transcript.", truncated: false });
  mergeAndPolishMock.mockReset();
  languageBeforeTest = getActiveUiLanguage();
  vi.stubGlobal("window", {});
  notices.length = 0;
});

afterEach(() => {
  setActiveUiLanguage(languageBeforeTest);
});

describe("clean transcript storage", () => {
  it("uses current mode templates and storage folder for original snapshots", async () => {
    const { files, vault } = createMemoryVault();
    const originalContent = sourceContent
      .replace("qnalog_time: 2026-09-29T21:49:00", "qnalog_time: 2026-10-04T00:00:00.000Z")
      .replace("qnalog_mode: meeting", "qnalog_mode: custom-note");
    const sourceFile = new obsidian.TFile("QnALog/notes/custom-source.md", originalContent);
    files.set(sourceFile.path, sourceFile);
    const template = (name: string) => ({
      id: "custom-note",
      mode: "custom-note",
      name,
      prompt: "Custom mode fixture.",
      customMode: true,
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
    });
    let settings: Pick<PluginSettings, "mdFolder" | "promptTemplates"> = {
      mdFolder: "QnALog/version-port-a",
      promptTemplates: { "custom-note": template("Name A") },
    };
    const app = {
      vault,
      metadataCache: { getFileCache: () => ({ frontmatter: { qnalog_mode: "custom-note" } }) },
    };
    const versions = new VersionStore(makeVersionHost(app, () => settings));
    const originalText = await vault.read(sourceFile);

    const firstPath = await versions.ensureOriginalVersionForSource(sourceFile);
    expect(firstPath).toBeTruthy();
    const first = await versions.findOriginalVersionForSource(sourceFile);
    expect(first?.mode).toBe("custom-note");
    expect(first?.label).toContain("Name A");
    const folderA = getVersionStoreFolder(settings, getSourceIdFromMarkdown(originalText, sourceFile));
    const manifestPathA = `${folderA}/manifest.json`;
    const snapshotA = files.get(firstPath!);
    if (!snapshotA) throw new Error("Original snapshot A was not written");
    const snapshotABytes = snapshotA.data;
    const manifestABytes = files.get(manifestPathA)?.data;
    if (!manifestABytes) throw new Error("Version manifest A was not written");

    settings = {
      ...settings,
      promptTemplates: { "custom-note": template("Name B") },
    };
    const sameSnapshot = await versions.findOriginalVersionForSource(sourceFile);
    expect(sameSnapshot?.path).toBe(firstPath);
    expect(sameSnapshot?.label).toContain("Name B");

    settings = { ...settings, mdFolder: "QnALog/version-port-b" };
    const secondPath = await versions.ensureOriginalVersionForSource(sourceFile);
    expect(secondPath).toContain("QnALog/version-port-b");
    const folderB = getVersionStoreFolder(settings, getSourceIdFromMarkdown(originalText, sourceFile));
    const manifestPathB = `${folderB}/manifest.json`;
    const manifestB = JSON.parse(files.get(manifestPathB)?.data || "{}");
    expect(manifestB.versions).toHaveLength(1);
    expect(manifestB.versions[0].kind).toBe("source-original");
    expect(snapshotA.data).toBe(snapshotABytes);
    expect(files.get(manifestPathA)?.data).toBe(manifestABytes);
    expect(await vault.read(sourceFile)).toBe(originalText);
    for (const snapshotPath of [firstPath!, secondPath!]) {
      const snapshot = files.get(snapshotPath);
      expect(snapshot?.data).toContain("First generated minutes must stay visible.");
      expect(snapshot?.data).not.toContain("Original ASR transcript.");
    }
  });
  it("recovers an unindexed manifest, preserves orphan snapshots, and switches back to the personal note", async () => {
    const { files, unindexedFiles, vault } = createMemoryVault();
    const originalContent = sourceContent.replace("qnalog_mode: meeting", "qnalog_mode: monologue")
      .replace("First generated minutes must stay visible.", "Private personal note body.");
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/personal-note.md", originalContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const sourceId = getSourceIdFromMarkdown(originalContent, sourceFile);
    const folder = getVersionStoreFolder(settings, sourceId);
    const manifestPath = `${folder}/manifest.json`;
    const oldManifest = {
      version: 1,
      sourceId,
      activeVersionId: "old-minutes",
      versions: [{ id: "old-minutes", fileName: "old-minutes.md", kind: "minutes", label: "Old minutes" }],
    };
    files.set(manifestPath, new obsidian.TFile(manifestPath, JSON.stringify(oldManifest)));
    unindexedFiles.add(manifestPath);
    for (const [fileName, timestamp] of [["orphan-one.md", "16:39:05"], ["orphan-two.md", "16:41:58"]]) {
      const path = `${folder}/${fileName}`;
      files.set(path, new obsidian.TFile(path,
        `---\nqnalog_type: QnALog派生版本\nversion_id: "orphan-${timestamp}"\nvariant_kind: "source-original"\nsource_id: "${sourceId}"\n---\n\nPreserved orphan ${timestamp}.`));
      unindexedFiles.add(path);
    }
    const openFile = vi.fn(async () => undefined);
    const app = {
      vault,
      metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
      workspace: { getLeaf: () => ({ openFile }) },
    };

    const noteIndex = { refreshNoteIndexSafely: vi.fn(async () => undefined) };
    const versions = new VersionStore(makeVersionHost(app, () => settings, noteIndex.refreshNoteIndexSafely));
    const tasks = {
      _busyLabel: null,
      _busyContext: null,
      startTaskActivity: vi.fn(),
      patchTaskActivity: vi.fn(),
      updateBusyStatus: vi.fn(),
      beginTaskMeter: vi.fn(() => ({ id: "meter" })),
      endTaskMeter: vi.fn(() => ({ elapsedMs: 1 })),
      logCompletedWork: vi.fn(),
      completeTaskActivity: vi.fn(),
      failTaskActivity: vi.fn(),
    };
    const service = new RepolishService({
      app, settings, tasks, versions, noteIndex, requestOutlineRefresh: vi.fn(),
    } as never);
    mergeAndPolishMock.mockResolvedValue("Generated minutes body.");

    await service.repolishMarkdownFile(sourceFile, "synthesis");

    const savedManifest = JSON.parse(await vault.adapter.read(manifestPath));
    expect(savedManifest.activeVersionId).toBe("old-minutes");
    expect(savedManifest.versions.map((record: { kind: string }) => record.kind)).toEqual([
      "minutes", "source-original", "minutes",
    ]);
    expect(files.get(`${folder}/orphan-one.md`)?.data).toContain("Preserved orphan 16:39:05.");
    expect(files.get(`${folder}/orphan-two.md`)?.data).toContain("Preserved orphan 16:41:58.");
    const snapshot = await versions.findOriginalVersionForSource(sourceFile);
    expect(snapshot).toBeDefined();
    expect(await vault.adapter.read(snapshot!.path)).toContain("Private personal note body.");
    const derivedRecord = savedManifest.versions.find((record: { id: string }) => record.id !== "old-minutes" && record.kind === "minutes");
    const derivedCache = files.get(`${folder}/${derivedRecord.fileName}`);
    expect(derivedCache).toBeDefined();
    expect([...files.values()].some((file) => file.path !== sourceFile.path
      && !file.path.includes("/.versions/") && file.data.includes("Generated minutes body."))).toBe(true);
    await versions.switchVersion(derivedCache!, sourceFile.path);
    expect(await vault.read(sourceFile)).toContain("Generated minutes body.");
    await versions.switchVersion(snapshot!.path, sourceFile.path);
    expect(await vault.read(sourceFile)).toContain("Private personal note body.");
    expect(await vault.read(sourceFile)).toContain("Original ASR transcript.");
    expect(openFile).toHaveBeenCalledWith(sourceFile);
  });


  it("stores the clean copy and switches the source note while preserving a returnable original version", async () => {
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/2026-09-29 2149 · 会议纪要.md", sourceContent);
    files.set(sourceFile.path, sourceFile);
    const cleanNoteIndex = { refreshNoteIndexSafely: vi.fn(async () => undefined) };
    let cleanFrontmatterOverride: Record<string, unknown> | null = {};
    const app = {
      vault,
      metadataCache: {
        getFileCache: (candidate: MemoryFile) => candidate.path === sourceFile.path
          ? { frontmatter: { qnalog_time: "2026-09-29T21:49:00", qnalog_mode: "meeting", qnalog_custom: "keep-me" } }
          : candidate.data.includes('variant_kind: "clean"')
            ? { frontmatter: cleanFrontmatterOverride || { variant_kind: "clean", source_id: getSourceIdFromMarkdown(sourceContent, sourceFile), qnalog_type: "QnALog派生版本", qnalog_source_path: sourceFile.path, qnalog_contains_raw: false } }
            : { frontmatter: {} },
      },
      workspace: { getLeaf: () => ({ openFile: vi.fn(async () => undefined) }) },
    };
    const settings = { mdFolder: "QnALog/转写纪要" };
    const versionFolder = getVersionStoreFolder(settings, getSourceIdFromMarkdown(sourceContent, sourceFile));
    const manifestPath = `${versionFolder}/manifest.json`;
    files.set(manifestPath, new obsidian.TFile(manifestPath, JSON.stringify({ version: 1, activeVersionId: "minutes:existing", versions: [] })));
    const versions = new VersionStore(makeVersionHost(app, () => settings, cleanNoteIndex.refreshNoteIndexSafely));
    const openFile = vi.fn(async () => undefined);
    const tasks = {
      startTaskActivity: vi.fn(),
      updateBusyStatus: vi.fn(),
      beginTaskMeter: vi.fn(() => ({ id: "meter" })),
      endTaskMeter: vi.fn(() => ({ elapsedMs: 1 })),
      logCompletedWork: vi.fn(),
      completeTaskActivity: vi.fn(),
    };
    app.workspace.getLeaf = () => ({ openFile });
    const service = new RepolishService({ app, settings, tasks, versions, noteIndex: cleanNoteIndex } as never);
    await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes",
      label: "综合纪要",
      mode: "meeting",
      idLabel: "saved-minutes",
      body: "First generated minutes must stay visible.",
      activate: false,
    });
    const manifestFile = files.get(manifestPath);
    if (!manifestFile) throw new Error("Version manifest was not created");
    const validManifest = manifestFile.data;
    const cleanPreview = await versions.createDerivedNote(sourceFile, sourceContent, {
      meta: { sourceId: getSourceIdFromMarkdown(sourceContent, sourceFile), kind: "clean", createdAt: "2026-09-29T21:49:00" },
      frontmatter: "",
      body: "Clean preview text.",
    }, "Clean transcript", "cleanscript");
    if (!cleanPreview) throw new Error("Clean preview was not created");
    manifestFile.data = "{";
    const originalSource = await vault.read(sourceFile);
    await expect(versions.switchVersion(cleanPreview, sourceFile.path)).rejects.toThrow();
    expect(await vault.read(sourceFile)).toBe(originalSource);
    expect(manifestFile.data).toBe("{");
    manifestFile.data = validManifest;
    files.delete(cleanPreview.path);

    await service.generateCleanScript(sourceFile);
    cleanFrontmatterOverride = null;

    expect(await vault.read(sourceFile)).toContain('qnalog_mode: "cleanscript"');
    expect(await vault.read(sourceFile)).toContain('qnalog_time: "2026-09-29T21:49:00"');
    expect(await vault.read(sourceFile)).toContain('qnalog_custom: "keep-me"');
    expect(await vault.read(sourceFile)).toContain("Readable cleaned transcript.");
    expect(await vault.read(sourceFile)).toContain("Original ASR transcript.");
    expect(await vault.read(sourceFile)).toContain("qnalog-active-version-start");
    expect(cleanTranscript).toHaveBeenCalledOnce();
    const derived = [...files.values()].find((file) => file.path !== sourceFile.path && file.path.startsWith(`${sourceFile.parent.path}/`) && !file.path.includes("/.versions/") && file.path.endsWith(`${sourceFile.basename}.md`));
    expect(derived).toBeDefined();
    expect(derived?.path).toMatch(/【.+】/);
    expect(derived?.data).toContain('variant_kind: "clean"');
    expect(derived?.data).toContain('qnalog_mode: "cleanscript"');
    expect(derived?.data).toContain("qnalog_contains_raw: false");
    expect(derived?.data).toContain("Readable cleaned transcript.");
    expect(derived?.data).toContain("[[2026-09-29 2149 · 会议纪要]]");
    const malformedVersion = new obsidian.TFile(
      `${sourceFile.parent.path}/Malformed clean.md`,
      `---\nvariant_kind: "clean"\nqnalog_source_path: "${sourceFile.path}"\nqnalog_time: [\n---\nClean body`,
    );
    files.set(malformedVersion.path, malformedVersion);
    cleanFrontmatterOverride = {};
    const beforeMalformedSwitch = await vault.read(sourceFile);
    await expect(versions.switchVersion(malformedVersion, sourceFile.path)).rejects.toThrow("Could not read version metadata");
    expect(await vault.read(sourceFile)).toBe(beforeMalformedSwitch);
    cleanFrontmatterOverride = null;
    files.delete(malformedVersion.path);
    expect(openFile).toHaveBeenCalledWith(sourceFile);
    expect([...files.values()].filter((file) => file.path.includes("/.versions/") && file.data.includes('variant_kind: "clean"'))).toHaveLength(0);
    expect(tasks.completeTaskActivity).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ subject: sourceFile.path }));
    expect(versions.findDerivedNoteForSource(sourceFile, getSourceIdFromMarkdown(sourceContent, sourceFile), "clean")).toBe(derived);
    const originalVersion = await versions.findOriginalVersionForSource(sourceFile);
    expect(originalVersion).toBeDefined();
    expect(await vault.adapter.read(originalVersion!.path)).toContain("First generated minutes must stay visible.");
    expect(originalVersion?.mode).toBe("meeting");
    expect([...files.values()].filter((file) => file.path.includes("/.versions/") && file.data.includes('variant_kind: "source-original"'))).toHaveLength(1);
    await expect(versions.ensureOriginalVersionForSource(sourceFile)).resolves.toBe(originalVersion?.path);
    expect([...files.values()].filter((file) => file.path.includes("/.versions/") && file.data.includes('variant_kind: "source-original"'))).toHaveLength(1);
    await versions.saveVersion(sourceFile, await vault.read(sourceFile), [], {
      kind: "minutes",
      label: "个人笔记",
      mode: "monologue",
      idLabel: "personal-note",
      body: `---\nqnalog_time: 2026-09-29T21:49:00\nqnalog_mode: monologue\nqnalog_custom: keep-me\n---\nPersonal note body.`,
      activate: false,
    });
    const personalVersion = [...files.values()].find((file) => file.extension === "md" && file.path.includes("/.versions/") && file.data.includes("personal-note"));
    expect(personalVersion).toBeDefined();
    await versions.switchVersion(personalVersion, sourceFile.path);
    expect(await vault.read(sourceFile)).toContain("qnalog_mode: monologue");
    expect(await vault.read(sourceFile)).toContain("Personal note body.");
    await versions.switchVersion(derived, sourceFile.path);
    expect(await vault.read(sourceFile)).toContain('qnalog_mode: "cleanscript"');
    expect(await vault.read(sourceFile)).toContain("Readable cleaned transcript.");
    await versions.saveVersion(sourceFile, await vault.read(sourceFile), [], {
      kind: "minutes",
      label: "综合纪要",
      mode: "synthesis",
      idLabel: "synthesis-note",
      body: `---\nqnalog_time: 2026-09-29T21:49:00\nqnalog_mode: synthesis\nqnalog_custom: keep-me\n---\nSynthesis body.`,
      activate: false,
    });
    const synthesisVersion = [...files.values()].find((file) => file.extension === "md" && file.path.includes("/.versions/") && file.data.includes("synthesis-note"));
    expect(synthesisVersion).toBeDefined();
    await versions.switchVersion(synthesisVersion, sourceFile.path);
    expect(await vault.read(sourceFile)).toContain("qnalog_mode: synthesis");
    expect(await vault.read(sourceFile)).toContain("Synthesis body.");
    await versions.switchVersion(originalVersion?.path, sourceFile.path);
    expect(await vault.read(sourceFile)).toContain("qnalog_mode: meeting");
    expect(await vault.read(sourceFile)).toContain("qnalog_time: 2026-09-29T21:49:00");
    expect(await vault.read(sourceFile)).toContain("qnalog_custom: keep-me");
    expect(await vault.read(sourceFile)).toContain("First generated minutes must stay visible.");
    await service.generateCleanScript(sourceFile);
    expect(await vault.read(sourceFile)).toContain('qnalog_mode: "cleanscript"');
    expect(cleanTranscript).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledTimes(6);
    expect(openFile).toHaveBeenLastCalledWith(sourceFile);
    expect([...files.values()].filter((file) => file.path !== sourceFile.path && file.path.startsWith(`${sourceFile.parent.path}/`) && !file.path.includes("/.versions/") && file.path.endsWith(`${sourceFile.basename}.md`))).toHaveLength(1);
    cleanFrontmatterOverride = {
      variant_kind: "clean",
      source_id: "old-session-id",
      qnalog_type: "QnALog派生版本",
      qnalog_source_path: "OldVault/转写纪要/renamed-source.md",
      qnalog_contains_raw: false,
    };
    expect(await service.findCleanCopy(sourceFile)).toBe(derived);
    cleanTranscriptMock.mockResolvedValueOnce({ text: "Regenerated in the existing file.", truncated: false });
    await service.generateCleanScript(sourceFile, { regenerateExisting: true });
    expect(cleanTranscript).toHaveBeenCalledTimes(2);
    expect(files.get(derived?.path || "")).toBe(derived);
    expect(derived?.data).toContain("Regenerated in the existing file.");
    cleanFrontmatterOverride = null;
    cleanTranscriptMock.mockResolvedValueOnce({ text: "Updated clean transcript.", truncated: false });
    await service.generateCleanScript(derived as MemoryFile);
    expect(cleanTranscript).toHaveBeenCalledTimes(3);
    expect(derived?.data).toContain("Updated clean transcript.");
    expect(openFile).toHaveBeenCalledTimes(8);
    const cleanPath = derived?.path || "";
    if (!cleanPath) throw new Error("Clean note was not created");
    files.delete(cleanPath);
    cleanTranscriptMock.mockResolvedValueOnce({ text: "Regenerated after deletion.", truncated: false });
    await service.generateCleanScript(sourceFile);
    const recreated = files.get(cleanPath);
    expect(cleanTranscript).toHaveBeenCalledTimes(4);
    expect(recreated?.data).toContain("Regenerated after deletion.");
    expect(openFile).toHaveBeenCalledTimes(9);
    expect(openFile).toHaveBeenLastCalledWith(sourceFile);
    await Promise.all([
      service.generateCleanScript(recreated as MemoryFile),
      service.generateCleanScript(recreated as MemoryFile),
    ]);
    expect(cleanTranscript).toHaveBeenCalledTimes(5);
    expect([...files.values()].filter((file) => file.path !== sourceFile.path && file.path.startsWith(`${sourceFile.parent.path}/`) && !file.path.includes("/.versions/") && file.path.endsWith(`${sourceFile.basename}.md`))).toHaveLength(1);
    const originalSnapshotPath = originalVersion?.path;
    if (!originalSnapshotPath) throw new Error("Original snapshot was not stored");
    const activeContentBeforeMissingSnapshot = await vault.read(sourceFile);
    files.delete(originalSnapshotPath);
    const missingOriginalManifest = files.get(manifestPath);
    if (!missingOriginalManifest) throw new Error("Version manifest was not written");
    missingOriginalManifest.data = JSON.stringify({
      ...JSON.parse(missingOriginalManifest.data),
      versions: JSON.parse(missingOriginalManifest.data).versions.filter((record: { kind: string }) => record.kind !== "source-original"),
    });
    expect(await versions.findOriginalVersionForSource(sourceFile)).toBeNull();
    await expect(versions.ensureOriginalVersionForSource(sourceFile)).rejects.toThrow();
    expect(await vault.read(sourceFile)).toBe(activeContentBeforeMissingSnapshot);
  });
  it("generates and activates a clean copy from a raw-only source without inventing an original row", async () => {
    const { files, vault } = createMemoryVault();
    const rawOnlyContent = sourceContent.replace("First generated minutes must stay visible.", "");
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/raw-only.md", rawOnlyContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const app = {
      vault,
      metadataCache: { getFileCache: (candidate: MemoryFile) => candidate.path === sourceFile.path
        ? { frontmatter: { qnalog_time: "2026-09-29T21:49:00", qnalog_mode: "meeting" } }
        : { frontmatter: {} } },
      workspace: { getLeaf: () => ({ openFile: vi.fn() }) },
    };
    const noteIndex = { refreshNoteIndexSafely: vi.fn(async () => undefined) };
    const versions = new VersionStore(makeVersionHost(app, () => settings, noteIndex.refreshNoteIndexSafely));
    const tasks = {
      startTaskActivity: vi.fn(),
      patchTaskActivity: vi.fn(),
      updateBusyStatus: vi.fn(),
      beginTaskMeter: vi.fn(() => ({ id: "meter" })),
      endTaskMeter: vi.fn(() => ({ elapsedMs: 1 })),
      logCompletedWork: vi.fn(),
      completeTaskActivity: vi.fn(),
    };
    const service = new RepolishService({ app, settings, tasks, versions, noteIndex } as never);

    await expect(versions.ensureOriginalVersionForSource(sourceFile)).resolves.toBeNull();
    await service.generateCleanScript(sourceFile);

    expect(await vault.read(sourceFile)).toContain("Readable cleaned transcript.");
    expect(await versions.findOriginalVersionForSource(sourceFile)).toBeNull();
    expect([...files.values()].some((candidate) =>
      candidate.path !== sourceFile.path && candidate.path.startsWith(`${sourceFile.parent.path}/`)
      && candidate.data.includes('variant_kind: "clean"') && candidate.data.includes("Readable cleaned transcript."))).toBe(true);
    expect(cleanTranscript).toHaveBeenCalledOnce();
  });
  it("uses an English built-in mode prefix for new repolished files and cache records", async () => {
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/旧中文纪要.md", sourceContent);
    const oldChineseDerived = new obsidian.TFile(
      "QnALog/转写纪要/【工作纪要】旧中文纪要.md",
      "legacy Chinese derived note",
    );
    files.set(sourceFile.path, sourceFile);
    files.set(oldChineseDerived.path, oldChineseDerived);
    const settings = {
      mdFolder: "QnALog/转写纪要",
      promptTemplates: {
        "custom-output": {
          id: "custom-output",
          mode: "custom-output",
          customMode: true,
          name: "我的模板",
          baseMode: "meeting",
          prompt: "Custom prompt fixture.",
        },
      },
    };
    const app = {
      vault,
      metadataCache: { getFileCache: () => ({ frontmatter: { qnalog_time: "2026-09-29T21:49:00", qnalog_mode: "meeting" } }) },
      workspace: { getLeaf: () => ({ openFile: vi.fn(async () => undefined) }) },
    };
    const noteIndex = { refreshNoteIndexSafely: vi.fn(async () => undefined) };
    const versions = new VersionStore(makeVersionHost(app, () => settings, noteIndex.refreshNoteIndexSafely));
    const tasks = {
      startTaskActivity: vi.fn(), patchTaskActivity: vi.fn(), updateBusyStatus: vi.fn(),
      beginTaskMeter: vi.fn(() => ({ id: "meter" })), endTaskMeter: vi.fn(() => ({ elapsedMs: 1 })),
      logCompletedWork: vi.fn(), completeTaskActivity: vi.fn(), failTaskActivity: vi.fn(),
    };
    const service = new RepolishService({ app, settings, tasks, versions, noteIndex, requestOutlineRefresh: vi.fn() } as never);
    mergeAndPolishMock.mockResolvedValue("Generated body fixture.");

    await service.repolishMarkdownFile(sourceFile, "meeting", { label: "简洁" });

    const derived = files.get("QnALog/转写纪要/【Work notes · 简洁】旧中文纪要.md");
    expect(derived?.data).toContain("Generated body fixture.");
    expect(derived?.data).toContain('variant_label: "Work notes · 简洁"');
    expect(derived?.data).toContain('variant_mode: "meeting"');
    expect(derived?.data).toContain('variant_style: "简洁"');
    const folder = getVersionStoreFolder(settings, getSourceIdFromMarkdown(sourceContent, sourceFile));
    const manifestPath = `${folder}/manifest.json`;
    const manifest = JSON.parse(await vault.adapter.read(manifestPath));
    const record = manifest.versions.find((entry: { label: string }) => entry.label === "Work notes · 简洁");
    expect(record).toBeDefined();
    expect(record.mode).toBe("meeting");
    expect(record.style).toBe("简洁");
    const cache = files.get(`${folder}/${record.fileName}`);
    expect(cache?.data).toContain('variant_label: "Work notes · 简洁"');
    expect(cache?.data).toContain('variant_mode: "meeting"');
    expect(cache?.data).toContain('variant_style: "简洁"');
    const activeBeforeSwitch = manifest.activeVersionId;
    await service.repolishMarkdownFile(sourceFile, "meeting");
    await service.repolishMarkdownFile(sourceFile, "meeting");
    const noPreferenceDerived = files.get("QnALog/转写纪要/【Work notes】旧中文纪要.md");
    expect(noPreferenceDerived?.data).toContain('variant_label: "Work notes"');
    expect(noPreferenceDerived?.data).toContain('variant_style: ""');
    const afterRepeated = JSON.parse(await vault.adapter.read(manifestPath));
    expect(afterRepeated.activeVersionId).toBe(activeBeforeSwitch);
    expect(afterRepeated.versions.filter((entry: { label: string; kind: string }) =>
      entry.label === "Work notes" && entry.kind === "minutes")).toHaveLength(2);
    expect(oldChineseDerived.data).toBe("legacy Chinese derived note");
    await versions.switchVersion(cache!, sourceFile.path);
    expect(await vault.read(sourceFile)).toContain("> [!info]- Currently displayed version: Work notes · 简洁");
    expect(await vault.read(sourceFile)).toContain("Original ASR transcript.");
    expect(JSON.parse(await vault.adapter.read(manifestPath)).activeVersionId).toBe(record.id);
    expect(activeBeforeSwitch).not.toBe(record.id);

    await service.repolishMarkdownFile(sourceFile, "custom-output", { label: "简洁" });
    const customDerived = files.get("QnALog/转写纪要/【我的模板 · 简洁】旧中文纪要.md");
    expect(customDerived?.data).toContain('variant_label: "我的模板 · 简洁"');
    expect(customDerived?.data).toContain('variant_mode: "custom-output"');
    expect(customDerived?.data).toContain('variant_style: "简洁"');
    expect(customDerived?.data).not.toContain("Custom prompt:");
    const afterCustom = JSON.parse(await vault.adapter.read(manifestPath));
    expect(afterCustom.versions.some((entry: { label: string; mode: string }) =>
      entry.label === "我的模板 · 简洁" && entry.mode === "custom-output")).toBe(true);
  });

  it("saves and exposes a personal-note original when a synthesis version is generated", async () => {
    setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
    const { files, vault } = createMemoryVault();
    const originalContent = sourceContent.replace("qnalog_mode: meeting", "qnalog_mode: monologue");
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/个人笔记-假期安排-中秋国庆拼假.md", originalContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const app = {
      vault,
      metadataCache: {
        getFileCache: (candidate: MemoryFile) => candidate.path === sourceFile.path
          ? { frontmatter: { qnalog_time: "2026-09-30T09:00:00", qnalog_mode: "monologue", qnalog_custom: "keep-me" } }
          : { frontmatter: {} },
      },
      workspace: { getLeaf: () => ({ openFile: vi.fn(async () => undefined) }) },
    };
    const noteIndex = { refreshNoteIndexSafely: vi.fn(async () => undefined) };
    const versions = new VersionStore(makeVersionHost(app, () => settings, noteIndex.refreshNoteIndexSafely));
    const requestOutlineRefresh = vi.fn();
    const tasks = {
      _busyLabel: null,
      _busyContext: null,
      startTaskActivity: vi.fn(),
      patchTaskActivity: vi.fn(),
      updateBusyStatus: vi.fn(),
      beginTaskMeter: vi.fn(() => ({ id: "meter" })),
      endTaskMeter: vi.fn(() => ({ elapsedMs: 1 })),
      logCompletedWork: vi.fn(),
      completeTaskActivity: vi.fn(),
    };
    const service = new RepolishService({
      app, settings, tasks, versions, noteIndex, requestOutlineRefresh,
    } as never);
    mergeAndPolishMock.mockResolvedValue("Synthesis body for the holiday plan.");

    await service.repolishMarkdownFile(sourceFile, "synthesis");

    const snapshot = await versions.findOriginalVersionForSource(sourceFile);
    expect(snapshot?.mode).toBe("monologue");
    expect(await vault.adapter.read(snapshot!.path)).not.toContain("Synthesis body");
    expect(await vault.adapter.read(snapshot!.path)).toContain("First generated minutes must stay visible.");
    expect(await vault.read(sourceFile)).toContain("Original ASR transcript.");
    expect([...files.values()].some((candidate) =>
      candidate.path.includes("【综合纪要】") && candidate.data.includes("Synthesis body for the holiday plan."))).toBe(true);
    expect(requestOutlineRefresh).toHaveBeenCalledOnce();
  });
  it("does not create a derived note when the original snapshot cannot be saved", async () => {
    const { files, vault } = createMemoryVault();
    const originalContent = sourceContent.replace("qnalog_mode: meeting", "qnalog_mode: monologue")
      .replace("First generated minutes must stay visible.", "正文 A：个人笔记。");
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/personal-note.md", originalContent);
    files.set(sourceFile.path, sourceFile);
    const app = {
      vault,
      metadataCache: { getFileCache: () => ({ frontmatter: { qnalog_time: "2026-09-30T09:00:00", qnalog_mode: "monologue" } }) },
    };
    const versions = new VersionStore(makeVersionHost(app, () => ({ mdFolder: "QnALog/转写纪要" })));
    const createDerivedNote = vi.spyOn(versions, "createDerivedNote");
    let contentAtSnapshotGate = "";
    vi.spyOn(versions, "ensureOriginalVersionForSource").mockImplementation(async () => {
      contentAtSnapshotGate = await vault.read(sourceFile);
      throw new Error("Could not save original minutes");
    });
    const tasks = {
      startTaskActivity: vi.fn(),
      patchTaskActivity: vi.fn(),
      updateBusyStatus: vi.fn(),
      beginTaskMeter: vi.fn(() => ({ id: "meter" })),
      endTaskMeter: vi.fn(),
      failTaskActivity: vi.fn(),
    };
    const service = new RepolishService({ app, settings: { mdFolder: "QnALog/转写纪要" }, tasks, versions } as never);
    mergeAndPolishMock.mockResolvedValue("研讨会派生正文");

    await service.repolishMarkdownFile(sourceFile, "seminar");

    expect(createDerivedNote).not.toHaveBeenCalled();
    expect(await vault.read(sourceFile)).toBe(contentAtSnapshotGate);
    expect(await vault.read(sourceFile)).toContain("Original ASR transcript.");
    expect([...files.values()].filter((candidate) => candidate.path !== sourceFile.path)).toHaveLength(0);
  });
  it("stops repolishing when writing the original snapshot manifest fails", async () => {
    const { files, vault } = createMemoryVault();
    const originalContent = sourceContent.replace("qnalog_mode: meeting", "qnalog_mode: monologue")
      .replace("First generated minutes must stay visible.", "正文 A：个人笔记。");
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/personal-note.md", originalContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const app = {
      vault,
      metadataCache: { getFileCache: () => ({ frontmatter: { qnalog_time: "2026-09-29T21:49:00", qnalog_mode: "monologue" } }) },
    };
    const versions = new VersionStore(makeVersionHost(app, () => settings));
    const createDerivedNote = vi.spyOn(versions, "createDerivedNote");
    const originalWrite = vault.adapter.write;
    let contentAtManifestFailure = "";
    vi.spyOn(vault.adapter, "write").mockImplementation(async (path, content) => {
      if (path.endsWith("/manifest.json")) {
        contentAtManifestFailure = await vault.read(sourceFile);
        throw new Error("Simulated original snapshot manifest failure");
      }
      await originalWrite(path, content);
    });
    const tasks = {
      startTaskActivity: vi.fn(),
      patchTaskActivity: vi.fn(),
      updateBusyStatus: vi.fn(),
      beginTaskMeter: vi.fn(() => ({ id: "meter" })),
      endTaskMeter: vi.fn(),
      failTaskActivity: vi.fn(),
    };
    const service = new RepolishService({ app, settings, tasks, versions } as never);
    mergeAndPolishMock.mockResolvedValue("研讨会派生正文");

    await service.repolishMarkdownFile(sourceFile, "seminar");

    expect(createDerivedNote).not.toHaveBeenCalled();
    expect(contentAtManifestFailure).not.toBe("");
    expect(await vault.read(sourceFile)).toBe(contentAtManifestFailure);
    expect(await vault.read(sourceFile)).toContain("Original ASR transcript.");
    expect([...files.values()].some((candidate) => candidate.data.includes('variant_kind: "minutes"'))).toBe(false);
  });

  it("rejects a version file without variant_kind before changing the source note", async () => {
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/source.md", sourceContent);
    files.set(sourceFile.path, sourceFile);
    const app = {
      vault,
      metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
      workspace: { getLeaf: () => ({ openFile: vi.fn() }) },
    };
    const versions = new VersionStore(makeVersionHost(
      app,
      () => ({ mdFolder: "QnALog/转写纪要" }),
      async () => undefined,
    ));
    const malformed = new obsidian.TFile(
      "QnALog/转写纪要/.versions/source/untyped.md",
      `---\nversion_id: "untyped"\nvariant_label: "Invalid"\nqnalog_source_path: "${sourceFile.path}"\nsource_id: "${getSourceIdFromMarkdown(sourceContent, sourceFile)}"\n---\n\nMust not replace the source.`,
    );
    files.set(malformed.path, malformed);
    const original = await vault.read(sourceFile);

    await expect(versions.switchVersion(malformed, sourceFile.path)).rejects.toThrow("Could not read version metadata");
    expect(await vault.read(sourceFile)).toBe(original);
  });
  it("serializes simultaneous saves per source while independent sources progress", async () => {
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/source.md", sourceContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
    const folder = getVersionStoreFolder(settings, sourceId);
    const manifestPath = `${folder}/manifest.json`;
    const app = {
      vault,
      metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
      workspace: { getLeaf: () => ({ openFile: vi.fn() }) },
    };
    const versions = new VersionStore(makeVersionHost(app, () => settings));
    const previous = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "previous-minutes", label: "Previous", body: "Previous version.", activate: true,
    });
    const original = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "source-original", idLabel: "source-original", label: "Personal note",
      mode: "monologue", body: "Personal text A.", activate: false,
    });
    const sourceBefore = await vault.read(sourceFile);
    const secondSource = new obsidian.TFile("QnALog/转写纪要/second-source.md", sourceContent);
    files.set(secondSource.path, secondSource);
    const secondContent = await vault.read(secondSource);
    const secondSourceId = getSourceIdFromMarkdown(secondContent, secondSource);
    const secondFolder = getVersionStoreFolder(settings, secondSourceId);
    const secondManifestPath = `${secondFolder}/manifest.json`;
    const secondSourceBytes = await vault.read(secondSource);

    let enterManifestRead: () => void = () => undefined;
    let releaseManifestRead: () => void = () => undefined;
    const manifestReadEntered = new Promise<void>((resolve) => { enterManifestRead = resolve; });
    const manifestReadGate = new Promise<void>((resolve) => { releaseManifestRead = resolve; });
    let pausedFirstRead = false;
    vi.spyOn(vault.adapter, "read").mockImplementation(async (path) => {
      if (path === manifestPath && !pausedFirstRead) {
        pausedFirstRead = true;
        enterManifestRead();
        await manifestReadGate;
      }
      const file = files.get(path);
      if (!file) throw new Error(`File not found: ${path}`);
      return file.data;
    });
    const saveOne = versions.saveVersion(sourceFile, sourceBefore, [], {
      kind: "minutes", idLabel: "minutes", label: "Meeting", body: "Minutes A.", activate: false,
    });
    await manifestReadEntered;
    const saveTwo = versions.saveVersion(sourceFile, sourceBefore, [], {
      kind: "minutes", idLabel: "minutes", label: "Meeting", body: "Minutes B.", activate: false,
    });
    const independent = versions.saveVersion(secondSource, secondContent, [], {
      kind: "minutes", idLabel: "independent", label: "Independent", body: "Separate source.", activate: false,
    });
    const savedIndependent = await independent;
    expect(files.has(secondManifestPath)).toBe(true);
    releaseManifestRead();
    const [savedOne, savedTwo] = await Promise.all([saveOne, saveTwo]);

    const manifestFile = files.get(manifestPath);
    if (!manifestFile) throw new Error("Version manifest was not written");
    const manifest = JSON.parse(manifestFile.data);
    expect(manifest.activeVersionId).toBe(previous.meta.id);
    expect(manifest.versions.map((record: { id: string }) => record.id)).toEqual([
      previous.meta.id, original.meta.id, savedOne.meta.id, savedTwo.meta.id,
    ]);
    expect(savedOne.meta.id).not.toBe(savedTwo.meta.id);
    expect(files.get(`${folder}/${savedOne.meta.fileName}`)?.data).toContain("Minutes A.");
    expect(files.get(`${folder}/${savedTwo.meta.fileName}`)?.data).toContain("Minutes B.");
    expect(files.get(`${folder}/${original.meta.fileName}`)?.data).toContain("Personal text A.");
    expect(files.get(`${secondFolder}/${savedIndependent.meta.fileName}`)?.data).toContain("Separate source.");
    expect(await vault.read(sourceFile)).toBe(sourceBefore);
    expect(await vault.read(secondSource)).toBe(secondSourceBytes);
    expect(savedIndependent.manifest.sourceId).toBe(secondSourceId);

  });
  it("releases the source lock after a manifest write failure and retains the orphan cache", async () => {
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/source.md", sourceContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
    const folder = getVersionStoreFolder(settings, sourceId);
    const manifestPath = `${folder}/manifest.json`;
    const originalWrite = vault.adapter.write;
    let failNextManifestWrite = true;
    vi.spyOn(vault.adapter, "write").mockImplementation(async (path, content) => {
      if (path === manifestPath && failNextManifestWrite) {
        failNextManifestWrite = false;
        throw new Error("disk denied");
      }
      await originalWrite(path, content);
    });
    const versions = new VersionStore(makeVersionHost(
      { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
      () => settings,
    ));
    const failed = versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "failed", label: "Failed", body: "Orphan material.",
    });
    const later = versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "later", label: "Later", body: "Committed material.",
    });

    await expect(failed).rejects.toThrow("disk denied");
    const saved = await later;
    const manifest = JSON.parse(files.get(manifestPath)!.data);
    expect(manifest.versions.map((record: { id: string }) => record.id)).toContain(saved.meta.id);
    const orphan = [...files.values()].find((file) => file.data.includes("Orphan material."));
    const failedId = orphan?.data.match(/^version_id: "([^"]+)"$/m)?.[1];
    expect(failedId).toBeTruthy();
    expect(manifest.versions.map((record: { id: string }) => record.id)).not.toContain(failedId);
    expect(orphan?.path).toContain(`${folder}/`);
    expect(orphan?.data).toContain("Orphan material.");
    expect(files.get(`${folder}/${saved.meta.fileName}`)?.data).toContain("Committed material.");
  });

  it("preserves unknown manifest fields through a VersionStore save", async () => {
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/source.md", sourceContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
    const folder = getVersionStoreFolder(settings, sourceId);
    const versions = new VersionStore(makeVersionHost(
      { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
      () => settings,
    ));
    await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "first", label: "First", body: "First saved version.",
    });
    const manifestFile = files.get(`${folder}/manifest.json`);
    if (!manifestFile) throw new Error("Version manifest was not written");
    const manifest = JSON.parse(manifestFile.data);
    manifest.unknown = { nested: ["preserve", { flag: true }] };
    manifest.versions[0].vendorField = { untouched: true };
    manifestFile.data = JSON.stringify(manifest);

    await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "second", label: "Second", body: "Second saved version.",
    });

    const savedManifest = JSON.parse(manifestFile.data);
    expect(savedManifest.unknown).toEqual({ nested: ["preserve", { flag: true }] });
    expect(savedManifest.versions[0].vendorField).toEqual({ untouched: true });
    const savedIds = savedManifest.versions.map((record: { id: string }) => record.id);
    expect(savedIds).toHaveLength(2);
    expect(savedIds[0]).toContain("-first");
    expect(savedIds[1]).toContain("-second");
  });
  it("rejects a cache path that appears between name selection and creation", async () => {
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/path-race.md", sourceContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const versions = new VersionStore(makeVersionHost(
      { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
      () => settings,
    ));
    const originalExists = vault.adapter.exists;
    let targetPath = "";
    let targetChecks = 0;
    vi.spyOn(vault.adapter, "exists").mockImplementation(async (path) => {
      if (path.includes("/.versions/") && path.endsWith("-attempt.md")) {
        targetPath = path;
        targetChecks++;
        if (targetChecks === 2) {
          files.set(path, new obsidian.TFile(path, "Concurrent writer bytes."));
          return true;
        }
      }
      return originalExists(path);
    });

    await expect(versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "attempt", label: "Attempt", body: "Must not replace competitor.",
    })).rejects.toThrow("Version cache file already exists");
    expect(targetChecks).toBe(2);
    expect(files.get(targetPath)?.data).toBe("Concurrent writer bytes.");
    expect([...files.values()].some((file) => file.data.includes("Must not replace competitor."))).toBe(false);
  });

  it.each([true, false])("preserves cache create failure state when a competitor appears: %s", async (competitorAppears) => {
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/create-race.md", sourceContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const versions = new VersionStore(makeVersionHost(
      { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
      () => settings,
    ));
    const originalCreate = vault.create;
    const sourceBefore = await vault.read(sourceFile);
    let conflictPath = "";
    vi.spyOn(vault, "create").mockImplementation(async (path, content) => {
      if (!content.includes("Uncommitted body.")) return originalCreate(path, content);
      conflictPath = path;
      if (competitorAppears) files.set(path, new obsidian.TFile(path, "Competitor bytes."));
      throw new Error("create denied");
    });

    await expect(versions.saveVersion(sourceFile, sourceBefore, [], {
      kind: "minutes", idLabel: "attempt", label: "Attempt", body: "Uncommitted body.",
    })).rejects.toThrow(competitorAppears ? "Version cache file already exists" : "create denied");
    expect(conflictPath).not.toBe("");
    expect(files.get(conflictPath)?.data).toBe(competitorAppears ? "Competitor bytes." : undefined);
    const manifestPath = `${getVersionStoreFolder(settings, getSourceIdFromMarkdown(sourceBefore, sourceFile))}/manifest.json`;
    expect(files.has(manifestPath)).toBe(false);
    expect(await vault.read(sourceFile)).toBe(sourceBefore);

    vi.mocked(vault.create).mockRestore();
    const retry = await versions.saveVersion(sourceFile, sourceBefore, [], {
      kind: "minutes", idLabel: "attempt", label: "Attempt", body: "Retry body.",
    });
    const collisionName = conflictPath.split("/").pop() || "";
    expect(retry.meta.fileName).toBe(competitorAppears
      ? collisionName.replace(/\.md$/, "-2.md")
      : collisionName);
    expect(files.get(manifestPath)?.data).toContain(retry.meta.id);
  });

  it("keeps a mismatched cache readback orphaned and retries with another path", async () => {
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/cache-readback.md", sourceContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
    const manifestPath = `${getVersionStoreFolder(settings, sourceId)}/manifest.json`;
    const versions = new VersionStore(makeVersionHost(
      { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
      () => settings,
    ));
    const prior = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "prior", label: "Prior", body: "Prior stays.",
    });
    const manifestBefore = files.get(manifestPath)!.data;
    const sourceBefore = await vault.read(sourceFile);
    const originalCreate = vault.create;
    const originalRead = vault.adapter.read;
    let corruptedPath = "";
    vi.spyOn(vault, "create").mockImplementation(async (path, content) => {
      if (content.includes("Corrupted on readback.")) corruptedPath = path;
      return originalCreate(path, content);
    });
    vi.spyOn(vault.adapter, "read").mockImplementation(async (path) =>
      path === corruptedPath ? "Different readback bytes." : originalRead(path));

    await expect(versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "retry-id", label: "Retry", body: "Corrupted on readback.",
    })).rejects.toThrow("Could not verify version metadata");
    const orphanBytes = files.get(corruptedPath)?.data;
    expect(orphanBytes).toContain("Corrupted on readback.");
    expect(files.get(manifestPath)?.data).toBe(manifestBefore);
    expect(files.get(`${prior.folder}/${prior.meta.fileName}`)?.data).toContain("Prior stays.");
    expect(await vault.read(sourceFile)).toBe(sourceBefore);

    vi.mocked(vault.adapter.read).mockRestore();
    const retry = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "retry-id", label: "Retry", body: "Successful retry.",
    });
    expect(retry.meta.fileName).not.toBe(corruptedPath.split("/").pop());
    expect(files.get(corruptedPath)?.data).toBe(orphanBytes);
    expect(files.get(manifestPath)?.data).toContain(retry.meta.id);
  });

  it.each(["remove-record", "wrong-active"] as const)("rejects failed final manifest confirmation (%s) without deleting saved material", async (failure) => {
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/final-confirm.md", sourceContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
    const manifestPath = `${getVersionStoreFolder(settings, sourceId)}/manifest.json`;
    const versions = new VersionStore(makeVersionHost(
      { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
      () => settings,
    ));
    const sourceBefore = await vault.read(sourceFile);
    const originalRead = vault.adapter.read;
    let manifestReadCount = 0;
    vi.spyOn(vault.adapter, "read").mockImplementation(async (path) => {
      const content = await originalRead(path);
      if (path !== manifestPath) return content;
      manifestReadCount++;
      if (manifestReadCount !== 2) return content;
      const projected = JSON.parse(content);
      if (failure === "remove-record") projected.versions = [];
      else projected.activeVersionId = "unexpected-active";
      return JSON.stringify(projected);
    });

    await expect(versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "confirmed", label: "Confirmed", body: "Saved but unconfirmed.",
    })).rejects.toThrow("Could not verify version metadata");
    const diskManifest = JSON.parse(files.get(manifestPath)!.data);
    const savedRecord = diskManifest.versions.find((record: { id: string }) => record.id.includes("confirmed"));
    expect(savedRecord).toBeTruthy();
    expect(files.get(`${getVersionStoreFolder(settings, sourceId)}/${savedRecord.fileName}`)?.data).toContain("Saved but unconfirmed.");
    expect(await vault.read(sourceFile)).toBe(sourceBefore);

    vi.mocked(vault.adapter.read).mockRestore();
    const recovered = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "after-confirmation-failure", label: "Recovered", body: "Lock released.",
    });
    expect(files.get(manifestPath)?.data).toContain(recovered.meta.id);
  });

  it("persists segment order, status, end offsets, and the production source hash", async () => {
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/segment-metadata.md", sourceContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
    const folder = getVersionStoreFolder(settings, sourceId);
    const segments: Segment[] = [
      { index: 0, startOffsetMs: 1000, endOffsetMs: 0, text: " " },
      { index: 1, startOffsetMs: 2000, endOffsetMs: 3000, text: "Words." },
    ];
    const versions = new VersionStore(makeVersionHost(
      { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
      () => settings,
    ));

    const saved = await versions.saveVersion(sourceFile, sourceContent, segments, {
      kind: "minutes", idLabel: "segments", label: "Segments", body: "Segment metadata.",
    });
    const manifest = JSON.parse(files.get(`${folder}/manifest.json`)!.data);
    expect(manifest.segments).toEqual([
      expect.objectContaining({ id: "seg-0001", index: 0, startOffsetMs: 1000, endOffsetMs: 1000, status: "pending" }),
      expect.objectContaining({ id: "seg-0002", index: 1, startOffsetMs: 2000, endOffsetMs: 3000, status: "done" }),
    ]);
    const cache = files.get(`${folder}/${saved.meta.fileName}`);
    expect(cache).toBeDefined();
    const cacheFrontmatter = obsidian.parseYaml(cache!.data.split("---")[1]) as Record<string, unknown>;
    expect(cacheFrontmatter.source_segments_hash).toBe(getSegmentsHash(segments));
  });


  it("uses the current adapter when manifest capabilities execute", async () => {
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/source.md", sourceContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const initialManifest = vault.adapter;
    const alternateFiles = new Map<string, string>();
    const alternateFolders = new Set<string>();
    const alternateAdapter: VersionStoreHost["vault"]["adapter"] = {
      exists: async (path) => alternateFiles.has(path) || files.has(path) || alternateFolders.has(path),
      read: async (path) => {
        const content = alternateFiles.get(path) ?? files.get(path)?.data;
        if (content === undefined) throw new Error(`File not found: ${path}`);
        return content;
      },
      write: async (path, content) => { alternateFiles.set(path, content); },
      mkdir: async (path) => { alternateFolders.add(path); },
    };
    const app = { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } };
    const baseHost = makeVersionHost(app, () => settings);
    const host: VersionStoreHost = {
      ...baseHost,
      vault: {
        ...baseHost.vault,
        get adapter() { return app.vault.adapter; },
      },
    };
    const versions = new VersionStore(host);
    expect(files.size).toBe(1);
    await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "initial", label: "Initial", body: "Initial adapter.",
    });
    expect(files.has(`${getVersionStoreFolder(settings, getSourceIdFromMarkdown(sourceContent, sourceFile))}/manifest.json`)).toBe(true);

    app.vault.adapter = alternateAdapter;
    await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "alternate", label: "Alternate", body: "Alternate adapter.",
    });

    const manifestPath = `${getVersionStoreFolder(settings, getSourceIdFromMarkdown(sourceContent, sourceFile))}/manifest.json`;
    expect(alternateFiles.get(manifestPath)).toContain("alternate");
    const initialManifestContent = await initialManifest.read(manifestPath);
    expect(initialManifestContent).toContain("initial");
    expect(initialManifestContent).not.toContain("alternate");
  });

  it("rejects malformed or foreign manifests even when the vault index cannot see them", async () => {
    for (const manifestData of ["{", JSON.stringify({ version: 1, sourceId: "another-source", versions: [] })]) {
      const { files, unindexedFiles, vault } = createMemoryVault();
      const sourceFile = new obsidian.TFile("QnALog/转写纪要/source.md", sourceContent);
      files.set(sourceFile.path, sourceFile);
      const settings = { mdFolder: "QnALog/转写纪要" };
      const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
      const folder = getVersionStoreFolder(settings, sourceId);
      const manifestPath = `${folder}/manifest.json`;
      const manifestFile = new obsidian.TFile(manifestPath, manifestData);
      files.set(manifestPath, manifestFile);
      unindexedFiles.add(manifestPath);
      const versions = new VersionStore(makeVersionHost(
        { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
        () => settings,
      ));

      await expect(versions.saveVersion(sourceFile, sourceContent, [], {
        kind: "minutes", idLabel: "attempt", label: "Attempt", body: "Must not be written.",
      })).rejects.toThrow("Could not read version metadata");
      expect(manifestFile.data).toBe(manifestData);
      expect([...files.keys()]).toEqual([sourceFile.path, manifestPath]);
    }
  });

  it("does not register an original snapshot when adapter readback differs from the written payload", async () => {
    const { files, vault } = createMemoryVault();
    const originalContent = sourceContent.replace("qnalog_mode: meeting", "qnalog_mode: monologue")
      .replace("First generated minutes must stay visible.", "Personal text that must remain unchanged.");
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/readback-note.md", originalContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const sourceId = getSourceIdFromMarkdown(originalContent, sourceFile);
    const folder = getVersionStoreFolder(settings, sourceId);
    const manifestPath = `${folder}/manifest.json`;
    const originalRead = vault.adapter.read;
    vi.spyOn(vault.adapter, "read").mockImplementation(async (path) =>
      path.endsWith(".md") ? "Corrupted adapter readback." : originalRead(path));
    const versions = new VersionStore(makeVersionHost(
      { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
      () => settings,
    ));

    await expect(versions.ensureOriginalVersionForSource(sourceFile)).rejects.toThrow("Could not verify version metadata");

    expect(await vault.read(sourceFile)).toBe(originalContent);
    expect(await vault.adapter.exists(manifestPath)).toBe(false);
    const orphan = [...files.values()].find((file) => file.data.includes('variant_kind: "source-original"'));
    expect(orphan?.data).toContain("Personal text that must remain unchanged.");
  });

  it.each([
    ["version_id", "foreign-id"],
    ["variant_kind", "foreign-kind"],
    ["source_id", "foreign-source"],
    ["qnalog_source_path", "QnALog/notes/missing.md"],
    ["qnalog_type", "ForeignCache"],
  ])("rejects string activation when cached %s identity is changed", async (key, value) => {
    const { files, vault, sourceFile, versions, openFile } = createActivationFixture();
    const saved = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "identity-target", label: "Meeting", body: "Target body.", activate: false,
    });
    const folder = getVersionStoreFolder({ mdFolder: "QnALog/notes" }, getSourceIdFromMarkdown(sourceContent, sourceFile));
    const targetPath = `${folder}/${saved.meta.fileName}`;
    const target = files.get(targetPath);
    if (!target) throw new Error("Target cache was not written");
    const originalCache = target.data;
    const originalSource = await vault.read(sourceFile);
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    target.data = target.data.replace(new RegExp(`^${escapedKey}:.*$`, "m"), `${key}: ${JSON.stringify(value)}`);
    const corruptedCache = target.data;
    const originalManifest = await vault.adapter.read(`${folder}/manifest.json`);

    await expect(versions.switchVersion(targetPath, sourceFile.path)).rejects.toThrow("Could not read version metadata");

    expect(await vault.read(sourceFile)).toBe(originalSource);
    expect(target.data).toBe(corruptedCache);
    expect(await vault.adapter.read(`${folder}/manifest.json`)).toBe(originalManifest);
    expect(openFile).not.toHaveBeenCalled();
    expect(notices.some((notice) => notice.includes("Switched to version:"))).toBe(false);
    expect(originalCache).not.toBe(corruptedCache);
  });

  it("rejects a cache copied to another folder but permits a TFile fallback source", async () => {
    const { files, vault, sourceFile, versions, openFile } = createActivationFixture();
    const saved = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "fallback-target", label: "Meeting", body: "Target body.", activate: false,
    });
    const folder = getVersionStoreFolder({ mdFolder: "QnALog/notes" }, getSourceIdFromMarkdown(sourceContent, sourceFile));
    const targetPath = `${folder}/${saved.meta.fileName}`;
    const target = files.get(targetPath);
    if (!target) throw new Error("Target cache was not written");
    const originalCache = target.data;
    target.data = target.data.replace(
      `qnalog_source_path: \"${sourceFile.path}\"`,
      `qnalog_source_path: \"QnALog/notes/missing.md\"`,
    );
    await versions.switchVersion(target, sourceFile.path);
    expect(await vault.read(sourceFile)).toContain("Target body.");
    expect(openFile).toHaveBeenCalledWith(sourceFile);
    const afterFallback = await vault.read(sourceFile);
    await expect(versions.switchVersion(targetPath, sourceFile.path)).rejects.toThrow("Could not read version metadata");
    const copiedPath = `QnALog/notes/.versions/other/${saved.meta.fileName}`;
    files.set(copiedPath, new obsidian.TFile(copiedPath, originalCache));
    await expect(versions.switchVersion(copiedPath, sourceFile.path)).rejects.toThrow("Could not read version metadata");
    expect(await vault.read(sourceFile)).toBe(afterFallback);
  });

  it("does not treat a missing source or invalid fallback as an activatable cache", async () => {
    const { files, sourceFile, versions, openFile } = createActivationFixture();
    const saved = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "missing-source-target", label: "Meeting", body: "Target body.", activate: false,
    });
    const folder = getVersionStoreFolder({ mdFolder: "QnALog/notes" }, getSourceIdFromMarkdown(sourceContent, sourceFile));
    const targetPath = `${folder}/${saved.meta.fileName}`;
    const target = files.get(targetPath);
    if (!target) throw new Error("Target cache was not written");
    target.data = target.data.replace(
      `qnalog_source_path: \"${sourceFile.path}\"`,
      `qnalog_source_path: \"QnALog/notes/missing.md\"`,
    );
    await expect(versions.switchVersion(target, "QnALog/notes/also-missing.md"))
      .rejects.toThrow("Master copy not found; cannot switch versions.");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("keeps the committed activation when opening the source fails and releases the lock", async () => {
    const { files, vault, sourceFile, versions, openFile } = createActivationFixture();
    const original = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "source-original", idLabel: "activation-original", label: "Personal note", mode: "monologue",
      body: "Original body.", activate: false,
    });
    const target = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "activation-target", label: "Meeting", body: "Target body.", activate: false,
    });
    const folder = getVersionStoreFolder({ mdFolder: "QnALog/notes" }, getSourceIdFromMarkdown(sourceContent, sourceFile));
    const targetFile = files.get(`${folder}/${target.meta.fileName}`);
    if (!targetFile) throw new Error("Target cache was not written");
    const manifestPath = `${folder}/manifest.json`;
    const previousNoticeCount = notices.length;
    openFile.mockRejectedValueOnce(new Error("open denied"));
    await expect(versions.switchVersion(targetFile, sourceFile.path)).rejects.toThrow("open denied");
    expect(await vault.read(sourceFile)).toContain("Target body.");
    expect(JSON.parse(await vault.adapter.read(manifestPath)).activeVersionId).toBe(target.meta.id);
    expect(notices.slice(previousNoticeCount).some((notice) => notice.includes("Switched to version:"))).toBe(false);
    const originalFile = files.get(`${folder}/${original.meta.fileName}`);
    if (!originalFile) throw new Error("Original cache was not written");
    await versions.switchVersion(originalFile, sourceFile.path);
    expect(await vault.read(sourceFile)).toContain("Original body.");
  });

  it.each(["modify", "index", "manifest-readback"] as const)("retains recoverable state after a %s activation failure", async (failure) => {
    const { files, vault, sourceFile, versions, refresh, openFile } = createActivationFixture();
    const original = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "source-original", idLabel: `failure-original-${failure}`, label: "Personal note",
      mode: "monologue", body: "Original body.", activate: false,
    });
    const target = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: `failure-target-${failure}`, label: "Meeting",
      body: "Target body.", activate: false,
    });
    const folder = getVersionStoreFolder({ mdFolder: "QnALog/notes" }, getSourceIdFromMarkdown(sourceContent, sourceFile));
    const targetFile = files.get(`${folder}/${target.meta.fileName}`);
    const originalFile = files.get(`${folder}/${original.meta.fileName}`);
    if (!targetFile || !originalFile) throw new Error("Activation fixtures were not written");
    const manifestPath = `${folder}/manifest.json`;
    const manifestBefore = await vault.adapter.read(manifestPath);
    const sourceBefore = await vault.read(sourceFile);
    const cachedBefore = targetFile.data;
    const modify = vi.spyOn(vault, "modify");
    const originalAdapterRead = vault.adapter.read;
    const originalAdapterWrite = vault.adapter.write;
    const adapterRead = vi.spyOn(vault.adapter, "read");
    const adapterWrite = vi.spyOn(vault.adapter, "write");
    if (failure === "modify") {
      modify.mockRejectedValueOnce(new Error("modify denied"));
    } else if (failure === "index") {
      refresh.mockRejectedValueOnce(new Error("index denied"));
    } else {
      let manifestWriteCompleted = false;
      let postWriteManifestReads = 0;
      adapterWrite.mockImplementation(async (path, content) => {
        await originalAdapterWrite(path, content);
        if (path === manifestPath) manifestWriteCompleted = true;
      });
      adapterRead.mockImplementation(async (path) => {
        const actual = await originalAdapterRead(path);
        if (manifestWriteCompleted && path === manifestPath && ++postWriteManifestReads === 2) {
          return actual.replace(target.meta.id, "unexpected-active-id");
        }
        return actual;
      });
    }

    await expect(versions.switchVersion(targetFile, sourceFile.path)).rejects.toThrow(
      failure === "modify" ? "modify denied"
        : failure === "index" ? "index denied"
          : "Could not verify version metadata",
    );
    if (failure === "modify") {
      expect(await vault.read(sourceFile)).toBe(sourceBefore);
      expect(await vault.adapter.read(manifestPath)).toBe(manifestBefore);
    } else if (failure === "index") {
      expect(await vault.read(sourceFile)).toContain("Target body.");
      expect(JSON.parse(await vault.adapter.read(manifestPath)).activeVersionId).toBe("");
    } else {
      expect(await vault.read(sourceFile)).toContain("Target body.");
      expect(JSON.parse(await vault.adapter.read(manifestPath)).activeVersionId).toBe(target.meta.id);
    }
    expect(targetFile.data).toBe(cachedBefore);
    expect(openFile).not.toHaveBeenCalled();
    modify.mockRestore();
    adapterRead.mockRestore();
    adapterWrite.mockRestore();
    refresh.mockReset().mockResolvedValue(undefined);
    await versions.switchVersion(originalFile, sourceFile.path);
    expect(await vault.read(sourceFile)).toContain("Original body.");
    expect(openFile).toHaveBeenCalledWith(sourceFile);
  });
  it("serializes activations and inactive saves per source while independent sources complete", async () => {
    const { files, vault } = createMemoryVault();
    const sourceOne = new obsidian.TFile("QnALog/notes/lock-one.md", sourceContent);
    const sourceTwo = new obsidian.TFile("QnALog/notes/lock-two.md", sourceContent);
    files.set(sourceOne.path, sourceOne);
    files.set(sourceTwo.path, sourceTwo);
    const settings = { mdFolder: "QnALog/notes", promptTemplates: {} };
    const app = {
      vault,
      metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
      workspace: { getLeaf: () => ({ openFile: vi.fn(async () => undefined) }) },
    };
    let enteredResolve: () => void = () => undefined;
    let releaseResolve: () => void = () => undefined;
    let queuedResolve: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const threeCallsQueued = new Promise<void>((resolve) => { queuedResolve = resolve; });
    let sourceOneRefreshes = 0;
    const refresh = vi.fn(async (file: MemoryFile) => {
      if (file === sourceOne && ++sourceOneRefreshes === 1) {
        enteredResolve();
        await release;
      }
    });
    const versions = new VersionStore(makeVersionHost(app, () => settings, refresh));
    await versions.ensureOriginalVersionForSource(sourceOne);
    await versions.ensureOriginalVersionForSource(sourceTwo);
    const [a, b, c] = await Promise.all([
      versions.saveVersion(sourceOne, sourceContent, [], { kind: "minutes", idLabel: "lock-a", label: "A", body: "Body A.", activate: false }),
      versions.saveVersion(sourceOne, sourceContent, [], { kind: "minutes", idLabel: "lock-b", label: "B", body: "Body B.", activate: false }),
      versions.saveVersion(sourceTwo, sourceContent, [], { kind: "minutes", idLabel: "lock-c", label: "C", body: "Body C.", activate: false }),
    ]);
    const folderOne = getVersionStoreFolder(settings, getSourceIdFromMarkdown(sourceContent, sourceOne));
    const folderTwo = getVersionStoreFolder(settings, getSourceIdFromMarkdown(sourceContent, sourceTwo));
    const targetA = files.get(`${folderOne}/${a.meta.fileName}`);
    const targetB = files.get(`${folderOne}/${b.meta.fileName}`);
    const targetC = files.get(`${folderTwo}/${c.meta.fileName}`);
    if (!targetA || !targetB || !targetC) throw new Error("Lock fixtures were not written");
    const sourceOneId = getSourceIdFromMarkdown(sourceContent, sourceOne);
    const originalWithLock = versions.manifests.withLock.bind(versions.manifests);
    let sourceOneLockCalls = 0;
    vi.spyOn(versions.manifests, "withLock").mockImplementation((sourceId, operation) => {
      if (sourceId === sourceOneId && ++sourceOneLockCalls === 3) queuedResolve();
      return originalWithLock(sourceId, operation);
    });

    const switchA = versions.switchVersion(targetA, sourceOne.path);
    await entered;
    const switchB = versions.switchVersion(targetB, sourceOne.path);
    const saveD = versions.saveVersion(sourceOne, sourceContent, [], {
      kind: "minutes", idLabel: "lock-d", label: "D", body: "Body D.", activate: false,
    });
    await threeCallsQueued;
    await versions.switchVersion(targetC, sourceTwo.path);
    const manifestOnePath = `${folderOne}/manifest.json`;
    expect(await vault.read(sourceOne)).toContain("Body A.");
    expect(JSON.parse(await vault.adapter.read(manifestOnePath)).activeVersionId).toBe("");
    expect(JSON.parse(await vault.adapter.read(manifestOnePath)).versions.some((record: { id: string }) => record.id === "lock-d")).toBe(false);
    releaseResolve();
    const [, , savedD] = await Promise.all([switchA, switchB, saveD]);
    expect(await vault.read(sourceOne)).toContain("Body B.");
    expect(JSON.parse(await vault.adapter.read(manifestOnePath)).activeVersionId).toBe(b.meta.id);
    expect(files.get(`${folderOne}/${savedD.meta.fileName}`)?.data).toContain("Body D.");
    expect(JSON.parse(await vault.adapter.read(`${folderTwo}/manifest.json`)).activeVersionId).toBe(c.meta.id);
  });
  it("rejects a damaged original snapshot before modifying the source and succeeds after repair", async () => {
    const { files, vault, sourceFile, versions, openFile } = createActivationFixture();
    const originalPath = await versions.ensureOriginalVersionForSource(sourceFile);
    if (!originalPath) throw new Error("Original snapshot was not created");
    const target = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "snapshot-guard-target", label: "Meeting",
      body: "Target body.", activate: false,
    });
    const folder = getVersionStoreFolder({ mdFolder: "QnALog/notes" }, getSourceIdFromMarkdown(sourceContent, sourceFile));
    const targetFile = files.get(`${folder}/${target.meta.fileName}`);
    const originalFile = files.get(originalPath);
    if (!targetFile || !originalFile) throw new Error("Snapshot fixtures were not written");
    const sourceBefore = await vault.read(sourceFile);
    const targetBytes = targetFile.data;
    const originalBytes = originalFile.data;
    originalFile.data = originalBytes.replace(/source_id:.*$/m, 'source_id: "foreign-source"');

    await expect(versions.switchVersion(targetFile, sourceFile.path)).rejects.toThrow();

    expect(await vault.read(sourceFile)).toBe(sourceBefore);
    expect(targetFile.data).toBe(targetBytes);
    expect(originalFile.data).toContain('source_id: "foreign-source"');
    expect(openFile).not.toHaveBeenCalled();
    originalFile.data = originalBytes;
    await versions.switchVersion(targetFile, sourceFile.path);
    expect(await vault.read(sourceFile)).toContain("Target body.");
  });

  it("reads version caches and manifest confirmation through the current adapter", async () => {
    const { files, vault, sourceFile, settings, openFile, versions } = createActivationFixture();
    const saved = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "dynamic-adapter-target", label: "Meeting",
      body: "Target body.", activate: false,
    });
    const folder = getVersionStoreFolder(settings, getSourceIdFromMarkdown(sourceContent, sourceFile));
    const targetPath = `${folder}/${saved.meta.fileName}`;
    let activeAdapter = vault.adapter;
    Object.defineProperty(versions.host.vault, "adapter", {
      configurable: true,
      get: () => activeAdapter,
    });
    const oldAdapter = activeAdapter;
    oldAdapter.read = async () => { throw new Error("stale adapter used"); };
    activeAdapter = {
      exists: async (path) => files.has(path),
      read: async (path) => {
        const file = files.get(path);
        if (!file) throw new Error(`File not found: ${path}`);
        return file.data;
      },
      write: async (path, content) => {
        const file = files.get(path);
        if (file) file.data = content;
        else files.set(path, new obsidian.TFile(path, content));
      },
      mkdir: async () => undefined,
    };

    await versions.switchVersion(targetPath, sourceFile.path);

    expect(await vault.read(sourceFile)).toContain("Target body.");
    expect(JSON.parse(files.get(`${folder}/manifest.json`)?.data || "{}").activeVersionId).toBe(saved.meta.id);
    expect(openFile).toHaveBeenCalledWith(sourceFile);
  });

  it("uses the current custom mode name when activating a cached custom-mode version", async () => {
    setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
    const { files, vault, sourceFile, settings, versions } = createActivationFixture();
    const template = (name: string) => ({
      id: "custom-note", mode: "custom-note", name, prompt: "Fixture.",
      customMode: true, createdAt: "2026-10-06T15:00:00", updatedAt: "2026-10-06T15:00:00",
    });
    settings.promptTemplates = { "custom-note": template("Name A") };
    const saved = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "custom-mode-version", label: "Name A",
      mode: "custom-note", body: "Custom body.", activate: false,
    });
    const folder = getVersionStoreFolder(settings, getSourceIdFromMarkdown(sourceContent, sourceFile));
    const cached = files.get(`${folder}/${saved.meta.fileName}`);
    if (!cached) throw new Error("Custom mode cache was not written");
    const cachedBytes = cached.data;
    settings.promptTemplates = { "custom-note": template("Name B") };

    await versions.switchVersion(cached, sourceFile.path);

    expect(await vault.read(sourceFile)).toContain("· Name B");
    expect(await vault.read(sourceFile)).not.toContain("· Name A");
    expect(cached.data).toBe(cachedBytes);
  });


  it("keeps the written source body recoverable when updating activeVersionId fails", async () => {
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/source.md", sourceContent);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
    const folder = getVersionStoreFolder(settings, sourceId);
    const manifestPath = `${folder}/manifest.json`;
    const openFile = vi.fn();
    const app = {
      vault,
      metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
      workspace: { getLeaf: () => ({ openFile }) },
    };
    const versions = new VersionStore(makeVersionHost(app, () => settings, async () => undefined));
    const original = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "source-original",
      idLabel: "source-original",
      label: "Personal note",
      mode: "monologue",
      body: "Personal text A.",
      activate: false,
    });
    const target = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes",
      idLabel: "meeting",
      label: "Meeting",
      body: "Meeting version B.",
      activate: false,
    });
    const targetFile = files.get(`${folder}/${target.meta.fileName}`);
    if (!targetFile) throw new Error("Target version cache was not written");
    const originalAdapterWrite = vault.adapter.write;
    const failManifestWrite = vi.spyOn(vault.adapter, "write").mockImplementation(async (path, content) => {
      if (path === manifestPath) throw new Error("Simulated active-version manifest write failure");
      await originalAdapterWrite(path, content);
    });

    await expect(versions.switchVersion(targetFile, sourceFile.path)).rejects.toThrow("Simulated active-version manifest write failure");
    expect(await vault.read(sourceFile)).toContain("Meeting version B.");
    failManifestWrite.mockRestore();
    await versions.switchVersion(original.meta ? files.get(`${folder}/${original.meta.fileName}`)! : sourceFile, sourceFile.path);
    expect(await vault.read(sourceFile)).toContain("Personal text A.");
    expect(openFile).toHaveBeenCalledWith(sourceFile);
  });
  it.each([
    ["en", "Work notes", "Preference"],
    ["zh", "工作纪要", "Preference"],
  ] as const)("shows localized repolish progress and completion in %s without changing source data", async (language, displayName, preferenceLabel) => {
    setActiveUiLanguage(resolveUiLanguage(language, language));
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/localized-repolish.md", "");
    const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
    const sourceBefore = ensureTranscriptBlocks(sourceContent, sourceId);
    sourceFile.data = sourceBefore;
    files.set(sourceFile.path, sourceFile);
    const media = new obsidian.TFile("QnALog/录音/localized-repolish.wav", "fixture audio bytes");
    files.set(media.path, media);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const app = {
      vault,
      metadataCache: { getFileCache: () => ({ frontmatter: {
        qnalog_time: "2026-09-29T21:49:00",
        qnalog_mode: "meeting",
        qnalog_participants: ["Alias → Real"],
      } }) },
      workspace: { getLeaf: () => ({ openFile: vi.fn(async () => undefined) }) },
    };
    const noteIndex = { refreshNoteIndexSafely: vi.fn(async () => undefined) };
    const versions = new VersionStore(makeVersionHost(app, () => settings, noteIndex.refreshNoteIndexSafely));
    const tasks = new TaskActivityService({ settings } as never);
    tasks.taskActivityStore = new TaskActivityStore();
    tasks.completedWorkLog = [];
    const service = new RepolishService({ app, settings, tasks, versions, noteIndex, requestOutlineRefresh: vi.fn() } as never);
    let resolveModel: (body: string) => void = () => undefined;
    mergeAndPolishMock.mockReturnValue(new Promise<string>((resolve) => { resolveModel = resolve; }));

    const pending = service.repolishMarkdownFile(sourceFile, "meeting", { label: preferenceLabel });
    await vi.waitFor(() => expect(mergeAndPolishMock).toHaveBeenCalledOnce());
    const running = tasks.getTaskActivities().find((activity) => activity.id === `repolish:${sourceId}`);
    expect(running?.status).toBe("running");
    expect(running?.title).toContain(displayName);
    expect(tasks._busyLabel).toContain(displayName);
    expect(tasks._busyContext.sourceModeLabel).toBe(displayName);
    expect(tasks._busyContext.targetModeLabel).toBe(`${displayName} · ${preferenceLabel}`);
    expect(notices[0]).toContain(displayName);
    expect(notices[0]).toContain(language === "en" ? "1 role mappings" : "1 条角色映射");

    resolveModel("Localized derived body.");
    await pending;

    const completed = tasks.getTaskActivities().find((activity) => activity.id === `repolish:${sourceId}`);
    expect(completed?.status).toBe("done");
    expect(completed?.title).toContain(displayName);
    expect(tasks.completedWorkLog[0]?.title).toContain(displayName);
    expect(notices.slice(1).some((message) => message.includes(displayName))).toBe(true);
    expect(await vault.read(sourceFile)).toBe(sourceBefore);
    expect(media.data).toBe("fixture audio bytes");
    const derived = [...files.values()].find((candidate) => candidate.path !== sourceFile.path
      && candidate.path.startsWith(`${sourceFile.parent.path}/`) && !candidate.path.includes("/.versions/")
      && candidate.data.includes("Localized derived body."));
    expect(derived).toBeDefined();
    const manifestPath = `${getVersionStoreFolder(settings, sourceId)}/manifest.json`;
    const manifest = JSON.parse(await vault.adapter.read(manifestPath));
    expect(manifest.versions.some((record: { kind: string; mode: string; style: string; label: string }) =>
      record.kind === "minutes" && record.mode === "meeting" && record.style === "Preference"
      && record.label === (language === "en" ? "Work notes · Preference" : "工作纪要 · Preference"))).toBe(true);
  });

  it("keeps the custom mode explanation visible in repolish task UI", async () => {
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/custom-repolish.md", "");
    const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
    const sourceBefore = ensureTranscriptBlocks(sourceContent, sourceId);
    sourceFile.data = sourceBefore;
    files.set(sourceFile.path, sourceFile);
    const settings = {
      mdFolder: "QnALog/转写纪要",
      promptTemplates: {
        "custom-output": {
          id: "custom-output", mode: "custom-output", customMode: true,
          name: "My template", baseMode: "meeting", prompt: "Custom prompt fixture.",
        },
      },
    };
    const app = {
      vault,
      metadataCache: { getFileCache: () => ({ frontmatter: { qnalog_mode: "meeting" } }) },
      workspace: { getLeaf: () => ({ openFile: vi.fn(async () => undefined) }) },
    };
    const noteIndex = { refreshNoteIndexSafely: vi.fn(async () => undefined) };
    const versions = new VersionStore(makeVersionHost(app, () => settings, noteIndex.refreshNoteIndexSafely));
    const tasks = new TaskActivityService({ settings } as never);
    tasks.taskActivityStore = new TaskActivityStore();
    tasks.completedWorkLog = [];
    const service = new RepolishService({ app, settings, tasks, versions, noteIndex, requestOutlineRefresh: vi.fn() } as never);
    let resolveModel: (body: string) => void = () => undefined;
    mergeAndPolishMock.mockReturnValue(new Promise<string>((resolve) => { resolveModel = resolve; }));

    const pending = service.repolishMarkdownFile(sourceFile, "custom-output", { label: "Concise" });
    await vi.waitFor(() => expect(mergeAndPolishMock).toHaveBeenCalledOnce());
    expect(tasks._busyLabel).toContain("Custom prompt:My template");
    expect(tasks._busyContext.targetModeLabel).toBe("Custom prompt:My template · Concise");
    expect(tasks.getTaskActivities()[0]?.title).toContain("Custom prompt:My template");
    expect(notices[0]).toContain("Custom prompt:My template");
    resolveModel("Custom derived body.");
    await pending;
    expect(tasks.completedWorkLog[0]?.title).toContain("Custom prompt:My template");
    expect(notices.some((message) => message.includes("Custom prompt:My template") && message.includes("derived minutes"))).toBe(true);
    expect(await vault.read(sourceFile)).toBe(sourceBefore);
    expect([...files.values()].some((candidate) => candidate.data.includes("Custom derived body."))).toBe(true);
  });

  it("keeps repolish visibly failed and preserves the source when the model rejects", async () => {
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/failed-repolish.md", "");
    const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
    const sourceBefore = ensureTranscriptBlocks(sourceContent, sourceId);
    sourceFile.data = sourceBefore;
    files.set(sourceFile.path, sourceFile);
    const media = new obsidian.TFile("QnALog/录音/failed-repolish.wav", "preserved audio bytes");
    files.set(media.path, media);
    const settings = { mdFolder: "QnALog/转写纪要" };
    const app = {
      vault,
      metadataCache: { getFileCache: () => ({ frontmatter: { qnalog_mode: "meeting" } }) },
      workspace: { getLeaf: () => ({ openFile: vi.fn(async () => undefined) }) },
    };
    const noteIndex = { refreshNoteIndexSafely: vi.fn(async () => undefined) };
    const versions = new VersionStore(makeVersionHost(app, () => settings, noteIndex.refreshNoteIndexSafely));
    const tasks = new TaskActivityService({ settings } as never);
    tasks.taskActivityStore = new TaskActivityStore();
    tasks.completedWorkLog = [];
    const service = new RepolishService({ app, settings, tasks, versions, noteIndex, requestOutlineRefresh: vi.fn() } as never);
    mergeAndPolishMock.mockRejectedValue(new Error("Model request failed"));

    await service.repolishMarkdownFile(sourceFile, "meeting");

    const failed = tasks.getTaskActivities().find((activity) => activity.id === `repolish:${sourceId}`);
    expect(failed?.status).toBe("failed");
    expect(failed?.stage).toBe("failed");
    expect(tasks.completedWorkLog).toHaveLength(0);
    expect(notices.some((message) => message.includes("Re-organize failed") && message.includes("Model request failed"))).toBe(true);
    expect(await vault.read(sourceFile)).toBe(sourceBefore);
    expect(media.data).toBe("preserved audio bytes");
    expect([...files.values()].some((candidate) => candidate.path !== sourceFile.path
      && candidate.data.includes('variant_kind: "minutes"'))).toBe(false);
  });
  it("shares same-source snapshot work without blocking another source", async () => {
    const { files, vault } = createMemoryVault();
    const settings = { mdFolder: "QnALog/notes" };
    const textFor = (id: string, body: string) => sourceContent
      .replace("First generated minutes must stay visible.", body)
      .concat(`\n\n<!-- qnalog-session:${id} -->`);
    const sourceA = new obsidian.TFile("QnALog/notes/source-a.md", textFor("s1", "Source A body."));
    const sourceB = new obsidian.TFile("QnALog/notes/source-b.md", textFor("s2", "Source B body."));
    const sourceABefore = sourceA.data;
    const sourceBBefore = sourceB.data;
    files.set(sourceA.path, sourceA);
    files.set(sourceB.path, sourceB);
    const sourceIdA = getSourceIdFromMarkdown(sourceA.data, sourceA);
    const sourceIdB = getSourceIdFromMarkdown(sourceB.data, sourceB);
    const folderA = getVersionStoreFolder(settings, sourceIdA);
    const manifestPathA = `${folderA}/manifest.json`;
    const seed = {
      version: 1,
      sourceId: sourceIdA,
      activeVersionId: "prior",
      unknown: { nested: ["preserve"] },
      versions: [],
    };
    await vault.adapter.write(manifestPathA, JSON.stringify(seed));
    let enterRead: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { enterRead = resolve; });
    let releaseRead: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { releaseRead = resolve; });
    let shouldBlock = true;
    const originalRead = vault.adapter.read;
    vi.spyOn(vault.adapter, "read").mockImplementation(async (path) => {
      if (path === manifestPathA && shouldBlock) {
        shouldBlock = false;
        enterRead();
        await blocked;
      }
      return originalRead(path);
    });
    const versions = new VersionStore(makeVersionHost(
      { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
      () => settings,
    ));

    const first = versions.ensureOriginalVersionForSource(sourceA);
    await entered;
    const second = versions.ensureOriginalVersionForSource(sourceA);
    const independent = await versions.ensureOriginalVersionForSource(sourceB);
    releaseRead();
    const [pathA1, pathA2] = await Promise.all([first, second]);

    expect(pathA1).toBe(pathA2);
    expect(independent).toBeTruthy();
    expect(independent).not.toBe(pathA1);
    const manifest = JSON.parse(await originalRead(manifestPathA));
    expect(manifest.versions.filter((record: { kind: string }) => record.kind === "source-original")).toHaveLength(1);
    expect(manifest.activeVersionId).toBe("prior");
    expect(manifest.unknown).toEqual(seed.unknown);
    expect(await vault.read(sourceA)).toBe(sourceABefore);
    expect(await vault.read(sourceB)).toBe(sourceBBefore);
    expect(files.get(pathA1!)?.data).toContain("Source A body.");
    expect(files.get(pathA1!)?.data).not.toContain("Original ASR transcript.");
    expect(files.get(independent!)?.data).toContain("Source B body.");
  });

  it("shares a failed snapshot write and allows a fresh retry", async () => {
    const { files, vault } = createMemoryVault();
    const sourceText = sourceContent.replace("First generated minutes must stay visible.", "Recoverable source body.");
    const sourceFile = new obsidian.TFile("QnALog/notes/retry.md", sourceText);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/notes" };
    const manifestPath = `${getVersionStoreFolder(settings, getSourceIdFromMarkdown(sourceText, sourceFile))}/manifest.json`;
    let enterWrite: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { enterWrite = resolve; });
    let rejectWrite: () => void = () => undefined;
    const blocked = new Promise<void>((_resolve, reject) => { rejectWrite = () => reject(new Error("disk denied")); });
    let failOnce = true;
    const originalWrite = vault.adapter.write;
    vi.spyOn(vault.adapter, "write").mockImplementation(async (path, content) => {
      if (path === manifestPath && failOnce) {
        failOnce = false;
        enterWrite();
        await blocked;
      }
      await originalWrite(path, content);
    });
    const versions = new VersionStore(makeVersionHost(
      { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
      () => settings,
    ));

    const first = versions.ensureOriginalVersionForSource(sourceFile);
    await entered;
    const second = versions.ensureOriginalVersionForSource(sourceFile);
    rejectWrite();
    await expect(first).rejects.toThrow("disk denied");
    await expect(second).rejects.toThrow("disk denied");
    const orphan = [...files.values()].find((file) => file.data.includes('variant_kind: "source-original"'));
    if (!orphan) throw new Error("Failed original cache was not retained");
    const orphanBytes = orphan.data;
    expect(await vault.adapter.exists(manifestPath)).toBe(false);
    expect(await vault.read(sourceFile)).toBe(sourceText);

    const retryPath = await versions.ensureOriginalVersionForSource(sourceFile);
    expect(retryPath).not.toBe(orphan.path);
    expect(orphan.data).toBe(orphanBytes);
    const manifest = JSON.parse(await vault.adapter.read(manifestPath));
    expect(manifest.versions.filter((record: { kind: string }) => record.kind === "source-original")).toHaveLength(1);
    expect(await vault.read(sourceFile)).toBe(sourceText);
  });

  it.each([
    ["filename with forward slash", (manifest: Record<string, unknown>, cache: string) => {
      (manifest.versions as Array<Record<string, unknown>>)[0].fileName = "../escape.md";
      return cache;
    }],
    ["filename with backslash", (manifest: Record<string, unknown>, cache: string) => {
      (manifest.versions as Array<Record<string, unknown>>)[0].fileName = "..\\\\escape.md";
      return cache;
    }],
    ["version id", (manifest: Record<string, unknown>, cache: string) => cache.replace(/version_id: \"[^\"]+\"/, 'version_id: \"foreign\"')],
    ["variant kind", (manifest: Record<string, unknown>, cache: string) => cache.replace('variant_kind: \"source-original\"', 'variant_kind: \"minutes\"')],
    ["source id", (manifest: Record<string, unknown>, cache: string) => cache.replace(/source_id: \"[^\"]+\"/, 'source_id: \"foreign\"')],
    ["source path", (manifest: Record<string, unknown>, cache: string) => cache.replace(/qnalog_source_path: \"[^\"]+\"/, 'qnalog_source_path: \"elsewhere.md\"')],
    ["cache type", (manifest: Record<string, unknown>, cache: string) => cache.replace("qnalog_type: QnALog版本缓存", "qnalog_type: wrong")],
    ["empty cache body", (_manifest: Record<string, unknown>, cache: string) => cache.replace("Identity source body.", "")],
  ] as const)("rejects a corrupted original snapshot identity: %s", async (_case, corrupt) => {
    const { files, vault } = createMemoryVault();
    const sourceText = sourceContent.replace("First generated minutes must stay visible.", "Identity source body.");
    const sourceFile = new obsidian.TFile("QnALog/notes/identity.md", sourceText);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/notes" };
    const versions = new VersionStore(makeVersionHost(
      { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
      () => settings,
    ));
    const snapshotPath = await versions.ensureOriginalVersionForSource(sourceFile);
    if (!snapshotPath) throw new Error("Original snapshot was not created");
    const sourceId = getSourceIdFromMarkdown(sourceText, sourceFile);
    const manifestPath = `${getVersionStoreFolder(settings, sourceId)}/manifest.json`;
    const manifest = JSON.parse(await vault.adapter.read(manifestPath));
    const cache = files.get(snapshotPath)?.data;
    if (cache === undefined) throw new Error("Original cache was not written");
    const nextCache = corrupt(manifest, cache);
    if (nextCache !== cache) files.get(snapshotPath)!.data = nextCache;
    await vault.adapter.write(manifestPath, JSON.stringify(manifest));
    const before = new Map([...files].map(([path, file]) => [path, file.data]));

    expect(await versions.findOriginalVersionForSource(sourceFile)).toBeNull();
    await expect(versions.ensureOriginalVersionForSource(sourceFile)).rejects.toThrow("Could not read version metadata");
    expect(new Map([...files].map(([path, file]) => [path, file.data]))).toEqual(before);
    expect(await vault.read(sourceFile)).toBe(sourceText);
  });

  it("does not fall back from a corrupt original to pre-clean, but reuses a valid pre-clean alone", async () => {
    for (const includeOriginal of [true, false]) {
      const { files, vault } = createMemoryVault();
      const sourceText = sourceContent.replace("First generated minutes must stay visible.", "Pre-clean recovery body.");
      const sourceFile = new obsidian.TFile(`QnALog/notes/pre-clean-${includeOriginal}.md`, sourceText);
      files.set(sourceFile.path, sourceFile);
      const settings = { mdFolder: "QnALog/notes" };
      const versions = new VersionStore(makeVersionHost(
        { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
        () => settings,
      ));
      const sourceId = getSourceIdFromMarkdown(sourceText, sourceFile);
      const originalPath = includeOriginal ? await versions.ensureOriginalVersionForSource(sourceFile) : null;
      const preClean = await versions.saveVersion(sourceFile, sourceText, [], {
        kind: "pre-clean", idLabel: "pre-clean", label: "Pre-clean", body: "Pre-clean body.", activate: false,
      });
      const folder = getVersionStoreFolder(settings, sourceId);
      if (includeOriginal) {
        const originalCache = files.get(originalPath!);
        if (!originalCache) throw new Error("Original cache was not written");
        originalCache.data = originalCache.data.replace(/source_id: \"[^\"]+\"/, 'source_id: \"foreign\"');
        expect(await versions.findOriginalVersionForSource(sourceFile)).toBeNull();
        await expect(versions.ensureOriginalVersionForSource(sourceFile)).rejects.toThrow("Could not read version metadata");
      } else {
        const reused = await versions.ensureOriginalVersionForSource(sourceFile);
        expect(reused).toBe(`${folder}/${preClean.meta.fileName}`);
      }
    }
  });

  it("rejects a saved snapshot when final metadata points to another valid cache", async () => {
    const { files, vault } = createMemoryVault();
    const sourceText = sourceContent.replace("First generated minutes must stay visible.", "Verified path source body.");
    const sourceFile = new obsidian.TFile("QnALog/notes/verify-path.md", sourceText);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/notes" };
    const sourceId = getSourceIdFromMarkdown(sourceText, sourceFile);
    const folder = getVersionStoreFolder(settings, sourceId);
    const manifestPath = `${folder}/manifest.json`;
    const originalWrite = vault.adapter.write;
    let redirected = false;
    vi.spyOn(vault.adapter, "write").mockImplementation(async (path, content) => {
      if (path === manifestPath && !redirected) {
        const manifest = JSON.parse(content);
        const record = manifest.versions.find((item: { kind: string }) => item.kind === "source-original");
        if (record) {
          const savedPath = `${folder}/${record.fileName}`;
          const savedCache = files.get(savedPath);
          if (!savedCache) throw new Error("Saved original cache was not written");
          const redirectedPath = `${folder}/redirected-original.md`;
          files.set(redirectedPath, new obsidian.TFile(redirectedPath, savedCache.data));
          record.fileName = "redirected-original.md";
          redirected = true;
          content = JSON.stringify(manifest, null, 2);
        }
      }
      await originalWrite(path, content);
    });
    const versions = new VersionStore(makeVersionHost(
      { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
      () => settings,
    ));

    await expect(versions.ensureOriginalVersionForSource(sourceFile)).rejects.toThrow("Could not verify version metadata");
    expect(redirected).toBe(true);
    expect(await vault.read(sourceFile)).toBe(sourceText);
    expect(files.get(`${folder}/redirected-original.md`)?.data).toContain("Verified path source body.");
    expect([...files.values()].filter((file) => file.data.includes('variant_kind: "source-original"'))).toHaveLength(2);
  });

  it("does not write an original snapshot for raw-only source notes", async () => {
    const { files, vault } = createMemoryVault();
    const rawOnly = sourceContent.replace("First generated minutes must stay visible.", "")
      .replace("Original ASR transcript.", "Only raw evidence.");
    const sourceFile = new obsidian.TFile("QnALog/notes/raw-only.md", rawOnly);
    files.set(sourceFile.path, sourceFile);
    const settings = { mdFolder: "QnALog/notes" };
    const versions = new VersionStore(makeVersionHost(
      { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
      () => settings,
    ));

    expect(await versions.ensureOriginalVersionForSource(sourceFile)).toBeNull();
    expect([...files.values()].some((file) => file.data.includes('variant_kind: "source-original"'))).toBe(false);
    expect(await vault.read(sourceFile)).toBe(rawOnly);
  });

  describe("derived note persistence boundary", () => {
    function fixture(refreshIndex?: VersionStoreHost["refreshNoteIndexSafely"]) {
      const { files, vault } = createMemoryVault();
      const sourceFile = new obsidian.TFile("QnALog/notes/source.md", sourceContent);
      files.set(sourceFile.path, sourceFile);
      const app = {
        vault,
        metadataCache: {
          getFileCache: (file: MemoryFile) => {
            const parts = file.data.split("---");
            const yaml = parts.length > 2 ? parts[1] : "";
            return { frontmatter: obsidian.parseYaml(yaml) as Record<string, unknown> };
          },
        },
      };
      const versions = new VersionStore(makeVersionHost(app, () => ({ mdFolder: "QnALog/notes" }), refreshIndex));
      const version = (body: string, kind = "clean") => ({
        meta: { sourceId: getSourceIdFromMarkdown(sourceContent, sourceFile), kind, createdAt: "2026-10-06T15:00:00" },
        frontmatter: "",
        body,
      });
      return { files, vault, sourceFile, versions, version };
    }

    it("reuses an owned clean copy, preserves source materials, and allocates around an unrelated note", async () => {
      const { files, vault, sourceFile, versions, version } = fixture(async () => undefined);
      const originalSource = sourceFile.data;
      const cleanA = await versions.createDerivedNote(sourceFile, sourceFile.data, version("Body A."), "Clean", "cleanscript");
      if (!cleanA) throw new Error("Clean note was not created");
      const path = cleanA.path;
      const cleanB = await versions.createDerivedNote(sourceFile, sourceFile.data, version("Body B."), "Clean", "cleanscript");

      expect(cleanB).toBe(cleanA);
      expect(cleanA.data).toContain("Body B.");
      expect(files.get(sourceFile.path)?.data).toBe(originalSource);
      expect(sourceFile.data).toContain("Original ASR transcript.");
      files.delete(cleanA.path);

      const unrelated = new obsidian.TFile("QnALog/notes/【Other】source.md", "User-owned note.");
      files.set(unrelated.path, unrelated);
      const userAtTarget = new obsidian.TFile("QnALog/notes/【User】source.md", "Preserve this note.");
      files.set(userAtTarget.path, userAtTarget);
      const allocated = await versions.createDerivedNote(sourceFile, sourceFile.data, version("Clean body.", "clean"), "User", "cleanscript");
      expect(allocated?.path).toBe("QnALog/notes/【User】source-2.md");
      expect(userAtTarget.data).toBe("Preserve this note.");

      const ordinaryAtStable = new obsidian.TFile("QnALog/notes/【Replace】source.md", "Replace under existing ordinary-kind policy.");
      files.set(ordinaryAtStable.path, ordinaryAtStable);
      const replaced = await versions.createDerivedNote(sourceFile, sourceFile.data, version("Replacement body.", "minutes"), "Replace", "meeting");
      expect(replaced).toBe(ordinaryAtStable);
      expect(ordinaryAtStable.data).toContain("Replacement body.");
      expect(await vault.read(sourceFile)).toBe(originalSource);
    });

    it("retains written derived content after index failure and can retry through current vault capabilities", async () => {
      let failIndex = true;
      const { files, vault, sourceFile, versions, version } = fixture(async () => {
        if (failIndex) throw new Error("index denied");
      });
      await expect(versions.createDerivedNote(sourceFile, sourceFile.data, version("Recoverable body."), "Clean", "cleanscript"))
        .rejects.toThrow("index denied");
      const stablePath = "QnALog/notes/【Clean】source.md";
      const persisted = files.get(stablePath);
      expect(persisted?.data).toContain("Recoverable body.");
      expect(await vault.read(sourceFile)).toBe(sourceContent);

      failIndex = false;
      const originalLookup = vault.getAbstractFileByPath;
      const originalCreate = vault.create;
      const originalModify = vault.modify;
      let lookups = 0;
      let modifications = 0;
      vault.getAbstractFileByPath = (path) => {
        lookups++;
        return originalLookup(path);
      };
      vault.create = (path, content) => originalCreate(path, content);
      vault.modify = async (file, content) => {
        modifications++;
        await originalModify(file, content);
      };
      const result = await versions.createDerivedNote(sourceFile, sourceFile.data, version("Retry body."), "Clean", "cleanscript");
      expect(result?.path).toBe(stablePath);
      expect(result?.data).toContain("Retry body.");
      expect(lookups).toBeGreaterThan(0);
      expect(modifications).toBe(1);
    });

    it("propagates modify failures without replacing the existing clean note", async () => {
      const { files, vault, sourceFile, versions, version } = fixture(async () => undefined);
      const original = await versions.createDerivedNote(sourceFile, sourceFile.data, version("Original clean."), "Clean", "cleanscript");
      if (!original) throw new Error("Clean note was not created");
      const priorBytes = original.data;
      const modify = vault.modify;
      vault.modify = async () => { throw new Error("modify denied"); };
      await expect(versions.createDerivedNote(sourceFile, sourceFile.data, version("Rejected replacement."), "Clean", "cleanscript"))
        .rejects.toThrow("modify denied");
      expect(files.get(original.path)?.data).toBe(priorBytes);
      vault.modify = modify;
      await expect(versions.createDerivedNote(sourceFile, sourceFile.data, version("Successful retry."), "Clean", "cleanscript"))
        .resolves.toBe(original);
      expect(original.data).toContain("Successful retry.");
    });

    it("selects the newest indexed same-folder clean copy and exposes it through RepolishService", async () => {
      const { files, vault, sourceFile, versions } = fixture(async () => undefined);
      const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
      const makeCandidate = (path: string, mtime: number, id = sourceId) => {
        const file = new obsidian.TFile(path, [
          "---",
          'variant_kind: "clean"',
          `source_id: "${id}"`,
          'qnalog_type: "QnALog派生版本"',
          "qnalog_contains_raw: false",
          "---",
          "Clean copy.",
        ].join("\n"));
        file.stat = { ctime: mtime, mtime, size: file.data.length };
        files.set(path, file);
        return file;
      };
      const newest = makeCandidate("QnALog/notes/z-clean.md", 10);
      const tiedPathFirst = makeCandidate("QnALog/notes/a-clean.md", 10);
      makeCandidate("QnALog/other/unrelated.md", 999);
      const service = new RepolishService({
        app: { vault },
        versions,
        settings: {},
        tasks: {},
        noteIndex: {},
        requestOutlineRefresh: () => undefined,
      } as never);

      expect(versions.findDerivedNoteForSource(sourceFile, sourceId, "clean")).toBe(tiedPathFirst);
      expect(newest.path).toBe("QnALog/notes/z-clean.md");
      await expect(service.findCleanCopy(sourceFile)).resolves.toBe(tiedPathFirst);

      files.delete(tiedPathFirst.path);
      expect(versions.findDerivedNoteForSource(sourceFile, sourceId, "clean")).toBe(newest);
      files.delete(newest.path);
      const canonicalName = makeCandidate("QnALog/notes/【Old label】source.md", 1, "stale-source-id");
      expect(versions.findDerivedNoteForSource(sourceFile, sourceId, "clean")).toBe(canonicalName);
    });

    it("recovers a clean-note creation race without overwriting a foreign contender", async () => {
      const { files, vault, sourceFile, versions, version } = fixture(async () => undefined);
      const originalCreate = vault.create;
      const contenderPath = "QnALog/notes/【Clean】source.md";
      const contender = new obsidian.TFile(contenderPath, "User bytes remain.");
      let first = true;
      vault.create = async (path, content) => {
        if (first) {
          first = false;
          files.set(path, contender);
          throw new Error("create denied");
        }
        return originalCreate(path, content);
      };
      const created = await versions.createDerivedNote(sourceFile, sourceFile.data, version("Race-safe body."), "Clean", "cleanscript");
      expect(created?.path).toBe("QnALog/notes/【Clean】source-2.md");
      expect(files.get(contenderPath)?.data).toBe("User bytes remain.");
      expect(created?.data).toContain("Race-safe body.");
    });
    it("merges version frontmatter before derived fields and preserves source metadata on invalid YAML", async () => {
      const { files, sourceFile, versions, version } = fixture(async () => undefined);
      const merged = await versions.createDerivedNote(
        sourceFile,
        sourceFile.data,
        {
          ...version("# Existing heading\n\nBody."),
          frontmatter: "---\nqnalog_custom: from-version\nvariant_kind: wrong\n---\n",
        },
        "Clean",
        "cleanscript",
      );
      if (!merged) throw new Error("Merged derived note was not created");
      expect(merged.data).toContain('qnalog_custom: "from-version"');
      expect(merged.data).toContain('variant_kind: "clean"');
      expect(merged.data).toContain("# Existing heading");
      expect(merged.data.match(/^# /gm)).toHaveLength(1);

      files.delete(merged.path);
      const malformed = await versions.createDerivedNote(
        sourceFile,
        sourceFile.data,
        { ...version("Body after invalid YAML."), frontmatter: "---\nmalformed: [\n---\n" },
        "Clean",
        "cleanscript",
      );
      if (!malformed) throw new Error("Derived note with invalid version YAML was not created");
      expect(malformed.data).toContain('qnalog_custom: "keep-me"');
      expect(malformed.data).toContain("Body after invalid YAML.");
    });
    it("preserves every occupied path when clean-name allocation is exhausted", async () => {
      let indexCalls = 0;
      const { files, sourceFile, versions, version } = fixture(async () => {
        indexCalls++;
      });
      const stable = "QnALog/notes/【Clean】source.md";
      for (let suffix = 1; suffix <= 99; suffix++) {
        const path = suffix === 1 ? stable : `QnALog/notes/【Clean】source-${suffix}.md`;
        files.set(path, new obsidian.TFile(path, `occupied-${suffix}`));
      }
      const before = [...files.values()].map((file) => [file.path, file.data]);
      await expect(versions.createDerivedNote(sourceFile, sourceFile.data, version("No path."), "Clean", "cleanscript"))
        .rejects.toThrow("Failed to generate a path for the derived minutes file");
      expect([...files.values()].map((file) => [file.path, file.data])).toEqual(before);
      expect(indexCalls).toBe(0);
    });
  });
});
