import { getTranscriptMetadataRanges } from "../transcript/transcript-markdown";

interface Range {
  start: number;
  end: number;
}

/** 返回 frontmatter、HTML 注释、机器标记与围栏代码块的文本区间。 */
export function findProtectedRanges(markdown: string): Range[] {
  const text = String(markdown || "");
  const ranges: Range[] = [];
  const frontmatter = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (frontmatter) ranges.push({ start: 0, end: frontmatter[0].length });

  const comment = /<!--[\s\S]*?-->/g;
  let match: RegExpExecArray | null;
  while ((match = comment.exec(text)) !== null) ranges.push({ start: match.index, end: match.index + match[0].length });
  ranges.push(...getTranscriptMetadataRanges(text));

  const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm;
  while ((match = fence.exec(text)) !== null) ranges.push({ start: match.index, end: match.index + match[0].length });
  return ranges.sort((left, right) => left.start - right.start);
}
