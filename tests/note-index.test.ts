import { describe, expect, it } from "vitest";
import {
  buildLexVoiceNoteIndex,
  extractLexVoiceIndexSource,
  readLexVoiceNoteIndex,
  resolveLexVoiceNoteIndex,
  serializeLexVoiceNoteIndex,
  upsertLexVoiceNoteIndex,
} from "../src/indexing/note-index";

const minutes = [
  "---",
  "time: 2026-08-25T09:30:00",
  "mode: synthesis",
  "---",
  "",
  "# 2026-08-25 09:30 · 综合纪要",
  "",
  "> [!abstract] 会议梗概",
  "> 团队围绕会议知识如何形成持续可用的项目索引展开讨论，并确定先建立稳定的纪要索引契约。",
  "",
  "## 1. 从单次纪要走向项目记忆",
  "这部分讨论为什么单次 Canvas 不是终点。",
  "",
  "## 2. 索引生成与更新边界",
  "索引在最终正文落盘后生成。",
  "",
  "## 待办与下一步",
  "- [ ] 建立测试。",
  "",
  "---",
  "",
  "## 原始材料",
  "不应进入索引。",
  "<!-- lexvoice-segments-start -->",
  "### 段落 1",
  "原始转写也不应进入索引。",
].join("\n");

describe("LexVoice note index", () => {
  it("derives a compact core and first-level topics from the final minutes", () => {
    const index = buildLexVoiceNoteIndex(minutes, {
      noteTitle: "2026-08-25 0930 · 综合纪要-会议知识索引",
      generatedAt: "2026-08-25T10:00:00.000Z",
    });
    expect(index).not.toBeNull();
    expect(index?.meetingDate).toBe("2026-08-25");
    expect(index?.core.title).toBe("会议知识索引");
    expect(index?.core.summary).toContain("持续可用的项目索引");
    expect(index?.topics.map((topic) => topic.title)).toEqual([
      "从单次纪要走向项目记忆",
      "索引生成与更新边界",
      "待办与下一步",
    ]);
    expect(extractLexVoiceIndexSource(minutes)).not.toContain("原始转写也不应进入索引");
  });

  it("prefers the active display version over stale mother-note content", () => {
    const markdown = [
      "# 旧标题",
      "",
      "旧正文不应进入索引。",
      "",
      "<!-- lexvoice-active-version-start -->",
      "> [!info] 当前显示版本：综合纪要",
      "",
      "> [!abstract] 会议梗概",
      "> 新版本聚焦跨会议索引。",
      "",
      "## 1. 新版本议题",
      "正文。",
      "<!-- lexvoice-active-version-end -->",
      "",
      "## 原始材料",
      "原始材料。",
    ].join("\n");
    const index = buildLexVoiceNoteIndex(markdown, { noteTitle: "跨会议索引" });
    expect(index?.core.summary).toContain("新版本聚焦");
    expect(index?.core.summary).not.toContain("旧正文");
    expect(index?.topics.map((topic) => topic.title)).toEqual(["新版本议题"]);
  });

  it("replaces a low-information abstract with substantive note content", () => {
    const markdown = [
      "# 2026-08-24 01:18 · 综合纪要",
      "",
      "> [!abstract] 全程概览",
      "> 已按时间顺序完成全部内容整理。",
      "",
      "## 产品方向：从业务需求出发",
      "",
      "团队决定先识别直接服务业务的高价值场景，再按价值、风险和交付速度筛选首批功能，第一阶段以可用和可验证为目标。",
      "",
      "## 后续安排",
      "",
      "继续梳理候选场景并形成优先级。",
    ].join("\n");

    const index = buildLexVoiceNoteIndex(markdown, {
      noteTitle: "2026-08-24 0118 · 导入 · 综合纪要-HR AI-业务场景梳理与产品方向.md",
      generatedAt: "2026-08-25T00:00:00.000Z",
    });

    expect(index?.core.summary).toContain("团队决定先识别直接服务业务的高价值场景");
    expect(index?.core.summary).not.toBe("已按时间顺序完成全部内容整理。");
  });

  it("round-trips an HTML-comment-safe marker and replaces it idempotently", () => {
    const first = buildLexVoiceNoteIndex(minutes, {
      noteTitle: "A --> B",
      generatedAt: "2026-08-25T10:00:00.000Z",
    })!;
    const marker = serializeLexVoiceNoteIndex(first);
    expect(marker).not.toContain("A --> B");
    expect(readLexVoiceNoteIndex(marker)?.core.title).toBe("A --> B");

    const inserted = upsertLexVoiceNoteIndex(minutes, first);
    expect(upsertLexVoiceNoteIndex(inserted, { ...first, generatedAt: "later" })).toBe(inserted);

    const changed = buildLexVoiceNoteIndex(minutes.replace("项目索引契约", "项目索引协议"), {
      noteTitle: "A --> B",
      generatedAt: "2026-08-25T11:00:00.000Z",
    })!;
    const replaced = upsertLexVoiceNoteIndex(inserted, changed);
    expect((replaced.match(/lexvoice-note-index\s*$/gm) || []).length).toBe(1);
    expect(readLexVoiceNoteIndex(replaced)?.sourceRevision).toBe(changed.sourceRevision);
  });

  it("does not persist move-sensitive paths inside the canonical marker", () => {
    const index = buildLexVoiceNoteIndex(minutes, { noteTitle: "会议知识索引" })!;
    const marker = serializeLexVoiceNoteIndex(index);
    expect(marker).not.toContain("LexVoice/转写纪要");
    const resolved = resolveLexVoiceNoteIndex(
      index,
      "LexVoice/转写纪要/产品/会议知识索引.md",
      "LexVoice/转写纪要/产品/会议知识索引 · 语义图.canvas",
    );
    expect(resolved.filePath).toContain("产品/会议知识索引.md");
    expect(resolved.semanticCanvasPath).toContain("语义图.canvas");
  });

  it("signals topic truncation instead of silently pretending the index is complete", () => {
    const headings = Array.from({ length: 55 }, (_, index) => `## ${index + 1}. 议题 ${index + 1}\n内容 ${index + 1}`).join("\n\n");
    const index = buildLexVoiceNoteIndex(`# 大型会议\n\n${headings}`, { noteTitle: "大型会议" })!;
    expect(index.topics).toHaveLength(48);
    expect(index.topicCount).toBe(55);
    expect(index.omittedTopicCount).toBe(7);
  });
});
