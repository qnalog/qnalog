import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  UI_LANGUAGES,
  getActiveUiLanguage,
  matchUiLanguage,
  setActiveUiLanguage,
  translateInto,
} from "../src/shared/i18n";
import {
  INFO_LINE_WORDS_RE,
  NOTE_LABELS,
  PART_HEADING_RE,
  UTILITY_HEADING_RE,
  fmKey,
  labelText,
  labelPattern,
} from "../src/shared/note-labels";

// 笔记结构标签的契约测试。写入侧按当前界面语言产出标签，解析侧中英两套都要认
// （老笔记中文、新笔记随生成时语言）。目录条目用 t(变量) 取词，i18n 的覆盖检查
// 扫不到这一层，所以这里逐条兜住「每个键都有中文译文」与「两种语言渲染都可解析」。

const root = path.resolve(__dirname, "..");
const zhRaw = fs.readFileSync(path.join(root, "src/shared/i18n/locales/zh.ts"), "utf8");
const tableKeys = new Set(
  [...zhRaw.matchAll(/^  "((?:[^"\\]|\\.)*)":/gm)].map((m) => JSON.parse(`"${m[1]}"`)),
);

const entries = Object.entries(NOTE_LABELS);

/** 按目录登记的占位符个数填充样例参数。 */
function renderSample(key: string, params: number, langId: string): string {
  const lang = UI_LANGUAGES.find((l) => l.id === langId);
  let out = translateInto(lang, key);
  for (let i = 0; i < params; i++) out = out.split(`{${i}}`).join("12");
  return out;
}

describe("目录完整性", () => {
  it("每个目录条目在 zh.ts 都有译文（t(变量) 扫不到，靠这层兜住）", () => {
    const missing = entries.map(([, s]) => s.key).filter((k) => !tableKeys.has(k));
    expect(missing, `缺中文：${missing.slice(0, 5).join(" / ")}`).toEqual([]);
  });

  it("条目齐全且键名是小驼峰、key 非空、re 是正则", () => {
    expect(entries.length).toBeGreaterThanOrEqual(55);
    for (const [name, spec] of entries) {
      expect(name, name).toMatch(/^[a-z][A-Za-z0-9]*$/);
      expect(spec.key, name).toBeTruthy();
      expect(spec.re, name).toBeInstanceOf(RegExp);
    }
  });

  it("params 与 key 里的 {n} 占位符个数一致（测试据此填样例参数）", () => {
    for (const [name, spec] of entries) {
      const holes = new Set(spec.key.match(/\{\d+\}/g) || []);
      expect(spec.params ?? 0, name).toBe(holes.size);
    }
  });
});

describe("双语渲染可解析", () => {
  it("每个条目在每种已登记语言下的完整渲染都能被其模式匹配", () => {
    const failures: string[] = [];
    for (const [name, spec] of entries) {
      for (const lang of UI_LANGUAGES) {
        const rendered = renderSample(spec.key, spec.params ?? 0, lang.id);
        if (!spec.re.test(rendered)) failures.push(`${name}@${lang.id}: ${rendered}`);
      }
    }
    expect(failures, `解析失配：\n${failures.slice(0, 8).join("\n")}`).toEqual([]);
  });

  it("labelPattern 返回的模式同样中英都认", () => {
    const re = labelPattern("segmentedRawTranscript");
    expect(re.test("分段原始转写（3 段）")).toBe(true);
    expect(re.test("Segmented raw transcript (3 segments)")).toBe(true);
  });
});

describe("labelText 按界面语言取词并填充占位符", () => {
  it("中文返回译文、英文返回源文本，{0}{1} 按序替换", () => {
    const original = getActiveUiLanguage();
    try {
      setActiveUiLanguage(matchUiLanguage("zh") as never);
      expect(labelText("originalMaterial")).toBe("原始材料");
      expect(labelText("segment", 3)).toBe("段落 3");
      expect(labelText("segmentRange", 3, "00:10", "00:20")).toBe("段落 3（00:10–00:20）");
      expect(labelText("mergedVersionAt", "MiMo")).toBe("整合版（MiMo）");
      setActiveUiLanguage(matchUiLanguage("en") as never);
      expect(labelText("originalMaterial")).toBe("Original material");
      expect(labelText("segment", 3)).toBe("Segment 3");
      expect(labelText("segmentRange", 3, "00:10", "00:20")).toBe("Segment 3 (00:10–00:20)");
      expect(labelText("mergedVersionAt", "MiMo")).toBe("Merged version (MiMo)");
    } finally {
      setActiveUiLanguage(original);
    }
  });

  it("未知标签名报错，不静默返回裸键名", () => {
    expect(() => labelText("doesNotExist")).toThrow(/Unknown note label/);
    expect(() => labelPattern("doesNotExist")).toThrow(/Unknown note label/);
  });
});

describe("fmKey：frontmatter 系统键跟随界面语言", () => {
  it("zh 返回 时长/状态/人物，en 返回 duration/status/people", () => {
    const original = getActiveUiLanguage();
    try {
      setActiveUiLanguage(matchUiLanguage("zh") as never);
      expect(fmKey("duration")).toBe("时长");
      expect(fmKey("status")).toBe("状态");
      expect(fmKey("people")).toBe("人物");
      setActiveUiLanguage(matchUiLanguage("en") as never);
      expect(fmKey("duration")).toBe("duration");
      expect(fmKey("status")).toBe("status");
      expect(fmKey("people")).toBe("people");
    } finally {
      setActiveUiLanguage(original);
    }
  });

  it("地区变体（zh-TW 归一到 zh）也返回中文键", () => {
    const original = getActiveUiLanguage();
    try {
      setActiveUiLanguage(matchUiLanguage("zh-TW") as never);
      expect(fmKey("duration")).toBe("时长");
    } finally {
      setActiveUiLanguage(original);
    }
  });
});

describe("共享解析片段", () => {
  it("UTILITY_HEADING_RE 中英都认，且不误伤普通议题标题", () => {
    expect(UTILITY_HEADING_RE.test("原始材料")).toBe(true);
    expect(UTILITY_HEADING_RE.test("Original material")).toBe(true);
    expect(UTILITY_HEADING_RE.test("会中补充材料")).toBe(true);
    expect(UTILITY_HEADING_RE.test("Material added during the meeting")).toBe(true);
    expect(UTILITY_HEADING_RE.test("讨论议题")).toBe(false);
    expect(UTILITY_HEADING_RE.test("Agenda")).toBe(false);
  });

  it("INFO_LINE_WORDS_RE 认中英信息行词，半角/全角冒号都可", () => {
    expect(INFO_LINE_WORDS_RE.test("时间：2026-09-28")).toBe(true);
    expect(INFO_LINE_WORDS_RE.test("Duration: 03:56")).toBe(true);
    expect(INFO_LINE_WORDS_RE.test("状态: 已整理")).toBe(true);
    expect(INFO_LINE_WORDS_RE.test("Model: MiMo")).toBe(true);
    expect(INFO_LINE_WORDS_RE.test("备注：不是信息行")).toBe(false);
  });

  it("PART_HEADING_RE 认「第 N 部分 / Part N」，含 1/3 分母形式", () => {
    expect(PART_HEADING_RE.test("第 3 部分")).toBe(true);
    expect(PART_HEADING_RE.test("第 1/3 部分 · 00:10–00:20（原始转写保底）")).toBe(true);
    expect(PART_HEADING_RE.test("Part 3")).toBe(true);
    expect(PART_HEADING_RE.test("Part 2/4")).toBe(true);
    expect(PART_HEADING_RE.test("分部说明")).toBe(false);
  });
});
