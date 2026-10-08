import { vi } from "vitest";
vi.mock("obsidian", () => ({
  TFile: class TFile {},
  TFolder: class TFolder {},
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
}));
import { describe, expect, it } from "vitest";
import { getSegmentsDurationMs as getAudioSegmentsDurationMs } from "../src/notes/audio-refs";
import {
  applyBriefingLanguageInstruction,
  getBriefingTargetLanguage,
  getSegmentsDurationMs as getTextSegmentsDurationMs,
  getSessionMetaDurationMs,
  parseDurationLabel,
  parseElapsedMsToken,
  splitLongTextForLlm,
  truncateForLlmPrompt,
} from "../src/shared/util-text";
import { NS_FM } from "../src/shared/namespace";

describe("text utility contracts", () => {
  it("keeps the separate absolute-audio and text-span duration semantics", () => {
    const segment = { startOffsetMs: 61_000, endOffsetMs: 65_000 };
    expect(getAudioSegmentsDurationMs([segment])).toBe(65_000);
    expect(getAudioSegmentsDurationMs(new Set([segment]))).toBe(65_000);
    expect(getTextSegmentsDurationMs([segment])).toBe(4_000);
    expect(getTextSegmentsDurationMs([segment, { startOffsetMs: Infinity, endOffsetMs: NaN }])).toBe(4_000);
    expect(getTextSegmentsDurationMs([{ startOffsetMs: 0, endOffsetMs: 4_000 }])).toBe(4_000);
    expect(getTextSegmentsDurationMs(new Set([segment]) as unknown as Parameters<typeof getTextSegmentsDurationMs>[0])).toBe(0);
    for (const segments of [undefined, null, []]) {
      expect(getAudioSegmentsDurationMs(segments)).toBe(0);
      expect(getTextSegmentsDurationMs(segments)).toBe(0);
    }
  });

  it("parses elapsed tokens and duration labels with existing rounding and coercion", () => {
    expect(parseElapsedMsToken("time 1:02:03")).toBe(3_723_000);
    expect(parseElapsedMsToken("00:12")).toBe(12_000);
    for (const value of ["", "  ", "no time"]) expect(parseElapsedMsToken(value)).toBe(0);
    expect(parseDurationLabel(" 1.5分钟 ")).toBe(90_000);
    expect(parseDurationLabel("1.25秒")).toBe(1_250);
    expect(parseDurationLabel("01:02")).toBe(62_000);
    expect(parseDurationLabel("")).toBe(0);
    expect(parseDurationLabel(null)).toBe(0);
    expect(parseDurationLabel({ toString: () => "00:12" })).toBe(12_000);
    const failure = new Error("string conversion failed");
    expect(() => parseDurationLabel({ toString: () => { throw failure; } })).toThrow(failure);
  });

  it("keeps metadata duration precedence and namespace fallback", () => {
    expect(getSessionMetaDurationMs({ durationMs: 1_234, elapsedMs: 2_345, totalMs: 3_456 })).toBe(1_234);
    expect(getSessionMetaDurationMs({ elapsedMs: 2_345, totalMs: 3_456 })).toBe(2_345);
    expect(getSessionMetaDurationMs({ totalMs: 3_456 })).toBe(3_456);
    expect(getSessionMetaDurationMs({ durationMs: 0, elapsedMs: 0, totalMs: 0, [NS_FM.duration]: "00:12", duration: "2秒" })).toBe(12_000);
    expect(getSessionMetaDurationMs({ durationMs: -1, elapsedMs: 1_000, duration: "2秒" })).toBe(2_000);
    for (const meta of [undefined, null]) expect(getSessionMetaDurationMs(meta)).toBe(0);
  });

  it("applies configured briefing language branches without changing the prompt when off", () => {
    const settings = {
      briefingTranslationMode: "translate",
      briefingTargetLanguage: "custom",
      briefingCustomLanguage: " French ",
      briefingKeepOriginalTerms: false,
      briefingLanguageInstruction: " Preserve names ",
    };
    const translated = applyBriefingLanguageInstruction("PROMPT", settings);
    expect(translated.startsWith("PROMPT\n\n---\n\n")).toBe(true);
    expect(translated.match(/^- 目标语言：French。$/gm)).toHaveLength(1);
    expect(translated.match(/^- 额外要求：Preserve names$/gm)).toHaveLength(1);
    expect(translated).not.toContain("- 人名、组织名、产品名、模型名、代码标识、英文缩写和行业术语");
    expect(applyBriefingLanguageInstruction("PROMPT", { briefingTranslationMode: "off" })).toBe("PROMPT");
    const bilingual = applyBriefingLanguageInstruction("PROMPT", { briefingTranslationMode: "bilingual" });
    expect(bilingual).toContain("- 输出以目标语言为主；");
    expect(bilingual).not.toContain("- 输出正文统一使用目标语言。");
    expect(getBriefingTargetLanguage({ briefingTargetLanguage: "xx" })).toBe("xx");
    expect(getBriefingTargetLanguage({ briefingTargetLanguage: "custom", briefingCustomLanguage: "  " })).toBe("用户指定语言");
  });

  it("preserves prompt truncation and long-text chunk boundaries", () => {
    expect(truncateForLlmPrompt("ABCDE", 3)).toBe("ABC\n\n_[QnALog：此处为长文本预处理截断，仅用于分段摘要；完整原文仍保留在笔记折叠区。]_");
    expect(truncateForLlmPrompt("ABCDE", 0)).toBe("ABCDE");
    expect(truncateForLlmPrompt("ABCDE", 5)).toBe("ABCDE");
    expect(splitLongTextForLlm("  A  ", undefined)).toEqual(["A"]);
    expect(splitLongTextForLlm("A".repeat(1999) + "\n\nB", 2000)).toEqual(["A".repeat(1999), "B"]);
    expect(splitLongTextForLlm("A".repeat(2001), 2000)).toEqual(["A".repeat(2000), "A"]);
    expect(splitLongTextForLlm(" \n\n ", 2000)).toEqual([]);
  });
});
