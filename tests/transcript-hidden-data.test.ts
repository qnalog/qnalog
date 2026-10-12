import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ TFile: class TFile {}, normalizePath: (path: string) => path }));
import type { Segment } from "../src/shared/types";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import {
  normalizeTranscriptDataPlacement,
  readTranscriptBlocks,
  replaceTranscriptBlock,
  serializeTranscriptBlock,
} from "../src/transcript/transcript-markdown";
import { ensureTranscriptBlocks } from "../src/notes/note-transcript-ledger";

function makeSegment(index: number, text: string): Segment {
  return attachTextTranscript({ index, startOffsetMs: index * 1000, endOffsetMs: (index + 1) * 1000, text }, "hidden-data-fixture", "text-import");
}

function payloadAndId(block: string): { payload: string; id: string } {
  const encoded = block.match(/data-qnalog-transcript-data="([^"]+)"/)?.[1];
  const id = block.match(/data-qnalog-segment="([^"]+)"/)?.[1];
  if (encoded && id) return { payload: Buffer.from(encoded, "base64").toString("utf8"), id: decodeURIComponent(id) };
  const legacy = block.match(/<!-- qnalog-transcript-data ([\s\S]*?) -->/);
  const legacyId = block.match(/<!-- qnalog-transcript-start:([^ ]+) -->/)?.[1];
  if (!legacy || !legacyId) throw new Error("Serialized transcript data is missing");
  return { payload: legacy[1], id: legacyId };
}

function detail(blocks: string[]): string {
  return ["<details>", "<summary>分段原始转写</summary>", "<!-- qnalog-segments-start:test -->", ...blocks, "<!-- qnalog-segments-end:test -->", "</details>"].join("\n");
}

describe("transcript hidden-data storage", () => {
  it.each([0, 1, 3])("writes %i transcript blocks outside the raw-transcript details", (count) => {
    const serialized = Array.from({ length: count }, (_, index) => serializeTranscriptBlock(makeSegment(index, `段落 ${index + 1}`), `### 段落 ${index + 1}`, `段落 ${index + 1}`));
    const output = normalizeTranscriptDataPlacement(detail(serialized));
    const details = output.slice(0, output.indexOf("</details>") + "</details>".length);
    expect(details).not.toContain("qnalog-transcript-data");
    expect(details).not.toContain("data-qnalog-transcript-data");
    expect(readTranscriptBlocks(output)).toHaveLength(count);
    expect(output.match(/data-qnalog-transcript-data=/g) || []).toHaveLength(count);
    if (count) expect(output.slice(output.indexOf("</details>")).split("\n")[1]).toMatch(/^(?:<span hidden data-qnalog-transcript-data=.*><\/span>)+$/);
  });

  it("migrates a legacy inline comment on normal rewrite and preserves its transcript", () => {
    const segment = makeSegment(0, "legacy content");
    const serialized = serializeTranscriptBlock(segment, "### 段落 1", segment.text);
    const oldNote = detail([serialized]);
    const rewritten = ensureTranscriptBlocks(oldNote, "hidden-data-fixture");
    const [readBack] = readTranscriptBlocks(rewritten);
    expect(readBack.segment.text).toBe("legacy content");
    expect(readBack.visibleBlock).toBe("legacy content");
    expect(rewritten).not.toContain("<!-- qnalog-transcript-data ");
    expect(rewritten.indexOf("data-qnalog-transcript-data=")).toBeGreaterThan(rewritten.indexOf("</details>"));
    expect(ensureTranscriptBlocks(rewritten, "hidden-data-fixture")).toBe(rewritten);
  });

  it("prefers the hidden row over a legacy comment in a partly migrated note", () => {
    const segment = makeSegment(0, "preferred content");
    const serialized = serializeTranscriptBlock(segment, "### 段落 1", segment.text);
    const { id } = payloadAndId(serialized);
    const oldPayload = JSON.stringify({ schemaVersion: 2, segment: { ...segment, transcript: undefined }, transcript: segment.transcript, stale: true });
    const halfMigrated = normalizeTranscriptDataPlacement(detail([serialized]))
      .replace(`<!-- qnalog-transcript-end:${id} -->`, `<!-- qnalog-transcript-data ${oldPayload} -->\n<!-- qnalog-transcript-end:${id} -->`);
    expect(readTranscriptBlocks(halfMigrated)[0].segment.text).toBe("preferred content");
    expect(normalizeTranscriptDataPlacement(halfMigrated)).not.toContain("<!-- qnalog-transcript-data ");
  });

  it("round-trips punctuation, markup characters, newlines, emoji and empty transcript text", () => {
    const texts = ['quote " < > & -->\n🙂', ""];
    const serialized = texts.map((text, index) => serializeTranscriptBlock(makeSegment(index, text), `### 段落 ${index + 1}`, text));
    const output = normalizeTranscriptDataPlacement(detail(serialized));
    expect(readTranscriptBlocks(output).map((block) => block.visibleBlock)).toEqual(texts);
  });

  it("updates the hidden record when a transcript block is replaced", () => {
    const segment = makeSegment(0, "before");
    const output = normalizeTranscriptDataPlacement(detail([serializeTranscriptBlock(segment, "### 段落 1", "before")]));
    const block = readTranscriptBlocks(output)[0];
    const updated = attachTextTranscript({ ...block.segment, text: "after" }, "hidden-data-fixture", "edited-transcript");
    const next = replaceTranscriptBlock(output, block, updated, "after");
    expect(readTranscriptBlocks(next).map((item) => item.segment.text)).toEqual(["after"]);
    expect(next.match(/data-qnalog-transcript-data=/g) || []).toHaveLength(1);
    expect(next.slice(0, next.indexOf("</details>") + "</details>".length)).not.toContain("transcript-data");
  });
});
