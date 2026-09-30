import type { Segment } from "../shared/types";
import { getCurrentTranscript, type TranscriptSegmentRecord } from "./session-transcript";
import type { TranscriptAudioRef, TranscriptTiming } from "./session-transcript";

function finiteNonNegative(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Rebind source units to a retained session recording without changing unit identities. */
export function bindTranscriptSegmentToAudio(segment: Segment, path: string, name: string): Segment {
  const record = segment.transcript;
  const targetPath = String(path || "");
  if (!record || !targetPath) return segment;
  const current = getCurrentTranscript(record);
  const offset = record.sourcePath === targetPath ? 0 : finiteNonNegative(segment.audioStartOffsetMs) || 0;
  const coarseStart = finiteNonNegative(segment.audioStartOffsetMs);
  const coarseEnd = finiteNonNegative(segment.audioEndOffsetMs);
  let changed = record.sourcePath !== targetPath || record.sourceName !== name;
  const utterances = current.utterances.map((utterance) => {
    let startMs = utterance.startMs;
    let endMs = utterance.endMs;
    let timing: TranscriptTiming = utterance.timing;
    if (startMs !== null && endMs !== null && offset > 0 && utterance.audioRef?.path !== targetPath) {
      startMs += offset;
      endMs += offset;
    } else if (timing === "unknown" && coarseStart !== null && coarseEnd !== null && coarseEnd >= coarseStart) {
      startMs = coarseStart;
      endMs = coarseEnd;
      timing = "segment";
    }
    const audioRef: TranscriptAudioRef = {
      path: targetPath,
      name,
      startMs,
      endMs,
      precision: timing,
    };
    if (utterance.startMs !== startMs || utterance.endMs !== endMs || utterance.timing !== timing
      || utterance.audioRef?.path !== audioRef.path || utterance.audioRef?.name !== audioRef.name
      || utterance.audioRef?.startMs !== audioRef.startMs || utterance.audioRef?.endMs !== audioRef.endMs
      || utterance.audioRef?.precision !== audioRef.precision) changed = true;
    return { ...utterance, startMs, endMs, timing, audioRef };
  });
  if (!changed) return segment;
  const updatedRevision = {
    ...current,
    normalizationRevision: current.normalizationRevision + 1,
    utterances,
  };
  const updatedRecord: TranscriptSegmentRecord = {
    ...record,
    sourcePath: targetPath,
    sourceName: name,
    revisions: record.revisions.map((revision) => revision.revision === current.revision ? updatedRevision : revision),
  };
  return { ...segment, audioPath: targetPath, audioName: name, transcript: updatedRecord };
}
