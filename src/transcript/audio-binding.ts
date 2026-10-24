import type { Segment } from "../shared/types";
import { getCurrentTranscript, withSourceIntegrity, type TranscriptAudioRef, type TranscriptSegmentRecord, type TranscriptTiming } from "./session-transcript";
import type { SourceIntegrity } from "./source-integrity";

function finiteNonNegative(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Rebind source units to a retained session recording without changing unit identities.
 * `integrity` 是该录音读回核对后的完整性记录；给出时写入记录，缺省时保留路径未变的已有记录。
 * 只有完整性记录变化时不增加 normalizationRevision，避免已有整理结果被判为过期。
 */
export function bindTranscriptSegmentToAudio(segment: Segment, path: string, name: string, integrity: SourceIntegrity | null = null): Segment {
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
  const nextIntegrity = integrity || (record.sourcePath === targetPath ? record.sourceIntegrity : undefined);
  if (!changed) {
    const withIntegrity = withSourceIntegrity(record, nextIntegrity);
    return withIntegrity === record ? segment : { ...segment, transcript: withIntegrity };
  }
  const updatedRevision = {
    ...current,
    normalizationRevision: current.normalizationRevision + 1,
    utterances,
  };
  const updatedRecord: TranscriptSegmentRecord = withSourceIntegrity({
    ...record,
    sourcePath: targetPath,
    sourceName: name,
    revisions: record.revisions.map((revision) => revision.revision === current.revision ? updatedRevision : revision),
  }, nextIntegrity);
  return { ...segment, audioPath: targetPath, audioName: name, transcript: updatedRecord };
}
