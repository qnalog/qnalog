import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"), TFile: class {}, TFolder: class {} }));
import { getActiveUiLanguage, setActiveUiLanguage, resolveUiLanguage } from "../src/shared/i18n";
import { buildRenamedMarkdownPath, stripAutoTitleSuffix, stripModePrefixFromTitle } from "../src/notes/note-title-path";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";

const S = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
const initialLanguage = getActiveUiLanguage();
const customTemplates = {
  "custom-a": { id: "custom-a", mode: "custom-a", name: "Alpha", customMode: true, prompt: "fixture" },
  "custom-long": { id: "custom-long", mode: "custom-long", name: "Alpha Extended", customMode: true, prompt: "fixture" },
  "custom-special": { id: "custom-special", mode: "custom-special", name: "A.+(B)", customMode: true, prompt: "fixture" },
};
const customSettings = { ...S, promptTemplates: customTemplates };

beforeEach(() => setActiveUiLanguage(resolveUiLanguage("zh", "zh")));
afterEach(() => {
  setActiveUiLanguage(initialLanguage);
  vi.restoreAllMocks();
});

describe("笔记文件名随语言", () => {
  it("英文界面生成英文前缀的文件名，中文界面生成中文前缀，且都能剥回原 stem", () => {
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    const en = buildRenamedMarkdownPath("QnALog/转写纪要/2026-09-16 0852.md", "monologue", "AI video - storyboard axes", S);
    expect(en).toContain("Personal notes-");

    setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
    const zh = buildRenamedMarkdownPath("QnALog/转写纪要/2026-09-16 0852.md", "monologue", "AI视频制作-分镜坐标系规范", S);
    expect(zh).toContain("个人笔记-");

    // 两种前缀都要能剥掉，否则切语言后后缀越叠越长
    expect(stripAutoTitleSuffix("2026-09-16 0852 · Personal notes-AI video", S)).toBe("2026-09-16 0852");
    expect(stripAutoTitleSuffix("2026-09-16 0852 · 个人笔记-AI视频制作", S)).toBe("2026-09-16 0852");
  });
});

describe("按实际笔记名剥前缀", () => {
  it("英文界面下，中文前缀的既有笔记也要剥掉前缀", () => {
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    const name = "2026-09-16 0852 · 个人笔记-AI视频制作-分镜坐标系规范";
    expect(stripAutoTitleSuffix(name, S)).toBe("2026-09-16 0852");
  });
});

describe("实际笔记名的处理", () => {
  it("英文界面下，既有中文前缀笔记的标题与重命名都不残留中文前缀", () => {
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    const real = "2026-09-16 0852 · 个人笔记-AI视频制作-分镜坐标系规范";
    // 标题：剥掉前缀，只留日期+主题
    expect(stripAutoTitleSuffix(real, S)).toBe("2026-09-16 0852");
    // 重命名：用英文前缀重建，且不重复叠加
    const out = buildRenamedMarkdownPath(`QnALog/转写纪要/${real}.md`, "monologue", "AI video - storyboard axes", S);
    expect(out).toContain("Personal notes-");
    expect(out).not.toContain("个人笔记");
    expect(out.match(/2026-09-16 0852/g)).toHaveLength(1);
  });
});
describe("title helper boundary behavior", () => {
  it.each(["zh", "en"] as const)("keeps suffix matching and display-prefix ordering in %s", (language) => {
    setActiveUiLanguage(resolveUiLanguage(language, language));
    for (const suffix of [
      "date · Work notes-Old",
      "date · 工作纪要-旧",
      "date · Alpha Extended-Old",
      "date · A.+(B)-Old",
    ]) expect(stripAutoTitleSuffix(suffix, customSettings)).toBe("date");
    for (const value of ["date · Work notes-", "date · Work notes-Old/Part", "date · Work notes-Old · Tail"]) {
      expect(stripAutoTitleSuffix(value, customSettings)).toBe(value);
    }
    expect(stripAutoTitleSuffix(null, customSettings)).toBe("");
    expect(stripAutoTitleSuffix(0, customSettings)).toBe("");

    expect(stripModePrefixFromTitle("Alpha Extended-Topic", customSettings)).toBe("Topic");
    expect(stripModePrefixFromTitle("A.+(B)-Topic", customSettings)).toBe("Topic");
    for (const value of ["AzzzB-Topic", "Work notes", "work notes-Topic"]) {
      expect(stripModePrefixFromTitle(value, customSettings)).toBe(value);
    }
    expect(stripModePrefixFromTitle("date • Work notes-Topic", customSettings)).toBe("date • Topic");
    expect(stripModePrefixFromTitle("date · Work notesExtra", customSettings)).toBe("date · Extra");
    expect(stripModePrefixFromTitle("Work notes-Study notes-Topic", customSettings)).toBe("Study notes-Topic");
  });

  it("preserves full path construction and empty/invalid title boundaries", () => {
    setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
    expect(buildRenamedMarkdownPath("Notes/date · Work notes-Old.MD", "meeting", "New", S))
      .toBe("Notes/date · 工作纪要-New.md");
    expect(buildRenamedMarkdownPath(".md", "meeting", "New", S)).toBe("");
    expect(buildRenamedMarkdownPath("date.md", "meeting", { toString: () => "Topic" }, S)).toBe("");
    expect(buildRenamedMarkdownPath({ toString: () => "date.md" }, "meeting", "Topic", S))
      .toBe("date · 工作纪要-Topic.md");
  });

  it("preserves thrown conversion and settings getter errors", () => {
    const failure = new Error("conversion failed");
    const title = { toString: () => { throw failure; } };
    try {
      stripAutoTitleSuffix(title, S);
      throw new Error("expected conversion failure");
    } catch (error) {
      expect(error).toBe(failure);
    }
    try {
      stripModePrefixFromTitle(title, S);
      throw new Error("expected conversion failure");
    } catch (error) {
      expect(error).toBe(failure);
    }
    const settingsFailure = new Error("settings failed");
    const settings = Object.defineProperty({}, "promptTemplates", { get: () => { throw settingsFailure; } });
    try {
      stripAutoTitleSuffix("date", settings);
      throw new Error("expected settings failure");
    } catch (error) {
      expect(error).toBe(settingsFailure);
    }
  });
});

describe("标题剥前缀", () => {
  it("只剥模板名前缀，保留主题", () => {
    // 两种前缀都要能剥：笔记可能是在另一种界面语言下命名的。
    expect(stripModePrefixFromTitle("2026-09-16 0852 · 个人笔记-AI视频制作-分镜坐标系规范", S))
      .toBe("2026-09-16 0852 · AI视频制作-分镜坐标系规范");
    expect(stripModePrefixFromTitle("2026-09-16 0852 · Personal notes-AI video", S))
      .toBe("2026-09-16 0852 · AI video");
  });
});
