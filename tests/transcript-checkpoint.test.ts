import { describe, expect, it } from "vitest";
import { verifyTranscriptCheckpoint } from "../src/imports/transcript-checkpoint";

describe("verifyTranscriptCheckpoint", () => {
  it("accepts imported transcripts only after every successful segment is persisted", () => {
    const segments = [
      { text: "[00:00] [说话人1] 第一段原始转写" },
      { text: "[00:30] [说话人2] 第二段原始转写" },
    ];
    const markdown = `<!-- lexvoice-segments-start:test -->\n${segments[0].text}\n${segments[1].text}\n<!-- lexvoice-segments-end:test -->`;

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
});
