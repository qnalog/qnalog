/**
 * Offline scoring for the transcription accuracy baseline (MAINTAINING §6.1).
 *
 * Location: scripts/accuracy-baseline/. The folder is outside tsconfig "include"
 * (src only), so neither the plugin bundle nor the `tsc` build reads it. The CLI
 * (scripts/accuracy-baseline.mjs) bundles this file with esbuild at run time,
 * the same way scripts/eval-related-notes.mjs does. It only imports a type.
 *
 * Ground-truth file format (JSON):
 *   {
 *     "title": string,
 *     "language": "zh" | "en" | "mixed",
 *     "utterances": [{ "speaker": string, "text": string, "startMs": number, "endMs": number }]
 *   }
 * Utterances may overlap in time (interruptions). Speaker names are free text.
 *
 * Metrics:
 * - Speaker attribution is weighted by duration. Each hypothesis unit that has a
 *   speaker label and both times is intersected with each reference utterance.
 *   Hypothesis labels are mapped one-to-one to reference speakers so that the
 *   total matched overlap is largest. wrongShare = overlap with a mismatched
 *   speaker / overlap with any labelled unit. coverage = labelled overlap /
 *   total reference duration. Duration is used instead of characters because
 *   units without text positions cannot be split by character.
 * - Time offset uses units with timing "provider". Each reference utterance is
 *   matched to the provider unit(s) whose text covers it best, and the offset is
 *   |unit start - utterance start| of the earliest matched unit.
 * - Text error rate is edit distance over tokens divided by reference token
 *   count, computed on the units' text when units exist (result.text may carry
 *   time and speaker labels). A second rate first writes Chinese numerals as
 *   Arabic digits in both texts, because services differ in how they write numbers.
 *   Tokens are single CJK characters and lower-cased Latin/digit words.
 */
import type { AsrTranscriptResult } from "../../src/asr/transcript-result";

export interface ReferenceUtterance {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface GroundTruth {
  title: string;
  language: "zh" | "en" | "mixed";
  utterances: ReferenceUtterance[];
}

export interface SpeakerScore {
  referenceSpeakers: number;
  hypothesisSpeakers: number;
  referenceDurationMs: number;
  labelledOverlapMs: number;
  wrongOverlapMs: number;
  /** labelledOverlapMs / referenceDurationMs, 0 when there is no reference duration. */
  coverage: number;
  /** wrongOverlapMs / labelledOverlapMs, 0 when nothing is labelled. */
  wrongShare: number;
  /** Hypothesis label -> reference speaker. */
  mapping: Record<string, string>;
}

export interface OffsetScore {
  matchedUtterances: number;
  medianMs: number | null;
  p90Ms: number | null;
}

export interface TimingShares {
  provider: number;
  audioSpan: number;
  unknown: number;
  totalUnits: number;
}

export interface TextScore {
  referenceTokens: number;
  hypothesisTokens: number;
  editDistance: number;
  errorRate: number;
  /** Same comparison after Chinese numerals in both texts are written as Arabic digits (十一 → 11, 百分之十五 → 15). */
  numberNormalizedErrorRate: number;
}

export interface AccuracyReport {
  title: string;
  speaker: SpeakerScore;
  offset: OffsetScore;
  timing: TimingShares;
  text: TextScore;
}

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;
const WORD = /[A-Za-z0-9À-ɏ]/;

/** Splits text into CJK characters and lower-cased Latin/digit words; drops punctuation and spaces. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = "";
  const flush = (): void => {
    if (word) tokens.push(word.toLowerCase());
    word = "";
  };
  for (const ch of String(text || "")) {
    if (CJK.test(ch)) {
      flush();
      tokens.push(ch);
    } else if (WORD.test(ch) || (word && (ch === "'" || ch === "’"))) {
      word += ch;
    } else {
      flush();
    }
  }
  flush();
  return tokens;
}

export function editDistance(a: readonly string[], b: readonly string[]): number {
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost));
    }
    prev = cur;
  }
  return prev[b.length];
}

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Nearest-rank percentile of a non-empty sorted array; p in (0, 1]. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Pick {
  score: number;
  picks: number[];
}

/** For each row, the chosen column (or -1) so that the sum of matrix[row][col] is largest and no column repeats. */
function bestAssignment(matrix: number[][]): number[] {
  const rows = matrix.length;
  const cols = rows ? matrix[0].length : 0;
  if (!rows || !cols) return new Array<number>(rows).fill(-1);
  if (cols > 16) {
    // Greedy fallback for unusually many hypothesis labels.
    const used = new Set<number>();
    return matrix.map((row) => {
      let best = -1;
      row.forEach((value, c) => {
        if (!used.has(c) && value > 0 && (best < 0 || value > row[best])) best = c;
      });
      if (best >= 0) used.add(best);
      return best;
    });
  }
  const memo = new Map<string, Pick>();
  const solve = (r: number, used: number): Pick => {
    if (r === rows) return { score: 0, picks: [] };
    const key = `${r}:${used}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const skip = solve(r + 1, used);
    let best: Pick = { score: skip.score, picks: [-1, ...skip.picks] };
    for (let c = 0; c < cols; c++) {
      if ((used & (1 << c)) !== 0 || matrix[r][c] <= 0) continue;
      const next = solve(r + 1, used | (1 << c));
      if (matrix[r][c] + next.score > best.score) best = { score: matrix[r][c] + next.score, picks: [c, ...next.picks] };
    }
    memo.set(key, best);
    return best;
  };
  return solve(0, 0).picks;
}

export function scoreSpeakers(truth: GroundTruth, result: AsrTranscriptResult): SpeakerScore {
  const refSpeakers = [...new Set(truth.utterances.map((u) => u.speaker))];
  const placed: { label: string; start: number; end: number }[] = [];
  for (const unit of result.units) {
    const label = String(unit.speakerId ?? unit.speakerName ?? "").trim();
    if (!label || unit.startMs === null || unit.endMs === null || unit.endMs <= unit.startMs) continue;
    placed.push({ label, start: unit.startMs, end: unit.endMs });
  }
  const hypLabels = [...new Set(placed.map((u) => u.label))];
  const matrix = refSpeakers.map(() => hypLabels.map(() => 0));
  let labelled = 0;
  for (const ref of truth.utterances) {
    const r = refSpeakers.indexOf(ref.speaker);
    for (const unit of placed) {
      const ms = overlapMs(ref.startMs, ref.endMs, unit.start, unit.end);
      if (ms <= 0) continue;
      matrix[r][hypLabels.indexOf(unit.label)] += ms;
      labelled += ms;
    }
  }
  const picks = bestAssignment(matrix);
  const mapping: Record<string, string> = {};
  let correct = 0;
  picks.forEach((c, r) => {
    if (c < 0) return;
    mapping[hypLabels[c]] = refSpeakers[r];
    correct += matrix[r][c];
  });
  const referenceDurationMs = truth.utterances.reduce((sum, u) => sum + Math.max(0, u.endMs - u.startMs), 0);
  const wrong = labelled - correct;
  return {
    referenceSpeakers: refSpeakers.length,
    hypothesisSpeakers: hypLabels.length,
    referenceDurationMs,
    labelledOverlapMs: labelled,
    wrongOverlapMs: wrong,
    coverage: referenceDurationMs ? labelled / referenceDurationMs : 0,
    wrongShare: labelled ? wrong / labelled : 0,
    mapping,
  };
}

function bagOf(tokens: readonly string[]): Map<string, number> {
  const bag = new Map<string, number>();
  for (const t of tokens) bag.set(t, (bag.get(t) ?? 0) + 1);
  return bag;
}

/** Share of unit tokens found in the reference tokens (each reference token used once). */
function containment(unitTokens: readonly string[], refBag: ReadonlyMap<string, number>): number {
  const left = new Map(refBag);
  let hit = 0;
  for (const t of unitTokens) {
    const n = left.get(t) ?? 0;
    if (n > 0) {
      hit++;
      left.set(t, n - 1);
    }
  }
  return unitTokens.length ? hit / unitTokens.length : 0;
}

export function scoreOffsets(truth: GroundTruth, result: AsrTranscriptResult): OffsetScore {
  const refBags = truth.utterances.map((u) => bagOf(tokenize(u.text)));
  const units = result.units
    .filter((u) => u.timing === "provider" && u.startMs !== null)
    .map((u) => ({ start: u.startMs as number, tokens: tokenize(u.normalizedText || u.rawText) }))
    .filter((u) => u.tokens.length > 0);
  const offsets: number[] = [];
  truth.utterances.forEach((ref, index) => {
    let earliest: number | null = null;
    for (const unit of units) {
      const own = containment(unit.tokens, refBags[index]);
      if (own < 0.5) continue;
      // A unit belongs to the utterance it matches best.
      const rival = refBags.some((bag, j) => j !== index && containment(unit.tokens, bag) > own);
      if (rival) continue;
      if (earliest === null || unit.start < earliest) earliest = unit.start;
    }
    if (earliest !== null) offsets.push(Math.abs(earliest - ref.startMs));
  });
  if (!offsets.length) return { matchedUtterances: 0, medianMs: null, p90Ms: null };
  const sorted = [...offsets].sort((a, b) => a - b);
  return { matchedUtterances: sorted.length, medianMs: median(sorted), p90Ms: percentile(sorted, 0.9) };
}

export function timingShares(result: AsrTranscriptResult): TimingShares {
  const total = result.units.length;
  const share = (kind: string): number => (total ? result.units.filter((u) => u.timing === kind).length / total : 0);
  return { provider: share("provider"), audioSpan: share("audio-span"), unknown: share("unknown"), totalUnits: total };
}

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const CN_NUMBER_RUN = /[零〇一二两三四五六七八九十百千万亿]+/g;

/** Reads one run of Chinese numerals. Runs without unit characters (二〇二六) are read digit by digit. */
function chineseRunToArabic(run: string): string {
  if (!/[十百千万亿]/.test(run)) return [...run].map((ch) => String(CN_DIGITS[ch])).join("");
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of run) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      section += (digit || 1) * CN_UNITS[ch];
      digit = 0;
    } else {
      const big = ch === "万" ? 10_000 : 100_000_000;
      total = (total + section + digit) * big;
      section = 0;
      digit = 0;
    }
  }
  return String(total + section + digit);
}

/** Writes Chinese numerals as Arabic digits and drops 百分之 before a number; applied to both texts. */
export function normalizeNumbers(text: string): string {
  return String(text || "")
    .replace(/百分之([零〇一二两三四五六七八九十百千万亿]+)/g, "$1")
    .replace(CN_NUMBER_RUN, chineseRunToArabic);
}

/** Hypothesis text: the units' text when the service returned units, otherwise the whole text. */
function hypothesisText(result: AsrTranscriptResult): string {
  if (result.units.length) return result.units.map((u) => u.normalizedText || u.rawText).join(" ");
  return result.text || "";
}

export function scoreText(truth: GroundTruth, result: AsrTranscriptResult): TextScore {
  const refText = truth.utterances.map((u) => u.text).join(" ");
  const hypText = hypothesisText(result);
  const ref = tokenize(refText);
  const hyp = tokenize(hypText);
  const distance = editDistance(ref, hyp);
  const refN = tokenize(normalizeNumbers(refText));
  const hypN = tokenize(normalizeNumbers(hypText));
  const distanceN = editDistance(refN, hypN);
  return {
    referenceTokens: ref.length,
    hypothesisTokens: hyp.length,
    editDistance: distance,
    errorRate: ref.length ? distance / ref.length : hyp.length ? 1 : 0,
    numberNormalizedErrorRate: refN.length ? distanceN / refN.length : hypN.length ? 1 : 0,
  };
}

export function scoreTranscript(truth: GroundTruth, result: AsrTranscriptResult): AccuracyReport {
  return {
    title: truth.title,
    speaker: scoreSpeakers(truth, result),
    offset: scoreOffsets(truth, result),
    timing: timingShares(result),
    text: scoreText(truth, result),
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatReport(report: AccuracyReport): string {
  const s = report.speaker;
  const o = report.offset;
  const t = report.timing;
  const ms = (v: number | null): string => (v === null ? "n/a" : `${Math.round(v)} ms`);
  return [
    `Title: ${report.title}`,
    `Speakers: reference ${s.referenceSpeakers}, hypothesis ${s.hypothesisSpeakers}`,
    `Speaker attribution: wrong ${pct(s.wrongShare)} of labelled time, coverage ${pct(s.coverage)}`,
    `Start offset: median ${ms(o.medianMs)}, p90 ${ms(o.p90Ms)} (${o.matchedUtterances} utterances)`,
    `Timing precision: provider ${pct(t.provider)}, audio-span ${pct(t.audioSpan)}, unknown ${pct(t.unknown)} (${t.totalUnits} units)`,
    `Text error rate: ${pct(report.text.errorRate)} (${report.text.editDistance} edits / ${report.text.referenceTokens} reference tokens); with numbers normalized ${pct(report.text.numberNormalizedErrorRate)}`,
  ].join("\n");
}
