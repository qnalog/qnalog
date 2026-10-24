/**
 * 「决定与待办的原话出处」区块：整理正文末尾的可见小节，每条决定或待办一行，
 * 列出说话人、回到录音时间点的链接和一句原话摘录，供用户点开回听核对。
 *
 * 数据来源与边界（MAINTAINING §6.1 第 3 条、§7.4 第 2 条）：
 * - 条目与证据编号取自已校验的会话知识（status 为 complete）；
 * - 时间只取转写账本里该句的 audioRef（录音文件内的起点），不取模型输出；
 * - 链接写成 `[[录音|mm:ss]]`，精度后缀写在链接之外，正文时间链接的点击处理不需要改动；
 * - 证据只能校验「编号存在」，不能校验「内容相关」，因此区块注明出处由模型选出、需回听核对；
 * - 起始标记带会话知识 ID 与转写来源版本，重新整理时整块替换，一篇笔记只留一个区块。
 *
 * 纯函数模块：不依赖 Obsidian、DOM 或文件读写。
 */
import { formatElapsed } from "../shared/util-common";
import { labelText } from "../shared/note-labels";
import { t } from "../shared/i18n";
import { NS_TAG } from "../shared/namespace";
import type { Segment } from "../shared/types";
import type { Utterance } from "../transcript/session-transcript";
import {
  buildKnowledgeEvidenceIndex,
  resolveIndexedUtterance,
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

/**
 * 生成区块 Markdown。以下情况返回空字符串：会话知识缺失或不是 complete、
 * 转写账本已与知识记录的来源不一致、没有可解析到账本句子的决定或待办。
 */
export function buildEvidenceLinksBlock(knowledge: SessionKnowledge | null | undefined, segments: readonly Segment[]): string {
  if (!knowledge || knowledge.status !== "complete") return "";
  const index = buildKnowledgeEvidenceIndex(knowledge, segments);
  if (!index.fresh || !index.byId.size) return "";
  const lines = [
    ...renderKind(labelText("evidenceDecision"), knowledge.decisions, index),
    ...renderKind(labelText("evidenceAction"), knowledge.actions, index),
  ];
  if (!lines.length) return "";
  return [
    startMarker(knowledge.id, knowledge.sourceRevision),
    `## ${labelText("evidenceLinksHeading")}`,
    "",
    `_${labelText("evidenceLinksNote")}_`,
    "",
    ...lines,
    "",
    END_MARKER,
  ].join("\n");
}

interface MergedItem { text: string; evidence: string[] }

/** 同类条目里文字相同（忽略空白差异）的合并为一条，出处按出现顺序去重合并。 */
function mergeDuplicateItems(items: readonly KnowledgeItem[]): MergedItem[] {
  const byText = new Map<string, MergedItem>();
  for (const item of items) {
    const text = inlineText(item.text);
    if (!text) continue;
    const existing = byText.get(text);
    if (existing) {
      for (const id of item.evidence) if (!existing.evidence.includes(id)) existing.evidence.push(id);
    } else {
      byText.set(text, { text, evidence: [...new Set(item.evidence)] });
    }
  }
  return [...byText.values()];
}

function renderKind(typeLabel: string, items: readonly KnowledgeItem[], index: KnowledgeEvidenceIndex): string[] {
  const lines: string[] = [];
  for (const item of mergeDuplicateItems(items)) {
    const utterances = item.evidence
      .map((id) => resolveIndexedUtterance(index, id))
      .filter((utterance): utterance is Utterance => !!utterance);
    if (!utterances.length) continue;
    const shown = utterances.slice(0, EVIDENCE_LINKS_PER_ITEM).map(renderEvidence);
    const hidden = utterances.length - shown.length;
    if (hidden > 0) shown.push(labelText("evidenceMore", hidden));
    lines.push(`- **${typeLabel}**${t(": ")}${item.text} — ${shown.join(" · ")}`);
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

/** 精度按 audioRef.precision：provider 不加后缀；audio-span 加「约」；segment 指向段起点并注明「约在此段」；unknown 不出链接。 */
function renderTime(utterance: Utterance): string {
  const ref = utterance.audioRef;
  const startMs = ref && typeof ref.startMs === "number" && Number.isFinite(ref.startMs) && ref.startMs >= 0 ? ref.startMs : null;
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
  const chars = Array.from(text);
  const clipped = chars.length > EVIDENCE_QUOTE_MAX_CHARS
    ? `${chars.slice(0, EVIDENCE_QUOTE_MAX_CHARS - 1).join("").trimEnd()}…`
    : text;
  return labelText("evidenceQuote", clipped);
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
