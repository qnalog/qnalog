import { describe, expect, it } from "vitest";
import {
  getRecentNoteParentPath,
  getRecentNotePathRelativeToRoot,
  getRecentNoteTopLevelFolder,
  isPathUnderRecentNoteRoots,
  normalizeRecentNoteRoots,
} from "../src/recent-note-paths";

describe("最近纪要索引范围", () => {
  it("同时覆盖普通纪要目录和招聘项目目录", () => {
    const roots = normalizeRecentNoteRoots(["LexVoice/转写纪要", "JD"]);
    expect(isPathUnderRecentNoteRoots(
      "LexVoice/转写纪要/2026-07-29 会议.md",
      roots
    )).toBe(true);
    expect(isPathUnderRecentNoteRoots(
      "LexVoice/转写纪要/产品思路/2026-08-18 1621 · 综合纪要.md",
      roots
    )).toBe(true);
    expect(isPathUnderRecentNoteRoots(
      "JD/HR-SSC负责人/候选人/储立瑗-终面.md",
      roots
    )).toBe(true);
    expect(isPathUnderRecentNoteRoots("日记/2026-07-29.md", roots)).toBe(false);
  });

  it("父目录已覆盖子目录时去重，避免重复扫描", () => {
    expect(normalizeRecentNoteRoots([
      "LexVoice",
      "LexVoice/转写纪要",
      "LexVoice\\转写纪要",
    ])).toEqual(["LexVoice"]);
  });

  it("配置为知识库根目录时允许扫描全库", () => {
    const roots = normalizeRecentNoteRoots(["."]);
    expect(roots).toEqual([""]);
    expect(isPathUnderRecentNoteRoots("任意目录/纪要.md", roots)).toBe(true);
  });

  it("能够从纪要路径稳定得到文件夹和项目层级", () => {
    const path = "JD/HR-SSC负责人/候选人/储立瑗-终面.md";
    expect(getRecentNoteParentPath(path)).toBe("JD/HR-SSC负责人/候选人");
    expect(getRecentNotePathRelativeToRoot(path, "JD")).toBe("HR-SSC负责人/候选人/储立瑗-终面.md");
    expect(getRecentNoteTopLevelFolder(path, "JD")).toBe("HR-SSC负责人");
    expect(getRecentNoteTopLevelFolder("LexVoice/转写纪要/会议.md", "JD")).toBe("");
  });
});
