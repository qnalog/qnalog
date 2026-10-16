export type AsrTranscriptTiming = "provider" | "audio-span" | "unknown";

export interface AsrTranscriptUnit {
  rawText: string;
  normalizedText: string;
  speakerId: string | null;
  speakerName: string | null;
  startMs: number | null;
  endMs: number | null;
  timing: AsrTranscriptTiming;
}

export interface AsrTranscriptResult {
  text: string;
  rawText: string | null;
  providerId: string;
  units: AsrTranscriptUnit[];
  /** Every audio chunk was below the quiet level and the text is empty. Runtime signal only; never written to notes or ledgers. */
  quiet?: boolean;
}
