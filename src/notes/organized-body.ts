import { AI_FAILURE_PLACEHOLDER_RE, findActiveVersionBlock, stripFrontmatterSimple, stripUtilityDetailsBlocks } from "./note-document";
import { labelPattern } from "../shared/note-labels";
import { EMPTY_LLM_OUTPUT_FALLBACK_RE } from "./note-write-content";

const ORGANIZED_HEADING_RE = /^##\s+(?:✨\s*)?(?:整合版|Merged version)[^\n]*$/gm;
const RAW_MATERIAL_HEADING_RE = /^##\s+(?:📁\s*)?(?:原始材料|Original material)[^\n]*$/m;
const FAILURE_PLACEHOLDER_RE = new RegExp(AI_FAILURE_PLACEHOLDER_RE.source, "g");
// 导入时写入草稿的信息提示块（标题行加连续的 `>` 续行）：程序生成的元数据，不是整理正文。
const DRAFT_IMPORT_INFO_CALLOUT_RE = new RegExp(
  `^>\\s*\\[!info\\][+-]?\\s*(?:${labelPattern("importInfo").source}|${labelPattern("textImportInfo").source})[^\\n]*(?:\\n>[^\\n]*)*`,
  "gm",
);

/**
 * 判断笔记的整理正文（活动版本块内，或原始材料之前）是否有实际内容。
 * 只有标题、版本说明、整合版标题与 AI 整理失败占位行时返回 false。
 */
export function hasOrganizedBody(markdown: string): boolean {
  const text = stripFrontmatterSimple(String(markdown || "").replace(/\r\n/g, "\n"));
  const active = findActiveVersionBlock(text);
  const rawAt = text.search(RAW_MATERIAL_HEADING_RE);
  const beforeRaw = rawAt >= 0 ? text.slice(0, rawAt) : text;
  const region = active ? active.body : beforeRaw;
  const content = stripUtilityDetailsBlocks(region)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<span\b[^>]*>\s*<\/span>/gi, "")
    .replace(FAILURE_PLACEHOLDER_RE, "")
    .replace(EMPTY_LLM_OUTPUT_FALLBACK_RE, "")
    .replace(ORGANIZED_HEADING_RE, "")
    .replace(/^#\s[^\n]*$/gm, "")
    .replace(DRAFT_IMPORT_INFO_CALLOUT_RE, "")
    .replace(/^>\s*\[![^\n]*$/gm, "")
    .replace(/^\s*---\s*$/gm, "");
  return content.trim().length > 0;
}
