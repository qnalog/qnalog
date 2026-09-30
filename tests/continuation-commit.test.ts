import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class TFile {
    path: string;
    extension: string;
    basename: string;
    name: string;
    constructor(path: string) {
      this.path = path;
      this.extension = path.split(".").pop() || "";
      this.basename = path.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
      this.name = path.split("/").pop() || "";
    }
  },
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
}));

import * as obsidian from "obsidian";
import { NoteWriter } from "../src/notes/note-writer";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import { readTranscriptBlocks } from "../src/transcript/transcript-markdown";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { RecordingSession, Segment } from "../src/shared/types";

function makeSegment(index: number, text: string): Segment {
  return attachTextTranscript({
    index,
    startOffsetMs: index * 1000,
    endOffsetMs: (index + 1) * 1000,
    text,
  }, "continuation-a", "text-import");
}

describe("staged continuation commit", () => {
  it("writes every segment from one session once and makes retry idempotent", async () => {
    const path = "QnALog/Minutes/target.md";
    let markdown = [
      "# Existing minutes",
      "",
      "<!-- qnalog-session:target-session -->",
      "<!-- qnalog-segments-start:target-session -->",
      "<!-- qnalog-segments-end:target-session -->",
      "",
    ].join("\n");
    let writes = 0;
    const target = new (obsidian.TFile as never)(path);
    const writer = new NoteWriter({
      settings: { ...DEFAULT_SETTINGS, consolidatedLayout: false, llmModel: "test-model" },
      app: {
        vault: {
          getAbstractFileByPath: (requestedPath: string) => requestedPath === path ? target : null,
          read: async () => markdown,
          modify: async (_file: unknown, next: string) => { markdown = next; writes++; },
        },
      },
    } as never);
    const session = {
      id: "continuation-a",
      sessionStamp: "20260921-100000",
      startedAt: "2026-09-21T10:00:00.000Z",
      mdPath: path,
      mode: "synthesis",
      source: "recording",
      segments: [makeSegment(0, "first added segment"), makeSegment(1, "second added segment")],
      finalized: false,
    } as RecordingSession;

    vi.stubGlobal("window", {
      moment: (value: string) => ({ format: () => value }),
    });
    try {
      await writer.commitContinuation(session, "Organized continuation body", []);
      const committedBlocks = readTranscriptBlocks(markdown);
      expect(committedBlocks.map(block => block.segment.transcript?.id)).toEqual([
        "seg:continuation-a:0",
        "seg:continuation-a:1",
      ]);
      expect(committedBlocks.map(block => block.visibleBlock)).toEqual(["first added segment", "second added segment"]);
      expect(markdown).toContain("Organized continuation body");
      expect(markdown.match(/<!-- qnalog-continuation-committed:continuation-a -->/g)).toHaveLength(1);
      const firstWriteCount = writes;

      await writer.commitContinuation(session, "Organized continuation body", []);
      expect(writes).toBe(firstWriteCount);
      expect(readTranscriptBlocks(markdown)).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
