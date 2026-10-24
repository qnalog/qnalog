/**
 * Find in recording: the user types words and gets the utterances where they were said, each with the
 * time in the recording, so a long recording can be checked without listening from the start
 * (MAINTAINING §6.1, §7.2 "核对原话").
 *
 * Data and limits:
 * - The search unit is one utterance of the note's transcript ledger. Text and speaker name come from the
 *   ledger; when the note's session knowledge still matches the ledger, its utterance projections
 *   (corrected text, mapped speaker name) are applied, the same way the evidence-links block resolves them.
 * - Time is the utterance's `audioRef` start inside its audio file, with its precision
 *   (`provider` / `audio-span` / `segment` / `unknown`, MAINTAINING §7.4 item 2). When the utterance has no
 *   usable `audioRef`, the segment's audio start is used when the ledger has one, and the precision is `segment`.
 * - Segments without a ledger (older notes) are searched as one unit per segment, at the segment start,
 *   precision `segment`.
 * - Matching ignores case, whitespace and punctuation, writes Chinese numerals as Arabic digits on both
 *   sides (十一 ↔ 11, 百分之十五 ↔ 15), and also matches the speaker name. Space-separated terms must all
 *   appear in the same utterance, each one in its text or in its speaker name.
 *
 * Pure module: no Obsidian, DOM, network or model calls.
 */
import type { Segment } from "../shared/types";
import { AUDIO_EXT } from "../shared/catalog-import";
import { formatElapsed, normalizeAudioLinkTarget } from "../shared/util-common";
import {
  CN_PERCENT_PREFIX,
  chineseNumeralRunToArabic,
  isChineseNumeralChar,
  isNumberLikeChineseRun,
} from "../shared/chinese-numerals";
import { getCurrentTranscript, type TranscriptTiming, type Utterance } from "../transcript/session-transcript";
import { buildKnowledgeEvidenceIndex, resolveIndexedUtterance, type SessionKnowledge } from "../briefing/session-knowledge";
import { audioRefStartMs } from "../briefing/evidence-links";

/** Results shown at most; the rest is reported as a count. */
export const RECORDING_SEARCH_MAX_RESULTS = 200;
/** Snippet length at most, in Unicode code points, including the leading and trailing ellipsis. */
export const RECORDING_SEARCH_SNIPPET_MAX_CHARS = 60;
/** Code points shown before the first hit when the snippet has to be cut. */
const SNIPPET_LEAD_CHARS = 18;
const ELLIPSIS = "…";

/**
 * Where a result plays from: the same values a rendered `[[audio|mm:ss]]` time link carries, so the
 * sidebar can hand them to the existing time-link click path (`AudioTimeLinkService.openAudioTimeLink`).
 */
export interface RecordingSearchTarget {
  /** Audio link path (vault path or file name) as stored in the ledger. */
  linkPath: string;
  /** Time label inside that audio file, `mm:ss` or `h:mm:ss`. */
  label: string;
  /** Start inside that audio file, in milliseconds. */
  localMs: number;
}

/** A character range `[start, end)` in a result's `snippet` string (UTF-16 indices). */
export interface RecordingSearchHit {
  start: number;
  end: number;
}

export type RecordingSearchMatchedIn = "text" | "speaker" | "both";

export interface RecordingSearchResult {
  /** Utterance ID, or `segment:<index>` for a segment without a ledger. */
  id: string;
  /** Start inside the audio file; null when the time is unknown. */
  startMs: number | null;
  /** `mm:ss` / `h:mm:ss`; empty when the time is unknown. */
  timeLabel: string;
  precision: TranscriptTiming;
  /** Speaker display name; empty when the ledger has none. */
  speaker: string;
  matchedIn: RecordingSearchMatchedIn;
  /** At most `RECORDING_SEARCH_SNIPPET_MAX_CHARS` code points around the first text hit. */
  snippet: string;
  /** Text hits inside `snippet`, sorted and not overlapping. Empty when only the speaker matched. */
  hits: RecordingSearchHit[];
  /** Null when there is no audio file or no usable time. */
  target: RecordingSearchTarget | null;
}

export interface RecordingSearchOutcome {
  /** Normalized query terms; empty for an empty query. */
  terms: string[];
  /** Matching utterances in time order, at most the limit. */
  results: RecordingSearchResult[];
  /** All matches, including those over the limit. */
  total: number;
  /** Matches not included in `results`. */
  more: number;
}

interface NormalizedText {
  text: string;
  /** For each UTF-16 index of `text`: the source range it came from. */
  starts: number[];
  ends: number[];
}

interface SearchEntry {
  id: string;
  speaker: string;
  text: string;
  startMs: number | null;
  precision: TranscriptTiming;
  target: RecordingSearchTarget | null;
  normalizedText: NormalizedText;
  normalizedSpeaker: string;
}

/** Prepared once per note; `searchRecording` runs against it for each query. */
export interface RecordingSearchIndex {
  readonly entries: readonly SearchEntry[];
}

const IGNORED_CHAR = /[\p{P}\p{Z}\s]/u;
const ASCII_WORD_CHAR = /[A-Za-z0-9]/;

interface NormUnit { text: string; start: number; end: number }

/**
 * Case-folded, NFKC text without whitespace or punctuation, Chinese numerals as Arabic digits.
 * Each output character keeps the source range it came from, so hits can be mapped back for highlighting.
 */
export function normalizeForRecordingSearch(source: string): NormalizedText {
  const value = String(source || "");
  const units: NormUnit[] = [];
  let offset = 0;
  for (const ch of value) {
    units.push({ text: ch.normalize("NFKC").toLowerCase(), start: offset, end: offset + ch.length });
    offset += ch.length;
  }
  const converted = convertNumeralRuns(units);
  const result: NormalizedText = { text: "", starts: [], ends: [] };
  let text = "";
  for (const unit of converted) {
    for (const ch of unit.text) {
      if (IGNORED_CHAR.test(ch)) continue;
      text += ch;
      for (let i = 0; i < ch.length; i += 1) {
        result.starts.push(unit.start);
        result.ends.push(unit.end);
      }
    }
  }
  result.text = text;
  return result;
}

/** A run is converted only when it reads as a number (`isNumberLikeChineseRun`). */
function convertNumeralRuns(units: readonly NormUnit[]): NormUnit[] {
  const out: NormUnit[] = [];
  const prefix = [...CN_PERCENT_PREFIX];
  const isNumeral = (unit: NormUnit | undefined): boolean => !!unit && isChineseNumeralChar(unit.text);
  let i = 0;
  while (i < units.length) {
    const hasPrefix = prefix.every((ch, k) => units[i + k]?.text === ch) && isNumeral(units[i + prefix.length]);
    const runStart = hasPrefix ? i + prefix.length : i;
    if (!isNumeral(units[runStart])) {
      out.push(units[i]);
      i += 1;
      continue;
    }
    let runEnd = runStart;
    while (isNumeral(units[runEnd])) runEnd += 1;
    const run = units.slice(runStart, runEnd).map((unit) => unit.text).join("");
    if (!isNumberLikeChineseRun(run)) {
      out.push(...units.slice(i, runEnd));
    } else {
      out.push({ text: chineseNumeralRunToArabic(run), start: units[i].start, end: units[runEnd - 1].end });
    }
    i = runEnd;
  }
  return out;
}

/** Splits the query on whitespace and normalizes each term; terms that normalize to nothing are dropped. */
export function parseRecordingSearchQuery(query: string): string[] {
  const terms = String(query || "").split(/\s+/u).map((term) => normalizeForRecordingSearch(term).text).filter(Boolean);
  return [...new Set(terms)];
}

/**
 * Builds the search entries of one note. `knowledge` is the note's selected session knowledge; its
 * projections are applied only while it still matches the ledger.
 */
export function buildRecordingSearchIndex(segments: readonly Segment[], knowledge?: SessionKnowledge | null): RecordingSearchIndex {
  const evidence = knowledge ? buildKnowledgeEvidenceIndex(knowledge, segments) : null;
  const rows: Array<{ entry: SearchEntry; order: number | null }> = [];
  const seen = new Set<string>();
  segments.forEach((segment, segmentIndex) => {
    const record = segment.transcript;
    const segmentTime = segmentStart(segment, !record);
    if (!record) {
      const text = inlineText(segment.text);
      if (!text) return;
      rows.push({
        entry: makeEntry(`segment:${segment.index ?? segmentIndex}`, "", text, segmentTime ? { ...segmentTime, precision: "segment" } : null),
        order: noteOrder(segment, segmentTime?.startMs ?? null),
      });
      return;
    }
    let utterances: Utterance[];
    try { utterances = getCurrentTranscript(record).utterances; }
    catch { return; }
    for (const raw of utterances) {
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);
      const utterance = (evidence?.fresh ? resolveIndexedUtterance(evidence, raw.id) : null) || raw;
      const text = inlineText(utterance.normalizedText);
      if (!text) continue;
      const time = utteranceTime(utterance) || (segmentTime ? { ...segmentTime, precision: "segment" as const } : null);
      rows.push({
        entry: makeEntry(utterance.id, inlineText(utterance.speakerName || ""), text, time),
        order: noteOrder(segment, time?.startMs ?? null),
      });
    }
  });
  // Time order on the note clock; rows without a time keep their place after the row before them.
  let carried = Number.NEGATIVE_INFINITY;
  const keyed = rows.map((row, position) => {
    if (row.order !== null) carried = row.order;
    return { entry: row.entry, key: carried, position };
  });
  keyed.sort((left, right) => left.key - right.key || left.position - right.position);
  return { entries: keyed.map((row) => row.entry) };
}

interface ResolvedTime { startMs: number; precision: TranscriptTiming; linkPath: string }

function utteranceTime(utterance: Utterance): ResolvedTime | null {
  const ref = utterance.audioRef;
  const startMs = audioRefStartMs(ref);
  if (!ref || startMs === null || ref.precision === "unknown") return null;
  const linkPath = audioLinkPath(ref.path) || audioLinkPath(ref.name);
  return linkPath ? { startMs, precision: ref.precision, linkPath } : null;
}

/**
 * Segment start inside its audio file. Older notes without a ledger often have no audio offset; for them
 * the segment's note-clock start is used, as the raw-transcript fallback block does (`detail-blocks.ts`).
 */
function segmentStart(segment: Segment, allowNoteClock: boolean): Omit<ResolvedTime, "precision"> | null {
  const linkPath = audioLinkPath(segment.audioPath) || audioLinkPath(segment.audioName);
  if (!linkPath) return null;
  const audioStart = finiteNonNegative(segment.audioStartOffsetMs);
  const startMs = audioStart ?? (allowNoteClock ? finiteNonNegative(segment.startOffsetMs) : null);
  return startMs === null ? null : { startMs, linkPath };
}

/** Sort key on the note clock: segment start plus the utterance's distance from the segment's audio start. */
function noteOrder(segment: Segment, localMs: number | null): number | null {
  const segmentNoteStart = finiteNonNegative(segment.startOffsetMs);
  if (segmentNoteStart === null) return localMs;
  const audioStart = finiteNonNegative(segment.audioStartOffsetMs);
  if (localMs === null || audioStart === null) return segmentNoteStart;
  return segmentNoteStart + Math.max(0, localMs - audioStart);
}

function audioLinkPath(value: string | null | undefined): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const target = normalizeAudioLinkTarget(text);
  const ext = ((target.split("/").pop() || target).split(".").pop() || "").toLowerCase();
  return AUDIO_EXT.has(ext) ? text : "";
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function makeEntry(id: string, speaker: string, text: string, time: ResolvedTime | null): SearchEntry {
  return {
    id,
    speaker,
    text,
    startMs: time ? time.startMs : null,
    precision: time ? time.precision : "unknown",
    target: time ? { linkPath: time.linkPath, label: formatElapsed(time.startMs), localMs: time.startMs } : null,
    normalizedText: normalizeForRecordingSearch(text),
    normalizedSpeaker: normalizeForRecordingSearch(speaker).text,
  };
}

function inlineText(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

/** Runs one query. An empty query returns no results. */
export function searchRecording(
  index: RecordingSearchIndex | null | undefined,
  query: string,
  limit: number = RECORDING_SEARCH_MAX_RESULTS,
): RecordingSearchOutcome {
  const terms = parseRecordingSearchQuery(query);
  const outcome: RecordingSearchOutcome = { terms, results: [], total: 0, more: 0 };
  if (!terms.length || !index) return outcome;
  for (const entry of index.entries) {
    const match = matchEntry(entry, terms);
    if (!match) continue;
    outcome.total += 1;
    if (outcome.results.length < limit) outcome.results.push(toResult(entry, match));
  }
  outcome.more = outcome.total - outcome.results.length;
  return outcome;
}

interface EntryMatch { sourceHits: RecordingSearchHit[]; textHit: boolean; speakerHit: boolean }

function matchEntry(entry: SearchEntry, terms: readonly string[]): EntryMatch | null {
  const sourceHits: RecordingSearchHit[] = [];
  let textHit = false;
  let speakerHit = false;
  for (const term of terms) {
    const inSpeaker = !!entry.normalizedSpeaker && entry.normalizedSpeaker.includes(term);
    const found = findAll(entry.normalizedText, term);
    if (!found.length && !inSpeaker) return null;
    if (inSpeaker) speakerHit = true;
    if (found.length) textHit = true;
    sourceHits.push(...found);
  }
  return { sourceHits: mergeRanges(sourceHits), textHit, speakerHit };
}

function findAll(normalized: NormalizedText, term: string): RecordingSearchHit[] {
  const hits: RecordingSearchHit[] = [];
  let from = 0;
  while (from <= normalized.text.length - term.length) {
    const at = normalized.text.indexOf(term, from);
    if (at < 0) break;
    hits.push({ start: normalized.starts[at], end: normalized.ends[at + term.length - 1] });
    from = at + 1;
  }
  return hits;
}

function mergeRanges(ranges: readonly RecordingSearchHit[]): RecordingSearchHit[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: RecordingSearchHit[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function toResult(entry: SearchEntry, match: EntryMatch): RecordingSearchResult {
  const snippet = buildSnippet(entry.text, match.sourceHits);
  return {
    id: entry.id,
    startMs: entry.startMs,
    timeLabel: entry.startMs === null ? "" : formatElapsed(entry.startMs),
    precision: entry.precision,
    speaker: entry.speaker,
    matchedIn: match.textHit && match.speakerHit ? "both" : match.textHit ? "text" : "speaker",
    snippet: snippet.text,
    hits: snippet.hits,
    target: entry.target ? { ...entry.target } : null,
  };
}

/**
 * Cuts the text to a window around the first hit. The window is counted in code points, does not split a
 * Latin word or number at its edges unless the hit itself is that close, and marks cut ends with an ellipsis.
 */
function buildSnippet(text: string, hits: readonly RecordingSearchHit[]): { text: string; hits: RecordingSearchHit[] } {
  const points = Array.from(text);
  const offsets: number[] = [];
  let offset = 0;
  for (const point of points) { offsets.push(offset); offset += point.length; }
  offsets.push(offset);
  const toPoint = (utf16: number): number => {
    let low = 0;
    let high = points.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (offsets[mid] < utf16) low = mid + 1; else high = mid;
    }
    return low;
  };
  const max = RECORDING_SEARCH_SNIPPET_MAX_CHARS;
  if (points.length <= max) return { text, hits: hits.map((hit) => ({ ...hit })) };

  const n = points.length;
  const first = hits[0];
  const hitStart = first ? toPoint(first.start) : 0;
  const hitEnd = first ? toPoint(first.end) : 0;
  let start = Math.max(0, hitStart - SNIPPET_LEAD_CHARS);
  // The ellipses count toward the limit: one before the body when it starts after 0, one after it when it ends before n.
  let end = Math.min(n, start + max - (start > 0 ? 1 : 0));
  if (end < n) end -= 1;
  else start = n - (max - 1); // Near the end of the text, move the start back so the window stays full.

  const isWord = (index: number): boolean => index >= 0 && index < n && ASCII_WORD_CHAR.test(points[index]);
  const isSpace = (index: number): boolean => /\s/u.test(points[index] || "");
  if (start > 0 && isWord(start - 1) && isWord(start)) {
    let next = start;
    while (next < hitStart && isWord(next)) next += 1;
    if (!isWord(next) || next === hitStart) start = next;
  }
  if (end < n && isWord(end - 1) && isWord(end)) {
    let previous = end;
    while (previous > hitEnd && isWord(previous - 1)) previous -= 1;
    if (previous > start && (!isWord(previous - 1) || previous === hitEnd)) end = previous;
  }
  while (start < hitStart && isSpace(start)) start += 1;
  while (end > Math.max(hitEnd, start) && isSpace(end - 1)) end -= 1;

  const prefix = start > 0 ? ELLIPSIS : "";
  const suffix = end < points.length ? ELLIPSIS : "";
  const windowStart = offsets[start];
  const windowEnd = offsets[end];
  const body = points.slice(start, end).join("");
  const shown: RecordingSearchHit[] = [];
  for (const hit of hits) {
    const hitFrom = Math.max(hit.start, windowStart);
    const hitTo = Math.min(hit.end, windowEnd);
    if (hitTo <= hitFrom) continue;
    shown.push({ start: hitFrom - windowStart + prefix.length, end: hitTo - windowStart + prefix.length });
  }
  return { text: `${prefix}${body}${suffix}`, hits: shown };
}
