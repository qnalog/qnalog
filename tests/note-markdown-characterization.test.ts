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
  extractTranscriptSegments,
  normalizeBriefingFrontmatterFields,
  parseSuggestedTagsFromOutput,
  postProcessBriefingOutput,
  replaceActiveVersionBlock,
  stripEmptyPlaceholders,
  stripImportAppendices,
  stripMarkdownForEmailBrief,
} from "../src/notes/note-markdown";
import { QNALOG_ACTIVE_VERSION_END, QNALOG_ACTIVE_VERSION_START } from "../src/shared/limits";
import { NS_FM, NS_TAG } from "../src/shared/namespace";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

// note-markdown 的回归覆盖：机器字段名固定、旧中英字段安全读取、内容字段按模式白名单保留，
// 以及版本块原位更新时不丢正文与原始材料。

const START = QNALOG_ACTIVE_VERSION_START;
const END = QNALOG_ACTIVE_VERSION_END;
const SESSION_LINE = "<!-- " + NS_TAG + "-session:" + NS_TAG + "-test1234-abcdef -->";
const EMBED = "![]" + "[[qnalog-20260924-100138.webm]]";
const count = (text: string, needle: string) => text.split(needle).length - 1;

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
  it("构建：三行元数据齐全；可选字段缺省即省略", () => {
    const full = buildActiveVersionBlock(META, "显示正文");
    expect(full).toContain("> [!info]- 当前显示版本：个人笔记 ·新标签");
    expect(full).toContain("> 生成时间：2026-09-24T11:00:00");
    expect(full).toContain("> 源转写指纹：hash1");
    expect(full).toContain("显示正文");
    expect(count(full, START)).toBe(1);
    expect(count(full, END)).toBe(1);

    const minimal = buildActiveVersionBlock({ label: "L" }, "正文");
    expect(minimal).toContain("当前显示版本：L");
    expect(minimal).not.toContain("生成时间");
    expect(minimal).not.toContain("源转写指纹");

    const empty = buildActiveVersionBlock(null, "正文");
    expect(empty).toContain("当前显示版本：当前版本");
  });

  it("已有块时原位替换：只有一块，新旧标签交替，前后内容不动", () => {
    const out = replaceActiveVersionBlock(buildNote(true), META, "新的显示正文");
    expect(count(out, START)).toBe(1);
    expect(count(out, END)).toBe(1);
    expect(out).toContain("个人笔记 ·新标签");
    expect(out).toContain("新的显示正文");
    expect(out).not.toContain("旧标签");
    expect(out).not.toContain("旧内容");
    expect(out).toContain("mode: monologue");
    expect(out).toContain("# 2026-09-24 10:01 · 个人笔记");
    expect(out).toContain("## 优化录制时的浮窗外观");
    expect(out).toContain("## 原始材料");
    expect(out).toContain("<summary>原始音频</summary>");
    expect(out).toContain(EMBED);
    expect(out).toContain(SESSION_LINE);
  });

  it("重复应用同一元数据不嵌套：仍然只有一块（历史 details 双层嵌套回归）", () => {
    const once = replaceActiveVersionBlock(buildNote(true), META, "显示正文");
    const twice = replaceActiveVersionBlock(once, META, "显示正文");
    expect(count(twice, START)).toBe(1);
    expect(count(twice, END)).toBe(1);
    expect(count(twice, "当前显示版本：")).toBe(1);
  });

  it("首次采纳（尚无块）：只留 frontmatter、H1、版本块与原始材料，旧渲染正文被压缩掉", () => {
    const out = replaceActiveVersionBlock(buildNote(false), META, "显示正文");
    expect(count(out, START)).toBe(1);
    expect(out).toContain("mode: monologue");
    expect(out).toContain("# 2026-09-24 10:01 · 个人笔记");
    expect(out).toContain("当前显示版本：个人笔记 ·新标签");
    // 原始材料的可保留部分：白名单 details 块与 session 行必须活着进尾部
    expect(out).toContain("<summary>录音信息</summary>");
    expect(out).toContain("<summary>原始音频</summary>");
    expect(out).toContain(EMBED);
    expect(out).toContain(SESSION_LINE);
    // 旧渲染正文按契约被压缩（已持久化在版本库里）
    expect(out).not.toContain("这是旧的已渲染正文。");
    expect(out).not.toContain("## 优化录制时的浮窗外观");
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
