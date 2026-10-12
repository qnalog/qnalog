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

function legacyBlock(segment: Segment, heading: string, text: string): string {
  const record = segment.transcript!;
  const { transcript: _transcript, ...storedSegment } = segment;
  return [
    "<details>", `<summary>${heading.replace(/^###\s*/, "")}</summary>`,
    `<!-- qnalog-transcript-start:${record.id} -->`,
    `<!-- qnalog-transcript-text-start:${record.id} -->`, text,
    `<!-- qnalog-transcript-text-end:${record.id} -->`,
    `<!-- qnalog-transcript-data ${JSON.stringify({ schemaVersion: 2, segment: storedSegment, transcript: record })} -->`,
    `<!-- qnalog-transcript-end:${record.id} -->`, "</details>",
  ].join("\n");
}

function detailBlocks(blocks: string[]): string {
  return blocks.join("\n");
}

function assertDetailsBounded(markdown: string): void {
  const details = [...markdown.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gi)];
  for (const match of details) {
    expect(match[1].length).toBeLessThanOrEqual(3500);
    expect(match[1]).not.toContain("qnalog-transcript-data");
    expect(match[1]).not.toMatch(/\n[ \t]*\n/);
  }
  for (const [, summary] of markdown.matchAll(/<summary>([\s\S]*?)<\/summary>/gi)) {
    expect(summary).not.toMatch(/\[\[|\]\]|<|>/);
    expect(summary).toMatch(/^(?:段落|Segment) \d+ \(\d+:\d{2}(?::\d{2})?–\d+:\d{2}(?::\d{2})?\)$/);
  }
}

describe("transcript hidden-data storage", () => {
  it.each([0, 1, 6, 30])("writes %i independent bounded transcript details", (count) => {
    const segments = Array.from({ length: count }, (_, index) => makeSegment(index, `段落 ${index + 1}。`));
    const output = normalizeTranscriptDataPlacement(detailBlocks(segments.map((segment, index) => serializeTranscriptBlock(segment, `### 段落 ${index + 1} (00:00–00:10)`, segment.text))));
    expect(readTranscriptBlocks(output)).toHaveLength(count);
    expect(output.match(/data-qnalog-transcript-data=/g) || []).toHaveLength(count);
    assertDetailsBounded(output);
    if (count) expect(output.match(/<span hidden data-qnalog-transcript-data=/g)?.length).toBe(count);
    expect(normalizeTranscriptDataPlacement(output)).toBe(output);
  });

  it("splits long segments at sentence boundaries and reads the exact original text", () => {
    const text = `${"句子。 ".repeat(1000)}收尾。`;
    const segment = makeSegment(0, text);
    const output = normalizeTranscriptDataPlacement(serializeTranscriptBlock(segment, "### 很长的一段", text));
    const blocks = readTranscriptBlocks(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].visibleBlock).toBe(text);
    expect([...output.matchAll(/<summary>/g)].length).toBeGreaterThan(1);
    assertDetailsBounded(output);
  });

  it("keeps six segment payload spans on one row and within twice the decoded JSON size", () => {
    const segments = Array.from({ length: 6 }, (_, index) => makeSegment(index, `转写段落 ${index + 1}。`));
    const output = normalizeTranscriptDataPlacement(segments.map((segment, index) => serializeTranscriptBlock(segment, `### 段落 ${index + 1}`, segment.text)).join("\n"));
    const spans = [...output.matchAll(/<span hidden data-qnalog-transcript-data="([^"]+)"[^>]*><\/span>/g)];
    const jsonCharacters = segments.reduce((total, segment) => {
      const { transcript, ...storedSegment } = segment;
      return total + JSON.stringify({ schemaVersion: 2, segment: storedSegment, transcript }).length;
    }, 0);
    const encodedCharacters = spans.reduce((total, match) => total + match[0].length, 0);
    expect(spans).toHaveLength(6);
    expect(encodedCharacters).toBeLessThanOrEqual(jsonCharacters * 2);
    expect(output).toMatch(/<\/details>(?:\r?\n)?(?:<span hidden data-qnalog-transcript-data=.*><\/span>){6}/);
  });

  it("round-trips punctuation, markup characters, newlines, emoji and empty transcript text", () => {
    const texts = ['quote " < > & -->\r\n\n🙂', ""];
    const output = normalizeTranscriptDataPlacement(texts.map((text, index) => serializeTranscriptBlock(makeSegment(index, text), `### 段落 ${index + 1}`, text)).join("\n"));
    expect(readTranscriptBlocks(output).map((block) => block.visibleBlock)).toEqual(texts);
    assertDetailsBounded(output);
  });

  it("reads old inline-comment payloads and rewrites them as hidden base64 data", () => {
    const segment = makeSegment(0, "legacy content");
    const oldNote = legacyBlock(segment, "### 段落 1", segment.text);
    const rewritten = ensureTranscriptBlocks(oldNote, "hidden-data-fixture");
    const [readBack] = readTranscriptBlocks(rewritten);
    expect(readBack.segment.text).toBe("legacy content");
    expect(readBack.visibleBlock).toBe("legacy content");
    expect(rewritten).not.toContain("<!-- qnalog-transcript-data ");
    expect(rewritten).toContain("data-qnalog-transcript-data=");
    expect(readTranscriptBlocks(ensureTranscriptBlocks(rewritten, "hidden-data-fixture"))).toHaveLength(1);
  });

  it("reads the preceding URI-encoded hidden-span format", () => {
    const segment = makeSegment(0, "URI fixture 🙂");
    const encoded = serializeTranscriptBlock(segment, "### URI", segment.text);
    const base64 = encoded.match(/data-qnalog-transcript-data="([^"]+)"/)?.[1];
    if (!base64) throw new Error("Missing transcript span");
    const json = Buffer.from(base64, "base64").toString("utf8");
    const uri = encodeURIComponent(json);
    const oldSpan = encoded.replace(base64, uri);
    expect(readTranscriptBlocks(oldSpan)[0].visibleBlock).toBe(segment.text);
  });

  it("keeps summary text plain and moves source links into the details body", () => {
    const source = attachTextTranscript({
      index: 4, startOffsetMs: 0, endOffsetMs: 1000, text: "source text",
      sourcePath: "QnALog/source.md", sourceName: "source.md",
    }, "hidden-data-fixture", "text-import");
    const output = normalizeTranscriptDataPlacement(serializeTranscriptBlock(source, "### 段落 1 (00:00–00:01) [[QnALog/source.md|source.md]]", source.text));
    expect(output).toMatch(/<summary>(?:段落|Segment) 1 \(00:00–00:01\)<\/summary>\n\[\[QnALog\/source\.md\|source\.md\]\]\n<!-- qnalog-transcript-start:/);
    expect(readTranscriptBlocks(output)[0].heading).toContain("[[QnALog/source.md|source.md]]");
    assertDetailsBounded(output);
  });

  it("does not read summary text when restoring transcript metadata", () => {
    const segment = makeSegment(0, "summary independent");
    const output = serializeTranscriptBlock(segment, "### 段落 1 (00:00–00:01)", segment.text)
      .replace(/<summary>[\s\S]*?<\/summary>/, "<summary>[[invalid]] <title></summary>");
    const [block] = readTranscriptBlocks(output);
    expect(block.visibleBlock).toBe(segment.text);
    expect(block.heading).toMatch(/### (?:段落|Segment) 1 \(00:00–00:01\)/);
  });

  it("reads legacy heading links from stored segment metadata instead of summary text", () => {
    const source = attachTextTranscript({
      index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "legacy source",
      sourcePath: "QnALog/legacy.md", sourceName: "legacy.md",
    }, "hidden-data-fixture", "text-import");
    const old = legacyBlock(source, "### Segment 1 (00:00–00:01) [[QnALog/legacy.md|legacy.md]]", source.text);
    const [block] = readTranscriptBlocks(old);
    const rewritten = replaceTranscriptBlock(old, block, block.segment, block.visibleBlock);
    expect(rewritten).toContain("<summary>Segment 1 (00:00–00:01)</summary>\n[[QnALog/legacy.md|legacy.md]]");
    expect(readTranscriptBlocks(rewritten)[0].visibleBlock).toBe("legacy source");
  });

  it("prefers new hidden data over an old inline copy", () => {
    const segment = makeSegment(0, "preferred content");
    const serialized = serializeTranscriptBlock(segment, "### 段落 1", segment.text);
    const halfMigrated = serialized.replace(`<!-- qnalog-transcript-end:${segment.transcript!.id}:fragment:1 -->`, `<!-- qnalog-transcript-data {"schemaVersion":1} -->\n<!-- qnalog-transcript-end:${segment.transcript!.id}:fragment:1 -->`);
    expect(readTranscriptBlocks(halfMigrated)[0].segment.text).toBe("preferred content");
  });

  it("updates the hidden record when a transcript block is replaced", () => {
    const segment = makeSegment(0, "before");
    const output = normalizeTranscriptDataPlacement(serializeTranscriptBlock(segment, "### 段落 1", "before"));
    const block = readTranscriptBlocks(output)[0];
    const updated = attachTextTranscript({ ...block.segment, text: "after" }, "hidden-data-fixture", "edited-transcript");
    const next = replaceTranscriptBlock(output, block, updated, "after");
    expect(readTranscriptBlocks(next).map((item) => item.segment.text)).toEqual(["after"]);
    expect(next.match(/data-qnalog-transcript-data=/g) || []).toHaveLength(1);
    assertDetailsBounded(next);
  });
});
