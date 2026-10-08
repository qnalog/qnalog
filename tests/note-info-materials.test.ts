import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  TFile: class TFile {},
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
}));
import { getActiveUiLanguage, matchUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { buildRecordingInfoDetails, buildTextImportInfoDetails } from "../src/notes/note-session-materials";
import type { NoteInfoTimeFormatter } from "../src/notes/note-session-materials";

const moment = (format: (pattern: string) => string) => (date?: string) => ({ format: (pattern: string) => format(pattern) });
const formatStartedAt: NoteInfoTimeFormatter = (readStartedAt) => {
  const host = (globalThis as { window?: { moment?: (value?: string) => { format: (pattern: string) => string } } }).window;
  return host?.moment ? host.moment(readStartedAt()).format("YYYY-MM-DD HH:mm:ss") : undefined;
};

function withLanguage<T>(language: string, run: () => T): T {
  const previous = getActiveUiLanguage();
  setActiveUiLanguage(matchUiLanguage(language)!);
  try { return run(); }
  finally { setActiveUiLanguage(previous); }
}

describe("note info material contracts", () => {
  it.each(["zh", "en"]) ("preserves recording info line order and values in %s", (language) => {
    withLanguage(language, () => {
      vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00:00" }) });
      try {
        const labels = language === "zh"
          ? ["时间：", "时长：", "模式：", "分段：", "模型："]
          : ["Time: ", "Duration: ", "Mode: ", "Segments: ", "Model: "];
        expect(buildRecordingInfoDetails({
          startedAt: "2026-09-14T12:00:00.000Z", totalMs: 3_661_999,
          modeLabel: "用户模式 $& $` $' $$", segmentCount: 4,
          segmentText: "2 + 2 $& $` $' $$", model: "模型 $& $` $' $$",
        }, formatStartedAt)).toBe([
          "<details>", `<summary>${language === "zh" ? "录音信息" : "Recording info"}</summary>`, "",
          `- ${labels[0]}2026-09-14 12:00:00`, `- ${labels[1]}1:01:01`,
          `- ${labels[2]}用户模式 $& $` + "` $' $$", `- ${labels[3]}2 + 2 $& $` + "` $' $$",
          `- ${labels[4]}模型 $& $` + "` $' $$", "", "</details>",
        ].join("\n"));
      } finally { vi.unstubAllGlobals(); }
    });
  });

  it("keeps recording duration, segment fallback, and missing-time behavior", () => withLanguage("zh", () => {
    vi.stubGlobal("window", {});
    try {
      expect(buildRecordingInfoDetails({ totalMs: 0, segmentText: "", segmentCount: 0 })).toContain("- 时长：00:00\n- 分段：0");
      expect(buildRecordingInfoDetails({ totalMs: null, segmentCount: null })).toBe("");
      expect(buildRecordingInfoDetails({ startedAt: "x", model: "m" })).toContain("- 模型：m");
      expect(buildRecordingInfoDetails({ startedAt: "x", model: "m" })).not.toContain("时间：");
      expect(buildRecordingInfoDetails({ startedAt: "x" }, () => undefined)).toBe("");
      expect(buildRecordingInfoDetails({ startedAt: "x" }, () => "")).toContain("- 时间：\n");
      expect(() => buildRecordingInfoDetails({ startedAt: "x" }, () => { throw new Error("formatter failed"); }))
        .toThrow("formatter failed");
      expect(buildRecordingInfoDetails({})).toBe("");
      expect(buildRecordingInfoDetails(null)).toBe("");
      expect(buildRecordingInfoDetails(undefined)).toBe("");
    } finally { vi.unstubAllGlobals(); }
  }));

  it("preserves moment return and failure semantics", () => withLanguage("zh", () => {
    const format = vi.fn(() => "");
    vi.stubGlobal("window", { moment: moment(format) });
    try {
      expect(buildRecordingInfoDetails({ startedAt: "x" }, formatStartedAt)).toContain("- 时间：\n");
      expect(format).toHaveBeenCalledWith("YYYY-MM-DD HH:mm:ss");
      vi.stubGlobal("window", { moment: () => ({ format: () => { throw new Error("format failed"); } }) });
      expect(() => buildRecordingInfoDetails({ startedAt: "x" }, formatStartedAt)).toThrow("format failed");
    } finally { vi.unstubAllGlobals(); }
  }));


  it.each(["zh", "en"]) ("preserves text import source priority and literal names in %s", (language) => {
    withLanguage(language, () => {
      vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00:00" }) });
      try {
        const labels = language === "zh"
          ? ["时间：", "模式：", "来源文件：", "模型：", "来源："]
          : ["Time: ", "Mode: ", "Source files: ", "Model: ", "Source: "];
        const result = buildTextImportInfoDetails({
          source: "text-import", startedAt: "x", segments: [{}, {}], textImportSources: [
            { name: "来源一 $& $` $' $$", path: "Notes/one.md", chars: 11 },
            { path: "Notes/two.md" }, { name: "无路径来源 $& $` $' $$" }, {},
          ],
        }, "工作纪要", "模型 $& $` $' $$", formatStartedAt);
        expect(result).toBe([
          "<details>", `<summary>${language === "zh" ? "导入文本信息" : "Imported text info"}</summary>`, "",
          `- ${labels[0]}2026-09-14 12:00:00`, `- ${labels[1]}工作纪要`, `- ${labels[2]}4`,
          `- ${labels[3]}模型 $& $` + "` $' $$", "", labels[4],
          "- [[Notes/one.md|来源一 $& $` $' $$]]", "- [[Notes/two.md|two.md]]",
          "- 无路径来源 $& $` $' $$", "- 未命名文本", "", "</details>",
        ].join("\n"));
      } finally { vi.unstubAllGlobals(); }
    });
  });

  it("keeps text-import time capability optional and propagates its failures", () => withLanguage("zh", () => {
    const formatter = vi.fn(() => undefined);
    const withoutCapability = buildTextImportInfoDetails({ source: "text-import", startedAt: "x" }, "", "");
    expect(withoutCapability).not.toContain("时间：");
    expect(buildTextImportInfoDetails({ source: "text-import", startedAt: "x" }, "", "", formatter))
      .not.toContain("时间：");
    expect(formatter).toHaveBeenCalledTimes(1);
    expect(buildTextImportInfoDetails({ source: "text-import", startedAt: "x" }, "", "", () => ""))
      .toContain("- 时间：\n");
    expect(() => buildTextImportInfoDetails({ source: "text-import", startedAt: "x" }, "", "", () => {
      throw new Error("text formatter failed");
    })).toThrow("text formatter failed");
  }));
  it("uses segment-count and one fallback without adding an empty source list", () => withLanguage("zh", () => {
    for (const textImportSources of [undefined, null, "invalid", []]) {
      const result = buildTextImportInfoDetails({ source: "text-import", segments: [{}, {}], textImportSources }, "", "");
      expect(result).toContain("- 来源文件：2");
      expect(result).not.toContain("来源：\n");
    }
    expect(buildTextImportInfoDetails({ source: "text-import", segments: [], textImportSources: [] }, "", ""))
      .toContain("- 来源文件：1");
    expect(buildTextImportInfoDetails({ source: "text-import", segments: undefined }, "", ""))
      .toContain("- 来源文件：1");
    for (const source of ["recording", " text-import ", null, undefined]) {
      expect(buildTextImportInfoDetails({ source }, "", "")).toBe("");
    }
  }));

  it("does not normalize malformed source entries or path types", () => withLanguage("zh", () => {
    expect(() => buildTextImportInfoDetails({ source: "text-import", textImportSources: [null] }, "", ""))
      .toThrow();
    expect(() => buildTextImportInfoDetails({ source: "text-import", textImportSources: [{ path: 42 }] }, "", ""))
      .toThrow();
  }));
});
