import type { SessionKnowledge } from "./session-knowledge";
import { t } from "../shared/i18n";
import {
  NS_PART_BODY_RE,
  NS_PART_ENTITY_LINE_RE,
  NS_PART_SUMMARY_BLOCK_RE,
  NS_PART_SUMMARY_LINE_RE,
  NS_PART_SUMMARY_ONLY_RE,
  NS_PART_SUMMARY_RE,
  NS_PART_SUMMARY_STRIP_RE,
} from "../shared/namespace";

export const BRIEFING_PIPELINE_VERSION = 11;

export type BriefingSegment = {
  index?: number;
  startOffsetMs?: number;
  endOffsetMs?: number;
  text?: string;
  utteranceId?: string;
  transcriptSourceRevision?: string;
  speakerId?: string | null;
  speakerName?: string | null;
  timing?: string;
};

export type BriefingUsage = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

export type BriefingPartStatus = "pending" | "running" | "complete" | "partial" | "failed";

export type BriefingPartCheckpoint = {
  index: number;
  segmentStart: number;
  segmentEnd: number;
  startOffsetMs: number;
  endOffsetMs: number;
  sourceHash: string;
  status: BriefingPartStatus;
  text: string;
  summary: string;
  people: string[];
  tags: string[];
  sedimentObjects: unknown;
  knowledge: SessionKnowledge | null;
  finishReason: string;
  attempts: number;
  usage: BriefingUsage;
  error: string;
  sourceChars?: number;
  outputChars?: number;
  outputRatio?: number;
  minimumOutputChars?: number;
  targetOutputChars?: number;
  qualityStatus?: "pending" | "ok" | "under-detailed" | "under-grounded";
  repairAttempts?: number;
  updatedAt: string;
};

export type BriefingCheckpointStatus = "running" | "partial" | "assembled" | "committed";

export type BriefingCheckpoint = {
  version: number;
  id: string;
  sourceHash: string;
  optionsHash: string;
  mode: string;
  model: string;
  status: BriefingCheckpointStatus;
  topicMap: string;
  /** 议题映射的来源：llm 由模型生成，timeline 由时间线兜底，part-summaries 由分部摘要汇总。 */
  topicMapSource: "llm" | "timeline" | "part-summaries" | "";
  topicMapFinishReason: string;
  topicMapUsage: BriefingUsage;
  consolidationStatus: "pending" | "running" | "complete" | "failed";
  consolidationBody: string;
  consolidationFinishReason: string;
  consolidationUsage: BriefingUsage;
  consolidationAttempts: number;
  consolidationError: string;
  coverageRepairAttempted: boolean;
  auditStatus: "pending" | "complete" | "failed";
  auditText: string;
  auditFinishReason: string;
  auditUsage: BriefingUsage;
  parts: BriefingPartCheckpoint[];
  assembledKnowledge: SessionKnowledge | null;
  assembledBody: string;
  createdAt: string;
  updatedAt: string;
};

export type BriefingPartPlan = {
  index: number;
  segments: BriefingSegment[];
  segmentStart: number;
  segmentEnd: number;
  startOffsetMs: number;
  endOffsetMs: number;
  sourceHash: string;
  chars: number;
};

export type BriefingFidelityPolicy = {
  profile: "detailed" | "balanced" | "concise";
  sourceTargetChars: number;
  minimumOutputRatio: number;
  targetOutputRatio: number;
  absoluteMinimumChars: number;
  enforceLengthFloor: boolean;
};

export type BriefingFidelityAssessment = {
  sourceChars: number;
  outputChars: number;
  outputRatio: number;
  minimumOutputChars: number;
  targetOutputChars: number;
  needsExpansion: boolean;
};
export type BriefingGroundingAssessment = {
  anchors: string[];
  missingAnchors: string[];
  matchedAnchors: number;
  ratio: number;
  needsRepair: boolean;
};


export type BriefingSegmentCoverageResult = {
  segmentNumber: number;
  bigramOverlap: number;
  bigramCount: number;
  matchedNameAnchors: number;
  nameAnchorCount: number;
  numericAnchorCount: number;
  eligible: boolean;
  missing: boolean;
};

export type BriefingSegmentCoverageAssessment = {
  missingSegments: number[];
  segments: BriefingSegmentCoverageResult[];
};

export const EMPTY_BRIEFING_USAGE: BriefingUsage = {
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};

function cleanText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).trim();
  }
  return "";
}

function finiteNonNegative(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

export function stableBriefingHash(value: unknown): string {
  let text = "";
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value) ?? ""; }
    catch { text = ""; }
  }
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function getBriefingSourceHash(segments: BriefingSegment[]): string {
  return stableBriefingHash((Array.isArray(segments) ? segments : []).map((segment, index) => [
    Number.isFinite(Number(segment?.index)) ? Number(segment.index) : index,
    finiteNonNegative(segment?.startOffsetMs),
    finiteNonNegative(segment?.endOffsetMs),
    cleanText(segment?.text),
    cleanText(segment?.utteranceId),
    cleanText(segment?.transcriptSourceRevision),
  ].join("|")).join("\n"));
}

export function createBriefingJobId(input: {
  segments: BriefingSegment[];
  mode: string;
  model: string;
  optionsKey: string;
}): { id: string; sourceHash: string; optionsHash: string } {
  const sourceHash = getBriefingSourceHash(input.segments);
  const optionsHash = stableBriefingHash([
    BRIEFING_PIPELINE_VERSION,
    cleanText(input.mode),
    cleanText(input.model),
    cleanText(input.optionsKey),
  ].join("|"));
  return {
    id: `briefing-${sourceHash}-${optionsHash}`,
    sourceHash,
    optionsHash,
  };
}

function splitBriefingTextAtBoundaries(value: unknown, maxChars: number): string[] {
  let remaining = cleanText(value);
  if (!remaining) return [];
  const limit = Math.max(2_000, Math.floor(Number(maxChars) || 12_000));
  const chunks: string[] = [];
  while (remaining.length > limit) {
    const floor = Math.floor(limit * 0.62);
    const window = remaining.slice(0, limit + 1);
    let cut = -1;
    for (const pattern of [/\n\s*\n/g, /[。！？!?；;]\s*/g, /[，,、：:]\s*/g]) {
      pattern.lastIndex = floor;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(window))) cut = Math.max(cut, match.index + match[0].length);
    }
    if (cut < floor) cut = limit;
    const chunk = remaining.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

/**
 * Whole-file ASR and diarization providers may return a multi-hour transcript
 * as one segment. Treating that segment as atomic defeats the long-meeting
 * pipeline, so create internal virtual segments while retaining interpolated
 * time ranges. These boundaries never appear in the final note.
 */
export function expandOversizedBriefingSegments(
  inputSegments: BriefingSegment[],
  targetChars: number,
): BriefingSegment[] {
  const limit = Math.max(4_000, Math.floor(Number(targetChars) || 24_000));
  const expanded: BriefingSegment[] = [];
  for (const source of Array.isArray(inputSegments) ? inputSegments : []) {
    const text = cleanText(source?.text);
    if (!text) continue;
    const pieces = text.length > limit * 1.15
      ? splitBriefingTextAtBoundaries(text, limit)
      : [text];
    const start = finiteNonNegative(source?.startOffsetMs);
    const end = Math.max(start, finiteNonNegative(source?.endOffsetMs));
    let consumedChars = 0;
    for (const piece of pieces) {
      const pieceStartRatio = text.length ? consumedChars / text.length : 0;
      consumedChars += piece.length;
      const pieceEndRatio = text.length ? Math.min(1, consumedChars / text.length) : 1;
      const startOffsetMs = source.utteranceId
        ? start
        : Math.round(start + (end - start) * pieceStartRatio);
      const endOffsetMs = source.utteranceId
        ? end
        : Math.round(start + (end - start) * pieceEndRatio);
      expanded.push({
        ...source,
        index: expanded.length,
        startOffsetMs,
        endOffsetMs,
        text: piece,
      });
    }
  }
  return expanded;
}

export function planBriefingParts(
  inputSegments: BriefingSegment[],
  targetChars = 24000,
): BriefingPartPlan[] {
  const limit = Math.max(4000, Math.floor(Number(targetChars) || 24000));
  const segments = expandOversizedBriefingSegments(inputSegments, limit);
  if (!segments.length) return [];
  const totalChars = segments.reduce((sum, segment) => sum + cleanText(segment.text).length, 0);
  const desiredPartCount = Math.max(1, Math.ceil(totalChars / limit));
  const balancedTarget = Math.max(1, Math.ceil(totalChars / desiredPartCount));
  const groups: BriefingSegment[][] = [];
  let current: BriefingSegment[] = [];
  let chars = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const nextChars = cleanText(segment.text).length;
    const segmentsRemaining = segments.length - segmentIndex;
    const groupsNeededAfterCurrent = desiredPartCount - groups.length - 1;
    const canStartAnotherGroup = groupsNeededAfterCurrent > 0 && segmentsRemaining >= groupsNeededAfterCurrent;
    const wouldPassBalancedTarget = chars + nextChars > balancedTarget;
    const currentIsSubstantial = chars >= balancedTarget * 0.55;
    if (current.length && canStartAnotherGroup && wouldPassBalancedTarget && currentIsSubstantial) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += nextChars;
  }
  if (current.length) groups.push(current);
  return groups.map((group, index) => {
    const first = group[0];
    const last = group[group.length - 1];
    const segmentStart = Number.isFinite(Number(first.index)) ? Number(first.index) : segments.indexOf(first);
    const segmentEnd = Number.isFinite(Number(last.index)) ? Number(last.index) : segments.indexOf(last);
    return {
      index,
      segments: group,
      segmentStart: Math.max(0, segmentStart),
      segmentEnd: Math.max(0, segmentEnd),
      startOffsetMs: finiteNonNegative(first.startOffsetMs),
      endOffsetMs: Math.max(finiteNonNegative(first.startOffsetMs), finiteNonNegative(last.endOffsetMs)),
      sourceHash: getBriefingSourceHash(group),
      chars: group.reduce((sum, segment) => sum + cleanText(segment.text).length, 0),
    };
  });
}

export function getBriefingPartTargetChars(input: {
  mode?: string;
  detailLevel?: string;
  structureLevel?: string;
} = {}): number {
  return getBriefingFidelityPolicy(input).sourceTargetChars;
}

export function getBriefingFidelityPolicy(input: {
  mode?: string;
  detailLevel?: string;
  structureLevel?: string;
} = {}): BriefingFidelityPolicy {
  const detailLevel = cleanText(input.detailLevel).toLowerCase();
  const isSynthesis = cleanText(input.mode).toLowerCase() === "synthesis";
  if (cleanText(input.mode).toLowerCase() === "general") {
    const structureLevel = cleanText(input.structureLevel).toLowerCase();
    const profile = detailLevel === "detailed" || detailLevel === "concise" ? detailLevel : "balanced";
    return {
      profile,
      sourceTargetChars: profile === "concise" ? 28_000 : (profile === "detailed" ? 16_000 : (structureLevel === "strict" ? 18_000 : 22_000)),
      minimumOutputRatio: 0,
      targetOutputRatio: profile === "concise" ? 0.18 : (profile === "detailed" ? 0.42 : 0.30),
      absoluteMinimumChars: 0,
      enforceLengthFloor: false,
    };
  }
  if (isSynthesis) {
    if (detailLevel === "detailed") {
      return {
        profile: "detailed",
        sourceTargetChars: 16_000,
        minimumOutputRatio: 0,
        targetOutputRatio: 0.42,
        absoluteMinimumChars: 0,
        enforceLengthFloor: false,
      };
    }
    if (detailLevel === "concise") {
      return {
        profile: "concise",
        sourceTargetChars: 28_000,
        minimumOutputRatio: 0,
        targetOutputRatio: 0.18,
        absoluteMinimumChars: 0,
        enforceLengthFloor: false,
      };
    }
    const structureLevel = cleanText(input.structureLevel).toLowerCase();
    return {
      profile: "balanced",
      sourceTargetChars: structureLevel === "strict" ? 18_000 : 22_000,
      minimumOutputRatio: 0,
      targetOutputRatio: 0.30,
      absoluteMinimumChars: 0,
      enforceLengthFloor: false,
    };
  }
  if (detailLevel === "detailed") {
    return {
      profile: "detailed",
      sourceTargetChars: 14_000,
      minimumOutputRatio: 0.48,
      targetOutputRatio: 0.62,
      absoluteMinimumChars: 1_600,
      enforceLengthFloor: true,
    };
  }
  if (detailLevel === "concise") {
    return {
      profile: "concise",
      sourceTargetChars: 28_000,
      minimumOutputRatio: 0.15,
      targetOutputRatio: 0.22,
      absoluteMinimumChars: 700,
      enforceLengthFloor: true,
    };
  }
  const structureLevel = cleanText(input.structureLevel).toLowerCase();
  return {
    profile: "balanced",
    sourceTargetChars: structureLevel === "strict" ? 18_000 : 20_000,
    minimumOutputRatio: 0.30,
    targetOutputRatio: 0.42,
    absoluteMinimumChars: 1_000,
    enforceLengthFloor: true,
  };
}

export function assessBriefingPartFidelity(
  sourceChars: unknown,
  output: unknown,
  input: { mode?: string; detailLevel?: string; structureLevel?: string } = {},
): BriefingFidelityAssessment {
  const source = Math.max(0, Math.floor(Number(sourceChars) || 0));
  const outputChars = cleanText(output).length;
  const policy = getBriefingFidelityPolicy(input);
  if (!source) {
    return {
      sourceChars: 0,
      outputChars,
      outputRatio: 0,
      minimumOutputChars: 0,
      targetOutputChars: 0,
      needsExpansion: false,
    };
  }
  const sourceSafeCeiling = Math.max(1, Math.ceil(source * 0.92));
  const minimumOutputChars = policy.enforceLengthFloor
    ? Math.min(
      sourceSafeCeiling,
      Math.max(policy.absoluteMinimumChars, Math.ceil(source * policy.minimumOutputRatio)),
    )
    : 0;
  const targetOutputChars = Math.min(
    Math.max(minimumOutputChars, Math.ceil(source * policy.targetOutputRatio)),
    Math.max(minimumOutputChars, Math.ceil(source * 0.96)),
  );
  return {
    sourceChars: source,
    outputChars,
    outputRatio: outputChars / source,
    minimumOutputChars,
    targetOutputChars,
    needsExpansion: policy.enforceLengthFloor && outputChars < minimumOutputChars,
  };
}

function normalizeGroundingAnchor(value: unknown): string {
  return cleanText(value).toLocaleLowerCase().replace(/[\s`*_~，。！？、；：,.!?;:'"“”‘’（）()\u005b\u005d【】<>《》]/g, "");
}

export function extractBriefingGroundingAnchors(source: unknown): string[] {
  const text = cleanText(source)
    .replace(/^===SEG[^\n]*$/gmi, "")
    .replace(/^TIME\s*:[^\n]*$/gmi, "");
  if (!text) return [];
  const candidates: string[] = [];
  for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9._/+:-]{2,40}\b/g)) candidates.push(match[0]);
  for (const match of text.matchAll(/(?:\d+(?:\.\d+)?\s*(?:%|％|万|亿|元|人|个|次|天|周|月|年|分钟|小时|GB|MB|K|M)|\b\d{2,}(?:\.\d+)?\b)/gi)) candidates.push(match[0]);
  for (const match of text.matchAll(/[“「『"]([^”」』"\n]{2,28})[”」』"]/g)) candidates.push(match[1]);
  const seen = new Set<string>();
  const anchors: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeGroundingAnchor(candidate);
    if (normalized.length < 2 || seen.has(normalized) || /^seg\d*$/i.test(normalized)) continue;
    seen.add(normalized);
    anchors.push(cleanText(candidate));
    if (anchors.length >= 80) break;
  }
  return anchors;
}

export function assessBriefingPartGrounding(source: unknown, output: unknown): BriefingGroundingAssessment {
  const anchors = extractBriefingGroundingAnchors(source);
  const normalizedOutput = normalizeGroundingAnchor(output);
  const missingAnchors = anchors.filter((anchor) => !normalizedOutput.includes(normalizeGroundingAnchor(anchor)));
  const matchedAnchors = anchors.length - missingAnchors.length;
  const ratio = anchors.length ? matchedAnchors / anchors.length : 1;
  return {
    anchors,
    missingAnchors,
    matchedAnchors,
    ratio,
    needsRepair: anchors.length >= 4 && ratio < 0.35,
  };
}

export function shouldAutoRepairBriefingPart(
  fidelity: Pick<BriefingFidelityAssessment, "needsExpansion"> | null | undefined,
): boolean {
  // Exact anchor matching is useful diagnostics, but it is too brittle to justify
  // another paid rewrite. Automatic repair is reserved for a deterministic length gap.
  return fidelity?.needsExpansion === true;
}

function briefingCoverageBigrams(value: unknown): Set<string> {
  const runs = cleanText(value).normalize("NFKC").toLowerCase().match(/[\p{Script=Han}\p{Script=Latin}]+/gu) || [];
  const bigrams = new Set<string>();
  for (const run of runs) {
    const chars = Array.from(run);
    for (let index = 0; index + 1 < chars.length; index += 1) {
      bigrams.add(chars[index] + chars[index + 1]);
    }
  }
  return bigrams;
}

const BRIEFING_COVERAGE_CHINESE_NUMERALS = String.fromCharCode(
  0x96f6, 0x3007, 0x4e00, 0x4e8c, 0x4e24, 0x4e09, 0x56db, 0x4e94, 0x516d, 0x4e03,
  0x516b, 0x4e5d, 0x5341, 0x767e, 0x5343, 0x4e07, 0x4ebf,
);
const BRIEFING_COVERAGE_CHINESE_NUMBER = `[${BRIEFING_COVERAGE_CHINESE_NUMERALS}]+(?:${String.fromCharCode(0x70b9)}[${BRIEFING_COVERAGE_CHINESE_NUMERALS}]+)?`;
const BRIEFING_COVERAGE_CHINESE_UNITS = [
  [0x6210], [0x5468], [0x661f, 0x671f], [0x5929], [0x65e5], [0x4e2a, 0x6708], [0x6708],
  [0x5e74], [0x6b65], [0x4eba], [0x4e2a], [0x6b21], [0x4efd], [0x9875], [0x5143], [0x5bb6],
  [0x5c0f, 0x65f6], [0x5206, 0x949f],
].map((unit) => String.fromCharCode(...unit)).join("|");
const BRIEFING_COVERAGE_CHINESE_PERCENT = String.fromCharCode(0x767e, 0x5206, 0x4e4b);
const BRIEFING_COVERAGE_CHINESE_WEEK = String.fromCharCode(0x5468);
const BRIEFING_COVERAGE_CHINESE_WEEKDAY = String.fromCharCode(0x661f, 0x671f);
const BRIEFING_COVERAGE_FULLWIDTH_PERCENT = String.fromCharCode(0xff05);
const BRIEFING_COVERAGE_CHINESE_NUMERIC_PATTERNS = [
  /\d+(?:[.,]\d+)*(?:\s*[%％])?/g,
  new RegExp(`${BRIEFING_COVERAGE_CHINESE_PERCENT}${BRIEFING_COVERAGE_CHINESE_NUMBER}`, "g"),
  new RegExp(`${BRIEFING_COVERAGE_CHINESE_NUMBER}(?:${BRIEFING_COVERAGE_CHINESE_UNITS}|%|${BRIEFING_COVERAGE_FULLWIDTH_PERCENT})`, "g"),
  new RegExp(`(?:${BRIEFING_COVERAGE_CHINESE_WEEK}|${BRIEFING_COVERAGE_CHINESE_WEEKDAY})[${BRIEFING_COVERAGE_CHINESE_NUMERALS}]`, "g"),
];

function extractBriefingCoverageNumericAnchors(value: string): string[] {
  const matches: string[] = [];
  for (const pattern of BRIEFING_COVERAGE_CHINESE_NUMERIC_PATTERNS) {
    for (const match of value.matchAll(pattern)) matches.push(match[0]);
  }
  return [...new Set(matches)];
}

const BRIEFING_COVERAGE_CAPITALIZED_STOP_WORDS = new Set([
  "After", "Also", "And", "Before", "Because", "But", "First", "For", "Friday", "From", "How", "Into", "It",
  "Monday", "Next", "Our", "Please", "Saturday", "Second", "Sunday", "That", "The", "Then", "These",
  "This", "Those", "Thursday", "Today", "Tomorrow", "Tuesday", "Wednesday", "When", "Where", "Which",
  "Who", "Why", "We", "With",
]);

function extractBriefingCoverageNameAnchors(source: string, knownPeople: readonly string[]): string[] {
  const sourceLower = source.toLowerCase();
  const anchors = knownPeople.filter((name) => name.length >= 2 && sourceLower.includes(name.toLowerCase()));
  for (const match of source.matchAll(/\b(?:[A-Z]{2,}(?:[-_][A-Z0-9]+)*|[A-Z][a-z]{2,}[A-Za-z0-9]*)\b/g)) {
    if (BRIEFING_COVERAGE_CAPITALIZED_STOP_WORDS.has(match[0])) continue;
    if (anchors.some((name) => name.toLowerCase().includes(match[0].toLowerCase()))) continue;
    anchors.push(match[0]);
  }
  return [...new Set(anchors)];
}

export function assessBriefingSegmentCoverage(
  sourceSegments: readonly BriefingSegment[],
  output: unknown,
  knownPeople: readonly string[] = [],
): BriefingSegmentCoverageAssessment {
  const outputText = cleanText(output).normalize("NFKC").toLowerCase();
  const outputBigrams = briefingCoverageBigrams(outputText);
  const rows = sourceSegments.map((segment, index) => {
    const source = cleanText(segment?.text);
    const sourceBigrams = briefingCoverageBigrams(source);
    const namedAnchors = extractBriefingCoverageNameAnchors(source, [
      ...knownPeople,
      cleanText(segment?.speakerName),
    ]);
    const matchedNameAnchors = namedAnchors.filter((anchor) => outputText.includes(anchor.normalize("NFKC").toLowerCase())).length;
    let matchedBigrams = 0;
    for (const bigram of sourceBigrams) if (outputBigrams.has(bigram)) matchedBigrams += 1;
    return {
      segmentNumber: index + 1,
      bigramOverlap: sourceBigrams.size ? matchedBigrams / sourceBigrams.size : 0,
      bigramCount: sourceBigrams.size,
      matchedNameAnchors,
      nameAnchorCount: namedAnchors.length,
      numericAnchorCount: extractBriefingCoverageNumericAnchors(source).length,
      eligible: sourceBigrams.size >= 8 || namedAnchors.length > 0,
      missing: false,
    };
  });
  const eligible = rows.filter((row) => row.eligible);
  const missingSegments: number[] = [];
  for (const row of eligible) {
    const peerScores = eligible
      .filter((peer) => peer.segmentNumber !== row.segmentNumber)
      .map((peer) => peer.bigramOverlap)
      .sort((left, right) => left - right);
    const peerMedian = peerScores.length
      ? peerScores[Math.floor(peerScores.length / 2)]
      : 0;
    const absoluteGap = row.bigramCount >= 8 && row.bigramOverlap < 0.12;
    const relativeGap = row.bigramCount >= 8
      && peerMedian >= 0.18
      && row.bigramOverlap <= peerMedian * 0.35
      && peerMedian - row.bigramOverlap >= 0.12;
    const allNamesMissing = row.nameAnchorCount > 0 && row.matchedNameAnchors === 0;
    row.missing = absoluteGap || relativeGap || allNamesMissing;
    if (row.missing) missingSegments.push(row.segmentNumber);
  }
  return { missingSegments, segments: rows };
}

function createPartCheckpoint(plan: BriefingPartPlan): BriefingPartCheckpoint {
  return {
    index: plan.index,
    segmentStart: plan.segmentStart,
    segmentEnd: plan.segmentEnd,
    startOffsetMs: plan.startOffsetMs,
    endOffsetMs: plan.endOffsetMs,
    sourceHash: plan.sourceHash,
    status: "pending",
    text: "",
    summary: "",
    people: [],
    tags: [],
    sedimentObjects: null,
    knowledge: null,
    finishReason: "",
    attempts: 0,
    usage: { ...EMPTY_BRIEFING_USAGE },
    error: "",
    sourceChars: plan.chars,
    outputChars: 0,
    outputRatio: 0,
    minimumOutputChars: 0,
    targetOutputChars: 0,
    qualityStatus: "pending",
    repairAttempts: 0,
    updatedAt: new Date().toISOString(),
  };
}

export function createBriefingCheckpoint(input: {
  id: string;
  sourceHash: string;
  optionsHash: string;
  mode: string;
  model: string;
  parts: BriefingPartPlan[];
}): BriefingCheckpoint {
  const now = new Date().toISOString();
  return {
    version: BRIEFING_PIPELINE_VERSION,
    id: cleanText(input.id),
    sourceHash: cleanText(input.sourceHash),
    optionsHash: cleanText(input.optionsHash),
    mode: cleanText(input.mode),
    model: cleanText(input.model),
    status: "running",
    topicMap: "",
    topicMapSource: "",
    assembledKnowledge: null,
    topicMapFinishReason: "",
    topicMapUsage: { ...EMPTY_BRIEFING_USAGE },
    consolidationStatus: "pending",
    consolidationBody: "",
    consolidationFinishReason: "",
    consolidationUsage: { ...EMPTY_BRIEFING_USAGE },
    consolidationAttempts: 0,
    consolidationError: "",
    coverageRepairAttempted: false,
    auditStatus: "pending",
    auditText: "",
    auditFinishReason: "",
    auditUsage: { ...EMPTY_BRIEFING_USAGE },
    parts: input.parts.map(createPartCheckpoint),
    assembledBody: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function reconcileBriefingCheckpoint(
  checkpoint: BriefingCheckpoint | null,
  input: Parameters<typeof createBriefingCheckpoint>[0],
): BriefingCheckpoint {
  if (!checkpoint
    || checkpoint.version !== BRIEFING_PIPELINE_VERSION
    || checkpoint.id !== input.id
    || checkpoint.sourceHash !== input.sourceHash
    || checkpoint.optionsHash !== input.optionsHash) {
    return createBriefingCheckpoint(input);
  }
  const byIndex = new Map(checkpoint.parts.map((part) => [part.index, part]));
  checkpoint.parts = input.parts.map((plan) => {
    const previous = byIndex.get(plan.index);
    if (!previous || previous.sourceHash !== plan.sourceHash) return createPartCheckpoint(plan);
    if (previous.status === "running") {
      return { ...previous, status: "pending", error: "上次运行中断，等待恢复" };
    }
    return previous;
  });
  if (checkpoint.consolidationStatus === "running") {
    checkpoint.consolidationStatus = "pending";
    checkpoint.consolidationError = "上次全局成文中断，等待恢复";
  }
  checkpoint.updatedAt = new Date().toISOString();
  return checkpoint;
}

export function buildProgrammaticTopicMap(parts: BriefingPartPlan[], formatElapsed: (ms: number) => string): string {
  const lines = ["## 全程议题索引"];
  for (const part of parts) {
    const firstText = cleanText(part.segments[0]?.text).replace(/\s+/g, " ");
    const preview = firstText.length > 90 ? `${firstText.slice(0, 90)}…` : firstText;
    lines.push(`- ${formatElapsed(part.startOffsetMs)}–${formatElapsed(part.endOffsetMs)}：${preview || "本时段转写内容"}`);
  }
  return lines.join("\n");
}

export function buildBriefingPartSummaryMap(
  parts: BriefingPartCheckpoint[],
  formatElapsed: (ms: number) => string,
): string {
  const lines = ["## 全程议题索引"];
  for (const part of [...parts].sort((left, right) => left.index - right.index)) {
    const headings = Array.from(cleanText(part.text).matchAll(/^#{2,4}\s+(.+)$/gm))
      .map((match) => cleanText(match[1]))
      .filter(Boolean)
      .slice(0, 5);
    const details = Array.from(new Set([cleanText(part.summary), ...headings].filter(Boolean)));
    lines.push(`- ${formatElapsed(part.startOffsetMs)}–${formatElapsed(part.endOffsetMs)}：${details.join("；") || "本时段已整理"}`);
  }
  return lines.join("\n");
}

export function assembleBriefingParts(parts: BriefingPartCheckpoint[]): string {
  const ordered = [...parts].sort((left, right) => left.index - right.index);
  const incomplete = ordered.filter((part) => part.status !== "complete" || !cleanText(part.text));
  if (incomplete.length) {
    throw new BriefingPipelineIncompleteError(
      t("The minutes are partially complete: {0}/{1} parts completed").replace("{0}", String(ordered.length - incomplete.length)).replace("{1}", String(ordered.length)),
      ordered.length - incomplete.length,
      ordered.length,
      incomplete.map((part) => part.index),
    );
  }
  const fragmentMode = ordered.length > 1;
  return ordered
    .map((part) => normalizeBriefingPartBody(part.text, { fragmentMode }))
    .filter(Boolean)
    .join("\n\n");
}

export type BriefingPartEnvelope = {
  body: string;
  summary: string;
};

function extractCalloutBlock(value: string, kindPattern: string): { block: string; content: string } | null {
  const lines = value.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s*>\\s*\\[!(?:${kindPattern})\\]`, "i").test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && /^\s*>/.test(lines[end])) end += 1;
  const blockLines = lines.slice(start, end);
  const content = blockLines
    .slice(1)
    .map((line) => line.replace(/^\s*>\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
  return { block: blockLines.join("\n"), content };
}

function stripLeakedBriefingMarkers(value: string): string {
  return value
    .replace(NS_PART_SUMMARY_LINE_RE, "")
    .replace(NS_PART_ENTITY_LINE_RE, "");
}

/** Extract the internal part protocol while tolerating weak-model variants. */
export function extractBriefingPartEnvelope(value: unknown): BriefingPartEnvelope {
  const raw = cleanText(value);
  if (!raw) return { body: "", summary: "" };

  const bodyMatch = raw.match(NS_PART_BODY_RE);
  const summaryMatch = raw.match(NS_PART_SUMMARY_RE);
  let summary = cleanText(summaryMatch?.[1]);
  if (!summary) {
    const lines = raw.split(/\r?\n/);
    const markerIndex = lines.findIndex((line) => NS_PART_SUMMARY_ONLY_RE.test(line));
    if (markerIndex >= 0) {
      const inline = lines[markerIndex].replace(NS_PART_SUMMARY_STRIP_RE, "").trim();
      if (inline) {
        summary = inline;
      } else {
        const following: string[] = [];
        for (let index = markerIndex + 1; index < lines.length; index += 1) {
          const line = lines[index];
          if (/^\s*#{1,6}\s+/.test(line)) break;
          if (!/^\s*>/.test(line) && line.trim()) break;
          const content = line.replace(/^\s*>\s?/, "").trim();
          if (content) following.push(content);
        }
        summary = cleanText(following.join(" "));
      }
    }
  }
  const abstract = extractCalloutBlock(raw, "abstract|summary");
  if (!summary && abstract?.content) summary = abstract.content;

  let body = bodyMatch ? bodyMatch[1] : raw;
  body = stripLeakedBriefingMarkers(body)
    .replace(/<!--\s*qnalog-part-(?:body-start|body-end)\s*-->/gi, "")
    .replace(NS_PART_SUMMARY_BLOCK_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { body, summary };
}

/**
 * Long briefings are processed in internal time windows, but those windows must
 * never become visible document boundaries. Older checkpoints and occasional
 * model responses may still contain a generated "part N" heading, so remove
 * only that implementation-specific wrapper before deterministic assembly.
 */
export function normalizeBriefingPartBody(
  value: unknown,
  options: { fragmentMode?: boolean } = {},
): string {
  let normalized = stripLeakedBriefingMarkers(cleanText(value))
    .replace(/<!--\s*qnalog-part-(?:body-start|body-end)\s*-->/gi, "")
    .replace(NS_PART_SUMMARY_BLOCK_RE, "")
    .replace(
      // 中文分支保持既有宽容写法（含 分部/时段 变体与无空格「第1部分」）；
      // 英文分支与 note-labels 的 PART_HEADING_RE 英文侧一致（Part N / Part N/M）。
      /^\s*#{1,6}\s*(?:第\s*\d+\s*(?:\/\s*\d+\s*)?(?:部分|分部|时段)|Part\s+\d+(?:\s*\/\s*\d+)?|(?:内部)?(?:时间窗口|转写窗口|分段)\s*\d+)(?:\s*[·:：—-]\s*[^\n]*)?\s*\n+/gim,
      "",
    )
    .trim();

  if (options.fragmentMode) {
    normalized = normalized.replace(/^\s*#\s+[^\n]+\n+/gm, "").trim();
    const leadingCallout = extractCalloutBlock(normalized, "abstract|summary");
    if (leadingCallout && normalized.indexOf(leadingCallout.block) < 8) {
      normalized = normalized.replace(leadingCallout.block, "").trim();
    }
    normalized = normalized
      .replace(/^(\s*#{2,3}\s+)(?:[一二三四五六七八九十百]+|\d+)[、.．]\s*/gm, "$1")
      .replace(/^\s*---\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return normalized;
}

export class BriefingPipelineIncompleteError extends Error {
  readonly completedParts: number;
  readonly totalParts: number;
  readonly failedPartIndexes: number[];

  constructor(message: string, completedParts: number, totalParts: number, failedPartIndexes: number[]) {
    super(message);
    this.name = "BriefingPipelineIncompleteError";
    this.completedParts = completedParts;
    this.totalParts = totalParts;
    this.failedPartIndexes = failedPartIndexes;
  }
}
