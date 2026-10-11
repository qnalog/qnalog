import { NS_FM, NS_FM_TOPIC_LAYOUT, NS_TYPE_TOPIC } from "../shared/namespace";

export type TopicBasis = "overview" | "body";
export type TopicStatus = "active" | "done" | "paused" | "unknown";
export type TopicOpenKind = "question" | "action" | "bug";
export type TopicSection = "概要" | "当前状态" | "进展脉络" | "分歧与待核实" | "未决问题与未完成行动" | "未决问题与行动" | "时间线" | "来源笔记" | "待整理";
export interface TopicMember { path: string; title: string; sourceId: string; date?: string; summary?: string }
export interface TopicThread { id: string; title: string; summary: string; points: Array<{ id: string; text: string; sources: string[] }> }
export interface TopicDisagreement { id: string; subject: string; positions: Array<{ text: string; sourceId: string; date?: string }> }
export interface TopicOpenItem { id: string; kind: TopicOpenKind; text: string; sources: string[]; done: boolean }
export interface TopicPageV2Model {
  overview: string; status: TopicStatus; threads: TopicThread[]; disagreements: TopicDisagreement[];
  open: TopicOpenItem[]; unsorted: string[]; validationWarnings?: string[];
}
export interface TopicPageLabels {
  overview: string; status: string; progress: string; disagreements: string; open: string;
  timeline: string; sources: string; inProgress: string; updated: string; notes: string;
  conflict: string; statusActive: string; statusDone: string; statusPaused: string; statusUnknown: string;
  openQuestion: string; openAction: string; openBug: string;
}
export interface ParsedTopicBlock { id: string; type: "overview" | "thread-summary" | "point" | "disagreement" | "open" | "other"; text: string; start: number; end: number }
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
  | { type: "add_disagreement"; subject: string; positions: Array<{ text: string; sourceId: string; date?: string }>; sourceId: string }
  | { type: "add_open"; kind: TopicOpenKind; text: string; sources: string[]; sourceId: string }
  | { type: "resolve_open"; blockId: string; note: string; expectedText?: string; sourceId: string };
export interface AppliedTopicOperation { operation: TopicOperation; blockId: string | null; location: TopicSection }
export interface ApplyTopicOpsResult { markdown: string; applied: AppliedTopicOperation[]; skipped: Array<{ id: string; reason: "block-modified" }> }

export const TOPIC_SECTIONS: readonly TopicSection[] = ["概要", "当前状态", "分歧与待核实", "未决问题与未完成行动", "时间线", "来源笔记", "待整理"];
const ENGLISH_SECTION: Record<TopicSection, string> = {
  "概要": "Overview", "当前状态": "Current status", "进展脉络": "Progress thread", "分歧与待核实": "Disagreements and verification", "未决问题与未完成行动": "Open questions and actions", "未决问题与行动": "Open questions and actions", "时间线": "Timeline", "来源笔记": "Source notes", "待整理": "Unsorted",
};

function yamlString(value: string): string { return JSON.stringify(value); }
function yamlStrings(values: readonly string[]): string { return `[${values.map(yamlString).join(", ")}]`; }
function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}
export function hashTopicPage(markdown: string): string {
  const content = String(markdown).replace(new RegExp(`^${NS_FM.topicHash}:.*(?:\\r?\\n|$)`, "m"), "");
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
    `${NS_FM.topicTagAliases}: ${yamlString(JSON.stringify(page.tagAliases || {}))}`,
    `${NS_FM.topicMembers}: ${yamlStrings(page.memberLinks)}`,
    `${NS_FM.topicExcluded}: ${yamlStrings(page.excluded)}`,
    `${NS_FM.topicBasis}: ${yamlString(page.basis)}`,
    `${NS_FM.topicCreated}: ${yamlString(page.created)}`,
    `${NS_FM.topicUpdated}: ${yamlString(page.updated)}`,
    ...(page.layout === 2 ? [`${NS_FM_TOPIC_LAYOUT}: 2`, `cssclasses: [qnalog-topic]`] : []),
    ...(page.appliedHash ? [`${NS_FM.topicHash}: ${yamlString(page.appliedHash)}`] : []),
    ...(page.undoSnapshot ? [`${NS_FM.topicUndoSnapshot}: ${yamlString(page.undoSnapshot)}`] : []),
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
    body: split.body,
  };
}

const DEFAULT_V2_LABELS: TopicPageLabels = {
  overview: "概要", status: "状态", progress: "进展脉络", disagreements: "分歧与待核实",
  open: "未决问题与行动", timeline: "时间线", sources: "来源笔记", inProgress: "进行中",
  updated: "最近更新", notes: "篇笔记", conflict: "关于这个问题的不同说法",
  statusActive: "进行中", statusDone: "已完成", statusPaused: "搁置", statusUnknown: "待定",
  openQuestion: "问题", openAction: "行动", openBug: "缺陷",
};

export function isTopicStatus(value: string): value is TopicStatus {
  return value === "active" || value === "done" || value === "paused" || value === "unknown";
}

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
function uniqueBlockId(kind: string, value: string, used: Set<string>): string {
  const id = stableTopicBlockId(kind, value, value, new Set([...used].map((item) => item.replace(/-\d+$/, ""))));
  used.add(id);
  return id;
}
function quote(text: string): string { return text.split("\n").map((line) => `> ${line}`).join("\n"); }

/** Deterministically renders a v2 page. The same model and members produce identical Markdown. */
export function renderTopicPage(model: TopicPageV2Model, members: readonly TopicMember[], labels: Partial<TopicPageLabels> = {}): string {
  const label = { ...DEFAULT_V2_LABELS, ...labels };
  const used = new Set<string>();
  const allSourceIds = new Set(members.map((member) => member.sourceId));
  const overviewId = uniqueBlockId("overview", "overview", used);
  const statusLabel = model.status === "done" ? label.statusDone
    : model.status === "paused" ? label.statusPaused
      : model.status === "unknown" ? label.statusUnknown : label.statusActive;
  const sections: string[] = [`> [!abstract] ${label.overview}`, ...quote(model.overview.trim()).split("\n"), `> **${label.status}**${topicLabelSeparator(label.status)}${statusLabel} · **${label.updated}** ${members.map((member) => member.date || "").filter(Boolean).sort().at(-1) || "—"} · ${members.length}${label.notes}`, `> ^${overviewId}`, "", `## ${label.progress}`];
  for (const thread of model.threads.slice(0, 6)) {
    const threadId = uniqueBlockId("thread", thread.id || thread.title, used);
    sections.push("", `### ${thread.title}`, `${thread.summary.trim()} ^${threadId}`);
    for (const point of thread.points.slice(0, 6)) {
      const id = uniqueBlockId("point", point.id || `${thread.id}:${point.text}`, used);
      sections.push(`- ${point.text.trim()}${inlineFootnotes(point.sources.filter((source) => allSourceIds.has(source)))} ^${id}`);
    }
  }
  if (model.disagreements.length) {
    sections.push("", `## ${label.disagreements}`);
    for (const disagreement of model.disagreements) {
      sections.push("", `> [!warning] ${disagreement.subject || label.conflict}`);
      for (const position of disagreement.positions) {
        if (!allSourceIds.has(position.sourceId)) continue;
        sections.push(`> - **${position.date || ""}**：${position.text}${inlineFootnotes([position.sourceId])}`);
      }
    }
  }
  if (model.open.length) {
    sections.push("", `## ${label.open}`);
    for (const item of model.open) {
      const id = uniqueBlockId("open", item.id || item.text, used);
      const kind = topicOpenKindLabel(item.kind, label);
      sections.push(`- [${item.done ? "x" : " "}] ${kind}${topicLabelSeparator(kind)}${item.text}${inlineFootnotes(item.sources.filter((source) => allSourceIds.has(source)))} ^${id}`);
    }
  }
  if (model.unsorted.length) {
    sections.push("", `## 待整理`, ...model.unsorted.map((item) => `- ${item}`));
  }
  sections.push("", `## ${label.timeline}`);
  const timeline = members.filter((member) => member.date).slice().sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.sourceId.localeCompare(b.sourceId));
  for (const member of timeline) sections.push(`- ${member.date} · [[${member.path.replace(/\.md$/i, "")}|${member.title}]] — ${summarizeForTimeline(member.summary || "", { title: member.title })}`);
  sections.push("", `## ${label.sources}`);
  const sorted = [...members].sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.sourceId.localeCompare(b.sourceId));
  for (const member of sorted) sections.push(`[^${sourceFootnoteId(member.sourceId)}]: [[${member.path.replace(/\.md$/i, "")}|${member.title}]]${member.date ? ` · ${member.date}` : ""}`);
  return sections.join("\n").trimEnd() + "\n";
}

/** Extracts block-addressable text while tolerating malformed and user-authored Markdown. */
export function parseTopicPageBlocks(markdown: string): ParsedTopicBlock[] {
  const split = frontmatter(markdown);
  const bodyOffset = markdown.length - split.body.length;
  const lines = split.body.split("\n");
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) { offsets.push(cursor); cursor += line.length + 1; }
  const blocks: ParsedTopicBlock[] = [];
  for (let index = 0; index < lines.length; index++) {
    const marker = lines[index].match(/\^(tpc-[\da-f]{6})\s*$/i);
    if (!marker) continue;
    let startLine = index;
    if (/^\s*>\s*\^tpc-/i.test(lines[index])) {
      while (startLine > 0 && /^\s*>/.test(lines[startLine - 1])) startLine--;
    }
    const raw = lines.slice(startLine, index + 1);
    const isOverview = raw.some((line) => /\[!abstract\]/i.test(line));
    const nearestHeading = lines.slice(0, startLine).filter((line) => /^#{1,6}\s/.test(line)).at(-1) || "";
    let type: ParsedTopicBlock["type"] = isOverview ? "overview"
      : /^###/.test(nearestHeading) && !/^[-*]/.test(lines[startLine].trim()) ? "thread-summary"
        : /^[-*]\s*\[[ xX]\]/.test(lines[startLine].trim()) ? "open"
          : /^[-*]/.test(lines[startLine].trim()) ? "point" : "other";
    const cleaned = raw.map((line) => line.replace(/\s+\^tpc-[\da-f]{6}\s*$/i, "").replace(/^\s*>\s?/, "").trim());
    let text = "";
    if (isOverview) text = cleaned.filter((line) => line && !/\[!abstract\]/i.test(line) && !/^\*\*.*\*\*[:：]/.test(line)).join("\n");
    else text = cleaned.at(-1) || "";
    if (type === "other" && /!\[warning\]/i.test(text)) type = "disagreement";
    const start = bodyOffset + offsets[startLine];
    const end = bodyOffset + offsets[index] + lines[index].length;
    blocks.push({ id: marker[1], type, text, start, end });
  }
  return blocks;
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
  const timeline = lines.findIndex((line) => /^##\s+(?:Timeline|时间线)\s*$/.test(line.trim()));
  const sources = lines.findIndex((line) => /^##\s+(?:Source notes|来源笔记)\s*$/.test(line.trim()));
  const existingIds = new Set(lines.map((line) => line.match(/^\[\^(s[\da-f]{4})\]:/)?.[1]).filter((id): id is string => !!id));
  const sourceRows: string[] = [];
  const timelineRows: Array<{ date: string; row: string }> = [];
  for (const member of members) {
    const footnoteId = sourceFootnoteId(member.sourceId);
    if (!existingIds.has(footnoteId)) {
      existingIds.add(footnoteId);
      const link = "[[" + member.path.replace(/\.md$/i, "") + "|" + member.title + "]]";
      sourceRows.push("[^" + footnoteId + "]: " + link + (member.date ? " · " + member.date : ""));
    }
    if (timeline >= 0 && member.date) {
      const link = "[[" + member.path.replace(/\.md$/i, "") + "|" + member.title + "]]";
      if (!lines.some((line) => line.includes(link))) timelineRows.push({ date: member.date, row: "- " + member.date + " · " + link + " — " + summarizeForTimeline(member.summary || "", { title: member.title }) });
    }
  }
  if (timeline >= 0 && timelineRows.length) {
    let end = timeline + 1;
    while (end < lines.length && !/^##\s/.test(lines[end])) end++;
    for (const entry of timelineRows.sort((a, b) => a.date.localeCompare(b.date))) {
      let at = timeline + 1;
      while (at < end) {
        const date = lines[at].match(/^\s*-\s*(\d{4}-\d{2}-\d{2})\s*[·—-]/)?.[1];
        if (date && date > entry.date) break;
        at++;
      }
      lines.splice(at, 0, entry.row);
      end++;
    }
  }
  if (sources >= 0 && sourceRows.length) {
    let at = sources + 1;
    while (at < lines.length && !/^##\s/.test(lines[at])) at++;
    lines.splice(at, 0, ...sourceRows.sort((a, b) => a.localeCompare(b)));
  }
  return (parsed.text ? "---\n" + parsed.text + "\n---\n" : "") + lines.join("\n");
}


export function stableTopicBlockId(kind: string, sourceId: string, text: string, existing: ReadonlySet<string>): string {
  const base = `tpc-${stableHash(`${kind}\0${sourceId}\0${text}`)}`;
  let candidate = base;
  let suffix = 1;
  while (existing.has(candidate)) candidate = `tpc-${stableHash(`${kind}\0${sourceId}\0${text}\0${suffix++}`)}`;
  return candidate;
}

export function applyTopicOps(markdown: string, ops: readonly TopicOperation[]): ApplyTopicOpsResult {
  let current = ensureSections(markdown);
  const applied: AppliedTopicOperation[] = [];
  const skipped: ApplyTopicOpsResult["skipped"] = [];
  for (const operation of ops) {
    const isV2 = parseTopicFrontmatter(frontmatter(current).text)[NS_FM_TOPIC_LAYOUT] === 2;
    if (isV2 && ["add_point", "add_thread", "revise_block", "add_disagreement", "add_open", "resolve_open"].includes(operation.type)) {
      const parsed = frontmatter(current);
      const lines = parsed.body.split("\n");
      const source = (id: string) => `[^${sourceFootnoteId(id)}]`;
      let blockId: string | null = null;
      let location: TopicSection = "进展脉络";
      if (operation.type === "revise_block" || operation.type === "resolve_open") {
        const id = operation.blockId.replace(/^\^/, "");
        const block = parseTopicPageBlocks(current).find((item) => item.id === id);
        if (operation.expectedText !== undefined && block?.text !== operation.expectedText) {
          skipped.push({ id, reason: "block-modified" });
          continue;
        }
        const at = lines.findIndex((line) => line.trimEnd().endsWith(`^${id}`));
        if (at >= 0 && block) {
          blockId = id;
          if (operation.type === "revise_block") {
            if (block.type === "overview") {
              let header = at;
              while (header > 0 && !/\[!abstract\]/i.test(lines[header])) header--;
              let end = at;
              while (end > header + 1 && /^\s*>\s*\*\*/.test(lines[end - 1])) end--;
              lines.splice(header + 1, end - header - 1, ...operation.newText.split("\n").map((line) => `> ${line}`));
            } else {
              const prefix = lines[at].match(/^\s*[-*]?\s*/)?.[0] || "";
              lines[at] = `${prefix}${operation.newText} ^${id}`;
            }
          } else {
            lines[at] = lines[at].replace(/^(\s*[-*]\s*\[)\s(\])/, "$1x$2");
            lines.splice(at + 1, 0, `  - ${operation.note}${source(operation.sourceId)}`);
          }
        }
      } else {
        let row: string;
        const kind = operation.type;
        if (operation.type === "add_thread") {
          const used = new Set(lines.map((line) => line.match(/\^(tpc-[\da-f]{6})\s*$/)?.[1]).filter((value): value is string => !!value));
          const summaryId = stableTopicBlockId("thread", operation.title, operation.summary, used);
          used.add(summaryId);
          const pointRows = operation.points.map((point) => {
            const id = stableTopicBlockId("point", operation.title, point.text, used);
            used.add(id);
            return `- ${point.text}${inlineFootnotes(point.sources)} ^${id}`;
          });
          row = [``, `### ${operation.title}`, ``, `${operation.summary} ^${summaryId}`, ...pointRows].join("\n");
        } else if (operation.type === "add_point") {
          const thread = lines.findIndex((line) => line.trim() === `### ${operation.thread}`);
          if (thread >= 0) {
            let end = thread + 1;
            while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
            const id = stableTopicBlockId(kind, operation.sourceId, operation.text, new Set(lines.map((line) => line.match(/\^(tpc-[\da-f]{6})\s*$/)?.[1]).filter((value): value is string => !!value)));
            lines.splice(end, 0, `- ${operation.text}${inlineFootnotes(operation.sources)} ^${id}`);
            blockId = id;
            current = `${parsed.text ? `---\n${parsed.text}\n---\n` : ""}${lines.join("\n")}`;
            applied.push({ operation, blockId, location });
            continue;
          }
          row = `- ${operation.text}${inlineFootnotes(operation.sources)}`;
          location = "进展脉络";
        } else if (operation.type === "add_disagreement") {
          const used = new Set(lines.map((line) => line.match(/\^(tpc-[\da-f]{6})\s*$/)?.[1]).filter((value): value is string => !!value));
          const positions = operation.positions.map((position) => {
            const id = stableTopicBlockId("disagreement", position.sourceId, position.text, used);
            used.add(id);
            return `> - **${position.date || ""}**：${position.text}${source(position.sourceId)} ^${id}`;
          });
          row = [``, `> [!warning] ${operation.subject}`, ...positions].join("\n");
          location = "分歧与待核实";
        } else if (operation.type === "add_open") {
          const id = stableTopicBlockId("open", operation.sourceId, operation.text, new Set(lines.map((line) => line.match(/\^(tpc-[\da-f]{6})\s*$/)?.[1]).filter((value): value is string => !!value)));
          row = `- [ ] ${operation.kind ? `${operation.kind}：` : ""}${operation.text}${inlineFootnotes(operation.sources)} ^${id}`;
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
    const targetLine = target ? lines.findIndex((line) => line.trimEnd().endsWith(`^${target}`)) : -1;
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
  return { markdown: ensureSections(current), applied, skipped };
}
