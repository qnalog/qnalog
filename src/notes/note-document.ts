import {
  NS_ACTIVE_VERSION_BODY_RE,
  NS_SEDIMENT_BLOCK_RE,
  NS_SEGMENTS_BLOCK_RE,
  NS_SESSION_LINE_RE,
  NS_SESSION_VALUE_RE,
} from "../shared/namespace";
import { UTILITY_DETAILS_SUMMARY_RE } from "../shared/note-labels";

const UTILITY_DETAILS_BLOCK_RE = new RegExp(
  String.raw`<details>\s*<summary>[^<]*${UTILITY_DETAILS_SUMMARY_RE.source}[^<]*<\/summary>[\s\S]*?<\/details>`,
  "gi",
);

export interface ActiveVersionBlockRange {
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
  body: string;
}

export function findFirstNoteBoundary(markdown: string, patterns: readonly RegExp[]): number {
  const text = String(markdown || "");
  let boundary = text.length;
  for (const pattern of patterns) {
    const index = text.search(pattern);
    if (index >= 0 && index < boundary) boundary = index;
  }
  return boundary;
}

export interface NoteDetailsBlockRange {
  start: number;
  end: number;
  summaryStart: number;
  summaryEnd: number;
  bodyStart: number;
  bodyEnd: number;
}

export function* iterateNoteDetailsBlocks(markdown: string): IterableIterator<NoteDetailsBlockRange> {
  const text = String(markdown || "");
  const re = /(<details>\s*<summary>)([\s\S]*?)(<\/summary>\s*)([\s\S]*?)<\/details>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const start = match.index;
    const summaryStart = start + match[1].length;
    const summaryEnd = summaryStart + match[2].length;
    const bodyStart = summaryEnd + match[3].length;
    yield {
      start,
      end: start + match[0].length,
      summaryStart,
      summaryEnd,
      bodyStart,
      bodyEnd: bodyStart + match[4].length,
    };
  }
}

export interface NoteHeadingBlockRange {
  start: number;
  bodyStart: number;
  bodyEnd: number;
  match: RegExpExecArray;
}

export function* iterateNoteHeadingBlocks(
  markdown: string,
  headingPattern: RegExp,
  nextBoundaryPattern?: RegExp,
): IterableIterator<NoteHeadingBlockRange> {
  const text = String(markdown || "");
  const flags = headingPattern.flags.includes("g") ? headingPattern.flags : `${headingPattern.flags}g`;
  const headings = new RegExp(headingPattern.source, flags);
  let match: RegExpExecArray | null = headings.exec(text);
  while (match) {
    const start = match.index;
    const bodyStart = start + match[0].length;
    const nextHeading = headings.exec(text);
    let bodyEnd = text.length;
    if (nextBoundaryPattern) {
      const boundary = text.slice(bodyStart).search(nextBoundaryPattern);
      if (boundary >= 0) bodyEnd = bodyStart + boundary;
    } else if (nextHeading) {
      bodyEnd = nextHeading.index;
    }
    yield { start, bodyStart, bodyEnd, match };
    match = nextHeading;
  }
}

export function findActiveVersionBlock(markdown: string): ActiveVersionBlockRange | null {
  const text = String(markdown || "");
  const match = NS_ACTIVE_VERSION_BODY_RE.exec(text);
  if (!match) return null;
  const start = match.index;
  const relativeBodyStart = match[0].indexOf(match[1], match[0].indexOf("-->") + 3);
  const bodyStart = start + relativeBodyStart;
  return {
    start,
    end: start + match[0].length,
    bodyStart,
    bodyEnd: bodyStart + match[1].length,
    body: match[1],
  };
}

export function stripUtilityDetailsBlocks(markdown: string): string {
  return String(markdown || "").replace(UTILITY_DETAILS_BLOCK_RE, "\n");
}

export interface NoteDocumentParts {
  frontmatter: string;
  body: string;
}

export interface RawNoteDocumentParts {
  tail: string;
  withoutRaw: string;
}

export function splitLeadingFrontmatter(markdown: string): NoteDocumentParts {
  const text = String(markdown || "").replace(/^\uFEFF/, "");
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return { frontmatter: "", body: text };
  return {
    frontmatter: match[0].replace(/\r\n/g, "\n").replace(/\n*$/, "\n"),
    body: text.slice(match[0].length).replace(/^(?:\r?\n)+/, ""),
  };
}

export function getFrontmatterYaml(frontmatter: string): string {
  const normalized = String(frontmatter || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  const parts = splitLeadingFrontmatter(`${normalized}\n`);
  if (!parts.frontmatter) return normalized;
  return parts.frontmatter
    .replace(/^---\n/, "")
    .replace(/\n---\n?$/, "")
    .trim();
}

export function wrapFrontmatterYaml(yaml: string): string {
  const value = String(yaml || "").replace(/\r\n/g, "\n").trim();
  return value ? `---\n${value}\n---\n` : "";
}

export function replaceLeadingFrontmatter(markdown: string, frontmatter: string, clearWhenEmpty = false): string {
  const current = splitLeadingFrontmatter(markdown);
  const yaml = getFrontmatterYaml(frontmatter);
  if (!yaml) {
    if (!clearWhenEmpty || !current.frontmatter) return String(markdown || "");
    return current.body.replace(/^(?:\r?\n)+/, "");
  }
  const body = current.body.replace(/^(?:\r?\n)+/, "");
  return `${wrapFrontmatterYaml(yaml).trimEnd()}${body ? `\n\n${body}` : "\n"}`;
}

export function replaceExistingActiveVersionBlock(markdown: string, block: string): string | null {
  const text = String(markdown || "");
  if (!findActiveVersionBlock(text)) return null;
  return text.replace(NS_ACTIVE_VERSION_BODY_RE, String(block || ""));
}


export function extractAllRawBlocksFromText(text: string): RawNoteDocumentParts {
  let s = String(text || "");
  const seen = new Set<string>();
  const tailParts: string[] = [];
  const stash = (block: string): string => {
    const trimmed = String(block || "").trim();
    if (!trimmed) return "";
    if (seen.has(trimmed)) return "";
    seen.add(trimmed);
    tailParts.push(trimmed);
    return "";
  };

  const detailsPatterns: RegExp[] = [
    /<details>\s*\n?<summary>[^<\n]*?(?:录音信息|Recording info)[^<\n]*?<\/summary>[\s\S]*?<\/details>/gi,
    /<details>\s*\n?<summary>[^<\n]*?(?:原始音频|Original audio)[^<\n]*?<\/summary>[\s\S]*?<\/details>/gi,
    /<details>\s*\n?<summary>[^<\n]*?(?:录音中实时大纲|Live outline while recording)[^<\n]*?<\/summary>[\s\S]*?<\/details>/gi,
    /<details>\s*\n?<summary>[^<\n]*?(?:回听时间轴|Playback timeline)[^<\n]*?<\/summary>[\s\S]*?<\/details>/gi,
    /<details>\s*\n?<summary>[^<\n]*?(?:分段原始转写|Segmented raw transcript)[^<\n]*?<\/summary>[\s\S]*?<\/details>/gi,
    /<details>\s*\n?<summary>[^<\n]*?(?:文本导入来源|Text import source)[^<\n]*?<\/summary>[\s\S]*?<\/details>/gi,
    /<details>\s*\n?<summary>[^<\n]*?(?:会议工作台|Meeting workbench)[^<\n]*?<\/summary>[\s\S]*?<\/details>/gi,
  ];
  for (let iter = 0; iter < 32; iter++) {
    let changed = false;
    for (const re of detailsPatterns) {
      const before = s;
      s = s.replace(re, (match: string) => stash(match));
      if (s !== before) changed = true;
    }
    if (!changed) break;
  }

  s = s.replace(NS_SEGMENTS_BLOCK_RE, (match: string) => stash(match));
  s = s.replace(NS_SESSION_LINE_RE, (match: string) => stash(match.trim()));
  s = s.replace(NS_SEDIMENT_BLOCK_RE, (match: string) => stash(match));
  s = s.replace(/##\s+✨\s+(?:整合版|Merged version)[^\n]*\n+_\[(?:合并润色失败|AI 整理失败|Merge failed|AI organizing failed)[^\]]*\]_\s*\n?/g, "");
  s = s.replace(/<details>\s*<\/details>/gi, "");
  s = s.replace(/<details>\s*\n+\s*<\/details>/gi, "");

  return { tail: tailParts.join("\n\n"), withoutRaw: s };
}

export function extractSessionId(content: string, fallback: string): string {
  const match = String(content || "").match(NS_SESSION_VALUE_RE);
  return match ? match[1].trim() : fallback;
}
