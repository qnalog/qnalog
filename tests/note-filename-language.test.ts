import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"), TFile: class {}, TFolder: class {} }));
import { setActiveUiLanguage, resolveUiLanguage } from "../src/shared/i18n";
import { buildRenamedMarkdownPath, stripAutoTitleSuffix } from "../src/notes/note-markdown";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";

const S = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

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
