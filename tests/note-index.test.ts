import { describe, expect, it } from "vitest";
import {
  buildNoteIndex,
  extractIndexSource,
  readNoteIndex,
  removeNoteIndex,
  resolveNoteIndex,
  serializeNoteIndex,
  upsertNoteIndex,
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
  "<!-- qnalog-segments-start -->",
  "### 段落 1",
  "原始转写也不应进入索引。",
].join("\n");

describe("QnALog note index", () => {
  it("derives a compact core and first-level topics from the final minutes", () => {
    const index = buildNoteIndex(minutes, {
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
    expect(extractIndexSource(minutes)).not.toContain("原始转写也不应进入索引");
  });

  it("prefers the active display version over stale mother-note content", () => {
    const markdown = [
      "# 旧标题",
      "",
      "旧正文不应进入索引。",
      "",
      "<!-- qnalog-active-version-start -->",
      "> [!info] 当前显示版本：综合纪要",
      "",
      "> [!abstract] 会议梗概",
      "> 新版本聚焦跨会议索引。",
      "",
      "## 1. 新版本议题",
      "正文。",
      "<!-- qnalog-active-version-end -->",
      "",
      "## 原始材料",
      "原始材料。",
    ].join("\n");
    const index = buildNoteIndex(markdown, { noteTitle: "跨会议索引" });
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

    const index = buildNoteIndex(markdown, {
      noteTitle: "2026-08-24 0118 · 导入 · 综合纪要-HR AI-业务场景梳理与产品方向.md",
      generatedAt: "2026-08-25T00:00:00.000Z",
    });

    expect(index?.core.summary).toContain("团队决定先识别直接服务业务的高价值场景");
    expect(index?.core.summary).not.toBe("已按时间顺序完成全部内容整理。");
  });

  it("round-trips a folded shell marker and replaces it idempotently", () => {
    const first = buildNoteIndex(minutes, {
      noteTitle: "A --> B",
      generatedAt: "2026-08-25T10:00:00.000Z",
    })!;
    const marker = serializeNoteIndex(first);
    expect(marker).not.toContain("A --> B");
    expect(marker).toContain("<summary>索引数据</summary>");
    expect(marker).toContain("```json");
    expect(readNoteIndex(marker)?.core.title).toBe("A --> B");

    const inserted = upsertNoteIndex(minutes, first);
    expect(upsertNoteIndex(inserted, { ...first, generatedAt: "later" })).toBe(inserted);

    const changed = buildNoteIndex(minutes.replace("项目索引契约", "项目索引协议"), {
      noteTitle: "A --> B",
      generatedAt: "2026-08-25T11:00:00.000Z",
    })!;
    const replaced = upsertNoteIndex(inserted, changed);
    expect((replaced.match(/<!-- qnalog-note-index -->/g) || []).length).toBe(1);
    expect(replaced).not.toContain("<!-- qnalog-note-index\n");
    expect(readNoteIndex(replaced)?.sourceRevision).toBe(changed.sourceRevision);
  });

  it("upgrades a legacy comment block in place on refresh and never duplicates it", () => {
    const legacyBlock = [
      "<!-- qnalog-note-index",
      '{"schemaVersion":1,"sourceRevision":"old-rev","core":{"title":"旧","summary":"旧摘要内容不足三十二个字符时会走兜底，这里写长一点以通过弱摘要判定","heading":""},"topics":[],"topicCount":0,"omittedTopicCount":0,"meetingDate":"2026-08-25","generatedAt":"2026-08-25T10:00:00.000Z"}',
      "qnalog-note-index-end -->",
    ].join("\n");
    const note = `${minutes}\n\n${legacyBlock}\n`;
    const next = buildNoteIndex(minutes, { noteTitle: "升级索引", generatedAt: "2026-08-25T12:00:00.000Z" })!;
    const upgraded = upsertNoteIndex(note, next);
    expect((upgraded.match(/<!-- qnalog-note-index -->/g) || []).length).toBe(1);
    expect(upgraded).not.toContain("qnalog-note-index-end -->\n<!--");
    expect(upgraded).not.toContain('"sourceRevision":"old-rev"');
    expect(upgraded).toContain("<summary>索引数据</summary>");
    expect(readNoteIndex(upgraded)?.sourceRevision).toBe(next.sourceRevision);
    // 再刷一次：已是新格式且内容没变 → 原样返回。
    expect(upsertNoteIndex(upgraded, next)).toBe(upgraded);
    // 摘要里出现标记词也不能截断读取（换修订号触发一次真实重写）。
    const tricky = { ...next, sourceRevision: `${next.sourceRevision}-tricky`, core: { ...next.core, summary: "结尾提到 qnalog-note-index-end --> 的场景" } };
    expect(readNoteIndex(upsertNoteIndex(upgraded, tricky))?.core.summary).toContain("qnalog-note-index-end");
  });

  it("removes both folded and legacy index blocks without leftovers", () => {
    const fenced = upsertNoteIndex(minutes, buildNoteIndex(minutes, { noteTitle: "去壳", generatedAt: "2026-08-25T13:00:00.000Z" })!);
    const strippedFenced = removeNoteIndex(fenced);
    expect(strippedFenced).not.toContain("<details>");
    expect(strippedFenced).not.toContain("索引数据");
    expect(strippedFenced).not.toContain("qnalog-note-index");
    expect(strippedFenced).not.toContain("```json");
    expect(strippedFenced).not.toContain("\n\n\n");

    const legacy = `${minutes}\n\n<!-- qnalog-note-index\n{"schemaVersion":1}\nqnalog-note-index-end -->\n`;
    const strippedLegacy = removeNoteIndex(legacy);
    expect(strippedLegacy).not.toContain("qnalog-note-index");
    expect(strippedLegacy).not.toContain("\n\n\n");
  });

  it("keeps folded index and sediment shells out of the index source", () => {
    const shell = [
      "<!-- qnalog-note-index -->",
      "<details>",
      "<summary>索引数据</summary>",
      "",
      "```json",
      '{"schemaVersion":1,"sourceRevision":"x"}',
      "```",
      "",
      "</details>",
      "<!-- qnalog-note-index-end -->",
      "",
      "<!--QNALOG_SEDIMENT_BEGIN-->",
      "<details>",
      "<summary>沉淀数据</summary>",
      "",
      "```json",
      '{"people":[{"name":"张三"}]}',
      "```",
      "",
      "</details>",
      "<!--QNALOG_SEDIMENT_END-->",
    ].join("\n");
    const source = extractIndexSource(`# 标题\n\n正文议题。\n\n${shell}`);
    expect(source).toContain("正文议题");
    expect(source).not.toContain("索引数据");
    expect(source).not.toContain("沉淀数据");
    expect(source).not.toContain("schemaVersion");
    expect(source).not.toContain("张三");
    expect(source).not.toContain("<details>");
  });

  it("does not persist move-sensitive paths inside the canonical marker", () => {
    const index = buildNoteIndex(minutes, { noteTitle: "会议知识索引" })!;
    const marker = serializeNoteIndex(index);
    expect(marker).not.toContain("QnALog/转写纪要");
    const resolved = resolveNoteIndex(
      index,
      "QnALog/转写纪要/产品/会议知识索引.md",
      "QnALog/转写纪要/产品/会议知识索引 · 语义图.canvas",
    );
    expect(resolved.filePath).toContain("产品/会议知识索引.md");
    expect(resolved.semanticCanvasPath).toContain("语义图.canvas");
  });

  it("signals topic truncation instead of silently pretending the index is complete", () => {
    const headings = Array.from({ length: 55 }, (_, index) => `## ${index + 1}. 议题 ${index + 1}\n内容 ${index + 1}`).join("\n\n");
    const index = buildNoteIndex(`# 大型会议\n\n${headings}`, { noteTitle: "大型会议" })!;
    expect(index.topics).toHaveLength(48);
    expect(index.topicCount).toBe(55);
    expect(index.omittedTopicCount).toBe(7);
  });
});
