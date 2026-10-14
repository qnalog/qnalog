import type { ParsedErrata } from "./errata-parser";

export interface ErrataPromptResult { text: string; usedCount: number; truncated: boolean }

const MAX_PROMPT_CHARS = 3000;

function render(replacements: readonly { from: string; to: string }[], noise: readonly string[], notes: readonly string[]): string {
  const sections = [
    replacements.length ? `替换：\n${replacements.map(({ from, to }) => `- 「${from}」应写作「${to}」`).join("\n")}` : "",
    noise.length ? `噪音（以下内容不属于本次录音，整理时必须排除，不得在输出中出现或转述）：\n${noise.map((item) => `- 「${item}」`).join("\n")}` : "",
    notes.length ? `说明：\n${notes.map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean);
  if (!sections.length) return "";
  return `【用户勘误（已由用户确认，优先于转写原文）】\n${sections.join("\n")}\n若转写原文与以上勘误冲突，以勘误为准。`;
}

export function buildErrataPrompt(errata: ParsedErrata): ErrataPromptResult {
  const rules = [...errata.replacements];
  const noise = [...errata.noise];
  const notes = [...errata.notes];
  let text = render(rules, noise, notes);
  let usedCount = rules.length + noise.length + notes.length;
  while (text.length > MAX_PROMPT_CHARS && notes.length) { notes.pop(); usedCount--; text = render(rules, noise, notes); }
  while (text.length > MAX_PROMPT_CHARS && noise.length) { noise.pop(); usedCount--; text = render(rules, noise, notes); }
  while (text.length > MAX_PROMPT_CHARS && rules.length) { rules.pop(); usedCount--; text = render(rules, noise, notes); }
  if (text.length > MAX_PROMPT_CHARS) text = text.slice(0, MAX_PROMPT_CHARS);
  return { text, usedCount, truncated: usedCount < errata.replacements.length + errata.noise.length + errata.notes.length || errata.truncated };
}
