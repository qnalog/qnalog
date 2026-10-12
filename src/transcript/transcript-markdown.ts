import { NS_TAG, nsRe } from "../shared/namespace";
import type { Segment } from "../shared/types";
import type { TranscriptSegmentRecord } from "./session-transcript";

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
}

function compactTranscriptPayload(segment: Segment, transcript: TranscriptSegmentRecord): Record<string, unknown> {
  const storedSegment = { ...segment };
  delete storedSegment.transcript;
  const storedTranscript = JSON.parse(JSON.stringify(transcript)) as TranscriptSegmentRecord;
  const references: CompactTranscriptTextReferences = {};
  const current = storedTranscript.revisions.find((revision) => revision.revision === storedTranscript.currentRevision);
  if (!current) return { schemaVersion: 2, segment: storedSegment, transcript: storedTranscript };
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

function transcriptSummary(heading: string): string {
  return String(heading || "Transcript")
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/<!--[^>]*-->/g, "")
    .trim();
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

function detailsFragment(segmentId: string, summary: string, text: string, fragment: number, extraMarkers: readonly string[] = []): string {
  const markerId = `${segmentId}:fragment:${fragment}`;
  if (!text) return [
    "<details>",
    `<summary>${summary}</summary>`,
    ...extraMarkers,
    `<!-- ${nsRe("transcript-start")}:${markerId} -->`,
    `<!-- ${nsRe("transcript-text-start")}:${markerId} --> <!-- ${nsRe("transcript-text-end")}:${markerId} -->`,
    `<!-- ${nsRe("transcript-end")}:${markerId} -->`,
    "</details>",
  ].join("\n");
  return [
    "<details>",
    `<summary>${summary}</summary>`,
    ...extraMarkers,
    `<!-- ${nsRe("transcript-start")}:${markerId} -->`,
    `<!-- ${nsRe("transcript-text-start")}:${markerId} -->`,
    escapeTranscriptText(text),
    `<!-- ${nsRe("transcript-text-end")}:${markerId} -->`,
    `<!-- ${nsRe("transcript-end")}:${markerId} -->`,
    "</details>",
  ].join("\n");
}

function transcriptDetails(segmentId: string, heading: string, displayText: string): string[] {
  const summary = transcriptSummary(heading);
  const extraMarkers = [...String(heading || "").matchAll(/<!--[^>]*-->/g)].map(([marker]) => marker);
  const continuationSummary = `${summary} (continued)`;
  const overhead = detailsFragment(segmentId, continuationSummary, "", 999999, extraMarkers)
    .slice("<details>".length, -"</details>".length).trim().length;
  const maxText = Math.max(1, 3500 - overhead - 256);
  const chunks = splitTextAtSentenceBoundaries(displayText, maxText);
  return chunks.map((chunk, index) => {
    const continuation = index ? " (continued)" : "";
    const fragment = detailsFragment(segmentId, `${summary}${continuation}`, chunk, index + 1, index === 0 ? extraMarkers : []);
    const inner = fragment.slice("<details>".length, -"</details>".length).trim();
    if (inner.length > 3500) throw new Error(`Transcript details block exceeds 3500 characters: ${inner.length}`);
    return fragment;
  });
}

interface TranscriptDataElement {
  start: number;
  end: number;
  id: string;
  payload: string;
}

function findTranscriptDataElements(markdown: string): TranscriptDataElement[] {
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
  const payload = safeJson(compactTranscriptPayload(segment, storedTranscript));
  return [
    ...transcriptDetails(parentId, heading, displayText),
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
    const transcript = row.transcript;
    if (transcript.id !== parentId) throw new Error(`Transcript block ${parentId} does not match its source record ID`);
    const startBody = textStart.index + textStart[0].length;
    const endBody = textEnd.index;
    const framedText = inner.slice(startBody, endBody);
    if (framedText === " ") {
      const segment = { ...row.segment, transcript };
      const summaryMatch = inner.match(/<summary>([\s\S]*?)<\/summary>/i);
      const heading = summaryMatch ? summaryMatch[1].trim() : inner.slice(0, textStart.index).trim();
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
    const summaryMatch = inner.match(/<summary>([\s\S]*?)<\/summary>/i);
    const heading = summaryMatch ? summaryMatch[1].trim() : inner.slice(0, textStart.index).trim();
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
  return normalizeTranscriptDataPlacement(next);
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
