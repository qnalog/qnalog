import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
}));

import { attachTextTranscript } from "../src/transcript/session-transcript";
import { readTranscriptBlocks, serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
import { buildRewriteSegmentBlock } from "../src/notes/note-transcript-materials";
import { getAudioTimeLink } from "../src/notes/audio-reference-text";
import { labelText } from "../src/shared/note-labels";
import { nsMarker } from "../src/shared/namespace";
import { formatElapsed } from "../src/shared/util-common";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import type { Segment } from "../src/shared/types";

// 特征测试：锁住五条写入路径当前交给 serializeTranscriptBlock 的分段标题，以及它们最终落在笔记里的样子。
// 标题字符串按各路径源码逐字构造（行号见每个用例），统一分段标题前不改变这些断言。

const initialLanguage = getActiveUiLanguage();
beforeEach(() => setActiveUiLanguage(resolveUiLanguage("en", "en")));
afterEach(() => setActiveUiLanguage(initialLanguage));

function segment(index: number, extra: Partial<Segment> = {}): Segment {
  return attachTextTranscript({
    index,
    startOffsetMs: index * 10_000,
    endOffsetMs: (index + 1) * 10_000,
    audioStartOffsetMs: index * 10_000,
    audioEndOffsetMs: (index + 1) * 10_000,
    audioName: "rec.webm",
    audioPath: "QnALog/Recordings/rec.webm",
    text: "Spoken words.",
    ...extra,
  }, "src-1", "text-import");
}

/** 从序列化结果取 <summary> 之后、第一个 QnALog 标记之前的「材料」行。 */
function materialLines(block: string): string[] {
  const lines = block.split("\n");
  const start = lines.findIndex((line) => line.startsWith("<summary>")) + 1;
  const end = lines.findIndex((line, index) => index >= start && line.startsWith("<!--"));
  return lines.slice(start, end);
}

function summaryOf(block: string): string {
  return block.match(/<summary>([^<]*)<\/summary>/)?.[1] || "";
}

const expectedSummary = (index: number) => labelText("rawTranscriptSegmentRange", index + 1, formatElapsed(index * 10_000), formatElapsed((index + 1) * 10_000));

describe("transcript segment headings: current output per write path", () => {
  it("live recording (notes/live-segment-flow.ts): inline wiki link; ' · 结束' and the heading text are dropped", () => {
    const seg = segment(1, { isFinal: true, queueTaskId: "task-live" });
    const segTitle = `### ${labelText("segment", 2)} (${formatElapsed(10_000)}–${formatElapsed(20_000)}) ${getAudioTimeLink("rec.webm", 10_000)} · 结束`;
    const heading = [segTitle, nsMarker("transcribe-task", "task-live")].join("\n\n");
    const block = serializeTranscriptBlock(seg, heading, "Spoken words.");
    expect(summaryOf(block)).toBe(expectedSummary(1));
    expect(materialLines(block)).toEqual(["[[rec.webm|00:10]]"]);
    expect(block).not.toContain("结束");
    expect(block).toContain(nsMarker("transcribe-task", "task-live"));
  });

  it("import (imports/import-service.ts): 'Audio N' heading is dropped; the wiki link is kept", () => {
    const seg = segment(0, { isFinal: true, queueTaskId: "task-import" });
    const heading = `### ${labelText("audio", 1)} ${getAudioTimeLink("rec.webm", 0)} · 结束\n\n${nsMarker("transcribe-task", "task-import")}`;
    const block = serializeTranscriptBlock(seg, heading, "Spoken words.");
    expect(summaryOf(block)).toBe(expectedSummary(0));
    expect(materialLines(block)).toEqual(["[[rec.webm|00:00]]"]);
    expect(block).not.toContain(labelText("audio", 1));
    expect(block).not.toContain("结束");
  });

  it("transcription retry (queue/queue-transcribe-retry-flow.ts): HTML internal-link anchor on its own line", () => {
    const seg = segment(2, { queueTaskId: "task-retry" });
    const anchor = '<a class="internal-link qnalog-time-link" data-href="QnALog/.cache/segments/rec%20seg.webm" href="QnALog/.cache/segments/rec%20seg.webm">00:00</a>';
    const heading = [`### ${labelText("segment", 3)} (${formatElapsed(20_000)}–${formatElapsed(30_000)})`, anchor, nsMarker("transcribe-task", "task-retry")].join("\n\n");
    const block = serializeTranscriptBlock(seg, heading, "Spoken words.");
    expect(summaryOf(block)).toBe(expectedSummary(2));
    expect(materialLines(block)).toEqual([anchor]);
  });

  it("transcript recovery (notes/transcript-recovery-flow.ts): single segment with an inline wiki link at 00:00", () => {
    const seg = segment(0, { queueTaskId: "task-recover" });
    const heading = [
      `### ${labelText("segment", 1)} (${formatElapsed(0)}–${formatElapsed(10_000)}) ${getAudioTimeLink("rec.webm", 0)}`,
      nsMarker("transcribe-task", "task-recover"),
    ].join("\n\n");
    const block = serializeTranscriptBlock(seg, heading, "Spoken words.");
    expect(summaryOf(block)).toBe(expectedSummary(0));
    expect(materialLines(block)).toEqual(["[[rec.webm|00:00]]"]);
  });

  it("finalize rewrite (notes/note-transcript-materials.ts): wiki link on the line after the summary", () => {
    const seg = segment(1, { queueTaskId: "task-rewrite" });
    const block = buildRewriteSegmentBlock(seg, getAudioTimeLink("rec.webm", 10_000));
    expect(summaryOf(block)).toBe(expectedSummary(1));
    expect(materialLines(block)).toEqual(["[[rec.webm|00:10]]"]);
    expect(block).toContain(nsMarker("transcribe-task", "task-rewrite"));
  });

  it("all paths produce the same summary and read back to the same segment text", () => {
    const blocks = [
      serializeTranscriptBlock(segment(0), `### ${labelText("segment", 1)} (00:00–00:10) ${getAudioTimeLink("rec.webm", 0)} · 结束`, "Spoken words."),
      serializeTranscriptBlock(segment(0), `### ${labelText("audio", 1)} ${getAudioTimeLink("rec.webm", 0)}`, "Spoken words."),
      buildRewriteSegmentBlock(segment(0), getAudioTimeLink("rec.webm", 0)),
    ];
    expect(new Set(blocks.map(summaryOf)).size).toBe(1);
    for (const block of blocks) {
      const [read] = readTranscriptBlocks(block);
      expect(read.visibleBlock).toBe("Spoken words.");
      expect(read.drifted).toBe(false);
    }
  });
});
