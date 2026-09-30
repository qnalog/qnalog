import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class TFile {
    path: string;
    basename: string;
    extension: string;
    frontmatter: Record<string, unknown>;
    constructor(path: string, frontmatter: Record<string, unknown> = {}) {
      this.path = path;
      this.basename = path.split("/").pop()?.replace(/\.md$/i, "") || path;
      this.extension = "md";
      this.frontmatter = frontmatter;
    }
  },
}));

import * as obsidian from "obsidian";
import { NoteWriter } from "../src/notes/note-writer";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";

describe("NoteWriter mode detection for clean transcript display state", () => {
  const detect = (filename: string, frontmatter: Record<string, unknown>, polishMode = "synthesis") => {
    const file = new obsidian.TFile(filename, frontmatter);
    const writer = new NoteWriter({
      settings: { ...DEFAULT_SETTINGS, polishMode },
      app: { metadataCache: { getFileCache: (candidate: typeof file) => ({ frontmatter: candidate.frontmatter }) } },
    } as never);
    return writer.detectModeFromMarkdown(file);
  };

  it("uses a recognized existing mode tag before filename inference for clean display state", () => {
    expect(detect("Untitled.md", { qnalog_mode: "cleanscript", tags: ["meeting"] })).toBe("meeting");
  });

  it("infers the underlying polish mode from the filename, then falls back to settings", () => {
    expect(detect("Synthesis minutes - Untitled.md", { qnalog_mode: "cleanscript" })).toBe("synthesis");
    expect(detect("Renamed note.md", { qnalog_mode: "cleanscript" }, "seminar")).toBe("seminar");
  });

  it("leaves ordinary recognized frontmatter modes unchanged", () => {
    expect(detect("Untitled.md", { qnalog_mode: "meeting", tags: ["synthesis"] })).toBe("meeting");
  });
});
