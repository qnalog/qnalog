import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  setIcon: () => {},
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
}));
import { getModeDisplayName, getModeMeta, getVisibleModeEntries } from "../src/shared/mode-meta";
import { UI_LANGUAGES, setActiveUiLanguage } from "../src/shared/i18n";

// 模板名必须跟随界面语言：MODE_META.label 是英文原文也是词条键，prefix 是写进
// 笔记文件名、供读取侧解析的中文前缀。2026-09-21 的实测缺陷正是两者用混：
// 侧栏模板下拉显示英文 label（中文界面下仍是 "Personal notes"），而右键菜单与
// 导入弹窗显示中文 prefix（英文界面下仍是「个人笔记」）。
const original = UI_LANGUAGES.find((l) => l.id === "zh")!;
afterEach(() => { setActiveUiLanguage(original); });

const settings = { promptTemplates: {} };

describe("模板显示名跟随界面语言", () => {
  it("中文界面：内置模板显示中文名（下拉、菜单、导入弹窗共用同一个值）", () => {
    setActiveUiLanguage(UI_LANGUAGES.find((l) => l.id === "zh")!);
    expect(getModeDisplayName(settings, "monologue")).toBe("个人笔记");
    expect(getModeDisplayName(settings, "synthesis")).toBe("综合纪要");
    expect(getModeDisplayName(settings, "learning")).toBe("学习笔记");
  });

  it("英文界面：显示英文名", () => {
    setActiveUiLanguage(UI_LANGUAGES.find((l) => l.id === "en")!);
    expect(getModeDisplayName(settings, "monologue")).toBe("Personal notes");
    expect(getModeDisplayName(settings, "synthesis")).toBe("Synthesis minutes");
  });

  it("读取侧仍拿到中文前缀（用于解析既有笔记，不随界面语言变化）", () => {
    setActiveUiLanguage(UI_LANGUAGES.find((l) => l.id === "en")!);
    const entries = getVisibleModeEntries(settings, false);
    const monologue = entries.find(([key]) => key === "monologue");
    expect(monologue?.[1]).toBe("个人笔记");
  });

  it("自定义模板：用户起的名字原样出现，两种语言都不丢", () => {
    const custom = {
      promptTemplates: {
        "custom-abc-1": { id: "custom-abc-1", mode: "custom-abc-1", customMode: true, name: "周会纪要", description: "", baseMode: "meeting" },
      },
    };
    for (const id of ["zh", "en"]) {
      setActiveUiLanguage(UI_LANGUAGES.find((l) => l.id === id)!);
      expect(getModeDisplayName(custom, "custom-abc-1")).toContain("周会纪要");
    }
  });

  it("未知模式按内置默认模式显示，不返回空串", () => {
    setActiveUiLanguage(UI_LANGUAGES.find((l) => l.id === "zh")!);
    expect(getModeDisplayName(settings, "no-such-mode")).toBe(getModeDisplayName(settings, "meeting"));
    expect(getModeMeta(settings, "no-such-mode").label).toBeTruthy();
  });
});
