// 词表纠错（全库词汇表）与勘误替换（单篇笔记）共用的「A 应写作 B」执行规则。
// 两处原本各写一套：词汇表逐条替换，前一条的结果会被后一条再改，英文词也会在单词内部被替换
// （规则 ai => AI 会把 said 改成 sAId）。这里统一为一次扫描：同一位置取最长的原词，
// 含英文字母的原词要求前后不是字母、数字或下划线，替换结果不再参与后续匹配。

export interface TermReplacement { from: string; to: string }
export interface TextRange { start: number; end: number }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPatternSource(from: string): string {
  const escaped = escapeRegExp(from);
  return /[A-Za-z]/.test(from) ? `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])` : escaped;
}

/**
 * 一次扫描完成全部替换；与 ranges 重叠的匹配保持原文。英文比较不区分大小写。
 * 替换文本按字面量写入（不解释 $& 等替换模式）。
 */
export function replaceTerms(text: string, rules: readonly TermReplacement[], ranges: readonly TextRange[] = []): string {
  const source = String(text || "");
  const validRules = rules.filter((rule) => rule && rule.from && rule.to !== undefined && rule.from !== rule.to)
    .sort((left, right) => right.from.length - left.from.length);
  if (!source || !validRules.length) return source;
  const replacements = new Map(validRules.map((rule) => [rule.from.toLocaleLowerCase(), rule.to]));
  const pattern = new RegExp(validRules.map(({ from }) => termPatternSource(from)).join("|"), "gi");
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match[0].length === 0) { pattern.lastIndex += 1; continue; }
    const start = match.index;
    const end = start + match[0].length;
    if (ranges.some((range) => start < range.end && end > range.start)) continue;
    result += source.slice(cursor, start) + (replacements.get(match[0].toLocaleLowerCase()) ?? match[0]);
    cursor = end;
  }
  return cursor ? result + source.slice(cursor) : source;
}
