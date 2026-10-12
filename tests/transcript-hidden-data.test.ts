import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ TFile: class TFile {}, normalizePath: (path: string) => path }));
import type { Segment } from "../src/shared/types";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import {
  normalizeTranscriptDataPlacement,
  normalizeTranscriptLayout,
  readTranscriptBlocks,
  replaceTranscriptBlock,
  serializeTranscriptBlock,
} from "../src/transcript/transcript-markdown";
import { ensureTranscriptBlocks } from "../src/notes/note-transcript-ledger";
import { buildOutlineCoverageMetadata, readCurrentOutlineBlock } from "../src/notes/outline-storage";

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
    if (/^(?:段落|Segment)\s+\d+/.test(summary)) {
      expect(summary).toMatch(/^(?:段落|Segment) \d+ \(\d+:\d{2}(?::\d{2})?–\d+:\d{2}(?::\d{2})?\)$/);
    }
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

  it("splits a legacy multi-segment details wrapper during in-place normalization", () => {
    const previousLanguage = getActiveUiLanguage();
    setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
    try {
    const segments = [makeSegment(0, "第一段。"), makeSegment(1, "第二段。")];
    const oldNote = [
      "---", "## 原始材料", "<details>", "<summary>分段原始转写（2 段）</summary>", "",
      legacyBlock(segments[0], "### 段落 1 (00:00–00:01)", segments[0].text), "",
      legacyBlock(segments[1], "### 段落 2 (00:01–00:02)", segments[1].text), "",
      "</details>",
    ].join("\n");
    const normalized = normalizeTranscriptLayout(oldNote);
    const restored = readTranscriptBlocks(normalized);
    expect(restored.map((block) => block.visibleBlock)).toEqual(["第一段。", "第二段。"]);
    expect(restored.map((block) => block.segment.transcript)).toEqual(segments.map((segment) => segment.transcript));
    expect(normalized).toContain("**分段原始转写（2 段）**");
    expect(normalized.match(/<summary>/g)).toHaveLength(2);
    expect(normalized).not.toContain("<!-- qnalog-transcript-data ");
    expect(normalized).toMatch(/data-qnalog-transcript-data=.*data-qnalog-segment=/);
    expect(normalizeTranscriptLayout(normalized)).toBe(normalized);
    assertDetailsBounded(normalized);
    } finally {
      setActiveUiLanguage(previousLanguage);
    }
  });

  it("splits the 1.6.4 grouped details layout with blank lines and inline JSON comments", () => {
    const previousLanguage = getActiveUiLanguage();
    setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
    try {
      const texts = ["甲句。".repeat(55), "乙句。".repeat(170), "丙句。".repeat(360)];
      const segments = texts.map((text, index) => {
        const segment = makeSegment(index, text);
        const current = segment.transcript!.revisions.find((revision) => revision.revision === segment.transcript!.currentRevision)!;
        const utterance = current.utterances[0];
        if (utterance) {
          utterance.speakerId = `speaker-${index + 1}`;
          utterance.speakerName = `发言人${index + 1}`;
          utterance.startMs = index * 10_000;
          utterance.endMs = index * 10_000 + 500;
          current.corrections.push({ revision: current.revision, kind: "speaker", from: "说话人", to: utterance.speakerName, utteranceIds: [utterance.id] });
        }
        return segment;
      });
      const oldParts = segments.map((segment, index) => {
        const block = legacyBlock(segment, `### 段落 ${index + 1} (00:00–00:10)`, segment.text);
        return block
          .replace(/^<details>\n<summary>[^\n]*<\/summary>\n/, `### 段落 ${index + 1} (00:00–00:10) [[audio-${index}.m4a|00:00]]\n`)
          .replace(/\n<\/details>$/, "");
      });
      const oldNote = [
        "# 2026-10-10 10:41 · 通用", "正文内容。", "<!-- qnalog-session-knowledge {\"schemaVersion\":2,\"id\":\"fixture\"} -->",
        "---", "## 原始材料", "<details><summary>分段原始转写（3 段）</summary>", "",
        ...oldParts.flatMap((part) => [part, ""]),
        "</details>", "<!-- qnalog-session:fixture -->", "<!-- qnalog-note-index -->",
        "<details><summary>索引数据</summary>", "```json", "{\"fixture\":true}", "```", "</details>", "<!-- qnalog-note-index-end -->",
      ].join("\n");

      const normalized = normalizeTranscriptLayout(oldNote);
      const restored = readTranscriptBlocks(normalized);
      expect(normalized).toContain("**分段原始转写（3 段）**");
      expect(normalized).not.toMatch(/<summary>分段原始转写/);
      expect(restored.map((block) => block.visibleBlock)).toEqual(texts);
      expect(restored.map((block) => block.segment.transcript)).toEqual(segments.map((segment) => segment.transcript));
      expect((normalized.match(/data-qnalog-transcript-data=/g) || []).length).toBe(3);
      expect(normalized.match(/<details>/g)).toHaveLength(4);
      expect(normalized.match(/<summary>索引数据<\/summary>/g)).toHaveLength(1);
      expect(normalized.trimEnd().endsWith("</details>")).toBe(true);
      expect(normalized).toContain("{\"fixture\":true}");
      expect(normalized.match(/qnalog-session-knowledge /g)).toHaveLength(1);
      expect(normalized.match(/<!-- qnalog-note-index -->/g)).toHaveLength(1);
      expect(normalized.match(/<!-- qnalog-note-index-end -->/g)).toHaveLength(1);
      expect(normalizeTranscriptLayout(normalized)).toBe(normalized);
      expect([...normalized.matchAll(/<!-- qnalog-[^>]*-->/g)].every((match) => {
        const prefix = normalized.slice(0, match.index);
        return (prefix.match(/<details\b/gi)?.length || 0) > (prefix.match(/<\/details>/gi)?.length || 0);
      })).toBe(true);
      assertDetailsBounded(normalized);
    } finally {
      setActiveUiLanguage(previousLanguage);
    }
  });

  it("splits the six-segment Herald text scale while keeping every details block bounded", () => {
    const lengths = [274, 871, 1806, 3306, 3463, 2145];
    const segments = lengths.map((length, index) => makeSegment(index, `${"转写。".repeat(Math.floor(length / 3))}${"尾".repeat(length % 3)}`));
    const original = segments.map((segment, index) => legacyBlock(segment, `### 段落 ${index + 1} (00:00–00:10)`, segment.text)
      .replace(/^<details>\n<summary>[^\n]*<\/summary>\n/, `### 段落 ${index + 1} (00:00–00:10)\n`)
      .replace(/\n<\/details>$/, "")).join("\n\n");
    const oldLayout = `<details><summary>分段原始转写（6 段）</summary>\n${original}\n</details>`;
    const normalized = normalizeTranscriptLayout(oldLayout);
    expect(readTranscriptBlocks(normalized).map((block) => block.visibleBlock)).toEqual(segments.map((segment) => segment.text));
    expect((normalized.match(/data-qnalog-transcript-data=/g) || []).length).toBe(6);
    assertDetailsBounded(normalized);
  });

  it("moves realtime outline coverage metadata out and removes blank lines", () => {
    const coverage = { version: 1 as const, outlineHash: "outline-hash", sourceHash: "source-hash", committedSegmentCount: 5, totalSegmentCount: 6 };
    const oldNote = [
      "## 原始材料", "<details>", "<summary>录音中实时大纲（草稿）</summary>", "",
      "> 当前覆盖 5/6 段", "", buildOutlineCoverageMetadata(coverage), "", "- 条目一", "", "</details>",
    ].join("\n");
    const normalized = normalizeTranscriptLayout(oldNote);
    const detailsBody = normalized.match(/<details>\s*<summary>[\s\S]*?<\/summary>([\s\S]*?)<\/details>/)?.[1] || "";
    expect(detailsBody).not.toMatch(/\n\s*\n/);
    expect(detailsBody).not.toContain("realtime-outline-source-coverage");
    expect(normalized).toMatch(/<\/details>\s*<span hidden data-qnalog-realtime-outline-source-coverage=/);
    expect(readCurrentOutlineBlock(normalized)?.sourceCoverage).toEqual(coverage);
    expect(normalizeTranscriptLayout(normalized)).toBe(normalized);
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

  it("converts the intermediate grouped URI-span layout into split base64 storage", () => {
    const segments = [makeSegment(0, "中间格式甲。"), makeSegment(1, "中间格式乙。")];
    const oldParts = segments.map((segment, index) => legacyBlock(segment, `### 段落 ${index + 1} (00:00–00:01)`, segment.text)
      .replace(/^<details>\n<summary>[^\n]*<\/summary>\n/, `### 段落 ${index + 1} (00:00–00:01)\n`)
      .replace(/<!-- qnalog-transcript-data ([\s\S]*?) -->/, (_whole, rawJson: string) => {
        const data = JSON.parse(rawJson) as { transcript: { id: string } };
        return `<span hidden data-qnalog-transcript-data="${encodeURIComponent(rawJson)}" data-qnalog-segment="${encodeURIComponent(data.transcript.id)}"></span>`;
      })
      .replace(/\n<\/details>$/, ""));
    const intermediate = `<details><summary>分段原始转写（2 段）</summary>\n\n${oldParts.join("\n\n")}\n</details>`;
    const normalized = normalizeTranscriptLayout(intermediate);
    const spans = [...normalized.matchAll(/data-qnalog-transcript-data="([^"]+)"/g)].map((match) => match[1]);
    expect(readTranscriptBlocks(normalized).map((block) => block.visibleBlock)).toEqual(segments.map((segment) => segment.text));
    expect(spans).toHaveLength(2);
    expect(spans.every((value) => !value.includes("%7B") && !!JSON.parse(Buffer.from(value, "base64").toString("utf8")))).toBe(true);
    expect(normalized).not.toContain("<summary>分段原始转写");
    assertDetailsBounded(normalized);
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
