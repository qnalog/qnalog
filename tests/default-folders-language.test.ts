import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import { UI_LANGUAGES, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { DEFAULT_LIBRARY_PATHS, DEFAULT_SETTINGS, defaultFolderPaths } from "../src/shared/defaults";
import { normalizePluginSettings, serializePluginSettings } from "../src/shared/settings-io";

// 默认目录名会写进用户知识库，新装时按当时的界面语言选定，之后不再随语言变化。
// 这里盯住三件事：中文环境出中文目录、英文（及其他未登记语言）出英文目录、
// 已保存的路径不被语言改写——第三条是「换语言不搬已有目录」的机械依据。

const ZH = UI_LANGUAGES.find(l => l.id === "zh")!;
const EN = UI_LANGUAGES.find(l => l.id === "en")!;

afterEach(() => setActiveUiLanguage(EN));

function freshSettings() {
  return normalizePluginSettings({ schemaVersion: 1 });
}

describe("默认目录跟随界面语言", () => {
  it("中文环境的新装目录是中文", () => {
    setActiveUiLanguage(resolveUiLanguage("", "zh"));
    const s = freshSettings();
    expect(s.audioFolder).toBe("QnALog/录音");
    expect(s.mdFolder).toBe("QnALog/转写纪要");
    expect(s.meetingMaterialsFolder).toBe("QnALog/会议资料");
    expect(s.htmlReportFolder).toBe("QnALog/HTML报告");
    expect(s.vocabularyFile).toBe("QnALog/资料库/词汇表.md");
    expect(s.peopleDirectoryFolder).toBe("QnALog/资料库/人员");
    expect(s.basesFolder).toBe("QnALog/资料库/视图");
    expect(s.diagnosticsLogFolder).toBe("QnALog/系统/诊断日志");
    expect(DEFAULT_LIBRARY_PATHS.archiveFolder).toBe("QnALog/资料库/归档");
    expect(defaultFolderPaths().emailDraftFolder).toBe("QnALog/邮件草稿");
  });

  it("英文环境的新装目录是英文", () => {
    setActiveUiLanguage(resolveUiLanguage("", "en"));
    const s = freshSettings();
    expect(s.audioFolder).toBe("QnALog/Recordings");
    expect(s.mdFolder).toBe("QnALog/Transcribed notes");
    expect(s.meetingMaterialsFolder).toBe("QnALog/Meeting materials");
    expect(s.htmlReportFolder).toBe("QnALog/HTML reports");
    expect(s.vocabularyFile).toBe("QnALog/Library/Glossary.md");
    expect(s.peopleDirectoryFolder).toBe("QnALog/Library/People");
    expect(s.basesFolder).toBe("QnALog/Library/Views");
    expect(s.diagnosticsLogFolder).toBe("QnALog/System/Diagnostics log");
    expect(DEFAULT_LIBRARY_PATHS.archiveFolder).toBe("QnALog/Library/Archive");
    expect(defaultFolderPaths().emailDraftFolder).toBe("QnALog/Email drafts");
  });

  it("Obsidian 是未登记语言时回退英文（只提供中英两套）", () => {
    setActiveUiLanguage(resolveUiLanguage("", "ja"));
    expect(freshSettings().audioFolder).toBe("QnALog/Recordings");
    setActiveUiLanguage(resolveUiLanguage("", "zh-TW"));
    expect(freshSettings().audioFolder).toBe("QnALog/录音");
  });

  it("默认值在语言切换后取到新值（不是导入时冻住的常量）", () => {
    setActiveUiLanguage(ZH);
    expect(DEFAULT_SETTINGS.audioFolder).toBe("QnALog/录音");
    setActiveUiLanguage(EN);
    expect(DEFAULT_SETTINGS.audioFolder).toBe("QnALog/Recordings");
  });

  it("已保存的路径不随界面语言改写（换语言不搬已有目录）", () => {
    const saved = serializePluginSettings({ ...freshSettings(), audioFolder: "我的/录音", mdFolder: "QnALog/转写纪要/会议" });
    setActiveUiLanguage(EN);
    const back = normalizePluginSettings(JSON.parse(JSON.stringify(saved)));
    expect(back.audioFolder).toBe("我的/录音");
    expect(back.mdFolder).toBe("QnALog/转写纪要/会议");
    // 未填过的键仍按当前语言给默认值
    expect(back.meetingMaterialsFolder).toBe("QnALog/Meeting materials");
  });
});
