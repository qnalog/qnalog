import { getAudioLinkTarget } from "./audio-refs";
import { parseElapsedMsToken } from "../shared/util-text";
import { labelPattern } from "../shared/note-labels";
import { nsMarkerGlobalRe, nsRe } from "../shared/namespace";
import { findNoteDelimitedBlock, iterateNoteHeadingBlocks } from "./note-document";
import type { Segment } from "../shared/types";
import { attachTextTranscript } from "../transcript/session-transcript";
import { readTranscriptBlocks, replaceTranscriptBlock, serializeTranscriptBlock } from "../transcript/transcript-markdown";

const stringifyTranscriptValue = String as (value: unknown) => string;
const LEGACY_TRANSCRIPT_HEADING_RE = /^###\s+(?:(?:段落|Segment|Audio(?: source)?|Text source|音频|文本来源)\s+(\d+)([^\n]*)|(\d+)[.、]\s*([^\n]*))$/gm;

export function cleanTranscriptBlock(block: unknown): string {
  return stringifyTranscriptValue(block || "")
    .replace(/<!--[^>]*-->/g, "")
    .replace(/<summary>[\s\S]*?<\/summary>/gi, "")
    .replace(/<\/?details>/gi, "")
    .replace(/^###\s+(?:段落|Segment)\s+\d+[^\n]*$/gm, "")
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/^_\[(?:转写失败|等待后台转写|此段尚未完成转写|Transcription failed|Waiting for background transcription|This segment is not fully transcribed yet)[^\n]*$/gm, "")
    .replace(new RegExp(`^(?:${labelPattern("noContentSegment").source})$`, "gm"), "")
    .replace(/^\s*---\s*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitTranscriptSections(markdown: unknown): string[] {
  const text = stringifyTranscriptValue(markdown || "");
  const sections: string[] = [];
  let searchFrom = 0;
  while (true) {
    const sectionLabels = ["分段原始转写", "Segmented raw transcript", "导入文本来源", "导入文本原文", "Text import sources", "Text import source"];
    const labelIndexes = sectionLabels.map((label) => text.indexOf(label, searchFrom)).filter((index) => index >= 0);
    const labelIdx = labelIndexes.length ? Math.min(...labelIndexes) : -1;
    if (labelIdx < 0) break;
    const range = findNoteDelimitedBlock(text, /<\/summary>/g, /<\/details>/g, labelIdx);
    if (range) {
      sections.push(text.slice(range.bodyStart, range.bodyEnd));
      searchFrom = range.end;
    } else {
      searchFrom = labelIdx + 1;
    }
  }

  let markerSearchFrom = 0;
  while (true) {
    const range = findNoteDelimitedBlock(
      text,
      nsMarkerGlobalRe("segments-start"),
      nsMarkerGlobalRe("segments-end"),
      markerSearchFrom,
    );
    if (!range) break;
    sections.push(text.slice(range.bodyStart, range.bodyEnd));
    markerSearchFrom = range.bodyStart;
  }

  if (!sections.length) {
    // 兜底老格式「原始转写：…」/「Raw transcript: …」：取两者中靠后的一处。
    const zhRawIdx = text.lastIndexOf("原始转写：");
    const enRawIdx = text.lastIndexOf("Raw transcript:");
    if (zhRawIdx >= 0 || enRawIdx >= 0) {
      const useZh = zhRawIdx >= enRawIdx;
      const rawIdx = useZh ? zhRawIdx : enRawIdx;
      sections.push(text.slice(rawIdx + (useZh ? "原始转写：".length : "Raw transcript:".length)));
    }
  }
  return sections;
}

export function extractTranscriptSegments(markdown: unknown): Segment[] {
  const source = stringifyTranscriptValue(markdown || "");
  const transcriptBlocks = readTranscriptBlocks(source);
  let legacyMarkdown = source;
  for (const block of [...transcriptBlocks].sort((left, right) => right.start - left.start)) {
    legacyMarkdown = legacyMarkdown.slice(0, block.start) + legacyMarkdown.slice(block.end);
  }
  const sortedBlocks = [...transcriptBlocks].sort((left, right) => left.start - right.start);
  const toSourceOffset = (offset: number): number => {
    let removedLength = 0;
    for (const block of sortedBlocks) {
      const maskedStart = block.start - removedLength;
      if (offset < maskedStart) break;
      removedLength += block.end - block.start;
    }
    return offset + removedLength;
  };
  const entries: Array<{ segment: Segment; position: number }> = transcriptBlocks.map((block) => ({ segment: block.segment, position: block.start }));
  const sections = splitTranscriptSections(legacyMarkdown);
  let sectionSearchFrom = 0;
  for (const section of sections) {
    const foundAt = legacyMarkdown.indexOf(section, sectionSearchFrom);
    const sectionStart = foundAt >= 0 ? foundAt : sectionSearchFrom;
    sectionSearchFrom = sectionStart + section.length;
    let hadHeading = false;
    for (const range of iterateNoteHeadingBlocks(section, LEGACY_TRANSCRIPT_HEADING_RE)) {
      hadHeading = true;
      const heading = range.match;
      const rawBlock = section.slice(range.bodyStart, range.bodyEnd);
      const body = cleanTranscriptBlock(rawBlock);
      if (!body) continue;
      const tail = stringifyTranscriptValue(heading[2] || heading[4] || "");
      const textSource = heading[3] !== undefined || /(?:Text source|文本来源)/.test(heading[0]);
      const timeMatch = tail.match(/\(([^)]+?)[–-]([^)]+?)\)/);
      const startOffsetMs = timeMatch ? parseElapsedMsToken(timeMatch[1]) : 0;
      const endOffsetMs = timeMatch ? parseElapsedMsToken(timeMatch[2]) : startOffsetMs;
      const audioMatch = rawBlock.match(/!\[\[([^\]]+)\]\]/);
      const wikiMatch = tail.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
      const linkTarget = audioMatch ? audioMatch[1] : wikiMatch?.[1] || "";
      const target = linkTarget ? getAudioLinkTarget(linkTarget) : "";
      const name = textSource ? (wikiMatch?.[2] || target.split("/").pop() || target) : (target.split("/").pop() || target);
      const taskMatch = rawBlock.match(new RegExp(`<!--\\s*${nsRe("transcribe-task")}:([^>\\s]+)\\s*-->`));
      entries.push({
        segment: {
          index: entries.length,
          startOffsetMs,
          endOffsetMs,
          audioName: textSource ? "" : name,
          audioPath: textSource ? "" : target,
          sourceName: textSource ? name : "",
          sourcePath: textSource ? target : "",
          rawText: textSource ? body : undefined,
          source: textSource ? "text-import" : "",
          queueTaskId: taskMatch?.[1],
          text: body,
        },
        position: toSourceOffset(sectionStart + range.start),
      });
    }
    if (!hadHeading) {
      const text = cleanTranscriptBlock(section);
      if (text) entries.push({ segment: { index: entries.length, startOffsetMs: 0, endOffsetMs: 0, text }, position: toSourceOffset(sectionStart) });
    }
  }
  entries.sort((left, right) => left.position - right.position);
  return entries.map((entry, index) => ({ ...entry.segment, index }));
}

/** Persist source records before an active reorganization pays for a model response. */
export function ensureTranscriptBlocks(
  markdown: string,
  sourceId: string,
  options: { reconcileEditedText?: boolean } = {},
): string {
  let next = stringifyTranscriptValue(markdown || "");
  const originalBlocks = readTranscriptBlocks(next);
  for (const block of [...originalBlocks].filter((item) => options.reconcileEditedText !== false && item.drifted).sort((left, right) => right.start - left.start)) {
    const record = block.segment.transcript!;
    const current = record.revisions.find((revision) => revision.revision === record.currentRevision)!;
    const editedText = block.visibleBlock
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/!\[\[[^\]]+\]\]/g, "");
    const edited = attachTextTranscript({ ...block.segment, text: editedText, rawText: undefined }, record.sourceId || sourceId, "edited-transcript");
    const contextText = stringifyTranscriptValue(block.segment.text || "");
    const previousUnitText = current.utterances.map((unit) => unit.normalizedText).join("");
    const updatedText = previousUnitText && contextText.includes(previousUnitText)
      ? contextText.replace(previousUnitText, editedText)
      : editedText;
    next = replaceTranscriptBlock(next, block, { ...edited, text: updatedText }, block.visibleBlock);
  }

  const currentBlocks = readTranscriptBlocks(next);
  let legacyMarkdown = next;
  for (const block of [...currentBlocks].sort((left, right) => right.start - left.start)) {
    legacyMarkdown = legacyMarkdown.slice(0, block.start) + legacyMarkdown.slice(block.end);
  }
  const orderedBlocks = [...currentBlocks].sort((left, right) => left.start - right.start);
  const toSourceOffset = (offset: number): number => {
    let removedLength = 0;
    for (const block of orderedBlocks) {
      if (offset < block.start - removedLength) break;
      removedLength += block.end - block.start;
    }
    return offset + removedLength;
  };
  const sections = splitTranscriptSections(legacyMarkdown);
  const legacyEntries: Array<{
    segment: Segment;
    position: number;
    start: number;
    end: number;
    heading: string;
    visibleText: string;
  }> = [];
  const seenRanges = new Set<string>();
  let sectionSearchFrom = 0;
  for (const section of sections) {
    const foundAt = legacyMarkdown.indexOf(section, sectionSearchFrom);
    const sectionStart = foundAt >= 0 ? foundAt : sectionSearchFrom;
    sectionSearchFrom = sectionStart + section.length;
    let hadHeading = false;
    for (const range of iterateNoteHeadingBlocks(section, LEGACY_TRANSCRIPT_HEADING_RE)) {
      hadHeading = true;
      const headingMatch = range.match;
      const rawBlock = section.slice(range.bodyStart, range.bodyEnd);
      const body = cleanTranscriptBlock(rawBlock);
      if (!body) continue;
      const start = toSourceOffset(sectionStart + range.start);
      const end = toSourceOffset(sectionStart + range.bodyEnd);
      const key = `${start}:${end}`;
      if (seenRanges.has(key)) continue;
      seenRanges.add(key);
      const tail = stringifyTranscriptValue(headingMatch[2] || headingMatch[4] || "");
      const textSource = headingMatch[3] !== undefined || /(?:Text source|文本来源)/.test(headingMatch[0]);
      const timeMatch = tail.match(/\(([^)]+?)[–-]([^)]+?)\)/);
      const startOffsetMs = timeMatch ? parseElapsedMsToken(timeMatch[1]) : 0;
      const endOffsetMs = timeMatch ? parseElapsedMsToken(timeMatch[2]) : startOffsetMs;
      const audioMatch = rawBlock.match(/!\[\[([^\]]+)\]\]/);
      const wikiMatch = tail.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
      const linkTarget = audioMatch ? audioMatch[1] : wikiMatch?.[1] || "";
      const target = linkTarget ? getAudioLinkTarget(linkTarget) : "";
      const name = textSource ? (wikiMatch?.[2] || target.split("/").pop() || target) : (target.split("/").pop() || target);
      const taskMatch = rawBlock.match(new RegExp(`<!--\\s*${nsRe("transcribe-task")}:([^>\\s]+)\\s*-->`));
      legacyEntries.push({
        segment: {
          index: -1,
          startOffsetMs,
          endOffsetMs,
          audioStartOffsetMs: !textSource && target ? startOffsetMs : undefined,
          audioEndOffsetMs: !textSource && target ? endOffsetMs : undefined,
          audioName: textSource ? "" : name,
          audioPath: textSource ? "" : target,
          source: textSource ? "text-import" : "",
          sourceName: textSource ? name : "",
          sourcePath: textSource ? target : "",
          rawText: textSource ? body : undefined,
          queueTaskId: taskMatch?.[1],
          text: body,
        },
        position: start,
        start,
        end,
        heading: headingMatch[0],
        visibleText: rawBlock,
      });
    }
    if (!hadHeading) {
      const body = cleanTranscriptBlock(section);
      if (!body) continue;
      const start = toSourceOffset(sectionStart);
      const end = toSourceOffset(sectionStart + section.length);
      const key = `${start}:${end}`;
      if (seenRanges.has(key)) continue;
      seenRanges.add(key);
      legacyEntries.push({ segment: { index: -1, startOffsetMs: 0, endOffsetMs: 0, text: body }, position: start, start, end, heading: "", visibleText: section });
    }
  }
  if (!legacyEntries.length) return next;

  const orderedEntries: Array<{ position: number; id: string; legacy: (typeof legacyEntries)[number] | null }> = [
    ...currentBlocks.map((block) => ({ position: block.start, id: block.segment.transcript!.id, legacy: null })),
    ...legacyEntries.map((entry) => ({ position: entry.position, id: "", legacy: entry })),
  ].sort((left, right) => left.position - right.position);
  const usedIds = new Set(orderedEntries.map((entry) => entry.id).filter(Boolean));
  const replacements: Array<{ start: number; end: number; block: string }> = [];
  for (let index = 0; index < orderedEntries.length; index += 1) {
    const entry = orderedEntries[index];
    if (!entry.legacy) continue;
    let segmentIndex = index;
    while (usedIds.has(`seg:${encodeURIComponent(sourceId)}:${segmentIndex}`)) segmentIndex += 1;
    const origin = entry.legacy.segment.source === "text-import" ? "text-import" : "legacy-transcript";
    const segment = attachTextTranscript({ ...entry.legacy.segment, index: segmentIndex }, sourceId, origin);
    usedIds.add(segment.transcript!.id);
    const block = serializeTranscriptBlock(segment, entry.legacy.heading, entry.legacy.visibleText);
    let cursor = entry.legacy.start;
    let firstGap = true;
    for (const protectedBlock of orderedBlocks) {
      if (protectedBlock.end <= cursor) continue;
      if (protectedBlock.start >= entry.legacy.end) break;
      const gapEnd = Math.min(protectedBlock.start, entry.legacy.end);
      if (gapEnd > cursor) {
        replacements.push({
          start: cursor,
          end: gapEnd,
          block: firstGap ? block : "",
        });
        firstGap = false;
      }
      cursor = Math.max(cursor, protectedBlock.end);
      if (cursor >= entry.legacy.end) break;
    }
    if (cursor < entry.legacy.end) {
      replacements.push({
        start: cursor,
        end: entry.legacy.end,
        block: firstGap ? block : "",
      });
    }
  }
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    next = next.slice(0, replacement.start) + replacement.block + next.slice(replacement.end);
  }
  return next;
}
