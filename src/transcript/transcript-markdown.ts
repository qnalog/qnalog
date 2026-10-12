import { NS_TAG, nsRe } from "../shared/namespace";
import type { Segment } from "../shared/types";
import type { TranscriptSegmentRecord } from "./session-transcript";

export interface ReadTranscriptBlock {
  segment: Segment;
  start: number;
  end: number;
  visibleBlock: string;
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

function encodeData(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeData(value: string): string {
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function transcriptDataElement(id: string, payload: string): string {
  const safeId = encodeURIComponent(id).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<span hidden data-${NS_TAG}-transcript-data="${encodeData(payload)}" data-${NS_TAG}-segment="${safeId}"></span>`;
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
  const hasEmbeddedSpan = dataElements.some((element) => text.lastIndexOf("<details>", element.start) > text.lastIndexOf("</details>", element.start));
  if (!hasLegacyData && !hasEmbeddedSpan) return text;
  const blockIds = new Set(blocks.map((block) => block.segment.transcript?.id || ""));
  for (const element of dataElements) {
    if (!blockIds.has(element.id)) throw new Error(`Transcript hidden data has no matching block: ${element.id}`);
  }
  const groups = new Map<number, string[]>();
  for (const block of blocks) {
    const record = block.segment.transcript;
    if (!record) continue;
    const segment = { ...block.segment };
    delete segment.transcript;
    const payload = safeJson({ schemaVersion: 2, segment, transcript: record });
    const lastOpen = text.lastIndexOf("<details>", block.start);
    const priorClose = text.lastIndexOf("</details>", block.start);
    const closeAt = lastOpen > priorClose ? text.indexOf("</details>", block.end) : -1;
    const segmentsEndPattern = new RegExp(`<!--\\s*${nsRe("segments-end")}(?::[^>]*)?\\s*-->`, "g");
    segmentsEndPattern.lastIndex = block.end;
    const segmentsEnd = segmentsEndPattern.exec(text);
    const anchorEnd = closeAt >= 0 ? closeAt + "</details>".length
      : segmentsEnd ? segmentsEnd.index + segmentsEnd[0].length : block.end;
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
  for (const insertion of insertions) next = next.slice(0, insertion.position) + `\n${insertion.row}` + next.slice(insertion.position);
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
  const { transcript, ...storedSegment } = segment;
  const parentId = transcript.id || `seg:${encodeURIComponent(transcript.sourceId)}:${segment.index}`;
  const storedTranscript: TranscriptSegmentRecord = {
    ...transcript,
    revisions: transcript.revisions.map((revision) => revision.revision === transcript.currentRevision
      ? { ...revision, displayText }
      : revision),
  };
  const payload = safeJson({ schemaVersion: 2, segment: storedSegment, transcript: storedTranscript });
  return [
    `<!-- ${nsRe("transcript-start")}:${parentId} -->`,
    heading,
    `<!-- ${nsRe("transcript-text-start")}:${parentId} -->`,
    displayText,
    `<!-- ${nsRe("transcript-text-end")}:${parentId} -->`,
    `<!-- ${nsRe("transcript-data")} ${payload} -->`,
    `<!-- ${nsRe("transcript-end")}:${parentId} -->`,
  ].join("\n");
}

/** Read only complete v2 blocks. Damaged boundaries or unknown schemas throw to prevent overwrite. */
export function readTranscriptBlocks(markdown: string): ReadTranscriptBlock[] {
  const text = String(markdown || "");
  const hiddenData = new Map(findTranscriptDataElements(text).map((element) => [element.id, element.payload]));
  const startPattern = new RegExp(`<!--\\s*${nsRe("transcript-start")}:([^>]+)\\s*-->`, "g");
  const blocks: ReadTranscriptBlock[] = [];
  let startMatch: RegExpExecArray | null;
  while ((startMatch = startPattern.exec(text))) {
    const parentId = startMatch[1].trim();
    if (!parentId) throw new Error("Transcript block has an empty source ID");
    const escapedId = escapeRegExp(parentId);
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
    const externalPayload = hiddenData.get(parentId);
    const textEnd = dataMatch ? [...textEnds].reverse().find((match) => match.index < dataMatch.index) : textEnds[textEnds.length - 1];
    const dataAfterText = textEnd && dataMatch
      ? dataMatches.filter((match) => match.index > textEnd.index + textEnd[0].length)
      : [];
    if (!textStart || !textEnd || (!externalPayload && !dataMatch) || (dataMatch && dataAfterText.length !== 1)
      || textEnd.index < textStart.index + textStart[0].length) {
      throw new Error(`Transcript block ${parentId} has damaged metadata boundaries`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(externalPayload ?? dataMatch?.[1] ?? "");
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
    const leadingBreak = framedText.startsWith("\r\n") ? 2 : framedText.startsWith("\n") ? 1 : 0;
    const trailingBreak = framedText.endsWith("\r\n") ? 2 : framedText.endsWith("\n") ? 1 : 0;
    if (!leadingBreak || !trailingBreak) throw new Error(`Transcript block ${parentId} has damaged visible-text boundaries`);
    const visibleBlock = framedText.slice(leadingBreak, framedText.length - trailingBreak);
    const segment = { ...row.segment, transcript };
    const current = transcript.revisions.find((revision) => revision.revision === transcript.currentRevision);
    if (!current) throw new Error(`Transcript block ${parentId} has no current revision`);
    blocks.push({
      segment,
      start: startMatch.index,
      end: endMatch.index + endMatch[0].length,
      visibleBlock,
      drifted: visibleBlock !== current.displayText,
    });
    startPattern.lastIndex = endMatch.index + endMatch[0].length;
  }
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
  const sourceBlock = text.slice(block.start, block.end);
  const parentId = segment.transcript?.id;
  if (!parentId) throw new Error("Cannot replace a transcript block without a source ID");
  const textStart = new RegExp(`<!--\\s*${nsRe("transcript-text-start")}:${escapeRegExp(parentId)}\\s*-->`).exec(sourceBlock);
  const startEnd = sourceBlock.indexOf("-->");
  if (!textStart || startEnd < 0 || textStart.index < startEnd) throw new Error(`Transcript block ${parentId} has damaged heading boundaries`);
  const heading = sourceBlock.slice(startEnd + 3, textStart.index).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  const replacement = serializeTranscriptBlock(segment, heading, displayText);
  let next = text.slice(0, block.start) + replacement + text.slice(block.end);
  const staleSpans = findTranscriptDataElements(next).filter((element) => element.id === parentId).sort((left, right) => right.start - left.start);
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
