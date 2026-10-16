import { getTopicErrataSectionKey, type TopicErrataSection } from "./topic-errata-sections";

export interface TopicErrataEntry { memberLink: string | null; description: string }
export interface ParsedTopicErrata { entries: TopicErrataEntry[]; notes: string[] }

function cleanDescription(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function parseTopicErrata(markdown: string): ParsedTopicErrata {
  const sections: Record<TopicErrataSection, string[]> = { offTopic: [], notes: [] };
  let section: TopicErrataSection | null = null;
  for (const line of String(markdown || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const heading = line.match(/^\s*##\s+(.+?)\s*#*\s*$/);
    if (heading) { section = getTopicErrataSectionKey(heading[1]); continue; }
    if (section) sections[section].push(line);
  }
  const entries: TopicErrataEntry[] = [];
  const seen = new Set<string>();
  for (const line of sections.offTopic) {
    const cleaned = line.trim().replace(/^[-*+]\s+/, "").replace(/^\d+[.)、]\s+/, "");
    const match = cleaned.match(/^(?:\[\[(.*?)\]\]\s*[：:]\s*)?(.+)$/);
    if (!match) continue;
    const memberLink = match[1]?.split("|")[0].trim() || null;
    const description = cleanDescription(match[2]);
    if (!description) continue;
    const key = `${memberLink || "*"}\n${description.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ memberLink, description });
    if (entries.length >= 500) break;
  }
  const notes = [...new Set(sections.notes.map((line) => line.trim()).filter(Boolean))].slice(0, 100);
  return { entries, notes };
}
