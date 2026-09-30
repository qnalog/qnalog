import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSourceIdFromMarkdown, getVersionStoreFolder } from "../src/notes/note-markdown";

const { cleanTranscriptMock } = vi.hoisted(() => ({ cleanTranscriptMock: vi.fn() }));


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
    parseYaml: () => ({}),
  };
});

vi.mock("../src/briefing/merge-pipeline", () => ({
  cleanTranscript: cleanTranscriptMock,
  mergeAndPolish: vi.fn(),
}));

import * as obsidian from "obsidian";
import { cleanTranscript } from "../src/briefing/merge-pipeline";
import { RepolishService } from "../src/notes/repolish-service";
import { VersionStore } from "../src/versions/version-store";

type MemoryFile = InstanceType<typeof obsidian.TFile>;

function createMemoryVault() {
  const files = new Map<string, MemoryFile>();
  const folders = new Set<string>();
  const vault = {
    getAbstractFileByPath: (path: string) => files.get(path) || (folders.has(path) ? { path } : null),
    getMarkdownFiles: () => [...files.values()],
    createFolder: async (path: string) => { folders.add(path); return { path }; },
    read: async (file: MemoryFile) => file.data,
    cachedRead: async (file: MemoryFile) => file.data,
    modify: async (file: MemoryFile, content: string) => { file.data = content; return file; },
    create: async (path: string, content: string) => {
      if (files.has(path)) throw new Error(`File already exists: ${path}`);
      const file = new obsidian.TFile(path, content);
      files.set(path, file);
      return file;
    },
  };
  return { files, vault };
}

const sourceContent = [
  "---",
  "qnalog_time: 2026-09-29T21:49:00",
  "qnalog_mode: meeting",
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
});

describe("clean transcript storage", () => {
  it("creates and opens a clean derived note without replacing the source minutes", async () => {
    const { files, vault } = createMemoryVault();
    const sourceFile = new obsidian.TFile("QnALog/转写纪要/2026-09-29 2149 · 会议纪要.md", sourceContent);
    files.set(sourceFile.path, sourceFile);
    const cleanNoteIndex = { refreshNoteIndexSafely: vi.fn(async () => undefined) };
    let cleanFrontmatterOverride: Record<string, unknown> | null = null;
    const app = {
      vault,
      metadataCache: {
        getFileCache: (candidate: MemoryFile) => candidate.path === sourceFile.path
          ? { frontmatter: { qnalog_time: "2026-09-29T21:49:00", qnalog_mode: "meeting" } }
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

    await service.generateCleanScript(sourceFile);

    expect(await vault.read(sourceFile)).toBe(sourceContent);
    expect(cleanTranscript).toHaveBeenCalledOnce();
    const derived = [...files.values()].find((file) => file.path !== sourceFile.path && file.path.startsWith(`${sourceFile.parent.path}/`) && !file.path.includes("/.versions/") && file.path.endsWith(`${sourceFile.basename}.md`));
    expect(derived).toBeDefined();
    expect(derived?.path).toMatch(/【.+】/);
    expect(derived?.data).toContain("variant_kind: \"clean\"");
    expect(derived?.data).toContain("qnalog_contains_raw: false");
    expect(derived?.data).toContain("Readable cleaned transcript.");
    expect(derived?.data).toContain("[[2026-09-29 2149 · 会议纪要]]");
    expect(openFile).toHaveBeenCalledWith(derived);
    expect([...files.values()].filter((file) => file.path.includes("/.versions/") && file.data.includes('variant_kind: "clean"'))).toHaveLength(0);
    expect(tasks.completeTaskActivity).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ subject: derived?.path }));
    expect(versions.findDerivedNoteForSource(sourceFile, getSourceIdFromMarkdown(sourceContent, sourceFile), "clean")).toBe(derived);
    await service.generateCleanScript(sourceFile);
    expect(await vault.read(sourceFile)).toBe(sourceContent);
    expect(cleanTranscript).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledTimes(2);
    expect(openFile).toHaveBeenLastCalledWith(derived);
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
    expect(openFile).toHaveBeenCalledTimes(4);
    const cleanPath = derived?.path || "";
    if (!cleanPath) throw new Error("Clean note was not created");
    files.delete(cleanPath);
    cleanTranscriptMock.mockResolvedValueOnce({ text: "Regenerated after deletion.", truncated: false });
    await service.generateCleanScript(sourceFile);
    const recreated = files.get(cleanPath);
    expect(cleanTranscript).toHaveBeenCalledTimes(4);
    expect(recreated?.data).toContain("Regenerated after deletion.");
    expect(openFile).toHaveBeenCalledTimes(5);
    expect(openFile).toHaveBeenLastCalledWith(recreated);
    await Promise.all([
      service.generateCleanScript(recreated as MemoryFile),
      service.generateCleanScript(recreated as MemoryFile),
    ]);
    expect(cleanTranscript).toHaveBeenCalledTimes(5);
    expect([...files.values()].filter((file) => file.path !== sourceFile.path && file.path.startsWith(`${sourceFile.parent.path}/`) && !file.path.includes("/.versions/") && file.path.endsWith(`${sourceFile.basename}.md`))).toHaveLength(1);
    expect(await vault.read(sourceFile)).toBe(sourceContent);
  });
});
