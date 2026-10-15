import { NS_FM, NS_FM_TOPIC_LAYOUT, NS_TYPE_TOPIC } from "../shared/namespace";
import { t } from "../shared/i18n";
import { stripBlockMarkers } from "./topic-block-markers";

export type TopicBasis = "overview" | "body";
export type TopicOpenKind = "question" | "action" | "bug";
export type TopicSection = "概要" | "进展脉络" | "分歧与待核实" | "未决问题与未完成行动" | "未决问题与行动" | "时间线" | "来源笔记" | "待整理";
export interface TopicMember { path: string; title: string; sourceId: string; date?: string; summary?: string }
export interface TopicThread { id: string; title: string; summary: string; points: Array<{ id: string; text: string; sources: string[] }> }
/** Why a stance has no verified member source or date: pending verification, text not grounded in its member, or taken from page narrative. */
export type TopicPositionProvenance = "source-pending" | "unverified" | "page-narrative";
/** One side of a disagreement. `fromPage` marks the existing-page side; `footnotes` keeps that block's own footnote IDs; `sourceIds` lists every member it cites. */
export interface TopicDisagreementPosition { text: string; sourceId: string; date?: string; provenance?: TopicPositionProvenance; sourceTitle?: string; sourceIds?: string[]; footnotes?: string[]; fromPage?: boolean }
export interface TopicDisagreement { id: string; subject: string; positions: TopicDisagreementPosition[] }
export interface TopicOpenItem { id: string; kind: TopicOpenKind; text: string; sources: string[]; done: boolean }
export interface TopicPageV2Model {
  overview: string; threads: TopicThread[]; disagreements: TopicDisagreement[];
  open: TopicOpenItem[]; unsorted: string[]; validationWarnings?: string[];
}
export interface TopicPageLabels {
  overview: string; progress: string; disagreements: string; open: string;
  timeline: string; sources: string; conflict: string;
  openQuestion: string; openAction: string; openBug: string;
}
export interface TopicBlockIndexEntry { id: string; kind: ParsedTopicBlock["type"]; headingPath: string[]; ordinal: number; textHash: string; normalizedPreview: string }
export function isLegacyTopicStatusLine(line: string, prefixes: readonly string[]): boolean {
  if (!prefixes.some((prefix) => line.startsWith(prefix))) return false;
  return /^(?:\*\*状态\*\*：(?:进行中|已完成|搁置|待定)|\*\*Status\*\*: (?:Active|Done|Paused|Unknown)) · \*\*(?:最近更新|Updated)\*\* (?:\d{4}-\d{2}-\d{2}|—) · \d+(?:篇笔记| notes)$/u.test(line);
}
export const TOPIC_MACHINE_PROPERTY_KEYS = [NS_FM.topicTagAliases, NS_FM.topicBlocks, NS_FM.topicHash, NS_FM.topicUndoSnapshot] as const;
export interface ParsedTopicBlock { id: string; type: "overview" | "thread-summary" | "point" | "disagreement" | "open" | "other"; text: string; start: number; end: number; headingPath?: string[]; ordinal?: number }
export interface TopicPage {
  id: string;
  title: string;
  tags: string[];
  tagAliases?: Record<string, string[]>;
  members: string[];
  memberLinks: string[];
  excluded: string[];
  basis: TopicBasis;
  created: string;
  updated: string;
  appliedHash?: string;
  undoSnapshot?: string;
  cacheStatus?: "valid" | "missing" | "corrupt" | "stale";
  legacyMachineProperties?: boolean;
  body: string;
  layout?: number;
}
export type TopicOperation =
  | { type: "add_item"; section: TopicSection; text: string; sourceId: string; date?: string }
  | { type: "annotate_item"; targetId: string; text: string; sourceId: string }
  | { type: "add_conflict"; text: string; sourceId: string; date?: string }
  | { type: "resolve_question"; targetId: string; text: string; sourceId: string }
  | { type: "add_timeline"; text: string; sourceId: string; date: string }
  | { type: "add_point"; thread: string; text: string; sources: string[]; sourceId: string }
  | { type: "add_thread"; title: string; summary: string; points: Array<{ text: string; sources: string[] }>; sourceId: string }
  | { type: "revise_block"; blockId: string; newText: string; reason: string; expectedText?: string; sourceId: string }
  | { type: "remove_block"; blockId: string; expectedText: string; sourceId: string }
  | { type: "remove_member"; path: string }
  | { type: "add_disagreement"; subject: string; relatedBlockId?: string; positions: TopicDisagreementPosition[]; sourceId: string }
  | { type: "add_open"; kind: TopicOpenKind; text: string; sources: string[]; sourceId: string }
  | { type: "resolve_open"; blockId: string; note: string; expectedText?: string; sourceId: string };
export interface AppliedTopicOperation { operation: TopicOperation; blockId: string | null; location: TopicSection }
export interface ApplyTopicOpsResult { markdown: string; applied: AppliedTopicOperation[]; skipped: Array<{ id: string; reason: "block-modified" }>; duplicateBlockIds?: string[]; blockIndex?: TopicBlockIndexEntry[] }

export const TOPIC_SECTIONS: readonly TopicSection[] = ["概要", "进展脉络", "分歧与待核实", "未决问题与未完成行动", "时间线", "来源笔记", "待整理"];
const ENGLISH_SECTION: Record<TopicSection, string> = {
  "概要": "Overview", "进展脉络": "Progress thread", "分歧与待核实": "Disagreements and verification", "未决问题与未完成行动": "Open questions and actions", "未决问题与行动": "Open questions and actions", "时间线": "Timeline", "来源笔记": "Source notes", "待整理": "Unsorted",
};

function withoutBlockId(text: string, _id: string): string { return stripBlockMarkers(text); }
function yamlString(value: string): string { return JSON.stringify(value); }
function yamlStrings(values: readonly string[]): string { return `[${values.map(yamlString).join(", ")}]`; }
function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}
export function hashTopicPage(markdown: string): string {
  const content = removeTopicMachineProperties(String(markdown));
  let hash = 2166136261;
  for (let index = 0; index < content.length; index++) hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function frontmatter(markdown: string): { text: string; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return match ? { text: match[1], body: markdown.slice(match[0].length) } : { text: "", body: markdown };
}
function parseYamlValue(raw: string): unknown {
  const text = raw.trim();
  try { return JSON.parse(text) as unknown; } catch { return text.replace(/^['"]|['"]$/g, ""); }
}
function parseTopicFrontmatter(text: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^([\w-]+):\s*(.*)$/);
    if (!match) continue;
    const values: string[] = [];
    let next = index + 1;
    if (!match[2].trim()) {
      while (next < lines.length && /^\s+-\s+/.test(lines[next])) {
        const value = parseYamlValue(lines[next].replace(/^\s+-\s+/, ""));
        if (typeof value === "string") values.push(value);
        next++;
      }
    }
    if (values.length) {
      fields[match[1]] = values;
      index = next - 1;
    } else fields[match[1]] = parseYamlValue(match[2]);
  }
  return fields;
}
function sourceCitation(sourceId: string): string {
  return sourceId.startsWith("[[") ? sourceId : `[[${sourceId}]]`;
}
function parseArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function sectionHeading(section: TopicSection, english = false): string { return `## ${section} / ${ENGLISH_SECTION[section]}`; }
export function topicSectionEnglishLabel(section: TopicSection): string { return ENGLISH_SECTION[section]; }
function sectionRange(lines: string[], section: TopicSection): { start: number; end: number } | null {
  const heading = sectionHeading(section);
  let start = lines.findIndex((line) => line.trim() === heading || line.trim() === `## ${section}` || line.trim() === `## ${ENGLISH_SECTION[section]}`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  return { start, end };
}
function sectionForLine(lines: readonly string[], lineIndex: number): TopicSection | null {
  return TOPIC_SECTIONS.find((section) => {
    const range = sectionRange([...lines], section);
    return range !== null && lineIndex > range.start && lineIndex < range.end;
  }) || null;
}
function ensureSections(markdown: string): string {
  const text = frontmatter(markdown);
  if (parseTopicFrontmatter(text.text)[NS_FM_TOPIC_LAYOUT] === 2) return markdown;
  const lines = text.body.split("\n");
  for (const section of TOPIC_SECTIONS) if (!sectionRange(lines, section)) lines.push("", sectionHeading(section));
  return `${text.text ? `---\n${text.text}\n---\n` : ""}${lines.join("\n")}`;
}

export function createTopicPage(input: { id: string; title: string; tags: string[]; members: TopicMember[]; basis: TopicBasis; created?: string; updated?: string }): TopicPage {
  const now = new Date().toISOString();
  const members = input.members.map((member) => member.path);
  const memberLinks = input.members.map((member) => `[[${member.path.replace(/\.md$/i, "")}|${member.title}]]`);
  const body = appendTopicMemberLinks(TOPIC_SECTIONS.map((section) => `${sectionHeading(section)}\n`).join("\n"), memberLinks);
  return { id: input.id, title: input.title, tags: [...new Set(input.tags)], members, memberLinks, excluded: [], basis: input.basis, created: input.created || now, updated: input.updated || now, body };
}

export function serializeTopicPage(page: TopicPage): string {
  const fm = [
    `${NS_FM.type}: ${yamlString(NS_TYPE_TOPIC)}`,
    `${NS_FM.topicId}: ${yamlString(page.id)}`,
    `${NS_FM.topicTags}: ${yamlStrings(page.tags)}`,
    `${NS_FM.topicMembers}: ${yamlStrings(page.memberLinks)}`,
    `${NS_FM.topicExcluded}: ${yamlStrings(page.excluded)}`,
    `${NS_FM.topicBasis}: ${yamlString(page.basis)}`,
    `${NS_FM.topicCreated}: ${yamlString(page.created)}`,
    `${NS_FM.topicUpdated}: ${yamlString(page.updated)}`,
    ...(page.layout === 2 ? [`${NS_FM_TOPIC_LAYOUT}: 2`, `cssclasses: qnalog-topic`] : []),
  ].join("\n");
  const body = (page.layout === 2 ? page.body : ensureSections(page.body)).replace(/^---\n[\s\S]*?\n---\n/, "");
  return `---\n${fm}\n---\n\n# ${page.title}\n\n${body.trimStart()}`;
}

export function parseTopicPage(markdown: string, path = ""): TopicPage | null {
  const split = frontmatter(markdown);
  const fields = parseTopicFrontmatter(split.text);
  const topicIdValue = fields[NS_FM.topicId];
  if (fields[NS_FM.type] !== NS_TYPE_TOPIC || typeof topicIdValue !== "string") return null;
  const topicId = topicIdValue;
  const memberLinks = parseArray(fields[NS_FM.topicMembers]);
  const members = memberLinks.map((link) => {
    const target = link.match(/^\[\[([^|\]]+)/)?.[1] || "";
    return target && !/\.md$/i.test(target) ? `${target}.md` : target;
  }).filter(Boolean);
  const created = fields[NS_FM.topicCreated];
  const updated = fields[NS_FM.topicUpdated];
  const appliedHash = fields[NS_FM.topicHash];
  const undoSnapshot = fields[NS_FM.topicUndoSnapshot];
  return {
    id: topicId,
    title: split.body.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.split("/").pop()?.replace(/\.md$/i, "") || topicId,
    tags: parseArray(fields[NS_FM.topicTags]),
    tagAliases: (() => { const value = fields[NS_FM.topicTagAliases]; if (typeof value !== "string") return {}; try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string[]> : {}; } catch { return {}; } })(),
    members, memberLinks,
    excluded: parseArray(fields[NS_FM.topicExcluded]),
    basis: fields[NS_FM.topicBasis] === "body" ? "body" : "overview",
    created: typeof created === "string" ? created : "",
    updated: typeof updated === "string" ? updated : "",
    layout: fields[NS_FM_TOPIC_LAYOUT] === 2 ? 2 : undefined,
    appliedHash: typeof appliedHash === "string" ? appliedHash : undefined,
    undoSnapshot: typeof undoSnapshot === "string" ? undoSnapshot : undefined,
    legacyMachineProperties: TOPIC_MACHINE_PROPERTY_KEYS.some((key) => Object.prototype.hasOwnProperty.call(fields, key)),
    body: split.body,
  };
}

const DEFAULT_V2_LABELS: TopicPageLabels = {
  overview: "概要", progress: "进展脉络", disagreements: "分歧与待核实",
  open: "未决问题与行动", timeline: "时间线", sources: "来源笔记", conflict: "关于这个问题的不同说法",
  openQuestion: "问题", openAction: "行动", openBug: "缺陷",
};

export function isTopicOpenKind(value: string): value is TopicOpenKind {
  return value === "question" || value === "action" || value === "bug";
}

export function topicOpenKindLabel(kind: TopicOpenKind, labels: Pick<TopicPageLabels, "openQuestion" | "openAction" | "openBug"> = DEFAULT_V2_LABELS): string {
  return kind === "question" ? labels.openQuestion : kind === "bug" ? labels.openBug : labels.openAction;
}

export function topicLabelSeparator(label: string): string {
  return /\p{Script=Han}/u.test(label) ? "：" : ": ";
}

function sourceFootnoteId(sourceId: string): string { return `s${stableHash(sourceId).slice(0, 4)}`; }
function inlineFootnotes(sources: readonly string[]): string {
  return [...new Set(sources)].map((source) => `[^${sourceFootnoteId(source)}]`).join("");
}
function ensureSentencePunctuation(text: string): string {
  const value = text.trim();
  return /[。！？.!?]$/u.test(value) ? value : `${value}${/\p{Script=Han}/u.test(value) ? "。" : "."}`;
}
export function renderTopicOpenMarkdown(item: Pick<TopicOpenItem, "kind" | "text" | "sources" | "done">, labels: Pick<TopicPageLabels, "openQuestion" | "openAction" | "openBug"> = DEFAULT_V2_LABELS, blockId?: string): string {
  const kind = topicOpenKindLabel(item.kind, labels);
  const line = `- [${item.done ? "x" : " "}] ${kind}${topicLabelSeparator(kind)}${ensureSentencePunctuation(item.text)}${inlineFootnotes(item.sources)}`;
  return blockId ? withoutBlockId(line, blockId) : line;
}
export function summarizeForTimeline(overview: string, options: { maxChars?: number; title?: string } = {}): string {
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? 60));
  const clean = String(overview || "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match: string, target: string, label?: string) => label || target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*`~]/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=$|[^\p{L}\p{N}])/gu, "$1")
    .replace(/^\s*\[(?:说话人\s*\d*|speaker\s*\d+|s\d+)\]\s*/i, "")
    .replace(/^\s*(?:说话人\s*\d*|speaker\s*\d+|s\d+)\s*[：:]\s*/i, "")
    .replace(/\r/g, "")
    .trim();
  const sentence = clean.match(/^[\s\S]*?[。！？.!?\n]/u)?.[0].trim() || clean;
  const content = sentence || options.title?.trim() || "";
  const characters = [...content];
  if (characters.length <= maxChars) return content;
  const limit = maxChars - 1;
  let boundary = -1;
  for (let index = 0; index < limit; index++) {
    if (/[。！？.!?]/u.test(characters[index]) || /\s/u.test(characters[index])) boundary = index;
  }
  const end = boundary >= 0 ? (/[。！？.!?]/u.test(characters[boundary]) ? boundary + 1 : boundary) : limit;
  return `${characters.slice(0, end).join("").trimEnd()}…`;
}
function quote(text: string): string { return text.split("\n").map((line) => `> ${line}`).join("\n"); }

/** Deterministically renders a v2 page and stores block addresses in page properties. */
export function renderTopicPage(model: TopicPageV2Model, members: readonly TopicMember[], labels: Partial<TopicPageLabels> = {}): string {
  const label = { ...DEFAULT_V2_LABELS, ...labels };
  const allSourceIds = new Set(members.map((member) => member.sourceId));
  const sections: string[] = [`> [!abstract] ${label.overview}`, ...quote(model.overview.trim()).split("\n"), "", `## ${label.progress}`];
  for (const thread of model.threads.slice(0, 6)) {
    sections.push("", `### ${thread.title}`, thread.summary.trim());
    for (const point of thread.points.slice(0, 6)) sections.push(`- ${ensureSentencePunctuation(point.text)}${inlineFootnotes(point.sources.filter((source) => allSourceIds.has(source)))}`);
  }
  if (model.disagreements.length) {
    sections.push("", `## ${label.disagreements}`);
    const memberBySource = new Map(members.map((member) => [member.sourceId, member]));
    for (const disagreement of model.disagreements) {
      sections.push("", `> [!warning] ${disagreement.subject || label.conflict}`);
      for (const position of disagreement.positions) {
        const sourceMember = memberBySource.get(position.sourceId);
        if (sourceMember) sections.push(`> - ${sourceMember.date ? `**${sourceMember.date}**：` : ""}${position.text}${inlineFootnotes(position.sourceIds?.length ? position.sourceIds : [sourceMember.sourceId])}`);
      }
    }
  }
  if (model.open.length) {
    sections.push("", `## ${label.open}`);
    for (const item of model.open) sections.push(renderTopicOpenMarkdown({ ...item, sources: item.sources.filter((source) => allSourceIds.has(source)) }, label));
  }
  if (model.unsorted.length) sections.push("", `## 待整理`, ...model.unsorted.map((item) => `- ${item}`));
  sections.push("", `## ${label.timeline}`);
  const timeline = [...members].sort((a, b) => (a.date || "9999-99-99").localeCompare(b.date || "9999-99-99") || a.title.localeCompare(b.title));
  for (const member of timeline) sections.push(`- ${member.date || "—"} · [[${member.path.replace(/\.md$/i, "")}|${member.title}]] — ${summarizeForTimeline(member.summary || "", { title: member.title })}`);
  sections.push("", `## ${label.sources}`);
  const sorted = [...members].sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.title.localeCompare(b.title));
  for (const member of sorted) sections.push(`[^${sourceFootnoteId(member.sourceId)}]: [[${member.path.replace(/\.md$/i, "")}|${member.title}]]${member.date ? ` · ${member.date}` : ""}`);
  return sections.join("\n").trimEnd() + "\n";
}

const TOPIC_BLOCK_INDEX_KEY = NS_FM.topicBlocks;
export const TOPIC_BLOCK_SIMILARITY_THRESHOLD = 0.6;
function normalizeTopicBlockText(text: string): string {
  return text.replace(/\s+\^tpc-[\da-f]{6}\s*$/gim, "").replace(/\[\^[^\]]+\]/g, "")
    .replace(/^\s*>\s?/gm, "").replace(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?/, "")
    .replace(/[*_`~]/g, "").replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "$1")
    .normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
}
function topicTextHash(text: string): string {
  let hash = 2166136261;
  const normalized = normalizeTopicBlockText(text);
  for (let index = 0; index < normalized.length; index++) hash = Math.imul(hash ^ normalized.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function collectTopicBlocks(body: string, offset: number): ParsedTopicBlock[] {
  const lines = body.split("\n");
  const starts: number[] = [];
  let cursor = 0;
  for (const line of lines) { starts.push(cursor); cursor += line.length + 1; }
  const blocks: ParsedTopicBlock[] = [];
  let headingPath: string[] = [];
  let ordinalByKind = new Map<string, number>();
  const add = (type: ParsedTopicBlock["type"], text: string, first: number, last: number) => {
    const path = [...headingPath];
    const key = `${type}\0${path.join("/")}`;
    const ordinal = ordinalByKind.get(key) || 0;
    ordinalByKind.set(key, ordinal + 1);
    const cleanedText = text.replace(/\s+\^tpc-[\da-f]{6}\s*$/i, "");
    blocks.push({ id: "", type, text: cleanedText, start: offset + starts[first], end: offset + starts[last] + lines[last].length, headingPath: path, ordinal });
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      headingPath = headingPath.slice(0, heading[1].length - 1);
      headingPath.push(heading[2]);
      continue;
    }
    if (/^>\s*\[!abstract\]/i.test(line)) {
      const paragraph: string[] = [];
      let last = index;
      for (let next = index + 1; next < lines.length && /^>/.test(lines[next]); next++) {
        last = next;
        if (!/^>\s*\*\*/.test(lines[next])) paragraph.push(lines[next].replace(/^>\s?/, ""));
      }
      add("overview", paragraph.join("\n").trim(), index, last);
      index = last;
      continue;
    }
    if (/^>\s*\[!warning\]/i.test(line)) {
      let next = index + 1;
      while (next < lines.length && /^>\s*-/.test(lines[next])) { add("disagreement", lines[next].replace(/^>\s*-\s*/, ""), next, next); next++; }
      index = next - 1;
      continue;
    }
    if (/^\s*[-*]\s+(?:\[[ xX]\]\s*)?\S/.test(line)) {
      const type = /^\s*[-*]\s+\[[ xX]\]/.test(line) ? "open" : "point";
      add(type, line, index, index);
      continue;
    }
    if (headingPath.some((value) => /^Progress thread$|^进展脉络$/.test(value)) && line.trim() && !/^>/.test(line)) {
      if (!/^\s*[-*]\s+/.test(line) && !/^#{1,6}\s/.test(line) && !/^\[\^/.test(line)) add("thread-summary", line, index, index);
    }
  }
  return blocks.filter((block) => normalizeTopicBlockText(block.text));
}
function readTopicBlockIndex(markdown: string): TopicBlockIndexEntry[] {
  const value = parseTopicFrontmatter(frontmatter(markdown).text)[TOPIC_BLOCK_INDEX_KEY];
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is TopicBlockIndexEntry => !!entry && typeof entry === "object" && typeof (entry as TopicBlockIndexEntry).id === "string" && typeof (entry as TopicBlockIndexEntry).textHash === "string") : [];
  } catch { return []; }
}
function bigramOverlap(left: string, right: string): number {
  const pairs = (value: string) => { const chars = Array.from(normalizeTopicBlockText(value)); const set = new Set<string>(); for (let i = 0; i + 1 < chars.length; i++) set.add(chars[i] + chars[i + 1]); return set; };
  const a = pairs(left), b = pairs(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const pair of a) if (b.has(pair)) common++;
  return common / Math.min(a.size, b.size);
}
export function locateBlock(page: string, entry: TopicBlockIndexEntry, candidates = collectTopicBlocks(frontmatter(page).body, page.length - frontmatter(page).body.length)): ParsedTopicBlock | undefined {
  const exact = candidates.find((block) => block.type === entry.kind && topicTextHash(block.text) === entry.textHash);
  if (exact) return exact;
  const sameHeading = candidates.filter((block) => block.type === entry.kind && JSON.stringify(block.headingPath) === JSON.stringify(entry.headingPath));
  const similar = sameHeading.map((block) => ({ block, score: bigramOverlap(block.text, entry.normalizedPreview) })).sort((a, b) => b.score - a.score)[0];
  if (similar && similar.score >= TOPIC_BLOCK_SIMILARITY_THRESHOLD) return similar.block;
  return sameHeading.find((block) => block.ordinal === entry.ordinal);
}
export function buildTopicBlockIndex(markdown: string, previousIndex?: readonly TopicBlockIndexEntry[]): TopicBlockIndexEntry[] {
  const split = frontmatter(markdown);
  const candidates = collectTopicBlocks(split.body, markdown.length - split.body.length);
  const old = previousIndex || readTopicBlockIndex(markdown);
  const used = new Set<string>();
  return candidates.map((block) => {
    const previous = old.find((entry) => !used.has(entry.id) && locateBlock(markdown, entry, candidates) === block);
    const id = previous?.id || stableTopicBlockId(block.type, block.headingPath?.join("/") || "", block.text, used);
    used.add(id);
    const normalized = normalizeTopicBlockText(block.text);
    return { id, kind: block.type, headingPath: block.headingPath || [], ordinal: block.ordinal || 0, textHash: topicTextHash(block.text), normalizedPreview: Array.from(normalized).slice(0, 40).join("") };
  });
}
export function updateTopicBlockIndex(markdown: string): string {
  const entries = buildTopicBlockIndex(markdown);
  return updateTopicFrontmatter(markdown, { [TOPIC_BLOCK_INDEX_KEY]: JSON.stringify(entries) });
}

/** Removes legacy machine-only page properties while preserving the complete body. */
export function removeTopicMachineProperties(markdown: string): string {
  const match = markdown.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/);
  if (!match) return markdown;
  const lines = match[2].split(/\r?\n/);
  const kept: string[] = [];
  let skippingList = false;
  for (const line of lines) {
    const key = line.match(/^([\w-]+):/)?.[1];
    if (key && (TOPIC_MACHINE_PROPERTY_KEYS as readonly string[]).includes(key)) {
      skippingList = !/^([\w-]+):\s*\S/.test(line);
      continue;
    }
    if (skippingList && /^\s+-\s+/.test(line)) continue;
    skippingList = false;
    kept.push(line);
  }
  return `${match[1]}${kept.join("\n")}${match[3]}${markdown.slice(match[0].length)}`;
}

export function readLegacyTopicMachineProperties(markdown: string): {
  tagAliases: Record<string, string[]>; blocks: TopicBlockIndexEntry[]; pageHash?: string; lastSnapshot?: string;
} {
  const fields = parseTopicFrontmatter(frontmatter(markdown).text);
  const parseObject = (value: unknown): Record<string, string[]> => {
    if (typeof value !== "string") return {};
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((item) => typeof item === "string")));
    } catch { return {}; }
  };
  return {
    tagAliases: parseObject(fields[NS_FM.topicTagAliases]),
    blocks: readTopicBlockIndex(markdown),
    ...(typeof fields[NS_FM.topicHash] === "string" ? { pageHash: fields[NS_FM.topicHash] as string } : {}),
    ...(typeof fields[NS_FM.topicUndoSnapshot] === "string" ? { lastSnapshot: fields[NS_FM.topicUndoSnapshot] as string } : {}),
  };
}

export function withTopicBlockIndex(markdown: string, blocks: readonly TopicBlockIndexEntry[]): string {
  return updateTopicFrontmatter(markdown, { [TOPIC_BLOCK_INDEX_KEY]: JSON.stringify(blocks) });
}

/** Extracts blocks using the page property index; legacy inline anchors are accepted for migration only. */
export function topicBlockHeadingLabel(markdown: string, id: string): string {
  return parseTopicPageBlocks(markdown).find((block) => block.id === id)?.headingPath?.filter((part) => !/^#/.test(part)).join(" › ") || "";
}

export function parseTopicPageBlocks(markdown: string): ParsedTopicBlock[] {
  const split = frontmatter(markdown);
  const offset = markdown.length - split.body.length;
  const candidates = collectTopicBlocks(split.body, offset);
  const index = readTopicBlockIndex(markdown);
  if (!index.length) return candidates.map((block) => {
    const legacyId = markdown.slice(block.start, block.end).match(/\^(tpc-[\da-f]{6})\b/i)?.[1];
    return { ...block, id: legacyId || stableTopicBlockId(block.type, block.headingPath?.join("/") || "", block.text, new Set()) };
  });
  return index.flatMap((entry) => {
    const located = locateBlock(markdown, entry, candidates);
    return located ? [{ ...located, id: entry.id }] : [];
  });
}

export function topicBlockSourcePaths(markdown: string, block: ParsedTopicBlock): string[] {
  const footnotes = new Set([...block.text.matchAll(/\[\^([^\]]+)\]/g)].map((match) => match[1]));
  if (!footnotes.size) return [];
  const paths = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\[\^([^\]]+)\]:\s*.*?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/);
    if (match && footnotes.has(match[1])) paths.add(/\.md$/i.test(match[2]) ? match[2] : `${match[2]}.md`);
  }
  return [...paths];
}

/** Returns footnote IDs referenced in the page body, excluding frontmatter and definition rows. */
export function citedFootnoteIds(markdown: string): Set<string> {
  const cited = new Set<string>();
  for (const line of frontmatter(markdown).body.split(/\r?\n/)) {
    if (/^\s*\[\^[^\]]+\]:/.test(line)) continue;
    for (const match of line.matchAll(/\[\^([^\]]+)\]/g)) cited.add(match[1]);
  }
  return cited;
}

/** Returns footnote IDs whose definition links point to the given topic member. */
export function memberFootnoteIds(markdown: string, memberPath: string): string[] {
  const normalizedMemberPath = normalizeTopicMemberPath(memberPath);
  const ids = new Set<string>();
  for (const line of frontmatter(markdown).body.split(/\r?\n/)) {
    const match = line.match(/^\s*\[\^([^\]]+)\]:\s*.*?\[\[([^|\]]+)(?:\|[^\]]*)?\]\]/);
    if (match && normalizeTopicMemberPath(match[2]) === normalizedMemberPath) ids.add(match[1]);
  }
  return [...ids];
}

/** Returns member paths with at least one footnote referenced in the page body. */
export function contributingMemberPaths(markdown: string, members: readonly string[]): Set<string> {
  const page = parseTopicPage(markdown);
  if (page?.layout !== 2) return new Set();
  const citedIds = citedFootnoteIds(markdown);
  const contributing = new Set<string>();
  for (const member of members) {
    const normalized = normalizeTopicMemberPath(member);
    if (memberFootnoteIds(markdown, normalized).some((id) => citedIds.has(id))) contributing.add(normalized);
  }
  return contributing;
}

/** Lists v2 page members that have no footnote cited by a topic block. */
export function noContributionMembers(page: TopicPage, markdown: string): string[] {
  if (page.layout !== 2) return [];
  const contributing = contributingMemberPaths(markdown, page.members);
  return page.members.filter((path) => !contributing.has(normalizeTopicMemberPath(path)));
}

function normalizeTopicMemberPath(path: string): string {
  const normalized = String(path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return /\.md$/i.test(normalized) ? normalized : `${normalized}.md`;
}

function memberLinkTarget(value: string): string {
  const target = value.match(/^\s*\[\[([^|\]]+)/)?.[1] || "";
  return normalizeTopicMemberPath(target);
}

function removeTopicMember(markdown: string, memberPath: string): string {
  const normalizedMemberPath = normalizeTopicMemberPath(memberPath);
  const citedIds = citedFootnoteIds(markdown);
  if (memberFootnoteIds(markdown, normalizedMemberPath).some((id) => citedIds.has(id))) {
    throw new Error(t("This member is still cited by topic content and cannot be removed."));
  }
  const parsed = frontmatter(markdown);
  const lines = parsed.body.split("\n");
  const removeIndexes = new Set<number>();
  for (const section of ["时间线", "来源笔记"] as const) {
    const range = sectionRange(lines, section);
    if (!range) continue;
    for (let index = range.start + 1; index < range.end; index++) {
      const line = lines[index];
      const timelineRow = section === "时间线" && /^\s*-\s*(?:\d{4}-\d{2}-\d{2}|—)\s*[·—-]\s*\[\[/.test(line);
      const sourceRow = section === "来源笔记" && (/^\s*-\s*\[\[/.test(line) || /^\[\^[^\]]+\]:/.test(line));
      if ((timelineRow || sourceRow) && [...line.matchAll(/\[\[([^|\]]+)/g)].some((match) => normalizeTopicMemberPath(match[1]) === normalizedMemberPath)) removeIndexes.add(index);
    }
  }
  const body = lines.filter((_line, index) => !removeIndexes.has(index)).join("\n");
  const result = `${parsed.text ? `---\n${parsed.text}\n---\n` : ""}${body}`;
  const page = parseTopicPage(result);
  if (!page) throw new Error("Topic page is invalid");
  return updateTopicFrontmatter(result, {
    [NS_FM.topicMembers]: page.memberLinks.filter((link) => memberLinkTarget(link) !== normalizedMemberPath),
  });
}

export function updateTopicFrontmatter(markdown: string, updates: Record<string, string | string[]>): string {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error("Topic page frontmatter is missing");
  const lines = match[1].split(/\r?\n/);
  for (const [key, value] of Object.entries(updates)) {
    const serialized = Array.isArray(value) ? yamlStrings(value) : yamlString(value);
    const index = lines.findIndex((line) => line.match(/^([\w-]+):/)?.[1] === key);
    if (index >= 0) {
      let end = index + 1;
      if (!/^[\w-]+:\s*\S/.test(lines[index])) {
        while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
      }
      lines.splice(index, end - index, `${key}: ${serialized}`);
    } else lines.push(`${key}: ${serialized}`);
  }
  return `---\n${lines.join("\n")}\n---\n${markdown.slice(match[0].length)}`;
}
export function appendTopicMemberLinks(markdown: string, memberLinks: readonly string[]): string {
  const normalized = ensureSections(markdown);
  const split = frontmatter(normalized);
  const lines = split.body.split("\n");
  const range = sectionRange(lines, "来源笔记");
  if (!range) throw new Error("Topic source-note section is missing");
  const existing = new Set(lines.slice(range.start + 1, range.end).map((line) => line.trim()));
  const additions = [...new Set(memberLinks)].filter((link) => !existing.has(`- ${link}`)).map((link) => `- ${link}`);
  lines.splice(range.end, 0, ...additions);
  return `${split.text ? `---\n${split.text}\n---\n` : ""}${lines.join("\n")}`;
}

export function appendTopicMemberMetadata(markdown: string, members: readonly TopicMember[]): string {
  const parsed = frontmatter(markdown);
  if (parseTopicFrontmatter(parsed.text)[NS_FM_TOPIC_LAYOUT] !== 2 || !members.length) return markdown;
  const lines = parsed.body.split("\n");
  for (const section of ["时间线", "来源笔记"] as const) {
    if (!sectionRange(lines, section)) {
      while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
      lines.push("", sectionHeading(section));
    }
  }
  const linkOf = (member: TopicMember): string => `[[${member.path.replace(/\.md$/i, "")}|${member.title}]]`;
  const timelineRows = members.map((member) => ({
    date: member.date || "9999-99-99", title: member.title, link: linkOf(member),
    row: `- ${member.date || "—"} · ${linkOf(member)} — ${summarizeForTimeline(member.summary || "", { title: member.title })}`,
  }));
  for (const entry of timelineRows.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))) {
    const range = sectionRange(lines, "时间线");
    if (!range || lines.slice(range.start + 1, range.end).some((line) => line.includes(entry.link))) continue;
    const rows = lines.slice(range.start + 1, range.end).map((line, offset) => ({ index: range.start + 1 + offset, match: line.match(/^\s*-\s*(\d{4}-\d{2}-\d{2}|—)\s*[·—-]\s*\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/) }));
    const timelineEntries = rows.filter((row) => row.match);
    const target = timelineEntries.find(({ match }) => {
      const date = match?.[1] === "—" ? "9999-99-99" : match?.[1] || "";
      const linkParts = match?.[2].split("/") || [];
      const title = match?.[3] || linkParts[linkParts.length - 1] || "";
      return date.localeCompare(entry.date) > 0 || (date === entry.date && title.localeCompare(entry.title) > 0);
    });
    const lastTimelineIndex = timelineEntries[timelineEntries.length - 1]?.index;
    let at = target?.index ?? (lastTimelineIndex !== undefined ? lastTimelineIndex + 1 : range.start + 1);
    while (at > range.start + 1 && !lines[at - 1]?.trim()) at--;
    lines.splice(at, 0, entry.row);
  }
  const timelineRange = sectionRange(lines, "时间线");
  if (timelineRange) {
    const timelineIndexes = lines.slice(timelineRange.start + 1, timelineRange.end).map((line, offset) => /^\s*-\s*(?:\d{4}-\d{2}-\d{2}|—)\s*[·—-]\s*\[\[/.test(line) ? timelineRange.start + 1 + offset : -1).filter((index) => index >= 0);
    for (let index = timelineIndexes.length - 1; index > 0; index--) {
      const left = timelineIndexes[index - 1];
      const right = timelineIndexes[index];
      if (lines.slice(left + 1, right).every((line) => !line.trim())) lines.splice(left + 1, right - left - 1);
    }
  }
  if (sectionRange(lines, "来源笔记")) {
    const entries = members.map((member) => ({
      sourceId: member.sourceId,
      date: member.date || "9999-99-99",
      title: member.title,
      row: `[^${sourceFootnoteId(member.sourceId)}]: ${linkOf(member)}${member.date ? ` · ${member.date}` : ""}`,
    })).sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
    for (const entry of entries) {
      const id = sourceFootnoteId(entry.sourceId);
      const range = sectionRange(lines, "来源笔记");
      if (!range) continue;
      if (lines.slice(range.start + 1, range.end).some((line) => line.startsWith(`[^${id}]:`))) continue;
      const list = lines.slice(range.start + 1, range.end).map((line, offset) => ({ index: range.start + 1 + offset, match: line.match(/^\[\^s[\da-f]{4}\]:\s+\[\[([^\]|]+)(?:\|([^\]]+))?\]\](?:\s+·\s+(\d{4}-\d{2}-\d{2}))?$/) }));
      const rows = list.filter((row) => row.match);
      const target = rows.find(({ match }) => {
        const date = match?.[3] || "9999-99-99";
        const linkParts = match?.[1].split("/") || [];
        const title = match?.[2] || linkParts[linkParts.length - 1] || "";
        return date.localeCompare(entry.date) > 0 || (date === entry.date && title.localeCompare(entry.title) > 0);
      });
      const lastSourceIndex = rows[rows.length - 1]?.index;
      lines.splice(target?.index ?? (lastSourceIndex !== undefined ? lastSourceIndex + 1 : range.start + 1), 0, entry.row);
    }
  }
  let result = (parsed.text ? "---\n" + parsed.text + "\n---\n" : "") + lines.join("\n");
  const current = parseTopicPage(markdown);
  if (current) {
    const memberLinks = [...new Set([...current.memberLinks, ...members.map(linkOf)])];
    result = updateTopicFrontmatter(result, { [NS_FM.topicMembers]: memberLinks });
  }
  return result;
}

export interface TopicMemberMetadataCounts { members: number; timeline: number; sources: number }
export function topicMemberMetadataCounts(markdown: string): TopicMemberMetadataCounts {
  const split = frontmatter(markdown);
  const members = parseTopicPage(markdown)?.members.length || 0;
  const lines = split.body.split("\n");
  const count = (section: TopicSection, pattern: RegExp): number => {
    const range = sectionRange(lines, section);
    return range ? lines.slice(range.start + 1, range.end).filter((line) => pattern.test(line)).length : 0;
  };
  return {
    members,
    timeline: count("时间线", /^\s*-\s*(?:\d{4}-\d{2}-\d{2}|—)\s*[·—-]\s*\[\[/),
    sources: count("来源笔记", /^\[\^s[\da-f]{4}\]:\s+\[\[/),
  };
}


export function stableTopicBlockId(kind: string, sourceId: string, text: string, existing: ReadonlySet<string>): string {
  const base = `tpc-${stableHash(`${kind}\0${sourceId}\0${text}`)}`;
  let candidate = base;
  let suffix = 1;
  while (existing.has(candidate)) candidate = `tpc-${stableHash(`${kind}\0${sourceId}\0${text}\0${suffix++}`)}`;
  return candidate;
}

export function applyTopicOps(markdown: string, ops: readonly TopicOperation[], labels: Partial<TopicPageLabels> = {}): ApplyTopicOpsResult {
  let current = ensureSections(markdown);
  const openLabels = Object.keys(labels).length ? { ...DEFAULT_V2_LABELS, ...labels }
    : /##\s+(?:Overview|Progress thread|Timeline)\b/.test(markdown)
      ? { ...DEFAULT_V2_LABELS, openQuestion: "Question", openAction: "Action", openBug: "Bug" }
      : DEFAULT_V2_LABELS;
  const applied: AppliedTopicOperation[] = [];
  const skipped: ApplyTopicOpsResult["skipped"] = [];
  for (const operation of ops) {
    if (operation.type === "remove_member") {
      current = removeTopicMember(current, operation.path);
      applied.push({ operation, blockId: null, location: "来源笔记" });
      continue;
    }
    const isV2 = parseTopicFrontmatter(frontmatter(current).text)[NS_FM_TOPIC_LAYOUT] === 2;
    if (isV2 && ["add_point", "add_thread", "revise_block", "remove_block", "add_disagreement", "add_open", "resolve_open"].includes(operation.type)) {
      const parsed = frontmatter(current);
      const lines = parsed.body.split("\n");
      const source = (id: string) => `[^${sourceFootnoteId(id)}]`;
      let blockId: string | null = null;
      let location: TopicSection = "进展脉络";
      if (operation.type === "revise_block" || operation.type === "remove_block" || operation.type === "resolve_open") {
        const id = operation.blockId.replace(/^\^/, "");
        const block = parseTopicPageBlocks(current).find((item) => item.id === id);
        if (operation.expectedText !== undefined && block?.text !== operation.expectedText) {
          skipped.push({ id, reason: "block-modified" });
          continue;
        }
        const bodyOffset = current.length - parsed.body.length;
        const at = block ? parsed.body.slice(0, Math.max(0, block.start - bodyOffset)).split("\n").length - 1 : -1;
        if (at >= 0 && block) {
          blockId = id;
          if (operation.type === "remove_block") {
            const bodyOffset = current.length - parsed.body.length;
            const relativeStart = Math.max(0, block.start - bodyOffset);
            const relativeEnd = Math.max(relativeStart, block.end - bodyOffset);
            const lineStart = parsed.body.slice(0, relativeStart).split("\n").length - 1;
            const blockLines = parsed.body.slice(relativeStart, relativeEnd).split("\n").length;
            lines.splice(lineStart, blockLines);
          } else if (operation.type === "revise_block") {
            if (block.type === "overview") {
              let end = at + 1;
              while (end < lines.length && /^>/.test(lines[end]) && !/^>\s*\*\*/.test(lines[end])) end++;
              lines.splice(at + 1, end - at - 1, ...operation.newText.split("\n").map((line) => `> ${stripBlockMarkers(line)}`));
            } else {
              const prefix = lines[at].match(/^\s*[-*]?\s*(?:\[[ xX]\]\s*)?/)?.[0] || "";
              lines[at] = `${prefix}${stripBlockMarkers(operation.newText)}`;
            }
          } else {
            lines[at] = lines[at].replace(/^(\s*[-*]\s*\[)\s(\])/, "$1x$2");
            lines.splice(at + 1, 0, `  - ${operation.note}${source(operation.sourceId)}`);
          }
        }
      } else {
        let row: string;
        if (operation.type === "add_thread") {
          const used = new Set(lines.map((line) => line.match(/\^(tpc-[\da-f]{6})\s*$/)?.[1]).filter((value): value is string => !!value));
          const summaryId = stableTopicBlockId("thread", operation.title, operation.summary, used);
          used.add(summaryId);
          const pointRows = operation.points.map((point) => {
            const id = stableTopicBlockId("point", operation.title, point.text, used);
            used.add(id);
            return `- ${ensureSentencePunctuation(point.text)}${inlineFootnotes(point.sources)}`;
          });
          row = [``, `### ${operation.title}`, ``, `${operation.summary} ^${summaryId}`, ...pointRows].join("\n");
        } else if (operation.type === "add_point") {
          const thread = lines.findIndex((line) => line.trim() === `### ${operation.thread}`);
          if (thread >= 0) {
            let end = thread + 1;
            while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
            const id = stableTopicBlockId("add_point", operation.sourceId, operation.text, new Set(lines.map((line) => line.match(/\^(tpc-[\da-f]{6})\s*$/)?.[1]).filter((value): value is string => !!value)));
            lines.splice(end, 0, `- ${ensureSentencePunctuation(operation.text)}${inlineFootnotes(operation.sources)}`);
            blockId = id;
            current = `${parsed.text ? `---\n${parsed.text}\n---\n` : ""}${lines.join("\n")}`;
            applied.push({ operation, blockId, location });
            continue;
          }
          row = `- ${ensureSentencePunctuation(operation.text)}${inlineFootnotes(operation.sources)}`;
          location = "进展脉络";
        } else if (operation.type === "add_disagreement") {
          const used = new Set(lines.map((line) => line.match(/\^(tpc-[\da-f]{6})\s*$/)?.[1]).filter((value): value is string => !!value));
          // Stances render in date order; a stance without a date goes last.
          const ordered = [...operation.positions].sort((left, right) => (left.date || "9999-99-99").localeCompare(right.date || "9999-99-99"));
          const positions = ordered.map((position) => {
            const id = stableTopicBlockId("disagreement", position.sourceId, position.text, used);
            used.add(id);
            const hasSource = position.provenance !== "source-pending" && position.provenance !== "page-narrative" && !!position.sourceId;
            const sourceDate = hasSource ? position.date || "" : "";
            const sourceFootnote = !hasSource ? "" : position.footnotes?.length ? position.footnotes.map((ref) => `[^${ref}]`).join("") : inlineFootnotes(position.sourceIds?.length ? position.sourceIds : [position.sourceId]);
            const marker = position.provenance === "source-pending" ? "（来源待核实）" : position.provenance === "unverified" ? "（未核实）" : position.provenance === "page-narrative" ? "（来自页面叙述）" : "";
            return `> - ${sourceDate ? `**${sourceDate}**：` : ""}${position.text}${marker}${sourceFootnote}`;
          });
          const heading = `> [!warning] ${operation.subject}`;
          const existingHeading = lines.findIndex((line) => line.trim() === heading);
          if (existingHeading >= 0) {
            let end = existingHeading + 1;
            while (end < lines.length && /^\s*>/.test(lines[end])) end++;
            const existingText = lines.slice(existingHeading + 1, end).join("\n");
            const additions = positions.filter((position) => !existingText.includes(position.replace(/\s+\^tpc-[\da-f]{6}$/, "")));
            if (additions.length) lines.splice(end, 0, ...additions);
            current = `${parsed.text ? `---\n${parsed.text}\n---\n` : ""}${lines.join("\n")}`;
            applied.push({ operation, blockId: null, location: "分歧与待核实" });
            continue;
          }
          row = [``, heading, ...positions].join("\n");
          location = "分歧与待核实";
        } else if (operation.type === "add_open") {
          const id = stableTopicBlockId("open", operation.sourceId, operation.text, new Set(lines.map((line) => line.match(/\^(tpc-[\da-f]{6})\s*$/)?.[1]).filter((value): value is string => !!value)));
          row = renderTopicOpenMarkdown({ kind: operation.kind, text: operation.text, sources: operation.sources, done: false }, openLabels);
          blockId = id;
          location = "未决问题与未完成行动";
        } else { row = ""; location = "待整理"; }
        if (row) {
          const headingNames = operation.type === "add_thread" || operation.type === "add_point" ? ["进展脉络", "Progress thread"]
            : operation.type === "add_disagreement" ? ["分歧与待核实", "Disagreements and verification"]
              : operation.type === "add_open" ? ["未决问题与行动", "Open questions and actions"] : ["待整理", "Unsorted"];
          const headingIndex = lines.findIndex((line) => headingNames.some((name) => line.trim() === `## ${name}`));
          const english = lines.some((line) => /^##\s+(?:Overview|Progress thread|Timeline|Source notes)\s*$/.test(line));
          const chosenHeading = headingIndex >= 0 ? lines[headingIndex] : `## ${english ? headingNames[1] : headingNames[0]}`;
          if (headingIndex < 0) {
            const insertBefore = ["时间线", "Timeline", "来源笔记", "Source notes"].map((name) => lines.findIndex((line) => line.trim() === `## ${name}`)).filter((index) => index >= 0).sort((a, b) => a - b)[0];
            if ((operation.type === "add_open" || operation.type === "add_disagreement") && insertBefore !== undefined) lines.splice(insertBefore, 0, "", chosenHeading, row);
            else lines.push("", chosenHeading, row);
          }
          else {
            let end = headingIndex + 1;
            while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
            lines.splice(end, 0, row);
          }
        }
      }
      current = `${parsed.text ? `---\n${parsed.text}\n---\n` : ""}${lines.join("\n")}`;
      applied.push({ operation, blockId, location });
      continue;
    }
    const parsed = frontmatter(current);
    const lines = parsed.body.split("\n");
    const existing = new Set(lines.map((line) => line.match(/\^(tpc-[\da-f]{6})\s*$/i)?.[1]).filter((id): id is string => !!id));
    let destination: TopicSection = operation.type === "add_conflict" ? "分歧与待核实"
      : operation.type === "add_timeline" ? "时间线"
        : operation.type === "resolve_question" ? "未决问题与未完成行动"
      : operation.type === "annotate_item" ? "待整理" : operation.type === "add_item" ? operation.section : "待整理";
    const target = "targetId" in operation ? operation.targetId.replace(/^\^/, "") : "";
    const locatedTarget = target ? parseTopicPageBlocks(current).find((block) => block.id === target) : undefined;
    const bodyOffset = current.length - parsed.body.length;
    const targetLine = locatedTarget ? parsed.body.slice(0, locatedTarget.start - bodyOffset).split("\n").length - 1
      : target ? lines.findIndex((line) => line.trimEnd().endsWith(`^${target}`)) : -1;
    const targetSection = targetLine >= 0 ? sectionForLine(lines, targetLine) : null;
    if (operation.type === "annotate_item" && targetLine >= 0) {
      lines.splice(targetLine + 1, 0, `  - ${operation.text} — 来源：${sourceCitation(operation.sourceId)}`);
      applied.push({ operation, blockId: target, location: targetSection || "待整理" });
    } else if (operation.type === "resolve_question" && targetLine >= 0) {
      const original = lines[targetLine];
      if (!/^\s*-\s*\[[ xX]\]/.test(original)) lines[targetLine] = original.replace(/^(\s*-\s*)/, "$1[x] ");
      lines.splice(targetLine + 1, 0, `  - ${operation.text} — 来源：${sourceCitation(operation.sourceId)}`);
      applied.push({ operation, blockId: target, location: targetSection || "待整理" });
    } else {
      if ((operation.type === "annotate_item" || operation.type === "resolve_question") && targetLine < 0) destination = "待整理";
      const insertion = sectionRange(lines, destination);
      const content = "text" in operation ? operation.text : "";
      const sourceId = operation.sourceId;
      const timelineText = operation.type === "add_timeline" ? content.replace(new RegExp(`^${operation.date.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:[—–-]\\s*)?`), "") : content;
      const bodyText = `${(operation.type === "add_timeline" || operation.type === "add_conflict") && operation.date ? `${operation.date} — ` : ""}${timelineText} — 来源：${sourceCitation(sourceId)}`;
      const blockId = stableTopicBlockId(operation.type, sourceId, bodyText, existing);
      const row = `- ${bodyText} ^${blockId}`;
      const at = insertion ? insertion.end : lines.length;
      lines.splice(at, 0, row);
      applied.push({ operation, blockId, location: destination });
    }
    current = `${parsed.text ? `---\n${parsed.text}\n---\n` : ""}${lines.join("\n")}`;
  }
  const normalized = ensureSections(current);
  const isV2Page = parseTopicFrontmatter(frontmatter(normalized).text)[NS_FM_TOPIC_LAYOUT] === 2;
  const cleaned = isV2Page ? normalized.replace(/[ \t]+\^tpc-[\da-f]{6}\b/gi, "") : normalized;
  const indexed = isV2Page ? updateTopicBlockIndex(cleaned) : cleaned;
  const blockIndex = isV2Page ? readTopicBlockIndex(indexed) : undefined;
  return { markdown: isV2Page ? removeTopicMachineProperties(indexed) : indexed, applied, skipped, ...(blockIndex ? { blockIndex } : {}) };
}
