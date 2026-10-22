import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  parseYaml: () => ({}),
}));

import {
  buildNoteIndex,
  clearComputedNoteIndexCache,
  computeNoteIndex,
  foldNoteMachineData,
  readNoteIndex,
  upsertNoteIndex,
} from "../src/indexing/note-index";
import { NS_FM } from "../src/shared/namespace";

// 索引卡改为读取时计算：笔记里不再写索引卡，写入只整理机器数据。

const body = (summary: string) => [
  "---",
  `${NS_FM.time}: 2026-08-25T09:30:00`,
  `${NS_FM.mode}: synthesis`,
  "---",
  "",
  "# 2026-08-25 09:30 · 综合纪要",
  "",
  "> [!abstract] 会议梗概",
  `> ${summary}`,
  "",
  "## 1. 索引生成与更新边界",
  "索引在读取时按正文计算。",
  "",
  "---",
  "",
  "## 原始材料",
  "<!-- qnalog-session:s1 -->",
  "<!-- qnalog-segments-start:s1 -->",
  "### 段落 1",
  "原始转写不进入索引。",
  "<!-- qnalog-segments-end:s1 -->",
].join("\n");

const path = "QnALog/Notes/2026-08-25 0930 · 综合纪要-会议知识索引.md";
const noteTitle = "2026-08-25 0930 · 综合纪要-会议知识索引";

afterEach(() => clearComputedNoteIndexCache());

describe("computeNoteIndex (read side)", () => {
  it("computes the card from the current body, ignoring a stale stored card", () => {
    const stale = upsertNoteIndex(body("旧的概要内容，已经不再准确，读取方不应再使用它。"), buildNoteIndex(body("旧的概要内容，已经不再准确，读取方不应再使用它。"), { noteTitle })!);
    const current = stale.replace("旧的概要内容，已经不再准确，读取方不应再使用它。", "新的概要：索引改为读取时按当前正文计算，不再写入笔记。");
    expect(readNoteIndex(current)?.core.summary).toContain("旧的概要");
    const card = computeNoteIndex(current, { path, mtime: 2, noteTitle });
    expect(card?.core.title).toBe("会议知识索引");
    expect(card?.core.summary).toContain("读取时按当前正文计算");
    expect(card?.core.summary).not.toContain("旧的概要");
  });

  it("caches by path, mtime and length and recomputes when the note changes", () => {
    const first = body("第一版概要：用于检查同一 mtime 与长度下复用缓存。");
    const a = computeNoteIndex(first, { path, mtime: 10, noteTitle });
    expect(computeNoteIndex(first, { path, mtime: 10, noteTitle })).toBe(a);
    const changed = body("第二版概要：正文与修改时间都变了，必须重新计算索引卡。");
    const b = computeNoteIndex(changed, { path, mtime: 11, noteTitle });
    expect(b).not.toBe(a);
    expect(b?.core.summary).toContain("第二版概要");
  });

  it("gives no card to notes QnALog did not write, as before", () => {
    const plain = "# Plain note\n\nSome ordinary text that has nothing to do with QnALog recordings at all.";
    expect(computeNoteIndex(plain, { path: "Notes/plain.md", mtime: 1, noteTitle: "plain" })).toBeNull();
  });

  it("falls back to the stored card instead of throwing when the transcript is damaged", () => {
    const stored = upsertNoteIndex(body("已存的概要在计算失败时作为退路。"), buildNoteIndex(body("已存的概要在计算失败时作为退路。"), { noteTitle })!);
    const damaged = `${stored}\n<!-- qnalog-transcript-start:broken:fragment:1 -->\n`;
    expect(() => computeNoteIndex(damaged, { path, mtime: 3, noteTitle })).not.toThrow();
    expect(computeNoteIndex(damaged, { path, mtime: 3, noteTitle })?.core.summary).toContain("已存的概要");
  });
});

describe("foldNoteMachineData (write side)", () => {
  it("folds session comments into one Index data container without writing a card", () => {
    const folded = foldNoteMachineData(body("写入时只整理机器数据，不写索引卡。"));
    expect(folded).not.toContain("<!-- qnalog-note-index -->");
    expect([...folded.matchAll(/<summary>(?:索引数据|Index data)<\/summary>/g)]).toHaveLength(1);
    const container = folded.slice(folded.lastIndexOf("<details>"));
    expect(container).toContain("<!-- qnalog-session:s1 -->");
    expect(foldNoteMachineData(folded)).toBe(folded);
  });

  it("removes an old stored card from the note being written and keeps its session comments", () => {
    const old = upsertNoteIndex(body("旧版本写入的索引卡在下次写入时移除。"), buildNoteIndex(body("旧版本写入的索引卡在下次写入时移除。"), { noteTitle })!);
    expect(old).toContain("<!-- qnalog-note-index -->");
    const folded = foldNoteMachineData(old);
    expect(folded).not.toContain("<!-- qnalog-note-index -->");
    expect(readNoteIndex(folded)).toBeNull();
    expect(folded).toContain("<!-- qnalog-session:s1 -->");
    expect([...folded.matchAll(/<summary>(?:索引数据|Index data)<\/summary>/g)]).toHaveLength(1);
  });

  it("leaves a note with a card from a newer version untouched", () => {
    const future = `${body("来自更新版本的索引卡保持只读。")}\n\n<details>\n<summary>Index data</summary>\n<!-- qnalog-note-index -->\n\`\`\`json\n{"schemaVersion":99}\n\`\`\`\n<!-- qnalog-note-index-end -->\n</details>`;
    expect(foldNoteMachineData(future)).toBe(future);
  });
});

describe("NoteIndexService.refreshNoteIndex after a note write", () => {
  it("folds machine data, writes no card, returns the computed card and fires the topic prompt", async () => {
    const obsidian = await import("obsidian") as unknown as { TFile: new () => object };
    const { NoteIndexService } = await import("../src/notes/note-index-service");
    class TFile { path = path; basename = noteTitle; extension = "md"; }
    Object.assign(obsidian, { TFile });
    let stored = upsertNoteIndex(body("服务层：写入后不再写索引卡，但仍触发主题提示。"), buildNoteIndex(body("服务层：写入后不再写索引卡，但仍触发主题提示。"), { noteTitle })!);
    const file = new TFile();
    const onNoteIndexed = vi.fn();
    const service = new NoteIndexService({
      app: {
        vault: {
          getAbstractFileByPath: () => file,
          read: async () => stored,
          modify: vi.fn(async (_file: unknown, next: string) => { stored = next; }),
        },
        metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
      },
      diagnostics: { logDiagnostic: vi.fn() },
      settings: {},
      onNoteIndexed,
    } as never);
    const resolved = await service.refreshNoteIndex(file);
    expect(stored).not.toContain("<!-- qnalog-note-index -->");
    expect(stored).toContain("<!-- qnalog-session:s1 -->");
    expect(resolved?.core.summary).toContain("服务层");
    await vi.waitFor(() => expect(onNoteIndexed).toHaveBeenCalledWith(path));
  });
});
