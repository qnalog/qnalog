import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class TFile {
    path: string;
    basename: string;
    extension: string;
    frontmatter: Record<string, unknown>;
    constructor(path: string, frontmatter: Record<string, unknown> = {}) {
      this.path = path;
      this.basename = path.split("/").pop()?.replace(/\.md$/i, "") || path;
      this.extension = "md";
      this.frontmatter = frontmatter;
    }
  },
}));

import * as obsidian from "obsidian";
import { NoteWriter } from "../src/notes/note-writer";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";

describe("NoteWriter mode detection for clean transcript display state", () => {
  const template = {
    id: "custom-mode-probe",
    mode: "custom-mode-probe",
    customMode: true,
    name: "模式探针",
    prompt: "固定提示词",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const createWriter = (
    getFileFrontmatter: (file: InstanceType<typeof obsidian.TFile>) => Record<string, unknown> | undefined,
    polishMode = "synthesis",
    promptTemplates: Record<string, unknown> = {},
  ) => {
    const writer = new NoteWriter({
      vault: {} as never,
      settings: { ...DEFAULT_SETTINGS, polishMode, promptTemplates },
      noteIndex: { refreshNoteIndexSafely: async () => undefined },
      getFileFrontmatter,
      ensureFolder: async () => { throw new Error("unexpected folder creation"); },
      findAvailableMarkdownPath: () => { throw new Error("unexpected path allocation"); },
      renameFile: async () => { throw new Error("unexpected rename"); },
      openFile: async () => { throw new Error("unexpected file open"); },
      confirm: async () => { throw new Error("unexpected confirmation"); },
      getRecentNotes: () => { throw new Error("unexpected recent-note lookup"); },
      generateTitleTag: async () => { throw new Error("unexpected title generation"); },
      polishTranscript: async () => { throw new Error("unexpected transcript polish"); },
      mergeAndPolish: async () => { throw new Error("unexpected note merge"); },
      clearCommittedBriefingCheckpoint: async () => { throw new Error("unexpected checkpoint cleanup"); },
    });
    return writer;
  };
  const detect = (filename: string, frontmatter: Record<string, unknown> = {}, polishMode = "synthesis") => {
    const file = new obsidian.TFile(filename, frontmatter);
    const writer = createWriter(() => frontmatter, polishMode);
    return writer.detectModeFromMarkdown(file);
  };

  it("guards non-files without metadata access and accepts non-markdown TFiles", () => {
    let lookups = 0;
    const writer = createWriter(() => { lookups++; return { qnalog_mode: "meeting" }; });
    expect(writer.detectModeFromMarkdown(null)).toBeNull();
    expect(writer.detectModeFromMarkdown("Notes/meeting.md")).toBeNull();
    expect(writer.detectModeFromMarkdown({ path: "Notes/meeting.md" })).toBeNull();
    expect(lookups).toBe(0);
    const file = new obsidian.TFile("Notes/meeting.txt", { qnalog_mode: "meeting" });
    file.extension = "txt";
    expect(writer.detectModeFromMarkdown(file)).toBe("meeting");
  });

  it("infers filenames when metadata is missing and preserves filename label behavior", () => {
    const writer = createWriter(() => undefined);
    expect(writer.detectModeFromMarkdown(new obsidian.TFile("Synthesis minutes - Probe.md"))).toBe("synthesis");
    expect(writer.detectModeFromMarkdown(new obsidian.TFile("Recording - Probe.md"))).toBeNull();
    expect(writer.detectModeFromMarkdown(new obsidian.TFile("2026-10-08 1100 · Work notes - Topic.md"))).toBe("meeting");
    expect(writer.detectModeFromMarkdown(new obsidian.TFile("2026-10-08 1100 · 学习记录 - Topic.md"))).toBe("learning");
    expect(writer.detectModeFromMarkdown(new obsidian.TFile("Unknown.md"))).toBeNull();
    expect(detect("Synthesis minutes - Probe.md", {})).toBe("synthesis");
    expect(detect("Recording - Probe.md", {})).toBeNull();
  });

  it("keeps explicit modes and namespace type precedence", () => {
    expect(detect("Untitled.md", { qnalog_mode: "meeting", qnalog_type: "学习", tags: ["seminar"] })).toBe("meeting");
    expect(detect("Untitled.md", { qnalog_mode: "off", qnalog_type: "会议" })).toBe("off");
    expect(detect("Untitled.md", { qnalog_mode: "", mode: "meeting" })).toBeNull();
    expect(detect("Untitled.md", { qnalog_mode: "unknown", mode: "meeting", tags: ["meeting"] })).toBeNull();
    expect(detect("Untitled.md", { qnalog_mode: "会议" })).toBeNull();
    expect(detect("Untitled.md", { qnalog_type: "unknown", type: "会议", 类型: "会议", template: "会议" })).toBeNull();
    expect(detect("Untitled.md", { qnalog_type: "", template: "会议" })).toBe("meeting");
    expect(detect("Learning notes - Probe.md", { qnalog_type: "会议" })).toBe("meeting");
    expect(detect("Untitled.md", { qnalog_mode: "unknown", tags: ["meeting"] })).toBeNull();
  });

  it.each([
    ["学习", "learning"], ["学习记录", "learning"], ["学习视频", "learning"], ["视频学习", "learning"], ["课程笔记", "learning"],
    ["访谈", "interview"], ["访谈调研", "interview"], ["研讨", "seminar"], ["研讨会", "seminar"],
    ["学术研讨", "seminar"], ["主题沙龙", "seminar"], ["会议", "meeting"], ["工作纪要", "meeting"],
    ["小会", "huddle"], ["讨论", "huddle"], ["圆桌讨论", "huddle"], ["独白", "monologue"],
    ["手记", "monologue"], ["个人笔记", "monologue"],
  ])("maps type label %s to %s through supported fields", (label, mode) => {
    for (const field of ["qnalog_type", "type", "类型", "模板", "template"]) {
      expect(detect("Untitled.md", { [field]: label })).toBe(mode);
    }
  });

  it("uses tags, filename, then the clean-state setting and preserves fallback rules", () => {
    expect(detect("Untitled.md", { qnalog_mode: "cleanscript", tags: ["off", "unknown", "qnalog/seminar", "meeting"] })).toBe("seminar");
    expect(detect("Untitled.md", { qnalog_mode: "cleanscript", tags: "off, unknown, Work notes" })).toBe("synthesis");
    expect(detect("Untitled.md", { qnalog_mode: "cleanscript", tags: "工作纪要" })).toBe("meeting");
    expect(detect("Seminar notes - Probe.md", { qnalog_mode: "cleanscript" }, "learning")).toBe("seminar");
    expect(detect("Untitled.md", { qnalog_mode: "cleanscript" }, "seminar")).toBe("seminar");
    expect(detect("Untitled.md", { qnalog_mode: "cleanscript" }, "off")).toBe("meeting");
    expect(detect("Untitled.md", { qnalog_mode: "cleanscript" }, "unknown")).toBe("meeting");
  });

  it("recognizes only registered custom modes across mode, tag, and filename sources", () => {
    const settings = { "custom-mode-probe": template };
    expect(createWriter(() => ({ qnalog_mode: "custom-mode-probe" }), "meeting", settings)
      .detectModeFromMarkdown(new obsidian.TFile("Untitled.md"))).toBe("custom-mode-probe");
    expect(createWriter(() => ({ qnalog_mode: "cleanscript", tags: ["模式探针"] }), "meeting", settings)
      .detectModeFromMarkdown(new obsidian.TFile("Untitled.md"))).toBe("custom-mode-probe");
    expect(createWriter(() => undefined, "meeting", settings)
      .detectModeFromMarkdown(new obsidian.TFile("模式探针 - Probe.md"))).toBe("custom-mode-probe");
    expect(createWriter(() => ({ qnalog_mode: "custom-mode-probe" }), "meeting", {
      "custom-mode-probe": { ...template, customMode: false },
    }).detectModeFromMarkdown(new obsidian.TFile("Untitled.md"))).toBeNull();
  });

  it("reads the current host and settings synchronously at each inference stage", () => {
    const templateSettings = { ...DEFAULT_SETTINGS, polishMode: "meeting", promptTemplates: { "custom-mode-probe": template } };
    const writer = createWriter(() => {
      writer.host = { ...writer.host, settings: templateSettings };
      return { qnalog_mode: "cleanscript", tags: ["模式探针"] };
    });
    expect(writer.detectModeFromMarkdown(new obsidian.TFile("Untitled.md"))).toBe("custom-mode-probe");

    const secondWriter = createWriter(() => ({
      qnalog_mode: "cleanscript",
      get tags() {
        secondWriter.host = { ...secondWriter.host, settings: templateSettings };
        return ["模式探针"];
      },
    }));
    expect(secondWriter.detectModeFromMarkdown(new obsidian.TFile("Untitled.md"))).toBe("custom-mode-probe");
  });

  it("propagates synchronous metadata, tag, and type conversion failures without side effects", () => {
    const failure = new Error("mode lookup failed");
    const writer = createWriter(() => { throw failure; });
    expect(() => writer.detectModeFromMarkdown(new obsidian.TFile("Untitled.md"))).toThrow(failure);
    const tagFailure = new Error("tag lookup failed");
    const tagWriter = createWriter(() => ({
      qnalog_mode: "cleanscript",
      get tags() { throw tagFailure; },
    }));
    expect(() => tagWriter.detectModeFromMarkdown(new obsidian.TFile("Untitled.md"))).toThrow(tagFailure);
    const conversionFailure = new Error("type conversion failed");
    const conversionWriter = createWriter(() => ({
      qnalog_type: { toString() { throw conversionFailure; } },
    }));
    expect(() => conversionWriter.detectModeFromMarkdown(new obsidian.TFile("Untitled.md"))).toThrow(conversionFailure);
  });
});
