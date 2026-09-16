import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (p: string) => String(p || ""), TFile: class {}, TFolder: class {} }));
import {
  DEFAULT_UI_LANGUAGE,
  UI_LANGUAGES,
  createTranslator,
  normalizeUiLanguage,
  resolveUiLanguage,
  translate,
} from "../src/shared/i18n";

// 界面语言的解析规则。这里断言的是「用户会看到哪种语言」，
// 不是某个函数怎么实现——语言认错最多显示不对，但不该让插件起不来。

describe("界面语言解析", () => {
  it("认得出带地区的语言标识（Obsidian 会返回 zh-TW、en-GB 这类值）", () => {
    expect(normalizeUiLanguage("zh")).toBe("zh");
    expect(normalizeUiLanguage("zh-TW")).toBe("zh");
    expect(normalizeUiLanguage("zh_CN")).toBe("zh");
    expect(normalizeUiLanguage("en")).toBe("en");
    expect(normalizeUiLanguage("en-GB")).toBe("en");
  });

  it("认不出的语言回退到默认值，不抛错", () => {
    // 界面语言认错最多是语言不对，不该让插件加载失败
    expect(normalizeUiLanguage("fr")).toBe(DEFAULT_UI_LANGUAGE);
    expect(normalizeUiLanguage("")).toBe(DEFAULT_UI_LANGUAGE);
    expect(normalizeUiLanguage(null)).toBe(DEFAULT_UI_LANGUAGE);
    expect(normalizeUiLanguage(undefined)).toBe(DEFAULT_UI_LANGUAGE);
  });

  it("用户显式设置优先于 Obsidian 的语言", () => {
    // 英文 Obsidian + 显式选中文 → 用中文
    expect(resolveUiLanguage("zh", "en")).toBe("zh");
    // 中文 Obsidian + 显式选英文 → 用英文
    expect(resolveUiLanguage("en", "zh")).toBe("en");
  });

  it("未设置时跟随 Obsidian，两者都认不出才用默认值", () => {
    expect(resolveUiLanguage("", "en")).toBe("en");
    expect(resolveUiLanguage("", "en-US")).toBe("en");
    expect(resolveUiLanguage("", "")).toBe(DEFAULT_UI_LANGUAGE);
    expect(resolveUiLanguage(null, null)).toBe(DEFAULT_UI_LANGUAGE);
  });
});

describe("取词条", () => {
  it("中文直接返回原文（中文原文就是键）", () => {
    expect(translate("zh", "录音")).toBe("录音");
    expect(translate("zh", "任意未登记的字符串")).toBe("任意未登记的字符串");
  });

  it("英文返回译文", () => {
    expect(translate("en", "录音")).toBe("Recording");
    expect(translate("en", "关于")).toBe("About");
  });

  it("缺译文时回退到中文原文，不显示裸露的键名", () => {
    // 未翻译的界面显示中文，好过显示 home.status.ready 这类符号键
    const untranslated = "这条还没有译文";
    expect(translate("en", untranslated)).toBe(untranslated);
    expect(translate("en", untranslated)).not.toContain(".");
  });

  it("createTranslator 绑定语言后可反复调用", () => {
    const en = createTranslator("en");
    const zh = createTranslator("zh");
    expect(en("录音")).toBe("Recording");
    expect(zh("录音")).toBe("录音");
  });

  it("语言下拉列出全部支持的语言，且中文与英文都在", () => {
    const ids = UI_LANGUAGES.map((l) => l.id);
    expect(ids).toContain("zh");
    expect(ids).toContain("en");
    expect(new Set(ids).size).toBe(ids.length);
  });
});
