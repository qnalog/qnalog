export type ApimimoRepeatCleanResult = {
  text: string;
  suppressedChars: number;
  suppressedRepeats: number;
};

const SENTENCE_END_RE = /[。！？!?；;]/;
const HARD_BOUNDARY_RE = /[\n\r]/;
const IGNORE_PUNCT_RE = /[\s，,。.!！？?、；;：:"“”‘’'`（）()[\]【】《》<>]/g;
const MAX_PATTERN_UNITS = 24;
const MIN_SHORT_PATTERN_CHARS = 24;
const MIN_LONG_PATTERN_CHARS = 60;

function splitTranscriptUnits(text: string): string[] {
  const input = String(text || "");
  const units: string[] = [];
  let current = "";

  for (const ch of input) {
    current += ch;
    if (SENTENCE_END_RE.test(ch) || HARD_BOUNDARY_RE.test(ch)) {
      if (current.trim()) units.push(current);
      current = "";
    }
  }
  if (current.trim()) units.push(current);
  return units.length ? units : (input.trim() ? [input] : []);
}

function normalizeUnit(text: string): string {
  return String(text || "")
    .replace(IGNORE_PUNCT_RE, "")
    .trim()
    .toLowerCase();
}

function samePattern(norms: string[], startA: number, startB: number, length: number): boolean {
  for (let i = 0; i < length; i++) {
    if (!norms[startA + i] || norms[startA + i] !== norms[startB + i]) return false;
  }
  return true;
}

function countPatternRepeats(norms: string[], start: number, length: number): number {
  let count = 1;
  while (start + (count + 1) * length <= norms.length) {
    if (!samePattern(norms, start, start + count * length, length)) break;
    count++;
  }
  return count;
}

export function cleanApimimoAsrRepeatedLoops(text: string): ApimimoRepeatCleanResult {
  const original = String(text || "").replace(/\s+/g, " ").trim();
  if (!original) return { text: "", suppressedChars: 0, suppressedRepeats: 0 };

  const units = splitTranscriptUnits(original);
  if (units.length < 4) return { text: original, suppressedChars: 0, suppressedRepeats: 0 };

  const norms = units.map(normalizeUnit);
  const output: string[] = [];
  let suppressedChars = 0;
  let suppressedRepeats = 0;
  let i = 0;

  while (i < units.length) {
    let best: { length: number; repeats: number; removedChars: number } | null = null;
    const maxLength = Math.min(MAX_PATTERN_UNITS, Math.floor((units.length - i) / 2));

    for (let length = 1; length <= maxLength; length++) {
      const patternNorm = norms.slice(i, i + length).join("");
      const patternChars = patternNorm.length;
      if (patternChars < MIN_SHORT_PATTERN_CHARS) continue;

      const repeats = countPatternRepeats(norms, i, length);
      const requiredRepeats = patternChars >= MIN_LONG_PATTERN_CHARS ? 2 : 3;
      if (repeats < requiredRepeats) continue;

      const removedChars = units.slice(i + length, i + repeats * length).join("").length;
      if (!best || removedChars > best.removedChars) {
        best = { length, repeats, removedChars };
      }
    }

    if (best) {
      output.push(...units.slice(i, i + best.length));
      suppressedChars += best.removedChars;
      suppressedRepeats += best.repeats - 1;
      i += best.length * best.repeats;
    } else {
      output.push(units[i]);
      i++;
    }
  }

  return {
    text: output.join("").replace(/\s+/g, " ").trim(),
    suppressedChars,
    suppressedRepeats,
  };
}
