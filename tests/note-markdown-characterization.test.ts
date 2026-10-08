import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
}));
// vitest 跑在 Node 环境，没有 window；formatYamlDateTime 等读 window.moment（无 moment 时走内置 Date 分支）。
vi.stubGlobal("window", {});
import {
  buildActiveVersionBlock,
  buildImportedTextSegment,
  cleanTranscriptBlock,
  extractIntegratedBriefing,
  ensureTranscriptBlocks,
  extractTranscriptSegments,
  splitImportedTextIntoNormalSegments,
  normalizeBriefingFrontmatterFields,
  parseSuggestedTagsFromOutput,
  postProcessBriefingOutput,
  replaceActiveVersionBlock,
  splitTranscriptSections,
  stripEmptyPlaceholders,
  stripImportAppendices,
  stripMarkdownForEmailBrief,
  getSourceIdFromMarkdown,
} from "../src/notes/note-markdown";
import { extractAllRawBlocksFromText, extractSessionId, findActiveVersionBlock, findFirstNoteBoundary, findNoteMarkerOffset, findNoteDelimitedBlock, findRawMaterialInsertionOffset, iterateNoteDetailsBlocks, iterateNoteHeadingBlocks, replaceExistingActiveVersionBlock, replaceLeadingFrontmatter, splitLeadingFrontmatter, stripUtilityDetailsBlocks } from "../src/notes/note-document";
import { QNALOG_ACTIVE_VERSION_END, QNALOG_ACTIVE_VERSION_START } from "../src/shared/limits";
import { NS_FM, NS_TAG } from "../src/shared/namespace";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { hashRealtimeOutlineText } from "../src/notes/outline-text";
import { readTranscriptBlocks, serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
import { attachTextTranscript, getCurrentTranscript } from "../src/transcript/session-transcript";
import { buildTextImportSourceDetails } from "../src/notes/note-transcript-materials";

// note-markdown 的回归覆盖：机器字段名固定、旧中英字段安全读取、内容字段按模式白名单保留，
// 以及版本块原位更新时不丢正文与原始材料。

const START = QNALOG_ACTIVE_VERSION_START;
const END = QNALOG_ACTIVE_VERSION_END;
const SESSION_LINE = "<!-- " + NS_TAG + "-session:" + NS_TAG + "-test1234-abcdef -->";
const EMBED = "![]" + "[[qnalog-20260924-100138.webm]]";
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("iterateNoteHeadingBlocks", () => {
  it("returns original heading captures and exact ranges for adjacent and final headings", () => {
    const markdown = "### Segment 1\r\n### Segment 2\r\nbody\r\n### Segment 3\r\nlast";
    const pattern = /^### Segment (\d+)([^\n]*)$/gm;
    pattern.lastIndex = 7;
    const ranges = [...iterateNoteHeadingBlocks(markdown, pattern)];
    expect(pattern.lastIndex).toBe(7);
    expect(ranges.map((range) => range.match[1])).toEqual(["1", "2", "3"]);
    expect(markdown.slice(ranges[0].bodyStart, ranges[0].bodyEnd)).toBe("\n");
    expect(markdown.slice(ranges[1].bodyStart, ranges[1].bodyEnd)).toBe("\nbody\r\n");
    expect(markdown.slice(ranges[2].bodyStart, ranges[2].bodyEnd)).toBe("\nlast");
  });

  it("returns no ranges without a heading and lets a broader boundary truncate a timed body", () => {
    const timedHeading = /^### Segment \d+ \(([^)\n]+?)[–-]([^\n)]+?)\)([^\n]*)$/m;
    expect([...iterateNoteHeadingBlocks("plain text", timedHeading)]).toEqual([]);
    const markdown = "### Segment 1 (00:00–00:10)\nbody\n### Segment 2\nlater.wav";
    const [range] = iterateNoteHeadingBlocks(
      markdown,
      timedHeading,
      /^### Segment \d+/m,
    );
    expect(markdown.slice(range.bodyStart, range.bodyEnd)).toBe("\nbody\n");
  });
});
describe("findNoteDelimitedBlock", () => {
  it("returns original UTF-16 ranges from a requested offset with repeated body text", () => {
    const markdown = "😀\r\n<box>same</box>\r\n<box>same</box>";
    const firstStart = markdown.indexOf("<box>");
    const secondStart = markdown.indexOf("<box>", firstStart + 1);
    const first = findNoteDelimitedBlock(markdown, /<box>/, /<\/box>/);
    const second = findNoteDelimitedBlock(markdown, /<box>/, /<\/box>/, secondStart);
    expect(first).toEqual({
      start: firstStart,
      end: firstStart + "<box>same</box>".length,
      bodyStart: firstStart + "<box>".length,
      bodyEnd: firstStart + "<box>same".length,
    });
    expect(markdown.slice(first.start, first.end)).toBe("<box>same</box>");
    expect(markdown.slice(first.bodyStart, first.bodyEnd)).toBe("same");
    expect(markdown.slice(second.bodyStart, second.bodyEnd)).toBe("same");
    expect(second.start).toBe(secondStart);
  });

  it("accepts adjacent boundaries, returns null for missing boundaries, and scans nested starts from bodyStart", () => {
    const adjacent = findNoteDelimitedBlock("[]", /\[/g, /\]/g);
    expect(adjacent).not.toBeNull();
    expect("[]".slice(adjacent!.bodyStart, adjacent!.bodyEnd)).toBe("");
    expect(findNoteDelimitedBlock("", /</, />/)).toBeNull();
    expect(findNoteDelimitedBlock("no opener", /</, />/)).toBeNull();
    expect(findNoteDelimitedBlock("<open>", /<open>/, /<close>/)).toBeNull();

    const nested = "<x>outer <x>inner</x>";
    const outer = findNoteDelimitedBlock(nested, /<x>/, /<\/x>/)!;
    const inner = findNoteDelimitedBlock(nested, /<x>/, /<\/x>/, outer.bodyStart)!;
    expect(nested.slice(outer.bodyStart, outer.bodyEnd)).toBe("outer <x>inner");
    expect(nested.slice(inner.bodyStart, inner.bodyEnd)).toBe("inner");
  });

  it("does not consume or retain lastIndex from caller-owned global expressions", () => {
    const start = /<item>/g;
    const end = /<\/item>/g;
    start.lastIndex = 11;
    end.lastIndex = 17;
    const first = findNoteDelimitedBlock("<item>payload</item>", start, end);
    expect(start.lastIndex).toBe(11);
    expect(end.lastIndex).toBe(17);
    expect(findNoteDelimitedBlock("<item>payload</item>", start, end)).toEqual(first);
  });
});

describe("splitTranscriptSections 容器提取", () => {
  it("保留转写容器的原始换行，并解析文本来源字段", () => {
    const audio = "<details><summary>分段原始转写</summary>\r\n### Segment 1\r\n甲\r\n</details>";
    expect(splitTranscriptSections(audio)).toEqual(["\r\n### Segment 1\r\n甲\r\n"]);
    expect(extractTranscriptSegments(audio).map((segment) => segment.text)).toEqual(["甲"]);

    const imported = [
      "<details><summary>Text import sources</summary>",
      "",
      "### Text source 2 [[Notes/b.md|B]]",
      "",
      "乙",
      "",
      "</details>",
    ].join("\n");
    expect(extractTranscriptSegments(imported)).toMatchObject([
      { source: "text-import", sourceName: "B", sourcePath: "Notes/b.md", text: "乙" },
    ]);
  });

  it("returns details sections before marker sections, regardless of document order", () => {
    const markdown = [
      "<!-- qnalog-segments-start -->MARKER<!-- qnalog-segments-end -->",
      "<details><summary>分段原始转写</summary>DETAILS</details>",
    ].join("\n");
    expect(splitTranscriptSections(markdown)).toEqual(["DETAILS", "MARKER"]);
  });

  it("keeps empty complete containers and does not fall back, but ignores an unclosed container", () => {
    expect(
      splitTranscriptSections("<summary>Segmented raw transcript</summary></details>Raw transcript:FALLBACK"),
    ).toEqual([""]);
    expect(splitTranscriptSections("<summary>Segmented raw transcript</summary>orphaned")).toEqual([]);
  });

  it("uses the later legacy-language fallback when no complete container exists", () => {
    expect(splitTranscriptSections("原始转写：早期正文\nRaw transcript:最终正文")).toEqual(["最终正文"]);
  });
});


describe("parseSuggestedTagsFromOutput 标签建议注释", () => {
  it("解析标签并把注释从正文剥除，去重且保持顺序", () => {
    const input = "正文第一行\n\n<!-- qnalog-tags: 主题/实时转写, 项目/QALog, 主题/实时转写 -->\n";
    const r = parseSuggestedTagsFromOutput(input);
    expect(r.tags).toEqual(["主题/实时转写", "项目/QALog"]);
    expect(r.people).toEqual([]);
    expect(r.cleaned).toBe("正文第一行\n");
    expect(r.cleaned).not.toContain("qnalog-tags");
  });

  it("防御：# 前缀、空格、系统前缀、超长标签与人物转 people", () => {
    const long = "超".repeat(25);
    const input = `保留这段\n<!-- qnalog-tags: #主题/带 空格, ${NS_TAG}/系统标签, ${long}, 人物/张三, 人物/李四 -->`;
    const r = parseSuggestedTagsFromOutput(input);
    expect(r.tags).toEqual(["主题/带空格"]);
    expect(r.people).toEqual(["张三", "李四"]);
    expect(r.cleaned).not.toContain("qnalog-tags");
    expect(r.cleaned).toContain("保留这段");
  });

  it("无注释时原样返回，不做任何清理", () => {
    const r = parseSuggestedTagsFromOutput("普通正文");
    expect(r).toEqual({ tags: [], cleaned: "普通正文" });
  });

  it("兼容 tags-suggest 变体写法", () => {
    const r = parseSuggestedTagsFromOutput("内容\n<!-- qnalog-tags-suggest: 主题/备选 -->");
    expect(r.tags).toEqual(["主题/备选"]);
    expect(r.cleaned).not.toContain("suggest");
  });
});

describe("normalizeBriefingFrontmatterFields：固定键与历史别名", () => {
  it("按模式白名单规范化旧属性并裁掉未知字段", () => {
    const r = normalizeBriefingFrontmatterFields({ 主题: "X", 来源: "会议记录", 幻想字段: "剔除" }, "learning", "");
    expect(r).toEqual({ [NS_FM.topic]: "X", [NS_FM.source]: "会议记录" });
  });

  it("读取旧中文别名并只输出 canonical 字段", () => {
    const r = normalizeBriefingFrontmatterFields({ 录音主题: "转写主题" }, "monologue", "");
    expect(r).toEqual({ [NS_FM.topic]: "转写主题" });
  });

  it("兼容两个语言版本并列的人员数组，不丢任一值", () => {
    const r = normalizeBriefingFrontmatterFields({ people: ["李四"], 人物: ["王五"] }, "monologue", "");
    expect(r).toEqual({ [NS_FM.people]: ["李四", "王五"] });
  });

  it("canonical 属性存在时优先于旧别名", () => {
    const r = normalizeBriefingFrontmatterFields({ [NS_FM.topic]: "canonical", 主题: "旧值" }, "monologue", "");
    expect(r).toEqual({ [NS_FM.topic]: "canonical" });
  });

  it("旧参会人属性按 canonical 名称输出，数组值保持顺序", () => {
    const r = normalizeBriefingFrontmatterFields({ 与会人: ["甲", "乙"] }, "meeting", "");
    expect(r).toEqual({ [NS_FM.participants]: ["甲", "乙"] });
  });
});

// 按真实笔记结构构造：frontmatter + H1 + 渲染正文 + 版本块（可选）+ 原始材料段。
// 原始材料段的可保留部分是白名单 details（录音信息 / 原始音频）、session 行——
// 裸标题与裸嵌入不在提取白名单里，characterization 不为它们许诺。
function buildNote(existingBlock: boolean): string {
  const block = existingBlock
    ? [START, "> [!info]- 当前显示版本：旧标签", "> 旧内容", END].join("\n")
    : "";
  return [
    "---",
    "mode: monologue",
    "time: 2026-09-24T10:01:38",
    "时长: 02:01",
    "---",
    "",
    "# 2026-09-24 10:01 · 个人笔记",
    "",
    ...(block ? [block, ""] : []),
    "这是旧的已渲染正文。",
    "",
    "## 优化录制时的浮窗外观",
    "",
    "段落正文保留与否由替换路径决定。",
    "",
    "## 原始材料",
    "",
    "<details>",
    "<summary>录音信息</summary>",
    "",
    "- 时间：2026-09-24 10:01:38",
    "- 时长：02:01",
    "",
    "</details>",
    "",
    "<details>",
    "<summary>原始音频</summary>",
    "",
    EMBED,
    "",
    "</details>",
    "",
    SESSION_LINE,
    "",
  ].join("\n");
}

const META = { label: "个人笔记 ·新标签", createdAt: "2026-09-24T11:00:00", sourceHash: "hash1" };

describe("版本块构建与替换", () => {
  it("renders version-card metadata in the active language without translating version names", () => {
    const originalLanguage = getActiveUiLanguage();
    try {
      setActiveUiLanguage(resolveUiLanguage("en", "en"));
      const english = buildActiveVersionBlock({
        label: "Synthesis minutes",
        createdAt: "2026-10-01 21:36:37",
        sourceHash: "hash-fixture",
      }, "中文正文 stays unchanged.");
      expect(english).toContain("> [!info]- Currently displayed version: Synthesis minutes");
      expect(english).toContain("> Generated at: 2026-10-01 21:36:37");
      expect(english).toContain("> Source transcript fingerprint: hash-fixture");
      expect(english).toContain("中文正文 stays unchanged.");
      expect(count(english, START)).toBe(1);
      expect(count(english, END)).toBe(1);
      expect(buildActiveVersionBlock({ label: "旧中文版本" }, "正文")).toContain(
        "> [!info]- Currently displayed version: 旧中文版本",
      );
      expect(buildActiveVersionBlock({ kind: "Original" }, "正文")).toContain(
        "> [!info]- Currently displayed version: Original",
      );
      expect(buildActiveVersionBlock(null, "正文")).toContain(
        "> [!info]- Currently displayed version: Current version",
      );
      const minimalEnglish = buildActiveVersionBlock({ label: "L" }, "正文");
      expect(minimalEnglish).not.toContain("Generated at:");
      expect(minimalEnglish).not.toContain("Source transcript fingerprint:");

      setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
      const chinese = buildActiveVersionBlock({
        label: "个人笔记 ·新标签",
        createdAt: "2026-09-24T11:00:00",
        sourceHash: "hash1",
      }, "显示正文");
      expect(chinese).toContain("> [!info]- 当前显示版本：个人笔记 ·新标签");
      expect(chinese).toContain("> 生成时间：2026-09-24T11:00:00");
      expect(chinese).toContain("> 源转写指纹：hash1");
      expect(buildActiveVersionBlock(null, "正文")).toContain("> [!info]- 当前显示版本：当前版本");
    } finally {
      setActiveUiLanguage(originalLanguage);
    }
  });

  it("replaces only the active block and preserves legacy Chinese raw content", () => {
    const originalLanguage = getActiveUiLanguage();
    try {
      setActiveUiLanguage(resolveUiLanguage("en", "en"));
      const original = buildNote(true);
      const rawTail = original.slice(original.indexOf("## 原始材料"));
      const out = replaceActiveVersionBlock(original, META, "新的显示正文");
      expect(count(out, START)).toBe(1);
      expect(count(out, END)).toBe(1);
      expect(out).toContain("> [!info]- Currently displayed version: 个人笔记 ·新标签");
      expect(out).toContain("新的显示正文");
      expect(out).not.toContain("旧标签");
      expect(out).not.toContain("旧内容");
      expect(out).toContain("mode: monologue");
      expect(out).toContain("# 2026-09-24 10:01 · 个人笔记");
      expect(out.slice(out.indexOf("## 原始材料"))).toBe(rawTail);
      expect(out).toContain("<summary>原始音频</summary>");
      expect(out).toContain(EMBED);
      expect(out).toContain(SESSION_LINE);

      const once = replaceActiveVersionBlock(original, META, "显示正文");
      const twice = replaceActiveVersionBlock(once, META, "显示正文");
      expect(twice).toBe(once);

      const adopted = replaceActiveVersionBlock(buildNote(false), META, "显示正文");
      expect(count(adopted, START)).toBe(1);
      expect(adopted).toContain("mode: monologue");
      expect(adopted).toContain("# 2026-09-24 10:01 · 个人笔记");
      expect(adopted).toContain("> [!info]- Currently displayed version: 个人笔记 ·新标签");
      expect(adopted).toContain("<summary>录音信息</summary>");
      expect(adopted).toContain("<summary>原始音频</summary>");
      expect(adopted).toContain(EMBED);
      expect(adopted).toContain(SESSION_LINE);
      expect(adopted).not.toContain("这是旧的已渲染正文。");
      expect(adopted).not.toContain("## 优化录制时的浮窗外观");
    } finally {
      setActiveUiLanguage(originalLanguage);
    }
  });
});

describe("活动版本范围读取", () => {
  it("returns exact UTF-16 ranges for the first complete CRLF block and preserves an empty body", () => {
    const text = `before\r\n<!-- QNALOG-active-version-start -->\r\nAlpha\r\n<!-- qnalog-active-version-end -->\r\nafter`;
    const range = findActiveVersionBlock(text)!;
    expect(text.slice(range.start, range.end)).toBe("<!-- QNALOG-active-version-start -->\r\nAlpha\r\n<!-- qnalog-active-version-end -->");
    expect(text.slice(range.bodyStart, range.bodyEnd)).toBe("\r\nAlpha\r\n");
    expect(range).toMatchObject({ start: 8, body: "\r\nAlpha\r\n" });

    const emptyText = "<!-- qnalog-active-version-start --><!-- qnalog-active-version-end -->";
    const empty = findActiveVersionBlock(emptyText)!;
    expect(empty.body).toBe("");
    expect(empty.bodyStart).toBe(empty.bodyEnd);
  });

  it("prefers the first full block, rejects an incomplete block, and leaves String.replace semantics intact", () => {
    const first = "<!-- qnalog-active-version-start -->one<!-- qnalog-active-version-end -->";
    const second = "<!-- qnalog-active-version-start -->two<!-- qnalog-active-version-end -->";
    const text = `prefix${first}middle${second}suffix`;
    const range = findActiveVersionBlock(text)!;
    expect(text.slice(range.bodyStart, range.bodyEnd)).toBe("one");
    const replacement = replaceExistingActiveVersionBlock(text, "changed");
    expect(replacement).toBe(`prefixchangedmiddle${second}suffix`);
    expect(replaceExistingActiveVersionBlock(first, "$&")).toBe(first);
    expect(findActiveVersionBlock("<!-- qnalog-active-version-start -->unfinished")).toBeNull();
    expect(findActiveVersionBlock(text)).toEqual(range);
    expect(findActiveVersionBlock(text)).toEqual(range);
  });
});
describe("工具 details 壳读取", () => {
  it("removes adjacent matching shells without normalizing line endings or unmatched text", () => {
    const input = [
      "before",
      "<details>",
      "<summary>Raw transcript</summary>",
      "private one",
      "</details>",
      "<details>",
      "<summary>Index data</summary>",
      "{\"secret\":true}",
      "</details>",
      "after",
    ].join("\r\n");
    const expected = "before\r\n\n\r\n\n\r\nafter";
    expect(stripUtilityDetailsBlocks(input)).toBe(expected);
    expect(stripUtilityDetailsBlocks(stripUtilityDetailsBlocks(input))).toBe(expected);
    expect(stripUtilityDetailsBlocks("untouched\r\ntext")).toBe("untouched\r\ntext");
  });
});

// 解析双语是硬约束：同一段结构的中文 fixture 与等价英文 fixture 必须得到相同解析结果，
// 且与当前界面语言无关（解析侧不读 activeUiLanguage）。下面的成对断言即该约束的回归锁。
describe("笔记结构标签解析：中英 fixture 等价", () => {
  it("stripImportAppendices：五类折叠壳（导入文本信息/原文、实时大纲、回听时间轴、分段原始转写）双语整块剥除", () => {
    const shell = (summary: string) => ["<details>", `<summary>${summary}</summary>`, "", "BLOCK", "", "</details>", ""].join("\n");
    const zh = ["# T", "", shell("导入文本信息"), shell("导入文本原文（2 个来源）"), shell("录音中实时大纲（草稿）"), shell("回听时间轴"), shell("分段原始转写（3 段）"), "正文。"].join("\n");
    const en = ["# T", "", shell("Imported text info"), shell("Imported text (2 sources)"), shell("Live outline while recording (draft)"), shell("Playback timeline"), shell("Segmented raw transcript (3 segments)"), "正文。"].join("\n");
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(norm(stripImportAppendices(zh))).toBe("# T 正文。");
    expect(norm(stripImportAppendices(en))).toBe("# T 正文。");
  });

  it("extractIntegratedBriefing：最后一段整合版到导入折叠区为止（中英标题/停止位双语）", () => {
    const tail = ["", "要点一。", "", "要点二。", "", "<details>", "<summary>{0}</summary>", "", "来源正文", "", "</details>"].join("\n");
    const zh = ["# T", "", "## ✨ 整合版（2026-09-24）", ...tail.replace("{0}", "导入文本原文（2 个来源）").split("\n")].join("\n");
    const en = ["# T", "", "## ✨ Merged version (2026-09-24)", ...tail.replace("{0}", "Imported text (2 sources)").split("\n")].join("\n");
    expect(extractIntegratedBriefing(zh)).toBe("要点一。\n\n要点二。");
    expect(extractIntegratedBriefing(en)).toBe("要点一。\n\n要点二。");
  });

  it("extractTranscriptSegments：分段原始转写 details 下的 段落/Segment 标题读回等价", () => {
    const head = (summary: string, n1: string, n2: string) => [
      "<details>", `<summary>${summary}</summary>`, "",
      `### ${n1} (00:00–00:10)`, "", "甲段。", "",
      `### ${n2} (00:10–00:20)`, "", "乙段。", "",
      "</details>",
    ].join("\n");
    const zhSegs = extractTranscriptSegments(head("分段原始转写（2 段）", "段落 1", "段落 2"));
    const enSegs = extractTranscriptSegments(head("Segmented raw transcript (2 segments)", "Segment 1", "Segment 2"));
    expect(zhSegs).toHaveLength(2);
    expect(zhSegs[0].text).toBe("甲段。");
    expect(enSegs).toEqual(zhSegs);
  });

  it("extractTranscriptSegments：老格式「原始转写：/Raw transcript:」兜底读回等价", () => {
    const zh = extractTranscriptSegments("# T\n\n原始转写：\n甲段。");
    const en = extractTranscriptSegments("# T\n\nRaw transcript:\n甲段。");
    expect(zh).toHaveLength(1);
    expect(zh[0].text).toBe("甲段。");
    expect(en).toEqual(zh);
  });

  it("writes stable source ledgers before active processing and records direct edits as new revisions", () => {
    const legacy = [
      `<!-- ${NS_TAG}-session:legacy-session -->`,
      `<!-- ${NS_TAG}-segments-start:legacy-session -->`,
      "### Segment 1 (00:00–00:10) [[old.wav|00:00]]",
      "",
      `<!-- ${NS_TAG}-transcribe-task:task-legacy -->`,
      "**说话人1：** 原始内容。",
      "",
      `<!-- ${NS_TAG}-segments-end:legacy-session -->`,
    ].join("\n");
    const upgraded = ensureTranscriptBlocks(legacy, "legacy-session");
    const [original] = readTranscriptBlocks(upgraded);
    expect(original.segment.transcript?.id).toBe("seg:legacy-session:0");
    expect(original.segment.queueTaskId).toBe("task-legacy");
    expect(original.segment.transcript?.revisions[0]).toMatchObject({ source: "legacy-transcript", rawText: null });
    expect(original.segment.transcript?.revisions[0].utterances[0].rawText).toBeNull();
    expect(original.visibleBlock).toContain("qnalog-transcribe-task:task-legacy");
    expect(ensureTranscriptBlocks(upgraded, "legacy-session")).toBe(upgraded);

    const directlyEdited = ensureTranscriptBlocks(upgraded.replace("原始内容。", "手动修正内容。"), "legacy-session");
    const [edited] = readTranscriptBlocks(directlyEdited);
    expect(edited.segment.transcript?.id).toBe(original.segment.transcript?.id);
    expect(edited.segment.transcript?.currentRevision).toBe(1);
    expect(edited.segment.transcript?.revisions[0].source).toBe("legacy-transcript");
    expect(edited.segment.transcript?.revisions[1]).toMatchObject({ source: "edited-transcript", rawText: null });
    expect(edited.segment.transcript?.revisions[1].utterances[0].normalizedText).toContain("手动修正内容");
  });
  it("preserves valid transcript ledgers while upgrading legacy sections around them", () => {
    const middle = attachTextTranscript({
      index: 1,
      startOffsetMs: 10000,
      endOffsetMs: 20000,
      text: "B",
      audioName: "mid.wav",
      audioPath: "Audio/mid.wav",
    }, "fixture", "text-import");
    const middleBlock = serializeTranscriptBlock(middle, "### Segment 2 (00:10–00:20)", "B");
    const original = [
      "<details>",
      "<summary>Segmented raw transcript</summary>",
      "",
      "### Segment 1 (00:00–00:10)",
      "",
      "![[Audio/a.wav]]",
      "<!-- qnalog-transcribe-task:task-a -->",
      "A",
      "",
      middleBlock,
      "",
      "### Text source 3 [[Notes/c.md|c]]",
      "",
      "C",
      "",
      "</details>",
      "AFTER",
    ].join("\n");

    expect(extractTranscriptSegments(original).map((segment) => segment.text)).toEqual(["A", "B", "C"]);
    const upgraded = ensureTranscriptBlocks(original, "fixture");
    const blocks = readTranscriptBlocks(upgraded);
    expect(blocks.map((block) => block.segment.transcript?.id)).toEqual([
      "seg:fixture:0",
      "seg:fixture:1",
      "seg:fixture:2",
    ]);
    expect(blocks.map((block) => block.segment.text)).toEqual(["A", "B", "C"]);
    expect(blocks.find((block) => block.segment.transcript?.id === "seg:fixture:1")?.segment).toEqual(
      readTranscriptBlocks(original)[0].segment,
    );
    expect(upgraded).toContain(middleBlock);
    expect(extractTranscriptSegments(upgraded).map((segment) => segment.text)).toEqual(["A", "B", "C"]);
    expect(blocks[0].segment.audioPath).toBe("Audio/a.wav");
    expect(blocks[0].segment.audioName).toBe("a.wav");
    expect(blocks[0].segment.queueTaskId).toBe("task-a");
    expect(blocks[2].segment.sourcePath).toBe("Notes/c.md");
    expect(blocks[2].segment.rawText).toBe("C");
    expect(getCurrentTranscript(blocks[2].segment.transcript!).rawText).toBe("C");
    expect(upgraded.endsWith("</details>\nAFTER")).toBe(true);
    expect(ensureTranscriptBlocks(upgraded, "fixture")).toBe(upgraded);
  });

  it("keeps legacy bytes outside CRLF and consecutive protected ledger ranges", () => {
    const ledger = (index: number, text: string) => {
      const segment = attachTextTranscript({
        index,
        startOffsetMs: index * 10000,
        endOffsetMs: (index + 1) * 10000,
        text,
      }, "fixture", "text-import");
      return serializeTranscriptBlock(segment, `### Segment ${index + 1}`, text);
    };
    const firstLedger = ledger(1, "B");
    const secondLedger = ledger(2, "D");
    const source = [
      "<details>",
      "<summary>Segmented raw transcript</summary>",
      "",
      "### Segment 1",
      "",
      "A-before",
      "",
      firstLedger.replace(/\n/g, "\r\n"),
      "",
      secondLedger,
      "",
      "A-after",
      "",
      "</details>",
    ].join("\n");

    const upgraded = ensureTranscriptBlocks(source, "fixture");
    const blocks = readTranscriptBlocks(upgraded);
    expect(blocks.map((block) => block.segment.transcript?.id)).toEqual([
      "seg:fixture:0",
      "seg:fixture:1",
      "seg:fixture:2",
    ]);
    expect(upgraded).toContain(firstLedger.replace(/\n/g, "\r\n"));
    expect(upgraded).toContain(secondLedger);
    expect(blocks[0].segment.text).toContain("A-before");
    expect(blocks[0].segment.text).toContain("A-after");
    expect(blocks[0].segment.text.match(/A-before/g)).toHaveLength(1);
    expect(blocks[0].segment.text.match(/A-after/g)).toHaveLength(1);
    expect(blocks.slice(1).map((block) => block.segment.text)).toEqual(["B", "D"]);
    expect(ensureTranscriptBlocks(upgraded, "fixture")).toBe(upgraded);
  });

  it("avoids IDs already owned by a protected ledger and rejects damaged or future ledgers", () => {
    const segment = attachTextTranscript({
      index: 0,
      startOffsetMs: 10000,
      endOffsetMs: 20000,
      text: "B",
    }, "fixture", "text-import");
    const middleBlock = serializeTranscriptBlock(segment, "### Segment 2", "B");
    const source = [
      "<details>",
      "<summary>Segmented raw transcript</summary>",
      "",
      "### Segment 1",
      "",
      "A",
      "",
      middleBlock,
      "",
      "### Segment 3",
      "",
      "C",
      "",
      "</details>",
    ].join("\n");
    const upgraded = ensureTranscriptBlocks(source, "fixture");
    expect(readTranscriptBlocks(upgraded).map((block) => block.segment.transcript?.id)).toEqual([
      "seg:fixture:1",
      "seg:fixture:0",
      "seg:fixture:2",
    ]);
    expect(extractTranscriptSegments(upgraded).map((item) => item.index)).toEqual([0, 1, 2]);

    const damaged = middleBlock.replace(/<!--\s*qnalog-transcript-text-end:[^>]+-->/, "");
    const damagedSource = source.replace(middleBlock, damaged);
    expect(() => extractTranscriptSegments(damagedSource)).toThrow(/damaged metadata boundaries/);
    expect(() => ensureTranscriptBlocks(damagedSource, "fixture")).toThrow(/damaged metadata boundaries/);

    const future = middleBlock.replace('"schemaVersion":2', '"schemaVersion":3');
    const futureSource = source.replace(middleBlock, future);
    expect(() => extractTranscriptSegments(futureSource)).toThrow(/uses an unsupported schema/);
    expect(() => ensureTranscriptBlocks(futureSource, "fixture")).toThrow(/uses an unsupported schema/);
  });



  it("keeps imported text raw separate from its source label in details", () => {
    const sessionId = "text-import-session";
    const segments = splitImportedTextIntoNormalSegments([{
      name: "source.md",
      path: "Notes/source.md",
      text: "  QnALog was selected.\nThe source label is not transcript evidence.  ",
    }]).map((segment) => attachTextTranscript(segment, sessionId, "text-import"));
    const details = buildTextImportSourceDetails({ id: sessionId, source: "text-import", segments });
    const [block] = readTranscriptBlocks(details);
    const transcript = getCurrentTranscript(block.segment.transcript!);
    expect(block.visibleBlock).toBe(segments[0].rawText);
    expect(transcript.rawText).toBe(segments[0].rawText);
    expect(transcript.utterances.map((unit) => unit.rawText).join("")).toBe(segments[0].rawText);
    expect(block.segment.text).toContain("source.md");
  });

  it.each(["recording", "import", "merged-notes", " text-import "])(
    "does not build imported-source details for source %s",
    (source) => {
      expect(buildTextImportSourceDetails({ id: "empty", source, segments: [] })).toBe("");
    },
  );

  it.each([undefined, [], null])("does not build imported-source details without segments: %s", (segments) => {
    expect(buildTextImportSourceDetails({ id: "empty", source: "text-import", segments })).toBe("");
  });


  it("migrates numbered text source details without putting the source label in raw text", () => {
    const legacy = [
      "<details>",
      "<summary>导入文本原文（1 个来源）</summary>",
      "",
      "### 1. [[Notes/source.md|source.md]]",
      "",
      "原始来源内容。",
      "",
      "</details>",
    ].join("\n");
    const upgraded = ensureTranscriptBlocks(legacy, "legacy-text-import");
    const [block] = readTranscriptBlocks(upgraded);
    const transcript = getCurrentTranscript(block.segment.transcript!);
    expect(transcript.source).toBe("text-import");
    expect(transcript.rawText).toBe("原始来源内容。");
    expect(transcript.utterances.map((unit) => unit.rawText).join("")).toBe("原始来源内容。");
    expect(block.segment.sourcePath).toBe("Notes/source.md");
  });

  it.each([
    ["_[此段无内容]_", "_[No content in this segment]_"],
    ["_[等待后台转写，音频已保留]_", "_[Waiting for background transcription; the audio has been kept]_"],
    ["_[此段尚未完成转写，音频已保留]_", "_[This segment is not fully transcribed yet; the audio has been kept]_"],
    ["_[无输出]_", "_[No output]_"],
    ["_[转写失败：某某]_", "_[Transcription failed: 某某]_"],
    ["_[合并润色失败（已加入重试队列）：某某]_", "_[Merge failed (queued for retry): 某某]_"],
  ])("stripEmptyPlaceholders 空占位双语剥离：%s / %s", (zh, en) => {
    expect(stripEmptyPlaceholders(zh)).toBe("");
    expect(stripEmptyPlaceholders(en)).toBe("");
  });

  it("cleanTranscriptBlock：段落标题与无内容占位行双语剥离", () => {
    expect(cleanTranscriptBlock("### 段落 1 (00:00–00:10)\n甲段。")).toBe("甲段。");
    expect(cleanTranscriptBlock("### Segment 1 (00:00–00:10)\n甲段。")).toBe("甲段。");
    expect(cleanTranscriptBlock("_[此段无内容]_")).toBe("");
    expect(cleanTranscriptBlock("_[No content in this segment]_")).toBe("");
  });

  it("stripMarkdownForEmailBrief：正文在原始材料标题前截断，中英标题都认", () => {
    expect(stripMarkdownForEmailBrief("# 正文\n\n## 📁 原始材料\n\n转写一。")).toBe("# 正文");
    expect(stripMarkdownForEmailBrief("# Body\n\n## 📁 Original material\n\nTranscript.")).toBe("# Body");
    expect(stripMarkdownForEmailBrief("\uFEFF---\r\nmode: mic\r\n---\r\n# Body")).toBe("# Body");
    expect(stripMarkdownForEmailBrief("---\nmode: mic\n# Unclosed")).toBe("---\nmode: mic\n# Unclosed");
  });
});

describe("Frontmatter 系统字段：键名和值不随界面语言变化", () => {
  const source = { name: "甲", path: "p/甲.md", text: "内容" };

  it("buildImportedTextSegment 的可见标签仍随界面语言切换", () => {
    const originalLanguage = getActiveUiLanguage();
    try {
      setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
      expect(buildImportedTextSegment(source, 0)).toBe("【文本来源 1：[[p/甲.md|甲]]】\n\n内容");
      setActiveUiLanguage(resolveUiLanguage("en", "en"));
      expect(buildImportedTextSegment(source, 0)).toBe("【Text source 1:[[p/甲.md|甲]]】\n\n内容");
    } finally {
      setActiveUiLanguage(originalLanguage);
    }
  });

  it("中英文界面写入相同 qnalog_* 字段和状态值", () => {
    const originalLanguage = getActiveUiLanguage();
    const outputs = [];
    try {
      for (const language of ["zh", "en"]) {
        setActiveUiLanguage(resolveUiLanguage(language, language));
        outputs.push(postProcessBriefingOutput(
          "<!-- qnalog-people: 张三 -->\n正文。",
          "monologue",
          { startedAt: "2026-09-24T10:01:38", duration: "01:02:03" },
          null,
          "",
        ));
      }
    } finally {
      setActiveUiLanguage(originalLanguage);
    }
    for (const out of outputs) {
      expect(out).toContain(`${NS_FM.mode}: monologue`);
      expect(out).toContain(`${NS_FM.time}: 2026-09-24T10:01:38`);
      expect(out).toContain(`${NS_FM.duration}: 01:02:03`);
      expect(out).toContain(`${NS_FM.status}: organized`);
      expect(out).toContain(`${NS_FM.people}:`);
      expect(out).not.toMatch(/^(?:时长|状态|人物|duration|status|people):/m);
    }
  });

  it("重新整理旧中英属性时保留两组人员值并只写 canonical 键", () => {
    const originalLanguage = getActiveUiLanguage();
    try {
      setActiveUiLanguage(resolveUiLanguage("en", "en"));
      const out = postProcessBriefingOutput(
        "正文。",
        "monologue",
        { startedAt: "2026-09-24T10:01:38", duration: "01:02:03" },
        {
          mode: "monologue",
          time: "2026-09-24T10:01:38",
          duration: "00:05:00",
          status: "draft",
          people: ["李四"],
          人物: ["王五"],
          主题: "旧主题",
        },
        "",
      );
      expect(out).toContain(`${NS_FM.topic}: 旧主题`);
      expect(out).toContain("李四");
      expect(out).toContain("王五");
      expect(out).toContain(`${NS_FM.status}: organized`);
      expect(out).not.toMatch(/^(?:mode|time|duration|status|people|主题|人物|时长|状态):/m);
      expect(out).not.toContain("draft");
    } finally {
      setActiveUiLanguage(originalLanguage);
    }
  });
});
describe("笔记外层结构", () => {
  it("只拆开头 frontmatter，规范化头部换行并保留正文分隔语义", () => {
    const parts = splitLeadingFrontmatter("\uFEFF---\r\nmode: monologue\r\n---\r\n\r\n# Title\r\nbody");
    expect(parts.frontmatter).toBe("---\nmode: monologue\n---\n");
    expect(parts.body).toBe("# Title\r\nbody");
    expect(splitLeadingFrontmatter("正文\n---\n不是头部").body).toBe("正文\n---\n不是头部");
    expect(splitLeadingFrontmatter("---\nmode: x\n正文").body).toBe("---\nmode: x\n正文");
  });

  it("空 YAML 默认不改原稿，显式清除才移除头部", () => {
    const original = "---\nmode: monologue\n---\n\n# Title";
    expect(replaceLeadingFrontmatter(original, "")).toBe(original);
    expect(replaceLeadingFrontmatter(original, "", true)).toBe("# Title");
  });

  it("更新活动版本块不改变合法账本与来源材料，重复更新保持单块", () => {
    const segment = attachTextTranscript({
      index: 0,
      startOffsetMs: 0,
      endOffsetMs: 1000,
      text: "source",
      rawText: "source",
    }, "s1", "text-import");
    const transcriptBlock = serializeTranscriptBlock(segment, "### 转写", getCurrentTranscript(segment.transcript!).displayText);
    const original = [
      "<!-- qnalog-session:s1 -->",
      "<details><summary>分段原始转写</summary>",
      transcriptBlock,
      "</details>",
      START,
      "old body",
      END,
      "<details><summary>原始音频</summary>![[qnalog-audio.webm]]</details>",
    ].join("\n");
    const before = readTranscriptBlocks(original);
    expect(before).toHaveLength(1);
    const first = replaceExistingActiveVersionBlock(original, `${START}\nnew body\n${END}`);
    expect(first).not.toBeNull();
    const second = replaceExistingActiveVersionBlock(first!, `${START}\nnewer body\n${END}`);
    expect(second).not.toBeNull();
    const after = readTranscriptBlocks(second!);
    expect(after).toHaveLength(1);
    expect(after[0].segment).toEqual(before[0].segment);
    expect(after[0].visibleBlock).toBe(before[0].visibleBlock);
    expect(after[0].segment.transcript).toEqual(before[0].segment.transcript);
    expect(second).toContain("qnalog-session:s1");
    expect(second).toContain("newer body");
    expect(second).toContain("原始音频");
    expect(second).toContain("![[qnalog-audio.webm]]");
    expect(second?.match(/qnalog-active-version-start/g)).toHaveLength(1);
    expect(second?.match(/qnalog-active-version-end/g)).toHaveLength(1);
  });

  it("来源身份使用首个会话 ID，否则按路径与创建时间稳定回退", () => {
    expect(getSourceIdFromMarkdown("<!-- qnalog-session: source/id -->", { path: "note.md", stat: { ctime: 1 } })).toBe("sourceid");
    const file = { path: "note.md", stat: { ctime: 1 } };
    const expected = `note-${hashRealtimeOutlineText("note.md:1")}`;
    expect(getSourceIdFromMarkdown("", file)).toBe(expected);
    expect(getSourceIdFromMarkdown("changed body", file)).toBe(expected);
    expect(getSourceIdFromMarkdown("", { path: "other.md", stat: { ctime: 1 } })).not.toBe(expected);
    expect(getSourceIdFromMarkdown("", { path: "note.md", stat: { ctime: 2 } })).not.toBe(expected);
    expect(getSourceIdFromMarkdown("<!-- qnalog-session://// -->", file)).toBe("////");
    expect(getSourceIdFromMarkdown("<!-- qnalog-session:first --><!-- qnalog-session:second -->", file)).toBe("first");
  });

  it("原始材料提取按白名单保留来源块，未知 details 留在正文", () => {
    const recognized = "<details><summary>录音信息</summary>source</details>";
    const input = `正文\n${recognized}\n${recognized}\n<details><summary>未知资料</summary>keep</details>\n<!-- qnalog-session:s1 -->`;
    const extracted = extractAllRawBlocksFromText(input);
    expect(extracted.tail).toContain(recognized);
    expect(extracted.tail.match(/录音信息/g)).toHaveLength(1);
    expect(extracted.withoutRaw).toContain("未知资料");
    expect(extracted.withoutRaw).not.toContain("qnalog-session:s1");
    expect(extractSessionId("<!-- qnalog-session: source-id -->", "fallback")).toBe("source-id");
    expect(extractSessionId("<!-- qnalog-segments-start -->", "fallback")).toBe("fallback");
  });

});

describe("共享笔记结构范围定位", () => {
  it("返回首个边界且不修改 global 正则的 lastIndex", () => {
    const text = "xx target yy";
    const pattern = /target/g;
    pattern.lastIndex = 4;
    expect(findFirstNoteBoundary(text, [])).toBe(text.length);
    expect(findFirstNoteBoundary(text, [/missing/, /target/])).toBe(3);
    expect(pattern.lastIndex).toBe(4);
    expect(findFirstNoteBoundary(text, [pattern])).toBe(3);
    expect(pattern.lastIndex).toBe(4);
    expect(findFirstNoteBoundary("hit before", [/hit/, /before/])).toBe(0);
    expect(findFirstNoteBoundary("none", [/absent/])).toBe(4);
  });
  it("locates the requested first or last literal marker and preserves UTF-16 offsets", () => {
    const markdown = "😀<!-- marker -->middle<!-- marker -->";
    const first = markdown.indexOf("<!-- marker -->");
    const last = markdown.lastIndexOf("<!-- marker -->");
    expect(findNoteMarkerOffset(markdown, "<!-- marker -->", "first")).toBe(first);
    expect(findNoteMarkerOffset(markdown, "<!-- marker -->", "last")).toBe(last);
    expect(findNoteMarkerOffset(markdown, "absent", "first")).toBe(-1);
    expect(findNoteMarkerOffset(markdown, "absent", "last")).toBe(-1);
  });

  it("finds the original-material line start outside machine shells", () => {
    const shell = "<details><summary>Index data</summary>\n<!-- qnalog-segments-start:fake -->\n</details>";
    const realAnchor = "<!-- qnalog-segments-start:real -->";
    const tail = `before\n${shell}\nafter\n${realAnchor}\n`;
    expect(findRawMaterialInsertionOffset(tail)).toBe(tail.indexOf(realAnchor));
    expect(findRawMaterialInsertionOffset(shell)).toBe(-1);
    expect(findRawMaterialInsertionOffset("plain body")).toBe(-1);
  });


  it("yields exact UTF-16 slices in order with independent iterator state", () => {
    const text = "\uFEFF😀\r\n<details><summary>same</summary>\r\nsame</details>\r\n<DETAILS><SUMMARY>same</SUMMARY></DETAILS>";
    const expected = [
      { outer: "<details><summary>same</summary>\r\nsame</details>", summary: "same", body: "same" },
      { outer: "<DETAILS><SUMMARY>same</SUMMARY></DETAILS>", summary: "same", body: "" },
    ];
    const first = iterateNoteDetailsBlocks(text);
    const second = iterateNoteDetailsBlocks(text);
    const firstRange = first.next().value!;
    const secondRange = second.next().value!;
    expect(text.slice(firstRange.start, firstRange.end)).toBe(expected[0].outer);
    expect(text.slice(firstRange.summaryStart, firstRange.summaryEnd)).toBe(expected[0].summary);
    expect(text.slice(firstRange.bodyStart, firstRange.bodyEnd)).toBe(expected[0].body);
    expect(secondRange).toEqual(firstRange);
    const remainder = [...first];
    expect(remainder).toHaveLength(1);
    expect(text.slice(remainder[0].start, remainder[0].end)).toBe(expected[1].outer);
    expect(text.slice(remainder[0].summaryStart, remainder[0].summaryEnd)).toBe("same");
    expect(text.slice(remainder[0].bodyStart, remainder[0].bodyEnd)).toBe("");
    expect([...iterateNoteDetailsBlocks("<details><summary>open</summary>")]).toEqual([]);
  });

  it("keeps the existing flat match when an earlier opening tag closes later", () => {
    const text = "<details><summary>Wanted</summary>outer<details><summary>Inner</summary>inner</details>tail</details>";
    const range = [...iterateNoteDetailsBlocks(text)][0];
    expect(text.slice(range.bodyStart, range.bodyEnd)).toBe("outer<details><summary>Inner</summary>inner");
    expect(stripUtilityDetailsBlocks("<details><summary><b>Raw transcript</b></summary>keep</details>")).toContain("keep");
  });
});
