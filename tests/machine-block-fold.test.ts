import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
}));

import { NS_MACHINE_SHELL_RE, NS_SEDIMENT_BLOCK_RE, NS_SEDIMENT_LINE_BEGIN_RE } from "../src/shared/namespace";
import {
  appendSedimentPreExtractionBlock,
  extractSedimentPreExtractionBlock,
  formatSedimentPreExtractionBlock,
  getSedimentPreExtractionBlockPatterns,
  splitOutSedimentBlock,
  stripSedimentPreExtractionBlocks,
} from "../src/sediment";
import { foldRawTranscriptSection } from "../src/version-content";
import { stripImportAppendices } from "../src/notes/note-markdown";

const OBJECTS = {
  people: [{ name: "张三", aliases: ["老张"], role: "负责人", organization: "一组", note: "牵头", confidence: "高", evidence: ["决定周三交付"] }],
  todos: [{ task: "提交方案", owner: "张三", due: "周三", sourceTime: "12:34", note: "会上确认", subtasks: ["整理初稿", "发给评审"] }],
  hotwords: { people: [], brands: [], projects: ["QnALog"], terms: [], corrections: ["Hugging Face"], other: [] },
};

function legacyBlock(objects = OBJECTS) {
  return ["<!--QNALOG_SEDIMENT_BEGIN", JSON.stringify(objects), "QNALOG_SEDIMENT_END-->"].join("\n");
}

describe("尾部机器块：折叠壳新格式", () => {
  it("沉淀块序列化为「标记在外、details+json 围栏在内」，读回等价", () => {
    const block = formatSedimentPreExtractionBlock(OBJECTS);
    expect(block.startsWith("<!--QNALOG_SEDIMENT_BEGIN-->")).toBe(true);
    expect(block.endsWith("<!--QNALOG_SEDIMENT_END-->")).toBe(true);
    expect(block).toContain("<summary>沉淀数据</summary>");
    expect(block).toContain("```json");
    // 标记行仍在块首行，ask 边界与行首判断继续命中。
    expect(NS_SEDIMENT_LINE_BEGIN_RE.exec(`\n${block}`)?.index).toBe(1);

    const extracted = extractSedimentPreExtractionBlock(`# 正文\n\n${block}`);
    expect(extracted.found).toBe(true);
    expect(extracted.objects?.people?.[0]?.name).toBe("张三");
    expect(extracted.objects?.todos?.[0]?.task).toBe("提交方案");
    expect(extracted.cleaned).not.toContain("沉淀数据");
    expect(extracted.cleaned).not.toContain("QNALOG_SEDIMENT");
    expect(extracted.cleaned).not.toContain("<details>");
    expect(extracted.cleaned).toContain("# 正文");
  });

  it("旧的单注释格式仍能读出（读旧写新）", () => {
    const extracted = extractSedimentPreExtractionBlock(`# 正文\n\n${legacyBlock()}`);
    expect(extracted.objects?.people?.[0]?.name).toBe("张三");
    expect(extracted.cleaned).not.toContain("QNALOG_SEDIMENT");
  });

  it("splitOut 把整个折叠壳搬走，不留孤儿壳", () => {
    const note = `# 正文\n\n内容。\n\n${formatSedimentPreExtractionBlock(OBJECTS)}\n\n## 原始材料\n\n原始。`;
    const { body, block } = splitOutSedimentBlock(note);
    expect(block).toContain("</details>");
    expect(block).toContain("QNALOG_SEDIMENT_BEGIN");
    expect(body).not.toContain("<details>");
    expect(body).not.toContain("QNALOG_SEDIMENT");
    expect(body).toContain("## 原始材料");

    // 旧格式同行为。
    const legacy = `# 正文\n\n${legacyBlock()}`;
    const splitLegacy = splitOutSedimentBlock(legacy);
    expect(splitLegacy.block).toContain("QNALOG_SEDIMENT_BEGIN");
    expect(splitLegacy.body).not.toContain("QNALOG_SEDIMENT");
  });

  it("strip 对新旧两种格式都剥干净（含折叠壳）", () => {
    const withFenced = appendSedimentPreExtractionBlock("# 正文", OBJECTS);
    expect(withFenced).toContain("沉淀数据");
    const strippedNew = stripSedimentPreExtractionBlocks(withFenced);
    expect(strippedNew).not.toContain("<details>");
    expect(strippedNew).not.toContain("QNALOG_SEDIMENT");
    expect(strippedNew).toContain("# 正文");

    const strippedLegacy = stripSedimentPreExtractionBlocks(`# 正文\n\n${legacyBlock()}\n\n尾巴`);
    expect(strippedLegacy).not.toContain("QNALOG_SEDIMENT");
    expect(strippedLegacy).toContain("尾巴");
  });

  it("NS_SEDIMENT_BLOCK_RE 整块吞下新格式（stash/搬运不断壳）", () => {
    const block = formatSedimentPreExtractionBlock(OBJECTS);
    const match = NS_SEDIMENT_BLOCK_RE.exec(`前文\n${block}\n后文`);
    expect(match).not.toBeNull();
    expect(match?.[0]).toContain("<details>");
    expect(match?.[0]).toContain("</details>");
    expect(match?.[0].split("QNALOG_SEDIMENT_BEGIN").length - 1).toBe(1);
    NS_SEDIMENT_BLOCK_RE.lastIndex = 0;
  });

  it("任一命中模式的整段匹配都吞下折叠壳（strip 不留孤儿壳）", () => {
    const patterns = getSedimentPreExtractionBlockPatterns(false);
    const block = formatSedimentPreExtractionBlock(OBJECTS);
    const matched = patterns.map((pattern) => pattern.exec(block)).find((m) => m);
    expect(matched).toBeTruthy();
    expect(matched?.[0]).toContain("<details>");
    expect(matched?.[0]).toContain("</details>");
    expect(matched?.[0]).toContain("QNALOG_SEDIMENT_END");
  });
});

describe("共享机器壳正则与附录剔除", () => {
  it("只剔除索引/沉淀折叠壳，不碰其它 details", () => {
    const note = [
      "<details>",
      "<summary>分段原始转写（1 段）</summary>",
      "",
      "### 段落 1",
      "",
      "转写正文。",
      "",
      "</details>",
      "",
      "<!-- qnalog-note-index -->",
      "<details>",
      "<summary>索引数据</summary>",
      "",
      "```json",
      '{"schemaVersion":1}',
      "```",
      "",
      "</details>",
      "<!-- qnalog-note-index-end -->",
    ].join("\n");
    const stripped = note.replace(NS_MACHINE_SHELL_RE, "\n");
    expect(stripped).not.toContain("索引数据");
    expect(stripped).not.toContain("schemaVersion");
    expect(stripped).toContain("分段原始转写");
    expect(stripped).toContain("转写正文。");
    NS_MACHINE_SHELL_RE.lastIndex = 0;
  });

  it("stripImportAppendices 连同索引标记一起清出提示词素材", () => {
    const note = [
      "# 纪要",
      "",
      "正文。",
      "",
      "<!-- qnalog-note-index -->",
      "<details>",
      "<summary>索引数据</summary>",
      "",
      "```json",
      '{"schemaVersion":1,"sourceRevision":"rev-1"}',
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
      '{"todos":[{"task":"提交方案"}]}',
      "```",
      "",
      "</details>",
      "<!--QNALOG_SEDIMENT_END-->",
    ].join("\n");
    const stripped = stripImportAppendices(note);
    expect(stripped).not.toContain("qnalog-note-index");
    expect(stripped).not.toContain("索引数据");
    expect(stripped).not.toContain("沉淀数据");
    expect(stripped).not.toContain("sourceRevision");
    expect(stripped).not.toContain("提交方案");
    expect(stripped).toContain("# 纪要");
    expect(stripped).toContain("正文。");
  });
});

describe("foldRawTranscriptSection 锚点不落进机器壳", () => {
  const head = [
    "<!-- qnalog-active-version-start -->",
    "> [!info] 当前显示版本：个人笔记",
    "",
    "正文。",
    "<!-- qnalog-active-version-end -->",
  ].join("\n");
  const machineShell = [
    "<!-- qnalog-note-index -->",
    "<details>",
    "<summary>索引数据</summary>",
    "",
    "```json",
    '{"schemaVersion":1}',
    "```",
    "",
    "</details>",
    "<!-- qnalog-note-index-end -->",
  ].join("\n");

  it("裸尾只有机器壳时不插入「原始材料」标题", () => {
    const note = `${head}\n\n<!-- qnalog-session:qnalog-s1 -->\n\n${machineShell}\n`;
    const folded = foldRawTranscriptSection(note);
    expect(folded).toBe(note);
    expect(folded).not.toContain("## 原始材料");
  });

  it("分段块在机器壳之前时，标题落在分段折叠区前、机器壳不受影响", () => {
    const segments = [
      "<!-- qnalog-segments-start:qnalog-s2 -->",
      "### 段落 1 (00:00–00:10)",
      "",
      "逐字内容。",
      "<!-- qnalog-segments-end:qnalog-s2 -->",
    ].join("\n");
    const note = `${head}\n\n${segments}\n\n<!-- qnalog-session:qnalog-s2 -->\n\n${machineShell}\n`;
    const folded = foldRawTranscriptSection(note);
    expect(folded).toContain("## 原始材料");
    expect(folded.indexOf("## 原始材料")).toBeLessThan(folded.indexOf("分段原始转写"));
    expect(folded.indexOf("分段原始转写")).toBeLessThan(folded.indexOf("qnalog-segments-start"));
    expect(folded.indexOf("</details>\n<!-- qnalog-note-index-end -->")).toBeGreaterThan(folded.indexOf("## 原始材料"));
    expect(folded).toContain('"schemaVersion":1');
    // 幂等：再跑一次原样返回。
    expect(foldRawTranscriptSection(folded)).toBe(folded);
  });
});
