export interface TranscriptCheckpointSegment {
  text?: string | null;
  error?: string | null;
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

export function verifyTranscriptCheckpoint(
  markdown: string,
  segments: TranscriptCheckpointSegment[],
): TranscriptCheckpointResult {
  const content = markdown;
  const usable = (Array.isArray(segments) ? segments : [])
    .map((segment, index) => ({ index, text: String(segment?.text || "").trim(), error: segment?.error }))
    .filter((segment) => segment.text && !segment.error);
  const missingSegmentIndexes = usable
    .filter((segment) => {
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
