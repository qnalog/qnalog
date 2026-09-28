import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
}));
// vitest 跑在 Node 环境，没有 window；appendAskEntry 读 window.moment（缺省回退 Date）。
vi.stubGlobal("window", {});

import { appendAskEntry, findAskBoundary, normalizeAskSections, stripAskBlocks } from "../src/notes/ask-panel";
import { resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

// 问一问区的解析必须中英双语（老笔记中文、新笔记随界面语言），且与当前界面语言无关；
// 写入（appendAskEntry 的 `## 问一问` / `> [!summary] 问一问`）随界面语言取词。
// 历史 bug：`\b` 接在中文词后（前一字符非 \w）在换行前不成立，zh 区块从未被剥离/识别——
// 下面的 zh 断言在修复前是红的。

const zhNote = [
  "# T",
  "",
  "## 问一问",
  "",
  "### 2026-09-24 10:00",
  "",
  "> [!summary] 问一问",
  "> 旧答案。",
  "",
  "## 📁 原始材料",
  "",
  "转写。",
].join("\n");

const enNote = [
  "# T",
  "",
  "## Q&A",
  "",
  "### 2026-09-24 10:00",
  "",
  "> [!summary] Q&A",
  "> Old answer.",
  "",
  "## 📁 Original material",
  "",
  "Transcript.",
].join("\n");

describe("stripAskBlocks：问一问区双语剥离到原始材料为止", () => {
  it("zh：剥离 ## 问一问 区，原始材料及其后保留", () => {
    expect(stripAskBlocks(zhNote)).toBe("# T\n\n\n## 📁 原始材料\n\n转写。");
  });

  it("en：剥离 ## Q&A 区，结果与 zh 同构", () => {
    expect(stripAskBlocks(enNote)).toBe("# T\n\n\n## 📁 Original material\n\nTranscript.");
  });
});

describe("findAskBoundary：边界落在原始材料标题前（双语）", () => {
  it("zh/en 都能定位到原始材料行首", () => {
    expect(zhNote.slice(findAskBoundary(zhNote))).toBe("\n## 📁 原始材料\n\n转写。");
    expect(enNote.slice(findAskBoundary(enNote))).toBe("\n## 📁 Original material\n\nTranscript.");
  });
});

describe("normalizeAskSections：多段问一问合并（双语、输出标题随界面语言）", () => {
  const zhIn = "前文\n## 问一问\n\nA\n## 问一问\n\nB";
  const enIn = "前文\n## Q&A\n\nA\n## Q&A\n\nB";

  it("zh 界面：中英输入合并结果等价（输出 zh 标题）", () => {
    setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
    expect(normalizeAskSections(zhIn)).toBe(normalizeAskSections(enIn));
    expect(normalizeAskSections(zhIn)).toContain("## 问一问");
    expect(normalizeAskSections(zhIn).match(/\n## /g)).toHaveLength(1);
  });

  it("en 界面：中英输入合并结果等价（输出 en 标题）", () => {
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    expect(normalizeAskSections(zhIn)).toBe(normalizeAskSections(enIn));
    expect(normalizeAskSections(zhIn)).toContain("## Q&A");
    expect(normalizeAskSections(zhIn).match(/\n## /g)).toHaveLength(1);
  });
});

describe("appendAskEntry：写入标题与 callout 随界面语言，重复追加不叠标题", () => {
  it("zh 界面写 `## 问一问` 与 `> [!summary] 问一问`", () => {
    setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
    const out = appendAskEntry("# T", "问题？", "回答。");
    expect(out).toContain("## 问一问");
    expect(out).toContain("> [!summary] 问一问");
    expect(out).not.toContain("Q&A");
  });

  it("en 界面写 `## Q&A`；往 zh 旧笔记追加不产生第二个区标题", () => {
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    const fresh = appendAskEntry("# T", "Q?", "A!");
    expect(fresh).toContain("## Q&A");
    expect(fresh).toContain("> [!summary] Q&A");
    expect(fresh.match(/\n## /g)).toHaveLength(1);

    const appended = appendAskEntry(zhNote, "Q?", "A!");
    // 区标题双语命中：只追加条目，不叠出第三条 `## `。
    // 旧 zh 标题在归一化时切到当前界面语言（与 version-content 的 en 补题一致），写入侧按新语言落盘。
    expect(appended.match(/\n## /g)).toHaveLength(2); // ## Q&A + ## 📁 原始材料
    expect(appended).toContain("> [!summary] Q&A");
    expect(appended).toContain("## Q&A");
    expect(appended).not.toContain("## 问一问");
  });
});
