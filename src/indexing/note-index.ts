export const LEXVOICE_NOTE_INDEX_START = "<!-- lexvoice-note-index";
export const LEXVOICE_NOTE_INDEX_END = "lexvoice-note-index-end -->";

const NOTE_INDEX_PATTERN = /<!--\s*lexvoice-note-index\s*\n([\s\S]*?)\nlexvoice-note-index-end\s*-->/i;
const ACTIVE_VERSION_PATTERN = /<!--\s*lexvoice-active-version-start\s*-->([\s\S]*?)<!--\s*lexvoice-active-version-end\s*-->/i;
const MAX_INDEX_TOPICS = 48;
const MAX_CORE_TITLE_CHARS = 96;
const MAX_CORE_SUMMARY_CHARS = 720;
const MIN_USEFUL_SUMMARY_CHARS = 32;

export interface LexVoiceNoteIndexTopic {
  order: number;
  title: string;
  heading: string;
}

export interface LexVoiceNoteIndexCard {
  schemaVersion: 1;
  sourceRevision: string;
  generatedAt: string;
  meetingDate: string;
  core: {
    title: string;
    summary: string;
  };
  topics: LexVoiceNoteIndexTopic[];
  topicCount: number;
  omittedTopicCount: number;
}

export interface ResolvedLexVoiceNoteIndex extends LexVoiceNoteIndexCard {
  filePath: string;
  semanticCanvasPath: string | null;
}

export interface BuildLexVoiceNoteIndexOptions {
  noteTitle?: string;
  meetingDate?: string;
  generatedAt?: string;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}

function clampText(value: unknown, maxChars: number): string {
  const text = textValue(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, Math.max(1, maxChars - 1)).trimEnd();
  return `${sliced}…`;
}

function stripMarkdownInline(value: unknown): string {
  return textValue(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match: string, target: string, label: string | undefined): string => label || target)
    .replace(/[*_`~]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function stripLeadingFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
}

function extractFrontmatterScalar(markdown: string, keys: readonly string[]): string {
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(markdown);
  if (!match) return "";
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const valueMatch = new RegExp(`^${escaped}\\s*:\\s*(.+?)\\s*$`, "mi").exec(match[1]);
    if (!valueMatch) continue;
    const value = valueMatch[1].trim().replace(/^['"]|['"]$/g, "");
    if (value && value !== "null" && value !== "~") return value;
  }
  return "";
}

function stripUtilityTail(markdown: string): string {
  const boundaries = [
    /<!--\s*lexvoice-segments-start\b/i,
    /^##\s+(?:原始材料|原始转写|逐字稿|录音原文|分段原始转写|回听时间轴|录音中实时大纲)\s*$/im,
  ];
  let end = markdown.length;
  for (const boundary of boundaries) {
    const match = boundary.exec(markdown);
    if (match && match.index < end) end = match.index;
  }
  return markdown.slice(0, end);
}

function extractLastLegacyPolishBlock(markdown: string): string {
  const matches = Array.from(markdown.matchAll(/^##\s+整合版(?:（[^\n]*）)?\s*$/gim));
  if (!matches.length) return markdown;
  const start = matches[matches.length - 1].index || 0;
  const tail = markdown.slice(start);
  const divider = /^---\s*$/m.exec(tail);
  return divider ? tail.slice(0, divider.index) : tail;
}

export function removeLexVoiceNoteIndex(markdown: unknown): string {
  return textValue(markdown).replace(NOTE_INDEX_PATTERN, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function extractLexVoiceIndexSource(markdown: unknown): string {
  const original = removeLexVoiceNoteIndex(markdown);
  const active = ACTIVE_VERSION_PATTERN.exec(original);
  let visible = active ? active[1] : original;
  visible = stripLeadingFrontmatter(visible);
  if (!active) visible = extractLastLegacyPolishBlock(visible);
  visible = stripUtilityTail(visible)
    .replace(/<details>\s*<summary>[^<]*(?:原始转写|逐字稿|原始材料|回听时间轴|录音中实时大纲)[^<]*<\/summary>[\s\S]*?<\/details>/gi, "\n")
    .replace(/<!--[^>]*-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return visible;
}

function extractAbstractSummary(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const candidates: Array<{ preferred: boolean; text: string }> = [];
  for (let index = 0; index < lines.length; index++) {
    const start = /^\s*>\s*\[!(abstract|summary)\](?:[+-])?\s*(.*?)\s*$/i.exec(lines[index]);
    if (!start) continue;
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const quote = /^\s*>\s?(.*)$/.exec(lines[cursor]);
      if (!quote) break;
      const line = quote[1].trim();
      if (line) body.push(line.replace(/^[-*+]\s+/, ""));
    }
    const label = stripMarkdownInline(start[2]);
    const text = clampText(body.join(" "), MAX_CORE_SUMMARY_CHARS);
    if (text) candidates.push({ preferred: /(?:会议)?(?:梗概|摘要|概览|总览)/.test(label), text });
  }
  return (candidates.find((item) => item.preferred) || candidates[0] || { text: "" }).text;
}

const UTILITY_HEADING_PATTERN = /^(?:原始材料|原始转写|逐字稿|录音原文|分段原始转写|回听时间轴|录音中实时大纲|会中补充材料|问一问|附录|参考资料|版本信息)$/;

function normalizeTopicTitle(value: unknown): string {
  return clampText(stripMarkdownInline(value)
    .replace(/^\s*(?:\d+(?:\.\d+)*[.、)）]?|[一二三四五六七八九十百]+[、.．)）])\s*/, "")
    .replace(/^\s*(?:📌|📋|🧭|✨|⭐|✅|❗)+\s*/u, ""), 120);
}

function extractTopics(markdown: string): { topics: LexVoiceNoteIndexTopic[]; topicCount: number } {
  const rows: Array<{ level: number; heading: string; title: string }> = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const heading = stripMarkdownInline(match[2]);
    const title = normalizeTopicTitle(heading);
    if (!title || UTILITY_HEADING_PATTERN.test(title)) continue;
    rows.push({ level: match[1].length, heading, title });
  }
  const preferredLevel = rows.some((row) => row.level === 2) ? 2 : 3;
  const seen = new Set<string>();
  const all: LexVoiceNoteIndexTopic[] = [];
  for (const row of rows) {
    if (row.level !== preferredLevel) continue;
    const key = row.title.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({ order: all.length + 1, title: row.title, heading: row.heading });
  }
  return { topics: all.slice(0, MAX_INDEX_TOPICS), topicCount: all.length };
}

function extractFallbackSummary(markdown: string, topics: readonly LexVoiceNoteIndexTopic[]): string {
  const body = markdown
    .replace(/^#\s+.+$/m, "")
    .replace(/^>\s*\[![^\]]+\].*(?:\n>.*)*/gim, "")
    .replace(/^#{2,6}\s+.+$/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .trim();
  const paragraph = body.split(/\n\s*\n/).map((item) => clampText(item, MAX_CORE_SUMMARY_CHARS)).find(Boolean);
  if (paragraph) return paragraph;
  return clampText(topics.map((topic) => topic.title).join("；"), MAX_CORE_SUMMARY_CHARS);
}

function isWeakIndexSummary(value: string): boolean {
  const normalized = clampText(value, MAX_CORE_SUMMARY_CHARS);
  if (!normalized || normalized.length < MIN_USEFUL_SUMMARY_CHARS) return true;
  return /^(?:已|现已|本文|本次(?:会议|讨论|研讨)?)?.{0,18}(?:完成|生成|整理|汇总)(?:全部|所有|本次)?(?:内容|材料|会议内容|纪要)?(?:的)?(?:整理|汇总)?[。.!！]?$/.test(normalized)
    || /^(?:内容|详情|具体内容)(?:见|详见|参见)(?:下文|正文|后文)[。.!！]?$/.test(normalized);
}

function cleanCoreTitle(value: unknown): string {
  return clampText(stripMarkdownInline(value)
    .replace(/\.md$/i, "")
    .replace(/^【[^】]+】\s*/, "")
    .replace(/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:?\d{2})?\s*[·\-–—:]?\s*/, "")
    .replace(/^\d{4}-\d{2}-\d{2}\s+\d{4}\s*[·\-–—:]?\s*/, "")
    .replace(/^(?:导入|合并|录音)\s*[·\-–—:]\s*/, "")
    .replace(/^(?:综合纪要|研讨会|学习笔记|招聘评估|个人笔记|访谈纪要)\s*[·\-–—:]\s*/, "")
    .trim(), MAX_CORE_TITLE_CHARS);
}

function firstSentence(value: string): string {
  const match = /^(.{4,80}?)(?:[。！？!?；;]|$)/.exec(value.trim());
  return clampText(match ? match[1] : value, MAX_CORE_TITLE_CHARS);
}

function inferMeetingDate(markdown: string, explicit: unknown, noteTitle: unknown): string {
  const source = textValue(explicit).trim()
    || extractFrontmatterScalar(markdown, ["time", "日期", "date", "created"])
    || textValue(noteTitle);
  const match = /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(source);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildLexVoiceNoteIndex(
  markdown: unknown,
  options: BuildLexVoiceNoteIndexOptions = {},
): LexVoiceNoteIndexCard | null {
  const fullMarkdown = textValue(markdown);
  const source = extractLexVoiceIndexSource(fullMarkdown);
  if (!source || /^_?\[(?:无输出|版本内容为空)\]_?$/i.test(source)) return null;
  const extracted = extractTopics(source);
  const abstractSummary = extractAbstractSummary(source);
  const fallbackSummary = extractFallbackSummary(source, extracted.topics);
  const summary = isWeakIndexSummary(abstractSummary) && fallbackSummary.length > abstractSummary.length
    ? fallbackSummary
    : (abstractSummary || fallbackSummary);
  const h1 = /^#\s+(.+?)\s*$/m.exec(source)?.[1] || "";
  const titleCandidate = cleanCoreTitle(options.noteTitle || h1);
  const genericTitle = /^(?:综合纪要|研讨会|学习笔记|招聘评估|个人笔记|访谈纪要|导入|合并)?$/.test(titleCandidate);
  const title = genericTitle || titleCandidate.length < 4
    ? (firstSentence(summary) || extracted.topics[0]?.title || "会议纪要")
    : titleCandidate;
  const meetingDate = inferMeetingDate(fullMarkdown, options.meetingDate, options.noteTitle || h1);
  const sourceRevision = `idx-${stableHash(JSON.stringify({ title, meetingDate, source }))}`;
  return {
    schemaVersion: 1,
    sourceRevision,
    generatedAt: options.generatedAt || new Date().toISOString(),
    meetingDate,
    core: { title, summary },
    topics: extracted.topics,
    topicCount: extracted.topicCount,
    omittedTopicCount: Math.max(0, extracted.topicCount - extracted.topics.length),
  };
}

function isIndexTopic(value: unknown): value is LexVoiceNoteIndexTopic {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Number.isFinite(Number(row.order)) && typeof row.title === "string" && typeof row.heading === "string";
}

export function readLexVoiceNoteIndex(markdown: unknown): LexVoiceNoteIndexCard | null {
  const match = NOTE_INDEX_PATTERN.exec(textValue(markdown));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    const core = parsed.core as Record<string, unknown> | undefined;
    if (parsed.schemaVersion !== 1 || typeof parsed.sourceRevision !== "string" || !core
      || typeof core.title !== "string" || typeof core.summary !== "string"
      || !Array.isArray(parsed.topics) || !parsed.topics.every(isIndexTopic)) return null;
    return parsed as unknown as LexVoiceNoteIndexCard;
  } catch {
    return null;
  }
}

export function serializeLexVoiceNoteIndex(index: LexVoiceNoteIndexCard): string {
  const json = JSON.stringify(index)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/--/g, "\\u002d\\u002d");
  return `${LEXVOICE_NOTE_INDEX_START}\n${json}\n${LEXVOICE_NOTE_INDEX_END}`;
}

export function upsertLexVoiceNoteIndex(markdown: unknown, index: LexVoiceNoteIndexCard): string {
  const text = textValue(markdown);
  const existing = readLexVoiceNoteIndex(text);
  if (existing && existing.sourceRevision === index.sourceRevision) return text;
  const block = serializeLexVoiceNoteIndex(index);
  if (NOTE_INDEX_PATTERN.test(text)) return text.replace(NOTE_INDEX_PATTERN, block);
  return `${text.trimEnd()}\n\n${block}\n`;
}

export function resolveLexVoiceNoteIndex(
  index: LexVoiceNoteIndexCard,
  filePath: unknown,
  semanticCanvasPath: unknown,
): ResolvedLexVoiceNoteIndex {
  return {
    ...index,
    filePath: textValue(filePath),
    semanticCanvasPath: textValue(semanticCanvasPath) || null,
  };
}
