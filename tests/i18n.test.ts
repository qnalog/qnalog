import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (p: string) => String(p || ""), TFile: class {}, TFolder: class {} }));
import {
  DEFAULT_UI_LANGUAGE,
  UI_LANGUAGES,
  createTranslator,
  getActiveUiLanguage,
  isSupportedUiLanguage,
  matchUiLanguage,
  resolveUiLanguage,
  setActiveUiLanguage,
  t,
  translateInto,
} from "../src/shared/i18n";

const root = path.resolve(__dirname, "..");

// 界面语言的解析规则。这里断言的是「用户会看到哪种语言」，
// 不是某个函数怎么实现——语言认错最多显示不对，但不该让插件起不来。

describe("界面语言解析", () => {
  it("认得出带地区的语言标识（Obsidian 会返回 zh-TW、en-GB 这类值）", () => {
    expect(matchUiLanguage("zh")?.id).toBe("zh");
    expect(matchUiLanguage("en")?.id).toBe("en");
    expect(matchUiLanguage("EN")?.id).toBe("en");
  });

  it("未登记的地区变体按主语言码降级，而不是直接落到英文", () => {
    // zh-TW（繁體）尚未登记时回退到 zh，比回退到英文更贴近用户预期
    expect(matchUiLanguage("zh-TW")?.id).toBe("zh");
    expect(matchUiLanguage("zh_HK")?.id).toBe("zh");
    expect(matchUiLanguage("en-GB")?.id).toBe("en");
  });

  it("完全认不出的语言返回 null，不硬塞一个默认值", () => {
    // 调用方需要区分「用户明确选了不支持的语言」与「没有语言线索」
    expect(matchUiLanguage("fr")).toBeNull();
    expect(matchUiLanguage("")).toBeNull();
    expect(matchUiLanguage(null)).toBeNull();
    expect(matchUiLanguage(undefined)).toBeNull();
    expect(isSupportedUiLanguage("fr")).toBe(false);
    expect(isSupportedUiLanguage("zh")).toBe(true);
  });

  it("用户显式设置优先于 Obsidian 的语言", () => {
    expect(resolveUiLanguage("zh", "en").id).toBe("zh");
    expect(resolveUiLanguage("en", "zh").id).toBe("en");
  });

  it("未设置时跟随 Obsidian，两者都认不出才用默认值", () => {
    expect(resolveUiLanguage("", "en").id).toBe("en");
    expect(resolveUiLanguage("", "zh-TW").id).toBe("zh");
    expect(resolveUiLanguage("", "fr").id).toBe(DEFAULT_UI_LANGUAGE);
    expect(resolveUiLanguage(null, null).id).toBe(DEFAULT_UI_LANGUAGE);
  });
});

describe("取词条", () => {
  const zh = UI_LANGUAGES.find((l) => l.id === "zh");
  const en = UI_LANGUAGES.find((l) => l.id === "en");

  it("英文是源语言：查不到时原样返回，不显示裸露的键名", () => {
    expect(translateInto(en, "Ready")).toBe("Ready");
    expect(translateInto(en, "Not translated yet")).toBe("Not translated yet");
  });

  it("中文返回译文", () => {
    expect(translateInto(zh, "Ready")).toBe("已准备好");
    expect(translateInto(zh, "Quick setup")).toBe("快速设置");
  });

  it("缺译时回退英文原文，而不是回退中文", () => {
    // 英文用户看到英文是「尚未翻译」；回退中文则是读不懂
    const missing = "A string that has no Chinese translation";
    expect(translateInto(zh, missing)).toBe(missing);
    expect(translateInto(zh, missing)).not.toContain("[");
  });

  it("createTranslator 绑定语言后可反复调用", () => {
    const a = createTranslator(zh);
    const b = createTranslator(en);
    expect(a("Ready")).toBe("已准备好");
    expect(b("Ready")).toBe("Ready");
  });

  it("生效语言可切换，t() 随之改变", () => {
    const original = getActiveUiLanguage();
    setActiveUiLanguage(zh as never);
    expect(t("Ready")).toBe("已准备好");
    setActiveUiLanguage(en as never);
    expect(t("Ready")).toBe("Ready");
    setActiveUiLanguage(original);
  });

  it("语言下拉列出全部支持的语言，且中文与英文都在", () => {
    const ids = UI_LANGUAGES.map((l) => l.id);
    expect(ids).toContain("zh");
    expect(ids).toContain("en");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每种语言都给出本地名，用户不必先读懂英文才能找到自己的语言", () => {
    for (const lang of UI_LANGUAGES) {
      expect(lang.nativeName, `${lang.id} 缺 nativeName`).toBeTruthy();
      expect(lang.name, `${lang.id} 缺英文名`).toBeTruthy();
    }
  });
});

describe("词条表完整性", () => {
  it("中文表没有重复键（重复键会让后一条静默覆盖前一条）", () => {
    const raw = fs.readFileSync(path.join(root, "src/shared/i18n/locales/zh.ts"), "utf8");
    const keys = [...raw.matchAll(/^  "((?:[^"\\]|\\.)*)":/gm)].map((m) => m[1]);
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dup, `重复键：${dup.slice(0, 3).join(" / ")}`).toEqual([]);
  });

  it("中文表没有空译文（空串等于没翻译，却会顶掉英文回退）", () => {
    const raw = fs.readFileSync(path.join(root, "src/shared/i18n/locales/zh.ts"), "utf8");
    const empties = [...raw.matchAll(/^  "((?:[^"\\]|\\.)*)":\s*"",/gm)].map((m) => m[1]);
    expect(empties, `空译文：${empties.slice(0, 3).join(" / ")}`).toEqual([]);
  });
});

describe("界面文案与路径的边界", () => {
  it("默认目录路径不得包在 t() 里（路径是值，不是文案）", () => {
    // 曾经把 QnALog/录音 这类占位符包上 t()：翻译后占位符与实际默认目录不一致，
    // 更糟的是在 addText(a => ...) 这类回调里会变成调用参数对象，运行时报错。
    const files = [
      "src/ui/settings-tab.ts", "src/ui/modals.ts", "src/ui/outline-view.ts", "src/ui/helpers.ts",
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      for (const m of src.matchAll(/(?:t|i18nT)\("(QnALog\/[^"]*)"\)/g)) {
        offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders, `路径被包进 t()：${offenders.slice(0, 3).join(" / ")}`).toEqual([]);
  });
});

describe("词条表的形状", () => {
  const zhRaw = fs.readFileSync(path.join(root, "src/shared/i18n/locales/zh.ts"), "utf8");
  const pairs = [...zhRaw.matchAll(/^  "((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)",/gm)]
    .map((m) => [m[1], m[2]] as const);

  it("键必须是英文（英文是源语言，t() 用代码里的英文字面量查表）", () => {
    // 反向条目（中文做键）在中文界面下查不到，会静默回退成英文。
    // 键里出现中文不必然是错：语言下拉写 native name（日本語）、
    // 文案里引用应用本名（哔哩哔哩）都是合法的，按 ASCII 字母占比区分。
    const cjk = /[\u4e00-\u9fa5]/g;
    const backwards = pairs
      .filter(([k]) => {
        const han = (k.match(cjk) || []).length;
        if (!han) return false;
        const latin = (k.match(/[A-Za-z]/g) || []).length;
        return latin <= han; // 汉字不少于拉丁字母 → 键主体是中文
      })
      .map(([k, v]) => `${k} → ${v}`);
    expect(backwards, `键主体是中文（方向反了）：${backwards.slice(0, 3).join(" / ")}`).toEqual([]);
  });

  it("值必须是中文或标点（英文表为空，值若是英文说明这条写反了）", () => {
    // 全角标点映射（")" → "）"）没有汉字但合法；含拉丁字母才算漏译。
    const withoutCjk = pairs
      .filter(([, v]) => !/[\u4e00-\u9fa5]/.test(v) && /[A-Za-z]/.test(v))
      .map(([k]) => k);
    expect(withoutCjk, `值含拉丁字母但没有中文：${withoutCjk.slice(0, 3).join(" / ")}`).toEqual([]);
  });

  it("中文值不得以空格结尾而英文键不以空格结尾（英文侧会与下一个片段粘连）", () => {
    // 键即英文界面回退显示的内容。曾出现值带尾空格、键不带："Step" vs "步骤 "
    // → en 渲染 "Step5"，zh 渲染 "步骤 5"。
    // 反向（键带空格、值不带："Source: " vs "来源："）是安全的：
    // 中文标点自带间隙，英文靠这个空格连接，两侧都正确。
    const glued = pairs
      .filter(([k, v]) => v.endsWith(" ") && !k.endsWith(" "))
      .map(([k, v]) => `${JSON.stringify(k)} vs ${JSON.stringify(v)}`);
    expect(glued, `英文侧会粘连：${glued.slice(0, 3).join(" / ")}`).toEqual([]);
  });

  it("不应存在「值等于键」的自我映射（那等于没翻译）", () => {
    const identity = pairs.filter(([k, v]) => k === v).map(([k]) => k);
    expect(identity, `自我映射：${identity.slice(0, 3).join(" / ")}`).toEqual([]);
  });
});
