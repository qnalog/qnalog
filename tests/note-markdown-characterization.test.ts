import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
}));
import {
  buildActiveVersionBlock,
  normalizeBriefingFrontmatterFields,
  parseSuggestedTagsFromOutput,
  replaceActiveVersionBlock,
} from "../src/notes/note-markdown";
import { QNALOG_ACTIVE_VERSION_END, QNALOG_ACTIVE_VERSION_START } from "../src/shared/limits";
import { NS_TAG } from "../src/shared/namespace";

// note-markdown（1503 行）此前只有分段读回/文件名两组测试，frontmatter 与版本块这两组
// 「错了就丢用户数据」的纯函数没有 characterization 锁定。这里锁现状契约，不改实现：
//   1) 标签建议注释：按分隔符解析 + 六道防御（去重 / # 前缀 / 空格 / 超长 / 系统前缀 / 人物转 people），
//      注释必须从正文剥除——它是给机器的，不能出现在读者面前；
//   2) frontmatter 白名单：按模式裁字段、旧字段别名迁移（录音主题→主题、与会人→参会人）、
//      用户改过的「人物」恒保留——重整时被当非白名单裁掉就是数据丢失；
//   3) 版本块：原位替换且只有一块（历史 bug：每次重整把旧 details 嵌进新 details 爆炸式增长）、
//      首次采纳只留 frontmatter + H1 + 版本块 + 原始材料（原始材料 = 白名单 details 块
//      + 分段标记 + session 行，fixture 按真实笔记结构构造）、可选元数据行缺省即省略。

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

describe("normalizeBriefingFrontmatterFields 白名单与别名", () => {
  it("按模式白名单裁掉未知字段", () => {
    const r = normalizeBriefingFrontmatterFields({ 主题: "X", 来源: "会议记录", 幻想字段: "剔除" }, "learning", "");
    expect(r).toEqual({ 主题: "X", 来源: "会议记录" });
  });

  it("旧字段录音主题迁移为主题，且旧键本身不残留", () => {
    const r = normalizeBriefingFrontmatterFields({ 录音主题: "转写的主题" }, "monologue", "");
    expect(r).toEqual({ 主题: "转写的主题" });
  });

  it("旧字段与会人迁移为参会人，数组值原样保留", () => {
    const r = normalizeBriefingFrontmatterFields({ 与会人: ["甲", "乙"] }, "meeting", "");
    expect(r).toEqual({ 参会人: ["甲", "乙"] });
  });

  it("人物字段不在任何模式白名单里也恒保留", () => {
    const r = normalizeBriefingFrontmatterFields({ 主题: "T", 人物: ["张三"], 无关: "丢" }, "monologue", "");
    expect(r).toEqual({ 主题: "T", 人物: ["张三"] });
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
