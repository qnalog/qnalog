import { QNALOG_ACTIVE_VERSION_END, QNALOG_ACTIVE_VERSION_START } from "../shared/limits";
import { labelText } from "../shared/note-labels";
import {
  extractAllRawBlocksFromText,
  replaceExistingActiveVersionBlock,
  splitLeadingFrontmatter,
} from "../notes/note-document";
import { sanitizeActiveVersionBody } from "./version-content";

export interface ActiveVersionMeta {
  label?: unknown;
  kind?: unknown;
  createdAt?: unknown;
  sourceHash?: unknown;
}

export function buildActiveVersionBlock(versionMeta: ActiveVersionMeta | null | undefined, body: string): string {
  // Preserve the previous String coercion for persisted metadata values.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Preserve historical coercion for persisted metadata.
  const label = String(versionMeta && versionMeta.label || versionMeta && versionMeta.kind || labelText("currentVersion"));
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Preserve historical coercion for persisted metadata.
  const created = String(versionMeta && versionMeta.createdAt || "");
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Preserve historical coercion for persisted metadata.
  const sourceHash = String(versionMeta && versionMeta.sourceHash || "");
  // label 已含模式前缀与整理偏好，不再拼内部 mode 键（monologue 这类键直接见了用户）。
  // 折叠默认收起：版本卡是元数据，正文摘要应当先被看到。
  const metaLines = [
    `> [!info]- ${labelText("currentDisplayedVersionLabel")}${label}`,
    created ? `> ${labelText("versionGeneratedAtLabel")}${created}` : "",
    sourceHash ? `> ${labelText("sourceTranscriptFingerprintLabel")}${sourceHash}` : "",
  ].filter(Boolean).join("\n");
  return [
    QNALOG_ACTIVE_VERSION_START,
    metaLines,
    "",
    sanitizeActiveVersionBody(body),
    QNALOG_ACTIVE_VERSION_END,
  ].join("\n").replace(/\n{4,}/g, "\n\n\n");
}

export function replaceActiveVersionBlock(
  markdown: string,
  versionMeta: ActiveVersionMeta | null | undefined,
  body: string,
): string {
  const text = String(markdown || "");
  const block = buildActiveVersionBlock(versionMeta, body);
  const replaced = replaceExistingActiveVersionBlock(text, block);
  if (replaced !== null) return replaced;
  // First adoption of the version model compacts the mother note:
  // keep only frontmatter, H1, active display block, and raw/source metadata.
  // The previous rendered minutes/clean text is already persisted in the version store.
  const extracted = extractAllRawBlocksFromText(text);
  const parts = splitLeadingFrontmatter(extracted.withoutRaw);
  const bodyText = parts.body || "";
  const titleMatch = bodyText.match(/^#\s+[^\n]+\n*/);
  const rawTail = extracted.tail ? `\n\n---\n\n${extracted.tail.trimEnd()}\n` : "\n";
  if (titleMatch) {
    const titleBlock = titleMatch[0].trimEnd();
    return [
      parts.frontmatter ? parts.frontmatter.trimEnd() : "",
      titleBlock,
      "",
      block,
    ].filter(Boolean).join("\n") + rawTail;
  }
  return [
    parts.frontmatter ? parts.frontmatter.trimEnd() : "",
    block,
  ].filter(Boolean).join("\n") + rawTail;
}
