import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSourceIdFromMarkdown, getVersionStoreFolder } from "../src/notes/note-markdown";

const { cleanTranscriptMock, mergeAndPolishMock } = vi.hoisted(() => ({
  cleanTranscriptMock: vi.fn(),
  mergeAndPolishMock: vi.fn(),
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
    TFolder: class TFolder {},
    Notice: class Notice {},
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
import { cleanTranscript } from "../src/briefing/merge-pipeline";
import { mergeAndPolish } from "../src/briefing/merge-pipeline";
import { RepolishService } from "../src/notes/repolish-service";
import { VersionStore } from "../src/versions/version-store";

type MemoryFile = InstanceType<typeof obsidian.TFile>;

function createMemoryVault() {
  const files = new Map<string, MemoryFile>();
  const unindexedFiles = new Set<string>();
  const folders = new Set<string>();
  const vault = {
    getAbstractFileByPath: (path: string) => !unindexedFiles.has(path) ? files.get(path) || (folders.has(path) ? { path } : null) : null,
    getMarkdownFiles: () => [...files.values()].filter((file) => !unindexedFiles.has(file.path)),
    createFolder: async (path: string) => { folders.add(path); return { path }; },
    read: async (file: MemoryFile) => file.data,
    cachedRead: async (file: MemoryFile) => file.data,
    modify: async (file: MemoryFile, content: string) => { file.data = content; return file; },
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



beforeEach(() => {
  vi.stubGlobal("window", {});
  cleanTranscriptMock.mockReset().mockResolvedValue({ text: "Readable cleaned transcript.", truncated: false });
  mergeAndPolishMock.mockReset();
});

describe("clean transcript storage", () => {
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
    const versions = new VersionStore({ app, settings, noteIndex } as never);
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
    const versions = new VersionStore({ app, settings, noteIndex: cleanNoteIndex } as never);
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
    const versions = new VersionStore({ app, settings, noteIndex } as never);
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
  it("saves and exposes a personal-note original when a synthesis version is generated", async () => {
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
    const versions = new VersionStore({ app, settings, noteIndex } as never);
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
    const versions = new VersionStore({ app, settings: { mdFolder: "QnALog/转写纪要" }, noteIndex: {} } as never);
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
    const versions = new VersionStore({ app, settings, noteIndex: {} } as never);
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
    const versions = new VersionStore({
      app,
      settings: { mdFolder: "QnALog/转写纪要" },
      noteIndex: { refreshNoteIndexSafely: vi.fn(async () => undefined) },
    } as never);
    const malformed = new obsidian.TFile(
      "QnALog/转写纪要/.versions/source/untyped.md",
      `---\nversion_id: "untyped"\nvariant_label: "Invalid"\nqnalog_source_path: "${sourceFile.path}"\nsource_id: "${getSourceIdFromMarkdown(sourceContent, sourceFile)}"\n---\n\nMust not replace the source.`,
    );
    files.set(malformed.path, malformed);
    const original = await vault.read(sourceFile);

    await expect(versions.switchVersion(malformed, sourceFile.path)).rejects.toThrow("Could not read version metadata");
    expect(await vault.read(sourceFile)).toBe(original);
  });
  it("serializes simultaneous version saves without replacing the original or active version", async () => {
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
    const versions = new VersionStore({ app, settings, noteIndex: {} } as never);
    const previous = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes",
      idLabel: "previous-minutes",
      label: "Previous",
      body: "Previous version.",
      activate: true,
    });
    const original = await versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "source-original",
      idLabel: "source-original",
      label: "Personal note",
      mode: "monologue",
      body: "Personal text A.",
      activate: false,
    });

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
      return files.get(path)?.data || "";
    });
    const saveOne = versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "minutes", label: "Meeting", body: "Minutes A.", activate: false,
    });
    await manifestReadEntered;
    const saveTwo = versions.saveVersion(sourceFile, sourceContent, [], {
      kind: "minutes", idLabel: "minutes", label: "Meeting", body: "Minutes B.", activate: false,
    });
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
      const versions = new VersionStore({
        app: { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
        settings,
        noteIndex: {},
      } as never);

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
    const versions = new VersionStore({
      app: { vault, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } },
      settings,
      noteIndex: {},
    } as never);

    await expect(versions.ensureOriginalVersionForSource(sourceFile)).rejects.toThrow("Could not verify version metadata");

    expect(await vault.read(sourceFile)).toBe(originalContent);
    expect(await vault.adapter.exists(manifestPath)).toBe(false);
    const orphan = [...files.values()].find((file) => file.data.includes('variant_kind: "source-original"'));
    expect(orphan?.data).toContain("Personal text that must remain unchanged.");
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
    const versions = new VersionStore({
      app,
      settings,
      noteIndex: { refreshNoteIndexSafely: vi.fn(async () => undefined) },
    } as never);
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
});
