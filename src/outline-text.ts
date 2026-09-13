// 实时大纲的"文本/状态纯函数层"。从 main.ts 抽出，专门承载所有"把非确定性的 LLM markdown
// 掰回确定结构"的逻辑——这是全项目正确性最敏感、历史 bug 最多的一层。
// 这里的函数全是纯函数（无 obsidian / 无 DOM / 无 IO），便于被 vitest 回归测试覆盖（见 outline-text.test.ts）。
// 注意：normalizeRealtimeOutlineState / renderRealtimeOutlineStateMarkdown 仍留在 main.ts（它们依赖
// clipRealtimeContextText 等通用工具），但会从本模块 import 这里的节点构造/解析函数。

export const REALTIME_OUTLINE_STATE_MAX_CHILDREN = 5;

export const REALTIME_OUTLINE_ANCHOR_RE = /\[\[[^\]\n]+\|\d{1,2}:\d{2}(?::\d{2})?\]\]/;
export const REALTIME_OUTLINE_ANCHOR_GLOBAL_RE = /\[\[[^\]\n]+\|\d{1,2}:\d{2}(?::\d{2})?\]\]/g;
// 连排分隔符：空格 + 任意 Unicode 破折号 + 空格。
// 用 \p{Pd}（Unicode 破折号类）一网打尽：ASCII 连字符 - / 连字符 ‐ / 不换行连字符 ‑ /
// en-dash – / em-dash — / 横杠 ― 等"长得像但码点不同"的全部认；再补减号 U+2212(−，属 Sm 类不在 Pd)。
// 要求两侧有空格，避开中文 "——"（破折号通常无空格）误伤。
export const REALTIME_OUTLINE_INLINE_SEP_RE = /\s[\p{Pd}−]\s/u;
export const REALTIME_OUTLINE_INLINE_SEP_SPLIT_RE = /\s[\p{Pd}−]\s/gu;

export interface RealtimeOutlineNode {
  id: string;
  anchor: string;
  time: string;
  title: string;
  children: string[];
}

export interface RealtimeOutlineSegmentLike {
  text?: unknown;
  index?: unknown;
}

export interface RecruitRealtimeOutlineProtocolResult {
  outline: string;
  memory: string;
  protocolMatched: boolean;
}

export interface RecruitRealtimeOutlineFallbackOptions {
  maxNodes?: number;
}

export interface RecruitRealtimeOutlineMemoryOptions {
  maxChars?: number;
  recentDetailCount?: number;
}

export interface SelectIncrementalRealtimeOutlineOptions {
  maxSegments?: number;
  maxChars?: number;
  sinceCount?: number;
  lookbackSegments?: number;
}

export interface IncrementalRealtimeOutlineSelection<T extends RealtimeOutlineSegmentLike> {
  segments: T[];
  newSegments: T[];
  usedCount: number;
  newUsedCount: number;
  omittedBeforeCount: number;
  totalTextCount: number;
  totalSegmentCount: number;
  approxChars: number;
  isIncremental: boolean;
  sinceCount: number;
  deltaTotalCount: number;
  commitThroughCount: number;
  hasRemainingText: boolean;
}

export interface RealtimeOutlineAnchorSource {
  anchor?: unknown;
  index?: unknown;
}

export interface RepairRealtimeOutlineAnchorsOptions {
  previousOutline?: unknown;
  anchorSources?: readonly RealtimeOutlineAnchorSource[];
}

export interface RepairRealtimeOutlineAnchorsResult {
  outline: string;
  repairedCount: number;
  restoredCount: number;
  replacedCount?: number;
  unresolvedCount: number;
}

export interface NormalizeOutlineMarkdownOptions {
  attachUntimed?: boolean;
  preserveUntimedTopLevel?: boolean;
}

export interface CoverageDimensionLike {
  status?: string;
  evidence_anchor?: unknown;
  missing_what?: unknown;
  followup_question?: unknown;
  vague_hits?: readonly unknown[];
}

export type CoverageDimensions = Record<string, CoverageDimensionLike>;

export type FollowupDimension = CoverageDimensionLike;

export interface FollowupRule {
  fallback?: unknown;
  priority?: number;
}

export interface FollowupDimensionMeta {
  key?: string;
  name?: string;
  group?: string;
}

export interface DeriveFollowupCardsOptions {
  rules?: Record<string, FollowupRule>;
  dimOrder?: readonly FollowupDimensionMeta[];
  suppressed?: ReadonlySet<string> | readonly string[];
  maxCards?: number;
}

export type FollowupCardStatus = "missing" | "partial";

export interface FollowupCard {
  key: string;
  name: string;
  group: string;
  status: FollowupCardStatus;
  reason: string;
  vagueHits: unknown[];
  question: string;
  priority: number;
  order: number;
}

export interface ValidateRealtimeOutlineOptions {
  previousOutline?: unknown;
  maxNewTopLevel?: number;
  deltaOnly?: boolean;
  allowUntimedTopLevel?: boolean;
}

export type RealtimeOutlineValidationReason =
  | ""
  | "empty_outline"
  | "no_top_level_bullets"
  | "too_many_top_level_bullets"
  | "lost_all_time_anchors"
  | "too_many_untimed_top_level_items"
  | "numbered_items_inline_in_title";

export interface RealtimeOutlineValidationResult {
  ok: boolean;
  reason: RealtimeOutlineValidationReason;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

// 把一个片段在"第 2 个及以后的锚点"前切开——应对模型把多个一级条目排在一起、中间却没用任何破折号分隔的情况。
// 锚点 [[file|HH:MM]] 是最可靠的结构信号，据它硬切能保证一级条目至少能分开（时间轴 rail 不会糊成一条）。
export function splitRealtimeOutlineAtEmbeddedAnchors(segment: unknown): string[] {
  const s = stringValue(segment);
  const re = new RegExp(REALTIME_OUTLINE_ANCHOR_GLOBAL_RE.source, "g");
  const idxs: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) idxs.push(m.index);
  if (idxs.length <= 1) return [s];
  const out: string[] = [];
  let start = 0;
  for (let i = 1; i < idxs.length; i++) { out.push(s.slice(start, idxs[i])); start = idxs[i]; }
  out.push(s.slice(start));
  return out;
}

// 兜底修复模型把整份大纲连排成一行的问题。不再依赖模型规范换行，而是用最可靠的锚点信号重建结构：
// ① 按"空格+破折号+空格"切（破折号认全 Unicode 变体，含隐形的 U+2010/U+2011）；
// ② 再把任何内部还嵌着 ≥2 个锚点的片段在锚点前硬切；
// ③ 按锚点重建父子：带锚点的段 = 一级条目，其后无锚点的段 = 它的子要点（缩进两格）。
export function normalizeRealtimeOutlineList(outline: unknown): string {
  const src = stringValue(outline);
  if (!src.trim()) return src;
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const rawLine of lines) {
    let line = rawLine;
    // 模型偶尔会把协议里的 Markdown 列表改成标题、编号或 Unicode
    // 圆点。这里仅做确定性的语法归一，不改写任何内容。
    const heading = line.match(/^ {0,1}#{1,6}\s+(.+)$/);
    if (heading) line = `- ${String(heading[1] || "").trim()}`;
    const numbered = line.match(/^(\s*)\d{1,2}[.)、．]\s*(.+)$/);
    if (numbered) line = `${numbered[1] || ""}- ${String(numbered[2] || "").trim()}`;
    // 只处理"列表行"（允许前导缩进）。统一成 ASCII "-"，使验证、
    // 解析和渲染共用同一套稳定语法。
    const m = line.match(/^(\s*)([-*+•·▪◦])\s+(.*)$/);
    if (!m) { out.push(line); continue; }
    const indent = m[1] || "";
    const body = m[3] || "";
    const anchorCount = (body.match(REALTIME_OUTLINE_ANCHOR_GLOBAL_RE) || []).length;
    const hasDash = REALTIME_OUTLINE_INLINE_SEP_RE.test(body);
    // 既没破折号分隔、锚点也不超过 1 个 → 不是连排，原样保留。
    if (!hasDash && anchorCount <= 1) { out.push(`${indent}- ${body}`); continue; }
    let parts: string[] = hasDash ? body.split(REALTIME_OUTLINE_INLINE_SEP_SPLIT_RE) : [body];
    parts = parts.flatMap(splitRealtimeOutlineAtEmbeddedAnchors).map(s => s.trim()).filter(Boolean);
    if (parts.length <= 1) { out.push(line); continue; }
    if (indent) {
      // 子层里的连排：原样平铺到同一缩进（子项之间无需再分父子）。
      for (const part of parts) out.push(`${indent}- ${part}`);
      continue;
    }
    // 顶层连排：按锚点重建父子。带锚点的段开一个新一级条目，随后的无锚点段挂为它的子要点。
    let hasTopAnchorYet = false;
    for (const part of parts) {
      if (REALTIME_OUTLINE_ANCHOR_RE.test(part)) {
        out.push(`- ${part}`);
        hasTopAnchorYet = true;
      } else if (hasTopAnchorYet) {
        out.push(`  - ${part}`);
      } else {
        // 还没出现任何带锚点的一级条目，只能先平铺为顶层（后续显示规范化会处理无锚点项）。
        out.push(`- ${part}`);
      }
    }
  }
  return out.join("\n");
}

const RECRUIT_OUTLINE_CHILD_LABELS: ReadonlyArray<{ pattern: RegExp; prefix: string }> = [
  { pattern: /^(?:Q|问题|面试官提问|提问|主问)\s*[：:]\s*(.+)$/i, prefix: "❓" },
  { pattern: /^(?:A|回答|候选人回答|回答要点)\s*[：:]\s*(.+)$/i, prefix: "💬" },
  { pattern: /^(?:E|AI\s*评价|AI\s*简评|评价|观察|判断)\s*[：:]\s*(.+)$/i, prefix: "🤖" },
  { pattern: /^(?:F|建议追问|追问|待追问)\s*[：:]\s*(.+)$/i, prefix: "⛏" },
];

function normalizeRecruitOutlineBody(raw: unknown): string {
  return stringValue(raw)
    .replace(/\*\*/g, "")
    .replace(/^>\s*/, "")
    .trim();
}

function matchRecruitOutlineChild(raw: unknown): string {
  const body = normalizeRecruitOutlineBody(raw);
  const explicitIcon = /^([❓💬🤖⛏])\s*(.+)$/u.exec(body);
  if (explicitIcon) {
    const text = cleanRealtimeOutlineItemText(explicitIcon[2], 120);
    return text ? `${explicitIcon[1]} ${text}` : "";
  }
  for (const rule of RECRUIT_OUTLINE_CHILD_LABELS) {
    const match = rule.pattern.exec(body);
    if (!match) continue;
    const text = cleanRealtimeOutlineItemText(match[1], 120);
    return text ? `${rule.prefix} ${text}` : "";
  }
  return "";
}

// Recover explicit recruitment structure from the compact line protocol and
// from legacy XML/Markdown responses. Arbitrary prose is ignored so a model
// preamble cannot masquerade as a valid interview outline.
export function parseRecruitRealtimeOutlineProtocol(input: unknown): RecruitRealtimeOutlineProtocolResult {
  let source = stringValue(input).replace(/\r\n/g, "\n").trim();
  if (!source) return { outline: "", memory: "", protocolMatched: false };

  const taggedOutline = source.match(/<lexvoice-outline\b[^>]*>([\s\S]*?)(?:<\/lexvoice-outline>|$)/i);
  const taggedMemory = source.match(/<lexvoice-memory\b[^>]*>([\s\S]*?)(?:<\/lexvoice-memory>|$)/i);
  const memoryLines: string[] = [];
  if (taggedMemory && String(taggedMemory[1] || "").trim()) {
    memoryLines.push(String(taggedMemory[1] || "").trim().replace(/\s+/g, " "));
  }
  if (taggedOutline) {
    source = taggedOutline[1] || "";
  } else {
    source = source.replace(/<lexvoice-memory\b[^>]*>[\s\S]*?(?:<\/lexvoice-memory>|$)/gi, "");
  }
  source = source
    .replace(/<\/?lexvoice-(?:outline|memory)\b[^>]*>/gi, "")
    .replace(/```(?:markdown|md)?/gi, "")
    .replace(/```/g, "")
    .replace(/\s+(?=(?:记忆|面试主题|主题|能力项|考察项|话题|问题|面试官提问|提问|主问|回答|候选人回答|回答要点|AI\s*评价|AI\s*简评|评价|观察|判断|建议追问|追问|待追问)\s*[：:])/gi, "\n");

  const out: string[] = [];
  let hasTopic = false;
  let protocolMatched = false;
  const ensureTopic = (): void => {
    if (hasTopic) return;
    out.push("- 面试问答（待复核）");
    hasTopic = true;
  };

  for (const rawLine of source.split("\n")) {
    const raw = String(rawLine || "");
    if (!raw.trim()) continue;
    const heading = /^ {0,3}#{1,6}\s+(.+)$/.exec(raw);
    const numbered = /^ {0,3}\d{1,2}[.)、．]\s*(.+)$/.exec(raw);
    const bullet = /^(\s*)[-*+•·]\s+(.+)$/.exec(raw);
    const candidate = heading
      ? heading[1]
      : numbered
        ? numbered[1]
        : bullet
          ? bullet[2]
          : raw;
    const body = normalizeRecruitOutlineBody(candidate);
    if (!body) continue;

    const memory = /^(?:M|记忆)\s*[：:]\s*(.+)$/i.exec(body);
    if (memory) {
      const text = cleanRealtimeOutlineItemText(memory[1], 600);
      if (text) memoryLines.push(text);
      protocolMatched = true;
      continue;
    }

    const topic = /^(?:T|面试主题|主题|能力项|考察项|话题)\s*[：:]\s*(.+)$/i.exec(body);
    if (topic) {
      const title = cleanRealtimeOutlineItemText(topic[1], 90);
      if (title) {
        out.push(`- ${title}`);
        hasTopic = true;
      }
      protocolMatched = true;
      continue;
    }

    const child = matchRecruitOutlineChild(body);
    if (child) {
      ensureTopic();
      out.push(`  - ${child}`);
      protocolMatched = true;
      continue;
    }

    const isNestedBullet = !!(bullet && String(bullet[1] || "").length >= 2);
    if (isNestedBullet && hasTopic) {
      const text = cleanRealtimeOutlineItemText(body, 120);
      if (text) out.push(`  - ${text}`);
      continue;
    }

    if (heading || numbered || (bullet && !isNestedBullet)) {
      const title = cleanRealtimeOutlineItemText(body, 90);
      if (title) {
        out.push(`- ${title}`);
        hasTopic = true;
      }
    }
  }

  const normalized = normalizeRealtimeOutlineList(out.join("\n")).trim();
  return {
    outline: parseRealtimeOutlineStateFromMarkdown(normalized).length ? normalized : "",
    memory: memoryLines.join("；"),
    protocolMatched,
  };
}

export function normalizeRecruitRealtimeOutline(input: unknown): string {
  return parseRecruitRealtimeOutlineProtocol(input).outline;
}

// Last-resort output for malformed/failed recruitment batches. It copies only
// source transcript into neutral review nodes, so the ordered cursor can keep
// moving without inventing an assessment.
export function buildRecruitRealtimeOutlineFallback(
  segments: readonly (RealtimeOutlineSegmentLike | null | undefined)[] | null | undefined,
  opts: RecruitRealtimeOutlineFallbackOptions = {},
): string {
  const source = (segments ?? [])
    .filter((segment): segment is RealtimeOutlineSegmentLike => !!segment && !!stringValue(segment.text).trim());
  const maxNodes = Math.max(1, Math.min(6, Math.floor(Number(opts.maxNodes) || 6)));
  const groupSize = Math.max(1, Math.ceil(source.length / maxNodes));
  const lines: string[] = [];
  for (let offset = 0; offset < source.length; offset += groupSize) {
    const group = source.slice(offset, offset + groupSize);
    const displayIndexes = group.map((segment, innerIndex) => (
      Number.isFinite(Number(segment.index))
        ? Math.max(0, Math.floor(Number(segment.index))) + 1
        : offset + innerIndex + 1
    ));
    const rangeLabel = displayIndexes.length > 1
      ? `${displayIndexes[0]}-${displayIndexes[displayIndexes.length - 1]}`
      : String(displayIndexes[0]);
    lines.push(`- 面试片段 ${rangeLabel}（待复核）`);
    for (const segment of group) {
      const excerpt = cleanRealtimeOutlineItemText(
        stringValue(segment.text).replace(/\s+/g, " "),
        110,
      );
      if (excerpt) lines.push(`  - 💬 ${excerpt}`);
    }
  }
  return lines.join("\n");
}

// The committed cursor is program-owned monotonic state. Stale async results
// can never move it backwards or acknowledge past the current transcript.
export function advanceRealtimeOutlineCursor(
  currentCount: unknown,
  attemptedCount: unknown,
  totalCount: unknown,
): number {
  const total = Math.max(0, Math.floor(Number(totalCount) || 0));
  const current = Math.min(total, Math.max(0, Math.floor(Number(currentCount) || 0)));
  const attempted = Math.min(total, Math.max(0, Math.floor(Number(attemptedCount) || 0)));
  return Math.max(current, attempted);
}

export function hashRealtimeOutlineText(text: unknown): string {
  const src = stringValue(text);
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function getRealtimeOutlineAnchorTime(anchor: unknown): string {
  const match = stringValue(anchor).match(/\|(\d{1,2}:\d{2}(?::\d{2})?)\]\]/);
  return match ? match[1] : "";
}

export function cleanRealtimeOutlineItemText(text: unknown, maxChars = 120): string {
  let value = stringValue(text)
    .replace(/\[\[[^\]]+\|\d{1,2}:\d{2}(?::\d{2})?\]\]/g, "")
    // 剥掉行尾未闭合的残缺锚点（如 "[[lex-202"）——模型截断/流式半写时会漏出 [[ 却没有闭合 ]]，
    // 不清掉会当成正文渲染成一条乱码节点。只匹配"尾部不含 ]"的片段，绝不会碰到完整 [[x|MM:SS]]。
    .replace(/\[\[[^\]]*$/, "")
    .replace(/^[\s\-*+>]+/, "")
    .replace(/^\d+[.)、．]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length > maxChars) value = value.slice(0, maxChars).trimEnd();
  // 截断到 maxChars 时可能又切出半个锚点/半个 [[，再兜一次。
  value = value.replace(/\[\[[^\]]*$/, "").trimEnd();
  return value;
}

// 去重归一键：在 cleanRealtimeOutlineItemText 之上再做"去所有空白 + 去常见标点 + 小写"，
// 得到一个稳定 key，用于"措辞微改（加标点/空格/大小写）即视为同一条"的宽松去重。
// 纯确定性、可 vitest；刻意不做编辑距离/语义相似（不确定、易把真正不同的话题误并）。
// 注意虚词差异（"商业化思路" vs "商业化的思路"）不归一——宁可偶尔重复，不误并。
export function realtimeOutlineDedupKey(text: unknown): string {
  const cleaned = cleanRealtimeOutlineItemText(text, 200);
  return cleaned
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。、；：！？,.;:!?（）()「」【】《》""''·…—-]/gu, "");
}

export function makeRealtimeOutlineNode(
  anchor: unknown,
  title: unknown,
  children: unknown,
  index: unknown,
): RealtimeOutlineNode | null {
  const safeAnchor = stringValue(anchor).trim();
  const safeTitle = cleanRealtimeOutlineItemText(title, 90);
  if (!safeTitle) return null;
  const safeChildren: string[] = [];
  const childValues: unknown[] = Array.isArray(children) ? children : [];
  for (const child of childValues) {
    const text = cleanRealtimeOutlineItemText(child, 120);
    if (text && !safeChildren.includes(text)) safeChildren.push(text);
    if (safeChildren.length >= REALTIME_OUTLINE_STATE_MAX_CHILDREN) break;
  }
  const idSeed = [safeAnchor, safeTitle, stringValue(index) || "0"].join("|");
  return {
    id: `rt-${hashRealtimeOutlineText(idSeed)}`,
    anchor: safeAnchor,
    time: getRealtimeOutlineAnchorTime(safeAnchor),
    title: safeTitle,
    children: safeChildren,
  };
}

export function parseRealtimeOutlineStateFromMarkdown(markdown: unknown): RealtimeOutlineNode[] {
  const lines = stringValue(markdown).split(/\r?\n/);
  const nodes: RealtimeOutlineNode[] = [];
  let current: RealtimeOutlineNode | null = null;
  for (const raw of lines) {
    const line = String(raw || "");
    const child = /^ {2,}[-*+]\s+(.+)$/.exec(line);
    if (child && current) {
      const text = cleanRealtimeOutlineItemText(child[1], 120);
      if (text && !current.children.includes(text) && current.children.length < REALTIME_OUTLINE_STATE_MAX_CHILDREN) {
        current.children.push(text);
      }
      continue;
    }
    const top = /^ {0,1}[-*+]\s+(.+)$/.exec(line);
    if (top) {
      const body = (top[1] || "").trim();
      const anchor = (body.match(/\[\[[^\]\n]+\|\d{1,2}:\d{2}(?::\d{2})?\]\]/) || [])[0] || "";
      const node = makeRealtimeOutlineNode(anchor, body, [], nodes.length);
      if (node) {
        nodes.push(node);
        current = node;
      } else {
        current = null;
      }
      continue;
    }
  }
  // Prompt builders clip context independently. Persisting only the tail here
  // would silently erase the beginning of long meetings from the visible state.
  return nodes;
}

function clipRecruitOutlineMemoryText(text: unknown, maxChars: unknown): string {
  const max = Math.max(1, Math.floor(Number(maxChars) || 0));
  const cleaned = cleanRealtimeOutlineItemText(
    stringValue(text).replace(/^(?:❓|💬|🤖|⛏)\s*/u, ""),
    max + 1,
  );
  if (cleaned.length <= max) return cleaned;
  if (max === 1) return "…";
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

function buildRecruitOutlineMemoryNodeLine(node: RealtimeOutlineNode): string {
  const title = clipRecruitOutlineMemoryText(node.title, 36);
  if (!title) return "";
  const labelled = { question: "", answer: "", evaluation: "", followup: "", other: "" };
  for (const rawChild of node.children) {
    const child = String(rawChild || "").trim();
    if (!child) continue;
    if (/^❓/.test(child) && !labelled.question) labelled.question = clipRecruitOutlineMemoryText(child, 64);
    else if (/^💬/.test(child) && !labelled.answer) labelled.answer = clipRecruitOutlineMemoryText(child, 72);
    else if (/^🤖/.test(child) && !labelled.evaluation) labelled.evaluation = clipRecruitOutlineMemoryText(child, 72);
    else if (/^⛏/.test(child) && !labelled.followup) labelled.followup = clipRecruitOutlineMemoryText(child, 64);
    else if (!labelled.other) labelled.other = clipRecruitOutlineMemoryText(child, 72);
  }
  const details: string[] = [];
  if (labelled.answer) details.push(`答：${labelled.answer}`);
  if (labelled.evaluation) details.push(`判：${labelled.evaluation}`);
  if (labelled.followup) details.push(`待问：${labelled.followup}`);
  if (!details.length && labelled.question) details.push(`问：${labelled.question}`);
  if (!details.length && labelled.other) details.push(labelled.other);
  return details.length ? `${title}｜${details.join("｜")}` : title;
}

// Recruitment memory is derived only from committed nodes. Older topics remain
// as a compact index while recent topics keep evidence and follow-up details.
export function buildRecruitRealtimeOutlineMemory(
  nodesOrMarkdown: unknown,
  opts: RecruitRealtimeOutlineMemoryOptions = {},
): string {
  const sourceNodes = Array.isArray(nodesOrMarkdown)
    ? (nodesOrMarkdown as RealtimeOutlineNode[])
    : parseRealtimeOutlineStateFromMarkdown(nodesOrMarkdown);
  const nodes = sourceNodes.filter((node): node is RealtimeOutlineNode => (
    !!node && !!cleanRealtimeOutlineItemText(node.title, 90)
  ));
  if (!nodes.length) return "";

  const maxChars = Math.max(80, Math.floor(Number(opts.maxChars) || 800));
  const recentDetailCount = Math.max(2, Math.min(8, Math.floor(Number(opts.recentDetailCount) || 6)));
  const splitAt = Math.max(0, nodes.length - recentDetailCount);
  const olderNodes = nodes.slice(0, splitAt);
  const recentLines = nodes.slice(splitAt)
    .map(buildRecruitOutlineMemoryNodeLine)
    .filter(Boolean)
    .map((line) => `- ${line}`);

  let history = "";
  if (olderNodes.length) {
    const historyBudget = Math.min(180, Math.max(60, Math.floor(maxChars * 0.24)));
    history = clipRecruitOutlineMemoryText(
      `较早已讨论：${olderNodes
        .map((node) => clipRecruitOutlineMemoryText(node.title, 28))
        .filter(Boolean)
        .join("、")}`,
      historyBudget,
    );
  }

  let remaining = maxChars - history.length - (history ? 1 : 0);
  const selected: string[] = [];
  for (let index = recentLines.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const separatorChars = selected.length ? 1 : 0;
    const line = recentLines[index];
    if (line.length + separatorChars <= remaining) {
      selected.unshift(line);
      remaining -= line.length + separatorChars;
      continue;
    }
    if (!selected.length && remaining >= 24) {
      selected.unshift(clipRecruitOutlineMemoryText(line, remaining));
      remaining = 0;
    }
    break;
  }

  return [history, ...selected].filter(Boolean).join("\n").slice(0, maxChars).trim();
}

// Select the earliest uncommitted transcript segments, plus a small read-only
// lookback window for continuity. The returned commitThroughCount only covers
// segments actually included in this batch, so a capped window can never skip
// an older backlog and falsely mark it as processed.
export function selectIncrementalRealtimeOutlineSegments<T extends RealtimeOutlineSegmentLike>(
  segments: readonly (T | null | undefined)[] | null | undefined,
  opts: SelectIncrementalRealtimeOutlineOptions = {},
): IncrementalRealtimeOutlineSelection<T> {
  const source: readonly (T | null | undefined)[] = segments ?? [];
  const totalSegmentCount = source.length;
  const maxSegments = Math.max(1, Math.floor(Number(opts.maxSegments) || 10));
  const maxChars = Math.max(200, Math.floor(Number(opts.maxChars) || 6000));
  const sinceCount = Math.min(totalSegmentCount, Math.max(0, Math.floor(Number(opts.sinceCount) || 0)));
  const requestedLookback = Math.max(0, Math.floor(Number(opts.lookbackSegments) || 0));
  const lookbackCount = Math.min(requestedLookback, Math.max(0, maxSegments - 1));

  const valid = source
    .map((segment, sourceIndex) => ({ segment, sourceIndex }))
    .filter((entry): entry is { segment: T; sourceIndex: number } => {
      const segment = entry.segment;
      return !!segment && !!stringValue(segment.text).trim();
    });
  const previous = valid.filter(({ sourceIndex }) => sourceIndex < sinceCount).slice(-lookbackCount);
  const pending = valid.filter(({ sourceIndex }) => sourceIndex >= sinceCount);
  const selectedEntries: Array<{ segment: T; sourceIndex: number }> = previous.slice();
  const selectedNewEntries: Array<{ segment: T; sourceIndex: number }> = [];
  let chars = selectedEntries.reduce((sum, item) => sum + stringValue(item.segment.text).trim().length, 0);

  for (const item of pending) {
    if (selectedEntries.length >= maxSegments) break;
    const chunkChars = stringValue(item.segment.text).trim().length;
    if (selectedNewEntries.length > 0 && chars + chunkChars > maxChars) break;
    selectedEntries.push(item);
    selectedNewEntries.push(item);
    chars += chunkChars;
  }

  let commitThroughCount = sinceCount;
  if (selectedNewEntries.length) {
    commitThroughCount = selectedNewEntries[selectedNewEntries.length - 1].sourceIndex + 1;
    if (selectedNewEntries.length === pending.length) commitThroughCount = totalSegmentCount;
  } else if (!pending.length) {
    // Empty/failed ASR segments carry no outline information and are safe to
    // acknowledge without spending an LLM request.
    commitThroughCount = totalSegmentCount;
  }

  const firstSelectedIndex = selectedEntries.length ? selectedEntries[0].sourceIndex : totalSegmentCount;
  return {
    segments: selectedEntries.map(({ segment }) => segment),
    newSegments: selectedNewEntries.map(({ segment }) => segment),
    usedCount: selectedEntries.length,
    newUsedCount: selectedNewEntries.length,
    omittedBeforeCount: valid.filter(({ sourceIndex }) => sourceIndex < firstSelectedIndex).length,
    totalTextCount: valid.length,
    totalSegmentCount,
    approxChars: chars,
    isIncremental: sinceCount > 0,
    sinceCount,
    deltaTotalCount: pending.length,
    commitThroughCount,
    hasRemainingText: selectedNewEntries.length < pending.length,
  };
}

function renderRealtimeOutlineNodesMarkdown(
  nodes: readonly RealtimeOutlineNode[] | null | undefined,
): string {
  return (nodes ?? []).map((node) => {
    const head = `- ${node.anchor ? `${node.anchor} ` : ""}${node.title}`.trimEnd();
    const children = (Array.isArray(node.children) ? node.children : [])
      .map((child: string) => `  - ${child}`);
    return [head, ...children].join("\n");
  }).join("\n");
}

// Audio anchors are program-owned metadata, not part of the LLM contract.
// Always restore exact historical anchors by title and replace anchors on new
// nodes with approximate anchors derived from the real transcript segments.
// This prevents a useful outline from being rejected or merged incorrectly
// because the model omitted, copied, repeated, or invented a timestamp.
export function repairRealtimeOutlineAnchors(
  markdown: unknown,
  opts: RepairRealtimeOutlineAnchorsOptions = {},
): RepairRealtimeOutlineAnchorsResult {
  const source = stringValue(markdown).trim();
  const nodes = parseRealtimeOutlineStateFromMarkdown(source);
  if (!nodes.length) {
    return { outline: source, repairedCount: 0, restoredCount: 0, unresolvedCount: 0 };
  }

  const previousNodes = parseRealtimeOutlineStateFromMarkdown(opts.previousOutline || "");
  const previousByTitle = new Map<string, string>();
  for (const node of previousNodes) {
    const key = realtimeOutlineDedupKey(node.title);
    if (key && node.anchor && !previousByTitle.has(key)) previousByTitle.set(key, node.anchor);
  }

  const anchorSources = (opts.anchorSources ?? [])
    .map((item, index) => ({
      anchor: stringValue(item.anchor).trim(),
      index: Number.isFinite(Number(item.index)) ? Number(item.index) : index,
    }))
    .filter((item) => REALTIME_OUTLINE_ANCHOR_RE.test(item.anchor))
    .sort((a, b) => a.index - b.index);
  let repairedCount = 0;
  let restoredCount = 0;
  let replacedCount = 0;
  let unresolvedCount = 0;
  const freshNodes: RealtimeOutlineNode[] = [];

  for (const node of nodes) {
    const previousAnchor = previousByTitle.get(realtimeOutlineDedupKey(node.title));
    if (previousAnchor) {
      if (node.anchor !== previousAnchor) repairedCount++;
      if (node.anchor && node.anchor !== previousAnchor) replacedCount++;
      node.anchor = previousAnchor;
      node.time = getRealtimeOutlineAnchorTime(previousAnchor);
      restoredCount++;
      continue;
    }
    freshNodes.push(node);
  }

  for (let index = 0; index < freshNodes.length; index++) {
    const node = freshNodes[index];
    // Spread topics monotonically over the real source window. There may be
    // more candidate anchors than topics because each transcript segment
    // contributes several approximate positions.
    const sourceIndex = anchorSources.length
      ? Math.min(anchorSources.length - 1, Math.floor(index * anchorSources.length / freshNodes.length))
      : -1;
    const next = sourceIndex >= 0 ? anchorSources[sourceIndex] : null;
    if (!next) {
      if (node.anchor) {
        node.anchor = "";
        node.time = "";
        repairedCount++;
        replacedCount++;
      }
      unresolvedCount++;
      continue;
    }
    if (node.anchor !== next.anchor) repairedCount++;
    if (node.anchor && node.anchor !== next.anchor) replacedCount++;
    node.anchor = next.anchor;
    node.time = getRealtimeOutlineAnchorTime(next.anchor);
  }

  return {
    outline: renderRealtimeOutlineNodesMarkdown(nodes),
    repairedCount,
    restoredCount,
    replacedCount,
    unresolvedCount,
  };
}

// children 单调并集：只增不删、按 realtimeOutlineDedupKey 去重、existing 优先、截断 MAX_CHILDREN。
// 单调 = 模型某轮漏给的子要点不会删旧的；某轮给的脏/近义子要点最多多一条噪音、不顶替历史子要点。
// 代价（诚实）：早轮一条"错但独特"的子要点会被永久钉死（dedupKey 只挡近义、不挡内容错）——
// 但子项不进时间轴顶层、不可点击，污染面远小于顶层，净收益为正。
export function mergeOutlineChildrenMonotonic(
  existingChildren: readonly unknown[] | null | undefined,
  freshChildren: readonly unknown[] | null | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown): void => {
    const text = cleanRealtimeOutlineItemText(raw, 120);
    if (!text) return;
    const key = realtimeOutlineDedupKey(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  for (const c of (Array.isArray(existingChildren) ? existingChildren : [])) {
    if (out.length >= REALTIME_OUTLINE_STATE_MAX_CHILDREN) break;
    push(c);
  }
  for (const c of (Array.isArray(freshChildren) ? freshChildren : [])) {
    if (out.length >= REALTIME_OUTLINE_STATE_MAX_CHILDREN) break;
    push(c);
  }
  return out.slice(0, REALTIME_OUTLINE_STATE_MAX_CHILDREN);
}

// 冻结合并：把本轮新解析出的节点并入已有大纲状态，"历史冻结、只动末尾"。
// 目的——让大纲全部内容稳定存在、只在末尾增量生长：某一轮模型抽风最多影响"正在进行的最后一个话题 +
// 新话题"，永远碰不到已经定稿的历史话题（按锚点 / 标题识别去重）。这是实时大纲稳定性的根本保障。
// 升级（治"历史子要点补不全"）：不再只更新末尾节点——所有同锚点历史节点的 children 都做"单调并集合并"，
// 但 title/anchor/time 一律保留 existing（历史冻结、抗"A 被乱改"）。这样被新话题挤下末尾的历史话题，
// 后续轮仍能靠同锚点 fresh 补全子要点，大纲随会变厚而非停在稀薄；而 title/anchor 绝对不被模型本轮改写。
export function mergeStableRealtimeOutlineNodes(
  existingNodes: readonly (RealtimeOutlineNode | null | undefined)[] | null | undefined,
  freshNodes: readonly (RealtimeOutlineNode | null | undefined)[] | null | undefined,
): RealtimeOutlineNode[] {
  const existingInput: readonly (RealtimeOutlineNode | null | undefined)[] = Array.isArray(existingNodes) ? existingNodes : [];
  const existing = existingInput.filter((node): node is RealtimeOutlineNode => !!node);
  const freshInput: readonly (RealtimeOutlineNode | null | undefined)[] = Array.isArray(freshNodes) ? freshNodes : [];
  const fresh = freshInput.filter((node): node is RealtimeOutlineNode => !!node);
  if (!existing.length) return fresh;
  const freshByTitle = new Map<string, RealtimeOutlineNode>();
  const freshByAnchor = new Map<string, RealtimeOutlineNode[]>();
  for (const node of fresh) {
    const titleKey = realtimeOutlineDedupKey(node.title);
    if (titleKey && !freshByTitle.has(titleKey)) freshByTitle.set(titleKey, node);
    if (node.anchor) {
      const bucket = freshByAnchor.get(node.anchor) || [];
      bucket.push(node);
      freshByAnchor.set(node.anchor, bucket);
    }
  }
  const existingAnchorCounts = new Map<string, number>();
  const existingCompositeKeys = new Set<string>();
  const existingTitles = new Set<string>();
  for (const node of existing) {
    const titleKey = realtimeOutlineDedupKey(node.title);
    if (titleKey) existingTitles.add(titleKey);
    if (node.anchor) existingAnchorCounts.set(node.anchor, (existingAnchorCounts.get(node.anchor) || 0) + 1);
    existingCompositeKeys.add(`${node.anchor || ""}|${titleKey}`);
  }
  const consumedFresh = new Set<RealtimeOutlineNode>();
  const result: RealtimeOutlineNode[] = [];
  for (let i = 0; i < existing.length; i++) {
    const node = existing[i];
    const titleKey = realtimeOutlineDedupKey(node.title);
    let freshMatch = titleKey ? freshByTitle.get(titleKey) : null;
    if (freshMatch && consumedFresh.has(freshMatch)) freshMatch = null;
    // Backward compatibility for older outputs that retained an exact unique
    // anchor but lightly rewrote the title. Never use anchor-only matching when
    // several topics share the same source interval.
    if (!freshMatch && node.anchor && existingAnchorCounts.get(node.anchor) === 1) {
      const candidates = (freshByAnchor.get(node.anchor) || []).filter((item) => !consumedFresh.has(item));
      if (candidates.length === 1) freshMatch = candidates[0];
    }
    if (freshMatch) {
      consumedFresh.add(freshMatch);
      // children 单调并集；title/anchor/time 全取 existing —— 历史冻结，模型乱改 title 进不来。
      result.push(Object.assign({}, node, {
        children: mergeOutlineChildrenMonotonic(node.children, freshMatch.children),
      }));
    } else {
      result.push(node); // 无同锚点 fresh：原样保留（历史里已有的子要点也不丢）
    }
  }
  // 追加真正的新话题。时间锚点只表示大致区间，不是唯一键：同一三分钟
  // 分段可以有多个不同主题，按「区间 + 标题」复合键去重，绝不能只按时间吞掉后者。
  const appendedCompositeKeys = new Set<string>();
  for (const node of fresh) {
    if (consumedFresh.has(node)) continue;
    const titleKey = realtimeOutlineDedupKey(node.title);
    if (!titleKey) continue;
    const compositeKey = `${node.anchor || ""}|${titleKey}`;
    if (existingCompositeKeys.has(compositeKey) || appendedCompositeKeys.has(compositeKey)) continue;
    if (!node.anchor && existingTitles.has(titleKey)) continue;
    appendedCompositeKeys.add(compositeKey);
    result.push(node);
  }
  return result;
}

// opts.attachUntimed=true：把"首个带锚点 L1 之后"冒出的无锚点顶层行降级挂靠为上一带锚点节点的子项
// （治"延续讨论被整轮丢光"）。**只应在处理模型本轮 fresh 输出时开启**；处理 renderRealtimeOutlineStateMarkdown
// 产出的"已合并状态"时必须关闭（默认 false），否则会把状态里真实存在的无锚点历史顶层节点静默降级为子项、
// 改写历史结构。顶部（首个带锚点之前）的无锚点总览行无论如何仍丢弃（挂无可挂、会挤坏时间轴）。
export function normalizeOutlineMarkdownForDisplay(
  text: unknown,
  opts: NormalizeOutlineMarkdownOptions = {},
): string {
  const attachUntimed = !!(opts && opts.attachUntimed);
  const preserveUntimedTopLevel = !!(opts && opts.preserveUntimedTopLevel);
  const src = stringValue(text).trim();
  if (!src) return "";
  const lines = src.split(/\r?\n/);
  const hasTimedTopLevel = lines.some((line) => {
    const m = /^ {0,3}[-*+]\s+(.+)$/.exec(String(line || ""));
    return !!(m && /\[\[[^\]]+\|\d{1,2}:\d{2}(?::\d{2})?\]\]/.test(m[1]));
  });
  if (!hasTimedTopLevel) return src;

  const out: string[] = [];
  let skipUntimedBlock = false;
  let afterTimedTopLevel = false;
  let seenTimedTop = false; // 是否已出现过至少一个带锚点 L1（区分"顶部总览该丢" vs "中段延续该挂"）
  const numberedPrefix = /^\s*\d+[.)、．]\s*/;

  for (const rawLine of lines) {
    const line = String(rawLine || "");
    // 只把"几乎不缩进"（≤1 空格）的 bullet 当作顶层项。
    // 关键：子要点通常缩进 2 个及以上空格（`  - 子要点`），若这里用 {0,3} 容忍 3 空格，
    // 会把 2 空格的子要点误判成"顶层项"，再因其无时间锚点被整条丢弃——这正是
    // "大纲只剩光秃秃一级标题、子要点全没了"的真凶。收紧到 {0,1} 后，≥2 空格的子要点
    // 不再进入顶层丢弃逻辑，而是落到下方原样保留。
    const topBullet = /^( {0,1}[-*+]\s+)(.*)$/.exec(line);
    if (topBullet) {
      skipUntimedBlock = false;
      const body = topBullet[2] || "";
      const hasTime = /\[\[[^\]]+\|\d{1,2}:\d{2}(?::\d{2})?\]\]/.test(body);
      if (!hasTime) {
        if (preserveUntimedTopLevel) {
          out.push(line);
          afterTimedTopLevel = false;
          continue;
        }
        // 首个带锚点 L1 之后冒出的无锚点顶层行 = 延续讨论。开启 attachUntimed 时降级挂靠为上一带锚点
        // 节点的子项（治"内容白丢"），挂靠后落到上一话题 children、被冻结合并保留；不开启则按旧逻辑丢。
        if (attachUntimed && seenTimedTop) {
          const childBody = body.replace(numberedPrefix, "").trim();
          if (childBody) { out.push("  - " + childBody); afterTimedTopLevel = false; continue; }
        }
        // 顶部（首个带锚点之前）的无锚点"课程结构 / 总览"类总结：不可点击、挂无可挂、会挤坏时间轴 → 丢弃。
        skipUntimedBlock = true;
        afterTimedTopLevel = false;
        continue;
      }
      const normalizedBody = body.replace(/(\]\])\s*\d+[.)、．]\s*/, "$1 ");
      out.push(topBullet[1] + normalizedBody);
      afterTimedTopLevel = true;
      seenTimedTop = true;
      continue;
    }

    if (skipUntimedBlock) {
      if (/^\s+/.test(line) || !line.trim()) continue;
      skipUntimedBlock = false;
    }

    if (afterTimedTopLevel && numberedPrefix.test(line)) {
      out.push("  - " + line.replace(numberedPrefix, "").trim());
      continue;
    }

    if (line.trim()) afterTimedTopLevel = false;
    out.push(line);
  }
  return out.join("\n").trim();
}

// 招聘需求挖掘（recruit-needs）会中覆盖态的"单调累积"合并。
// 覆盖是"截至目前是否谈到过某维"的累积事实——业务方不会"取消"已经谈过的东西。
// 规则：某维一旦达到 covered/partial，本轮即便没在转写里再次看到也绝不退回 missing；
// 仍允许 covered↔partial 双向调整（业务方改口澄清），只拦"退回 missing"。
// 注意：不再要求 prev 必须带 evidence_anchor 才冻结——旧的"有锚点才冻结"条件正是字段树
// "忽有忽无"的根：模型常省略锚点，导致已覆盖维度本轮被判 missing 时保不住、覆盖数闪回。
// freeze=false 时不冻结、本轮 fresh 完全为准（允许 covered/partial 退回 missing）——
// 用于"早期轮"(转写还很短、模型最易误判)，让早期误判的 covered 能自我纠正，不被永久锁死；
// 成熟轮(freeze=true)再启用单调累积防闪回。
export function mergeCoverageNoRegress(
  freshDims: CoverageDimensions | null | undefined,
  prevDims: CoverageDimensions | null | undefined,
  freeze = true,
): CoverageDimensions {
  const fresh: CoverageDimensions = freshDims && typeof freshDims === "object" ? freshDims : {};
  const prev: CoverageDimensions = prevDims && typeof prevDims === "object" ? prevDims : {};
  const out: CoverageDimensions = {};
  for (const key of Object.keys(fresh)) {
    const f = fresh[key] || {};
    const p = prev[key] || null;
    if (freeze && f.status === "missing" && p && p.status && p.status !== "missing") {
      out[key] = p; // 整对象保留（含锚点 / 追问话术等），单调不回退
    } else {
      out[key] = f;
    }
  }
  return out;
}

// Phase 3 会中"追问建议"：从覆盖态 dims + 反馈压制 + 规则库，派生"已排序、已去重、已截断 K"的追问卡数组。
// 纯函数（无 DOM / Obsidian 依赖），便于 vitest 回归——排序/去重/反馈过滤是最易出 bug 又最该锁住的逻辑。
// opts: { rules:{[key]:{fallback,priority}}, dimOrder:[{key,name,group}], suppressed:Set|Array<key>, maxCards:number }
// 规则：跳过 covered/无效状态、跳过被反馈压制(suppressed)的维；
//   reason 取 missing_what，没有则用命中的模糊词拼一句，再没有则按状态给默认语；
//   question 取模型 followup_question，空则回落 rules[key].fallback；
//   排序纯按 priority 降序 → missing 先于 partial → dimOrder 原序。
//   vague_hits 只进 reason 文案、不参与排序——避免"刚说过模糊词的软维"抢占"硬维缺失"的有限名额。
export function deriveFollowupCards(
  dims: Record<string, FollowupDimension> | null | undefined,
  opts: DeriveFollowupCardsOptions = {},
): FollowupCard[] {
  const d: Record<string, FollowupDimension> = dims && typeof dims === "object" ? dims : {};
  const rules: Record<string, FollowupRule> = opts.rules && typeof opts.rules === "object" ? opts.rules : {};
  const dimOrder: readonly FollowupDimensionMeta[] = Array.isArray(opts.dimOrder) ? opts.dimOrder : [];
  const suppressed: ReadonlySet<string> = opts.suppressed instanceof Set
    ? opts.suppressed
    : new Set<string>(Array.isArray(opts.suppressed) ? opts.suppressed : []);
  const maxCards = typeof opts.maxCards === "number" && Number.isFinite(opts.maxCards)
    ? Math.max(0, opts.maxCards)
    : 3;
  const statusRank: Record<FollowupCardStatus, number> = { missing: 0, partial: 1 };
  const cards: FollowupCard[] = [];
  for (let i = 0; i < dimOrder.length; i++) {
    const meta = dimOrder[i] || {};
    const key = meta.key;
    if (!key || suppressed.has(key)) continue;
    const item = d[key] || {};
    const status = item.status === "partial" || item.status === "missing" ? item.status : null;
    if (!status) continue; // covered 或无效状态 → 不产卡
    const rule = rules[key] || {};
    const vagueHits = Array.isArray(item.vague_hits) ? item.vague_hits.filter(Boolean) : [];
    const missingWhat = stringValue(item.missing_what).trim();
    const reason = missingWhat
      || (vagueHits.length ? `提到「${vagueHits.map(stringValue).filter(Boolean).join("、")}」但不够具体` : (status === "missing" ? "尚未谈到" : "提到但不够具体"));
    const question = stringValue(item.followup_question).trim()
      || stringValue(rule.fallback).trim();
    cards.push({
      key,
      name: meta.name || key,
      group: meta.group || "",
      status,
      reason,
      vagueHits,
      question,
      priority: typeof rule.priority === "number" && Number.isFinite(rule.priority) ? rule.priority : 0,
      order: i,
    });
  }
  cards.sort((a, b) =>
    (b.priority - a.priority)
    || (statusRank[a.status] - statusRank[b.status])
    || (a.order - b.order)
  );
  return cards.slice(0, maxCards);
}

export function validateRealtimeOutlineMarkdown(
  outline: unknown,
  opts: ValidateRealtimeOutlineOptions = {},
): RealtimeOutlineValidationResult {
  const text = stringValue(outline).trim();
  const previousOutline = stringValue(opts.previousOutline).trim();
  if (!text) {
    return previousOutline ? { ok: false, reason: "empty_outline" } : { ok: true, reason: "" };
  }
  const lines = text.split(/\r?\n/);
  // 只统计真·顶层项（≤1 空格缩进）。子要点缩进 ≥2 空格，绝不能算成顶层——否则富大纲会被
  // "顶层项过多(>10)" 和 "无锚点占比过高(>0.35)" 误杀，导致大纲被丢弃、永远停在稀薄状态。
  const topBullets: string[] = [];
  for (const line of lines) {
    const m = /^ {0,1}[-*+]\s+(.+)$/.exec(String(line || ""));
    if (m) topBullets.push((m[1] || "").trim());
  }
  if (!topBullets.length) {
    return { ok: false, reason: "no_top_level_bullets" };
  }
  // 顶层项上限只看"本轮相对已有大纲【新增】的顶层项"，不看全量——长会里累积顶层项必然 >10，
  // 旧的"全量 >10 即判废"会让大纲过了约 50 分钟就整轮被否、停更并丢失中段内容（已知 bug）。
  // 只有单轮新增过多（模型把层级摊平成一长串）才判废；累积变多交给下游冻结合并 + 节点上限兜底。
  const prevTopCount = previousOutline
    ? previousOutline.split(/\r?\n/).filter((l) => /^ {0,1}[-*+]\s+/.test(String(l || ""))).length
    : 0;
  const maxNewTopLevel = Math.max(1, Number(opts.maxNewTopLevel) || 8);
  // Incremental LLM responses contain delta nodes only. Subtracting the
  // historical count in that mode would make the limit ineffective as soon
  // as the accumulated outline became longer than the current response.
  const newTopLevelCount = opts.deltaOnly
    ? topBullets.length
    : Math.max(0, topBullets.length - prevTopCount);
  if (newTopLevelCount > maxNewTopLevel) {
    return { ok: false, reason: "too_many_top_level_bullets" };
  }
  if (!opts.allowUntimedTopLevel) {
    const timedTopBullets = topBullets.filter((body) => /\[\[[^\]]+\|\d{1,2}:\d{2}(?::\d{2})?\]\]/.test(body));
    const hasPreviousTimed = /\[\[[^\]]+\|\d{1,2}:\d{2}(?::\d{2})?\]\]/.test(previousOutline);
    if (hasPreviousTimed && timedTopBullets.length === 0) {
      return { ok: false, reason: "lost_all_time_anchors" };
    }
    const untimedRatio = topBullets.length ? (topBullets.length - timedTopBullets.length) / topBullets.length : 0;
    if (hasPreviousTimed && untimedRatio > 0.35) {
      return { ok: false, reason: "too_many_untimed_top_level_items" };
    }
  }
  const suspiciousNumberedTitle = topBullets.find((body) => /\]\]\s*\d+[.)、．]/.test(body));
  if (suspiciousNumberedTitle) {
    return { ok: false, reason: "numbered_items_inline_in_title" };
  }
  return { ok: true, reason: "" };
}

export interface EntityEvidenceFinding {
  name: string;
  outputCount: number;
  transcriptCount: number;
}

// 人物指认幻觉的机械探测：找出"AI 产出里反复引用、但原始转写里几乎没出现"的具名实体。
// 背景：模型可能把转写里零星出现的称呼提升为贯穿全文的核心人物（如把只提到三次的"某外号"
// 指认为一号位），这类绑定用户难以察觉、最伤信任。本函数按字面子串计数做软探测——
  // 转写错字会让真实人名计数偏低（如"李扣"被转写成"你扣"），所以结果只能作核对提示，绝不能自动删改。
export function findLowEvidenceEntities(
  names: string[],
  outputText: string,
  transcript: string,
  opts: { minOutputMentions?: number; maxTranscriptMentions?: number } = {},
): EntityEvidenceFinding[] {
  const minOut = opts.minOutputMentions ?? 3;
  const maxTr = opts.maxTranscriptMentions ?? 3;
  const out = String(outputText || "");
  const tr = String(transcript || "");
  const countIn = (hay: string, needle: string): number => (needle ? hay.split(needle).length - 1 : 0);
  const findings: EntityEvidenceFinding[] = [];
  const seen = new Set<string>();
  for (const raw of names || []) {
    const name = String(raw || "").trim();
    // 单字名子串误命中率太高（"扣"会命中"折扣"），不参与探测
    if (!name || name.length < 2 || seen.has(name)) continue;
    seen.add(name);
    const outputCount = countIn(out, name);
    const transcriptCount = countIn(tr, name);
    // 产出里成为高频实体（≥minOut 次）、转写里证据稀薄（≤maxTr 次）、且明显倒挂（产出 > 转写）才报
    if (outputCount >= minOut && transcriptCount <= maxTr && outputCount > transcriptCount) {
      findings.push({ name, outputCount, transcriptCount });
    }
  }
  return findings;
}

// ============================================================
// 招聘项目化（HR 模块）纯函数地基：JD 章节抽取 / 必要素质清单序列化 /
// 简历脱敏 / 项目名净化。无 obsidian / DOM / IO，便于 vitest 覆盖；F2/F3/F4.2/F5/F6 复用。
// ============================================================

// 从 markdown 正文里抽取某标题（如 "## 岗位描述"）下的一段：取该标题之后、
// 直到下一个"同级或更高级标题"或文件尾。找不到该标题返回 ""（回退策略由调用方决定）。
export function extractMarkdownSection(md: unknown, heading: unknown): string {
  const text = stringValue(md);
  const h = stringValue(heading).trim();
  if (!h) return "";
  const headLevel = (h.match(/^#+/) || [""])[0].length || 0;
  const headBody = h.replace(/^#+\s*/, "").trim();
  if (!headLevel || !headBody) return "";
  const lines = text.split(/\r?\n/);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*?)\s*$/);
    if (m && m[1].length === headLevel && m[2].trim() === headBody) { startIdx = i; break; }
  }
  if (startIdx < 0) return "";
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= headLevel) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

// 把 JD 的「综合素质」对象数组序列化成注入提示词的【必要素质清单】文本块。
// 每项形如 { 素质, 定义, 信号 }（兼容 name/definition/signal）。序号即"必要素质核验表"行号
// （提示词增 A 据此逐项产出）。无有效项返回 ""。
export function serializeRequiredQualities(qualities: unknown): string {
  const list: unknown[] = Array.isArray(qualities) ? qualities : [];
  const clean: Array<{ name: string; def: string; signal: string }> = [];
  for (const q of list) {
    if (!isObjectRecord(q)) continue;
    const name = stringValue(q.素质 ?? q.name).trim();
    if (!name) continue;
    const def = stringValue(q.定义 ?? q.definition).trim();
    const signal = stringValue(q.信号 ?? q.signal).trim();
    clean.push({ name, def, signal });
  }
  if (!clean.length) return "";
  const lines = ["【必要素质清单】"];
  clean.forEach((q, i) => {
    let line = `${i + 1}. ${q.name}`;
    if (q.def) line += `：${q.def}`;
    if (q.signal) line += `（信号：${q.signal}）`;
    lines.push(line);
  });
  return lines.join("\n");
}

// 简历脱敏：手机号 / 身份证号 / 邮箱替换成占位符（仅作用于注入文本，原文件不动）。
// 顺序要点：先替身份证（18 位）再替手机号——否则身份证里出生年份段（如 "1990…"）会被
// 手机号正则先吃掉一截，导致身份证整体匹配不到而漏网；手机号再加数字边界，避免吃到长串数字的子段。
export function desensitizeResumeText(text: unknown): string {
  return stringValue(text)
    .replace(/\d{6}(?:19|20)\d{2}(?:0\d|1[0-2])(?:[0-2]\d|3[01])\d{3}[\dXx]/g, "[身份证]")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[邮箱]");
}

// 项目（招聘岗位）文件夹名净化：替换 Windows/Obsidian 非法字符为短横，去首尾点和空白，空名兜底。
export function sanitizeProjectFolderName(name: unknown): string {
  const cleaned = stringValue(name)
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  return cleaned || "未命名项目";
}

// ============================================================
// 报告改色（纯白弥散报告）：用 CSS filter:hue-rotate 把整篇按色相整体旋到用户选的颜色。
// 一次覆盖 hex / rgba / 渐变 / 弥散光晕；纯灰阶（白/黑/灰/近黑文字）几乎不受色相旋转影响。纯函数，便于单测。
// ============================================================

// 报告模板的基准强调色（暖橙）——用户所选颜色与它的色相差就是 hue-rotate 角度。
export const REPORT_BASE_ACCENT_HEX = "#E85F28";

// hex → 色相(0-360)。非法返回 null。3 位/6 位都认。
export function hexToHue(hex: unknown): number | null {
  let h = stringValue(hex).trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0; // 灰阶，色相无意义
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  return (hue + 360) % 360;
}

// 目标色相相对基准橙的最短旋转角（-180..180 的整数）。无法解析或同色相返回 0。
export function reportHueDelta(
  targetHex: unknown,
  baseHex: unknown = REPORT_BASE_ACCENT_HEX,
): number {
  const base = hexToHue(baseHex || REPORT_BASE_ACCENT_HEX);
  const tgt = hexToHue(targetHex);
  if (base == null || tgt == null) return 0;
  let d = ((tgt - base) % 360 + 360) % 360;
  if (d > 180) d -= 360;     // 取最短方向，旋转量更小、色彩漂移更可控
  return Math.round(d);
}

// 把报告 HTML 整体改色：注入 body{filter:hue-rotate(Δdeg)}。Δ=0（同色相，如默认橙）原样返回。
export function recolorReportHtml(
  html: unknown,
  targetHex: unknown,
  baseHex: unknown = REPORT_BASE_ACCENT_HEX,
): string {
  const s = stringValue(html);
  if (!s) return s;
  const delta = reportHueDelta(targetHex, baseHex);
  if (!delta) return s;
  const style = `<style id="lexvoice-report-recolor">body{filter:hue-rotate(${delta}deg)}</style>`;
  return s.includes("</head>") ? s.replace("</head>", style + "</head>") : style + s;
}
