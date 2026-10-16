import { parseTopicPageBlocks, type ParsedTopicBlock } from "./topic-page";

export interface TopicBlockPosition { line: number; ch: number }

/** Convert an editor line and column to a Markdown string offset, accounting for CRLF. */
export function topicPositionToOffset(markdown: string, position: TopicBlockPosition): number {
  const targetLine = Math.max(0, Math.trunc(position.line));
  const targetColumn = Math.max(0, Math.trunc(position.ch));
  let line = 0;
  let lineStart = 0;
  while (line < targetLine && lineStart < markdown.length) {
    const current = markdown.indexOf("\n", lineStart);
    if (current < 0) return markdown.length;
    lineStart = current + 1;
    line++;
  }
  let lineEnd = markdown.indexOf("\n", lineStart);
  if (lineEnd < 0) lineEnd = markdown.length;
  if (lineEnd > lineStart && markdown[lineEnd - 1] === "\r") lineEnd--;
  return Math.min(lineStart + targetColumn, lineEnd);
}

/** Resolve a cursor or editor selection to the topic content blocks it touches. */
export function resolveTopicBlocksForRange(
  markdown: string,
  from: TopicBlockPosition,
  to: TopicBlockPosition,
): ParsedTopicBlock[] {
  const start = topicPositionToOffset(markdown, from);
  const end = topicPositionToOffset(markdown, to);
  const blocks = parseTopicPageBlocks(markdown);
  if (start === end) return blocks.filter((block) => block.start <= start && start <= block.end);
  const rangeStart = Math.min(start, end);
  const rangeEnd = Math.max(start, end);
  return blocks.filter((block) => block.start < rangeEnd && block.end > rangeStart);
}
