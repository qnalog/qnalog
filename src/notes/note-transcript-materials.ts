import type { Segment } from "../shared/types";
import { formatElapsed } from "../shared/util-common";
import { getTranscribeSegmentPlaceholder } from "../shared/util-audio";
import { nsMarker } from "../shared/namespace";
import { labelText } from "../shared/note-labels";
import type { TranscriptSegmentRecord } from "../transcript/session-transcript";
import { serializeTranscriptBlock } from "../transcript/transcript-markdown";

function buildSegmentHeading(segment: Segment, audioLink: string): string {
  return `### ${labelText("segment", segment.index + 1)} (${formatElapsed(segment.startOffsetMs)}–${formatElapsed(segment.endOffsetMs)}) ${audioLink}${segment.isFinal ? " · 结束" : ""}`;
}

function buildSegmentBody(segment: Segment): string {
  return segment.error
    ? getTranscribeSegmentPlaceholder(segment.error, { retryable: !!segment.queueTaskId })
    : (segment.text || labelText("noContentSegment"));
}

export function buildRewriteSegmentBlock(segment: Segment, audioLink: string): string {
  const heading = buildSegmentHeading(segment, audioLink);
  const taskMarker = segment.queueTaskId ? nsMarker("transcribe-task", segment.queueTaskId) : "";
  const body = buildSegmentBody(segment);
  const blockHeading = taskMarker ? `${heading}\n\n${taskMarker}` : heading;
  return segment.transcript
    ? serializeTranscriptBlock(segment, blockHeading, body)
    : `${heading}\n\n${taskMarker ? `${taskMarker}\n` : ""}${body}\n`;
}

export function serializeContinuationSegmentBlock(
  segment: Segment & { transcript: TranscriptSegmentRecord },
  audioLink: string,
): string {
  return serializeTranscriptBlock(segment, buildSegmentHeading(segment, audioLink), buildSegmentBody(segment));
}
