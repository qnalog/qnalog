import type { ParsedTopicErrata, TopicErrataEntry } from "./topic-errata-parser";

export interface TopicErrataPromptResult { text: string; usedCount: number; truncated: boolean }
export interface ScopedTopicErrataEntry extends TopicErrataEntry { memberPath: string | null }
export interface ScopedTopicErrata { entries: ScopedTopicErrataEntry[]; notes: string[]; truncated?: boolean }
const MAX_PROMPT_CHARS = 3000;

function render(entries: readonly ScopedTopicErrataEntry[], notes: readonly string[]): string {
  if (!entries.length && !notes.length) return "";
  const rules = entries.map((entry) => `- ${entry.memberPath ? `[[${entry.memberPath}]]：` : ""}${entry.description}`).join("\n");
  const sections = [`【主题勘误（用户已确认列出的方面不属于本主题，整合时不得写入）】\n${rules}`];
  if (notes.length) sections.push(`说明：\n${notes.map((note) => `- ${note}`).join("\n")}`);
  return sections.join("\n");
}

export function buildTopicErrataPrompt(errata: ParsedTopicErrata | ScopedTopicErrata): TopicErrataPromptResult {
  const sourceEntries: readonly (TopicErrataEntry | ScopedTopicErrataEntry)[] = errata.entries;
  const entries: ScopedTopicErrataEntry[] = sourceEntries.map((entry): ScopedTopicErrataEntry => "memberPath" in entry
    ? { memberLink: entry.memberLink, memberPath: entry.memberPath, description: entry.description }
    : { ...entry, memberPath: entry.memberLink });
  const keptEntries = [...entries];
  const notes = [...errata.notes];
  let text = render(keptEntries, notes);
  // The requested trimming order is global entries first, then member-scoped entries.
  while (text.length > MAX_PROMPT_CHARS && keptEntries.some((entry) => !entry.memberPath)) {
    const index = keptEntries.findLastIndex((entry) => !entry.memberPath);
    keptEntries.splice(index, 1);
    text = render(keptEntries, notes);
  }
  while (text.length > MAX_PROMPT_CHARS && notes.length) { notes.pop(); text = render(keptEntries, notes); }
  while (text.length > MAX_PROMPT_CHARS && keptEntries.length) {
    const index = keptEntries.findLastIndex((entry) => !!entry.memberPath);
    keptEntries.splice(index < 0 ? keptEntries.length - 1 : index, 1);
    text = render(keptEntries, notes);
  }
  if (text.length > MAX_PROMPT_CHARS) text = text.slice(0, MAX_PROMPT_CHARS);
  const usedCount = keptEntries.length + notes.length;
  return { text, usedCount, truncated: usedCount < errata.entries.length + errata.notes.length || ("truncated" in errata && errata.truncated === true) };
}
