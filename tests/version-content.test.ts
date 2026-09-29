import { describe, expect, it } from "vitest";
import { resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import {
  applyVersionTitle,
  buildVersionPayload,
  foldRawTranscriptSection,
  normalizeTitleDatetime,
  replaceExistingActiveVersionBlock,
  replaceLeadingFrontmatter,
  sanitizeActiveVersionBody,
  splitLeadingFrontmatter,
  splitVersionPayload,
  stripVersionBookkeepingFrontmatter,
} from "../src/version-content";

const generatedDocument = [
  "---",
  "mode: seminar",
  "topic: Audio test",
  "tags:",
  "  - qnalog/seminar",
  "---",
  "",
  "# Seminar minutes",
  "",
  "Generated body.",
].join("\n");

describe("QnALog version content", () => {
  it("separates generated YAML from the display body", () => {
    const parts = splitVersionPayload(generatedDocument);
    expect(parts.frontmatter).toContain("mode: seminar");
    expect(parts.body).toBe("# Seminar minutes\n\nGenerated body.");
  });

  it("stores generated YAML in a non-frontmatter cache marker", () => {
    const source = splitVersionPayload(generatedDocument);
    const payload = buildVersionPayload(source.frontmatter, source.body);
    expect(payload).toContain("qnalog-version-frontmatter-start");
    expect(payload).not.toMatch(/^---/);

    const restored = splitVersionPayload(payload);
    expect(restored).toEqual(source);
  });

  it("replaces the mother note frontmatter instead of adding another YAML block", () => {
    const mother = "---\nmode: synthesis\ntopic: Old\n---\n\n# Mother\n\nRaw tail";
    const generated = splitVersionPayload(generatedDocument);
    const next = replaceLeadingFrontmatter(mother, generated.frontmatter);
    expect(next.match(/^---$/gm)).toHaveLength(2);
    expect(next).toContain("mode: seminar");
    expect(next).not.toContain("mode: synthesis");
    expect(next).toContain("# Mother\n\nRaw tail");
  });

  it("never allows YAML to leak into an active version body", () => {
    const clean = sanitizeActiveVersionBody(generatedDocument);
    // 活动块嵌在母本自己的标题之下：正文里的一级标题一律剥掉，母本全文只保留一条标题。
    expect(clean).toBe("Generated body.");
    expect(clean).not.toContain("mode: seminar");
    expect(clean).not.toMatch(/^---/);
  });

  it("strips derived-note titles and self backlinks before embedding into the mother", () => {
    const derived = [
      "# 个人笔记 · 2026-09-18 1107",
      "",
      "> [!info] 基于原始转写重新生成 · 原始纪要：[[2026-09-18 1107]]",
      "",
      "> [!abstract] 摘要",
      "> 正文内容。",
    ].join("\n");
    expect(sanitizeActiveVersionBody(derived)).toBe("> [!abstract] 摘要\n> 正文内容。");

    const cleanScript = [
      "# [清稿] 2026-09-18 1107",
      "",
      "> [!note] 从母本逐字稿忠实清理的可读稿（非纪要、不摘要）。母本（事实源 / 逐字稿）：[[2026-09-18 1107]]",
      "",
      "> [!warning] 清稿可能被截断",
      "",
      "清理后的正文。",
    ].join("\n");
    expect(sanitizeActiveVersionBody(cleanScript)).toBe("> [!warning] 清稿可能被截断\n\n清理后的正文。");

    // 普通正文与二级标题不受影响；只剩标题时回退到空内容标记。
    expect(sanitizeActiveVersionBody("> [!abstract] 摘要\n> 正文")).toBe("> [!abstract] 摘要\n> 正文");
    expect(sanitizeActiveVersionBody("## 章节\n正文")).toBe("## 章节\n正文");
    expect(sanitizeActiveVersionBody("# OnlyTitle")).toBe("_[当前版本无内容]_");
  });

  it("drops canonical and legacy derived bookkeeping keys but keeps content fields", () => {
    const yaml = [
      "qnalog_mode: monologue",
      "qnalog_time: 2026-09-18T11:07:46",
      "qnalog_status: organized",
      "tags:",
      "  - qnalog/monologue",
      "  - 主题/视频制作",
      "qnalog_type: QnALog派生版本",
      "类型: QnALog派生版本",
      "variant_kind: minutes",
      "variant_label: 个人笔记",
      "variant_mode: monologue",
      "qnalog_source_path: \"QnALog/转写纪要/2026-09-18 1107.md\"",
      "source_path: \"QnALog/转写纪要/old.md\"",
      "source_id: qnalog-mu6doqqg-vglxge",
      "qnalog_contains_raw: false",
      "contains_raw: false",
      "created: 2026-09-23 16:03:59",
    ].join("\n");
    const stripped = stripVersionBookkeepingFrontmatter(yaml);
    expect(stripped).toContain("qnalog_mode: monologue");
    expect(stripped).toContain("qnalog_time: 2026-09-18T11:07:46");
    expect(stripped).toContain("qnalog_status: organized");
    expect(stripped).toContain("- qnalog/monologue");
    expect(stripped).toContain("  - 主题/视频制作");
    for (const key of ["qnalog_type", "类型", "variant_kind", "variant_label", "variant_mode", "qnalog_source_path", "source_path", "source_id", "qnalog_contains_raw", "contains_raw", "created"]) {
      expect(stripped).not.toContain(key);
    }
    expect(stripVersionBookkeepingFrontmatter("")).toBe("");
  });

  it("reads legacy cache bodies that begin with generated frontmatter", () => {
    const cacheFile = "---\ntype: cache\n---\n\n" + generatedDocument;
    const cache = splitLeadingFrontmatter(cacheFile);
    const legacy = splitVersionPayload(cache.body);
    expect(legacy.frontmatter).toContain("mode: seminar");
    expect(legacy.body).toContain("Generated body.");
  });

  it("keeps the mother YAML when a body-only version is applied", () => {
    const mother = "---\nmode: synthesis\n---\n\n# Mother";
    expect(replaceLeadingFrontmatter(mother, "")).toBe(mother);
    expect(sanitizeActiveVersionBody("# Clean script\n\n清理后的正文")).toBe("清理后的正文");
  });

  it("repairs a mother note that already contains duplicate YAML in its active block", () => {
    const malformed = [
      "---",
      "mode: synthesis",
      "topic: Old",
      "---",
      "# Mother",
      "<!-- qnalog-active-version-start -->",
      "> [!info] Current version",
      "",
      generatedDocument,
      "<!-- qnalog-active-version-end -->",
      "",
      "---",
      "",
      "<details>Raw transcript</details>",
    ].join("\n");
    const generated = splitVersionPayload(generatedDocument);
    const withCurrentYaml = replaceLeadingFrontmatter(malformed, generated.frontmatter);
    const block = [
      "<!-- qnalog-active-version-start -->",
      "> [!info] Current version",
      "",
      sanitizeActiveVersionBody(generatedDocument),
      "<!-- qnalog-active-version-end -->",
    ].join("\n");
    const repaired = replaceExistingActiveVersionBlock(withCurrentYaml, block);

    expect(repaired).not.toBeNull();
    expect(repaired!.match(/^---$/gm)).toHaveLength(3);
    expect(repaired!.slice(0, repaired!.indexOf("<!-- qnalog-active-version-end -->"))).not.toContain("mode: synthesis");
    expect(repaired!.slice(0, repaired!.indexOf("<!-- qnalog-active-version-end -->"))).toContain("mode: seminar");
    expect(repaired).toContain("<details>Raw transcript</details>");
  });
});

describe("母本标题跟随当前显示版本", () => {
  it("改写日期时间标题的模式段并消灭录音中占位", () => {
    const mother = [
      "---",
      "mode: synthesis",
      "---",
      "",
      "# 2026-09-18 11:07 · 综合纪要（录音中…）",
      "",
      "正文。",
    ].join("\n");
    const out = applyVersionTitle(mother, "个人笔记");
    expect(out).toContain("# 2026-09-18 11:07 · 个人笔记");
    expect(out).not.toContain("录音中");
    expect(out).toContain("mode: synthesis");
    expect(out.split("\n").filter((line) => line.startsWith("# "))).toHaveLength(1);
    // 幂等：已是目标标题时原样返回
    expect(applyVersionTitle(out, "个人笔记")).toBe(out);
    // 版本标签带整理偏好时只取模式段
    expect(applyVersionTitle(mother, "个人笔记 · 更详细")).toContain("# 2026-09-18 11:07 · 个人笔记");
  });

  it("不动用户自定义的非日期标题，也绝不插入第二条", () => {
    const custom = "# 我的随手记\n\n正文。";
    expect(applyVersionTitle(custom, "个人笔记", "2026-09-18 11:07")).toBe(custom);
  });

  it("无标题母本在回退日期存在时补插一条标题", () => {
    const headless = [
      "---",
      "mode: synthesis",
      "---",
      "",
      "<!-- qnalog-active-version-start -->",
      "> [!info] 当前显示版本：综合纪要",
      "<!-- qnalog-active-version-end -->",
    ].join("\n");
    const withTitle = applyVersionTitle(headless, "综合纪要", "2026-09-17T19:59:16");
    expect(withTitle).toContain("# 2026-09-17 19:59 · 综合纪要\n\n<!-- qnalog-active-version-start -->");
    expect(withTitle).toContain("mode: synthesis");
    expect(withTitle.split("\n").filter((line) => line.startsWith("# "))).toHaveLength(1);
    // 没有可用日期时间就不硬造标题
    const noDate = "<!-- qnalog-active-version-start -->\nx\n<!-- qnalog-active-version-end -->";
    expect(applyVersionTitle(noDate, "综合纪要")).toBe(noDate);
    expect(applyVersionTitle(noDate, "综合纪要", "下周三")).toBe(noDate);
  });

  it("归一化标题日期时间来源", () => {
    expect(normalizeTitleDatetime("2026-09-18T11:07:46")).toBe("2026-09-18 11:07");
    expect(normalizeTitleDatetime("2026-09-23 16:03:59")).toBe("2026-09-23 16:03");
    expect(normalizeTitleDatetime("2026-09-17 19:59:16")).toBe("2026-09-17 19:59");
    expect(normalizeTitleDatetime("2026-09-17")).toBe("2026-09-17");
    expect(normalizeTitleDatetime("下周三")).toBe("");
    expect(normalizeTitleDatetime("")).toBe("");
  });
});

describe("原始转写区折叠", () => {
  const bareMother = [
    "# 2026-09-18 11:07 · 个人笔记",
    "",
    "<!-- qnalog-active-version-start -->",
    "> [!info] 当前显示版本：个人笔记",
    "",
    "正文。",
    "",
    "<!-- qnalog-active-version-end -->",
    "",
    "---",
    "",
    "<!-- qnalog-segments-start:qnalog-s1 -->",
    "",
    "### 段落 1 (00:00–00:10) [[a.webm|00:00]]",
    "",
    "转写一。",
    "",
    "<!-- qnalog-segments-end:qnalog-s1 -->",
    "",
    "<!-- qnalog-session:qnalog-s1 -->",
  ].join("\n");

  it("裸露分段折叠进分段原始转写区并补原始材料标题（zh 界面）", () => {
    setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
    const folded = foldRawTranscriptSection(bareMother);
    expect(folded).toContain("## 原始材料");
    expect(folded).toContain("<summary>分段原始转写（1 段）</summary>");
    expect(folded).toContain("### 段落 1 (00:00–00:10)");
    expect(folded.indexOf("## 原始材料")).toBeLessThan(folded.indexOf("<details>"));
    expect(folded.indexOf("</details>")).toBeLessThan(folded.indexOf("<!-- qnalog-session:qnalog-s1 -->"));
    // 幂等：再跑一次原样返回
    expect(foldRawTranscriptSection(folded)).toBe(folded);
  });

  it("en 界面折叠产出英文标签，守卫同样命中（幂等、不重复折叠）", () => {
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    const folded = foldRawTranscriptSection(bareMother);
    expect(folded).toContain("## Original material");
    expect(folded).toContain("<summary>Segmented raw transcript (1 segments)</summary>");
    expect(folded).toContain("### 段落 1 (00:00–00:10)");
    expect(folded.indexOf("## Original material")).toBeLessThan(folded.indexOf("<details>"));
    expect(folded.indexOf("</details>")).toBeLessThan(folded.indexOf("<!-- qnalog-session:qnalog-s1 -->"));
    // 幂等：en 守卫（## Original material / Segmented raw transcript）命中，原样返回
    expect(foldRawTranscriptSection(folded)).toBe(folded);
  });

  it("已有原始材料标题或没有版本块的文档原样返回", () => {
    const healthy = [
      "# T",
      "",
      "<!-- qnalog-active-version-start -->",
      "b",
      "<!-- qnalog-active-version-end -->",
      "",
      "---",
      "",
      "## 原始材料",
      "",
      "<details>\n<summary>分段原始转写（1 段）</summary>\n\n### 段落 1 (00:00–00:10) x\n\n</details>",
    ].join("\n");
    expect(foldRawTranscriptSection(healthy)).toBe(healthy);
    // 解析双语（与界面语言无关）：等价英文母本同样被守卫拦下、原样返回
    const healthyEn = healthy
      .replace("## 原始材料", "## Original material")
      .replace("分段原始转写（1 段）", "Segmented raw transcript (1 segments)");
    expect(foldRawTranscriptSection(healthyEn)).toBe(healthyEn);
    const noBlock = "# T\n\n<!-- qnalog-segments-start:s -->\nx\n<!-- qnalog-segments-end:s -->";
    expect(foldRawTranscriptSection(noBlock)).toBe(noBlock);
    expect(foldRawTranscriptSection("")).toBe("");
  });
});
