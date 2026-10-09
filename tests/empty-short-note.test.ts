import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  TFile: class {},
  TFolder: class {},
  normalizePath: (path: string) => String(path || ""),
}));
import { buildConsolidatedNoteContent } from "../src/notes/note-write-content";
import { buildRewriteSegmentBlock } from "../src/notes/note-transcript-materials";
import { analyzeEmptyShortNote, stripEmptyPlaceholders } from "../src/notes/empty-short-note";

const NOTE_TITLE = "# 个人笔记 2026-09-14 11:33 · 个人笔记";
const MATERIALS = {
  recordingInfo: "",
  externalAudioSource: "",
  meetingWorkbench: "",
  realtimeOutline: "",
  textImportSource: "",
};

function buildNote(options: {
  endOffsetMs?: number;
  text?: string;
  error?: string;
  title?: string;
  polishBody?: string;
  omitSegmentHeading?: boolean;
  omitMarkers?: boolean;
} = {}): string {
  const endOffsetMs = options.endOffsetMs ?? 4000;
  const segment = {
    index: 0,
    startOffsetMs: 0,
    endOffsetMs,
    text: options.text ?? "",
    error: options.error ?? (options.text ? undefined : "transcription failed"),
  };
  let rawBlocks = buildRewriteSegmentBlock(segment, "![[rec.webm]]");
  if (options.omitSegmentHeading) rawBlocks = rawBlocks.replace(/^### .*\r?\n/m, "");
  const content = buildConsolidatedNoteContent({
    currentMarkdown: "",
    title: options.title ?? NOTE_TITLE,
    sessionId: "s1",
    continuationSessionId: "",
    totalMs: endOffsetMs,
    segmentCount: 1,
    textImport: false,
    retainAudio: true,
    isContinuation: false,
    masterAudioBlock: "",
    audioRow: "![[rec.webm]]",
    priorAudioAppendix: "",
    rawBlocks,
    polish: { frontmatter: "", body: options.polishBody ?? "", sedimentBlock: "" },
    materials: MATERIALS,
  });
  return options.omitMarkers
    ? content.replace(/<!-- qnalog-(?:session|segments-start):[^>]+ -->\n?/g, "")
    : content;
}

const candidateFile = { path: "Notes/blank.md" };

function candidate(markdown: string) {
  return analyzeEmptyShortNote(candidateFile, markdown);
}

describe("empty short note deletion decision", () => {
  it("offers a failed-transcription note at 4 seconds with its audio reference", () => {
    expect(candidate(buildNote())).toMatchObject({
      file: candidateFile,
      durationMs: 4000,
      audioRefs: ["rec.webm"],
    });
  });

  it("includes the 10-second boundary and rejects longer or unmeasurable notes", () => {
    expect(candidate(buildNote({ endOffsetMs: 10000 }))).not.toBeNull();
    expect(candidate(buildNote({ endOffsetMs: 11000 }))).toBeNull();
    expect(candidate(buildNote({ omitSegmentHeading: true }))).toBeNull();
  });

  it("rejects valid transcript text and polished prose", () => {
    expect(candidate(buildNote({ text: "你好" }))).toBeNull();
    expect(candidate(buildNote({ polishBody: "A user-written paragraph." }))).toBeNull();
  });

  it.each([
    "此段无内容",
    "无输出",
    "转写失败",
    "等待后台转写",
    "此段尚未完成转写",
    "合并润色失败",
    "No content in this segment",
    "No output",
    "Transcription failed",
    "Waiting for background transcription",
    "This segment is not fully transcribed yet",
    "Merge failed",
  ])("treats the placeholder variant %s as empty transcript text", (placeholder) => {
    const text = ` \n _[${placeholder}]_ \t`;
    expect(stripEmptyPlaceholders(text)).toBe("");
    expect(candidate(buildNote({ text }))).not.toBeNull();
  });

  it("requires the generated-note title and QnALog session or segment marker", () => {
    expect(candidate(buildNote({ title: "# 只有标题" }))).toBeNull();
    expect(candidate(buildNote({ omitMarkers: true }))).toBeNull();
  });
});
