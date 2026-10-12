import type { RecordingSession, Segment } from "../shared/types";
import { isTextImportSession } from "../briefing/note-layout-policy";
import { attachTextTranscript } from "../transcript/session-transcript";
import { labelText } from "../shared/note-labels";
import { formatElapsed } from "../shared/util-common";
import { getTranscribeSegmentPlaceholder } from "../shared/util-audio";
import { nsMarker, nsRe } from "../shared/namespace";
import type { TranscriptSegmentRecord } from "../transcript/session-transcript";
import { normalizeTranscriptDataPlacement, serializeTranscriptBlock } from "../transcript/transcript-markdown";

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
    const heading = `### ${labelText("segment", index + 1)} (${formatElapsed(segment.startOffsetMs)}–${formatElapsed(segment.endOffsetMs)}) ${link}`;
    const visibleText = String(segment.rawText ?? segment.text ?? "") || labelText("emptyTextSource");
    const storedSegment = segment.transcript
      ? segment
      : attachTextTranscript(segment, session.id, "text-import");
    lines.push(serializeTranscriptBlock(storedSegment, heading, visibleText));
  });
  return normalizeTranscriptDataPlacement(`**${labelText("segmentedRawTranscript", segments.length)}**\n\n${lines.join("\n")}`);
}

function withSessionSegmentMarkers(value: string, sessionId: string): string {
  const transcriptStart = value.search(new RegExp(`<!--\\s*${nsRe("transcript-start")}:`));
  const start = transcriptStart >= 0 ? transcriptStart : value.indexOf("</summary>") + "</summary>".length;
  const transcriptEnd = value.lastIndexOf(`<!-- ${nsRe("transcript-end")}:`);
  const close = value.lastIndexOf("</details>");
  if (start < 0 || close < 0) return value;
  const withEnd = transcriptEnd >= 0
    ? value.slice(0, close) + `${nsMarker("segments-end", sessionId)}\n` + value.slice(close)
    : value.slice(0, close) + `\n${nsMarker("segments-end", sessionId)}\n` + value.slice(close);
  const startPrefix = start > 0 && /[\r\n]/.test(withEnd[start - 1]) ? "" : "\n";
  return withEnd.slice(0, start) + `${startPrefix}${nsMarker("segments-start", sessionId)}\n` + withEnd.slice(start);
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
    : [
      "<details>",
      `<summary>${heading.replace(/^###\s*/, "")}</summary>`,
      taskMarker,
      body,
      "</details>",
    ].filter(Boolean).join("\n");
}

export function wrapSessionTranscriptBlocks(blocks: string, sessionId: string): string {
  return withSessionSegmentMarkers(blocks, sessionId);
}

export function serializeContinuationSegmentBlock(
  segment: Segment & { transcript: TranscriptSegmentRecord },
  audioLink: string,
): string {
  return serializeTranscriptBlock(segment, buildSegmentHeading(segment, audioLink), buildSegmentBody(segment));
}
