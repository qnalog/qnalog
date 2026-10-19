import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
type MemoryFile = { file: TestFile; content: string; frontmatter: Record<string, unknown> | null };

function fixture(derivedCount: number) {
  const root = Object.assign(new obsidian.TFile(), {
    path: "Notes/2026-10-01 1200 会议.md", basename: "2026-10-01 1200 会议", extension: "md", stat: { ctime: 1, mtime: 1 },
  }) as TestFile;
  const derived = Array.from({ length: derivedCount }, (_, index) => Object.assign(new obsidian.TFile(), {
    path: `Notes/2026-10-01 1200 衍生${index + 1}.md`, basename: `2026-10-01 1200 衍生${index + 1}`, extension: "md", stat: { ctime: index + 2, mtime: index + 2 },
  }) as TestFile);
  const files = new Map<string, MemoryFile>();
  const readFileCalls: string[] = [];
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
    readFrontmatter: (file) => files.get(file.path)?.frontmatter || null,
    readFile: async (file) => { readFileCalls.push(file.path); return files.get(file.path)?.content || ""; },
    updateFrontmatter: async (file, update) => {
      const entry = files.get(file.path);
      if (!entry?.frontmatter) throw new Error("File no longer exists or has no frontmatter");
      update(entry.frontmatter);
      const yaml = JSON.stringify(entry.frontmatter);
      entry.content = `---\n${yaml}\n---\n${entry.content.split("---\n").slice(2).join("---\n")}`;
    },
    trashFile: async (file) => { trashed.add(file.path); },
  };
  const noteList = () => {
    const frontmatter = new Map([...files.values()].map((entry) => [entry.file.path, entry.frontmatter || {}]));
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
  return { root, derived, files, trashed, port, noteList, readFileCalls };
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

  it("aborts a plain-delete confirmation if a derived note appears after the dialog opens", async () => {
    const f = fixture(0);
    const variantsAtConfirmation = await getDirectNoteVariants(f.port, f.root);
    expect(variantsAtConfirmation).toEqual([]);

    const newVariant = Object.assign(new obsidian.TFile(), {
      path: "Notes/new-derived.md", basename: "new-derived", extension: "md", stat: { mtime: 9 },
    }) as TestFile;
    const newFrontmatter = {
      qnalog_type: "QnALog派生版本", variant_kind: "minutes", qnalog_source_path: f.root.path,
      source_id: "source-id", qnalog_contains_raw: false,
    };
    f.files.set(newVariant.path, {
      file: newVariant,
      content: `---\n${JSON.stringify(newFrontmatter)}\n---\nnew derived body`,
      frontmatter: null,
    });

    const result = await deleteNoteWithVariants({
      port: f.port,
      source: f.root,
      expectedVariants: variantsAtConfirmation,
      action: "delete-all",
    });

    expect(result).toBe("stale");
    expect(f.trashed.has(f.root.path)).toBe(false);
    expect(f.trashed.has(newVariant.path)).toBe(false);
  });

  it("reads only linked derived candidates in a vault with many unrelated markdown files", async () => {
    const f = fixture(2);
    for (let index = 0; index < 1000; index++) {
      const file = Object.assign(new obsidian.TFile(), {
        path: `Notes/ordinary-${index}.md`, basename: `ordinary-${index}`, extension: "md", stat: { ctime: index, mtime: index },
      }) as TestFile;
      f.files.set(file.path, { file, content: "---\n{}\n---\nordinary", frontmatter: { qnalog_mode: "meeting" } });
    }
    const variants = await getDirectNoteVariants(f.port, f.root);
    expect(variants.map((variant) => variant.file.path)).toEqual(f.derived.map((file) => file.path));
    expect(f.readFileCalls).toEqual(f.derived.map((file) => file.path));
  });

  it("rechecks only candidates during stale validation", async () => {
    const f = fixture(2);
    const variants = await getDirectNoteVariants(f.port, f.root);
    f.readFileCalls.length = 0;
    const result = await deleteNoteWithVariants({ port: f.port, source: f.root, expectedVariants: variants, action: "handoff" });
    expect(result).toBe("handed-off");
    expect(f.readFileCalls).toEqual(f.derived.map((file) => file.path));
  });

  it("rejects a cached source link when the current file contents no longer link to the source", async () => {
    const f = fixture(1);
    const entry = f.files.get(f.derived[0].path);
    if (!entry) throw new Error("Missing derived fixture");
    entry.content = "---\n{}\n---\nno longer linked";

    const variants = await getDirectNoteVariants(f.port, f.root);

    expect(variants).toEqual([]);
  });

  it("does not treat uncached ordinary Markdown files as derived notes", async () => {
    const f = fixture(1);
    const unindexed = Object.assign(new obsidian.TFile(), {
      path: "Notes/unindexed.md", basename: "unindexed", extension: "md", stat: { ctime: 9, mtime: 9 },
    }) as TestFile;
    f.files.set(unindexed.path, { file: unindexed, content: "---\n{}\n---\nnot indexed", frontmatter: null });

    const variants = await getDirectNoteVariants(f.port, f.root);

    expect(variants.map((variant) => variant.file.path)).toEqual([f.derived[0].path]);
    expect(f.readFileCalls).toEqual([f.derived[0].path, unindexed.path]);
  });

  it("finds a real derived file before metadataCache indexes it, then preserves it on source deletion", async () => {
    const vaultPath = mkdtempSync(path.join(os.tmpdir(), "qnalog-unindexed-variant-"));
    try {
      const sourcePath = path.join(vaultPath, "source.md");
      const variantPath = path.join(vaultPath, "derived.md");
      const source = Object.assign(new obsidian.TFile(), { path: sourcePath, basename: "source", extension: "md", stat: { mtime: 1 } }) as TestFile;
      const variant = Object.assign(new obsidian.TFile(), { path: variantPath, basename: "derived", extension: "md", stat: { mtime: 2 } }) as TestFile;
      const sourceContent = "---\n{}\n---\nsource body";
      const variantFrontmatter = {
        qnalog_type: "QnALog派生版本", variant_kind: "minutes", variant_label: "Minutes",
        qnalog_source_path: sourcePath, source_id: "source-id", qnalog_contains_raw: false,
      };
      writeFileSync(sourcePath, sourceContent, "utf8");
      writeFileSync(variantPath, `---\n${JSON.stringify(variantFrontmatter)}\n---\nderived body`, "utf8");
      const trashed = new Set<string>();
      const port: DeleteNoteWithVariantsPort<TestFile> = {
        listMarkdownFiles: () => [source, variant].filter((file) => !trashed.has(file.path)),
        // Simulate Obsidian before its metadata cache has indexed the just-created derived note.
        readFrontmatter: (file) => file.path === sourcePath ? {} : null,
        readFile: async (file) => readFileSync(file.path, "utf8"),
        updateFrontmatter: async (file, update) => {
          const content = readFileSync(file.path, "utf8");
          const frontmatter = JSON.parse(content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/u)?.[1] || "{}");
          update(frontmatter);
          writeFileSync(file.path, content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---/u, `---\n${JSON.stringify(frontmatter)}\n---`), "utf8");
        },
        trashFile: async (file) => { trashed.add(file.path); },
      };

      const variants = await getDirectNoteVariants(port, source);
      expect(variants.map((item) => item.file.path)).toEqual([variantPath]);
      const result = await deleteNoteWithVariants({ port, source, expectedVariants: variants, action: "handoff" });

      expect(result).toBe("handed-off");
      expect(trashed.has(sourcePath)).toBe(true);
      expect(trashed.has(variantPath)).toBe(false);
      expect(readFileSync(variantPath, "utf8")).toContain('"qnalog_promoted_variant":true');
      expect(readFileSync(variantPath, "utf8")).not.toContain('"qnalog_source_path"');
    } finally {
      rmSync(vaultPath, { recursive: true, force: true });
    }
  });
});
