import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ TFile: class TFile {}, normalizePath: (path: string) => path }));
import * as obsidian from "obsidian";
import type { Segment } from "../src/shared/types";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { labelText } from "../src/shared/note-labels";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import {
  normalizeTranscriptDataPlacement,
  normalizeTranscriptLayout,
  readTranscriptBlocks,
  replaceTranscriptBlock,
  serializeTranscriptBlock,
} from "../src/transcript/transcript-markdown";
import { ensureTranscriptBlocks, extractTranscriptSegments } from "../src/notes/note-transcript-ledger";
import { insertBeforeSessionSegmentsEnd } from "../src/notes/note-segment-store";
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
    if (/^(?:原始转写|Raw transcript) · /.test(summary)) {
      expect(summary).toMatch(/^(?:原始转写 · 段落 \d+|Raw transcript · Segment \d+) \(\d+:\d{2}(?::\d{2})?–\d+:\d{2}(?::\d{2})?\)(?: · (?:第 \d+\/\d+ 部分|Part \d+\/\d+))?$/);
    }
  }
}

describe("transcript hidden-data storage", () => {
  it("keeps loose segment-group and index markers inside raw-material details", () => {
    const segments = [makeSegment(0, "alpha"), makeSegment(1, "beta")];
    const transcript = segments.map((segment, index) => serializeTranscriptBlock(
      segment,
      `段落 ${index + 1} (00:00–00:01)`,
      segment.text,
    )).join("\n");
    const input = [
      "# Fixture",
      "Visible body.",
      "<!-- qnalog-note-index -->",
      "<!-- qnalog-note-index-end -->",
      '<span data-qnalog="active-version-end"></span>',
      "---", "## 原始材料", "**分段原始转写（2 段）**",
      "<!-- qnalog-segments-start:fixture -->",
      transcript,
      "<!-- qnalog-segments-end:fixture -->",
      "<details>", "<summary>索引数据</summary>",
      "<!-- qnalog-note-index -->", "```json", "{}", "```", "<!-- qnalog-note-index-end -->",
      "</details>",
    ].join("\n");

    const output = normalizeTranscriptLayout(input);
    const outsideComments = [...output.matchAll(/<!--\s*qnalog-[^>]*-->/g)].filter((match) => {
      const before = output.slice(0, match.index);
      return (before.match(/<details\b/gi) || []).length <= (before.match(/<\/details>/gi) || []).length;
    });
    expect(outsideComments.map(([comment]) => comment)).toEqual([]);
    assertDetailsBounded(output);
    const details = [...output.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gi)].map((match) => match[1]);
    expect(details.some((body) => body.includes("qnalog-segments-start:fixture"))).toBe(true);
    expect(details.some((body) => body.includes("qnalog-segments-end:fixture"))).toBe(true);
    expect(output.match(/<summary>(?:索引数据|Index data)<\/summary>/g)).toHaveLength(1);
    expect(normalizeTranscriptLayout(output)).toBe(output);
  });
  it.each([0, 1, 6, 30])("writes %i independent bounded transcript details", (count) => {
    const segments = Array.from({ length: count }, (_, index) => makeSegment(index, `段落 ${index + 1}。`));
    const output = normalizeTranscriptDataPlacement(detailBlocks(segments.map((segment, index) => serializeTranscriptBlock(segment, `### 段落 ${index + 1} (00:00–00:10)`, segment.text))));
    expect(readTranscriptBlocks(output)).toHaveLength(count);
    expect(output.match(/data-qnalog-transcript-data=/g) || []).toHaveLength(count);
    assertDetailsBounded(output);
    if (count) expect(output.match(/<span hidden data-qnalog-transcript-data=/g)?.length).toBe(count);
    expect(normalizeTranscriptDataPlacement(output)).toBe(output);
  });

  it.each([
    { language: "zh", count: 1, expected: "原始转写 · 段落 1 (00:00–00:01)" },
    { language: "en", count: 1, expected: "Raw transcript · Segment 1 (00:00–00:01)" },
    { language: "zh", count: 6, expected: "原始转写 · 段落 1 (00:00–00:01)" },
  ])("writes self-describing transcript summaries ($language, $count segment(s))", ({ language, count, expected }) => {
    const previousLanguage = getActiveUiLanguage();
    try {
      setActiveUiLanguage(resolveUiLanguage(language, language));
      const segments = Array.from({ length: count }, (_, index) => makeSegment(index, `内容 ${index + 1}。`));
      const output = normalizeTranscriptDataPlacement(segments
        .map((segment) => serializeTranscriptBlock(segment, `### Segment ${segment.index + 1} (00:00–00:01)`, segment.text))
        .join("\n"));
      const summaries = [...output.matchAll(/<summary>(.*?)<\/summary>/g)].map((match) => match[1]);
      expect(summaries).toHaveLength(count);
      expect(summaries[0]).toBe(expected);
      if (language === "zh") expect(summaries.every((summary) => summary.startsWith("原始转写 · 段落 "))).toBe(true);
      else expect(summaries.every((summary) => summary.startsWith("Raw transcript · Segment "))).toBe(true);
      expect(output).not.toMatch(/^\*\*(?:分段原始转写|Segmented raw transcript)/m);
    } finally {
      setActiveUiLanguage(previousLanguage);
    }
  });

  it.each([
    { language: "zh", groupTitle: "分段原始转写（1 段）", oldSummary: "段落 1 (00:00–00:01)", expected: "原始转写 · 段落 1 (00:00–00:01)" },
    { language: "en", groupTitle: "Segmented raw transcript (1 segments)", oldSummary: "Segment 1 (00:00–00:01)", expected: "Raw transcript · Segment 1 (00:00–00:01)" },
  ])("upgrades legacy group title and summary after index-tail rewrite ($language)", ({ language, groupTitle, oldSummary, expected }) => {
    const previousLanguage = getActiveUiLanguage();
    try {
      setActiveUiLanguage(resolveUiLanguage(language, language));
      const segment = makeSegment(0, "保留的原始文本。");
      const serialized = serializeTranscriptBlock(segment, `### ${oldSummary}`, segment.text)
        .replace(/<summary>[^<]*<\/summary>/, `<summary>${oldSummary}</summary>`);
      const input = [
        "# Fixture",
        "Visible body.",
        "---",
        "## 原始材料",
        `**${groupTitle}**`,
        serialized,
        "<details>",
        "<summary>索引数据</summary>",
        "<!-- qnalog-note-index -->",
        "{}",
        "<!-- qnalog-note-index-end -->",
        "</details>",
      ].join("\n");

      const normalized = normalizeTranscriptLayout(input);
      expect(normalized).not.toContain(`**${groupTitle}**`);
      expect(normalized).toContain(`<summary>${expected}</summary>`);
      expect(normalized).toContain("保留的原始文本。");
      expect(normalized.match(/<summary>(?:索引数据|Index data)<\/summary>/g)).toHaveLength(1);
      expect(normalizeTranscriptLayout(normalized)).toBe(normalized);
    } finally {
      setActiveUiLanguage(previousLanguage);
    }
  });

  it.each([
    { language: "zh", old: "段落 2 (00:01–00:02)", expected: "原始转写 · 段落 2 (00:01–00:02)" },
    { language: "en", old: "Segment 2 (00:01–00:02)", expected: "Raw transcript · Segment 2 (00:01–00:02)" },
  ])("upgrades legacy bare segment summaries in $language", ({ language, old, expected }) => {
    const previousLanguage = getActiveUiLanguage();
    try {
      setActiveUiLanguage(resolveUiLanguage(language, language));
      const normalized = normalizeTranscriptLayout(`<details><summary>${old}</summary>Legacy text.</details>`);
      expect(normalized).toContain(`<summary>${expected}</summary>`);
      expect(normalized).toContain("Legacy text.");
      expect(normalizeTranscriptLayout(normalized)).toBe(normalized);
    } finally {
      setActiveUiLanguage(previousLanguage);
    }
  });

  it.each([
    { length: 5000, parts: 2 },
    { length: 9000, parts: 3 },
  ])("labels split segment fragments as part i/n ($parts parts)", ({ length, parts }) => {
    const segment = makeSegment(0, "转写文本。".repeat(Math.ceil(length / 6)).slice(0, length));
    const output = normalizeTranscriptDataPlacement(serializeTranscriptBlock(segment, "### Segment 1 (00:00–00:01)", segment.text));
    const summaries = [...output.matchAll(/<summary>(.*?)<\/summary>/g)].map((match) => match[1]);
    expect(summaries).toHaveLength(parts);
    expect(summaries).toEqual(Array.from({ length: parts }, (_, index) =>
      `Raw transcript · Segment 1 (00:00–00:01) · Part ${index + 1}/${parts}`));
    assertDetailsBounded(output);
  });

  it("upgrades legacy grouped titles and summaries without changing transcript records", () => {
    const previousLanguage = getActiveUiLanguage();
    try {
      setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
      const segments = [makeSegment(0, "第一段正文。"), makeSegment(1, "第二段正文。")];
      const source = `**分段原始转写（2 段）**\n<details><summary>分段原始转写（2 段）</summary>\n${segments.map((segment, index) =>
        legacyBlock(segment, `### 段落 ${index + 1} (00:0${index}0–00:0${index + 1}0)`, segment.text)
          .replace(/^<details>\n<summary>[^\n]*<\/summary>\n/, `### 段落 ${index + 1} (00:0${index}0–00:0${index + 1}0)\n`)
          .replace(/\n<\/details>$/, "")).join("\n\n")}\n</details>`;
      const expectedData = readTranscriptBlocks(source).map((block) => ({
        text: block.visibleBlock,
        start: block.segment.startOffsetMs,
        end: block.segment.endOffsetMs,
        record: block.segment.transcript,
      }));
      const normalized = normalizeTranscriptLayout(source);
      expect(normalized).not.toMatch(/^\*\*分段原始转写（\d+ 段）\*\*$/m);
      expect(normalized).not.toContain("<summary>分段原始转写");
      expect([...normalized.matchAll(/<summary>(.*?)<\/summary>/g)].map((match) => match[1])).toEqual([
        "原始转写 · 段落 1 (00:00–00:01)",
        "原始转写 · 段落 2 (00:01–00:02)",
      ]);
      const reread = readTranscriptBlocks(normalized).map((block) => ({
        text: block.visibleBlock,
        start: block.segment.startOffsetMs,
        end: block.segment.endOffsetMs,
        record: block.segment.transcript,
      }));
      expect(reread).toEqual(expectedData);
      expect(normalizeTranscriptLayout(normalized)).toBe(normalized);
      expect(normalized.match(/<details\b/g)).toHaveLength(2);
      assertDetailsBounded(normalized);
    } finally {
      setActiveUiLanguage(previousLanguage);
    }
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

  it("compacts repeated utterance fields and restores the exact transcript record", () => {
    const segment = makeSegment(0, "一句。另一句。第三句。".repeat(30));
    const transcript = segment.transcript!;
    const current = transcript.revisions.find((revision) => revision.revision === transcript.currentRevision)!;
    current.displayText = `00:00 ${current.utterances.map((utterance) => utterance.normalizedText).join("")}`;
    current.utterances.forEach((utterance, index) => {
      utterance.parentSegmentId = transcript.id;
      utterance.audioRef = { path: "QnALog/Audio/source.m4a", name: "source.m4a", startMs: index * 100, endMs: (index + 1) * 100, precision: "provider" };
      utterance.rawText = utterance.normalizedText;
      utterance.speakerId = "speaker-1";
      utterance.speakerName = "Speaker 1";
    });
    current.corrections.push({ revision: current.revision, kind: "speaker", from: "Speaker", to: "Speaker 1", utteranceIds: [current.utterances[0].id] });
    const expected = JSON.parse(JSON.stringify(segment));
    const serialized = serializeTranscriptBlock(segment, "Segment 1 (00:00–00:01)", current.displayText);
    const [readBack] = readTranscriptBlocks(serialized);
    expect(readBack.segment).toEqual(expected);
    const encodedData = serialized.match(/data-qnalog-transcript-data="([^"]+)"/)?.[1] || "";
    const decodedJson = new TextDecoder().decode(Uint8Array.from(atob(encodedData), (character) => character.charCodeAt(0)));
    const payload = JSON.parse(decodedJson);
    expect(decodedJson.length).toBeLessThan(JSON.stringify(expected).length);
    expect(payload.textReferences.utteranceDefaults.parentSegmentId).toBe(transcript.id);
    expect(payload.transcript.revisions[0].utterances.every((utterance: { parentSegmentId?: string; rawText: string | null }) => !("parentSegmentId" in utterance) && utterance.rawText === null)).toBe(true);
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
    expect(normalized).not.toContain("**分段原始转写（2 段）**");
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
      expect(normalized).not.toContain("**分段原始转写（3 段）**");
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

  it("keeps each legacy segment's audio timestamp link with that segment", () => {
    const segments = [makeSegment(0, "first"), makeSegment(1, "second"), makeSegment(2, "third")];
    const times = ["00:00", "00:10", "00:20"];
    const legacyParts = segments.map((segment, index) => {
      segment.audioName = "audio.m4a";
      segment.audioStartOffsetMs = index * 10_000;
      return legacyBlock(segment, `### 段落 ${index + 1} (${times[index]}–00:${String((index + 1) * 10).padStart(2, "0")})`, segment.text)
        .replace(/^<details>\n<summary>[^\n]*<\/summary>\n/, "")
        .replace(/\n<\/details>$/, "")
        .replace(/(<!-- qnalog-transcript-start:[^>]+-->)/, `$1\n### 段落 ${index + 1} (${times[index]}–00:${String((index + 1) * 10).padStart(2, "0")}) [[audio.m4a|${times[index]}]]`);
    });
    const input = [
      "**分段原始转写（3 段）**", "<details>", "<summary>分段原始转写（3 段）</summary>",
      "<!-- qnalog-segments-start:audio-links -->", "", ...legacyParts.flatMap((part) => [part, ""]),
      "<!-- qnalog-segments-end:audio-links -->", "</details>",
    ].join("\n");

    const normalized = normalizeTranscriptLayout(input);
    const details = [...normalized.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gi)]
      .filter((match) => /qnalog-transcript-start/.test(match[1]));
    expect(details).toHaveLength(3);
    expect(details.map(([_, body]) => [...body.matchAll(/\[\[[^\]]+\]\]/g)].map(([link]) => link)))
      .toEqual(times.map((time) => [`[[audio.m4a|${time}]]`]));
  });

  it("keeps a segment with no audio source free of timestamp links", () => {
    const segment = makeSegment(0, "text-only source");
    const oldBlock = legacyBlock(segment, "### 段落 1 (00:00–00:01)", segment.text)
      .replace(/^<details>\n<summary>[^\n]*<\/summary>\n/, "").replace(/\n<\/details>$/, "");
    const input = [
      "<details>", "<summary>分段原始转写（1 段）</summary>",
      "### 段落 1 (00:00–00:01)", oldBlock, "</details>",
    ].join("\n");
    const normalized = normalizeTranscriptLayout(input);
    const transcriptDetail = [...normalized.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gi)]
      .find((match) => /qnalog-transcript-start/.test(match[1]));
    expect(transcriptDetail?.[1].match(/\[\[[^\]]+\]\]/g) || []).toHaveLength(0);
  });

  it.each([1, 3, 6, 30])("keeps one group range around %i transcript segments and reads the full group", (count) => {
    const segments = Array.from({ length: count }, (_, index) => makeSegment(
      index,
      count === 3 && index === 2 ? `${"长段落。".repeat(1100)}收尾。` : `第 ${index + 1} 段。`,
    ));
    for (const [index, segment] of segments.entries()) {
      const record = segment.transcript!;
      const current = record.revisions.find((revision) => revision.revision === record.currentRevision)!;
      const utterance = current.utterances[0];
      if (utterance) {
        utterance.speakerId = `speaker-${index + 1}`;
        utterance.speakerName = `发言人${index + 1}`;
        current.corrections.push({ revision: current.revision, kind: "speaker", from: "说话人", to: utterance.speakerName, utteranceIds: [utterance.id] });
      }
    }
    const parts = segments.map((segment, index) => {
      const block = legacyBlock(segment, `### 段落 ${index + 1} (00:00–00:10)`, segment.text)
        .replace(/^<details>\n<summary>[^\n]*<\/summary>\n/, "").replace(/\n<\/details>$/, "");
      return `### 段落 ${index + 1} (00:0${index}0–00:0${index + 1}0) [[audio.m4a|00:0${index}0]]\n${block}`;
    });
    const input = [
      "<details>", `<summary>分段原始转写（${count} 段）</summary>`,
      "<!-- qnalog-segments-start:group-range -->", "", ...parts.flatMap((part) => [part, ""]),
      "<!-- qnalog-segments-end:group-range -->", "</details>",
    ].join("\n");

    const normalized = normalizeTranscriptLayout(input);
    const blocks = readTranscriptBlocks(normalized);
    const restoredFromNote = extractTranscriptSegments(normalized);
    const endMarker = normalized.indexOf("<!-- qnalog-segments-end:group-range -->");
    const lastTranscriptEnd = normalized.lastIndexOf("<!-- qnalog-transcript-end:");
    const groupRange = normalized.match(/<!-- qnalog-segments-start:group-range -->([\s\S]*?)<!-- qnalog-segments-end:group-range -->/);
    expect(blocks).toHaveLength(count);
    expect(restoredFromNote.map((segment) => segment.text)).toEqual(segments.map((segment) => segment.text));
    expect(blocks.map((block) => block.visibleBlock)).toEqual(segments.map((segment) => segment.text));
    expect(blocks.map((block) => block.segment.transcript)).toEqual(segments.map((segment) => segment.transcript));
    expect(endMarker).toBeGreaterThan(lastTranscriptEnd);
    expect(groupRange?.[1].match(/qnalog-transcript-start:/g)?.length).toBeGreaterThanOrEqual(count);
    expect(groupRange?.[1].match(/qnalog-transcript-end:/g)?.length).toBeGreaterThanOrEqual(count);
    expect(blocks.map((block) => [...block.heading.matchAll(/\[\[[^\]]+\]\]/g)].map(([link]) => link)))
      .toEqual(segments.map((_, index) => [`[[audio.m4a|00:0${index}0]]`]));
    expect(normalizeTranscriptLayout(normalized)).toBe(normalized);
  });

  it("normalizes legacy comments, URI spans and the current layout to the same result", () => {
    const segments = [makeSegment(0, "第一段。"), makeSegment(1, "第二段。")];
    const legacyParts = segments.map((segment, index) => {
      const block = legacyBlock(segment, `### 段落 ${index + 1} (00:00–00:10)`, segment.text)
        .replace(/^<details>\n<summary>[^\n]*<\/summary>\n/, "").replace(/\n<\/details>$/, "");
      return `### 段落 ${index + 1} (00:00–00:10) [[audio-${index + 1}.m4a|00:00]]\n${block}`;
    });
    const legacy = [
      "<details>", "<summary>分段原始转写（2 段）</summary>", "<!-- qnalog-segments-start:parity -->",
      "", ...legacyParts.flatMap((part) => [part, ""]), "<!-- qnalog-segments-end:parity -->", "</details>",
    ].join("\n");
    const intermediate = legacy.replace(/<!-- qnalog-transcript-data ([\s\S]*?) -->/g, (_whole, payload: string) => {
      const parsed = JSON.parse(payload) as { transcript: { id: string } };
      return `<span hidden data-qnalog-transcript-data="${encodeURIComponent(payload)}" data-qnalog-segment="${encodeURIComponent(parsed.transcript.id)}"></span>`;
    });
    const canonical = normalizeTranscriptLayout(legacy);
    const upgradedIntermediate = normalizeTranscriptLayout(intermediate);

    expect(upgradedIntermediate).toBe(canonical);
    expect(normalizeTranscriptLayout(canonical)).toBe(canonical);
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

  it("normalizes the legacy group when an appended recording adds a segment", async () => {
    const first = makeSegment(0, "旧录音转写。");
    const oldPart = legacyBlock(first, "### 段落 1 (00:00–00:01)", first.text)
      .replace(/^<details>\n<summary>[^\n]*<\/summary>\n/, "### 段落 1 (00:00–00:01)\n")
      .replace(/\n<\/details>$/, "");
    const oldNote = [
      "## 原始材料", "<details><summary>分段原始转写（1 段）</summary>",
      "<!-- qnalog-segments-start:append-fixture -->", oldPart,
      "<!-- qnalog-segments-end:append-fixture -->", "</details>",
    ].join("\n");
    const next = makeSegment(1, "追加录音转写。");
    const path = "Notes/append-fixture.md";
    const file = Object.assign(new obsidian.TFile(), { path });
    let content = oldNote;
    const vault = {
      getAbstractFileByPath: (candidate: string) => candidate === path ? file : null,
      read: async () => content,
      modify: async (_file: unknown, value: string) => { content = value; },
      create: vi.fn(async () => file),
    };
    await insertBeforeSessionSegmentsEnd({ getVault: () => vault, appendToNote: vi.fn(async () => undefined) }, path,
      serializeTranscriptBlock(next, "### 段落 2 (00:01–00:02)", next.text), "append-fixture");
    expect(readTranscriptBlocks(content).map((block) => block.visibleBlock)).toEqual([first.text, next.text]);
    expect(content).not.toMatch(/^\*\*(?:分段原始转写（\d+ 段）|Segmented raw transcript \(\d+ segments\))\*\*$/m);
    expect(content).not.toMatch(/<summary>(?:分段原始转写|Segmented raw transcript)/);
    expect(content.match(/<details\b/g)).toHaveLength(2);
    expect([...content.matchAll(/<summary>(.*?)<\/summary>/g)].map((match) => match[1])).toEqual([
      "Raw transcript · Segment 1 (00:00–00:01)",
      "Raw transcript · Segment 2 (00:01–00:02)",
    ]);
    expect(content.indexOf("<!-- qnalog-segments-end:append-fixture -->"))
      .toBeGreaterThan(content.lastIndexOf("<!-- qnalog-transcript-end:"));
    assertDetailsBounded(content);
  });

  it("normalizes the legacy group after text correction replaces a transcript block", () => {
    const segments = [makeSegment(0, "第一段原文。"), makeSegment(1, "第二段原文。")];
    const parts = segments.map((segment, index) => legacyBlock(segment, `### 段落 ${index + 1} (00:00–00:01)`, segment.text)
      .replace(/^<details>\n<summary>[^\n]*<\/summary>\n/, `### 段落 ${index + 1} (00:00–00:01)\n`)
      .replace(/\n<\/details>$/, ""));
    const oldNote = `<details><summary>分段原始转写（2 段）</summary>\n${parts.join("\n\n")}\n</details>`;
    const [block] = readTranscriptBlocks(oldNote);
    const updated = { ...block.segment, text: "第一段订正文。" };
    const corrected = replaceTranscriptBlock(oldNote, block, updated, updated.text);
    expect(readTranscriptBlocks(corrected).map((entry) => entry.visibleBlock)).toEqual(["第一段订正文。", "第二段原文。"]);
    expect(corrected).not.toMatch(/<summary>分段原始转写/);
    assertDetailsBounded(corrected);
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
    expect(output).toMatch(/<summary>Raw transcript · Segment 5 \(00:00–00:01\)<\/summary>\n\[\[QnALog\/source\.md\|source\.md\]\]\n<!-- qnalog-transcript-start:/);
    expect(readTranscriptBlocks(output)[0].heading).toContain("[[QnALog/source.md|source.md]]");
    assertDetailsBounded(output);
  });

  it("does not read summary text when restoring transcript metadata", () => {
    const segment = makeSegment(0, "summary independent");
    const output = serializeTranscriptBlock(segment, "### 段落 1 (00:00–00:01)", segment.text)
      .replace(/<summary>[\s\S]*?<\/summary>/, "<summary>[[invalid]] <title></summary>");
    const [block] = readTranscriptBlocks(output);
    expect(block.visibleBlock).toBe(segment.text);
    expect(block.heading).toMatch(/### Segment 1 \(00:00–00:01\)/);
    expect(output).not.toContain("displaySummary");
  });

  it("reads legacy heading links from stored segment metadata instead of summary text", () => {
    const source = attachTextTranscript({
      index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "legacy source",
      sourcePath: "QnALog/legacy.md", sourceName: "legacy.md",
    }, "hidden-data-fixture", "text-import");
    const old = legacyBlock(source, "### Segment 1 (00:00–00:01) [[QnALog/legacy.md|legacy.md]]", source.text);
    const [block] = readTranscriptBlocks(old);
    const rewritten = replaceTranscriptBlock(old, block, block.segment, block.visibleBlock);
    expect(rewritten).toContain("<summary>Raw transcript · Segment 1 (00:00–00:01)</summary>\n[[QnALog/legacy.md|legacy.md]]");
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
