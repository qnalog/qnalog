import type { RealtimeOutlineSourceCoverage, Segment } from "../shared/types";
import { getCurrentTranscript } from "../transcript/session-transcript";
import { stableHash } from "../shared/stable-hash";

function nullableFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Hashes the exact ordered transcript material used by outline generation, excluding merged-note clocks/indexes. */
export function hashOutlineSourceMaterial(segments: readonly Segment[]): string {
  return stableHash(JSON.stringify(segments.map((segment) => {
    let revision: number | null = null;
    let normalizationRevision: number | null = null;
    if (segment.transcript) {
      try {
        const current = getCurrentTranscript(segment.transcript);
        revision = current.revision;
        normalizationRevision = current.normalizationRevision;
      } catch {
        revision = segment.transcript.currentRevision;
      }
    }
    return {
      transcriptId: segment.transcript?.id || "",
      transcriptSourceId: segment.transcript?.sourceId || "",
      revision,
      normalizationRevision,
      text: String(segment.text || ""),
      audioPath: String(segment.audioPath || segment.segmentAudioPath || segment.sourcePath || segment.transcript?.sourcePath || ""),
      audioName: String(segment.audioName || segment.segmentAudioName || segment.sourceName || segment.transcript?.sourceName || ""),
      audioStartOffsetMs: nullableFinite(segment.audioStartOffsetMs),
      audioEndOffsetMs: nullableFinite(segment.audioEndOffsetMs),
      error: segment.error == null ? null : String(segment.error),
    };
  })));
}
function hasValidSourceRevisions(segments: readonly Segment[]): boolean {
  return segments.every((segment) => {
    if (!segment.transcript || !segment.transcript.id || !segment.transcript.sourceId) return false;
    try {
      const revision = getCurrentTranscript(segment.transcript);
      return Number.isInteger(revision.revision) && revision.revision >= 0
        && Number.isInteger(revision.normalizationRevision) && revision.normalizationRevision >= 0;
    } catch {
      return false;
    }
  });
}


export function createRealtimeOutlineSourceCoverage(
  outline: string,
  segments: readonly Segment[],
  committedSegmentCount: number,
): RealtimeOutlineSourceCoverage {
  return {
    version: 1,
    outlineHash: stableHash(String(outline || "").trim()),
    sourceHash: hashOutlineSourceMaterial(segments.slice(0, Math.max(0, Math.min(segments.length, Math.floor(committedSegmentCount))))),
    committedSegmentCount: Math.max(0, Math.min(segments.length, Math.floor(committedSegmentCount))),
    totalSegmentCount: segments.length,
  };
}

export function validateRealtimeOutlineSourceCoverage(
  coverage: unknown,
  outline: string,
  segments: readonly Segment[],
): coverage is RealtimeOutlineSourceCoverage {
  if (!coverage || typeof coverage !== "object") return false;
  const proof = coverage as Partial<RealtimeOutlineSourceCoverage>;
  if (proof.version !== 1 || typeof proof.outlineHash !== "string" || typeof proof.sourceHash !== "string"
    || typeof proof.committedSegmentCount !== "number" || !Number.isInteger(proof.committedSegmentCount)
    || typeof proof.totalSegmentCount !== "number" || !Number.isInteger(proof.totalSegmentCount)) return false;
  const committed = proof.committedSegmentCount;
  if (committed < 0 || proof.totalSegmentCount !== segments.length || committed > segments.length) return false;
  const prefix = segments.slice(0, committed);
  if (!hasValidSourceRevisions(prefix)) return false;
  return proof.outlineHash === stableHash(String(outline || "").trim())
    && proof.sourceHash === hashOutlineSourceMaterial(prefix);
}

export function getValidatedOutlineCommittedCount(
  coverage: unknown,
  outline: string,
  segments: readonly Segment[],
): number {
  return validateRealtimeOutlineSourceCoverage(coverage, outline, segments)
    ? coverage.committedSegmentCount
    : 0;
}

/** Extends an already-proven live prefix when new segments are appended to the same session. */
export function rebaseRealtimeOutlineSourceCoverage(
  coverage: unknown,
  outline: string,
  segments: readonly Segment[],
): RealtimeOutlineSourceCoverage | null {
  if (!coverage || typeof coverage !== "object") return null;
  const proof = coverage as Partial<RealtimeOutlineSourceCoverage>;
  if (proof.version !== 1 || proof.outlineHash !== stableHash(String(outline || "").trim())
    || typeof proof.sourceHash !== "string"
    || typeof proof.committedSegmentCount !== "number" || !Number.isInteger(proof.committedSegmentCount)
    || typeof proof.totalSegmentCount !== "number" || !Number.isInteger(proof.totalSegmentCount)) return null;
  const committed = proof.committedSegmentCount;
  const previousTotal = proof.totalSegmentCount;
  if (committed < 0 || previousTotal < committed || previousTotal > segments.length) return null;
  const prefix = segments.slice(0, committed);
  if (!hasValidSourceRevisions(prefix) || proof.sourceHash !== hashOutlineSourceMaterial(prefix)) return null;
  return {
    version: 1,
    outlineHash: proof.outlineHash,
    sourceHash: proof.sourceHash,
    committedSegmentCount: committed,
    totalSegmentCount: segments.length,
  };
}
