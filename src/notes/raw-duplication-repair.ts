/**
 * 修复「原地重新整理」把原始材料重复写入的母本（2026-10-24 回归，见 reorganize-in-place-flow.ts）。
 *
 * 只是纯函数：不读写文件，不提供命令或界面。输入一篇重复的母本，返回只保留一份正文与一份原始材料的
 * Markdown；无法确认结果只含每个转写块一份时抛错，调用方不应写入。
 *
 * 规则：
 * - 正文取活动版本块（没有时取标题之后）里第一个原始材料块之前的内容，保留会话知识注释与原话出处区块；
 * - 原始材料按块去重：转写块按转写 ID，其余折叠块按摘要（去掉「第 N/M 部分」），隐藏数据按属性名，
 *   会话注释按原文；重复时保留最后一份（转写数据 span 只附在最后一份上），顺序沿用最后一份的位置；
 * - 转写块摘要里的「第 N/M 部分」按去重后的数量重新编号。
 */
import { labelPattern, labelText } from "../shared/note-labels";
import { NS_TAG } from "../shared/namespace";
import { countTranscriptBlockIds, findActiveVersionBlock, hasRawMaterial, splitLeadingFrontmatter } from "./note-document";

interface RawUnit { key: string; text: string }

const PART_SUFFIX_RE = new RegExp(`\\s*${labelPattern("transcriptPartSuffix").source}`);
const HEADING_RE = new RegExp(`^(?:---\\s*\\n+)?##\\s+(?:📁\\s*)?(?:${labelPattern("originalMaterial").source})\\s*$`, "gim");
const HIDDEN_SPAN_RE = /^<span\s+hidden\b[^>]*>\s*<\/span>/i;
const SESSION_COMMENT_RE = new RegExp(`^<!--\\s*${NS_TAG}-(?:session|continuation-committed)\\b[^>]*-->`, "i");

/** 顶层 `<details>` 块的结束位置（支持嵌套）；不是完整块时返回 -1。 */
function detailsEnd(text: string, start: number): number {
  const re = /<details\b[^>]*>|<\/details\s*>/gi;
  re.lastIndex = start;
  let depth = 0;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }
  return -1;
}

function unitKey(block: string): string {
  const transcript = new RegExp(`<!--\\s*${NS_TAG}-transcript-start:([^\\s>]+)\\s*-->`).exec(block);
  if (transcript) return `transcript:${transcript[1]}`;
  if (/^<details/i.test(block)) {
    const summary = /<summary>([\s\S]*?)<\/summary>/i.exec(block)?.[1] ?? "";
    return `details:${summary.replace(PART_SUFFIX_RE, "").trim()}`;
  }
  if (/^<span/i.test(block)) {
    const attribute = /\sdata-([\w-]+)=/.exec(block)?.[1] ?? block;
    return `span:${attribute}`;
  }
  return `text:${block.trim()}`;
}

/** 依次取出原始材料块：折叠块、隐藏数据 span 与会话注释；其余文字（分隔线、标题、空行）丢弃。 */
function collectRawUnits(text: string): RawUnit[] {
  const units: RawUnit[] = [];
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const next = rest.search(/<details\b|<span\s+hidden\b|<!--\s*qnalog-(?:session|continuation-committed)\b/i);
    if (next < 0) break;
    const start = index + next;
    let end = -1;
    if (/^<details/i.test(text.slice(start))) end = detailsEnd(text, start);
    else {
      const span = HIDDEN_SPAN_RE.exec(text.slice(start)) || SESSION_COMMENT_RE.exec(text.slice(start));
      if (span) end = start + span[0].length;
    }
    if (end < 0) { index = start + 1; continue; }
    const block = text.slice(start, end);
    units.push({ key: unitKey(block), text: block });
    index = end;
  }
  return units;
}

function dedupeKeepLast(units: readonly RawUnit[]): RawUnit[] {
  const seen = new Set<string>();
  const kept: RawUnit[] = [];
  for (let i = units.length - 1; i >= 0; i--) {
    if (seen.has(units[i].key)) continue;
    seen.add(units[i].key);
    kept.unshift(units[i]);
  }
  return kept;
}

/** 转写块摘要里的「第 N/M 部分」按保留的块重新编号（同一段落的片段一起计数）。 */
function renumberParts(units: RawUnit[]): RawUnit[] {
  const groups = new Map<string, number>();
  const base = (unit: RawUnit) => /<summary>([\s\S]*?)<\/summary>/i.exec(unit.text)?.[1]?.replace(PART_SUFFIX_RE, "").trim() ?? "";
  for (const unit of units) if (unit.key.startsWith("transcript:") && PART_SUFFIX_RE.test(unit.text)) groups.set(base(unit), (groups.get(base(unit)) || 0) + 1);
  const seen = new Map<string, number>();
  return units.map((unit) => {
    if (!unit.key.startsWith("transcript:") || !PART_SUFFIX_RE.test(unit.text)) return unit;
    const name = base(unit);
    const position = (seen.get(name) || 0) + 1;
    seen.set(name, position);
    return { ...unit, text: unit.text.replace(PART_SUFFIX_RE, labelText("transcriptPartSuffix", position, groups.get(name) || position)) };
  });
}

export interface RawDuplicationRepair {
  markdown: string;
  /** 修复前每个转写块出现的最多次数；1 表示没有重复。 */
  maxCopiesBefore: number;
  transcriptBlocks: number;
}

/** 重复的母本 → 一份正文、一份原始材料。结果不满足「每个转写块一份、一个原始材料标题」时抛错。 */
export function repairDuplicatedRawMaterial(markdown: string): RawDuplicationRepair {
  const text = String(markdown || "").replace(/\r\n/g, "\n");
  const { frontmatter, body } = splitLeadingFrontmatter(text);
  const before = countTranscriptBlockIds(text);
  const maxCopiesBefore = Math.max(0, ...before.values());
  const title = /^\s*(#\s+[^\n]+)\n?/.exec(body);
  const afterTitle = title ? body.slice(title[0].length) : body;

  const active = findActiveVersionBlock(afterTitle);
  const firstRaw = (value: string) => {
    const at = value.search(/<details\b|<span\s+hidden\b/i);
    return at < 0 ? value.length : at;
  };
  let organized: string;
  let rawSource: string;
  if (active) {
    const activeBody = afterTitle.slice(active.bodyStart, active.bodyEnd);
    const cut = firstRaw(activeBody);
    const visible = activeBody.slice(0, cut).replace(/(?:\n\s*---\s*)+\s*$/, "").trimEnd();
    organized = `${afterTitle.slice(0, active.bodyStart)}${visible}\n${afterTitle.slice(active.bodyEnd, active.end)}`;
    rawSource = `${activeBody.slice(cut)}\n${afterTitle.slice(active.end)}`;
  } else {
    const headingAt = afterTitle.search(HEADING_RE);
    const limit = Math.min(firstRaw(afterTitle), headingAt < 0 ? afterTitle.length : headingAt);
    organized = afterTitle.slice(0, limit).replace(/(?:\n\s*---\s*)+\s*$/, "").trimEnd();
    rawSource = afterTitle.slice(limit);
  }
  const units = renumberParts(dedupeKeepLast(collectRawUnits(rawSource)));
  const raw = units.map((unit) => unit.text).join("\n\n");
  const repaired = [
    frontmatter ? frontmatter.trimEnd() : "",
    title ? title[1] : "",
    organized.trim(),
    "---",
    `## ${labelText("originalMaterial")}`,
    raw,
  ].filter(Boolean).join("\n\n") + "\n";

  const after = countTranscriptBlockIds(repaired);
  const headings = (repaired.match(HEADING_RE) || []).length;
  if ([...after.values()].some((count) => count !== 1) || after.size !== before.size || headings !== 1
    || hasRawMaterial(organized.replace(new RegExp(`<!--\\s*${NS_TAG}-session-knowledge[\\s\\S]*?-->`, "g"), ""))) {
    throw new Error("The duplicated note could not be rebuilt with exactly one copy of each transcript block.");
  }
  return { markdown: repaired, maxCopiesBefore, transcriptBlocks: after.size };
}
