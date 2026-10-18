import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dedupeTranscriptBlocks } from "../src/transcript/dedupe-transcript-blocks";
import { readTranscriptBlocks, findTranscriptDataElements } from "../src/transcript/transcript-markdown";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const SEG0 = "seg:qnalog-mvbx4lix-hj5fvt:0";
const SEG1 = "seg:qnalog-mvbx4lix-hj5fvt:1";
const REAL_TEXT = "现在是2026年的10月17号12:50，我们计划下午1点。";
const WAITING = "_[等待后台转写，音频已保留]_";

/** Returns the backfilled fixture with the segment 0 block (and its hidden payload) written twice. */
function duplicatedSegmentZero(options: { copyText?: string; firstText?: string } = {}): string {
  const base = fixture("backfilled-note-general.md");
  const start = base.indexOf("<details>\n<summary>原始转写 · 段落 1");
  const end = base.indexOf("</details>\n", start) + "</details>\n".length;
  const block = base.slice(start, end);
  const span = base.match(/<span hidden data-qnalog-transcript-data="[^"]*" data-qnalog-segment="seg%3Aqnalog-mvbx4lix-hj5fvt%3A0"><\/span>/)![0];
  const firstBlock = options.firstText === undefined ? block : block.replace(REAL_TEXT, options.firstText);
  const copy = options.copyText === undefined ? block : block.replace(REAL_TEXT, options.copyText);
  const withCopy = base.slice(0, start) + firstBlock + copy + base.slice(end);
  return withCopy.replace(span, `${span}${span}`);
}

describe("dedupeTranscriptBlocks", () => {
  it("returns the note unchanged when no transcript id is repeated (case 5 precondition)", () => {
    const note = fixture("backfilled-note-general.md");
    const result = dedupeTranscriptBlocks(note);
    expect(result).toEqual({ status: "unchanged", markdown: note });
  });

  it("keeps one placeholder block of a real duplicated note and removes the other with its markers moved, not lost", () => {
    const note = fixture("duplicate-transcript-blocks.md");
    const result = dedupeTranscriptBlocks(note);
    expect(result.status).toBe("repaired");
    if (result.status !== "repaired") return;
    const blocks = readTranscriptBlocks(result.markdown);
    expect(blocks.map((block) => block.segment.transcript?.id)).toEqual(["seg:qnalog-mvcjgw9z-b3kio1:0"]);
    expect(blocks[0].visibleBlock).toBe(WAITING);
    expect(result.markdown.match(/qnalog-segments-start:/g)?.length).toBe(1);
    expect(result.markdown.match(/qnalog-segments-end:/g)?.length).toBe(1);
    expect(result.markdown.match(/qnalog-transcribe-task:/g)?.length).toBe(1);
    expect(findTranscriptDataElements(result.markdown)).toHaveLength(1);
    expect(result.repairs).toEqual([{ id: "seg:qnalog-mvcjgw9z-b3kio1:0", blocks: 2, removed: 1 }]);
    // Idempotent (case 5).
    expect(dedupeTranscriptBlocks(result.markdown)).toEqual({ status: "unchanged", markdown: result.markdown });
  });

  it("removes a same-text duplicate, its hidden span, and leaves other blocks byte-identical (cases 1, 3, 4)", () => {
    const note = duplicatedSegmentZero();
    const base = fixture("backfilled-note-general.md");
    const result = dedupeTranscriptBlocks(note);
    expect(result.status).toBe("repaired");
    if (result.status !== "repaired") return;
    const blocks = readTranscriptBlocks(result.markdown);
    expect(blocks.map((block) => block.segment.transcript?.id)).toEqual([SEG0, SEG1]);
    expect(blocks[0].visibleBlock).toBe(REAL_TEXT);
    expect(blocks[1].visibleBlock).toBe("点半左右出发。");
    // The removed copy and its span are gone; exactly one span per id remains.
    expect(findTranscriptDataElements(result.markdown)).toHaveLength(2);
    // The kept block and the other segment's block are the original bytes.
    const seg0Start = base.indexOf("<details>\n<summary>原始转写 · 段落 1");
    const seg0Block = base.slice(seg0Start, base.indexOf("</details>\n", seg0Start) + "</details>\n".length);
    expect(result.markdown.startsWith(base.slice(0, seg0Start) + seg0Block)).toBe(true);
    expect(result.markdown.includes(base.slice(base.indexOf("<details>\n<summary>原始转写 · 段落 2"), base.indexOf("</details>\n", base.indexOf("<details>\n<summary>原始转写 · 段落 2")) + "</details>\n".length))).toBe(true);
    expect(dedupeTranscriptBlocks(result.markdown)).toEqual({ status: "unchanged", markdown: result.markdown });
  });

  it("keeps the real-text block when the other duplicate is a placeholder (case 1)", () => {
    const note = duplicatedSegmentZero({ firstText: WAITING });
    const result = dedupeTranscriptBlocks(note);
    expect(result.status).toBe("repaired");
    if (result.status !== "repaired") return;
    const blocks = readTranscriptBlocks(result.markdown).filter((block) => block.segment.transcript?.id === SEG0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].visibleBlock).toBe(REAL_TEXT);
    expect(findTranscriptDataElements(result.markdown).filter((element) => element.id === SEG0)).toHaveLength(1);
  });

  it("reports different real texts as ambiguous and changes nothing (case 2)", () => {
    const note = duplicatedSegmentZero({ copyText: "另一段不同的文字。" });
    const result = dedupeTranscriptBlocks(note);
    expect(result).toEqual({ status: "ambiguous", markdown: note, ids: [SEG0] });
  });
});
