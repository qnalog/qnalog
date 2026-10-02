import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import { extractNotePanelData } from "../src/notes/detail-blocks";
import { mapAudioTimeToNote, mapNoteTimeToAudio } from "../src/notes/note-audio-timeline";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import { serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
import type { Segment } from "../src/shared/types";

function segment(index: number, source: string, noteStart: number, localStart: number): Segment {
  const noteEnd = noteStart + 10000;
  const localEnd = localStart + 10000;
  return attachTextTranscript({
    index,
    startOffsetMs: noteStart,
    endOffsetMs: noteEnd,
    audioStartOffsetMs: localStart,
    audioEndOffsetMs: localEnd,
    audioPath: `QnALog/录音/${source}.webm`,
    audioName: `${source}.webm`,
    text: `Transcript ${index}`,
  }, `source-${source}-${index}`, "text-import");
}

function note(segments: Segment[]): string {
  return [
    "# Timeline note",
    "<details><summary>分段原始转写</summary>",
    "<!-- qnalog-segments-start:session -->",
    ...segments.map(item => serializeTranscriptBlock(item, `### Segment ${item.index + 1}`, item.text)),
    "<!-- qnalog-segments-end:session -->",
    "</details>",
    "<!-- qnalog-session:session -->",
  ].join("\n");
}

describe("completed note panel audio timeline", () => {
  it("exposes cumulative offsets from the original transcript ledger", () => {
    const segments = [
      segment(0, "first", 0, 0),
      segment(1, "latest", 148418, 0),
      segment(2, "latest", 158418, 10000),
    ];
    const data = extractNotePanelData(null, null, note(segments));
    expect(data?.audioTimelineComplete).toBe(true);
    expect(mapNoteTimeToAudio(data?.audioTimeline || [], 148418)?.localMs).toBe(0);
    expect(mapNoteTimeToAudio(data?.audioTimeline || [], 158418)?.localMs).toBe(10000);
    expect(mapAudioTimeToNote(data?.audioTimeline || [], "QnALog/录音/latest.webm", 0)).toBe(148418);
  });

  it("reads the complete current outline instead of a previous outline archive", () => {
    const outline = [
      "- [[first.webm|00:00]] First recording topics",
      "  - preserved decisions",
      "- [[latest.webm|00:00]] Continuation planning",
      "- [[latest.webm|00:10]] Continuation implementation",
      "- [[latest.webm|00:20]] Continuation verification",
    ].join("\n");
    const coverage = JSON.stringify({
      version: 1,
      outlineHash: "outline-hash",
      sourceHash: "source-hash",
      committedSegmentCount: 5,
      totalSegmentCount: 5,
    });
    const markdown = [
      note([segment(0, "first", 0, 0), segment(1, "latest", 10000, 0)]),
      "<details><summary>录音中实时大纲（草稿）</summary>",
      "",
      "> 基于录音过程中已完成的分段自动生成，正文纪要以最终整理为准。",
      "",
      outline,
      "",
      "> 以下为追加录音前场次（2026-10-01 11:00）的实时大纲草稿。",
      "- Archived topic",
      `<!-- qnalog-realtime-outline-source-coverage:${coverage} -->`,
      "</details>",
    ].join("\n");
    const data = extractNotePanelData(null, null, markdown);
    expect(data?.outline).toBe(outline);
  });

  it("does not claim cumulative playback when a legacy segment lacks local clocks", () => {
    const legacy: Segment = attachTextTranscript({
      index: 0,
      startOffsetMs: 0,
      endOffsetMs: 10000,
      audioName: "legacy.webm",
      text: "Legacy transcript",
    }, "legacy-source", "text-import");
    const data = extractNotePanelData(null, null, note([legacy]));
    expect(data?.audioTimelineComplete).toBe(false);
    expect(data?.audioTimeline).toEqual([]);
  });
});
