import { QNALOG_ACTIVE_VERSION_END, QNALOG_ACTIVE_VERSION_START } from "../shared/limits";
import { labelText } from "../shared/note-labels";
import { NS_TAG, nsRe } from "../shared/namespace";
import {
  extractAllRawBlocksFromText,
  findActiveVersionBlock,
  replaceExistingActiveVersionBlock,
  splitLeadingFrontmatter,
} from "../notes/note-document";
import { sanitizeActiveVersionBody } from "./version-content";
import { normalizeSessionKnowledgeMarkers } from "../briefing/session-knowledge";

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
    `> [!info]- ${labelText("currentDisplayedVersionLabel")}${label} ${QNALOG_ACTIVE_VERSION_START}`,
    created ? `> ${labelText("versionGeneratedAtLabel")}${created}` : "",
    sourceHash ? `> ${labelText("sourceTranscriptFingerprintLabel")}${sourceHash}` : "",
  ].filter(Boolean).join("\n");
  return [
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
  const activeRange = findActiveVersionBlock(text);
  const replaced = activeRange
    ? replaceLegacyRangePreservingRawTail(text, activeRange, block)
    : replaceExistingActiveVersionBlock(text, block);
  if (replaced !== null) {
    const preserved = preserveSessionMetadata(text, replaced);
    return normalizeSessionKnowledgeMarkers(normalizeRawMaterialScaffold(preserved));
  }
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
    const adopted = normalizeRawMaterialScaffold([
      parts.frontmatter ? parts.frontmatter.trimEnd() : "",
      titleBlock,
      "",
      block,
    ].filter(Boolean).join("\n") + rawTail);
    return normalizeSessionKnowledgeMarkers(normalizeRawMaterialScaffold(preserveSessionMetadata(text, adopted)));
  }
  const adopted = normalizeRawMaterialScaffold([
    parts.frontmatter ? parts.frontmatter.trimEnd() : "",
    block,
  ].filter(Boolean).join("\n") + rawTail);
  return normalizeSessionKnowledgeMarkers(normalizeRawMaterialScaffold(preserveSessionMetadata(text, adopted)));
}

/** Collapse repeated raw-material scaffolds left by older active-version boundaries. */
function normalizeRawMaterialScaffold(markdown: string): string {
  let text = String(markdown || "");
  const headings = [...text.matchAll(/^##\s+(?:原始材料|Original material)\s*$/gm)];
  for (const heading of headings.slice(1).reverse()) {
    const start = heading.index || 0;
    const prefix = text.slice(0, start);
    const separator = prefix.match(/\n---\s*\n+$/);
    const removeStart = separator ? start - separator[0].length + 1 : start;
    text = text.slice(0, removeStart) + text.slice(start + heading[0].length).replace(/^\r?\n+/, "");
  }
  const heading = /^##\s+(?:原始材料|Original material)\s*$/m.exec(text);
  const endPattern = new RegExp(`(?:<span\\s+data-${NS_TAG}=["']active-version-end["']\\s*><\\/span>|<!--\\s*${nsRe("active-version-end")}\\s*-->)`, "i");
  if (heading) {
    const beforeHeading = text.slice(0, heading.index);
    const separator = beforeHeading.match(/\n---\s*\n+$/);
    const marker = text.slice(heading.index).match(endPattern);
    if (separator && marker) {
      const markerText = marker[0];
      const body = beforeHeading.slice(0, beforeHeading.length - separator[0].length).replace(endPattern, "").replace(/\s+$/, "");
      const raw = text.slice(heading.index).replace(markerText, "");
      text = `${body}\n${markerText}\n\n---\n\n${raw}`;
    }
  }
  const firstHeading = /^##\s+(?:原始材料|Original material)\s*$/m.exec(text);
  const activeEnd = endPattern.exec(text);
  if (firstHeading && activeEnd && activeEnd.index < firstHeading.index) {
    const betweenRaw = text.slice(activeEnd.index + activeEnd[0].length, firstHeading.index);
    const between = betweenRaw
      .replace(/^\s*---\s*(?:\r?\n|$)/, "")
      .replace(/(?:\r?\n)\s*---\s*$/, "")
      .trim();
    const hasRawMaterial = /<details\b|<!--|<span\s+hidden\b/i.test(between);
    if (between && hasRawMaterial) {
      const body = text.slice(0, activeEnd.index + activeEnd[0].length).replace(/\s+$/, "");
      const rawAfterHeading = text.slice(firstHeading.index + firstHeading[0].length)
        .replace(/^\s*---\s*(?:\r?\n|$)/, "")
        .trim();
      const rawContent = [between, rawAfterHeading].filter(Boolean).join("\n\n");
      const headingText = firstHeading[0];
      text = `${body}\n\n---\n\n${headingText}${rawContent ? `\n\n${rawContent}` : ""}`;
    }
  }
  return text.replace(/\n{4,}/g, "\n\n\n");
}

function preserveSessionMetadata(previous: string, next: string): string {
  const markerRe = new RegExp(
    `<!--\\s*(?:${nsRe("session-knowledge")}\\s+[\\s\\S]*?|${nsRe("session")}(?::|\\s)[^>]*|${nsRe("continuation-committed")}:[^>]*)-->`, "gi",
  );
  const missing = [...previous.matchAll(markerRe)].map((match) => match[0]).filter((marker) => !next.includes(marker));
  if (!missing.length) return next;
  const indexBlockRe = /<details>\s*<summary>[^<]*(?:索引数据|Index data)[^<]*<\/summary>([\s\S]*?)<\/details>/i;
  const indexBlock = indexBlockRe.exec(next);
  if (indexBlock) {
    const additions = missing.filter((marker) => !indexBlock[1].includes(marker));
    if (!additions.length) return next;
    const body = `${indexBlock[1].trimEnd()}\n${additions.join("\n")}`;
    // 函数式替换：body 含会话注释原文，字符串形式会让其中的 $ 序列被改写。
    return next.slice(0, indexBlock.index) + indexBlock[0].replace(indexBlock[1], () => body) + next.slice(indexBlock.index + indexBlock[0].length);
  }
  const rawHeadingRe = /^##\s+(?:原始材料|Original material)\s*$/m;
  const tail = `<details>\n<summary>${labelText("indexData")}</summary>\n${missing.join("\n")}\n</details>`;
  return rawHeadingRe.test(next)
    ? `${next.trimEnd()}\n\n${tail}\n`
    : `${next.trimEnd()}\n\n---\n\n## ${labelText("originalMaterial")}\n\n${tail}\n`;
}

function replaceLegacyRangePreservingRawTail(
  text: string,
  activeRange: NonNullable<ReturnType<typeof findActiveVersionBlock>>,
  block: string,
): string {
  const oldRange = text.slice(activeRange.start, activeRange.end);
  const rawStart = oldRange.search(/\n---\s*\n+##\s+(?:原始材料|Original material)\s*\n/i);
  if (rawStart < 0) {
    const extracted = extractAllRawBlocksFromText(oldRange);
    const sessionMetadata = oldRange.match(new RegExp(
      `<!--\\s*(?:${nsRe("session-knowledge")}\\s+[\\s\\S]*?|${nsRe("session")}(?::|\\s)[^>]*|${nsRe("continuation-committed")}:[^>]*)-->`, "gi",
    )) || [];
    const retained = [...new Set([...extracted.tail.matchAll(/<!--[\\s\\S]*?-->/g)].map((match) => match[0]))];
    const looseMetadata = sessionMetadata.filter((marker) => !retained.some((item) => item.includes(marker)));
    const metadataBlock = looseMetadata.length
      ? `<details>\n<summary>${labelText("indexData")}</summary>\n${looseMetadata.join("\n")}\n</details>`
      : "";
    const contents = [extracted.tail, metadataBlock].filter(Boolean).join("\n");
    if (!contents) return replaceExistingActiveVersionBlock(text, block) || text;
    const rawTail = `\n\n---\n\n## ${labelText("originalMaterial")}\n\n${contents}\n`;
    return `${text.slice(0, activeRange.start)}${block}${rawTail}${text.slice(activeRange.end)}`;
  }
  const rawTail = oldRange.slice(rawStart)
    .replace(new RegExp(`(?:<span\\s+data-${NS_TAG}=["']active-version-end["']\\s*><\\/span>|<!--\\s*${nsRe("active-version-end")}\\s*-->)[\\s\\S]*$`, "i"), "")
    .replace(/\s+$/, "\n");
  return `${text.slice(0, activeRange.start)}${block}${rawTail}${text.slice(activeRange.end)}`;
}
