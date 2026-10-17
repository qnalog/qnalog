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
  /** The service reported that the audio contains no speech (for example the Bailian Flash no-words error). Runtime signal only; never written to notes or ledgers. */
  noSpeech?: boolean;
}

/** True when the result is an empty text that counts as a successful blank result (quiet audio or the service's no-speech report). */
export function isBlankAsrResult(result: AsrTranscriptResult | null | undefined): boolean {
  if (!result) return false;
  if (String(result.text || "").trim()) return false;
  return result.quiet === true || result.noSpeech === true;
}
