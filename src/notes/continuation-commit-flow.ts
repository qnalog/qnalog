import type { RecordingSession, Segment } from "../shared/types";
import { NS_CONTINUATION_COMMITTED_MARKER, nsMarker, nsMarkerAnyRe } from "../shared/namespace";
import { findFirstNoteBoundary } from "./note-document";
import { getCurrentTranscript, type TranscriptSegmentRecord } from "../transcript/session-transcript";
import { readTranscriptBlocks } from "../transcript/transcript-markdown";

export type ContinuationTranscriptSegment = Segment & { transcript: TranscriptSegmentRecord };

export interface ContinuationCommitFlowHost {
  readTarget(mdPath: string): Promise<string>;
  shouldRewrite(session: RecordingSession): boolean;
  serializeIncomingSegment(segment: ContinuationTranscriptSegment): string;
  rewrite(session: RecordingSession, polished: string, continuationSessionId: string): Promise<void>;
  append(session: RecordingSession, polished: string, continuationSessionId: string, initialMarkdown: string): Promise<void>;
}

function hasContinuationTranscript(segment: Segment, sessionId: string): segment is ContinuationTranscriptSegment {
  return segment.transcript?.sourceId === sessionId;
}

export async function commitContinuationFlow(
  host: ContinuationCommitFlowHost,
  session: RecordingSession,
  polished: string,
  committedSessionIds: readonly string[],
): Promise<void> {
  const current = await host.readTarget(session.mdPath);
  const blocks = readTranscriptBlocks(current);
  const incoming = session.segments.filter((segment) => hasContinuationTranscript(segment, session.id));
  const counts = new Map<string, number>();
  const existingById = new Map<string, typeof blocks[number]>();
  for (const block of blocks) {
    const id = block.segment.transcript?.id;
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
    existingById.set(id, block);
  }
  const incomingIds = new Set<string>();
  for (const segment of incoming) {
    const id = segment.transcript.id;
    if (incomingIds.has(id)) throw new Error(`Continuation contains duplicate transcript block ${id}`);
    incomingIds.add(id);
    const count = counts.get(id) || 0;
    if (count > 1) throw new Error(`Expected one transcript block for ${id}; found ${count}`);
    const existing = existingById.get(id);
    const incomingRevision = getCurrentTranscript(segment.transcript);
    const existingRevision = existing?.segment.transcript
      ? getCurrentTranscript(existing.segment.transcript)
      : null;
    if (existing && (existing.drifted
      || existing.segment.transcript?.sourceId !== segment.transcript.sourceId
      || existingRevision?.revision !== incomingRevision.revision
      || existingRevision?.normalizationRevision !== incomingRevision.normalizationRevision)) {
      throw new Error(`Transcript block drifted for ${id}`);
    }
  }
  const marker = nsMarker(NS_CONTINUATION_COMMITTED_MARKER, session.id);
  if (current.includes(marker)) {
    for (const segment of incoming) {
      if ((counts.get(segment.transcript.id) || 0) !== 1) {
        throw new Error(`Committed continuation is missing transcript block ${segment.transcript.id}`);
      }
    }
    return;
  }
  for (const id of committedSessionIds) {
    if (!current.includes(nsMarker(NS_CONTINUATION_COMMITTED_MARKER, id))) {
      throw new Error(`Previously committed continuation marker is missing for ${id}`);
    }
  }
  if (host.shouldRewrite(session)) {
    await host.rewrite(session, polished, session.id);
    return;
  }
  const freshBlocks: string[] = [];
  for (const segment of incoming) {
    if (existingById.has(segment.transcript.id)) continue;
    freshBlocks.push(host.serializeIncomingSegment(segment));
  }
  let withFreshBlocks = current;
  if (freshBlocks.length) {
    const markerAt = findFirstNoteBoundary(current, [nsMarkerAnyRe("segments-end")]);
    const insertionAt = markerAt < current.length
      ? markerAt
      : blocks.length ? blocks[blocks.length - 1].end : -1;
    if (insertionAt < 0) throw new Error("Continuation target has no transcript insertion marker");
    const insertion = `\n${freshBlocks.join("\n")}\n`;
    withFreshBlocks = current.slice(0, insertionAt) + insertion + current.slice(insertionAt);
  }
  await host.append(session, polished, session.id, withFreshBlocks);
}
