/**
 * Chinese conversational speech commonly reaches about 6–8 characters per second.
 * The 15-character limit leaves room for faster speech and English token spacing while remaining above that range.
 */
export const LONG_RECORDING_MAX_CHARACTERS_PER_SECOND = 15;
/** Repetition checks start above this compacted text length. */
export const LONG_RECORDING_REPETITION_MIN_CHARACTERS = 200;
/** A repeated span must account for more than this share of compacted text. */
export const LONG_RECORDING_REPETITION_MAX_SHARE = 0.6;

export type LongRecordingAnomalySignal = "density" | "repetition";

/** Return the anomaly signals for a transcription that is inconsistent with its audio duration. */
export function classifyLongRecordingAnomaly(text: string, durationMs: number): LongRecordingAnomalySignal[] {
  const source = String(text || "");
  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration < 10_000) return [];

  const nonWhitespaceLength = Array.from(source.replace(/\s/gu, "")).length;
  const durationSeconds = duration / 1000;
  const signals: LongRecordingAnomalySignal[] = [];
  if (nonWhitespaceLength / durationSeconds > LONG_RECORDING_MAX_CHARACTERS_PER_SECOND) {
    signals.push("density");
  }

  const compact = Array.from(source.replace(/\s/gu, ""));
  if (/[\p{L}\p{N}]/u.test(compact.join(""))
    && compact.length > LONG_RECORDING_REPETITION_MIN_CHARACTERS
    && hasDominantRepeatedSpan(compact)) {
    signals.push("repetition");
  }
  return signals;
}

function hasDominantRepeatedSpan(text: readonly string[]): boolean {
  const repeatedLengthByPattern = new Map<string, number>();
  for (let period = 1; period <= 20 && period * 2 <= text.length; period += 1) {
    let matchingCharacters = 0;
    let runStart = period;
    for (let index = period; index <= text.length; index += 1) {
      if (index < text.length && text[index] === text[index - period]) {
        if (matchingCharacters === 0) runStart = index - period;
        matchingCharacters += 1;
        continue;
      }
      if (matchingCharacters >= period) {
        const repeatedLength = matchingCharacters + period;
        const pattern = text.slice(runStart, runStart + period).join("");
        repeatedLengthByPattern.set(pattern, (repeatedLengthByPattern.get(pattern) || 0) + repeatedLength);
      }
      matchingCharacters = 0;
    }
  }
  for (const repeatedLength of repeatedLengthByPattern.values()) {
    if (repeatedLength / text.length > LONG_RECORDING_REPETITION_MAX_SHARE) return true;
  }
  return false;
}
