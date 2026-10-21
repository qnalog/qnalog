import { describe, expect, it } from "vitest";
import { hasOrganizedBody } from "../src/notes/organized-body";

const RAW = "## 📁 原始材料\n\n<details>\n<summary>分段原始转写</summary>\n\n原文\n\n</details>\n";

describe("hasOrganizedBody", () => {
  it("is false when the organized heading is followed only by the AI failure placeholder", () => {
    const note = `---\nqnalog_type: QnALog派生版本\n---\n\n# 2026-10-17 12:08 · 原始笔记\n\n> [!info]- 当前显示版本：原始笔记 <span data-qnalog="active-version-start"></span>\n\n## 整合版（qwen3.8-max · 通用）\n\n_[AI 整理失败：没有可用于整理的有效转写文本；录音和失败切片已保留]_\n<span data-qnalog="active-version-end"></span>\n\n---\n\n${RAW}`;
    expect(hasOrganizedBody(note)).toBe(false);
  });

  it("is false for the ✨ heading with a merge-failure placeholder and no active version block", () => {
    const note = `# T\n\n## ✨ 整合版（2026-09-24）\n\n_[合并润色失败：网络错误]_\n\n---\n\n${RAW}`;
    expect(hasOrganizedBody(note)).toBe(false);
  });

  it("is false when the English placeholder is the only organized content", () => {
    const note = `# T\n\n## Merged version (meeting)\n\n_[Merge failed: timeout]_\n\n---\n\n${RAW}`;
    expect(hasOrganizedBody(note)).toBe(false);
    const aiFailed = `# T\n\n## Merged version (meeting)\n\n_[AI organizing failed: timeout]_\n\n---\n\n${RAW}`;
    expect(hasOrganizedBody(aiFailed)).toBe(false);
  });

  it("is false when nothing sits between the title and the raw material section", () => {
    expect(hasOrganizedBody(`# T\n\n---\n\n${RAW}`)).toBe(false);
    expect(hasOrganizedBody(`# T\n\n${RAW}`)).toBe(false);
  });

  it("is false for an empty string", () => {
    expect(hasOrganizedBody("")).toBe(false);
  });

  it("is true when the organized heading is followed by real content", () => {
    const note = `# T\n\n## ✨ 整合版（2026-09-24）\n\n## 结论\n\n确认了下一步计划。\n\n---\n\n${RAW}`;
    expect(hasOrganizedBody(note)).toBe(true);
  });

  it("is true for an English organized body inside the active version block", () => {
    const note = `# T\n\n> [!info]- 当前显示版本：原始笔记 <span data-qnalog="active-version-start"></span>\n\n## Merged version (meeting)\n\nDecisions were recorded.\n<span data-qnalog="active-version-end"></span>\n\n---\n\n${RAW}`;
    expect(hasOrganizedBody(note)).toBe(true);
  });

  it("is true when the organized body sits before the raw section without a heading", () => {
    expect(hasOrganizedBody(`# T\n\n正文段落。\n\n---\n\n${RAW}`)).toBe(true);
  });

  it("is false for a Chinese audio import draft whose import info callout has several lines", () => {
    const draft = `# 2026-10-20 23:49 · 工作纪要（导入处理中…）\n\n> [!info] 导入信息\n> 文件数：1 · 模式：工作纪要 · 转写：整文件\n> 模型：stub-model → qwen3.8-max-0902\n\n---\n\n${RAW}`;
    expect(hasOrganizedBody(draft)).toBe(false);
  });

  it("is false for an English audio import draft whose import info callout has several lines", () => {
    const draft = `# 2026-10-20 23:49 · Minutes (importing…)\n\n> [!info] Import info\n> Files: 1 · Mode: Minutes · Transcription: Whole file\n> Model: stub-model → qwen3.8-max-0902\n\n---\n\n${RAW}`;
    expect(hasOrganizedBody(draft)).toBe(false);
  });

  it("is false for a text import draft whose text import info callout has several lines", () => {
    const draft = `# 2026-10-20 23:49 · 工作纪要（文本导入处理中…）\n\n> [!info] 文本导入信息\n> 来源文件：2 · 模式：工作纪要 · 模型：stub-model\n\n---\n\n${RAW}`;
    expect(hasOrganizedBody(draft)).toBe(false);
  });

  it("is true when an import draft also holds a real organized section with bullets", () => {
    const note = `# T\n\n> [!info] 导入信息\n> 文件数：1 · 模式：工作纪要 · 转写：整文件\n> 模型：stub-model → qwen3.8-max-0902\n\n## ✨ 整合版（工作纪要）\n\n## 结论\n\n- 确认了下一步计划\n- 下周复盘\n\n---\n\n${RAW}`;
    expect(hasOrganizedBody(note)).toBe(true);
  });

  it("is true when plain text follows the import info callout directly after its block", () => {
    const note = `# T\n\n> [!info] 导入信息\n> 文件数：1\n\n正文段落。\n\n---\n\n${RAW}`;
    expect(hasOrganizedBody(note)).toBe(true);
  });

  it("is true when a different callout carries content, since only import info callouts are ignored", () => {
    const note = `# T\n\n> [!tip] 模式建议\n> 先确认预算再排期。\n\n---\n\n${RAW}`;
    expect(hasOrganizedBody(note)).toBe(true);
  });
});
