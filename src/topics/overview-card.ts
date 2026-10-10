import { readNoteIndex, resolveNoteIndex } from "../indexing/note-index";
import type { RelatedNoteDocument } from "../indexing/related-notes";
import { readNamespaceFrontmatter } from "../shared/namespace";

export const OVERVIEW_MAX_CHARS = 300;

export interface OverviewCard {
  path: string;
  sourceId: string;
  title: string;
  date: string;
  overview: string;
  overviewSource: "abstract" | "index-summary" | "none";
  tags: string[];
  people: string[];
  outLinks: string[];
  inLinks: string[];
  unresolvedTargets: string[];
  mtime: number;
  precision: "full" | "body-only";
}

export interface OverviewCardInput {
  document: RelatedNoteDocument;
  markdown: string;
  frontmatter: unknown;
  mtime: number;
  ctime?: number;
}

export function normalizeTagKey(value: string): string {
  let normalized = value.trim().replace(/^#+/, "").replace(/^(?:主题|项目|行业|公司)\//i, "").normalize("NFKC").toLocaleLowerCase();
  normalized = normalized.replace(/\s*&\s*/g, " and ").replace(/\s+n\s+/g, " and ").replace(/\s+and\s+/g, " and ");
  const parts = normalized.split(" and ").sort();
  return parts.join("and").replace(/[\p{P}\p{S}\s_]+/gu, "");
}

function tagValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  return [...new Set(values.filter((item): item is string => typeof item === "string").map(normalizeTagKey).filter(Boolean))].sort();
}

function dateValue(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  const match = /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(text);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : "";
}

function abstract(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*>\s*\[!abstract\](?:[+-])?/i.test(lines[index])) continue;
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const quote = /^\s*>\s?(.*)$/.exec(lines[cursor]);
      if (!quote) break;
      if (quote[1].trim()) body.push(quote[1].trim().replace(/^[-*+]\s+/, ""));
    }
    if (body.length) return body.join(" ").slice(0, OVERVIEW_MAX_CHARS);
  }
  return "";
}

export function buildOverviewCard(input: OverviewCardInput): OverviewCard {
  const { document, markdown, frontmatter, mtime, ctime } = input;
  const index = readNoteIndex(markdown);
  const resolved = index ? resolveNoteIndex(index, document.path, null) : null;
  const abstractText = abstract(markdown);
  const indexText = document.summary || resolved?.core.summary || "";
  const overview = abstractText || indexText.slice(0, OVERVIEW_MAX_CHARS);
  const explicitDate = dateValue(frontmatter && typeof frontmatter === "object"
    ? (frontmatter as Record<string, unknown>)["meetingDate"] : undefined);
  const noteDate = dateValue(readNamespaceFrontmatter(frontmatter, "time"));
  const date = explicitDate || noteDate || (Number.isFinite(ctime) ? new Date(ctime ?? 0).toISOString().slice(0, 10) : "");
  const rawTags = frontmatter && typeof frontmatter === "object"
    ? ((frontmatter as Record<string, unknown>).tags ?? (frontmatter as Record<string, unknown>).tag) : undefined;
  const tagList = tagValues(rawTags);
  const topicTags = tagValues(readNamespaceFrontmatter(frontmatter, "topic"));
  const people = Array.isArray(document.people) ? [...new Set(document.people.filter(Boolean))].sort() : [];
  return {
    path: document.path,
    sourceId: document.sourceId,
    title: document.title,
    date,
    overview,
    overviewSource: abstractText ? "abstract" : indexText ? "index-summary" : "none",
    tags: [...new Set([...tagList, ...topicTags])].sort(),
    people,
    outLinks: [...document.outLinks],
    inLinks: [...document.inLinks],
    unresolvedTargets: [...document.unresolvedTargets],
    mtime,
    precision: document.precision,
  };
}

export function overviewCardTimestamp(card: OverviewCard): number {
  return Date.parse(card.date) || card.mtime || 0;
}
