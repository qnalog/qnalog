import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class {}, TFolder: class {},
}));

import {
  NS_TAG,
  NS_ROOT,
  NS_TAG_PREFIX,
  NS_FM_SPEAKERS,
  NS_TYPE_DERIVED,
  NS_TYPE_VERSION_CACHE,
  NS_VIEW_OUTLINE,
  NS_VIEW_MINUTES_KANBAN,
  NS_FM_SEMANTIC,
  isNamespaceTag,
  isDerivedVersionType,
  nsMarker,
  nsRe,
  readSemanticMeta,
} from "../src/shared/namespace";
import { SETTINGS_SCHEMA_VERSION } from "../src/shared/settings-io";
import { DEFAULT_SETTINGS, DEFAULT_LIBRARY_PATHS } from "../src/shared/defaults";

// QnALog 是独立项目：数据层只认自己的命名空间。
// 这组测试钉住"只认一套字面量"这条规则，防止后来者为了兼容旧数据把双读逻辑加回来。
describe("数据层命名空间：只认 QnALog", () => {
  it("命名空间常量就是 qnalog / QnALog", () => {
    expect(NS_TAG).toBe("qnalog");
    expect(NS_ROOT).toBe("QnALog");
    expect(NS_TAG_PREFIX).toBe("qnalog/");
    expect(nsRe("session")).toBe("qnalog-session");
    expect(nsMarker("session", "abc")).toBe("<!-- qnalog-session:abc -->");
  });

  it("系统标签只认 qnalog/ 前缀", () => {
    expect(isNamespaceTag("qnalog/meeting")).toBe(true);
    expect(isNamespaceTag("QNALOG/MEETING")).toBe(true);
    expect(isNamespaceTag("lexvoice/meeting")).toBe(false);
    expect(isNamespaceTag("其他/标签")).toBe(false);
    expect(isNamespaceTag(undefined)).toBe(false);
  });

  it("类型值只认 QnALog 取值", () => {
    expect(isDerivedVersionType(NS_TYPE_DERIVED)).toBe(true);
    expect(isDerivedVersionType("LexVoice派生版本")).toBe(false);
    expect(isDerivedVersionType(NS_TYPE_VERSION_CACHE)).toBe(false);
  });

  it("Canvas 语义元数据只读 qnalogSemantic 键", () => {
    expect(NS_FM_SEMANTIC).toBe("qnalogSemantic");
    expect(readSemanticMeta({ [NS_FM_SEMANTIC]: { sourcePath: "a.md" } })).toEqual({ sourcePath: "a.md" });
    expect(readSemanticMeta({ lexvoiceSemantic: { sourcePath: "a.md" } })).toBeUndefined();
    expect(readSemanticMeta(null)).toBeUndefined();
  });

  it("frontmatter 与视图类型用的是 QnALog 取值", () => {
    expect(NS_FM_SPEAKERS).toBe("qnalog_speakers");
    expect(NS_VIEW_OUTLINE).toBe("qnalog-outline-view");
    expect(NS_VIEW_MINUTES_KANBAN).toBe("qnalog-minutes-kanban-view");
  });

  it("默认目录全部落在 QnALog/ 下", () => {
    for (const [key, value] of Object.entries(DEFAULT_LIBRARY_PATHS)) {
      expect(value, key).toMatch(/^QnALog\//);
    }
    for (const key of ["audioFolder", "mdFolder", "meetingMaterialsFolder", "htmlReportFolder", "segmentCacheFolder"] as const) {
      expect(DEFAULT_SETTINGS[key], key).toMatch(/^QnALog\//);
    }
  });

  it("设置结构版本为 1（QnALog 不承接历史项目的设置）", () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(1);
  });
});
