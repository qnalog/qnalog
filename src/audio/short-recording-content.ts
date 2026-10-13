/** 短录音转写文本的内容判定结果。 */
export type ShortRecordingContent = "blank" | "sentence" | "fragment";

/** 成文判定使用的最小汉字数。 */
export const SHORT_RECORDING_MIN_HAN_CHARACTERS = 6;
/** 成文判定使用的最小拉丁词数。 */
export const SHORT_RECORDING_MIN_LATIN_WORDS = 3;

const FILLER_WORDS = /嗯|啊|呃|哦|\b(?:uh|um|hmm)\b/giu;
const WHITESPACE_AND_PUNCTUATION = /[\s\p{P}\p{S}]/gu;
const HAN_CHARACTER = /\p{Script=Han}/gu;
const LATIN_WORD = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
const TODO_PROMPT = /(?:记得|提醒我|待办|别忘了|remind\s+me|todo)/iu;

/** 按空白、标点、语气词、句长和待办提示词判断转写文本。 */
export function classifyShortRecordingContent(text: string): ShortRecordingContent {
  const source = String(text || "");
  const withoutFillers = source.replace(FILLER_WORDS, "");
  const compact = withoutFillers.replace(WHITESPACE_AND_PUNCTUATION, "");
  if (!compact) return "blank";

  const hanCount = (compact.match(HAN_CHARACTER) || []).length;
  const latinWords = withoutFillers.match(LATIN_WORD) || [];
  if (
    hanCount >= SHORT_RECORDING_MIN_HAN_CHARACTERS
    || latinWords.length >= SHORT_RECORDING_MIN_LATIN_WORDS
    || TODO_PROMPT.test(source)
  ) return "sentence";

  return "fragment";
}
