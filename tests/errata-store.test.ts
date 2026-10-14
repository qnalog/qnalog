import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  TFile: class TFile {},
}));

import * as obsidian from "obsidian";
import { ErrataStore, isErrataPath, type ErrataStorePort } from "../src/errata/errata-store";

type File = InstanceType<typeof obsidian.TFile> & { path: string; basename: string; extension: string };

function fixture() {
  const source = Object.assign(new obsidian.TFile(), { path: "QnALog/纪要/2026-10-13 2321 · 原理.md", basename: "2026-10-13 2321 · 原理", extension: "md" }) as File;
  const files = new Map<string, { file: File; text: string }>([[source.path, { file: source, text: "source" }]]);
  let processTail = Promise.resolve();
  const port: ErrataStorePort = {
    read: async (file) => files.get(file.path)?.text || "",
    listErrataFiles: () => [...files.values()].map(({ file }) => file).filter((file) => isErrataPath(file.path)),
    getByPath: (path) => files.get(path)?.file || null,
    getLinks: (file) => [...(files.get(file.path)?.text.matchAll(/\[\[([^\]]+)\]\]/g) || [])].map((match) => ({ link: match[1] })),
    resolveLink: (link) => [...files.values()].find(({ file }) => file.path.replace(/\.md$/i, "") === link || file.basename === link)?.file || null,
    ensureFolder: async () => undefined,
    create: async (path, text) => {
      const file = Object.assign(new obsidian.TFile(), { path, basename: path.split("/").pop()?.replace(/\.md$/, "") || "", extension: "md" }) as File;
      files.set(path, { file, text });
      return file;
    },
    process: async (file, transform) => {
      const task = processTail.then(() => {
        const record = files.get(file.path);
        if (!record) throw new Error("missing");
        record.text = transform(record.text);
      });
      processTail = task.catch(() => undefined);
      await task;
    },
  };
  return { source, files, store: new ErrataStore(port) };
}

describe("errata store", () => {
  it("uses the dedicated QnALog folder and links to the selected note", async () => {
    const f = fixture();
    const created = await f.store.create(f.source.path);
    expect(created.path).toBe("QnALog/勘误表/2026-10-13 2321 · 原理 · 勘误.md");
    const createdText = f.files.get(created.path)?.text || "";
    expect(createdText).toContain("笔记：[[QnALog/纪要/2026-10-13 2321 · 原理]]");
    expect(createdText).not.toMatch(/^qnalog_[\w-]+:/m);
    expect(createdText).not.toMatch(/^tags?:/m);
    expect(createdText).not.toMatch(/^#qnalog\//m);
    expect(await f.store.find(f.source.path)).toBe(created);
    expect(await f.store.load(f.source.path)).toMatchObject({ parsed: { replacements: [], noise: [], notes: [] } });
    expect(isErrataPath(created.path)).toBe(true);
    expect(isErrataPath("QnALog/纪要/entry.md")).toBe(false);
  });

  it("deduplicates repeated additions and keeps concurrent distinct additions", async () => {
    const f = fixture();
    await f.store.appendReplacement(f.source.path, "朱子 FS", "JuiceFS");
    await f.store.appendReplacement(f.source.path, "朱子 FS", "JuiceFS");
    await Promise.all([
      f.store.appendReplacement(f.source.path, "错词甲", "正词甲"),
      f.store.appendReplacement(f.source.path, "错词乙", "正词乙"),
    ]);
    const loaded = await f.store.load(f.source.path);
    expect(loaded?.parsed.replacements).toEqual(expect.arrayContaining([
      { from: "朱子 FS", to: "JuiceFS" },
      { from: "错词甲", to: "正词甲" },
      { from: "错词乙", to: "正词乙" },
    ]));
    expect(loaded?.parsed.replacements).toHaveLength(3);
  });
});
