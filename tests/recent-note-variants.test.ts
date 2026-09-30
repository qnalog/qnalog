import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import { findRecentNoteVariantHost } from "../src/recent/recent-notes";

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
});
