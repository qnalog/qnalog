import type { TranscriptSegmentRecord } from "../transcript/session-transcript";
import { readTranscriptBlocks } from "../transcript/transcript-markdown";

export interface TranscriptCheckpointSegment {
  text?: string | null;
  error?: string | null;
  transcript?: TranscriptSegmentRecord;
}

export interface TranscriptCheckpointResult {
  ok: boolean;
  expectedSegments: number;
  persistedSegments: number;
  expectedChars: number;
  missingSegmentIndexes: number[];
}

function transcriptProbe(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (text.length <= 240) return text;
  return `${text.slice(0, 120)}\n${text.slice(-120)}`;
}

function sameTranscriptRecord(expected: TranscriptSegmentRecord, stored: TranscriptSegmentRecord): boolean {
  return JSON.stringify(expected) === JSON.stringify(stored);
}

export function verifyTranscriptCheckpoint(
  markdown: string,
  segments: TranscriptCheckpointSegment[],
): TranscriptCheckpointResult {
  const content = String(markdown || "");
  let blocks: ReturnType<typeof readTranscriptBlocks> | null = null;
  try {
    blocks = readTranscriptBlocks(content);
  } catch {
    blocks = null;
  }
  const usable = (Array.isArray(segments) ? segments : [])
    .map((segment, index) => ({ index, text: String(segment?.text || "").trim(), error: segment?.error, transcript: segment?.transcript }))
    .filter((segment) => segment.text && !segment.error);
  const missingSegmentIndexes = usable
    .filter((segment) => {
      if (segment.transcript) {
        if (!blocks) return true;
        const matches = blocks.filter((block) => block.segment.transcript?.id === segment.transcript?.id);
        return matches.length !== 1
          || matches[0].drifted
          || !matches[0].segment.transcript
          || !sameTranscriptRecord(segment.transcript, matches[0].segment.transcript);
      }
      const probe = transcriptProbe(segment.text);
      if (!probe) return false;
      if (segment.text.length <= 240) return !content.includes(probe);
      const [head, tail] = probe.split("\n");
      return !content.includes(head) || !content.includes(tail);
    })
    .map((segment) => segment.index);

  return {
    ok: usable.length > 0 && missingSegmentIndexes.length === 0,
    expectedSegments: usable.length,
    persistedSegments: Math.max(0, usable.length - missingSegmentIndexes.length),
    expectedChars: usable.reduce((total, segment) => total + segment.text.length, 0),
    missingSegmentIndexes,
  };
}
