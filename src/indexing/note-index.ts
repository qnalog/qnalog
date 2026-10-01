import type { KnowledgeSourceRevision, KnowledgeStatus, SessionKnowledge } from "../briefing/session-knowledge";
import { readSelectedSessionKnowledge } from "../briefing/session-knowledge";
import type { Segment } from "../shared/types";
import { getTranscriptSourceRevision } from "../transcript/session-transcript";
import { readTranscriptBlocks } from "../transcript/transcript-markdown";
import { stableHash } from "../shared/stable-hash";
import { NS_FM, NS_TAG, nsRe } from "../shared/namespace";
import { labelPattern, labelText, UTILITY_HEADING_RE } from "../shared/note-labels";
import { findActiveVersionBlock, findFirstNoteBoundary, stripUtilityDetailsBlocks } from "../notes/note-document";
// 写入用折叠壳新格式（标记在外、details+json 围栏在内，阅读视图折叠为一行）；
// 读取同时接受旧的单注释格式，否则既有笔记里的索引块会被重复插入。
export const QNALOG_NOTE_INDEX_START = `<!-- ${NS_TAG}-note-index -->`;
export const QNALOG_NOTE_INDEX_END = `<!-- ${NS_TAG}-note-index-end -->`;

const NOTE_INDEX_FENCED_PATTERN = new RegExp(
  `<!--\\s*${nsRe("note-index")}\\s*-->\\s*<details>\\s*<summary>[^<]*</summary>\\s*\`\`\`json\\s*\\n([\\s\\S]*?)\\n\`\`\`\\s*</details>\\s*<!--\\s*${nsRe("note-index-end")}\\s*-->`,
  "i",
);
const NOTE_INDEX_LEGACY_PATTERN = new RegExp(`<!--\\s*${nsRe("note-index")}\\s*\\n([\\s\\S]*?)\\n${nsRe("note-index-end")}\\s*-->`, "i");
const MAX_INDEX_TOPICS = 48;
const MAX_CORE_TITLE_CHARS = 96;
const MAX_CORE_SUMMARY_CHARS = 720;
const MIN_USEFUL_SUMMARY_CHARS = 32;
const LEGACY_INDEX_CARDS = new WeakSet<object>();

export interface QnALogNoteIndexTopic {
  order: number;
  title: string;
  heading: string;
}

export interface NoteIndexKnowledge {
  snapshotId: string | null;
  sourceRevision: string | null;
  status: KnowledgeStatus;
  topics: Array<{ id: string; title: string; summary: string; evidence: string[] }>;
  decisions: string[];
  actions: string[];
  questions: string[];
}

export interface QnALogNoteIndexCard {
  schemaVersion: 2;
  sourceRevision: string;
  generatedAt: string;
  meetingDate: string;
  core: {
    title: string;
    summary: string;
  };
  topics: QnALogNoteIndexTopic[];
  topicCount: number;
  omittedTopicCount: number;
  knowledge: NoteIndexKnowledge;
}

export interface FutureNoteIndexSchema {
  status: "future-schema";
  schemaVersion: number;
}

export type NoteIndexReadResult = QnALogNoteIndexCard | FutureNoteIndexSchema;

export interface ResolvedNoteIndex extends QnALogNoteIndexCard {
  filePath: string;
  semanticCanvasPath: string | null;
}

export interface BuildNoteIndexOptions {
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
    new RegExp(`<!--\\s*${nsRe("segments-start")}\\b`, "i"),
    /^##\s+(?:原始材料|原始转写|逐字稿|录音原文|分段原始转写|回听时间轴|录音中实时大纲|Original material|Raw transcript|Verbatim transcript|Recording transcript|Segmented raw transcript|Playback timeline|Live outline while recording)\s*$/im,
  ];
  return markdown.slice(0, findFirstNoteBoundary(markdown, boundaries));
}

function extractLastLegacyPolishBlock(markdown: string): string {
  const matches = Array.from(markdown.matchAll(
    new RegExp(`^##\\s+(?:${labelPattern("mergedVersion").source})(?:（[^\\n]*）|\\([^\\n]*\\))?\\s*$`, "gim"),
  ));
  if (!matches.length) return markdown;
  const start = matches[matches.length - 1].index || 0;
  const tail = markdown.slice(start);
  return tail.slice(0, findFirstNoteBoundary(tail, [/^---\s*$/m]));
}

export function removeNoteIndex(markdown: unknown): string {
  return textValue(markdown)
    .replace(NOTE_INDEX_FENCED_PATTERN, "")
    .replace(NOTE_INDEX_LEGACY_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function extractIndexSource(markdown: unknown): string {
  const original = removeNoteIndex(markdown);
  const active = findActiveVersionBlock(original);
  let visible = active ? active.body : original;
  visible = stripLeadingFrontmatter(visible);
  if (!active) visible = extractLastLegacyPolishBlock(visible);
  visible = stripUtilityDetailsBlocks(stripUtilityTail(visible))
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

function normalizeTopicTitle(value: unknown): string {
  return clampText(stripMarkdownInline(value)
    .replace(/^\s*(?:\d+(?:\.\d+)*[.、)）]?|[一二三四五六七八九十百]+[、.．)）])\s*/, "")
    .replace(/^\s*(?:📌|📋|🧭|✨|⭐|✅|❗)+\s*/u, ""), 120);
}

function extractTopics(markdown: string): { topics: QnALogNoteIndexTopic[]; topicCount: number } {
  const rows: Array<{ level: number; heading: string; title: string }> = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const heading = stripMarkdownInline(match[2]);
    const title = normalizeTopicTitle(heading);
    if (!title || UTILITY_HEADING_RE.test(title)) continue;
    rows.push({ level: match[1].length, heading, title });
  }
  const preferredLevel = rows.some((row) => row.level === 2) ? 2 : 3;
  const seen = new Set<string>();
  const all: QnALogNoteIndexTopic[] = [];
  for (const row of rows) {
    if (row.level !== preferredLevel) continue;
    const key = row.title.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({ order: all.length + 1, title: row.title, heading: row.heading });
  }
  return { topics: all.slice(0, MAX_INDEX_TOPICS), topicCount: all.length };
}

function extractFallbackSummary(markdown: string, topics: readonly QnALogNoteIndexTopic[]): string {
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
    .replace(/^(?:综合纪要|研讨会|学习笔记|个人笔记|访谈纪要)\s*[·\-–—:]\s*/, "")
    .trim(), MAX_CORE_TITLE_CHARS);
}

function firstSentence(value: string): string {
  const match = /^(.{4,80}?)(?:[。！？!?；;]|$)/.exec(value.trim());
  return clampText(match ? match[1] : value, MAX_CORE_TITLE_CHARS);
}

function inferMeetingDate(markdown: string, explicit: unknown, noteTitle: unknown): string {
  const source = textValue(explicit).trim()
    || extractFrontmatterScalar(markdown, [NS_FM.time, "time", "日期", "date", "created"])
    || textValue(noteTitle);
  const match = /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(source);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}


export function buildNoteIndex(
  markdown: unknown,
  options: BuildNoteIndexOptions = {},
): QnALogNoteIndexCard | null {
  const fullMarkdown = textValue(markdown);
  const existingIndex = readNoteIndex(fullMarkdown, { includeFuture: true });
  if (existingIndex && "status" in existingIndex) return null;
  const source = extractIndexSource(fullMarkdown);
  if (!source || /^_?\[(?:无输出|版本内容为空)\]_?$/i.test(source)) return null;
  const extracted = extractTopics(source);
  const abstractSummary = extractAbstractSummary(source);
  const fallbackSummary = extractFallbackSummary(source, extracted.topics);
  const summary = isWeakIndexSummary(abstractSummary) && fallbackSummary.length > abstractSummary.length
    ? fallbackSummary
    : (abstractSummary || fallbackSummary);
  const h1 = /^#\s+(.+?)\s*$/m.exec(source)?.[1] || "";
  const titleCandidate = cleanCoreTitle(options.noteTitle || h1);
  const genericTitle = /^(?:综合纪要|研讨会|学习笔记|个人笔记|访谈纪要|导入|合并)?$/.test(titleCandidate);
  const title = genericTitle || titleCandidate.length < 4
    ? (firstSentence(summary) || extracted.topics[0]?.title || "会议纪要")
    : titleCandidate;
  const meetingDate = inferMeetingDate(fullMarkdown, options.meetingDate, options.noteTitle || h1);
  const transcriptSegments = readTranscriptBlocks(fullMarkdown).map(({ segment }) => segment);
  const knowledge = getKnowledgeSnapshot(fullMarkdown, transcriptSegments);
  const sourceRevision = `idx-${stableHash(JSON.stringify({
    title,
    meetingDate,
    source,
    knowledge: {
      snapshotId: knowledge.snapshotId,
      sourceRevision: knowledge.sourceRevision,
      status: knowledge.status,
      topics: knowledge.topics,
      decisions: knowledge.decisions,
      actions: knowledge.actions,
      questions: knowledge.questions,
    },
  }))}`;
  return {
    schemaVersion: 2,
    sourceRevision,
    generatedAt: options.generatedAt || new Date().toISOString(),
    meetingDate,
    core: { title, summary },
    topics: extracted.topics,
    topicCount: extracted.topicCount,
    omittedTopicCount: Math.max(0, extracted.topicCount - extracted.topics.length),
    knowledge,
  };
}

function validStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isKnowledgeIndex(value: unknown): value is NoteIndexKnowledge {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (row.snapshotId === null || typeof row.snapshotId === "string")
    && (row.sourceRevision === null || typeof row.sourceRevision === "string")
    && (row.status === "complete" || row.status === "partial" || row.status === "unavailable" || row.status === "stale")
    && Array.isArray(row.topics) && row.topics.every((topic) => {
      if (!topic || typeof topic !== "object" || Array.isArray(topic)) return false;
      const entry = topic as Record<string, unknown>;
      return typeof entry.id === "string" && typeof entry.title === "string"
        && typeof entry.summary === "string" && validStringArray(entry.evidence);
    })
    && validStringArray(row.decisions) && validStringArray(row.actions) && validStringArray(row.questions);
}

function isNoteIndexCard(value: unknown): value is QnALogNoteIndexCard {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const core = row.core as Record<string, unknown> | undefined;
  return row.schemaVersion === 2 && typeof row.sourceRevision === "string" && typeof row.generatedAt === "string"
    && typeof row.meetingDate === "string" && !!core && typeof core.title === "string" && typeof core.summary === "string"
    && Array.isArray(row.topics) && row.topics.every(isIndexTopic)
    && Number.isFinite(row.topicCount) && Number.isFinite(row.omittedTopicCount)
    && isKnowledgeIndex(row.knowledge);
}

function getKnowledgeSnapshot(markdown: string, segments: readonly Segment[]): NoteIndexKnowledge {
  const saved = readSelectedSessionKnowledge(markdown);
  if (!saved) return unavailableKnowledge();
  const knowledge = compactKnowledge(saved);
  const topicIds = new Set(saved.topics.map(({ id }) => id));
  const topicReferencesValid = [...saved.decisions, ...saved.actions, ...saved.questions]
    .every((item) => item.topicIds.every((id) => topicIds.has(id)));
  if (!topicReferencesValid) return { ...knowledge, status: "stale" };
  if (segments.length === 0) return knowledge;
  const currentRevision = getTranscriptSourceRevision(segments);
  const currentSourcesById = new Map<string, KnowledgeSourceRevision>();
  const sourceConflicts = new Set<string>();
  for (const segment of segments) {
    const record = segment.transcript;
    if (!record) continue;
    const current = record.revisions.find((revision) => revision.revision === record.currentRevision);
    if (!current) continue;
    const source = {
      segmentId: record.id,
      revision: current.revision,
      normalizationRevision: current.normalizationRevision,
    };
    const previous = currentSourcesById.get(source.segmentId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(source)) sourceConflicts.add(source.segmentId);
    else currentSourcesById.set(source.segmentId, source);
  }
  const currentSources = [...currentSourcesById.values()].sort((left, right) => left.segmentId.localeCompare(right.segmentId));
  const savedSources = [...saved.sources].sort((left, right) => left.segmentId.localeCompare(right.segmentId));
  if (sourceConflicts.size || currentRevision !== saved.sourceRevision || JSON.stringify(currentSources) !== JSON.stringify(savedSources)) {
    return { ...knowledge, status: "stale" };
  }
  const utteranceContent = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const segment of segments) {
    const record = segment.transcript;
    if (!record) continue;
    const revision = record.revisions.find((entry) => entry.revision === record.currentRevision);
    for (const utterance of revision?.utterances || []) {
      const content = JSON.stringify(utterance);
      const previous = utteranceContent.get(utterance.id);
      if (previous !== undefined && previous !== content) conflicts.add(utterance.id);
      else utteranceContent.set(utterance.id, content);
    }
  }
  const utteranceIds = new Set(utteranceContent.keys());
  const evidenceIds = [
    ...saved.topics.flatMap(({ evidence }) => evidence),
    ...saved.decisions.flatMap(({ evidence }) => evidence),
    ...saved.actions.flatMap(({ evidence }) => evidence),
    ...saved.questions.flatMap(({ evidence }) => evidence),
  ];
  return evidenceIds.every((id) => utteranceIds.has(id) && !conflicts.has(id))
    ? knowledge
    : { ...knowledge, status: "stale" };
}

function compactKnowledge(saved: SessionKnowledge): NoteIndexKnowledge {
  return {
    snapshotId: saved.id,
    sourceRevision: saved.sourceRevision,
    status: saved.status,
    topics: saved.topics.map(({ id, title, summary, evidence }) => ({ id, title, summary, evidence: [...evidence] })),
    decisions: saved.decisions.map(({ id }) => id),
    actions: saved.actions.map(({ id }) => id),
    questions: saved.questions.map(({ id }) => id),
  };
}

function unavailableKnowledge(): NoteIndexKnowledge {
  return { snapshotId: null, sourceRevision: null, status: "unavailable", topics: [], decisions: [], actions: [], questions: [] };
}

function isIndexTopic(value: unknown): value is QnALogNoteIndexTopic {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Number.isFinite(Number(row.order)) && typeof row.title === "string" && typeof row.heading === "string";
}

export function readNoteIndex(markdown: unknown): QnALogNoteIndexCard | null;
export function readNoteIndex(markdown: unknown, options: { includeFuture: true }): NoteIndexReadResult | null;
export function readNoteIndex(
  markdown: unknown,
  options?: { includeFuture: true },
): NoteIndexReadResult | null {
  const text = textValue(markdown);
  const match = NOTE_INDEX_FENCED_PATTERN.exec(text) || NOTE_INDEX_LEGACY_PATTERN.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    if (typeof parsed.schemaVersion === "number" && parsed.schemaVersion > 2) {
      return options?.includeFuture ? { status: "future-schema", schemaVersion: parsed.schemaVersion } : null;
    }
    const core = parsed.core as Record<string, unknown> | undefined;
    if (parsed.schemaVersion === 1 && typeof parsed.sourceRevision === "string" && core
      && typeof core.title === "string" && typeof core.summary === "string"
      && Array.isArray(parsed.topics) && parsed.topics.every(isIndexTopic)) {
      const migrated: QnALogNoteIndexCard = {
        schemaVersion: 2,
        sourceRevision: parsed.sourceRevision,
        generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
        meetingDate: typeof parsed.meetingDate === "string" ? parsed.meetingDate : "",
        core: { title: core.title, summary: core.summary },
        topics: parsed.topics,
        topicCount: Number.isFinite(parsed.topicCount) ? Number(parsed.topicCount) : parsed.topics.length,
        omittedTopicCount: Number.isFinite(parsed.omittedTopicCount) ? Number(parsed.omittedTopicCount) : 0,
        knowledge: unavailableKnowledge(),
      };
      LEGACY_INDEX_CARDS.add(migrated);
      return migrated;
    }
    return isNoteIndexCard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function serializeNoteIndex(index: QnALogNoteIndexCard): string {
  // JSON 与标记都要安全：`<`/`>`/`--` 防旧注释格式与 HTML 解析，反引号防截断 json 围栏。
  const json = JSON.stringify(index)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/`/g, "\\u0060")
    .replace(/--/g, "\\u002d\\u002d");
  return [
    QNALOG_NOTE_INDEX_START,
    "",
    "<details>",
    `<summary>${labelText("indexData")}</summary>`,
    "",
    "```json",
    json,
    "```",
    "",
    "</details>",
    QNALOG_NOTE_INDEX_END,
  ].join("\n");
}

export function upsertNoteIndex(markdown: unknown, index: QnALogNoteIndexCard): string {
  const text = textValue(markdown);
  const existing = readNoteIndex(text, { includeFuture: true });
  if (existing && "status" in existing) return text;
  const existingCard = existing && !("status" in existing) ? existing : null;
  const block = serializeNoteIndex(index);
  const hasFenced = NOTE_INDEX_FENCED_PATTERN.test(text);
  // Contents unchanged and already fenced means no write; legacy blocks upgrade naturally.
  if (existingCard && !LEGACY_INDEX_CARDS.has(existingCard) && existingCard.sourceRevision === index.sourceRevision && hasFenced) return text;
  if (hasFenced) return text.replace(NOTE_INDEX_FENCED_PATTERN, () => block);
  if (NOTE_INDEX_LEGACY_PATTERN.test(text)) return text.replace(NOTE_INDEX_LEGACY_PATTERN, () => block);
  return `${text.trimEnd()}\n\n${block}\n`;
}

export function resolveNoteIndex(
  index: QnALogNoteIndexCard,
  filePath: unknown,
  semanticCanvasPath: unknown,
): ResolvedNoteIndex {
  return {
    ...index,
    filePath: textValue(filePath),
    semanticCanvasPath: textValue(semanticCanvasPath) || null,
  };
}
