/**
 * 就地更正笔记里的误识别词。
 *
 * 与词表（`易错写法`）的区别：这里是**一次性、仅当前笔记**的替换，
 * 不写入任何全局配置，因此不会影响后续转写。
 *
 * 音频是事实源，文字稿由音频生成；在文字稿上更正听错的名词不是篡改记录。
 * 因此除机器数据外全稿替换——摘要、正文、实时大纲、原始转写都改。
 */

/** 受保护、不参与替换的区域。 */
export interface CorrectionOptions {
  /** 大小写敏感。默认 false（与既有易错写法替换一致：英文词忽略大小写）。 */
  caseSensitive?: boolean;
}

export interface CorrectionResult {
  /** 替换后的全文。 */
  text: string;
  /** 替换处数。 */
  replacements: number;
  /** 发生替换的行号（1 起，升序）。供预览显示。 */
  lines: number[];
}

interface Range {
  start: number;
  end: number;
}

/**
 * 找出不参与替换的区间：前置 frontmatter、HTML 注释、围栏代码块。
 *
 * - frontmatter：YAML 结构，替换可能破坏转义与值语义。
 * - HTML 注释：机器数据与锚点。`qnalog-note-index` 的 JSON 正文在里面，
 *   直接替换可能破坏 JSON 转义；它由 refreshNoteIndex 从正文重算，不必在这里改。
 * - 围栏代码块：示例代码里的词通常是刻意写的。
 */
function findProtectedRanges(markdown: string): Range[] {
  const text = String(markdown || "");
  const ranges: Range[] = [];

  // 前置 frontmatter：仅当文件以 --- 开头
  const frontmatter = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (frontmatter) ranges.push({ start: 0, end: frontmatter[0].length });

  // HTML 注释（含跨行）。机器锚点与索引 JSON 都在其中。
  const comment = /<!--[\s\S]*?-->/g;
  let m: RegExpExecArray | null;
  while ((m = comment.exec(text)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }

  // 围栏代码块（``` 或 ~~~，允许 ```lang）
  const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm;
  while ((m = fence.exec(text)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }

  return ranges.sort((a, b) => a.start - b.start);
}

function isProtected(ranges: Range[], index: number): boolean {
  return ranges.some((r) => index >= r.start && index < r.end);
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 统计某个偏移量落在第几行（1 起）。 */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/**
 * 在整篇 Markdown 里把 `from` 替换成 `to`，跳过受保护区域。
 *
 * 纯函数：不改文件、不读配置。界面拿到结果后可只用于预览，也可写回。
 */
export function applyNoteTextCorrection(
  markdown: string,
  from: string,
  to: string,
  options: CorrectionOptions = {},
): CorrectionResult {
  const text = String(markdown || "");
  const needle = String(from == null ? "" : from);
  const replacement = String(to == null ? "" : to);
  if (!text || !needle || needle === replacement) {
    return { text, replacements: 0, lines: [] };
  }

  const protectedRanges = findProtectedRanges(text);
  const flags = options.caseSensitive ? "g" : "gi";
  const pattern = new RegExp(escapeRegExp(needle), flags);

  let out = "";
  let cursor = 0;
  let replacements = 0;
  const lines: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    // 零宽匹配（needle 非空时不会发生）防御：避免死循环
    if (m.index === pattern.lastIndex) { pattern.lastIndex += 1; continue; }
    if (isProtected(protectedRanges, m.index)) continue;
    out += text.slice(cursor, m.index) + replacement;
    cursor = m.index + m[0].length;
    replacements += 1;
    lines.push(lineAt(text, m.index));
  }
  if (!replacements) return { text, replacements: 0, lines: [] };
  out += text.slice(cursor);

  return { text: out, replacements, lines };
}
