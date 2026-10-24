/**
 * 「决定与待办的原话出处」区块：整理正文末尾的可见小节，每条决定或待办一行，
 * 列出说话人、回到录音时间点的链接和一句原话摘录，供用户点开回听核对。
 *
 * 数据来源与边界（MAINTAINING §6.1 第 3 条、§7.4 第 2 条）：
 * - 条目与证据编号取自已校验的会话知识（status 为 complete）；
 * - 时间只取转写账本里该句的 audioRef（录音文件内的起点），不取模型输出；
 * - 链接写成 `[[录音|mm:ss]]`，精度后缀写在链接之外，正文时间链接的点击处理不需要改动；
 * - 证据只能校验「编号存在」，不能校验「内容相关」，因此区块注明出处由模型选出、需回听核对；
 * - 决定带状态标签（已确认 / 提议 / 有分歧 / 未定 / 已被替代），待办带负责人、期限与「未明确接下」；
 *   这些只写在本区块，不写进模型生成的正文。旧笔记（会话知识 v2）的条目没有这些字段，按原样显示；
 * - 说话人与负责人写普通文字，提及标记（『』/ []）由整理流程最后一步统一补上（audio/speaker-mentions.ts）；
 * - 起始标记带会话知识 ID 与转写来源版本，重新整理时整块替换，一篇笔记只留一个区块。
 *
 * 纯函数模块：不依赖 Obsidian、DOM 或文件读写。
 */
import { formatElapsed } from "../shared/util-common";
import { labelText } from "../shared/note-labels";
import { t } from "../shared/i18n";
import { NS_TAG } from "../shared/namespace";
import type { Segment } from "../shared/types";
import type { TranscriptAudioRef, Utterance } from "../transcript/session-transcript";
import {
  buildKnowledgeEvidenceIndex,
  isNormalizationIssue,
  resolveIndexedUtterance,
  type DecisionStatus,
  type KnowledgeEvidenceIndex,
  type KnowledgeItem,
  type SessionKnowledge,
} from "./session-knowledge";

/** 每条最多显示的出处数；其余写成「另有 k 处」。 */
export const EVIDENCE_LINKS_PER_ITEM = 3;
/** 原话摘录的最大字符数（按 Unicode 码点计）。 */
export const EVIDENCE_QUOTE_MAX_CHARS = 40;

// 起止标记沿用正文里激活版本块的写法（空 span 加 data 属性，见 shared/limits.ts 的 QNALOG_ACTIVE_VERSION_START）：
// 可见正文里不放 HTML 注释，机器注释只留在折叠的「索引数据」里。
const START_VALUE = "evidence-links-start";
const END_VALUE = "evidence-links-end";
const END_MARKER = `<span data-${NS_TAG}="${END_VALUE}"></span>`;
const START_MARKER_RE = `<span\\s+data-${NS_TAG}=["']${START_VALUE}["'][^>]*>\\s*<\\/span>`;
const END_MARKER_RE = `<span\\s+data-${NS_TAG}=["']${END_VALUE}["'][^>]*>\\s*<\\/span>`;

function startMarker(knowledgeId: string, sourceRevision: string): string {
  return `<span data-${NS_TAG}="${START_VALUE}" data-${NS_TAG}-knowledge="${encodeURIComponent(knowledgeId)}" data-${NS_TAG}-source-revision="${encodeURIComponent(sourceRevision)}"></span>`;
}

function blockPattern(global: boolean): RegExp {
  return new RegExp(`[ \\t]*${START_MARKER_RE}[\\s\\S]*?${END_MARKER_RE}[ \\t]*\\n?`, global ? "g" : "");
}

/** 区块起始标记里记录的会话知识 ID 与转写来源版本；按出现顺序返回。 */
export function readEvidenceLinkBlockIdentities(markdown: string): Array<{ knowledgeId: string; sourceRevision: string }> {
  const pattern = new RegExp(START_MARKER_RE, "g");
  return [...String(markdown || "").matchAll(pattern)].map((match) => ({
    knowledgeId: safeDecode(attribute(match[0], `data-${NS_TAG}-knowledge`)),
    sourceRevision: safeDecode(attribute(match[0], `data-${NS_TAG}-source-revision`)),
  }));
}

function attribute(tag: string, name: string): string {
  return new RegExp(`\\s${name}=["']([^"']*)["']`).exec(tag)?.[1] ?? "";
}

/** 删除全部完整区块（起止标记之间的内容一并删除）；只有起始标记、没有结束标记的残片不动。 */
export function stripEvidenceLinkBlocks(markdown: string): string {
  const text = String(markdown || "");
  const stripped = text.replace(blockPattern(true), "");
  return stripped === text ? text : stripped.replace(/\n{3,}/g, "\n\n");
}

/** 把区块放在可见正文末尾；已有区块时整块替换，`block` 为空时删除已有区块。 */
export function placeEvidenceLinkBlock(body: string, block: string): string {
  const text = String(body || "");
  const stripped = stripEvidenceLinkBlocks(text);
  if (!block) return stripped === text ? text : stripped.trimEnd();
  const visible = stripped.trimEnd();
  return `${visible}${visible ? "\n\n" : ""}${block}`;
}

/** 只因个别条目格式不对或引用了不存在的原句而成为 partial：其余条目的证据已校验，可以列出。 */
const ITEM_LEVEL_ISSUES = new Set<string>(["invalid-item", "unknown-evidence"]);
function itemsOmitted(knowledge: SessionKnowledge): boolean {
  return knowledge.issues.some((issue) => ITEM_LEVEL_ISSUES.has(issue.reason));
}
function renderable(knowledge: SessionKnowledge): boolean {
  if (knowledge.status === "complete") return true;
  if (knowledge.status !== "partial") return false;
  return itemsOmitted(knowledge)
    && knowledge.issues.every((issue) => isNormalizationIssue(issue.reason) || ITEM_LEVEL_ISSUES.has(issue.reason));
}

/**
 * 生成区块 Markdown。以下情况返回空字符串：会话知识缺失、不可用或已过期，partial 的原因不只是个别条目无效、
 * 转写账本已与知识记录的来源不一致、没有可解析到账本句子的决定或待办。个别条目被省略时加一行说明。
 */
export function buildEvidenceLinksBlock(knowledge: SessionKnowledge | null | undefined, segments: readonly Segment[]): string {
  if (!knowledge || !renderable(knowledge)) return "";
  const index = buildKnowledgeEvidenceIndex(knowledge, segments);
  if (!index.fresh || !index.byId.size) return "";
  const lines = [
    ...renderItems(orderDecisions(mergeDuplicateItems(knowledge.decisions)), index, (item) => decisionLabel(item.status), (item) => decisionSuffix(item, knowledge.decisions)),
    ...renderItems(mergeDuplicateItems(knowledge.actions), index, () => labelText("evidenceAction"), actionSuffix),
  ];
  if (!lines.length) return "";
  return [
    startMarker(knowledge.id, knowledge.sourceRevision),
    `## ${labelText("evidenceLinksHeading")}`,
    "",
    `_${labelText("evidenceLinksNote")}_`,
    ...(itemsOmitted(knowledge) ? [`_${labelText("evidenceLinksOmitted")}_`] : []),
    "",
    ...lines,
    "",
    END_MARKER,
  ].join("\n");
}

type MergedItem = Omit<KnowledgeItem, "id" | "topicIds"> & { ids: string[] };

/**
 * 同类条目里文字相同（忽略空白差异）的合并为一条，出处按出现顺序去重合并。
 * 状态、负责人、期限与接下情况取后出现的一条（分部合并时后面的分部覆盖前面的）。
 */
function mergeDuplicateItems(items: readonly KnowledgeItem[]): MergedItem[] {
  const byText = new Map<string, MergedItem>();
  for (const item of items) {
    const text = inlineText(item.text);
    if (!text) continue;
    const existing = byText.get(text);
    if (existing) {
      for (const id of item.evidence) if (!existing.evidence.includes(id)) existing.evidence.push(id);
      existing.ids.push(item.id);
      for (const field of ["status", "supersededBy", "owner", "due", "acceptance"] as const) {
        if (item[field] !== undefined) Object.assign(existing, { [field]: item[field] });
      }
    } else {
      byText.set(text, { ...item, text, evidence: [...new Set(item.evidence)], ids: [item.id] });
    }
  }
  return [...byText.values()];
}

/** 决定的显示顺序：已确认、提议、有分歧、未定、已被替代；旧笔记（v2）没有状态的条目与提议同列。 */
const DECISION_ORDER = ["confirmed", "proposed", "disputed", "open", "superseded"] as const;
function orderDecisions(items: MergedItem[]): MergedItem[] {
  const rank = (item: MergedItem) => DECISION_ORDER.indexOf(item.status ?? "proposed");
  return items.map((item, position) => ({ item, position }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.position - b.position)
    .map(({ item }) => item);
}

function decisionLabel(status: DecisionStatus | undefined): string {
  switch (status) {
    case "confirmed": return labelText("evidenceDecisionConfirmed");
    case "proposed": return labelText("evidenceDecisionProposed");
    case "disputed": return labelText("evidenceDecisionDisputed");
    case "open": return labelText("evidenceDecisionOpen");
    case "superseded": return labelText("evidenceDecisionSuperseded");
    default: return labelText("evidenceDecision");
  }
}

/** 已被替代的决定写出替代它的决定（截断到 EVIDENCE_QUOTE_MAX_CHARS）；找不到替代条目时不写箭头。 */
function decisionSuffix(item: MergedItem, decisions: readonly KnowledgeItem[]): string {
  if (item.status !== "superseded" || !item.supersededBy) return "";
  const replacement = decisions.find((entry) => entry.id === item.supersededBy);
  const text = replacement ? clip(inlineText(replacement.text)) : "";
  return text ? labelText("evidenceSupersededBy", text) : "";
}

/** 待办的负责人、期限与「未明确接下」；旧笔记（v2）的待办没有这些字段，不加后缀。 */
function actionSuffix(item: MergedItem): string {
  const owner = inlineText(item.owner || "");
  const due = inlineText(item.due || "");
  return [
    owner ? labelText("evidenceOwner", owner) : "",
    due ? labelText("evidenceDue", due) : "",
    item.acceptance === "assigned" ? labelText("evidenceNotAccepted") : "",
  ].join("");
}

function renderItems(
  items: readonly MergedItem[],
  index: KnowledgeEvidenceIndex,
  label: (item: MergedItem) => string,
  suffix: (item: MergedItem) => string,
): string[] {
  const lines: string[] = [];
  for (const item of items) {
    const utterances = item.evidence
      .map((id) => resolveIndexedUtterance(index, id))
      .filter((utterance): utterance is Utterance => !!utterance);
    if (!utterances.length) continue;
    const shown = utterances.slice(0, EVIDENCE_LINKS_PER_ITEM).map(renderEvidence);
    const hidden = utterances.length - shown.length;
    if (hidden > 0) shown.push(labelText("evidenceMore", hidden));
    lines.push(`- **${label(item)}**${t(": ")}${item.text}${suffix(item)} — ${shown.join(" · ")}`);
  }
  return lines;
}

function renderEvidence(utterance: Utterance): string {
  const speaker = renderSpeaker(utterance.speakerName);
  const time = renderTime(utterance);
  const quote = renderQuote(utterance.normalizedText);
  return [`${speaker}${speaker ? " " : ""}${time}`, quote].filter(Boolean).join(" ");
}

/**
 * 说话人按转写里的显示名写成普通文字，与整理正文的写法相同：编号形式（「说话人2」）
 * 由命名流程 `replaceSpeakerDisplayName`（audio/channel-speakers.ts）在正文各行一并改写。
 */
function renderSpeaker(name: string | null): string {
  return inlineText(name || "");
}

/** 录音文件内的起点（毫秒）；没有引用、起点缺失或不是非负有限数时返回 null。精度由调用方按 `ref.precision` 判断。 */
export function audioRefStartMs(ref: TranscriptAudioRef | null | undefined): number | null {
  return ref && typeof ref.startMs === "number" && Number.isFinite(ref.startMs) && ref.startMs >= 0 ? ref.startMs : null;
}

/** 精度按 audioRef.precision：provider 不加后缀；audio-span 加「约」；segment 指向段起点并注明「约在此段」；unknown 不出链接。 */
function renderTime(utterance: Utterance): string {
  const ref = utterance.audioRef;
  const startMs = audioRefStartMs(ref);
  if (!ref || startMs === null || ref.precision === "unknown") return labelText("evidenceTimeUnknown").trim();
  const label = formatElapsed(startMs);
  const target = linkTarget(ref.path) || linkTarget(ref.name);
  const link = target ? `[[${target}|${label}]]` : label;
  if (ref.precision === "audio-span") return `${link}${labelText("evidenceApprox")}`;
  if (ref.precision === "segment") return `${link}${labelText("evidenceInSegment")}`;
  return link;
}

/** 链接目标里不能出现会截断 wiki 链接的字符；出现时改用文件名，仍不行就只写时间。 */
function linkTarget(value: string | null | undefined): string {
  const text = String(value || "").trim();
  return text && !/[[\]|#^\r\n]/.test(text) ? text : "";
}

function renderQuote(value: string): string {
  const text = inlineText(value);
  if (!text) return "";
  return labelText("evidenceQuote", clip(text));
}

/** 按 Unicode 码点截断到 EVIDENCE_QUOTE_MAX_CHARS，超出时以「…」结尾。 */
function clip(text: string): string {
  const chars = Array.from(text);
  return chars.length > EVIDENCE_QUOTE_MAX_CHARS
    ? `${chars.slice(0, EVIDENCE_QUOTE_MAX_CHARS - 1).join("").trimEnd()}…`
    : text;
}

/** 单行文字：合并空白，去掉会打开注释或 wiki 链接的字符序列。 */
function inlineText(value: string): string {
  return String(value || "")
    .replace(/<!--|-->/g, " ")
    .replace(/\[\[/g, "[").replace(/\]\]/g, "]")
    .replace(/\s+/g, " ")
    .trim();
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}
