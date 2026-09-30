import { describe, expect, it } from "vitest";
import { verifyTranscriptCheckpoint } from "../src/imports/transcript-checkpoint";
import { attachTranscriptResult } from "../src/transcript/session-transcript";
import { serializeTranscriptBlock } from "../src/transcript/transcript-markdown";

describe("verifyTranscriptCheckpoint", () => {
  it("accepts imported transcripts only after every successful segment is persisted", () => {
    const segments = [
      { text: "[00:00] [说话人1] 第一段原始转写" },
      { text: "[00:30] [说话人2] 第二段原始转写" },
    ];
    const markdown = `<!-- qnalog-segments-start:test -->\n${segments[0].text}\n${segments[1].text}\n<!-- qnalog-segments-end:test -->`;

    expect(verifyTranscriptCheckpoint(markdown, segments)).toEqual({
      ok: true,
      expectedSegments: 2,
      persistedSegments: 2,
      expectedChars: segments[0].text.length + segments[1].text.length,
      missingSegmentIndexes: [],
    });
  });

  it("reports the exact segment missing from Markdown", () => {
    const result = verifyTranscriptCheckpoint("只有第一段原始转写", [
      { text: "第一段原始转写" },
      { text: "第二段原始转写" },
      { text: "失败段", error: "ASR failed" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.expectedSegments).toBe(2);
    expect(result.persistedSegments).toBe(1);
    expect(result.missingSegmentIndexes).toEqual([1]);
  });
  it("requires each successful v2 source record and an unchanged visible projection", () => {
    const segment = attachTranscriptResult({
      index: 0,
      startOffsetMs: 0,
      endOffsetMs: 1000,
      text: "Original phrase.",
    }, "session-checkpoint", {
      text: "Original phrase.",
      rawText: "Original phrase.",
      providerId: "test-asr",
      units: [{
        rawText: "Original phrase.",
        normalizedText: "Original phrase.",
        speakerId: null,
        speakerName: null,
        startMs: null,
        endMs: null,
        timing: "unknown",
      }],
    }, "asr");
    const block = serializeTranscriptBlock(segment, "### Segment 1", segment.text);
    expect(verifyTranscriptCheckpoint(block, [segment]).ok).toBe(true);
    expect(verifyTranscriptCheckpoint(block.replace(/<!-- qnalog-transcript-data[\s\S]*?-->/, ""), [segment]).ok).toBe(false);
    expect(verifyTranscriptCheckpoint(block.replace("Original phrase.", "Edited phrase."), [segment]).ok).toBe(false);
  });
});
