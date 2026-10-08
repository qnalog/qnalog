import type { RecordingSession, Segment } from "../shared/types";
import { isTextImportSession } from "../briefing/note-layout-policy";
import { attachTextTranscript } from "../transcript/session-transcript";
import { labelText } from "../shared/note-labels";
import { formatElapsed } from "../shared/util-common";
import { getTranscribeSegmentPlaceholder } from "../shared/util-audio";
import { nsMarker } from "../shared/namespace";
import type { TranscriptSegmentRecord } from "../transcript/session-transcript";
import { serializeTranscriptBlock } from "../transcript/transcript-markdown";

export type TextImportSourceDetailsInput = Pick<RecordingSession, "id" | "source"> & {
  segments?: Segment[] | null;
};

export function buildTextImportSourceDetails(session: TextImportSourceDetailsInput): string {
  if (!isTextImportSession(session)) return "";
  const segments = Array.isArray(session.segments) ? session.segments : [];
  if (!segments.length) return "";
  const lines: string[] = [];
  segments.forEach((segment, index) => {
    const name = segment.sourceName || `文本 ${index + 1}`;
    const path = segment.sourcePath || "";
    const link = path ? `[[${path}|${name}]]` : name;
    const heading = `### ${index + 1}. ${link}`;
    const visibleText = String(segment.rawText ?? segment.text ?? "") || labelText("emptyTextSource");
    const storedSegment = segment.transcript
      ? segment
      : attachTextTranscript(segment, session.id, "text-import");
    lines.push(serializeTranscriptBlock(storedSegment, heading, visibleText));
  });
  return [
    "<details>",
    `<summary>${labelText("importedTextSources", segments.length)}</summary>`,
    "",
    lines.join("\n\n"),
    "",
    "</details>",
  ].join("\n");
}

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
