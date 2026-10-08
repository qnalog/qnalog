import { getTranscribeSegmentPlaceholder } from "../src/shared/util-audio";
import { nsMarker } from "../src/shared/namespace";
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
import type { NoteWriterHost } from "../src/notes/note-writer";
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
  let targetExists = true;
  let rejectModify = false;
  const target = new (obsidian.TFile as never)(path);
  let vault = {
    getAbstractFileByPath: (requestedPath: string) => requestedPath === path && targetExists ? target : null,
    read: async () => markdown,
    modify: async (_file: unknown, next: string) => {
      if (rejectModify) throw new Error("write rejected");
      markdown = next;
      writes++;
    },
  };
  const settings = { ...DEFAULT_SETTINGS, consolidatedLayout, llmModel: "test-model" };
  const writer = new NoteWriter({
    get vault() { return vault; },
    settings,
    noteIndex: { refreshNoteIndexSafely: async () => undefined },
    getFileFrontmatter: () => undefined,
    ensureFolder: async () => { throw new Error("unexpected folder creation"); },
    findAvailableMarkdownPath: () => { throw new Error("unexpected path allocation"); },
    renameFile: async () => { throw new Error("unexpected rename"); },
    openFile: async () => { throw new Error("unexpected file open"); },
    confirm: async () => { throw new Error("unexpected confirmation"); },
    getRecentNotes: () => { throw new Error("unexpected recent-note lookup"); },
    generateTitleTag: async () => { throw new Error("unexpected title generation"); },
    polishTranscript: async () => { throw new Error("unexpected transcript polish"); },
    mergeAndPolish: async () => { throw new Error("unexpected note merge"); },
    clearCommittedBriefingCheckpoint: async () => { throw new Error("unexpected checkpoint cleanup"); },
  } as NoteWriterHost);
  return {
    writer,
    path,
    settings,
    setTargetExists(value: boolean) { targetExists = value; },
    setRejectModify(value: boolean) { rejectModify = value; },
    replaceVault(value: typeof vault) { vault = value; },
    get markdown() { return markdown; },
    get writes() { return writes; },
  };
}
function makeSession(path: string, segments: Segment[]): RecordingSession {
  return {
    id: "continuation-a",
    sessionStamp: "20260921-100000",
    startedAt: "2026-09-21T10:00:00.000Z",
    mdPath: path,
    mode: "synthesis",
    source: "recording",
    segments,
    finalized: false,
  } as RecordingSession;
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
    const markdownHost = {
      getAbstractFileByPath: (requestedPath: string) => requestedPath === path ? target : null,
      read: async () => markdown,
      modify: async (_file: unknown, next: string) => { markdown = next; writes++; },
    };
    const writer = new NoteWriter({
      vault: markdownHost,
      settings: { ...DEFAULT_SETTINGS, consolidatedLayout: false, llmModel: "test-model" },
      noteIndex: { refreshNoteIndexSafely: async () => undefined },
      getFileFrontmatter: () => undefined,
      ensureFolder: async () => { throw new Error("unexpected folder creation"); },
      findAvailableMarkdownPath: () => { throw new Error("unexpected path allocation"); },
      renameFile: async () => { throw new Error("unexpected rename"); },
      openFile: async () => { throw new Error("unexpected file open"); },
      confirm: async () => { throw new Error("unexpected confirmation"); },
      getRecentNotes: () => { throw new Error("unexpected recent-note lookup"); },
      generateTitleTag: async () => { throw new Error("unexpected title generation"); },
      polishTranscript: async () => { throw new Error("unexpected transcript polish"); },
      mergeAndPolish: async () => { throw new Error("unexpected note merge"); },
      clearCommittedBriefingCheckpoint: async () => { throw new Error("unexpected checkpoint cleanup"); },
    } as NoteWriterHost);
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

  it("inserts continuation error materials without a task marker and retries idempotently", async () => {
    const targetSessionId = "target-session";
    const initial = [
      "# Existing minutes",
      "",
      nsMarker("session", targetSessionId),
      nsMarker("segments-start", targetSessionId),
      nsMarker("segments-end", targetSessionId),
      "",
    ].join("\n");
    const memory = createMemoryWriter(initial, false);
    const segment = attachTextTranscript({
      index: 2,
      startOffsetMs: 5_000,
      endOffsetMs: 6_000,
      audioStartOffsetMs: 0,
      audioEndOffsetMs: 1_000,
      audioName: "retry.webm",
      queueTaskId: "raw-retry",
      error: "temporary failure",
      text: "不得显示的错误旧文本",
    }, "continuation-a", "text-import");
    const session = makeSession(memory.path, [segment]);
    vi.stubGlobal("window", { moment: (value: string) => ({ format: () => value }) });
    try {
      await memory.writer.commitContinuation(session, "Organized continuation body", []);
      const committed = memory.markdown;
      const blocks = readTranscriptBlocks(committed);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].visibleBlock).toBe(getTranscribeSegmentPlaceholder(segment.error, { retryable: true }));
      expect(blocks[0].segment.transcript?.sourceId).toBe("continuation-a");
      expect(committed).toContain("### Segment 3 (00:05–00:06) [[retry.webm|00:00]]");
      expect(committed).not.toContain(nsMarker("transcribe-task", "raw-retry"));
      const writes = memory.writes;
      await memory.writer.commitContinuation(session, "Organized continuation body", []);
      expect(memory.writes).toBe(writes);
      expect(memory.markdown).toBe(committed);
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
  it("rejects a missing target without creating a note", async () => {
    const memory = createMemoryWriter("# Original\n", false);
    memory.setTargetExists(false);
    const initial = memory.markdown;
    await expect(memory.writer.commitContinuation(makeSession(memory.path, [makeSegment(0, "incoming")]), "Polished", []))
      .rejects.toThrow("Continuation target note is missing");
    expect(memory.markdown).toBe(initial);
    expect(memory.writes).toBe(0);
  });

  it("rejects duplicate incoming ids before accepting an existing commit marker", async () => {
    const incoming = makeSegment(0, "incoming");
    const initial = `# Existing\n\n${serializeTranscriptBlock(incoming, "### Incoming", incoming.text)}\n<!-- qnalog-continuation-committed:continuation-a -->\n`;
    const memory = createMemoryWriter(initial, false);
    await expect(memory.writer.commitContinuation(makeSession(memory.path, [incoming, incoming]), "Polished", []))
      .rejects.toThrow("Continuation contains duplicate transcript block seg:continuation-a:0");
    expect(memory.markdown).toBe(initial);
    expect(memory.writes).toBe(0);
  });

  it("rejects an edited visible transcript block without modifying the note", async () => {
    const incoming = makeSegment(0, "incoming transcript");
    const serialized = serializeTranscriptBlock(incoming, "### Incoming", incoming.text);
    const initial = serialized.replace("incoming transcript", "edited transcript");
    const memory = createMemoryWriter(initial, false);
    await expect(memory.writer.commitContinuation(makeSession(memory.path, [incoming]), "Polished", []))
      .rejects.toThrow("Transcript block drifted for seg:continuation-a:0");
    expect(memory.markdown).toBe(initial);
    expect(memory.writes).toBe(0);
  });

  it("requires a missing ledger block for a previously marked continuation and preserves predecessor validation order", async () => {
    const incoming = makeSegment(0, "incoming");
    const absentLedger = `# Existing\n\n<!-- qnalog-continuation-committed:continuation-a -->\n`;
    const memory = createMemoryWriter(absentLedger, false);
    await expect(memory.writer.commitContinuation(makeSession(memory.path, [incoming]), "Polished", []))
      .rejects.toThrow("Committed continuation is missing transcript block seg:continuation-a:0");
    expect(memory.markdown).toBe(absentLedger);
    expect(memory.writes).toBe(0);

    const ledger = serializeTranscriptBlock(incoming, "### Incoming", incoming.text);
    const marked = `${ledger}\n<!-- qnalog-continuation-committed:continuation-a -->\n`;
    const alreadyCommitted = createMemoryWriter(marked, false);
    await alreadyCommitted.writer.commitContinuation(makeSession(alreadyCommitted.path, [incoming]), "Polished", ["missing-predecessor"]);
    expect(alreadyCommitted.markdown).toBe(marked);
    expect(alreadyCommitted.writes).toBe(0);

    const unmarked = createMemoryWriter(ledger, false);
    await expect(unmarked.writer.commitContinuation(makeSession(unmarked.path, [incoming]), "Polished", ["missing-predecessor"]))
      .rejects.toThrow("Previously committed continuation marker is missing for missing-predecessor");
    expect(unmarked.markdown).toBe(ledger);
    expect(unmarked.writes).toBe(0);
  });

  it("rejects damaged transcript metadata and preserves the source note", async () => {
    const initial = "<!-- qnalog-transcript-start:continuation-a:0 -->\n<!-- qnalog-transcript-data {bad} -->\n";
    const memory = createMemoryWriter(initial, false);
    await expect(memory.writer.commitContinuation(makeSession(memory.path, [makeSegment(0, "incoming")]), "Polished", []))
      .rejects.toThrow("Transcript block continuation-a:0 has no matching end marker");
    expect(memory.markdown).toBe(initial);
    expect(memory.writes).toBe(0);
  });

  it("retains transcript and marker state after a rejected write, then retries idempotently", async () => {
    const initial = "<!-- qnalog-segments-start:target -->\n<!-- qnalog-segments-end:target -->\nOriginal prose\n";
    const incoming = makeSegment(0, "continued transcript");
    const memory = createMemoryWriter(initial, false);
    const session = makeSession(memory.path, [incoming]);
    vi.stubGlobal("window", { moment: (value?: string) => ({ format: () => value || "2026-09-21 10:00" }) });
    try {
      memory.setRejectModify(true);
      await expect(memory.writer.commitContinuation(session, "Organized continuation body", [])).rejects.toThrow("write rejected");
      expect(memory.markdown).toBe(initial);
      expect(memory.markdown).not.toContain("qnalog-continuation-committed:continuation-a");
      expect(memory.writes).toBe(0);
      memory.setRejectModify(false);
      await memory.writer.commitContinuation(session, "Organized continuation body", []);
      const committed = memory.markdown;
      expect(readTranscriptBlocks(committed).map((block) => block.visibleBlock)).toEqual(["continued transcript"]);
      expect(committed.match(/<!-- qnalog-continuation-committed:continuation-a -->/g)).toHaveLength(1);
      await memory.writer.commitContinuation(session, "Organized continuation body", []);
      expect(memory.markdown).toBe(committed);
      expect(memory.writes).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("appends a completed ledger without requiring an insertion boundary", async () => {
    const incoming = makeSegment(0, "already inserted");
    const initial = `${serializeTranscriptBlock(incoming, "### Incoming", incoming.text)}\nOriginal prose\n`;
    const memory = createMemoryWriter(initial, false);
    vi.stubGlobal("window", { moment: (value?: string) => ({ format: () => value || "2026-09-21 10:00" }) });
    try {
      await memory.writer.commitContinuation(makeSession(memory.path, [incoming]), "Organized continuation body", []);
      expect(readTranscriptBlocks(memory.markdown)).toHaveLength(1);
      expect(memory.markdown.match(/<!-- qnalog-continuation-committed:continuation-a -->/g)).toHaveLength(1);
      expect(memory.markdown).toContain("Organized continuation body");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each(["sourceId", "revision", "normalizationRevision"])("rejects a transcript ledger with changed %s metadata", async (field) => {
    const incoming = makeSegment(0, "incoming transcript");
    const existing = makeSegment(0, "incoming transcript");
    if (field === "sourceId") existing.transcript!.sourceId = "different-source";
    else if (field === "revision") {
      existing.transcript!.currentRevision = 2;
      existing.transcript!.revisions[0].revision = 2;
    } else existing.transcript!.revisions[0].normalizationRevision += 1;
    const initial = serializeTranscriptBlock(existing, "### Incoming", existing.text);
    const memory = createMemoryWriter(initial, false);
    await expect(memory.writer.commitContinuation(makeSession(memory.path, [incoming]), "Polished", []))
      .rejects.toThrow("Transcript block drifted for seg:continuation-a:0");
    expect(memory.markdown).toBe(initial);
    expect(memory.writes).toBe(0);
  });

  it("uses current layout settings and vault when the continuation is committed", async () => {
    const incoming = makeSegment(0, "continued transcript");
    const memory = createMemoryWriter(
      "<!-- qnalog-segments-start:old -->\n<!-- qnalog-segments-end:old -->\nOld vault prose\n",
      false,
    );
    const oldMarkdown = memory.markdown;
    const newPath = memory.path;
    let newMarkdown = "<!-- qnalog-segments-start:new -->\n<!-- qnalog-segments-end:new -->\nNew vault prose\n";
    let newWrites = 0;
    const newTarget = new (obsidian.TFile as never)(newPath);
    memory.replaceVault({
      getAbstractFileByPath: (requestedPath: string) => requestedPath === newPath ? newTarget : null,
      read: async () => newMarkdown,
      modify: async (_file: unknown, next: string) => { newMarkdown = next; newWrites++; },
    });
    memory.settings.consolidatedLayout = true;
    vi.stubGlobal("window", { moment: (value?: string) => ({ format: () => value || "2026-09-21 10:00" }) });
    try {
      await memory.writer.commitContinuation(makeSession(memory.path, [incoming]), "Organized continuation body", []);
      expect(memory.markdown).toBe(oldMarkdown);
      expect(newWrites).toBe(1);
      expect(newMarkdown).toContain("Organized continuation body");
      expect(newMarkdown).toContain("qnalog-continuation-committed:continuation-a");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
