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
import { readTranscriptBlocks, serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { RecordingSession, Segment } from "../src/shared/types";

function makeSegment(index: number, text: string, sourceId = "continuation-a"): Segment {
  return attachTextTranscript({
    index,
    startOffsetMs: index * 1000,
    endOffsetMs: (index + 1) * 1000,
    text,
  }, sourceId, "text-import");
}

function createMemoryWriter(initialMarkdown: string, consolidatedLayout: boolean) {
  const path = "QnALog/Minutes/target.md";
  let markdown = initialMarkdown;
  let writes = 0;
  const target = new (obsidian.TFile as never)(path);
  const writer = new NoteWriter({
    settings: { ...DEFAULT_SETTINGS, consolidatedLayout, llmModel: "test-model" },
    app: {
      vault: {
        getAbstractFileByPath: (requestedPath: string) => requestedPath === path ? target : null,
        read: async () => markdown,
        modify: async (_file: unknown, next: string) => { markdown = next; writes++; },
      },
    },
  } as never);
  return { writer, path, get markdown() { return markdown; }, get writes() { return writes; } };
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

  it("rejects a continuation target with no transcript insertion boundary without changing it", async () => {
    const initial = "# Existing minutes\n\nTarget body without transcript markers";
    const memory = createMemoryWriter(initial, false);
    const session = {
      id: "continuation-a",
      sessionStamp: "20260921-100000",
      startedAt: "2026-09-21T10:00:00.000Z",
      mdPath: memory.path,
      mode: "synthesis",
      source: "recording",
      segments: [makeSegment(0, "continued transcript")],
      finalized: false,
    } as RecordingSession;

    vi.stubGlobal("window", { moment: (value?: string) => ({ format: () => value || "2026-09-21 10:00" }) });
    try {
      await expect(memory.writer.commitContinuation(session, "Organized continuation body", [])).rejects.toThrow(
        "Continuation target has no transcript insertion marker",
      );
      expect(memory.markdown).toBe(initial);
      expect(memory.writes).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([true, false])("commits complete transcript ledgers without an outer marker (consolidated=%s)", async (consolidatedLayout) => {
    const oldSegment = makeSegment(0, "original transcript", "target-source");
    const freshSegment = makeSegment(1, "continued transcript");
    const oldBlock = serializeTranscriptBlock(oldSegment, "### Original segment", oldSegment.text);
    const initial = `# Existing minutes\n\n<details>\n${oldBlock}\n</details>\nINDEX-LOCK\nSEDIMENT-LOCK\n`;
    const memory = createMemoryWriter(initial, consolidatedLayout);
    const session = {
      id: "continuation-a",
      sessionStamp: "20260921-100000",
      startedAt: "2026-09-21T10:00:00.000Z",
      mdPath: memory.path,
      mode: "synthesis",
      source: "recording",
      segments: [oldSegment, freshSegment],
      continuation: { targetPath: memory.path, targetSourceId: "target-source" },
      finalized: false,
    } as RecordingSession;
    vi.stubGlobal("window", { moment: (value?: string) => ({ format: () => value || "2026-09-21 10:00" }) });
    try {
      await memory.writer.commitContinuation(session, "Organized continuation body", []);
      const blocks = readTranscriptBlocks(memory.markdown);
      expect(blocks.map((block) => block.segment.transcript?.sourceId)).toEqual(["target-source", "continuation-a"]);
      expect(blocks.map((block) => block.visibleBlock)).toEqual(["original transcript", "continued transcript"]);
      expect(memory.markdown.match(/<!-- qnalog-continuation-committed:continuation-a -->/g)).toHaveLength(1);
      expect(memory.markdown).toContain("Organized continuation body");
      if (!consolidatedLayout) {
        expect(memory.markdown.indexOf("continued transcript")).toBeLessThan(memory.markdown.indexOf("</details>"));
        expect(memory.markdown.indexOf("</details>")).toBeLessThan(memory.markdown.indexOf("INDEX-LOCK"));
        expect(memory.markdown.indexOf("INDEX-LOCK")).toBeLessThan(memory.markdown.indexOf("SEDIMENT-LOCK"));
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not mark a staged rewrite as a committed continuation", async () => {
    const original = serializeTranscriptBlock(makeSegment(0, "staged transcript"), "### Staged", "staged transcript");
    const memory = createMemoryWriter(`# Stage\n\n${original}\n`, true);
    const stagedSession = {
      id: "continuation-a",
      sessionStamp: "20260921-100000",
      startedAt: "2026-09-21T10:00:00.000Z",
      mdPath: memory.path,
      mode: "synthesis",
      source: "recording",
      segments: [makeSegment(0, "staged transcript")],
      continuation: { targetPath: "target.md", targetSourceId: "target-source" },
      finalized: false,
    } as RecordingSession;
    vi.stubGlobal("window", { moment: (value?: string) => ({ format: () => value || "2026-09-21 10:00" }) });
    try {
      await memory.writer.rewriteConsolidated(stagedSession, "");
      expect(memory.markdown).not.toContain("qnalog-continuation-committed:continuation-a");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("adds only missing incoming ledger blocks when a partial continuation is already present", async () => {
    const original = makeSegment(0, "original transcript", "target-source");
    const first = makeSegment(1, "already inserted");
    const missing = makeSegment(2, "missing block");
    const initial = `# Partial\n\n${serializeTranscriptBlock(original, "### Original", original.text)}\n${serializeTranscriptBlock(first, "### First", first.text)}\n</details>\n`;
    const memory = createMemoryWriter(initial, false);
    const session = {
      id: "continuation-a",
      sessionStamp: "20260921-100000",
      startedAt: "2026-09-21T10:00:00.000Z",
      mdPath: memory.path,
      mode: "synthesis",
      source: "recording",
      segments: [original, first, missing],
      finalized: false,
    } as RecordingSession;
    vi.stubGlobal("window", { moment: (value?: string) => ({ format: () => value || "2026-09-21 10:00" }) });
    try {
      await memory.writer.commitContinuation(session, "Organized continuation body", []);
      const ids = readTranscriptBlocks(memory.markdown).map((block) => block.segment.transcript?.id);
      expect(ids).toEqual(["seg:target-source:0", "seg:continuation-a:1", "seg:continuation-a:2"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects duplicate target ledger ids without changing the note", async () => {
    const incoming = makeSegment(1, "incoming transcript");
    const duplicateBlock = serializeTranscriptBlock(incoming, "### Incoming", incoming.text);
    const initial = `# Duplicate\n\n${duplicateBlock}\n${duplicateBlock}\n`;
    const memory = createMemoryWriter(initial, false);
    const session = {
      id: "continuation-a",
      sessionStamp: "20260921-100000",
      startedAt: "2026-09-21T10:00:00.000Z",
      mdPath: memory.path,
      mode: "synthesis",
      source: "recording",
      segments: [incoming],
      finalized: false,
    } as RecordingSession;
    vi.stubGlobal("window", { moment: (value?: string) => ({ format: () => value || "2026-09-21 10:00" }) });
    try {
      await expect(memory.writer.commitContinuation(session, "Organized continuation body", [])).rejects.toThrow(
        "Expected one transcript block for seg:continuation-a:1; found 2",
      );
      expect(memory.markdown).toBe(initial);
      expect(memory.writes).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
