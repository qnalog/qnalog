import { beforeEach, describe, expect, it, vi } from "vitest";
const { parseYaml, stringifyYaml } = vi.hoisted(() => ({
  parseYaml: vi.fn((text: string) => Object.fromEntries(text.split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf(":");
    return [line.slice(0, index), line.slice(index + 1).trim()];
  }))),
  stringifyYaml: vi.fn((value: Record<string, unknown>) => Object.entries(value)
    .map(([key, item]) => `${key}: ${Array.isArray(item) ? JSON.stringify(item) : String(item)}`).join("\n") + "\n"),
}));
vi.mock("obsidian", () => ({ parseYaml, stringifyYaml }));
vi.stubGlobal("window", {});
import {
  formatYamlDateTime,
  frontmatterBaseModeKey,
  mergeLeadingFrontmatterIntoDocument,
  normalizeBriefingFrontmatterFields,
  postProcessBriefingOutput,
  scrubBriefingTodoPlaceholders,
} from "../src/notes/note-briefing-output";

const settings = { promptTemplates: { custom: { id: "custom", mode: "custom", customMode: true, baseMode: "learning" }, unknown: { id: "unknown", mode: "unknown", customMode: true, baseMode: "missing" } } };

describe("briefing output contracts", () => {
  beforeEach(() => {
    parseYaml.mockClear();
    stringifyYaml.mockClear();
    vi.stubGlobal("window", {});
  });

  it("resolves built-in and custom frontmatter modes with meeting fallback", () => {
    expect(frontmatterBaseModeKey(settings, "learning")).toBe("learning");
    expect(frontmatterBaseModeKey(settings, "custom")).toBe("learning");
    expect(frontmatterBaseModeKey(settings, "unknown")).toBe("meeting");
    expect(frontmatterBaseModeKey({}, "missing")).toBe("meeting");
    expect(frontmatterBaseModeKey(null, "missing")).toBe("meeting");
    expect(frontmatterBaseModeKey(undefined, "missing")).toBe("meeting");
  });

  it("scrubs only placeholder todo fields and handles CRLF lines", () => {
    expect(scrubBriefingTodoPlaceholders("- [ ] 责任人：待定 事项：报告 截止：无 优先级：tbd\r\n- [ ] 责任人：张三 事项：发布 截止：周五 优先级：高\r\n普通行"))
      .toBe("- [ ] 事项：报告\n- [ ] 责任人：张三 事项：发布 截止：周五 优先级：高\n普通行");
  });

  it("normalizes action labels only on checklist rows and their immediate continuations", () => {
    const chineseSource = "提醒一下，周五之前要把季度报告初稿发给李明评审。";
    const chineseOutput = postProcessBriefingOutput([
      "> [!abstract] 概要",
      "> 引用 Task: 不应改写。",
      "- [ ] Task: 发送季度报告初稿",
      "  Owner: 李明",
      "- Deadline: 周五前",
      "",
      "普通正文里的 Task: 不应改写。",
      "```text",
      "- [ ] Task: 代码块内容不应改写。",
      "```",
      "> [!quote] 引用",
      "> - [ ] Task: 引用内容不应改写。",
    ].join("\n"), "general", null, null, "general", "", chineseSource);
    expect(chineseOutput).toContain("> - [ ] 事项： 发送季度报告初稿");
    expect(chineseOutput).toContain("> 责任人： 李明");
    expect(chineseOutput).toContain("> - 截止： 周五前");
    expect(chineseOutput).toContain("普通正文里的 Task: 不应改写。");
    expect(chineseOutput).toContain("- [ ] Task: 代码块内容不应改写。");
    expect(chineseOutput).toContain("> - [ ] Task: 引用内容不应改写。");

    const englishSource = "I will send the report with the review team before Friday.";
    const englishOutput = postProcessBriefingOutput(
      "- [ ] 事项：send the report\n  责任人：Lee\n- 截止：Friday",
      "general",
      null,
      null,
      "general",
      "",
      englishSource,
    );
    expect(englishOutput).toContain("- [ ] Task:send the report\n  Owner:Lee\n- Due:Friday");

    const spanishOutput = postProcessBriefingOutput("- [ ] 事项：revisar el informe", "general", null, null, "general", "", "La próxima semana revisaré el informe.");
    expect(spanishOutput).toContain("- [ ] 事项：revisar el informe");
    const japaneseOutput = postProcessBriefingOutput("- [ ] 事项：返金の流れを見直す", "general", null, null, "general", "", "来週の共有会で返金の流れを見直します。");
    expect(japaneseOutput).toContain("- [ ] 事项：返金の流れを見直す");
  });
  it("formats dates via moment and falls back to Date for absent or invalid moment", () => {
    expect(formatYamlDateTime(null)).toBe("");
    expect(formatYamlDateTime("invalid date value")).toBe("");
    expect(formatYamlDateTime("2026-01-02T03:04:05.000Z")).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    vi.stubGlobal("window", { moment: (value: unknown) => ({ isValid: () => Boolean(value), format: () => "MOMENT" }) });
    expect(formatYamlDateTime("valid")).toBe("MOMENT");
    vi.stubGlobal("window", { moment: () => ({ isValid: () => false }) });
    expect(formatYamlDateTime("2026-01-02T03:04:05.000Z")).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
  });

  it("places notices after frontmatter, preserves key order, and falls back to hand-built YAML", () => {
    const output = postProcessBriefingOutput("---\nqnalog_topic: 主题\n幻想: 删除\n---\n# 模型标题\n正文", "meeting", { startedAt: "2026-01-02T03:04:05.000Z" }, null, "meeting", "注意事项");
    const keys = ["qnalog_mode", "qnalog_time", "qnalog_topic", "qnalog_status", "tags"];
    const positions = keys.map((key) => output.indexOf(`${key}:`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(output).toContain("---\n注意事项\n\n正文");
    expect(output).not.toContain("# 模型标题");
    stringifyYaml.mockImplementationOnce(() => { throw new Error("yaml stringify"); });
    const fallback = postProcessBriefingOutput("正文", "meeting", null, { qnalog_topic: "主题", tags: ["甲"] }, "meeting");
    expect(fallback).toContain("qnalog_topic: 主题");
    expect(fallback).toContain("  - 甲");
    expect(postProcessBriefingOutput("", "meeting", null, null, "meeting")).toBe("");
    expect(postProcessBriefingOutput(null, "meeting", null, null, "meeting")).toBe("");
  });

  it("merges generated frontmatter with the original document body", () => {
    expect(mergeLeadingFrontmatterIntoDocument("---\nold: value\n---\n# Original", "---\nnew: value\n---\n# Generated"))
      .toEqual({ content: "---\nnew: value\n---\n# Original", body: "# Generated" });
    expect(normalizeBriefingFrontmatterFields({ qnalog_topic: "主题", date: "ignored" }, "meeting", "meeting"))
      .toEqual({ qnalog_topic: "主题" });
  });
});
