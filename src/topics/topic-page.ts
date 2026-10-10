import { NS_FM, NS_TYPE_TOPIC } from "../shared/namespace";

export type TopicBasis = "overview" | "body";
export type TopicSection = "概要" | "当前状态" | "分歧与待核实" | "未决问题与未完成行动" | "时间线" | "来源笔记" | "待整理";
export interface TopicMember { path: string; title: string; sourceId: string }
export interface TopicPage {
  id: string;
  title: string;
  tags: string[];
  members: string[];
  memberLinks: string[];
  excluded: string[];
  basis: TopicBasis;
  created: string;
  updated: string;
  appliedHash?: string;
  undoSnapshot?: string;
  body: string;
}
export type TopicOperation =
  | { type: "add_item"; section: TopicSection; text: string; sourceId: string; date?: string }
  | { type: "annotate_item"; targetId: string; text: string; sourceId: string }
  | { type: "add_conflict"; text: string; sourceId: string; date?: string }
  | { type: "resolve_question"; targetId: string; text: string; sourceId: string }
  | { type: "add_timeline"; text: string; sourceId: string; date: string };
export interface AppliedTopicOperation { operation: TopicOperation; blockId: string | null; location: TopicSection }
export interface ApplyTopicOpsResult { markdown: string; applied: AppliedTopicOperation[] }

export const TOPIC_SECTIONS: readonly TopicSection[] = ["概要", "当前状态", "分歧与待核实", "未决问题与未完成行动", "时间线", "来源笔记", "待整理"];
const ENGLISH_SECTION: Record<TopicSection, string> = {
  "概要": "Overview", "当前状态": "Current status", "分歧与待核实": "Disagreements and verification", "未决问题与未完成行动": "Open questions and actions", "时间线": "Timeline", "来源笔记": "Source notes", "待整理": "Unsorted",
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
    ...(page.appliedHash ? [`${NS_FM.topicHash}: ${yamlString(page.appliedHash)}`] : []),
    ...(page.undoSnapshot ? [`${NS_FM.topicUndoSnapshot}: ${yamlString(page.undoSnapshot)}`] : []),
  ].join("\n");
  const body = ensureSections(page.body).replace(/^---\n[\s\S]*?\n---\n/, "");
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
    tags: parseArray(fields[NS_FM.topicTags]), members, memberLinks,
    excluded: parseArray(fields[NS_FM.topicExcluded]),
    basis: fields[NS_FM.topicBasis] === "body" ? "body" : "overview",
    created: typeof created === "string" ? created : "",
    updated: typeof updated === "string" ? updated : "",
    appliedHash: typeof appliedHash === "string" ? appliedHash : undefined,
    undoSnapshot: typeof undoSnapshot === "string" ? undoSnapshot : undefined,
    body: split.body,
  };
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
  for (const operation of ops) {
    const parsed = frontmatter(current);
    const lines = parsed.body.split("\n");
    const existing = new Set(lines.map((line) => line.match(/\^(tpc-[\da-f]{6})\s*$/i)?.[1]).filter((id): id is string => !!id));
    let destination: TopicSection = operation.type === "add_conflict" ? "分歧与待核实"
      : operation.type === "add_timeline" ? "时间线"
        : operation.type === "resolve_question" ? "未决问题与未完成行动"
          : operation.type === "annotate_item" ? "待整理" : operation.section;
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
      const bodyText = `${(operation.type === "add_timeline" || operation.type === "add_conflict") && operation.date ? `${operation.date} — ` : ""}${content} — 来源：${sourceCitation(sourceId)}`;
      const blockId = stableTopicBlockId(operation.type, sourceId, bodyText, existing);
      const row = `- ${bodyText} ^${blockId}`;
      const at = insertion ? insertion.end : lines.length;
      lines.splice(at, 0, row);
      applied.push({ operation, blockId, location: destination });
    }
    current = `${parsed.text ? `---\n${parsed.text}\n---\n` : ""}${lines.join("\n")}`;
  }
  return { markdown: ensureSections(current), applied };
}
