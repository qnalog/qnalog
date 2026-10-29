import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class TAbstractFile { path: string; constructor(path: string) { this.path = path; } }
  class TFile extends TAbstractFile {
    basename: string;
    extension = "md";
    parent: { path: string } | null;
    data: string;
    constructor(path: string, data = "") {
      super(path);
      const name = path.split("/").pop() || "";
      this.basename = name.replace(/\.md$/, "");
      this.parent = { path: path.split("/").slice(0, -1).join("/") };
      this.data = data;
    }
  }
  return {
    TAbstractFile,
    TFile,
    normalizePath: (value: string) => String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
    // JSON stands in for YAML so list-valued properties survive the round trip.
    stringifyYaml: (value: unknown) => JSON.stringify(value),
    parseYaml: (text: string) => JSON.parse(text) as unknown,
  };
});

import * as obsidian from "obsidian";
import { DerivedNoteStore, type DerivedNoteHost } from "../src/versions/derived-note-store";

type MemoryFile = obsidian.TFile & { data: string };

function fixture(sourcePath: string, sourceFrontmatter: Record<string, unknown>) {
  const files = new Map<string, MemoryFile>();
  const frontmatters = new Map<string, Record<string, unknown>>();
  const source = new obsidian.TFile(sourcePath, "Original ASR transcript.") as MemoryFile;
  files.set(source.path, source);
  frontmatters.set(source.path, sourceFrontmatter);
  const host: DerivedNoteHost = {
    getAbstractFileByPath: (path) => files.get(path) || null,
    getMarkdownFiles: () => [...files.values()],
    getFileFrontmatter: (file) => frontmatters.get(file.path) || null,
    getSourceId: () => "note-source",
    findAvailableMarkdownPath: (target) => target,
    create: async (path, content) => {
      const file = new obsidian.TFile(path, content) as MemoryFile;
      files.set(path, file);
      return file;
    },
    modify: async (file, content) => { (file as MemoryFile).data = content; },
    refreshDerivedNote: async () => undefined,
    buildEmptyBody: () => "",
    getCreatedAt: () => "2026-10-29T10:30:00",
  };
  return { files, source, store: new DerivedNoteStore(host) };
}

function readFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  return JSON.parse(match ? match[1] : "{}") as Record<string, unknown>;
}

describe("derived note name corrections", () => {
  const sourceFrontmatter = {
    qnalog_people: ["余涵", "齐静"],
    qnalog_audio: "QnALog/录音/余涵-原始.m4a",
    tags: ["qnalog/general", "主题/余涵成长"],
  };

  it("applies note errata to the regenerated version's file name, heading and inherited properties", async () => {
    const { source, store } = fixture("QnALog/转写纪要/2026-10-29 0908 · 通用-余涵课外学习.md", sourceFrontmatter);

    const derived = await store.createDerivedNote(source, source.data, {
      meta: { sourceId: "note-source", kind: "minutes", createdAt: "2026-10-29T10:30:00" },
      frontmatter: "",
      body: "于涵和祁婧讨论了作业。",
      nameCorrections: [{ from: "余涵", to: "于涵" }, { from: "齐静", to: "祁婧" }],
    }, "通用", "general") as MemoryFile;

    expect(derived.path).toBe("QnALog/转写纪要/【通用】2026-10-29 0908 · 通用-于涵课外学习.md");
    const fm = readFrontmatter(derived.data);
    expect(fm.qnalog_people).toEqual(["于涵", "祁婧"]);
    expect(fm.tags).toEqual(["qnalog/general", "主题/于涵成长"]);
    // The recording path and the link back to the original keep the original's name.
    expect(fm.qnalog_audio).toBe("QnALog/录音/余涵-原始.m4a");
    expect(fm.qnalog_source_path).toBe(source.path);
    expect(derived.data).toContain("# 通用 · 2026-10-29 0908 · 通用-于涵课外学习");
    expect(derived.data).toContain("[[2026-10-29 0908 · 通用-余涵课外学习]]");
    expect(source.data).toBe("Original ASR transcript.");
  });

  it("keeps the original name when the note has no errata", async () => {
    const { source, store } = fixture("QnALog/转写纪要/2026-10-29 0908 · 通用-余涵课外学习.md", sourceFrontmatter);

    const derived = await store.createDerivedNote(source, source.data, {
      meta: { sourceId: "note-source", kind: "minutes", createdAt: "2026-10-29T10:30:00" },
      frontmatter: "",
      body: "Body.",
    }, "通用", "general") as MemoryFile;

    expect(derived.path).toBe("QnALog/转写纪要/【通用】2026-10-29 0908 · 通用-余涵课外学习.md");
    expect(readFrontmatter(derived.data).qnalog_people).toEqual(["余涵", "齐静"]);
  });
});
