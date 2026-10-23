import type { Segment } from "../shared/types";
import { stableHash } from "../shared/stable-hash";
import type { AsrTranscriptResult, AsrTranscriptUnit } from "../asr/transcript-result";
import { sameSourceIntegrity, type SourceIntegrity } from "./source-integrity";

export type TranscriptOrigin = "asr" | "streaming-transcript" | "text-import" | "legacy-transcript" | "edited-transcript";
export type TranscriptTiming = "provider" | "audio-span" | "segment" | "unknown";

export interface TranscriptAudioRef {
  path: string;
  name: string;
  startMs: number | null;
  endMs: number | null;
  precision: TranscriptTiming;
}

export interface Utterance {
  id: string;
  parentSegmentId: string;
  rawText: string | null;
  normalizedText: string;
  speakerId: string | null;
  speakerName: string | null;
  startMs: number | null;
  endMs: number | null;
  timing: TranscriptTiming;
  audioRef: TranscriptAudioRef | null;
  source: TranscriptOrigin;
}

export interface TranscriptCorrection {
  revision: number;
  kind: "text" | "speaker";
  from: string;
  to: string;
  utteranceIds: string[];
}

export interface TranscriptRevision {
  revision: number;
  normalizationRevision: number;
  source: TranscriptOrigin;
  providerId: string | null;
  rawText: string | null;
  displayText: string;
  utterances: Utterance[];
  corrections: TranscriptCorrection[];
}

export interface TranscriptSegmentRecord {
  schemaVersion: 2;
  id: string;
  sourceId: string;
  sourcePath: string | null;
  sourceName: string | null;
  currentRevision: number;
  revisions: TranscriptRevision[];
  /** 录音完整性记录，对应本条的 `sourcePath`；旧账本没有此字段。不计入 `getTranscriptSourceRevision`。 */
  sourceIntegrity?: SourceIntegrity;
}

const SENTENCE_END = new Set(["。", "！", "？", "!", "?", ";", "；", "."]);
const MAX_UTTERANCE_LENGTH = 1000;

export function getCurrentTranscript(record: TranscriptSegmentRecord): TranscriptRevision {
  const revision = record.revisions.find((item) => item.revision === record.currentRevision);
  if (!revision) throw new Error(`Transcript revision ${record.currentRevision} is missing for ${record.id}`);
  return revision;
}

/**
 * 决定新记录携带的完整性记录：调用方显式给出的优先；否则沿用同一路径的已有记录。
 * 路径变化时不沿用，因为旧记录描述的是另一个文件。
 */
function carriedSourceIntegrity(
  existing: TranscriptSegmentRecord | undefined,
  sourcePath: string | null,
  explicit: SourceIntegrity | null | undefined,
): SourceIntegrity | undefined {
  if (explicit) return explicit;
  if (existing?.sourceIntegrity && existing.sourcePath === sourcePath) return existing.sourceIntegrity;
  return undefined;
}

/** 返回带（或不带）完整性记录的记录；字段相同则返回原对象，缺省时不写出该键。 */
export function withSourceIntegrity(record: TranscriptSegmentRecord, integrity: SourceIntegrity | undefined): TranscriptSegmentRecord {
  if (sameSourceIntegrity(record.sourceIntegrity, integrity)) return record;
  const next: TranscriptSegmentRecord = { ...record };
  if (integrity) next.sourceIntegrity = integrity;
  else delete next.sourceIntegrity;
  return next;
}

function safeSplitBoundary(text: string, start: number, limit: number): number {
  let end = Math.min(text.length, start + limit);
  if (end < text.length && end > start) {
    const previous = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  return end;
}

function splitLongUnit(text: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = safeSplitBoundary(text, start, MAX_UTTERANCE_LENGTH);
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

/** Split text into citation units without assigning inferred timestamps. */
export function splitTranscriptTextUnits(text: string): string[] {
  const source = String(text || "");
  if (!source) return [];
  const units: string[] = [];
  let start = 0;
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    if (current === "\r" || current === "\n") {
      const end = current === "\r" && source[index + 1] === "\n" ? index + 2 : index + 1;
      units.push(source.slice(start, end));
      start = end;
      index = end;
      continue;
    }
    if (SENTENCE_END.has(current)) {
      let punctuationEnd = index + 1;
      while (punctuationEnd < source.length && SENTENCE_END.has(source[punctuationEnd])) punctuationEnd += 1;
      const decimalPoint = current === "."
        && index > start
        && index + 1 < source.length
        && /\d/.test(source[index - 1])
        && /\d/.test(source[index + 1]);
      const cjkEnd = current === "。" || current === "！" || current === "？" || current === "；";
      const boundary = !decimalPoint && (cjkEnd || punctuationEnd === source.length || /\s/.test(source[punctuationEnd] || ""));
      if (boundary) {
        while (punctuationEnd < source.length && (source[punctuationEnd] === " " || source[punctuationEnd] === "\t")) punctuationEnd += 1;
        units.push(source.slice(start, punctuationEnd));
        start = punctuationEnd;
        index = punctuationEnd;
        continue;
      }
    }
    index += 1;
  }
  if (start < source.length) units.push(source.slice(start));
  const pieces = units.flatMap(splitLongUnit).filter((unit) => unit.length > 0);
  const merged: string[] = [];
  let leadingWhitespace = "";
  for (const piece of pieces) {
    if (!piece.trim()) {
      if (merged.length) merged[merged.length - 1] += piece;
      else leadingWhitespace += piece;
      continue;
    }
    merged.push(`${leadingWhitespace}${piece}`);
    leadingWhitespace = "";
  }
  if (leadingWhitespace && merged.length) merged[merged.length - 1] += leadingWhitespace;
  return merged;
}

function makeTextRevision(
  segment: Segment,
  origin: "text-import" | "legacy-transcript" | "edited-transcript",
  parentId: string,
  revisionNumber: number,
): TranscriptRevision {
  const text = String(origin === "text-import" ? (segment.rawText ?? segment.text ?? "") : (segment.text ?? ""));
  const rawText = origin === "text-import" ? text : null;
  const utterances = splitTranscriptTextUnits(text).map((unit, index): Utterance => ({
    id: `${parentId}:r${revisionNumber}:u${index + 1}`,
    parentSegmentId: parentId,
    rawText: origin === "text-import" ? unit : null,
    normalizedText: unit,
    speakerId: null,
    speakerName: null,
    startMs: null,
    endMs: null,
    timing: "unknown",
    audioRef: null,
    source: origin,
  }));
  return {
    revision: revisionNumber,
    normalizationRevision: 1,
    source: origin,
    providerId: null,
    rawText,
    displayText: text,
    utterances,
    corrections: [],
  };
}

function revisionContentKey(revision: TranscriptRevision): string {
  return JSON.stringify({
    source: revision.source,
    providerId: revision.providerId,
    rawText: revision.rawText,
    displayText: revision.displayText,
    utterances: revision.utterances.map(({ rawText, normalizedText, speakerId, speakerName, startMs, endMs, timing, audioRef }) => ({
      rawText, normalizedText, speakerId, speakerName, startMs, endMs, timing, audioRef,
    })),
  });
}

/** Attach imported or historical visible text as a source ledger without mutating the input segment. */
export function attachTextTranscript(
  segment: Segment,
  sourceId: string,
  origin: "text-import" | "legacy-transcript" | "edited-transcript",
): Segment {
  const existing = segment.transcript?.sourceId === sourceId ? segment.transcript : undefined;
  const parentId = existing?.id || `seg:${encodeURIComponent(sourceId)}:${segment.index}`;
  const nextNumber = existing ? Math.max(0, ...existing.revisions.map((revision) => revision.revision)) + 1 : origin === "legacy-transcript" ? 0 : 1;
  let nextRevision = makeTextRevision(segment, origin, parentId, nextNumber);
  const current = existing ? getCurrentTranscript(existing) : null;
  if (origin === "edited-transcript") {
    const coarseUnits: AsrTranscriptUnit[] = nextRevision.utterances.map((utterance) => ({
      rawText: "",
      normalizedText: utterance.normalizedText,
      speakerId: null,
      speakerName: null,
      startMs: null,
      endMs: null,
      timing: "unknown",
    }));
    nextRevision = {
      ...nextRevision,
      utterances: makeAsrUtterances(segment, sourceId, parentId, nextNumber, coarseUnits, origin)
        .map((utterance) => ({ ...utterance, rawText: null })),
    };
  }
  if (current && revisionContentKey(current) === revisionContentKey(nextRevision)) {
    return { ...segment, transcript: existing };
  }
  const sourcePath = segment.sourcePath || segment.audioPath || null;
  const transcript: TranscriptSegmentRecord = withSourceIntegrity({
    schemaVersion: 2,
    id: existing?.id || parentId,
    sourceId,
    sourcePath,
    sourceName: segment.sourceName || segment.audioName || null,
    currentRevision: nextNumber,
    revisions: [...(existing?.revisions || []), nextRevision],
  }, carriedSourceIntegrity(existing, sourcePath, null));
  return { ...segment, transcript };
}

function finiteNonNegative(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function makeAsrUtterances(
  segment: Segment,
  sourceId: string,
  parentId: string,
  revision: number,
  resultUnits: readonly AsrTranscriptUnit[],
  origin: TranscriptOrigin,
): Utterance[] {
  const segmentAudioPath = segment.segmentAudioPath || "";
  const audioPath = segment.audioPath || segmentAudioPath;
  const audioName = segment.audioName || segment.segmentAudioName || audioPath.split(/[\\/]/).pop() || "";
  const usesSessionAudio = !!segment.audioPath && segment.audioPath !== segmentAudioPath;
  const sessionOffset = usesSessionAudio ? finiteNonNegative(segment.audioStartOffsetMs ?? null) || 0 : 0;
  const clipDuration = Math.max(0, (Number(segment.endOffsetMs) || 0) - (Number(segment.startOffsetMs) || 0));
  const segmentStart = usesSessionAudio
    ? finiteNonNegative(segment.audioStartOffsetMs ?? null)
    : audioPath && clipDuration > 0 ? 0 : null;
  const segmentEnd = usesSessionAudio
    ? finiteNonNegative(segment.audioEndOffsetMs ?? null)
    : audioPath && clipDuration > 0 ? clipDuration : null;
  return resultUnits.map((unit, index) => {
    const rawStart = finiteNonNegative(unit.startMs);
    const rawEnd = finiteNonNegative(unit.endMs);
    const hasProviderRange = rawStart !== null && rawEnd !== null && rawEnd >= rawStart
      && (unit.timing === "provider" || unit.timing === "audio-span");
    const timing: TranscriptTiming = hasProviderRange ? unit.timing
      : segmentStart !== null && segmentEnd !== null && segmentEnd >= segmentStart ? "segment" : "unknown";
    const startMs = hasProviderRange ? rawStart + sessionOffset : timing === "segment" ? segmentStart : null;
    const endMs = hasProviderRange ? rawEnd + sessionOffset : timing === "segment" ? segmentEnd : null;
    const speakerId = unit.speakerId
      ? unit.speakerId.startsWith("channel:") ? `${sourceId}:${unit.speakerId}` : `${parentId}:${unit.speakerId}`
      : null;
    return {
      id: `${parentId}:r${revision}:u${index + 1}`,
      parentSegmentId: parentId,
      rawText: unit.rawText,
      normalizedText: unit.normalizedText,
      speakerId,
      speakerName: unit.speakerName,
      startMs,
      endMs,
      timing,
      audioRef: audioPath ? { path: audioPath, name: audioName, startMs, endMs, precision: timing } : null,
      source: origin,
    };
  });
}

function asrRawKey(source: TranscriptOrigin, rawText: string | null, units: readonly AsrTranscriptUnit[]): string {
  return JSON.stringify({ source, rawText, unitTexts: units.map((unit) => unit.rawText) });
}

function transcriptRawKey(revision: TranscriptRevision): string {
  return JSON.stringify({ source: revision.source, rawText: revision.rawText, unitTexts: revision.utterances.map((unit) => unit.rawText) });
}

/** Attach provider output while retaining exact service text and stable source-unit identities. */
export function attachTranscriptResult(
  segment: Segment,
  sourceId: string,
  result: AsrTranscriptResult | null,
  origin: TranscriptOrigin,
  sourceIntegrity: SourceIntegrity | null = null,
): Segment {
  const existing = segment.transcript?.sourceId === sourceId ? segment.transcript : undefined;
  const parentId = existing?.id || `seg:${encodeURIComponent(sourceId)}:${segment.index}`;
  const visibleText = String(segment.text || "");
  const sourcePath = segment.sourcePath || segment.audioPath || null;
  const integrity = carriedSourceIntegrity(existing, sourcePath, sourceIntegrity);
  const hasEvidence = !!result && (!!result.rawText || result.units.length > 0 || !!result.text.trim());
  if (!hasEvidence) {
    if (existing) return { ...segment, transcript: sourceIntegrity ? withSourceIntegrity(existing, sourceIntegrity) : existing };
    const emptyRevision: TranscriptRevision = {
      revision: 0,
      normalizationRevision: 1,
      source: origin,
      providerId: null,
      rawText: null,
      displayText: visibleText,
      utterances: [],
      corrections: [],
    };
    return {
      ...segment,
      transcript: withSourceIntegrity({
        schemaVersion: 2,
        id: parentId,
        sourceId,
        sourcePath,
        sourceName: segment.sourceName || segment.audioName || null,
        currentRevision: 0,
        revisions: [emptyRevision],
      }, integrity),
    };
  }

  const rawText = result.rawText;
  const previous = existing ? getCurrentTranscript(existing) : null;
  const sameRawRevision = previous && transcriptRawKey(previous) === asrRawKey(origin, rawText, result.units);
  const revisionNumber = sameRawRevision
    ? previous.revision
    : Math.max(0, ...(existing?.revisions || []).map((revision) => revision.revision)) + 1;
  const candidate: TranscriptRevision = {
    revision: revisionNumber,
    normalizationRevision: sameRawRevision ? previous.normalizationRevision : 1,
    source: origin,
    providerId: result.providerId || null,
    rawText,
    displayText: visibleText,
    utterances: makeAsrUtterances(segment, sourceId, parentId, revisionNumber, result.units, origin),
    corrections: sameRawRevision ? previous.corrections : [],
  };
  if (sameRawRevision && revisionContentKey(previous) === revisionContentKey(candidate)) {
    return { ...segment, transcript: existing && sourceIntegrity ? withSourceIntegrity(existing, sourceIntegrity) : existing };
  }
  if (sameRawRevision) {
    const normalizationRevision = previous.normalizationRevision + 1;
    const corrections: TranscriptCorrection[] = [...previous.corrections];
    for (let index = 0; index < candidate.utterances.length; index += 1) {
      const before = previous.utterances[index];
      const after = candidate.utterances[index];
      if (!before || !after) continue;
      if (before.normalizedText !== after.normalizedText) {
        corrections.push({ revision: normalizationRevision, kind: "text", from: before.normalizedText, to: after.normalizedText, utteranceIds: [after.id] });
      }
      if (before.speakerName !== after.speakerName) {
        corrections.push({ revision: normalizationRevision, kind: "speaker", from: before.speakerName || "", to: after.speakerName || "", utteranceIds: [after.id] });
      }
    }
    candidate.normalizationRevision = normalizationRevision;
    candidate.corrections = corrections;
  }
  const revisions = [...(existing?.revisions || [])];
  const replaceAt = revisions.findIndex((revision) => revision.revision === candidate.revision);
  if (replaceAt >= 0) revisions[replaceAt] = candidate;
  else revisions.push(candidate);
  return {
    ...segment,
    transcript: withSourceIntegrity({
      schemaVersion: 2,
      id: existing?.id || parentId,
      sourceId,
      sourcePath,
      sourceName: segment.sourceName || segment.audioName || null,
      currentRevision: candidate.revision,
      revisions,
    }, integrity),
  };
}

/** Hash the exact current source ledger projection; callers still compare persisted revision lists. */
export function getTranscriptSourceRevision(segments: readonly Segment[]): string {
  const sources = segments
    .flatMap((segment) => {
      const record = segment.transcript;
      if (!record) return [];
      const current = getCurrentTranscript(record);
      return [{
        sourceId: record.sourceId,
        parentId: record.id,
        source: current.source,
        providerId: current.providerId,
        rawText: current.rawText,
        revision: current.revision,
        normalizationRevision: current.normalizationRevision,
        utterances: current.utterances.map(({ id, rawText, normalizedText, speakerId, speakerName, startMs, endMs, timing, audioRef }) => ({
          id, rawText, normalizedText, speakerId, speakerName, startMs, endMs, timing, audioRef,
        })),
      }];
    })
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.parentId.localeCompare(right.parentId));
  return `tx-${stableHash(JSON.stringify(sources))}`;
}
