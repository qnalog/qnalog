import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  TFile: class TFile {},
}));

import * as obsidian from "obsidian";
import { ErrataStore, isErrataPath, type ErrataStorePort } from "../src/errata/errata-store";
import { parseErrata } from "../src/errata/errata-parser";
import { getActiveUiLanguage, matchUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

const originalLanguage = getActiveUiLanguage();
beforeEach(() => setActiveUiLanguage(matchUiLanguage("zh")!));
afterEach(() => setActiveUiLanguage(originalLanguage));

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

  it("creates localized Chinese and English structures and filenames", async () => {
    const f = fixture();
    setActiveUiLanguage(matchUiLanguage("zh")!);
    const chinese = await f.store.create(f.source.path);
    expect(chinese.path).toBe("QnALog/勘误表/2026-10-13 2321 · 原理 · 勘误.md");
    expect(f.files.get(chinese.path)?.text).toBe("笔记：[[QnALog/纪要/2026-10-13 2321 · 原理]]\n\n## 替换\n\n## 噪音\n\n## 说明\n");

    const englishFixture = fixture();
    setActiveUiLanguage(matchUiLanguage("en")!);
    const english = await englishFixture.store.create(englishFixture.source.path);
    expect(english.path).toBe("QnALog/勘误表/2026-10-13 2321 · 原理 · Errata.md");
    expect(englishFixture.files.get(english.path)?.text).toBe("Note: [[QnALog/纪要/2026-10-13 2321 · 原理]]\n\n## Replace\n\n## Noise\n\n## Notes\n");
  });

  it("appends to either heading language without adding the other language's section titles", async () => {
    for (const language of ["en", "zh"] as const) {
      const f = fixture();
      setActiveUiLanguage(matchUiLanguage(language)!);
      const created = await f.store.create(f.source.path);
      await f.store.appendReplacement(f.source.path, "wrong term", "right term");
      await f.store.appendNoise(f.source.path, "noise phrase");
      const markdown = f.files.get(created.path)?.text || "";
      if (language === "en") {
        expect(markdown).toContain("## Replace");
        expect(markdown).toContain("## Noise");
        expect(markdown).not.toMatch(/^## (替换|噪音|说明)$/m);
      } else {
        expect(markdown).toContain("## 替换");
        expect(markdown).toContain("## 噪音");
        expect(markdown).not.toMatch(/^## (Replace|Noise|Notes)$/m);
      }
      expect((await f.store.load(f.source.path))?.parsed).toMatchObject({
        replacements: [{ from: "wrong term", to: "right term" }],
        noise: ["noise phrase"],
      });
    }
  });

  it("uses the active language when appending a missing section", async () => {
    for (const [language, noteLabel, missingTitle] of [
      ["en", "Note", "Noise"],
      ["zh", "笔记", "噪音"],
    ] as const) {
      const f = fixture();
      setActiveUiLanguage(matchUiLanguage(language)!);
      const created = await f.store.create(f.source.path);
      const record = f.files.get(created.path);
      if (record) record.text = `${noteLabel}: [[QnALog/纪要/2026-10-13 2321 · 原理]]\n\n## ${language === "en" ? "Replace" : "替换"}\n`;
      await f.store.appendNoise(f.source.path, "noise phrase");
      const markdown = f.files.get(created.path)?.text || "";
      expect(markdown).toContain(`## ${missingTitle}`);
    }
  });

  it("reuses a Chinese errata file when the interface later switches to English", async () => {
    const f = fixture();
    setActiveUiLanguage(matchUiLanguage("zh")!);
    const original = await f.store.create(f.source.path);
    setActiveUiLanguage(matchUiLanguage("en")!);
    const reopened = await f.store.create(f.source.path);
    expect(reopened).toBe(original);
    expect(f.files.size).toBe(2);
  });

  it("localizes a same-name collision error", async () => {
    for (const [language, expectedMessage] of [
      ["zh", "已有另一篇勘误表使用了此文件名。"],
      ["en", "A different errata note already uses this file name."],
    ] as const) {
      const f = fixture();
      setActiveUiLanguage(matchUiLanguage(language)!);
      const other = Object.assign(new obsidian.TFile(), {
        path: "QnALog/纪要/other.md", basename: "other", extension: "md",
      }) as File;
      f.files.set(other.path, { file: other, text: "source" });
      const suffix = language === "en" ? "Errata" : "勘误";
      const conflictPath = `QnALog/勘误表/${f.source.basename} · ${suffix}.md`;
      const conflict = Object.assign(new obsidian.TFile(), {
        path: conflictPath, basename: conflictPath.split("/").pop()?.replace(/\.md$/, "") || "", extension: "md",
      }) as File;
      f.files.set(conflictPath, { file: conflict, text: "笔记：[[other]]" });
      await expect(f.store.create(f.source.path)).rejects.toThrow(expectedMessage);
    }
  });

  it("quotes every noise line so heading-looking text and blank lines stay in the noise section", async () => {
    const f = fixture();
    const errataFile = await f.store.create(f.source.path);
    const existing = f.files.get(errataFile.path);
    if (existing) existing.text = `${existing.text.trimEnd()}\n说明内容仍保留\n`;
    await f.store.appendNoise(f.source.path, "line one\n## 小标题\n\nline after blank");
    const loaded = await f.store.load(f.source.path);
    expect(loaded?.parsed.noise).toEqual(["line one ## 小标题 line after blank"]);
    expect(loaded?.parsed.notes).toEqual(["说明内容仍保留"]);
    const markdown = loaded?.markdown || "";
    expect(markdown).toContain("> ## 小标题\n> \n> line after blank");
    expect(markdown.indexOf("## 说明")).toBeGreaterThan(markdown.indexOf("line after blank"));
  });

  it("appends replacement and noise entries to an empty errata file", async () => {
    const replacementFixture = fixture();
    const replacementFile = await replacementFixture.store.create(replacementFixture.source.path);
    const replacementRecord = replacementFixture.files.get(replacementFile.path);
    if (replacementRecord) replacementRecord.text = "";
    await replacementFixture.store.appendReplacement(replacementFixture.source.path, "wrong", "right");
    const replacementText = replacementFixture.files.get(replacementFile.path)?.text || "";
    expect(replacementText).toContain("## 替换");
    expect(parseErrata(replacementText).replacements).toEqual([{ from: "wrong", to: "right" }]);

    const noiseFixture = fixture();
    const noiseFile = await noiseFixture.store.create(noiseFixture.source.path);
    const noiseRecord = noiseFixture.files.get(noiseFile.path);
    if (noiseRecord) noiseRecord.text = "";
    await noiseFixture.store.appendNoise(noiseFixture.source.path, "noise phrase");
    const noiseText = noiseFixture.files.get(noiseFile.path)?.text || "";
    expect(noiseText).toContain("## 噪音");
    expect(parseErrata(noiseText).noise).toEqual(["noise phrase"]);
  });

  it("handles an empty first line and only creates a heading when the section is absent", async () => {
    const existingSectionFixture = fixture();
    const existingSectionFile = await existingSectionFixture.store.create(existingSectionFixture.source.path);
    const existingSectionRecord = existingSectionFixture.files.get(existingSectionFile.path);
    if (existingSectionRecord) existingSectionRecord.text = "\n## 替换\n";
    await existingSectionFixture.store.appendReplacement(existingSectionFixture.source.path, "wrong", "right");
    const existingSectionText = existingSectionFixture.files.get(existingSectionFile.path)?.text || "";
    expect(existingSectionText.match(/^## 替换$/gm)).toHaveLength(1);
    expect(parseErrata(existingSectionText).replacements).toEqual([{ from: "wrong", to: "right" }]);

    const missingSectionFixture = fixture();
    const missingSectionFile = await missingSectionFixture.store.create(missingSectionFixture.source.path);
    const missingSectionRecord = missingSectionFixture.files.get(missingSectionFile.path);
    if (missingSectionRecord) missingSectionRecord.text = "\n\n笔记：[[x]]\n";
    await missingSectionFixture.store.appendNoise(missingSectionFixture.source.path, "noise phrase");
    const missingSectionText = missingSectionFixture.files.get(missingSectionFile.path)?.text || "";
    expect(missingSectionText).toContain("## 噪音");
    expect(parseErrata(missingSectionText).noise).toEqual(["noise phrase"]);
  });

  it("puts entries on the next line when the final section heading has no line ending", async () => {
    const f = fixture();
    const file = await f.store.create(f.source.path);
    const record = f.files.get(file.path);
    if (record) record.text = "笔记：[[x]]\n## Replace";
    await f.store.appendReplacement(f.source.path, "wrong", "right");
    const markdown = f.files.get(file.path)?.text || "";
    expect(markdown).toContain("## Replace\nwrong => right");
    expect(parseErrata(markdown).replacements).toEqual([{ from: "wrong", to: "right" }]);
  });

  it("appends entries to the right section in a Windows-newline errata file", async () => {
    const f = fixture();
    const file = await f.store.create(f.source.path);
    const record = f.files.get(file.path);
    if (record) record.text = "Note: [[QnALog/纪要/2026-10-13 2321 · 原理]]\r\n\r\n## Replace\r\n\r\n## Noise\r\n";
    await f.store.appendReplacement(f.source.path, "wrong", "right");
    await f.store.appendNoise(f.source.path, "noise phrase");
    const markdown = f.files.get(file.path)?.text || "";
    expect(parseErrata(markdown)).toMatchObject({
      replacements: [{ from: "wrong", to: "right" }],
      noise: ["noise phrase"],
    });
  });
});
