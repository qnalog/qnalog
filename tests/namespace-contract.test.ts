import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class {}, TFolder: class {},
}));

import {
  NS_TAG,
  NS_ROOT,
  NS_TAG_PREFIX,
  NS_FM,
  NS_FM_SPEAKERS,
  NS_TYPE_DERIVED,
  NS_TYPE_VERSION_CACHE,
  NS_VIEW_OUTLINE,
  NS_VIEW_MINUTES_KANBAN,
  NS_FM_SEMANTIC,
  hasNamespaceFrontmatter,
  isNamespaceTag,
  isDerivedVersionType,
  nsMarker,
  nsRe,
  readNamespaceFrontmatter,
  readSemanticMeta,
  setNamespaceFrontmatter,
} from "../src/shared/namespace";
import { LV_BASE_DEFINITIONS } from "../src/views/base-definitions";
import { formatPeopleBaseYaml } from "../src/people";
import { FRONTMATTER_SCHEMA } from "../src/shared/catalog-modes";
import { SETTINGS_SCHEMA_VERSION } from "../src/shared/settings-io";
import { DEFAULT_SETTINGS, DEFAULT_LIBRARY_PATHS } from "../src/shared/defaults";

// 品牌标记只认 QnALog；Frontmatter 业务字段另有明确的历史键读取规则，
// 仅兼容 QnALog 旧中文/英文属性，不恢复 LexVoice 数据兼容。
describe("数据层命名空间与 Frontmatter schema", () => {
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

  it("业务字段始终使用 qnalog_* canonical 键并读取旧别名", () => {
    expect(NS_FM.mode).toBe("qnalog_mode");
    expect(NS_FM.time).toBe("qnalog_time");
    expect(NS_FM.duration).toBe("qnalog_duration");
    expect(NS_FM.status).toBe("qnalog_status");
    expect(NS_FM.people).toBe("qnalog_people");
    expect(readNamespaceFrontmatter({ mode: "meeting" }, "mode")).toBe("meeting");
    expect(readNamespaceFrontmatter({ mode: "meeting", [NS_FM.mode]: "seminar" }, "mode")).toBe("seminar");
    expect(readNamespaceFrontmatter({ people: ["李四"], 人物: ["王五"] }, "people")).toEqual(["李四", "王五"]);
    expect(hasNamespaceFrontmatter({ 人物: [] }, "people")).toBe(true);
    const updated: Record<string, unknown> = { mode: "meeting", 模式: "meeting" };
    setNamespaceFrontmatter(updated, "mode", "meeting");
    expect(updated).toEqual({ [NS_FM.mode]: "meeting" });
  });

  it("Bases 查询使用 canonical 键，显示名与属性名分离", () => {
    for (const definition of LV_BASE_DEFINITIONS) {
      expect(definition.yaml).not.toMatch(/note\.[^:\n]*[\u3400-\u9fff]/);
      expect(definition.yaml).toContain(`note.${NS_FM.time}`);
    }
    const peopleBase = formatPeopleBaseYaml();
    expect(peopleBase).toContain(`note.${NS_FM.name}`);
    expect(peopleBase).toContain(`note.${NS_FM.role}`);
    expect(peopleBase).toContain(`note.${NS_FM.email}`);
    expect(peopleBase).not.toMatch(/note\.[^:\n]*[\u3400-\u9fff]/);
  });

  it("模型 schema 只要求 qnalog_* Frontmatter 属性", () => {
    expect(FRONTMATTER_SCHEMA.meeting).toContain(`${NS_FM.topic}:`);
    expect(FRONTMATTER_SCHEMA.meeting).toContain(`${NS_FM.participants}:`);
    expect(FRONTMATTER_SCHEMA.interview).toContain(`${NS_FM.interviewee}:`);
    for (const schema of Object.values(FRONTMATTER_SCHEMA)) {
      expect(schema).not.toMatch(/^(?:主题|参会人|与会人|来源|语言|受访者|访问者):/m);
    }
  });

  it("默认目录全部落在 QnALog/ 下", () => {
    for (const [key, value] of Object.entries(DEFAULT_LIBRARY_PATHS)) {
      expect(value, key).toMatch(/^QnALog\//);
    }
    for (const key of ["audioFolder", "mdFolder", "meetingMaterialsFolder", "htmlReportFolder", "segmentCacheFolder"] as const) {
      expect(DEFAULT_SETTINGS[key], key).toMatch(/^QnALog\//);
    }
  });

  it("设置结构版本为 2（保留 QnALog 1.x 设置，不承接其他项目）", () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(2);
  });
});
