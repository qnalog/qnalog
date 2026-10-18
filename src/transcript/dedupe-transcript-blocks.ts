import { labelPattern } from "../shared/note-labels";
import { nsRe } from "../shared/namespace";
import { findTranscriptDataElements, readTranscriptBlocks, type ReadTranscriptBlock } from "./transcript-markdown";

/**
 * Repairs notes in which one transcript id is written as more than one transcript block.
 *
 * - No duplicate ids: the markdown is returned unchanged.
 * - Duplicates whose visible text is the same, or whose other blocks are waiting or failure placeholders:
 *   one block is kept (the first block with real text, else the first block) and the others are removed
 *   together with their hidden data spans. Segment container markers inside removed blocks are kept.
 * - Duplicates with two different real texts: nothing is changed; the ids are reported as ambiguous.
 */
export type DuplicateTranscriptBlockResult =
  | { status: "unchanged"; markdown: string }
  | { status: "repaired"; markdown: string; repairs: Array<{ id: string; blocks: number; removed: number }> }
  | { status: "ambiguous"; markdown: string; ids: string[] };

const PLACEHOLDER_TEXT = new RegExp(`^(?:${[
  labelPattern("waitingBackground").source,
  labelPattern("notFullyTranscribed").source,
  labelPattern("noContentSegment").source,
].join("|")})$`);

const SEGMENT_CONTAINER_MARKER = new RegExp(`<!--\\s*(?:${nsRe("segments-start")}|${nsRe("segments-end")})(?::[^>]*)?\\s*-->`, "gi");

function isRealText(visibleText: string): boolean {
  const trimmed = visibleText.trim();
  return trimmed.length > 0 && !PLACEHOLDER_TEXT.test(trimmed);
}

interface RemovalRange {
  start: number;
  end: number;
  block: boolean;
}

export function dedupeTranscriptBlocks(markdown: string): DuplicateTranscriptBlockResult {
  const text = String(markdown || "");
  const blocks = readTranscriptBlocks(text);
  const byId = new Map<string, ReadTranscriptBlock[]>();
  for (const block of blocks) {
    const id = block.segment.transcript?.id || "";
    if (!id) continue;
    byId.set(id, [...(byId.get(id) || []), block]);
  }
  const duplicates = [...byId.entries()].filter(([, items]) => items.length > 1);
  if (!duplicates.length) return { status: "unchanged", markdown: text };

  const dataElements = findTranscriptDataElements(text);
  const ambiguous: string[] = [];
  const ranges: RemovalRange[] = [];
  const keptBlocks: ReadTranscriptBlock[] = [];
  const repairs: Array<{ id: string; blocks: number; removed: number }> = [];
  for (const [id, items] of duplicates) {
    const realTexts = new Set(items.map((block) => block.visibleBlock.trim()).filter(isRealText));
    const spans = dataElements.filter((element) => element.id === id);
    // Hidden payloads are matched to blocks by position (k-th block <-> k-th span), as readTranscriptBlocks does.
    if (realTexts.size > 1 || (spans.length > 0 && spans.length !== items.length)) {
      ambiguous.push(id);
      continue;
    }
    const keep = items.find((block) => isRealText(block.visibleBlock)) || items[0];
    keptBlocks.push(keep);
    items.forEach((block, index) => {
      if (block === keep) return;
      ranges.push({ start: block.start, end: block.end, block: true });
      if (spans[index]) ranges.push({ start: spans[index].start, end: spans[index].end, block: false });
    });
    repairs.push({ id, blocks: items.length, removed: items.length - 1 });
  }
  if (ambiguous.length) return { status: "ambiguous", markdown: text, ids: ambiguous };

  // A removed block must not contain any other transcript block.
  const removedBlocks = ranges.filter((range) => range.block);
  for (const range of removedBlocks) {
    if (blocks.some((block) => block.start > range.start && block.start < range.end)) {
      return { status: "ambiguous", markdown: text, ids: duplicates.map(([id]) => id) };
    }
  }

  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const keptText = removeRanges(text, sorted);
  const preserved: string[] = [];
  for (const range of removedBlocks) {
    for (const [marker] of text.slice(range.start, range.end).matchAll(SEGMENT_CONTAINER_MARKER)) {
      if (!keptText.includes(marker) && !preserved.includes(marker)) preserved.push(marker);
    }
  }
  let output = "";
  let cursor = 0;
  let inserted = false;
  for (const range of sorted) {
    output += text.slice(cursor, range.start);
    if (range.block && !inserted && preserved.length) {
      output += preserved.map((marker) => `${marker}\n`).join("");
      inserted = true;
    }
    cursor = range.end;
  }
  output += text.slice(cursor);

  // Verify before returning: every id must now have exactly one block with the kept text.
  let verified = false;
  try {
    const after = readTranscriptBlocks(output);
    verified = duplicates.every(([id]) => after.filter((block) => block.segment.transcript?.id === id).length === 1)
      && keptBlocks.every((keep) => after.some((block) => block.segment.transcript?.id === keep.segment.transcript?.id && block.visibleBlock === keep.visibleBlock));
  } catch {
    verified = false;
  }
  if (!verified) return { status: "ambiguous", markdown: text, ids: duplicates.map(([id]) => id) };
  return { status: "repaired", markdown: output, repairs };
}

function removeRanges(text: string, ranges: RemovalRange[]): string {
  let output = "";
  let cursor = 0;
  for (const range of ranges) {
    output += text.slice(cursor, range.start);
    cursor = range.end;
  }
  return output + text.slice(cursor);
}
