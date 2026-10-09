import { NS_PEOPLE_RE } from "../shared/namespace";

const stringifyPersonText = String as (value: unknown) => string;

export function splitPersonFieldValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(splitPersonFieldValue);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(splitPersonFieldValue);
  }
  const text = stringifyPersonText(value || "").trim();
  if (/^\[\[[\s\S]+?\]\]$/.test(text)) return [text];
  return text
    .split(/[，,、;；|]/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function normalizePersonLookupText(text: unknown): string {
  return stringifyPersonText(text || "")
    .replace(/\[\[|\]\]/g, "")
    .replace(/#\S+/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

export function normalizePeopleArray(value: unknown): string[] {
  return splitPersonFieldValue(value)
    .map(s => s.replace(/^["'「『]|["'」』]$/g, "").trim())
    .filter(Boolean);
}

export function mergeUniqueStrings(base: unknown, extra: unknown): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    const text = stringifyPersonText(value || "").trim();
    if (!text) return;
    const key = normalizePersonLookupText(text);
    if (!out.some(x => normalizePersonLookupText(x) === key)) out.push(text);
  };
  for (const item of normalizePeopleArray(base)) add(item);
  for (const item of normalizePeopleArray(extra)) add(item);
  return out;
}

export function parsePeopleFromOutput(text: string | null | undefined): { people: string[]; cleaned: string } {
  if (!text) return { people: [], cleaned: text || "" };
  const re = NS_PEOPLE_RE;
  const m = text.match(re);
  if (!m) return { people: [], cleaned: text };
  const raw = m[1]
    .split(/[,，;；、\n]+/)
    .map(s => s.replace(/^#+/, "").replace(/^人物\//, "").trim())
    .filter(Boolean)
    .filter(s => s.length <= 24);
  const seen = new Set<string>();
  const people: string[] = [];
  for (const p of raw) { const k = normalizePersonLookupText(p); if (k && !seen.has(k)) { seen.add(k); people.push(p); } }
  const cleaned = text.replace(re, "").replace(/\n{3,}$/, "\n\n").trimEnd() + "\n";
  return { people, cleaned };
}
