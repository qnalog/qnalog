import { describe, expect, it } from "vitest";
import { applyNoteTextCorrection } from "../src/notes/text-correction";

const NOTE = [
  "---",
  "mode: monologue",
  "tags:",
  "  - 主题/Hugging Face",
  "---",
  "",
  "# 2026-09-16 08:52 · 个人笔记",
  "",
  "<!-- qnalog-active-version-start -->",
  "> 在使用 Hugging Face 进行视频制作时，我梳理了一套流程。",
  "",
  "<!-- qnalog-note-index",
  '{"core":{"title":"Hugging Face 视频制作"}}',
  "qnalog-note-index-end -->",
  "<!-- qnalog-active-version-end -->",
  "",
  "<details>",
  "<summary>分段原始转写（1 段）</summary>",
  "",
  "### 段落 1",
  "",
  "在使用Hugging Face进行。视频制作的时候。",
  "",
  "</details>",
  "",
  "<!-- qnalog-session:qnalog-x -->",
  "",
  "```markdown",
  "示例：Hugging Face => Hyperframes",
  "```",
].join("\n");

describe("就地更正：替换范围", () => {
  it("正文、摘要、原始转写都替换；摘要与转写一并更正", () => {
    const r = applyNoteTextCorrection(NOTE, "Hugging Face", "Hyperframes");
    // 正文摘要 + 实时大纲/原始转写 = 2 处（frontmatter、索引 JSON、代码块各 1 处被保护）
    expect(r.replacements).toBe(2);
    expect(r.text).toContain("在使用 Hyperframes 进行视频制作时");
    expect(r.text).toContain("在使用Hyperframes进行");
  });

  it("frontmatter 不动（YAML 值语义）", () => {
    const r = applyNoteTextCorrection(NOTE, "Hugging Face", "Hyperframes");
    expect(r.text).toContain("  - 主题/Hugging Face");
  });

  it("索引 JSON 等 HTML 注释不动（机器数据，会被重算）", () => {
    const r = applyNoteTextCorrection(NOTE, "Hugging Face", "Hyperframes");
    expect(r.text).toContain('{"core":{"title":"Hugging Face 视频制作"}}');
  });

  it("折叠壳里的 json 围栏不动（新格式索引块受围栏保护）", () => {
    const fenced = [
      "# 笔记",
      "",
      "正文 Hugging Face 流程。",
      "",
      "<!-- qnalog-note-index -->",
      "<details>",
      "<summary>索引数据</summary>",
      "",
      "```json",
      '{"core":{"title":"Hugging Face 视频制作"}}',
      "```",
      "",
      "</details>",
      "<!-- qnalog-note-index-end -->",
    ].join("\n");
    const r = applyNoteTextCorrection(fenced, "Hugging Face", "Hyperframes");
    expect(r.text).toContain('{"core":{"title":"Hugging Face 视频制作"}}');
    expect(r.text).toContain("正文 Hyperframes 流程。");
    expect(r.replacements).toBe(1);
  });

  it("围栏代码块不动（示例代码里的词常是刻意的）", () => {
    const r = applyNoteTextCorrection(NOTE, "Hugging Face", "Hyperframes");
    expect(r.text).toContain("示例：Hugging Face => Hyperframes");
  });
});

describe("就地更正：匹配行为", () => {
  it("英文忽略大小写（与既有易错写法替换一致）", () => {
    const r = applyNoteTextCorrection("Hugging Face / hugging face / HUGGING FACE", "Hugging Face", "Hyperframes");
    expect(r.text).toBe("Hyperframes / Hyperframes / Hyperframes");
    expect(r.replacements).toBe(3);
  });

  it("可按需改为大小写敏感", () => {
    const r = applyNoteTextCorrection("Hugging Face / hugging face", "Hugging Face", "Hyperframes", { caseSensitive: true });
    expect(r.text).toBe("Hyperframes / hugging face");
    expect(r.replacements).toBe(1);
  });

  it("中文按原样匹配", () => {
    const r = applyNoteTextCorrection("说话人一 / 说话人二", "说话人一", "张三");
    expect(r.text).toBe("张三 / 说话人二");
  });

  it("正则可特殊字符按字面处理", () => {
    const r = applyNoteTextCorrection("值 (a) 与 a+b", "(a)", "[a]");
    expect(r.text).toBe("值 [a] 与 a+b");
  });

  it("空串、相同词、无匹配都不改", () => {
    expect(applyNoteTextCorrection("abc", "", "x").replacements).toBe(0);
    expect(applyNoteTextCorrection("abc", "abc", "abc").replacements).toBe(0);
    expect(applyNoteTextCorrection("abc", "zzz", "x").replacements).toBe(0);
    expect(applyNoteTextCorrection("abc", "zzz", "x").text).toBe("abc");
  });

  it("返回被改动的行号，供预览显示", () => {
    const r = applyNoteTextCorrection("l1\nl2 Hugging Face\nl3\nl4 Hugging Face", "Hugging Face", "X");
    expect(r.lines).toEqual([2, 4]);
  });
});
