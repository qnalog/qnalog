import { describe, expect, it } from "vitest";
import { attachTextTranscript, getCurrentTranscript, getTranscriptSourceRevision, splitTranscriptTextUnits } from "../src/transcript/session-transcript";
import { readTranscriptBlocks, serializeTranscriptBlock, stripTranscriptMetadata } from "../src/transcript/transcript-markdown";
import type { Segment } from "../src/shared/types";

function importedSegment(text: string): Segment {
  return {
    index: 4,
    startOffsetMs: 12_000,
    endOffsetMs: 15_000,
    audioStartOffsetMs: 500,
    audioEndOffsetMs: 3_500,
    audioName: "source.wav",
    text,
  };
}

describe("session transcript source ledger", () => {
  it("keeps imported raw text and stable unit identities across display changes", () => {
    const original = importedSegment("QNA 洛格。下一句 3.14 seconds. Last sentence!");
    const attached = attachTextTranscript(original, "session/one", "text-import");
    const current = getCurrentTranscript(attached.transcript!);
    expect(current.rawText).toBe(original.text);
    expect(current.utterances.map((unit) => unit.rawText).join("")).toBe(original.text);
    expect(current.utterances.map((unit) => unit.normalizedText)).toEqual([
      "QNA 洛格。",
      "下一句 3.14 seconds. ",
      "Last sentence!",
    ]);
    expect(current.utterances.every((unit) => unit.timing === "unknown" && unit.startMs === null && unit.endMs === null)).toBe(true);

    const sourceRevision = getTranscriptSourceRevision([attached]);
    const reindexed = attachTextTranscript({ ...attached, index: 22, sourcePath: "renamed.md" }, "session/one", "text-import");
    expect(reindexed.transcript?.id).toBe(attached.transcript?.id);
    expect(reindexed.transcript?.currentRevision).toBe(1);
    expect(reindexed.transcript?.revisions[0].utterances.map((unit) => unit.id)).toEqual(current.utterances.map((unit) => unit.id));
    expect(getTranscriptSourceRevision([reindexed])).toBe(sourceRevision);
    expect(original.transcript).toBeUndefined();
  });

  it("splits long text without breaking surrogate pairs or changing source bytes", () => {
    const source = `${"甲".repeat(999)}🙂${"乙".repeat(12)}`;
    const units = splitTranscriptTextUnits(source);
    expect(units.join("")).toBe(source);
    expect(units.every((unit) => unit.length <= 1000)).toBe(true);
    expect(units.some((unit) => unit.endsWith("\ud83d") || unit.startsWith("\ude42"))).toBe(false);
  });

  it("round-trips a visible block and escapes metadata without hiding its text", () => {
    const text = "First --> `code` <details>\nSecond line";
    const segment = attachTextTranscript(importedSegment(text), "session:unsafe/id", "text-import");
    const markdown = serializeTranscriptBlock(segment, "### Audio source 4", text);
    expect(markdown).toContain("\\u002d\\u002d\\u003e");
    expect(markdown).toContain("\\u0060");
    expect(markdown).toContain("\\u003cdetails\\u003e");

    const [block] = readTranscriptBlocks(markdown);
    expect(block.segment).toEqual(segment);
    expect(block.visibleBlock).toBe(text);
    expect(block.drifted).toBe(false);
    expect(block.segment.transcript?.revisions[0].rawText).toBe(text);

    const edited = markdown.replace("First --> `code`", "Edited --> `code`");
    expect(readTranscriptBlocks(edited)[0].drifted).toBe(true);
    const plain = stripTranscriptMetadata(markdown);
    expect(plain).toContain(text);
    expect(plain).not.toContain("qnalog-transcript-");
  });
  it("ignores a marker-shaped literal that has no transcript block structure", () => {
    const literal = "Legacy text mentions <!-- qnalog-transcript-start:fake --> as an example.";
    expect(readTranscriptBlocks(literal)).toEqual([]);
  });

  it("rejects damaged boundaries and future metadata instead of guessing", () => {
    const segment = attachTextTranscript(importedSegment("Evidence."), "session/two", "text-import");
    const markdown = serializeTranscriptBlock(segment, "### Segment 4", segment.text);
    expect(() => readTranscriptBlocks(markdown.replace(/<!-- qnalog-transcript-text-end:[^>]+ -->/, "")))
      .toThrow("damaged metadata boundaries");
    expect(() => readTranscriptBlocks(markdown.replace('"schemaVersion":2', '"schemaVersion":3')))
      .toThrow("unsupported schema");
  });
  it("rejects a source block missing both its outer end and visible-text start markers", () => {
    const segment = attachTextTranscript(importedSegment("Evidence."), "session/incomplete", "text-import");
    const markdown = serializeTranscriptBlock(segment, "### Segment 5", segment.text)
      .replace(/<!-- qnalog-transcript-text-start:[^>]+ -->/, "")
      .replace(/<!-- qnalog-transcript-end:[^>]+ -->/, "");
    expect(() => readTranscriptBlocks(markdown)).toThrow("no matching end marker");
  });

  it("retains old revisions when imported source text changes", () => {
    const first = attachTextTranscript(importedSegment("Original."), "session/three", "text-import");
    const next = attachTextTranscript({ ...first, text: "Corrected." }, "session/three", "text-import");
    expect(next.transcript?.currentRevision).toBe(2);
    expect(next.transcript?.revisions).toHaveLength(2);
    expect(next.transcript?.revisions[0].rawText).toBe("Original.");
    expect(next.transcript?.revisions[1].rawText).toBe("Corrected.");
    expect(next.transcript?.revisions[0].utterances[0].id).not.toBe(next.transcript?.revisions[1].utterances[0].id);
  });
});
