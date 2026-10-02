import { iterateNoteDetailsBlocks, type NoteDetailsBlockRange } from "./note-document";
import { labelPattern } from "../shared/note-labels";
import { nsMarker, nsRe } from "../shared/namespace";
import type { RealtimeOutlineSourceCoverage } from "../shared/types";

const OUTLINE_INTRO_LINE_RE = new RegExp(`^>\\s*(?:${labelPattern("outlineIntroPrefix").source})[^\\n]*\\n?`, "m");
const COVERAGE_LINE_RE = new RegExp(`^[ \\t]*>\\s*(?:${labelPattern("outlineCoverage").source}|${labelPattern("outlineCoverageCurrentRecording").source}|${labelPattern("outlineCoverageWholeNote").source})[^\\n]*\\n?`, "m");
const COVERAGE_META_RE = new RegExp(`<!--\\s*${nsRe("realtime-outline-source-coverage")}\\s*:\\s*([\\s\\S]*?)\\s*-->`, "i");

export interface CurrentOutlineBlock {
  range: NoteDetailsBlockRange;
  body: string;
  outline: string;
  sourceCoverage: RealtimeOutlineSourceCoverage | null;
}

function outlineSummaryMatches(markdown: string, range: NoteDetailsBlockRange): boolean {
  const summary = markdown.slice(range.summaryStart, range.summaryEnd).replace(/<[^>]*>/g, "").trim();
  return labelPattern("liveOutlineDraft").test(summary);
}

function parseSourceCoverage(body: string): RealtimeOutlineSourceCoverage | null {
  const match = body.match(COVERAGE_META_RE);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (!value || typeof value !== "object") return null;
    const proof = value as Partial<RealtimeOutlineSourceCoverage>;
    if (proof.version !== 1 || typeof proof.outlineHash !== "string" || typeof proof.sourceHash !== "string"
      || !Number.isInteger(proof.committedSegmentCount) || !Number.isInteger(proof.totalSegmentCount)) return null;
    return proof as RealtimeOutlineSourceCoverage;
  } catch {
    return null;
  }
}

export function stripCurrentOutlineMetadata(body: string): string {
  return body
    .replace(OUTLINE_INTRO_LINE_RE, "")
    .replace(COVERAGE_LINE_RE, "")
    .replace(COVERAGE_META_RE, "")
    .trim();
}

/** Reads the last matching outline details; an empty last block intentionally wins over older blocks. */
export function readCurrentOutlineBlock(markdown: string): CurrentOutlineBlock | null {
  const text = String(markdown || "");
  let current: NoteDetailsBlockRange | null = null;
  for (const range of iterateNoteDetailsBlocks(text)) {
    if (outlineSummaryMatches(text, range)) current = range;
  }
  if (!current) return null;
  const body = text.slice(current.bodyStart, current.bodyEnd).trim();
  return {
    range: current,
    body,
    outline: stripCurrentOutlineMetadata(body),
    sourceCoverage: parseSourceCoverage(body),
  };
}

export function buildOutlineCoverageMetadata(coverage: RealtimeOutlineSourceCoverage): string {
  return nsMarker("realtime-outline-source-coverage", JSON.stringify(coverage));
}
