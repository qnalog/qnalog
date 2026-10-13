import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+?/g, "/"),
  parseYaml: (yaml: string) => JSON.parse(yaml),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));
import * as obsidian from "obsidian";
import { getRecentNotes } from "../src/recent/recent-notes";
import { deleteNoteWithVariants, getDirectNoteVariants, type DeleteNoteWithVariantsPort, type DeletableNoteFile } from "../src/notes/delete-note-with-variants";

type TestFile = DeletableNoteFile & InstanceType<typeof obsidian.TFile> & { extension: string };
type MemoryFile = { file: TestFile; content: string; frontmatter: Record<string, unknown> };

function fixture(derivedCount: number) {
  const root = Object.assign(new obsidian.TFile(), {
    path: "Notes/2026-10-01 1200 会议.md", basename: "2026-10-01 1200 会议", extension: "md", stat: { ctime: 1, mtime: 1 },
  }) as TestFile;
  const derived = Array.from({ length: derivedCount }, (_, index) => Object.assign(new obsidian.TFile(), {
    path: `Notes/2026-10-01 1200 衍生${index + 1}.md`, basename: `2026-10-01 1200 衍生${index + 1}`, extension: "md", stat: { ctime: index + 2, mtime: index + 2 },
  }) as TestFile);
  const files = new Map<string, MemoryFile>();
  files.set(root.path, { file: root, content: "---\n{}\n---\nsource body", frontmatter: { qnalog_mode: "meeting", qnalog_time: "2026-10-01T12:00:00" } });
  for (const [index, file] of derived.entries()) {
    files.set(file.path, {
      file,
      content: `---\n${JSON.stringify({ qnalog_type: "QnALog派生版本", variant_kind: "minutes", variant_label: `纪要 ${index + 1}`, qnalog_source_path: root.path, source_id: "source-id", qnalog_contains_raw: false, qnalog_mode: "meeting", qnalog_time: "2026-10-01T12:00:00" })}\n---\nderived body ${index + 1}`,
      frontmatter: { qnalog_type: "QnALog派生版本", variant_kind: "minutes", variant_label: `纪要 ${index + 1}`, qnalog_source_path: root.path, source_id: "source-id", qnalog_contains_raw: false, qnalog_mode: "meeting", qnalog_time: "2026-10-01T12:00:00" },
    });
  }
  const trashed = new Set<string>();
  const port: DeleteNoteWithVariantsPort<TestFile> = {
    listMarkdownFiles: () => [...files.values()].filter((entry) => !trashed.has(entry.file.path)).map((entry) => entry.file),
    readFile: async (file) => files.get(file.path)?.content || "",
    updateFrontmatter: async (file, update) => {
      const entry = files.get(file.path);
      if (!entry) throw new Error("File no longer exists");
      update(entry.frontmatter);
      const yaml = JSON.stringify(entry.frontmatter);
      entry.content = `---\n${yaml}\n---\n${entry.content.split("---\n").slice(2).join("---\n")}`;
    },
    trashFile: async (file) => { trashed.add(file.path); },
  };
  const noteList = () => {
    const frontmatter = new Map([...files.values()].map((entry) => [entry.file.path, entry.frontmatter]));
    return getRecentNotes({
      settings: { mdFolder: "Notes" },
      queue: { tasks: [] },
      getCurrentSession: () => null,
      app: {
        vault: { getMarkdownFiles: () => port.listMarkdownFiles() },
        metadataCache: { getFileCache: (file: TestFile) => ({ frontmatter: frontmatter.get(file.path) || {} }) },
      },
    }, 24);
  };
  return { root, derived, files, trashed, port, noteList };
}

const moment = () => ({ year: () => 2026, isValid: () => true, day: () => 4, format: (pattern: string) => pattern === "YYYY-MM-DD" ? "2026-10-01" : "12:00", valueOf: () => 100 });

describe("delete note with derived versions", () => {
  beforeEach(() => vi.stubGlobal("window", { moment }));

  it("deletes a note with no derived versions through the existing path", async () => {
    const f = fixture(0);
    const variants = await getDirectNoteVariants(f.port, f.root);
    const result = await deleteNoteWithVariants({ port: f.port, source: f.root, expectedVariants: variants, action: "handoff" });
    expect(result).toBe("deleted");
    expect(f.trashed.has(f.root.path)).toBe(true);
    expect(f.noteList()).toHaveLength(0);
  });

  it("promotes the only derived note to the recent-notes root", async () => {
    const f = fixture(1);
    const variants = await getDirectNoteVariants(f.port, f.root);
    const result = await deleteNoteWithVariants({ port: f.port, source: f.root, expectedVariants: variants, action: "handoff" });
    expect(result).toBe("handed-off");
    expect(f.trashed.has(f.root.path)).toBe(true);
    expect(f.trashed.has(f.derived[0].path)).toBe(false);
    expect(f.files.get(f.derived[0].path)?.frontmatter.qnalog_promoted_variant).toBe(true);
    expect(f.files.get(f.derived[0].path)?.frontmatter.qnalog_contains_raw).toBe(false);
    expect(f.noteList().map((item) => item.file.path)).toEqual([f.derived[0].path]);
  });

  it("promotes the latest version and groups remaining versions under it", async () => {
    const f = fixture(3);
    const variants = await getDirectNoteVariants(f.port, f.root);
    await deleteNoteWithVariants({ port: f.port, source: f.root, expectedVariants: variants, action: "handoff" });
    const latest = f.derived[2];
    expect(f.trashed.has(f.root.path)).toBe(true);
    expect(f.noteList().map((item) => item.file.path)).toEqual([latest.path]);
    expect(f.files.get(f.derived[0].path)?.frontmatter.qnalog_source_path).toBe(latest.path);
    expect(f.files.get(f.derived[1].path)?.frontmatter.qnalog_source_path).toBe(latest.path);
    expect(f.noteList()[0].variants?.map((item) => item.file.path)).toEqual([f.derived[0].path, f.derived[1].path]);
  });

  it("trashes the source and every derived file when requested", async () => {
    const f = fixture(2);
    const variants = await getDirectNoteVariants(f.port, f.root);
    const result = await deleteNoteWithVariants({ port: f.port, source: f.root, expectedVariants: variants, action: "delete-all" });
    expect(result).toBe("deleted");
    expect([...f.trashed]).toHaveLength(3);
    expect(f.noteList()).toHaveLength(0);
  });

  it("aborts when a derived file changes while confirmation is open", async () => {
    const f = fixture(2);
    const variants = await getDirectNoteVariants(f.port, f.root);
    const changed = f.files.get(f.derived[1].path);
    if (changed) changed.content += "\nchanged";
    const result = await deleteNoteWithVariants({ port: f.port, source: f.root, expectedVariants: variants, action: "handoff" });
    expect(result).toBe("stale");
    expect(f.trashed.size).toBe(0);
    expect(f.noteList().map((item) => item.file.path)).toContain(f.root.path);
  });

  it("keeps the source when the selected latest version disappears before deletion", async () => {
    const f = fixture(2);
    const variants = await getDirectNoteVariants(f.port, f.root);
    f.trashed.add(f.derived[1].path);
    const result = await deleteNoteWithVariants({ port: f.port, source: f.root, expectedVariants: variants, action: "handoff" });
    expect(result).toBe("stale");
    expect(f.trashed.has(f.root.path)).toBe(false);
    expect(f.noteList().map((item) => item.file.path)).toContain(f.root.path);
  });
});
