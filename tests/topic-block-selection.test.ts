import { describe, expect, it } from "vitest";
import { resolveTopicBlocksForRange, topicPositionToOffset, type TopicBlockPosition } from "../src/topics/topic-block-selection";

function linePosition(markdown: string, lineText: string, ch: number): TopicBlockPosition {
  const line = markdown.split(/\r\n|\r|\n/).findIndex((item) => item === lineText);
  if (line < 0) throw new Error(`Line not found: ${lineText}`);
  return { line, ch };
}

describe("resolveTopicBlocksForRange", () => {
  it("selects all content blocks across headings while leaving headings out", () => {
    const markdown = "# Topic\n- First point\n## Section\n- Second point\n";
    const blocks = resolveTopicBlocksForRange(markdown, { line: 0, ch: 0 }, { line: 3, ch: 14 });
    expect(blocks.map(({ text, type }) => [type, text])).toEqual([
      ["point", "- First point"],
      ["point", "- Second point"],
    ]);
  });

  it("returns no block for a heading-only selection, heading cursor, or blank-line cursor", () => {
    const markdown = "# Topic\n\n- A point\n";
    expect(resolveTopicBlocksForRange(markdown, { line: 0, ch: 0 }, { line: 0, ch: 7 })).toEqual([]);
    expect(resolveTopicBlocksForRange(markdown, { line: 0, ch: 2 }, { line: 0, ch: 2 })).toEqual([]);
    expect(resolveTopicBlocksForRange(markdown, { line: 1, ch: 0 }, { line: 1, ch: 0 })).toEqual([]);
    expect(resolveTopicBlocksForRange(markdown, { line: 2, ch: 4 }, { line: 2, ch: 4 }).map((block) => block.text)).toEqual(["- A point"]);
  });

  it("does not include a block when a selection touches only its trailing newline", () => {
    const markdown = "- A point\n# Heading\n";
    expect(resolveTopicBlocksForRange(markdown, { line: 0, ch: 9 }, { line: 1, ch: 0 })).toEqual([]);
  });

  it("resolves abstract, point, open, disagreement, and thread-summary blocks in document order", () => {
    const markdown = [
      "# Topic",
      "> [!abstract]",
      "> Overview claim.",
      "## Progress thread",
      "### Thread",
      "Thread summary.",
      "- Point claim [^point]",
      "- [ ] Open claim [^open]",
      "## Disagreements and verification",
      "> [!warning]",
      "> - Disagreement claim [^disagreement]",
      "[^point]: [[Notes/Point]]",
      "[^open]: [[Notes/Open]]",
      "[^disagreement]: [[Notes/Disagreement]]",
    ].join("\n");
    const blocks = resolveTopicBlocksForRange(markdown, { line: 0, ch: 0 }, { line: 10, ch: 38 });
    expect(blocks.map(({ type }) => type)).toEqual(["overview", "thread-summary", "point", "open", "disagreement"]);
  });

  it("uses real CRLF lengths when converting editor positions", () => {
    const markdown = "# Topic\r\n- First\r\n\r\n- Second\r\n";
    expect(topicPositionToOffset(markdown, { line: 1, ch: 2 })).toBe(markdown.indexOf("- First") + 2);
    expect(topicPositionToOffset(markdown, { line: 3, ch: 2 })).toBe(markdown.indexOf("- Second") + 2);
    const blocks = resolveTopicBlocksForRange(markdown, linePosition(markdown, "# Topic", 0), linePosition(markdown, "- Second", 8));
    expect(blocks.map(({ text }) => text.trimEnd())).toEqual(["- First", "- Second"]);
  });
});
