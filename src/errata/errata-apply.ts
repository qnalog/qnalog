import { readTranscriptBlocks } from "../transcript/transcript-markdown";
import { findProtectedRanges } from "../notes/text-correction";
import { NS_SEGMENTS_BLOCK_RE } from "../shared/namespace";
import { nsRe } from "../shared/namespace";
import type { ErrataReplacement } from "./errata-parser";

export interface ErrataRules {
  replacements: readonly ErrataReplacement[];
  noise: readonly string[];
}

interface Range { start: number; end: number }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isEnglishTerm(value: string): boolean { return /[A-Za-z]/.test(value); }

function replacementPattern(from: string): RegExp {
  const escaped = escapeRegExp(from);
  if (isEnglishTerm(from)) return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "gi");
  return new RegExp(escaped, "g");
}

function protectedRanges(markdown: string): Range[] {
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

function replaceOutsideRanges(text: string, pattern: RegExp, replacements: ReadonlyMap<string, string>, ranges: readonly Range[]): string {
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) { pattern.lastIndex += 1; continue; }
    const start = match.index;
    const end = start + match[0].length;
    if (ranges.some((range) => start < range.end && end > range.start)) continue;
    result += text.slice(cursor, start) + (replacements.get(match[0].toLocaleLowerCase()) || match[0]);
    cursor = end;
  }
  return cursor ? result + text.slice(cursor) : text;
}

export function applyReplacements(text: string, rules: readonly ErrataReplacement[]): string {
  const source = String(text || "");
  const validRules = [...rules].filter((rule) => rule.from && rule.from !== rule.to)
    .sort((left, right) => right.from.length - left.from.length);
  if (!validRules.length) return source;
  const replacements = new Map(validRules.map((rule) => [rule.from.toLocaleLowerCase(), rule.to]));
  const pattern = new RegExp(validRules.map(({ from }) => replacementPattern(from).source).join("|"), "gi");
  return replaceOutsideRanges(source, pattern, replacements, protectedRanges(source));
}

function normalizeWhitespace(value: string): string { return value.replace(/\s+/g, " ").trim(); }

export interface NoiseRemovalResult { text: string; removed: number }

export function removeNoise(text: string, noise: readonly string[]): NoiseRemovalResult {
  let result = String(text || "");
  let removed = 0;
  const candidates = noise.map(normalizeWhitespace).filter((item) => item.length >= 6).sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const chunks = result.split(/(\n[\t ]*\n+)/);
    let range: Range | null = null;
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
