import { NS_TAG, nsRe } from "../shared/namespace";
import type { Segment } from "../shared/types";
import type { TranscriptSegmentRecord } from "./session-transcript";
import { readSourceIntegrity } from "./source-integrity";
import { labelPattern, labelText } from "../shared/note-labels";
import { formatElapsed } from "../shared/util-common";
import { protectActiveSessionKnowledge } from "../notes/note-document";

export interface ReadTranscriptBlock {
  segment: Segment;
  start: number;
  end: number;
  visibleBlock: string;
  heading: string;
  drifted: boolean;
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/`/g, "\\u0060")
    .replace(/--/g, "\\u002d\\u002d");
}

interface CompactTranscriptTextReferences {
  segmentText?: true;
  segmentRawText?: true;
  currentRawText?: true;
  utterances?: Array<{ start: number; end: number; rawMatchesNormalized: boolean }>;
  utteranceRawMatchesNormalized?: number[];
  utteranceDefaults?: Record<string, unknown>;
}

function compactTranscriptPayload(segment: Segment, transcript: TranscriptSegmentRecord): Record<string, unknown> {
  const storedSegment = { ...segment };
  delete storedSegment.transcript;
  const storedTranscript = JSON.parse(JSON.stringify(transcript)) as TranscriptSegmentRecord;
  const references: CompactTranscriptTextReferences = {};
  const current = storedTranscript.revisions.find((revision) => revision.revision === storedTranscript.currentRevision);
  if (!current) return { schemaVersion: 2, segment: storedSegment, transcript: storedTranscript };
  if (current.utterances.length > 1) {
    const defaults: Record<string, unknown> = {};
    const excluded = new Set(["id", "rawText", "normalizedText", "startMs", "endMs"]);
    for (const key of Object.keys(current.utterances[0])) {
      if (excluded.has(key)) continue;
      const serialized = JSON.stringify(current.utterances[0][key as keyof typeof current.utterances[0]]);
      if (current.utterances.every((utterance) => JSON.stringify(utterance[key as keyof typeof utterance]) === serialized)) {
        defaults[key] = current.utterances[0][key as keyof typeof current.utterances[0]];
        for (const utterance of current.utterances) delete (utterance as unknown as Record<string, unknown>)[key];
      }
    }
    if (Object.keys(defaults).length) references.utteranceDefaults = defaults;
  }
  const displayText = current.displayText;
  if (typeof displayText === "string") {
    if (storedSegment.text === displayText) {
      storedSegment.text = "";
      references.segmentText = true;
    }
    if (storedSegment.rawText === displayText) {
      storedSegment.rawText = "";
      references.segmentRawText = true;
    }
    if (current.rawText === displayText) {
      current.rawText = null;
      references.currentRawText = true;
    }
    let cursor = 0;
    const utteranceReferences: NonNullable<CompactTranscriptTextReferences["utterances"]> = [];
    let canReferenceUtterances = current.utterances.length > 0;
    for (const utterance of current.utterances) {
      const normalized = utterance.normalizedText;
      const end = cursor + normalized.length;
      if (displayText.slice(cursor, end) !== normalized) {
        canReferenceUtterances = false;
        break;
      }
      utteranceReferences.push({ start: cursor, end, rawMatchesNormalized: utterance.rawText === normalized });
      cursor = end;
    }
    if (canReferenceUtterances && cursor === displayText.length) {
      current.utterances.forEach((utterance, index) => {
        const reference = utteranceReferences[index];
        utterance.normalizedText = "";
        if (reference.rawMatchesNormalized) utterance.rawText = null;
      });
      references.utterances = utteranceReferences;
    }
  }
  const rawMatchesNormalized: number[] = [];
  current.utterances.forEach((utterance, index) => {
    if (utterance.rawText !== null && utterance.rawText === utterance.normalizedText) {
      utterance.rawText = null;
      rawMatchesNormalized.push(index);
    }
  });
  if (rawMatchesNormalized.length) references.utteranceRawMatchesNormalized = rawMatchesNormalized;
  return {
    schemaVersion: 2,
    segment: storedSegment,
    transcript: storedTranscript,
    ...(Object.keys(references).length ? { textReferences: references } : {}),
  };
}

function expandTranscriptTextReferences(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const row = payload as Record<string, unknown>;
  const references = row.textReferences as CompactTranscriptTextReferences | undefined;
  if (!references || !row.segment || !row.transcript) return payload;
  const segment = row.segment as Segment;
  const transcript = row.transcript as TranscriptSegmentRecord;
  const current = transcript.revisions.find((revision) => revision.revision === transcript.currentRevision);
  if (!current) return payload;
  const utteranceDefaults = references.utteranceDefaults;
  if (utteranceDefaults && typeof utteranceDefaults === "object" && !Array.isArray(utteranceDefaults)) {
    for (const utterance of current.utterances) Object.assign(utterance, utteranceDefaults);
  }
  const displayText = current.displayText;
  if (references.segmentText) segment.text = displayText;
  if (references.segmentRawText) segment.rawText = displayText;
  if (references.currentRawText) current.rawText = displayText;
  const utteranceReferences = references.utterances;
  if (utteranceReferences && utteranceReferences.length === current.utterances.length) {
    current.utterances.forEach((utterance, index) => {
      const reference = utteranceReferences[index];
      const normalized = displayText.slice(reference.start, reference.end);
      utterance.normalizedText = normalized;
      if (reference.rawMatchesNormalized) utterance.rawText = normalized;
    });
  }
  for (const index of references.utteranceRawMatchesNormalized || []) {
    if (Number.isInteger(index) && index >= 0 && index < current.utterances.length) {
      current.utterances[index].rawText = current.utterances[index].normalizedText;
    }
  }
  delete row.textReferences;
  return row;
}

function encodeData(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeData(value: string): string {
  try {
    const binary = atob(value);
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    if (/%[\da-f]{2}/i.test(value)) return decodeURIComponent(value);
    throw new Error("Transcript data has an unsupported encoding");
  }
}

function transcriptDataElement(id: string, payload: string): string {
  const safeId = encodeURIComponent(id).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<span hidden data-${NS_TAG}-transcript-data="${encodeData(payload)}" data-${NS_TAG}-segment="${safeId}"></span>`;
}

function matchingDetailsEnd(text: string, start: number): number {
  const tags = /<\/?details\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  let tag: RegExpExecArray | null;
  while ((tag = tags.exec(text))) {
    if (/^<\/details/i.test(tag[0])) depth--;
    else depth++;
    if (depth === 0) return tags.lastIndex;
  }
  return -1;
}

/** Convert the historical single transcript details wrapper to one short details per segment. */
function splitLegacyTranscriptDetails(markdown: string): string {
  const text = String(markdown || "");
  const wrapperPattern = /<details\b[^>]*>\s*<summary>([^<]*(?:分段原始转写|Segmented raw transcript)[^<]*)<\/summary>/gi;
  const wrapper = wrapperPattern.exec(text);
  if (!wrapper) return text;
  const start = wrapper.index;
  const end = matchingDetailsEnd(text, start);
  if (end < 0) return text;
  const blocks = readTranscriptBlocks(text).filter((block) => block.start >= start && block.end <= end);
  if (!blocks.length) return text;
  const wrapperText = text.slice(start, end);
  const wrapperBodyStart = wrapperText.indexOf("</summary>") + "</summary>".length;
  const wrapperBody = wrapperText.slice(wrapperBodyStart, -"</details>".length);
  const innerDetails: Array<{ start: number; end: number }> = [];
  const innerOpenings = /<details\b[^>]*>/gi;
  let innerOpening: RegExpExecArray | null;
  while ((innerOpening = innerOpenings.exec(wrapperBody))) {
    const innerEnd = matchingDetailsEnd(wrapperBody, innerOpening.index);
    if (innerEnd > 0) innerDetails.push({ start: innerOpening.index, end: innerEnd });
  }
  const allSegmentsAlreadyWrapped = blocks.every((block) => {
    const localStart = block.start - start - wrapperBodyStart;
    return innerDetails.some((detail) => localStart >= detail.start && localStart < detail.end);
  });
  const legacyHeadingNumbers = [...wrapperText.matchAll(/^###\s+.+?\s+(\d+)\b[^\n]*$/gim)]
    .map((match) => Number(match[1]));
  const headingPositions = [...wrapperBody.matchAll(/^###\s+.+?\s+(\d+)\b[^\n]*$/gim)]
    .map((match) => ({ number: Number(match[1]), position: match.index || 0 }));
  const readableSegmentNumbers = new Set(blocks.map((block) => block.segment.index + 1));
  const hasUnwrappedLegacyHeading = legacyHeadingNumbers.some((number) => !readableSegmentNumbers.has(number)
    || !innerDetails.some((detail) => {
      const headingPosition = headingPositions.find((heading) => heading.number === number)?.position ?? -1;
      return headingPosition >= detail.start && headingPosition < detail.end;
    }));
  if (allSegmentsAlreadyWrapped && innerDetails.length > 0 && !hasUnwrappedLegacyHeading) {
    return text.slice(0, start) + wrapperBody + text.slice(end);
  }
  // A wrapper can contain both upgraded ledger blocks and their stale heading lines.
  // Keep untracked legacy segments intact when a heading does not match a readable ledger.
  if (legacyHeadingNumbers.some((number) => !readableSegmentNumbers.has(number))) return text;

  // Replace the whole historical wrapper. Replacing only transcript marker ranges leaves
  // old headings and separators behind. Accept partially rewritten wrappers too: a previous
  // edit may already have replaced one segment while leaving the outer legacy shell intact.
  const segmentMarkers = [...wrapperText.matchAll(new RegExp(`<!--\\s*(${nsRe("segments-start")}|${nsRe("segments-end")})(?::[^>]*)?\\s*-->`, "gi"))]
    .map((match) => match[0]);
  const startMarker = segmentMarkers.find((marker) => new RegExp(nsRe("segments-start"), "i").test(marker));
  const endMarker = segmentMarkers.find((marker) => new RegExp(nsRe("segments-end"), "i").test(marker));
  const serialized = blocks.map((block) => serializeTranscriptBlock(block.segment, block.heading, block.visibleBlock));
  let serializedGroup = serialized.join("\n");
  if (startMarker) {
    const summaryEnd = serializedGroup.indexOf("</summary>");
    if (summaryEnd >= 0) {
      const insertion = summaryEnd + "</summary>".length;
      serializedGroup = serializedGroup.slice(0, insertion) + `\n${startMarker}` + serializedGroup.slice(insertion);
    }
  }
  if (endMarker) {
    const lastDetailsEnd = serializedGroup.lastIndexOf("</details>");
    if (lastDetailsEnd >= 0) serializedGroup = serializedGroup.slice(0, lastDetailsEnd) + `${endMarker}\n` + serializedGroup.slice(lastDetailsEnd);
  }
  const replacement = serializedGroup;
  return text.slice(0, start) + replacement + text.slice(end);
}

function normalizeRealtimeOutlineDetails(markdown: string): string {
  const pattern = /(<details\b[^>]*>\s*<summary>[^<]*(?:录音中实时大纲|Live outline while recording)[^<]*<\/summary>)([\s\S]*?)(<\/details>)/gi;
  return String(markdown || "").replace(pattern, (whole, header: string, body: string, close: string, offset: number, source: string) => {
    const coverage = body.match(new RegExp(`<!--\\s*${nsRe("realtime-outline-source-coverage")}\\s*:\\s*([\\s\\S]*?)\\s*-->`, "i"));
    const cleanBody = body.replace(new RegExp(`<!--\\s*${nsRe("realtime-outline-source-coverage")}\\s*:[\\s\\S]*?-->`, "i"), "")
      .split(/\r?\n/).filter((line) => line.trim()).join("\n");
    const alreadyHidden = new RegExp(`data-${NS_TAG}-realtime-outline-source-coverage=`, "i").test(source.slice(offset + whole.length, offset + whole.length + 512));
    const details = `${header}${cleanBody ? `\n${cleanBody}\n` : "\n"}${close}`;
    if (!coverage || alreadyHidden) return details;
    const payload = encodeData(coverage[1].trim());
    return `${details}\n<span hidden data-${NS_TAG}-realtime-outline-source-coverage="${payload}"></span>`;
  });
}

function normalizeIndexDataDetails(markdown: string): string {
  const protectedActive = protectActiveSessionKnowledge(String(markdown || ""));
  const source = protectedActive.markdown;
  const indexDetails = /<details>\s*<summary>[^<]*(?:索引数据|Index data|会话数据|QnALog session data)[^<]*<\/summary>([\s\S]*?)<\/details>/gi;
  const detailsMatches = [...source.matchAll(indexDetails)];
  const startMarker = new RegExp(`<!--\\s*${nsRe("note-index")}\\s*-->`, "i").exec(source);
  const endMarkerRe = new RegExp(`<!--\\s*${nsRe("note-index-end")}\\s*-->`, "ig");
  if (startMarker) endMarkerRe.lastIndex = startMarker.index + startMarker[0].length;
  const endMarker = startMarker ? endMarkerRe.exec(source) : null;
  const markerBody = startMarker && endMarker
    ? source.slice(startMarker.index + startMarker[0].length, endMarker.index)
    : "";
  const detailsBodies = detailsMatches.map((match) => match[1]
    .replace(new RegExp(`<!--\\s*${nsRe("note-index")}\\s*-->|<!--\\s*${nsRe("note-index-end")}\\s*-->`, "gi"), "")
    .replace(new RegExp(`<!--\\s*(?:${nsRe("session-knowledge")}\\s+[\\s\\S]*?|${nsRe("session")}(?::|\\s)[^>]*|${nsRe("continuation-committed")}:[^>]*)-->`, "gi"), "")
    .trim());
  const markerPayload = markerBody && !/<details\b/i.test(markerBody)
    ? markerBody.replace(new RegExp(`<!--\\s*(?:${nsRe("session-knowledge")}\\s+[\\s\\S]*?|${nsRe("session")}(?::|\\s)[^>]*|${nsRe("continuation-committed")}:[^>]*)-->`, "gi"), "").trim()
    : "";
  const indexBody = detailsBodies.find(Boolean) || markerPayload;
  if (!detailsMatches.length && !startMarker && !endMarker) return protectedActive.restore(source);
  const machineCommentPattern = new RegExp(
    `<!--\\s*(?:${nsRe("note-index")}\\s*|${nsRe("note-index-end")}\\s*|${nsRe("session-knowledge")}\\s+[\\s\\S]*?|${nsRe("session")}(?::|\\s)[^>]*|${nsRe("continuation-committed")}:[^>]*)-->`,
    "gi",
  );
  const comments = [...source.matchAll(machineCommentPattern)].map(([comment]) => comment);
  const commentSet = [...new Set(comments)];
  const hasIndexDetails = detailsMatches.length > 0;
  if (!hasIndexDetails && !commentSet.length) return protectedActive.restore(source);

  let text = source;
  text = text.replace(indexDetails, "");
  text = text.replace(machineCommentPattern, "");
  if (!indexBody && !commentSet.length) {
    return protectedActive.restore(text.replace(/\n{3,}/g, "\n\n").trimEnd());
  }

  const bodyLines = indexBody.split(/\r?\n/).filter((line) => line.trim());
  const noteIndexStart = new RegExp(`<!--\\s*${nsRe("note-index")}\\s*-->`, "i");
  const noteIndexEnd = new RegExp(`<!--\\s*${nsRe("note-index-end")}\\s*-->`, "i");
  const outputLines = [...bodyLines];
  if (bodyLines.length && !noteIndexStart.test(indexBody)) outputLines.unshift(`<!-- ${NS_TAG}-note-index -->`);
  if (bodyLines.length && !noteIndexEnd.test(indexBody)) outputLines.push(`<!-- ${NS_TAG}-note-index-end -->`);
  outputLines.push(...commentSet.filter((comment) => !new RegExp(`<!--\\s*${nsRe("note-index")}(?:-end)?\\s*-->`, "i").test(comment)));
  const rawHeading = /^##\s+(?:原始材料|Original material)\s*$/m;
  if (!rawHeading.test(text)) text = `${text.trimEnd()}\n\n---\n\n## ${labelText("originalMaterial")}`;
  return protectedActive.restore(
    `${text.replace(/\s+$/, "")}\n\n<details>\n<summary>${labelText("indexData")}</summary>\n${outputLines.join("\n")}\n</details>\n`,
  );
}

function placeLooseSegmentsMarkersInDetails(markdown: string): string {
  const source = String(markdown || "");
  const markerPattern = new RegExp("<!--\\s*(" + nsRe("segments-start") + "|" + nsRe("segments-end") + ")(?::[^>]*)?\\s*-->", "gi");
  const looseMarkers: Array<{ marker: string; index: number }> = [];
  for (const match of source.matchAll(markerPattern)) {
    const index = match.index || 0;
    const prefix = source.slice(0, index);
    const depth = (prefix.match(/<details\b[^>]*>/gi) || []).length - (prefix.match(/<\/details\s*>/gi) || []).length;
    if (depth <= 0) looseMarkers.push({ marker: match[0], index });
  }
  if (!looseMarkers.length) return source;

  let text = source;
  for (const item of looseMarkers.slice().sort((a, b) => b.index - a.index)) {
    text = text.slice(0, item.index) + text.slice(item.index + item.marker.length);
  }
  const detailBlocks = [...text.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/gi)]
    .filter((match) => new RegExp("<!--\\s*" + nsRe("transcript-start") + ":", "i").test(match[0]));
  if (!detailBlocks.length) return source;
  const starts = looseMarkers.filter(({ marker }) => new RegExp(nsRe("segments-start"), "i").test(marker));
  const ends = looseMarkers.filter(({ marker }) => new RegExp(nsRe("segments-end"), "i").test(marker));
  const insertions: Array<{ index: number; value: string }> = [];
  if (starts.length) {
    const first = detailBlocks[0];
    const summaryEnd = first[0].search(/<\/summary>/i);
    if (summaryEnd >= 0) {
      const insertionIndex = (first.index || 0) + summaryEnd + "</summary>".length;
      insertions.push({ index: insertionIndex, value: "\n" + starts.map(({ marker }) => marker).join("\n") });
    }
  }
  if (ends.length) {
    const last = detailBlocks[detailBlocks.length - 1];
    const closeIndex = (last.index || 0) + last[0].lastIndexOf("</details>");
    insertions.push({ index: closeIndex, value: ends.map(({ marker }) => marker).join("\n") + "\n" });
  }
  for (const insertion of insertions.sort((a, b) => b.index - a.index)) {
    text = text.slice(0, insertion.index) + insertion.value + text.slice(insertion.index);
  }
  return text.replace(/\n{3,}/g, "\n\n");
}

function removeLegacyTranscriptGroupTitles(markdown: string): string {
  const title = new RegExp(`^\\*\\*(?:${labelPattern("segmentedRawTranscript").source})\\*\\*\\s*(?:\\r?\\n|$)`, "gm");
  const source = String(markdown || "");
  const clean = source.replace(title, "");
  return clean === source ? source : clean.replace(/\n{3,}/g, "\n\n");
}

function normalizeTranscriptSummaryLabels(markdown: string): string {
  const text = String(markdown || "");
  const upgradeBareSummaries = (source: string) => source.replace(
    /<summary>(?:段落|Segment)\s+(\d+)\s+\((\d+:\d{2}(?::\d{2})?)\s*[–-]\s*(\d+:\d{2}(?::\d{2})?)\)<\/summary>/gi,
    (_summary, index: string, start: string, end: string) => `<summary>${labelText("rawTranscriptSegmentRange", Number(index), start, end)}</summary>`,
  );
  const blocks = readTranscriptBlocks(text);
  if (!blocks.length) return upgradeBareSummaries(text);
  const segments = new Map(blocks.map((block) => [block.segment.transcript?.id || "", block.segment]));
  const fragmentsPerSegment = new Map<string, number>();
  const starts = new RegExp(`<!--\\s*${nsRe("transcript-start")}:([^>]+)\\s*-->`, "gi");
  for (const match of text.matchAll(starts)) {
    const { id } = splitFragmentId(match[1].trim());
    fragmentsPerSegment.set(id, (fragmentsPerSegment.get(id) || 0) + 1);
  }
  const fragmentIndex = new Map<string, number>();
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const markers = new RegExp(`<!--\\s*${nsRe("transcript-start")}:([^>]+)\\s*-->`, "gi");
  for (const marker of text.matchAll(markers)) {
    const markerPosition = marker.index || 0;
    const open = text.lastIndexOf("<details", markerPosition);
    if (open < 0 || open < text.lastIndexOf("</details>", markerPosition)) continue;
    const end = matchingDetailsEnd(text, open);
    if (end < 0) continue;
    const summaryMatch = /<summary>[\s\S]*?<\/summary>/i.exec(text.slice(open, end));
    if (!summaryMatch) continue;
    const { id } = splitFragmentId(marker[1].trim());
    const segment = segments.get(id);
    if (!segment) continue;
    const index = (fragmentIndex.get(id) || 0) + 1;
    fragmentIndex.set(id, index);
    const summary = transcriptSummary(segment, { index, count: fragmentsPerSegment.get(id) || 1 });
    const summaryStart = open + (summaryMatch.index || 0);
    replacements.push({ start: summaryStart, end: summaryStart + summaryMatch[0].length, value: `<summary>${summary}</summary>` });
  }
  let next = text;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    next = next.slice(0, replacement.start) + replacement.value + next.slice(replacement.end);
  }
  return upgradeBareSummaries(next);
}

function splitFragmentId(value: string): { id: string; fragment: number } {
  const match = value.match(/^(.*):fragment:(\d+)$/);
  return match ? { id: match[1], fragment: Number(match[2]) } : { id: value, fragment: 0 };
}

function transcriptBlockRange(text: string, markerStart: number, markerEnd: number, endMarkerLength: number): { start: number; end: number } {
  const open = text.lastIndexOf("<details", markerStart);
  const priorClose = text.lastIndexOf("</details>", markerStart);
  const close = open > priorClose ? text.indexOf("</details>", markerEnd + endMarkerLength) : -1;
  if (open < 0 || open < priorClose || close < 0) {
    return { start: markerStart, end: markerEnd + endMarkerLength };
  }
  const wrapper = text.slice(open, close + "</details>".length);
  const markerCount = [...wrapper.matchAll(new RegExp(`<!--\\s*${nsRe("transcript-start")}:`, "g"))].length;
  const legacyHeadingCount = [...wrapper.matchAll(/^###\s+(?:段落|Segment)\s+\d+/gm)].length;
  return markerCount === 1 && legacyHeadingCount <= 1
    ? { start: open, end: close + "</details>".length }
    : { start: markerStart, end: markerEnd + endMarkerLength };
}

function transcriptHeadingParts(heading: string): { summary: string; material: string[]; markers: string[] } {
  const source = String(heading || "Transcript");
  const markers = [...source.matchAll(/<!--[^>]*-->/g)].map(([marker]) => marker);
  const withoutMarkers = source.replace(/<!--[^>]*-->/g, "");
  const lines = withoutMarkers.split(/\r?\n/);
  const first = (lines.shift() || "Transcript").replace(/^\s*#{1,6}\s*/, "").trim();
  const links = [...first.matchAll(/\[\[[^\]]+\]\]/g)].map(([link]) => link);
  const summary = first.replace(/\[\[[^\]]+\]\]/g, "").replace(/[<>]/g, "").trim() || "Transcript";
  const material = [...links, ...lines.map((line) => line.trim()).filter(Boolean)];
  return { summary, material, markers };
}

function escapeTranscriptText(value: string): string {
  return value
    .replace(/&(?=(?:#(?:\d+|x[\da-f]+)|(?:amp|lt|gt|quot|apos));)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/-->/g, "--&gt;")
    .replace(/(?:\r\n|\r|\n){2,}/g, (lineBreaks) => {
      const lineBreaksFound = lineBreaks.match(/\r\n|\r|\n/g) || [];
      return lineBreaksFound.map((lineBreak) => `<br data-${NS_TAG}-newline="${lineBreak === "\r\n" ? "crlf" : lineBreak === "\r" ? "cr" : "lf"}">`).join("");
    });
}

function unescapeTranscriptText(value: string): string {
  return value
    .replace(new RegExp(`<br\\s+data-${NS_TAG}-newline="(crlf|cr|lf)"\\s*>`, "gi"), (_match, lineBreak: string) => lineBreak === "crlf" ? "\r\n" : lineBreak === "cr" ? "\r" : "\n")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function splitTextAtSentenceBoundaries(text: string, maxLength: number): string[] {
  if (!text) return [""];
  const tokens = text.match(/[^.!?。！？\n]+[.!?。！？]*(?:\n+|[ \t]+)?|[.!?。！？]+(?:\n+|[ \t]+)?|\n+/gu) || [text];
  const chunks: string[] = [];
  let current = "";
  const addToken = (token: string) => {
    if (escapeTranscriptText(token).length > maxLength) {
      if (current) chunks.push(current);
      current = "";
      let part = "";
      for (const character of token) {
        if (escapeTranscriptText(part + character).length > maxLength) {
          chunks.push(part);
          part = "";
        }
        part += character;
      }
      current = part;
    } else if (escapeTranscriptText(current + token).length > maxLength) {
      chunks.push(current);
      current = token;
    } else current += token;
  };
  for (const token of tokens) addToken(token);
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text];
}

function detailsFragment(segmentId: string, summary: string, text: string, fragment: number, extraMarkers: readonly string[] = [], material: readonly string[] = []): string {
  const markerId = `${segmentId}:fragment:${fragment}`;
  if (!text) return [
    "<details>",
    `<summary>${summary}</summary>`,
    ...material,
    ...extraMarkers,
    `<!-- ${nsRe("transcript-start")}:${markerId} -->`,
    `<!-- ${nsRe("transcript-text-start")}:${markerId} --> <!-- ${nsRe("transcript-text-end")}:${markerId} -->`,
    `<!-- ${nsRe("transcript-end")}:${markerId} -->`,
    "</details>",
  ].join("\n");
  return [
    "<details>",
    `<summary>${summary}</summary>`,
    ...material,
    ...extraMarkers,
    `<!-- ${nsRe("transcript-start")}:${markerId} -->`,
    `<!-- ${nsRe("transcript-text-start")}:${markerId} -->`,
    escapeTranscriptText(text),
    `<!-- ${nsRe("transcript-text-end")}:${markerId} -->`,
    `<!-- ${nsRe("transcript-end")}:${markerId} -->`,
    "</details>",
  ].join("\n");
}

function transcriptDetails(segment: Segment, segmentId: string, heading: string, displayText: string): string[] {
  const { material, markers: extraMarkers } = transcriptHeadingParts(heading);
  const baseSummary = transcriptSummary(segment);
  const largestPartSummary = `${baseSummary}${labelText("transcriptPartSuffix", 999, 999)}`;
  const overhead = detailsFragment(segmentId, largestPartSummary, "", 999999, extraMarkers, material)
    .slice("<details>".length, -"</details>".length).trim().length;
  const maxText = Math.max(1, 3500 - overhead - 128);
  const chunks = splitTextAtSentenceBoundaries(displayText, maxText);
  return chunks.map((chunk, index) => {
    const summary = `${baseSummary}${chunks.length > 1 ? labelText("transcriptPartSuffix", index + 1, chunks.length) : ""}`;
    const fragment = detailsFragment(segmentId, summary, chunk, index + 1, index === 0 ? extraMarkers : [], index === 0 ? material : []);
    const inner = fragment.slice("<details>".length, -"</details>".length).trim();
    if (inner.length > 3500) throw new Error(`Transcript details block exceeds 3500 characters: ${inner.length}`);
    return fragment;
  });
}

function transcriptSummary(segment: Segment, part?: { index: number; count: number }): string {
  const base = labelText(
    "rawTranscriptSegmentRange",
    segment.index + 1,
    formatElapsed(segment.startOffsetMs),
    formatElapsed(segment.endOffsetMs),
  );
  return part && part.count > 1
    ? `${base}${labelText("transcriptPartSuffix", part.index, part.count)}`
    : base;
}

function headingForSerializedSegment(segment: Segment, heading: string): string {
  const { summary: requestedSummary, material, markers } = transcriptHeadingParts(heading);
  const summary = isTranscriptSummary(requestedSummary)
    ? requestedSummary
    : `${labelText("segment", segment.index + 1)} (${formatElapsed(segment.startOffsetMs)}–${formatElapsed(segment.endOffsetMs)})`;
  return [summary, ...material, ...markers].join("\n");
}

function isTranscriptSummary(value: string): boolean {
  return /^(?:段落|Segment)\s+\d+\s+\(\d+:\d{2}(?::\d{2})?[–-]\d+:\d{2}(?::\d{2})?\)$/.test(value);
}

function headingForSegment(segment: Segment, inner: string, textStartIndex: number, markdown: string, markerIndex: number): string {
  const legacyPrefix = inner.slice(0, textStartIndex);
  const comments = [...legacyPrefix.matchAll(/<!--[^>]*-->/g)].map(([comment]) => comment);
  const legacyLinks = [...legacyPrefix.matchAll(/\[\[[^\]]+\]\]/g)].map(([link]) => link);
  const open = markdown.lastIndexOf("<details", markerIndex);
  const priorClose = markdown.lastIndexOf("</details>", markerIndex);
  const summaryEnd = open > priorClose ? markdown.indexOf("</summary>", open) : -1;
  const between = summaryEnd >= 0 && summaryEnd < markerIndex
    ? markdown.slice(summaryEnd + "</summary>".length, markerIndex)
    : "";
  const legacyHeadings = [...between.matchAll(/^###\s+(?:段落|Segment)\s+(\d+)[^\n]*$/gm)];
  const currentHeading = legacyHeadings.find((heading) => Number(heading[1]) === segment.index + 1);
  const segmentMaterial = legacyHeadings.length
    ? (currentHeading ? between.slice(currentHeading.index || 0) : "")
    : between;
  // In the 1.6.4 grouped layout each transcript-start precedes its own heading.
  // Links in `legacyPrefix` belong to this segment; links before the marker belong to earlier segments.
  const links = legacyLinks.length ? legacyLinks : [...segmentMaterial.matchAll(/\[\[[^\]]+\]\]/g)].map(([link]) => link);
  const generatedAudioLinks = [...segmentMaterial.matchAll(/<a\b[^>]*\bclass="internal-link qnalog-time-link"[^>]*>[^<]*<\/a>/g)]
    .map(([anchor]) => {
      const dataHref = anchor.match(/(?:^|\s)data-href="([^"]+)"/)?.[1];
      const href = anchor.match(/(?:^|\s)href="([^"]+)"/)?.[1];
      return dataHref && dataHref === href ? anchor : "";
    })
    .filter(Boolean);
  const label = `${labelText("segment", segment.index + 1)} (${formatElapsed(segment.startOffsetMs)}–${formatElapsed(segment.endOffsetMs)})`;
  const audioName = segment.audioName || segment.segmentAudioName || "";
  const audioAt = Number.isFinite(segment.audioStartOffsetMs) ? Number(segment.audioStartOffsetMs) : segment.startOffsetMs;
  const dataLink = segment.sourcePath
    ? `[[${segment.sourcePath}|${segment.sourceName || segment.sourcePath.split("/").pop() || segment.sourcePath}]]`
    : audioName ? `[[${audioName}|${formatElapsed(audioAt)}]]` : "";
  const material = [...new Set([...links, ...generatedAudioLinks, ...(dataLink && !generatedAudioLinks.length ? [dataLink] : [])])];
  const nonHeadingLines = legacyPrefix.replace(/<!--[^>]*-->/g, "").split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !/^#{1,6}\s+/.test(line));
  return [`### ${label}`, ...material, ...nonHeadingLines, ...comments].join("\n");
}

interface TranscriptDataElement {
  start: number;
  end: number;
  id: string;
  payload: string;
}

export function findTranscriptDataElements(markdown: string): TranscriptDataElement[] {
  const elements: TranscriptDataElement[] = [];
  const spans = new RegExp(`<span\\b(?=[^>]*\\bhidden(?:\\s|=|>))(?=[^>]*\\bdata-${NS_TAG}-transcript-data=["']([^"']*)["'])(?=[^>]*\\bdata-${NS_TAG}-segment=["']([^"']*)["'])[^>]*>\\s*<\\/span>`, "gi");
  for (const match of markdown.matchAll(spans)) {
    const encoded = match[1];
    const encodedId = match[2];
    if (!encoded || encodedId === undefined) continue;
    try {
      const id = decodeURIComponent(encodedId.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
      elements.push({ start: match.index || 0, end: (match.index || 0) + match[0].length, id, payload: decodeData(encoded) });
    } catch {
      throw new Error("Transcript hidden data has invalid encoding");
    }
  }
  return elements;
}

/** Move transcript payloads into a compact hidden row after their containing transcript details. */
export function normalizeTranscriptDataPlacement(markdown: string): string {
  const text = String(markdown || "");
  const blocks = readTranscriptBlocks(text);
  if (!blocks.length) return text;
  const dataElements = findTranscriptDataElements(text);
  const hasLegacyData = new RegExp(`<!--\\s*${nsRe("transcript-data")}\\s+`, "i").test(text);
  if (!hasLegacyData && !dataElements.length) return text;
  const blockIds = new Set(blocks.map((block) => block.segment.transcript?.id || ""));
  for (const element of dataElements) {
    if (!blockIds.has(element.id)) throw new Error(`Transcript hidden data has no matching block: ${element.id}`);
  }
  const groups = new Map<number, string[]>();
  const finalBlock = blocks.reduce((last, block) => block.end > last.end ? block : last, blocks[0]);
  if (!hasLegacyData && dataElements.length === blocks.length) {
    const rowStart = dataElements[0].start;
    const rowEnd = dataElements[dataElements.length - 1].end;
    const row = text.slice(rowStart, rowEnd);
    const expectedRow = dataElements.map((element) => text.slice(element.start, element.end)).join("");
    if (row === expectedRow && rowStart >= finalBlock.end) return text;
  }
  for (const block of blocks) {
    const record = block.segment.transcript;
    if (!record) continue;
    const payload = safeJson(compactTranscriptPayload(block.segment, record));
    const anchorEnd = finalBlock.end;
    const elements = groups.get(anchorEnd) || [];
    elements.push(transcriptDataElement(record.id, payload));
    groups.set(anchorEnd, elements);
  }
  const removeRanges: Array<{ start: number; end: number }> = dataElements.map(({ start, end }) => ({ start, end }));
  const legacyData = new RegExp(`<!--\\s*${nsRe("transcript-data")}\\s+[\\s\\S]*?\\s*-->`, "gi");
  for (const match of text.matchAll(legacyData)) removeRanges.push({ start: match.index || 0, end: (match.index || 0) + match[0].length });
  removeRanges.sort((left, right) => left.start - right.start);
  const ranges = removeRanges.filter((range, index) => index === 0 || range.start >= removeRanges[index - 1].end);
  let next = text;
  for (const range of ranges.slice().reverse()) next = next.slice(0, range.start) + next.slice(range.end);
  const adjusted = (position: number) => position - ranges.filter((range) => range.end <= position).reduce((sum, range) => sum + range.end - range.start, 0);
  const insertions = [...groups.entries()].map(([anchor, elements]) => ({ position: adjusted(anchor), row: elements.join("") }))
    .sort((left, right) => right.position - left.position);
  for (const insertion of insertions) {
    const previousBreak = insertion.position > 0 && /[\r\n]/.test(next[insertion.position - 1]);
    const nextBreak = /[\r\n]/.test(next[insertion.position] || "");
    const before = previousBreak || nextBreak ? "" : "\n";
    const after = nextBreak ? "" : "\n";
    next = next.slice(0, insertion.position) + `${before}${insertion.row}${after}` + next.slice(insertion.position);
  }
  return next;
}

/** Normalize legacy grouped transcript markup and place its data outside the details blocks. */
export function normalizeTranscriptLayout(markdown: string): string {
  const placed = normalizeTranscriptDataPlacement(
    placeLooseSegmentsMarkersInDetails(splitLegacyTranscriptDetails(String(markdown || ""))),
  );
  const cleanTitles = removeLegacyTranscriptGroupTitles(placed);
  const labeled = normalizeTranscriptSummaryLabels(cleanTitles);
  const details = normalizeRealtimeOutlineDetails(labeled).replace(
    /(<details\b[^>]*>)([\s\S]*?)(<\/details>)/gi,
    (_whole, open: string, body: string, close: string) => {
      const lines = body.split(/\r?\n/).filter((line) => line.trim());
      return `${open}${lines.length ? `\n${lines.join("\n")}\n` : ""}${close}`;
    },
  );
  return normalizeIndexDataDetails(details);
}

function validSegment(value: unknown): value is Omit<Segment, "transcript"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return !Object.prototype.hasOwnProperty.call(row, "transcript")
    && Number.isFinite(row.index)
    && Number.isFinite(row.startOffsetMs)
    && Number.isFinite(row.endOffsetMs)
    && typeof row.text === "string";
}

function isTranscriptOrigin(value: unknown): value is TranscriptSegmentRecord["revisions"][number]["source"] {
  return value === "asr" || value === "streaming-transcript" || value === "text-import"
    || value === "legacy-transcript" || value === "edited-transcript";
}

function isTranscriptTiming(value: unknown): value is TranscriptSegmentRecord["revisions"][number]["utterances"][number]["timing"] {
  return value === "provider" || value === "audio-span" || value === "segment" || value === "unknown";
}

function validNullableTime(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function validAudioRef(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.path === "string" && typeof row.name === "string"
    && validNullableTime(row.startMs) && validNullableTime(row.endMs) && isTranscriptTiming(row.precision);
}

function validUtterance(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.parentSegmentId === "string"
    && (row.rawText === null || typeof row.rawText === "string")
    && typeof row.normalizedText === "string"
    && (row.speakerId === null || typeof row.speakerId === "string")
    && (row.speakerName === null || typeof row.speakerName === "string")
    && validNullableTime(row.startMs) && validNullableTime(row.endMs)
    && isTranscriptTiming(row.timing) && validAudioRef(row.audioRef) && isTranscriptOrigin(row.source);
}

function validCorrection(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Number.isInteger(row.revision) && (row.kind === "text" || row.kind === "speaker")
    && typeof row.from === "string" && typeof row.to === "string"
    && Array.isArray(row.utteranceIds) && row.utteranceIds.every((id) => typeof id === "string");
}

function validTranscriptRevision(value: unknown): value is TranscriptSegmentRecord["revisions"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Number.isInteger(row.revision) && Number.isInteger(row.normalizationRevision)
    && isTranscriptOrigin(row.source)
    && (row.providerId === null || typeof row.providerId === "string")
    && (row.rawText === null || typeof row.rawText === "string")
    && typeof row.displayText === "string"
    && Array.isArray(row.utterances) && row.utterances.every(validUtterance)
    && Array.isArray(row.corrections) && row.corrections.every(validCorrection);
}

export function isTranscriptSegmentRecord(value: unknown): value is TranscriptSegmentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schemaVersion === 2
    && typeof row.id === "string"
    && typeof row.sourceId === "string"
    && (row.sourcePath === null || typeof row.sourcePath === "string")
    && (row.sourceName === null || typeof row.sourceName === "string")
    && Number.isInteger(row.currentRevision)
    && Array.isArray(row.revisions)
    && row.revisions.every(validTranscriptRevision)
    && row.revisions.filter((revision) => revision.revision === row.currentRevision).length === 1;
}

/** 完整性记录形状非法时丢弃该字段，记录本身照常读取；缺省时保持缺省。 */
function normalizeRecordSourceIntegrity(record: TranscriptSegmentRecord): TranscriptSegmentRecord {
  if (!("sourceIntegrity" in record)) return record;
  const integrity = readSourceIntegrity(record.sourceIntegrity);
  const next: TranscriptSegmentRecord = { ...record };
  if (integrity) next.sourceIntegrity = integrity;
  else delete next.sourceIntegrity;
  return next;
}

/** Serialize visible heading/text and its exact source record as one replaceable block. */
export function serializeTranscriptBlock(segment: Segment, heading: string, displayText: string): string {
  if (!segment.transcript) throw new Error("Cannot serialize a transcript block without a source record");
  const transcript = segment.transcript;
  const parentId = transcript.id || `seg:${encodeURIComponent(transcript.sourceId)}:${segment.index}`;
  const storedTranscript: TranscriptSegmentRecord = {
    ...transcript,
    revisions: transcript.revisions.map((revision) => revision.revision === transcript.currentRevision
      ? { ...revision, displayText }
      : revision),
  };
  const normalizedHeading = headingForSerializedSegment(segment, heading);
  const payload = safeJson(compactTranscriptPayload(segment, storedTranscript));
  return [
    ...transcriptDetails(segment, parentId, normalizedHeading, displayText),
    transcriptDataElement(parentId, payload),
  ].join("\n");
}

/** Read only complete v2 blocks. Damaged boundaries or unknown schemas throw to prevent overwrite. */
export function readTranscriptBlocks(markdown: string): ReadTranscriptBlock[] {
  const text = String(markdown || "");
  const hiddenData = new Map<string, string[]>();
  for (const element of findTranscriptDataElements(text)) {
    const values = hiddenData.get(element.id) || [];
    values.push(element.payload);
    hiddenData.set(element.id, values);
  }
  const startPattern = new RegExp(`<!--\\s*${nsRe("transcript-start")}:([^>]+)\\s*-->`, "g");
  const fragments = new Map<string, Array<Array<{ segment: Segment; start: number; end: number; visibleBlock: string; heading: string; fragment: number; part: boolean }>>>();
  const activeGroupIndex = new Map<string, number>();
  let startMatch: RegExpExecArray | null;
  while ((startMatch = startPattern.exec(text))) {
    const markerId = startMatch[1].trim();
    if (!markerId) throw new Error("Transcript block has an empty source ID");
    const { id: parentId, fragment } = splitFragmentId(markerId);
    const part = fragment > 0;
    let parentGroups = fragments.get(parentId);
    if (!parentGroups) {
      parentGroups = [];
      fragments.set(parentId, parentGroups);
    }
    let groupIndex = activeGroupIndex.get(parentId);
    if (fragment <= 1 || groupIndex === undefined) {
      groupIndex = parentGroups.length;
      parentGroups.push([]);
      activeGroupIndex.set(parentId, groupIndex);
    }
    const escapedId = escapeRegExp(markerId);
    const endPattern = new RegExp(`<!--\\s*${nsRe("transcript-end")}:${escapedId}\\s*-->`, "g");
    endPattern.lastIndex = startPattern.lastIndex;
    const endMatch = endPattern.exec(text);
    if (!endMatch) {
      const tail = text.slice(startPattern.lastIndex);
      const nextStart = new RegExp(`<!--\\s*${nsRe("transcript-start")}:`).exec(tail);
      const blockTail = tail.slice(0, nextStart?.index ?? tail.length);
      const hasRelatedMetadata = [
        new RegExp(`<!--\\s*${nsRe("transcript-text-start")}:${escapedId}\\s*-->`),
        new RegExp(`<!--\\s*${nsRe("transcript-text-end")}:${escapedId}\\s*-->`),
        new RegExp(`<!--\\s*${nsRe("transcript-data")}\\s`),
      ].some((pattern) => pattern.test(blockTail));
      if (hasRelatedMetadata) throw new Error(`Transcript block ${parentId} has no matching end marker`);
      continue;
    }
    const inner = text.slice(startPattern.lastIndex, endMatch.index);
    const textStartPattern = new RegExp(`<!--\\s*${nsRe("transcript-text-start")}:${escapedId}\\s*-->`, "g");
    const textEndPattern = new RegExp(`<!--\\s*${nsRe("transcript-text-end")}:${escapedId}\\s*-->`, "g");
    const textStarts = [...inner.matchAll(textStartPattern)];
    const textEnds = [...inner.matchAll(textEndPattern)];
    const dataPattern = new RegExp(`<!--\\s*${nsRe("transcript-data")}\\s+([\\s\\S]*?)\\s*-->`, "g");
    const dataMatches = [...inner.matchAll(dataPattern)];
    const textStart = textStarts[0];
    const dataMatch = dataMatches[dataMatches.length - 1];
    const externalPayload = hiddenData.get(parentId)?.[groupIndex]
      || hiddenData.get(markerId)?.[0];
    const textEnd = dataMatch ? [...textEnds].reverse().find((match) => match.index < dataMatch.index) : textEnds[textEnds.length - 1];
    const dataAfterText = textEnd && dataMatch
      ? dataMatches.filter((match) => match.index > textEnd.index + textEnd[0].length)
      : [];
    if (!textStart || !textEnd || (!externalPayload && !dataMatch) || (dataMatch && dataAfterText.length !== 1)
      || textEnd.index < textStart.index + textStart[0].length) {
      throw new Error(`Transcript block ${parentId} has damaged metadata boundaries (textStart=${!!textStart}, textEnd=${!!textEnd}, externalPayload=${!!externalPayload}, legacyPayload=${!!dataMatch}, externalCount=${hiddenData.get(parentId)?.length || 0}, groupIndex=${groupIndex}, dataCount=${dataMatches.length})`);
    }
    let payload: unknown;
    try {
      payload = expandTranscriptTextReferences(JSON.parse(externalPayload ?? dataMatch?.[1] ?? ""));
    } catch {
      throw new Error(`Transcript block ${parentId} contains invalid metadata JSON`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`Transcript block ${parentId} has an invalid metadata object`);
    }
    const row = payload as Record<string, unknown>;
    if (row.schemaVersion !== 2) throw new Error(`Transcript block ${parentId} uses an unsupported schema`);
    if (!validSegment(row.segment) || !isTranscriptSegmentRecord(row.transcript)) {
      throw new Error(`Transcript block ${parentId} has an invalid source record`);
    }
    const transcript = normalizeRecordSourceIntegrity(row.transcript);
    if (transcript.id !== parentId) throw new Error(`Transcript block ${parentId} does not match its source record ID`);
    const startBody = textStart.index + textStart[0].length;
    const endBody = textEnd.index;
    const framedText = inner.slice(startBody, endBody);
    if (framedText === " ") {
      const segment = { ...row.segment, transcript };
      const heading = headingForSegment(segment, inner, textStart.index, text, startMatch.index);
      const range = transcriptBlockRange(text, startMatch.index, endMatch.index, endMatch[0].length);
      const group = parentGroups[groupIndex];
      group.push({ segment, ...range, visibleBlock: "", heading, fragment, part });
      startPattern.lastIndex = endMatch.index + endMatch[0].length;
      continue;
    }
    const leadingBreak = framedText.startsWith("\r\n") ? 2 : framedText.startsWith("\n") ? 1 : 0;
    const trailingBreak = framedText.endsWith("\r\n") ? 2 : framedText.endsWith("\n") ? 1 : 0;
    if (!leadingBreak || !trailingBreak) throw new Error(`Transcript block ${parentId} has damaged visible-text boundaries`);
    const visibleBlock = unescapeTranscriptText(framedText.slice(leadingBreak, framedText.length - trailingBreak));
    const segment = { ...row.segment, transcript };
    const current = transcript.revisions.find((revision) => revision.revision === transcript.currentRevision);
    if (!current) throw new Error(`Transcript block ${parentId} has no current revision`);
    const heading = headingForSegment(segment, inner, textStart.index, text, startMatch.index);
    const range = transcriptBlockRange(text, startMatch.index, endMatch.index, endMatch[0].length);
    const group = parentGroups[groupIndex];
    group.push({ segment, ...range, visibleBlock, heading, fragment, part });
    startPattern.lastIndex = endMatch.index + endMatch[0].length;
  }
  const blocks: ReadTranscriptBlock[] = [];
  for (const parentGroups of fragments.values()) for (const group of parentGroups.filter((items) => items.length > 0)) {
    group.sort((left, right) => left.start - right.start || left.fragment - right.fragment);
    const first = group[0];
    const last = group[group.length - 1];
    const visibleBlock = group.map((item) => item.visibleBlock).join("");
    const current = first.segment.transcript?.revisions.find((revision) => revision.revision === first.segment.transcript?.currentRevision);
    if (!current) throw new Error(`Transcript block ${first.segment.transcript?.id || "unknown"} has no current revision`);
    blocks.push({ segment: first.segment, start: first.start, end: last.end, visibleBlock, heading: first.heading, drifted: visibleBlock !== current.displayText });
  }
  blocks.sort((left, right) => left.start - right.start);
  return blocks;
}

/** Replace one validated block while preserving its original heading and task markers. */
export function replaceTranscriptBlock(
  markdown: string,
  block: ReadTranscriptBlock,
  segment: Segment,
  displayText: string,
): string {
  const text = String(markdown || "");
  const parentId = segment.transcript?.id;
  if (!parentId) throw new Error("Cannot replace a transcript block without a source ID");
  const replacement = serializeTranscriptBlock(segment, block.heading, displayText);
  let next = text.slice(0, block.start) + replacement + text.slice(block.end);
  const replacementSpanStart = block.start + replacement.indexOf(`<span hidden data-${NS_TAG}-transcript-data=`);
  const staleSpans = findTranscriptDataElements(next)
    .filter((element) => element.id === parentId && element.start !== replacementSpanStart)
    .sort((left, right) => right.start - left.start);
  for (const span of staleSpans) next = next.slice(0, span.start) + next.slice(span.end);
  return normalizeTranscriptLayout(next);
}

/** Rename speaker projections without replacing source speaker IDs or ASR text. */
export function updateTranscriptSpeakerName(
  markdown: string,
  speakerId: string,
  speakerName: string,
  previousNames: readonly string[],
): string {
  const oldNames = [...new Set(previousNames.map((value) => value.trim()).filter((value) => value && value !== speakerName))]
    .sort((left, right) => right.length - left.length);
  if (!oldNames.length) return String(markdown || "");
  let next = String(markdown || "");
  const blocks = readTranscriptBlocks(next);
  for (const block of blocks.slice().sort((left, right) => right.start - left.start)) {
    const record = block.segment.transcript;
    if (!record) continue;
    const current = record.revisions.find((revision) => revision.revision === record.currentRevision);
    if (!current) continue;
    const matchesSpeaker = (unit: TranscriptSegmentRecord["revisions"][number]["utterances"][number]) =>
      unit.speakerId === speakerId || !!unit.speakerId?.endsWith(`:${speakerId}`) || oldNames.includes(unit.speakerName || "");
    const normalizationRevision = current.normalizationRevision + 1;
    const corrections: TranscriptSegmentRecord["revisions"][number]["corrections"] = [...current.corrections];
    let changed = false;
    const utterances = current.utterances.map((unit) => {
      if (!matchesSpeaker(unit)) return unit;
      let normalizedText = unit.normalizedText;
      for (const oldName of oldNames) normalizedText = normalizedText.split(oldName).join(speakerName);
      if (unit.speakerName !== speakerName) {
        corrections.push({ revision: normalizationRevision, kind: "speaker", from: unit.speakerName || "", to: speakerName, utteranceIds: [unit.id] });
        changed = true;
      }
      if (normalizedText !== unit.normalizedText) {
        corrections.push({ revision: normalizationRevision, kind: "text", from: unit.normalizedText, to: normalizedText, utteranceIds: [unit.id] });
        changed = true;
      }
      return { ...unit, speakerName, normalizedText };
    });
    if (!changed) continue;
    const revisions = record.revisions.map((revision) => revision.revision === current.revision
      ? { ...revision, normalizationRevision, displayText: block.visibleBlock, utterances, corrections }
      : revision);
    let segmentText = String(block.segment.text || "");
    for (const oldName of oldNames) segmentText = segmentText.split(oldName).join(speakerName);
    const segment: Segment = { ...block.segment, text: segmentText, transcript: { ...record, revisions } };
    next = replaceTranscriptBlock(next, block, segment, block.visibleBlock);
  }
  return next;
}

/** Remove only transcript machine comments, retaining headings, visible text, and unrelated markers. */
export function getTranscriptMetadataRanges(markdown: string): Array<{ start: number; end: number }> {
  const markerNames = [
    nsRe("transcript-start"),
    nsRe("transcript-text-start"),
    nsRe("transcript-text-end"),
    nsRe("transcript-data"),
    nsRe("transcript-end"),
  ];
  const pattern = new RegExp(`<!--\\s*(?:${markerNames.map(escapeRegExp).join("|")})(?::[^>]*|\\s+[^>]*|\\s*)-->`, "g");
  const text = String(markdown || "");
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(pattern)) ranges.push({ start: match.index || 0, end: (match.index || 0) + match[0].length });
  const spans = new RegExp(`<span\\b(?=[^>]*\\bhidden)(?=[^>]*\\bdata-${NS_TAG}-transcript-data=["'][^"']*["'])[^>]*>\\s*<\\/span>`, "gi");
  for (const match of text.matchAll(spans)) ranges.push({ start: match.index || 0, end: (match.index || 0) + match[0].length });
  ranges.sort((left, right) => left.start - right.start);
  return ranges.filter((range, index) => index === 0 || range.start >= ranges[index - 1].end);
}

export function stripTranscriptMetadata(markdown: string): string {
  const text = String(markdown || "");
  const ranges = getTranscriptMetadataRanges(text);
  let next = text;
  for (const range of ranges.slice().reverse()) next = next.slice(0, range.start) + next.slice(range.end);
  return next;
}

/** Remove transcript payload comments and spans before parsing legacy visible sections. */
export function stripTranscriptPayloadElements(markdown: string): string {
  let next = String(markdown || "");
  const ranges = getTranscriptPayloadRanges(next);
  const comments = new RegExp(`<!--\\s*${nsRe("transcript-data")}\\s+[\\s\\S]*?\\s*-->`, "gi");
  for (const match of next.matchAll(comments)) ranges.push({ start: match.index || 0, end: (match.index || 0) + match[0].length });
  ranges.sort((left, right) => left.start - right.start);
  const unique = ranges.filter((range, index) => index === 0 || range.start >= ranges[index - 1].end);
  for (const range of unique.reverse()) {
    const padding = next.slice(range.start, range.end).replace(/[^\r\n]/g, " ");
    next = next.slice(0, range.start) + padding + next.slice(range.end);
  }
  return next;
}

export function getTranscriptPayloadRanges(markdown: string): Array<{ start: number; end: number }> {
  const text = String(markdown || "");
  const ranges = findTranscriptDataElements(text).map(({ start, end }) => ({ start, end }));
  const comments = new RegExp(`<!--\\s*${nsRe("transcript-data")}\\s+[\\s\\S]*?\\s*-->`, "gi");
  for (const match of text.matchAll(comments)) ranges.push({ start: match.index || 0, end: (match.index || 0) + match[0].length });
  ranges.sort((left, right) => left.start - right.start);
  const unique = ranges.filter((range, index) => index === 0 || range.start >= ranges[index - 1].end);
  return unique;
}
