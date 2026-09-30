import { describe, expect, it, vi } from "vitest";
const modalState = vi.hoisted(() => ({
  buttons: [] as Array<{ text: string; click: () => void }>,
  texts: [] as string[],
}));

vi.mock("obsidian", () => {
  class FakeElement {
    tag: string;
    text: string;
    listeners: Record<string, () => void> = {};
    constructor(tag = "", text = "") { this.tag = tag; this.text = text; }
    empty() {}
    createEl(tag: string, options: { text?: string } = {}) {
      const element = new FakeElement(tag, options.text || "");
      modalState.texts.push(element.text);
      return element;
    }
    createDiv(options: { cls?: string } = {}) { return new FakeElement("div", options.cls || ""); }
    addEventListener(event: string, callback: () => void) {
      this.listeners[event] = callback;
      if (this.tag === "button" && event === "click") modalState.buttons.push({ text: this.text, click: callback });
    }
  }
  class FakeModal {
    contentEl = new FakeElement();
    onOpen = () => undefined;
    onClose = () => undefined;
    open() { this.onOpen(); }
    close() { this.onClose(); }
  }
  return {
    normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
    TFile: class {}, TFolder: class {},
    Modal: FakeModal,
  };
});

import {
  chooseExistingCleanCopy,
  getImportMarkerState,
  normalizeRecentNoteMeaningfulText,
  noteHasSuccessfulLlmBriefing,
  noteHasUsableRawTranscriptDespiteFailures,
} from "../src/ui/helpers";
import { NS_FM } from "../src/shared/namespace";

// 英文界面写 `## ✨ Current minutes` 与 `status: Organized`，此前 ui/helpers 只认中文标题与
// `published|done|completed`，健康英文笔记被判成"未成功"（警告永不消除）——已知 bug 的回归锁。
// 断言成对给出：等价中英 fixture 必须得到相同解析结果（与界面语言无关）。

const LONG_BODY = "这是一段足够长的会议正文，覆盖标题识别与失败标记判断两道长度门槛，必须超过六十个字符的底线要求。补齐字数确保长度短路不会掩盖标题或状态键的识别问题。";

const zhNote = [
  "# 2026-09-24 10:01 · 会议纪要",
  "",
  "## ✨ 当前纪要（2026-09-24）",
  "",
  LONG_BODY,
  "",
].join("\n");

const enNote = [
  "# 2026-09-24 10:01 · Minutes",
  "",
  "## ✨ Current minutes (2026-09-24)",
  "",
  LONG_BODY,
  "",
].join("\n");

describe("noteHasSuccessfulLlmBriefing：当前纪要标题与状态键双语", () => {
  it("中文笔记（当前纪要 / 状态: 已整理）判成功", () => {
    expect(noteHasSuccessfulLlmBriefing(zhNote)).toBe(true);
  });

  it("英文笔记（Current minutes）同样判成功——en 回归锁", () => {
    expect(noteHasSuccessfulLlmBriefing(enNote)).toBe(true);
  });

  it("无标题小节时走 frontmatter 状态兜底：已整理/Organized 为真、草稿为假", () => {
    expect(noteHasSuccessfulLlmBriefing(`状态: 已整理\n\n${LONG_BODY}`)).toBe(true);
    expect(noteHasSuccessfulLlmBriefing(`status: Organized\n\n${LONG_BODY}`)).toBe(true);
    expect(noteHasSuccessfulLlmBriefing(`status: draft\n\n${LONG_BODY}`)).toBe(false);
    expect(noteHasSuccessfulLlmBriefing(`${NS_FM.status}: organized\n\n${LONG_BODY}`)).toBe(true);
    expect(noteHasSuccessfulLlmBriefing(`${NS_FM.status}: draft\n\n${LONG_BODY}`)).toBe(false);
  });

  it("整合版标题与失败标记的判定中英对称", () => {
    const zhMerged = `# T\n\n## ✨ 整合版\n\n${LONG_BODY}\n`;
    const enMerged = `# T\n\n## ✨ Merged version\n\n${LONG_BODY}\n`;
    expect(noteHasSuccessfulLlmBriefing(zhMerged)).toBe(true);
    expect(noteHasSuccessfulLlmBriefing(enMerged)).toBe(true);
    expect(noteHasSuccessfulLlmBriefing(`${enMerged}_[Merge failed (queued for retry): x]_`)).toBe(false);
    expect(noteHasSuccessfulLlmBriefing(`${zhMerged}_[合并润色失败（已加入重试队列）：x]_`)).toBe(false);
  });
});

describe("normalizeRecentNoteMeaningfulText：元信息行词表双语剥离", () => {
  it("行首中英信息行剥掉后剩同样的正文", () => {
    expect(normalizeRecentNoteMeaningfulText("时间：10:00\n时长：01:02\n正文")).toBe("正文");
    expect(normalizeRecentNoteMeaningfulText("Time: 10:00\nDuration: 01:02\n正文")).toBe("正文");
    expect(normalizeRecentNoteMeaningfulText("Time: 10:00\nMode: seminar\n正文")).toBe("正文");
  });
});

describe("getImportMarkerState：结构标记双语", () => {
  it("英文笔记识别 Current minutes / Original material / Imported text info", () => {
    const state = getImportMarkerState([
      "## ✨ Current minutes (2026-09-24)",
      "body",
      "## 📁 Original material",
      "<details>",
      "<summary>Imported text info</summary>",
      "</details>",
      "<!-- qnalog-segments-start -->",
      "<!-- qnalog-segments-end -->",
    ].join("\n"));
    expect(state.hasGeneratedBlock).toBe(true);
    expect(state.hasImportBlock).toBe(true);
    expect(state.hasSegments).toBe(true);
  });

  it("中文笔记同构", () => {
    const state = getImportMarkerState([
      "## ✨ 当前纪要（2026-09-24）",
      "正文",
      "## 📁 原始材料",
      "<details>",
      "<summary>导入文本信息</summary>",
      "</details>",
      "<!-- qnalog-segments-start -->",
      "<!-- qnalog-segments-end -->",
    ].join("\n"));
    expect(state.hasGeneratedBlock).toBe(true);
    expect(state.hasImportBlock).toBe(true);
    expect(state.hasSegments).toBe(true);
  });
});

describe("noteHasUsableRawTranscriptDespiteFailures：失败占位双语剥离", () => {
  it.each([
    [
      ["_[转写失败：x]_", "_[合并润色失败（已加入重试队列）：x]_"],
      ["_[Transcription failed: x]_", "_[Merge failed (queued for retry): x]_"],
    ],
    [
      ["_[等待后台转写，音频已保留]_", "_[此段尚未完成转写，音频已保留]_"],
      ["_[Waiting for background transcription; the audio has been kept]_", "_[This segment is not fully transcribed yet; the audio has been kept]_"],
    ],
  ])("中英占位等价剥离后仍判定有可用转写", (zhMarkers, enMarkers) => {
    const transcript = "这是一段超过一百六十个字符门槛的原始转写正文，用于证明失败占位被剥离之后剩下的正文依然能通过长度门槛与分段标记的双重检查。".repeat(3);
    const zh = `${transcript}\n${zhMarkers.join("\n")}\n<!-- qnalog-segments-start -->\n<!-- qnalog-segments-end -->`;
    const en = `${transcript}\n${enMarkers.join("\n")}\n<!-- qnalog-segments-start -->\n<!-- qnalog-segments-end -->`;
    expect(noteHasUsableRawTranscriptDespiteFailures(zh)).toBe(true);
    expect(noteHasUsableRawTranscriptDespiteFailures(en)).toBe(true);
  });
});

describe("existing clean-copy choices", () => {
  it.each([
    [0, "open"],
    [1, "regenerate"],
    [2, null],
  ] as const)("returns the selected action (%s)", async (index, expected) => {
    modalState.buttons.length = 0;
    modalState.texts.length = 0;
    const choice = chooseExistingCleanCopy({} as never, "【清稿】2026-09-29 会议");
    expect(modalState.texts).toContain("A clean copy already exists");
    expect(modalState.texts).toContain("A clean copy already exists: 【清稿】2026-09-29 会议. You can open it or regenerate it.");
    expect(modalState.buttons.map((button) => button.text)).toEqual([
      "Open existing clean copy",
      "Regenerate existing clean copy",
      "Cancel",
    ]);
    modalState.buttons[index].click();
    await expect(choice).resolves.toBe(expected);
  });
});
