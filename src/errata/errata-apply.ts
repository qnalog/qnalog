import { readTranscriptBlocks } from "../transcript/transcript-markdown";
import { findProtectedRanges } from "../notes/text-correction";
import { NS_SEGMENTS_BLOCK_RE } from "../shared/namespace";
import { nsRe } from "../shared/namespace";
import type { ErrataReplacement } from "./errata-parser";
import { replaceTerms, type TextRange } from "../shared/term-replacement";

export interface ErrataRules {
  replacements: readonly ErrataReplacement[];
  noise: readonly string[];
  prompt?: string;
}

function protectedRanges(markdown: string): TextRange[] {
  const ranges = findProtectedRanges(markdown);
  for (const match of markdown.matchAll(new RegExp(NS_SEGMENTS_BLOCK_RE.source, NS_SEGMENTS_BLOCK_RE.flags))) {
    ranges.push({ start: match.index || 0, end: (match.index || 0) + match[0].length });
  }
  const transcriptRecord = new RegExp(`<!--\\s*${nsRe("transcript-start")}(?::[^>]*)?\\s*-->[\\s\\S]*?<!--\\s*${nsRe("transcript-end")}(?::[^>]*)?\\s*-->`, "gi");
  for (const match of markdown.matchAll(transcriptRecord)) ranges.push({ start: match.index || 0, end: (match.index || 0) + match[0].length });
  try {
    for (const block of readTranscriptBlocks(markdown)) ranges.push({ start: block.start, end: block.end });
  } catch { /* malformed transcript data stays protected by the segment container range above */ }
  return ranges.sort((left, right) => left.start - right.start);
}

export function applyReplacements(text: string, rules: readonly ErrataReplacement[]): string {
  const source = String(text || "");
  return replaceTerms(source, rules, protectedRanges(source));
}

function normalizeWhitespace(value: string): string { return value.replace(/\s+/g, " ").trim(); }

export interface NoiseRemovalResult { text: string; removed: number }

export function removeNoise(text: string, noise: readonly string[]): NoiseRemovalResult {
  let result = String(text || "");
  let removed = 0;
  const candidates = noise.map(normalizeWhitespace).filter((item) => item.length >= 6).sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const chunks = result.split(/(\n[\t ]*\n+)/);
    let range: TextRange | null = null;
    let offset = 0;
    for (let index = 0; index < chunks.length; index += 2) {
      const chunk = chunks[index] || "";
      if (normalizeWhitespace(chunk) === candidate) { range = { start: offset, end: offset + chunk.length }; break; }
      offset += chunk.length + (chunks[index + 1] || "").length;
    }
    if (!range) continue;
    result = result.slice(0, range.start) + result.slice(range.end);
    removed += 1;
  }
  return { text: result, removed };
}

export function applyErrataToText(text: string, rules: ErrataRules): { text: string; removedNoise: number } {
  const replaced = applyReplacements(text, rules.replacements);
  const cleaned = removeNoise(replaced, rules.noise);
  return { text: cleaned.text, removedNoise: cleaned.removed };
}

export function applyErrataToSegments<T extends { text?: string }>(segments: readonly T[], rules: ErrataRules): T[] {
  if (!rules.replacements.length && !rules.noise.length) return segments as T[];
  return segments.map((segment) => ({
    ...segment,
    text: removeNoise(applyReplacements(String(segment.text || ""), rules.replacements), rules.noise).text,
  }));
}
