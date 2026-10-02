import type { Segment } from "../shared/types";

export interface NoteAudioInterval {
  sourcePath: string;
  sourceName: string;
  noteStartMs: number;
  noteEndMs: number;
  localStartMs: number;
  localEndMs: number;
}

export interface NoteAudioPosition {
  sourcePath: string;
  sourceName: string;
  localMs: number;
}

/** Build usable ledger intervals; entries missing either clock or a source stay indeterminate. */
export function buildNoteAudioTimeline(segments: readonly Segment[]): NoteAudioInterval[] {
  const intervals = segments.flatMap((segment): NoteAudioInterval[] => {
    const noteStartMs = segment.startOffsetMs;
    const noteEndMs = segment.endOffsetMs;
    const localStartMs = segment.audioStartOffsetMs;
    const localEndMs = segment.audioEndOffsetMs;
    const sourcePath = String(segment.audioPath || segment.sourcePath || "").trim();
    const sourceName = String(segment.audioName || segment.sourceName || "").trim();
    if (!sourcePath || typeof noteStartMs !== "number" || typeof noteEndMs !== "number"
      || typeof localStartMs !== "number" || typeof localEndMs !== "number"
      || !Number.isFinite(noteStartMs) || !Number.isFinite(noteEndMs)
      || !Number.isFinite(localStartMs) || !Number.isFinite(localEndMs)
      || noteEndMs <= noteStartMs || localEndMs <= localStartMs) return [];
    return [{ sourcePath, sourceName, noteStartMs, noteEndMs, localStartMs, localEndMs }];
  }).sort((a, b) => a.noteStartMs - b.noteStartMs || a.noteEndMs - b.noteEndMs);

  const merged: NoteAudioInterval[] = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && previous.sourcePath === interval.sourcePath
      && previous.noteEndMs === interval.noteStartMs
      && previous.localEndMs === interval.localStartMs) {
      previous.noteEndMs = interval.noteEndMs;
      previous.localEndMs = interval.localEndMs;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** Maps a position in a timeline produced by `buildNoteAudioTimeline` to source-local milliseconds. */
export function mapNoteTimeToAudio(timeline: readonly NoteAudioInterval[], globalMs: number): NoteAudioPosition | null {
  if (!Number.isFinite(globalMs) || timeline.length === 0) return null;
  const final = timeline[timeline.length - 1];
  if (globalMs === final.noteEndMs) {
    return { sourcePath: final.sourcePath, sourceName: final.sourceName, localMs: final.localEndMs };
  }
  let match: NoteAudioInterval | null = null;
  for (const interval of timeline) {
    if (globalMs < interval.noteStartMs || globalMs >= interval.noteEndMs) continue;
    if (match) return null;
    match = interval;
  }
  if (!match) return null;
  return {
    sourcePath: match.sourcePath,
    sourceName: match.sourceName,
    localMs: match.localStartMs + globalMs - match.noteStartMs,
  };
}

/** Maps source-local milliseconds to a unique note-global position, or null if unknown/ambiguous. */
export function mapAudioTimeToNote(timeline: readonly NoteAudioInterval[], sourcePath: string, localMs: number): number | null {
  if (!sourcePath || !Number.isFinite(localMs)) return null;
  let mapped: number | null = null;
  for (const interval of timeline) {
    if (interval.sourcePath !== sourcePath || localMs < interval.localStartMs || localMs >= interval.localEndMs) continue;
    const candidate = interval.noteStartMs + localMs - interval.localStartMs;
    if (mapped !== null && mapped !== candidate) return null;
    mapped = candidate;
  }
  return mapped;
}

