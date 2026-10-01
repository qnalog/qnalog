import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));
import * as obsidian from "obsidian";

import { detectRecentModeFromFrontmatter, findRecentNoteVariantHost, getRecentNotes } from "../src/recent/recent-notes";

type RecentItem = { file: { path: string; basename: string } };

const source: RecentItem = {
  file: { path: "QnALog/转写纪要/2026-09-29 综合纪要.md", basename: "2026-09-29 综合纪要" },
};

describe("recent clean-copy grouping", () => {
  it("uses the stored source path when it resolves", () => {
    expect(findRecentNoteVariantHost(
      [source],
      "QnALog\\转写纪要\\2026-09-29 综合纪要.md",
      "clean",
      "unrelated filename",
    )).toBe(source);
  });

  it("falls back to a unique parent basename when the stored path is stale", () => {
    expect(findRecentNoteVariantHost(
      [source],
      "OldVault/转写纪要/2026-09-29 综合纪要.md",
      "clean",
      "【清稿】2026-09-29 综合纪要",
    )).toBe(source);
  });

  it("does not guess when basenames collide or for other derived versions", () => {
    const duplicate: RecentItem = {
      file: { path: "Other/2026-09-29 综合纪要.md", basename: source.file.basename },
    };
    expect(findRecentNoteVariantHost(
      [source, duplicate],
      "OldVault/2026-09-29 综合纪要.md",
      "clean",
      "【清稿】2026-09-29 综合纪要",
    )).toBeNull();
    expect(findRecentNoteVariantHost(
      [source],
      "OldVault/2026-09-29 综合纪要.md",
      "minutes",
      "【综合纪要】2026-09-29 综合纪要",
    )).toBeNull();
  });
  it("treats clean transcript mode as a display state ahead of legacy tags", () => {
    expect(detectRecentModeFromFrontmatter({}, { qnalog_mode: "cleanscript", tags: ["meeting"] })).toBe("cleanscript");
  });

  it("does not include version-cache markdown as an independent recent note", () => {
    vi.stubGlobal("window", {});
    const cacheFile = Object.assign(new obsidian.TFile(), {
      path: "QnALog/转写纪要/.versions/source/pre-clean.md",
      basename: "pre-clean",
      extension: "md",
    });
    const result = getRecentNotes({
      settings: { mdFolder: "QnALog/转写纪要" },
      app: {
        vault: { getMarkdownFiles: () => [cacheFile] },
        metadataCache: { getFileCache: () => ({ frontmatter: { qnalog_type: "QnALog版本缓存" } }) },
      },
    }, 24);
    expect(result).toEqual([]);
  });
});
  it("groups a synthesized minutes file under its personal-note source", () => {
    const sourceFile = Object.assign(new obsidian.TFile(), {
      path: "Notes/个人笔记-假期安排-中秋国庆拼假.md",
      basename: "个人笔记-假期安排-中秋国庆拼假",
      extension: "md",
      parent: { path: "Notes" },
      stat: { ctime: 1, mtime: 1 },
    });
    const derivedFile = Object.assign(new obsidian.TFile(), {
      path: "Notes/【综合纪要】个人笔记-假期安排-中秋国庆拼假.md",
      basename: "【综合纪要】个人笔记-假期安排-中秋国庆拼假",
      extension: "md",
      parent: { path: "Notes" },
      stat: { ctime: 2, mtime: 2 },
    });
    const frontmatter = new Map([
      [sourceFile.path, { qnalog_mode: "monologue", qnalog_time: "2026-09-30T09:00:00" }],
      [derivedFile.path, {
        qnalog_type: "QnALog派生版本",
        variant_kind: "minutes",
        variant_label: "综合纪要",
        variant_mode: "synthesis",
        qnalog_source_path: sourceFile.path,
        source_id: "source-id",
        qnalog_contains_raw: false,
      }],
    ]);
    const moment = () => ({
      year: () => 2026,
      isValid: () => true,
      day: () => 3,
      format: (pattern: string) => pattern === "YYYY-MM-DD" ? "2026-09-30" : "09:00",
      valueOf: () => 1,
    });
    vi.stubGlobal("window", { moment });
    const items = getRecentNotes({
      getCurrentSession: () => null,
      settings: { mdFolder: "Notes" },
      queue: { tasks: [] },
      app: {
        vault: { getMarkdownFiles: () => [sourceFile, derivedFile] },
        metadataCache: { getFileCache: (file: { path: string }) => ({ frontmatter: frontmatter.get(file.path) || {} }) },
      },
    }, 24);

    expect(items).toHaveLength(1);
    expect(items[0].file).toBe(sourceFile);
    expect(items[0].variants?.map((variant) => variant.label)).toEqual(["综合纪要"]);
  });
