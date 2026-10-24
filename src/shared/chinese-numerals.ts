/**
 * Chinese numerals written as Arabic digits (十一 → 11, 百分之十五 → 15).
 *
 * Used where the same number may be written either way: the accuracy baseline compares
 * transcripts from services that write numbers differently (scripts/accuracy-baseline/scoring.ts),
 * and finding in a recording matches a typed query against the transcript (notes/recording-search.ts).
 * Pure functions: no Obsidian, DOM or file access.
 */

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const CN_BIG_UNITS: Record<string, number> = { 万: 10_000, 亿: 100_000_000 };
const CN_NUMBER_RUN = /[零〇一二两三四五六七八九十百千万亿]+/g;

/** The prefix written before a percentage (百分之十五 = 15%); dropped when the number is converted. */
export const CN_PERCENT_PREFIX = "百分之";

/** True for one character that can be part of a Chinese numeral run. */
export function isChineseNumeralChar(ch: string): boolean {
  return ch in CN_DIGITS || ch in CN_UNITS || ch in CN_BIG_UNITS;
}

/**
 * True when a run reads as a number: it has a digit character (零 to 九) or 十. A run of other unit
 * characters only (万, 千, 百亿) is more often part of a word, so search leaves it as written.
 */
export function isNumberLikeChineseRun(run: string): boolean {
  return [...run].some((ch) => ch in CN_DIGITS || ch === "十");
}

/** Reads one run of Chinese numerals. Runs without unit characters (二〇二六) are read digit by digit. */
export function chineseNumeralRunToArabic(run: string): string {
  if (!/[十百千万亿]/.test(run)) return [...run].map((ch) => String(CN_DIGITS[ch])).join("");
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of run) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      section += (digit || 1) * CN_UNITS[ch];
      digit = 0;
    } else {
      total = (total + section + digit) * CN_BIG_UNITS[ch];
      section = 0;
      digit = 0;
    }
  }
  return String(total + section + digit);
}

/** Writes Chinese numerals as Arabic digits and drops 百分之 before a number. */
export function normalizeChineseNumbers(text: string): string {
  return String(text || "")
    .replace(/百分之([零〇一二两三四五六七八九十百千万亿]+)/g, "$1")
    .replace(CN_NUMBER_RUN, chineseNumeralRunToArabic);
}
