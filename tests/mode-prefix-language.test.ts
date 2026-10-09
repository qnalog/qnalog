import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
}));
import { setActiveUiLanguage, resolveUiLanguage } from "../src/shared/i18n";
import { getModeMeta, getModePrefix, getModeDisplayName, isKnownPolishMode } from "../src/shared/mode-meta";
import { normalizeModeFromLabel } from "../src/shared/mode-label";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";

describe("模板前缀随语言", () => {
  it("英文界面写英文标题，中文界面写中文标题；两种都能解析回同一模式", () => {
    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    const meta = getModeMeta(settings, "synthesis");

    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    expect(getModePrefix(meta)).toBe("Synthesis minutes");

    const generalMeta = getModeMeta(settings, "general");
    expect(getModePrefix(generalMeta)).toBe("General");
    expect(normalizeModeFromLabel(settings, "General")).toBe("general");
    setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
    expect(getModePrefix(meta)).toBe("综合纪要");
    expect(getModePrefix(generalMeta)).toBe("通用");
    expect(normalizeModeFromLabel(settings, "通用")).toBe("general");

    // 两种前缀都要认回 synthesis，否则既有笔记与英文新笔记会被判成未知模式
    expect(normalizeModeFromLabel(settings, "综合纪要")).toBe("synthesis");
    expect(normalizeModeFromLabel(settings, "Synthesis minutes")).toBe("synthesis");
    expect(normalizeModeFromLabel(settings, "Work notes")).toBe("meeting");
    expect(normalizeModeFromLabel(settings, "工作纪要")).toBe("meeting");
  });

  it("shows clean transcript as a display state without registering it as a polish mode", () => {
    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
    expect(getModeMeta(settings, "cleanscript").label).toBe("Clean transcript");
    expect(getModeDisplayName(settings, "cleanscript")).toBe("清稿");
    expect(isKnownPolishMode(settings, "cleanscript")).toBe(false);
  });
});
