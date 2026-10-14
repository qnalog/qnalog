import { normalizeVocabularyCorrectionTerm } from "../vocabulary/correction-normalization";
import { getErrataSectionKey, type ErrataSection } from "./errata-sections";

export interface ErrataReplacement { from: string; to: string }
export const MIN_ERRATA_TERM_LENGTH = 2;

export interface ParsedErrata {
  replacements: ErrataReplacement[];
  noise: string[];
  notes: string[];
  truncated: boolean;
}

function parseReplacement(line: string): ErrataReplacement | null {
  const cleaned = line.trim().replace(/^[-*+]\s+/, "").replace(/^\d+[.)、]\s+/, "");
  const match = cleaned.match(/^(.+?)\s*(?:=>|->|→)\s*(.+)$/);
  if (!match) return null;
  const normalized = normalizeVocabularyCorrectionTerm(`${match[1]} => ${match[2]}`);
  if (!normalized) return null;
  const pair = normalized.match(/^(.+?)\s*=>\s*(.+)$/);
  if (!pair || pair[1].length < MIN_ERRATA_TERM_LENGTH || pair[1] === pair[2]) return null;
  return { from: pair[1], to: pair[2] };
}

function normalizeNoiseParagraph(paragraph: string): string {
  return paragraph.split(/\r?\n/)
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join(" ").replace(/\s+/g, " ").trim();
}

export function parseErrata(markdown: string): ParsedErrata {
  const source = String(markdown || "").replace(/^\uFEFF/, "");
  const lines = source.split(/\r?\n/);
  const sectionLines: Record<ErrataSection, string[]> = {
    replacements: [], noise: [], notes: [],
  };
  let section: ErrataSection | null = null;
  for (const line of lines) {
    const heading = line.match(/^\s*##\s+(.+?)\s*#*\s*$/);
    if (heading) {
      section = getErrataSectionKey(heading[1]);
      continue;
    }
    if (section) sectionLines[section].push(line);
  }

  const replacements: ErrataReplacement[] = [];
  for (const line of sectionLines.replacements) {
    const rule = parseReplacement(line);
    if (!rule) continue;
    if (replacements.length === 200) break;
    replacements.push(rule);
  }
  const validReplacementCount = sectionLines.replacements.reduce((count, line) => count + (parseReplacement(line) ? 1 : 0), 0);
  const noise = sectionLines.noise.join("\n").split(/\r?\n\s*\r?\n+/)
    .map(normalizeNoiseParagraph).filter(Boolean);
  const notes = sectionLines.notes.map((line) => line.trim()).filter(Boolean);
  return { replacements, noise, notes, truncated: validReplacementCount > 200 };
}
