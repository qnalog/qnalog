import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class TFile {
    path: string;
    name: string;
    basename: string;
    extension: string;
    constructor(path: string) {
      this.path = path;
      this.name = path.split("/").pop() || path;
      this.basename = this.name.replace(/\.[^.]+$/, "");
      this.extension = this.name.split(".").pop() || "";
    }
  }
  class TFolder { path: string; constructor(path: string) { this.path = path; } }
  return {
    TFile,
    TFolder,
    normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "").replace(/\/$/, ""),
  };
});

import * as obsidian from "obsidian";
import { NoteWriter } from "../src/notes/note-writer";
import type { NoteWriterHost } from "../src/notes/note-writer";
import { RealtimeOutlineService } from "../src/notes/realtime-outline-service";
import { readCurrentOutlineBlock } from "../src/notes/outline-storage";
import { createRealtimeOutlineSourceCoverage } from "../src/notes/outline-coverage";
import { readTranscriptBlocks, serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { RecordingSession, Segment } from "../src/shared/types";
import { ContinuationService } from "../src/session/continuation-service";

type MemoryFile = InstanceType<typeof obsidian.TFile>;

function createTranscriptSegment(index: number): Segment {
  const text = index === 0
    ? "The first source transcript stays untouched."
    : "The later source transcript stays untouched too.";
  return attachTextTranscript({
    index,
    startOffsetMs: index * 1_000,
    endOffsetMs: (index + 1) * 1_000,
    audioStartOffsetMs: index * 1_000,
    audioEndOffsetMs: (index + 1) * 1_000,
    audioName: "recording.webm",
    audioPath: "recording.webm",
    text,
  }, "transcript-source", "text-import");
}

function createOriginalNote(includeCurrentOutline = true): string {
  const segments = [createTranscriptSegment(0), createTranscriptSegment(1)];
  const sections = [
    "---\nqnalog_mode: meeting\n---",
    "# Organized note",
    "Body bytes stay exactly the same.",
    "<details>\n<summary>Recording info</summary>\n\n- Segments: 2\n</details>",
    ...(includeCurrentOutline ? [
      "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- Archived outline\n</details>",
      "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- Old current topic\n</details>",
    ] : []),
    "<details>\n<summary>Segmented raw transcript (2 segments)</summary>\n\n<!-- qnalog-session:transcript-source -->",
    ...segments.map((segment) => serializeTranscriptBlock(segment, `### Segment ${segment.index + 1}`, segment.text)),
    "</details>",
    "<!-- qnalog-session:transcript-source -->",
  ];
  return sections.join("\n\n");
}


function createMemoryVault(initialMarkdown: string, configDir = ".obsidian") {
  const files = new Map<string, { file: MemoryFile; markdown: string }>();
  const folders = new Map<string, InstanceType<typeof obsidian.TFolder>>();
  const adapterFiles = new Map<string, string>();
  const target = new obsidian.TFile("Notes/source.md");
  files.set(target.path, { file: target, markdown: initialMarkdown });
  let beforeProcess: (() => void) | null = null;
  let failBackupWrite = false;
  let processCount = 0;

  const vault = {
    get configDir() { return configDir; },
    adapter: {
      async exists(path: string) {
        return files.has(path) || folders.has(path) || adapterFiles.has(path);
      },
      async mkdir(path: string) {
        if (!folders.has(path)) folders.set(path, new obsidian.TFolder(path));
      },
      async write(path: string, markdown: string) {
        if (path.includes("qnalog-outline-backups") && failBackupWrite) throw new Error("Backup storage unavailable");
        adapterFiles.set(path, markdown);
      },
      async read(path: string) {
        const content = adapterFiles.get(path);
        if (content === undefined) throw new Error(`Missing adapter file ${path}`);
        return content;
      },
    },
    getAbstractFileByPath(path: string) {
      return files.get(path)?.file || folders.get(path) || null;
    },
    async read(file: MemoryFile) {
      const entry = files.get(file.path);
      if (!entry) throw new Error(`Missing file ${file.path}`);
      return entry.markdown;
    },
    async createFolder(path: string) {
      if (folders.has(path) || files.has(path)) throw new Error(`Path already exists: ${path}`);
      const folder = new obsidian.TFolder(path);
      folders.set(path, folder);
      return folder;
    },
    async create(path: string, markdown: string) {
      if (path.includes("qnalog-outline-backups") && failBackupWrite) throw new Error("Backup storage unavailable");
      if (files.has(path) || folders.has(path)) throw new Error(`Path already exists: ${path}`);
      const file = new obsidian.TFile(path);
      files.set(path, { file, markdown });
      return file;
    },
    async process(file: MemoryFile, transform: (markdown: string) => string) {
      processCount += 1;
      const pendingChange = beforeProcess;
      beforeProcess = null;
      pendingChange?.();
      const current = await vault.read(file);
      const next = transform(current);
      if (next !== current) files.get(file.path)!.markdown = next;
      return next;
    },
  };

  return {
    target,
    vault,
    get markdown() { return files.get(target.path)!.markdown; },
    get processCount() { return processCount; },
    readPath(path: string) { return files.get(path)?.markdown ?? adapterFiles.get(path); },
    writeTarget(markdown: string) { files.get(target.path)!.markdown = markdown; },
    changeBeforeProcess(change: () => void) { beforeProcess = change; },
    failBackupWrites() { failBackupWrite = true; },
    get backupPaths() { return [...adapterFiles.keys()]; },
    get folderPaths() { return [...folders.keys()]; },
  };
}

function makeWriterAndService(initialMarkdown: string, generation: "success" | "incomplete" | "failure" | "cancel" = "success", busy = false, configDir = ".obsidian") {
  const memory = createMemoryVault(initialMarkdown, configDir);
  let writerVault: NoteWriterHost["vault"] = memory.vault as never;
  const writerHost: NoteWriterHost = {
    get vault() { return writerVault; },
    settings: { ...DEFAULT_SETTINGS, enableRealtimeOutline: false, polishMode: "meeting" },
    noteIndex: { refreshNoteIndexSafely: async () => undefined },
    getFileFrontmatter: () => ({ qnalog_mode: "meeting" }),
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
  };
  const writer = new NoteWriter(writerHost);
  const service = new RealtimeOutlineService({
    diagnostics: {} as never,
    outlineCoordinator: null,
    requestOutlineRefresh: vi.fn(),
    sessionStore: {} as never,
    asrPipeline: {} as never,
    noteWriter: writer,
    continuations: {
      runOnTarget: (_target: MemoryFile, operation: () => Promise<unknown>) => operation(),
      isTargetBusy: () => busy,
    } as never,
    settings: { ...DEFAULT_SETTINGS, enableRealtimeOutline: false, polishMode: "meeting" },
  });
  service.generateRealtimeOutlineForSession = async (session: RecordingSession) => {
    if (generation === "failure") throw new Error("fixture model failure");
    if (generation === "cancel") {
      const error = new Error("LLM request cancelled");
      error.name = "AbortError";
      throw error;
    }
    if (generation === "incomplete") return;
    const outline = "- [[recording.webm|00:00]] Rebuilt topic";
    session.realtimeOutline = outline;
    session.realtimeOutlineSegmentCount = session.segments.length;
    session.realtimeOutlineSourceCoverage = createRealtimeOutlineSourceCoverage(outline, session.segments, session.segments.length);
  };
  return { memory, writer, service, setWriterVault: (vault: NoteWriterHost["vault"]) => { writerVault = vault; } };
}

describe("manual note outline rebuild", () => {
  it("backs up the exact original and changes only the last current outline block", async () => {
    const original = createOriginalNote();
    const currentBlock = readCurrentOutlineBlock(original);
    expect(currentBlock).not.toBeNull();
    const { memory, service } = makeWriterAndService(original);

    const result = await service.rebuildNoteOutline(memory.target);

    expect(result.errorMessage).toBeUndefined();
    expect(result).toMatchObject({
      status: "completed",
      coveredSegmentCount: 2,
      totalSegmentCount: 2,
      stopReason: null,
    });

    expect(result.backupPath).toMatch(/^\.obsidian\/qnalog-outline-backups\/[^/]+\/source\.md$/);
    expect(memory.readPath(result.backupPath!)).toBe(original);

    const updated = memory.markdown;
    const updatedBlock = readCurrentOutlineBlock(updated);
    expect(updatedBlock).not.toBeNull();
    expect(updated.slice(0, updatedBlock!.range.start)).toBe(original.slice(0, currentBlock!.range.start));
    expect(updated.slice(updatedBlock!.range.end)).toBe(original.slice(currentBlock!.range.end));
    expect(updatedBlock!.outline).toContain("Rebuilt topic");
    expect(updated).toContain("- Archived outline");
    expect(updated).toContain("The first source transcript stays untouched.");
    expect(updated).toContain("The later source transcript stays untouched too.");
  });

  it.each([
    ["incomplete", "no-progress"],
    ["failure", "model-failed"],
    ["cancel", "cancelled"],
  ] as const)("leaves the note unchanged after %s outline generation", async (generation, stopReason) => {
    const original = createOriginalNote();
    const { memory, service } = makeWriterAndService(original, generation);

    const result = await service.rebuildNoteOutline(memory.target);

    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe(stopReason);
    expect(memory.markdown).toBe(original);
    expect(memory.processCount).toBe(0);
    expect(result.backupPath).toBeNull();
  });

  it("rejects an active target before reading or rewriting the note", async () => {
    const original = createOriginalNote();
    const { memory, service } = makeWriterAndService(original, "success", true);

    const result = await service.rebuildNoteOutline(memory.target);

    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe("busy");
    expect(result.backupPath).toBeNull();
    expect(memory.markdown).toBe(original);
    expect(memory.processCount).toBe(0);
  });

  it("keeps a concurrent edit when the atomic write detects a stale snapshot", async () => {
    const original = createOriginalNote();
    const concurrentEdit = `${original}\n\nConcurrent user edit.`;
    const { memory, service } = makeWriterAndService(original);
    memory.changeBeforeProcess(() => memory.writeTarget(concurrentEdit));

    const result = await service.rebuildNoteOutline(memory.target);

    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe("stale");
    expect(memory.markdown).toBe(concurrentEdit);
    expect(result.backupPath).toBeTruthy();
    expect(memory.readPath(result.backupPath!)).toBe(original);
  });

  it("does not edit the target if exact-source backup creation fails", async () => {
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    const generatedDetails = [
      "<details>",
      "<summary>Live outline while recording (draft)</summary>",
      "",
      "- [[recording.webm|00:00]] Replacement",
      "",
      "</details>",
    ].join("\n");
    memory.failBackupWrites();

    const result = await writer.replaceRealtimeOutline(memory.target, original, generatedDetails);

    expect(result.status).toBe("backup-failed");
    expect(memory.markdown).toBe(original);
    expect(memory.processCount).toBe(0);
  });

  it("inserts a missing outline after recording information", async () => {
    const original = createOriginalNote(false);
    const { memory, writer } = makeWriterAndService(original);
    const generatedDetails = [
      "<details>",
      "<summary>Live outline while recording (draft)</summary>",
      "",
      "- [[recording.webm|00:00]] Inserted topic",
      "",
      "</details>",
    ].join("\n");

    const result = await writer.replaceRealtimeOutline(memory.target, original, generatedDetails);

    expect(result.status).toBe("written");
    const infoEnd = memory.markdown.indexOf("</details>", memory.markdown.indexOf("<summary>Recording info</summary>")) + "</details>".length;
    const insertedAt = memory.markdown.indexOf(generatedDetails);
    expect(insertedAt).toBeGreaterThan(infoEnd);
    expect(insertedAt).toBeLessThan(memory.markdown.indexOf("Segmented raw transcript"));
  });

  it("appends a legal top-level outline when no recording-info block exists", async () => {
    const recordingInfo = "<details>\n<summary>Recording info</summary>\n\n- Segments: 2\n</details>\n\n";
    const original = createOriginalNote(false).replace(recordingInfo, "");
    const { memory, writer } = makeWriterAndService(original);
    const generatedDetails = [
      "<details>",
      "<summary>Live outline while recording (draft)</summary>",
      "",
      "- [[recording.webm|00:00]] Appended topic",
      "",
      "</details>",
    ].join("\n");

    const result = await writer.replaceRealtimeOutline(memory.target, original, generatedDetails);

    expect(result.status).toBe("written");
    expect(memory.markdown.slice(0, original.length)).toBe(original);
    expect(memory.markdown.endsWith(`\n\n${generatedDetails}`)).toBe(true);
  });

  it("treats active recordings and queued continuations on the target as busy", () => {
    const target = new obsidian.TFile("Notes/source.md");
    const tasks: unknown[] = [];
    const continuations = new ContinuationService({
      vault: {} as never,
      fileManager: {} as never,
      getSettings: () => ({ mdFolder: "Notes", noteFileNameFormatNew: "YYYY-MM-DD", consolidatedLayout: false, polishMode: "meeting" }),
      detectModeFromMarkdown: () => "meeting",
      queueTasks: () => tasks as never,
      queueRecoveryEntries: () => [],
      addTask: async () => { throw new Error("unexpected queue write"); },
      removeTask: async () => undefined,
      scheduleTaskQueueRetry: () => undefined,
    });

    expect(continuations.isTargetBusy(target)).toBe(false);
    continuations.trackSession({ id: "active-recording" } as RecordingSession, target);
    expect(continuations.isTargetBusy(target)).toBe(true);
    continuations.releaseSession("active-recording");
    expect(continuations.isTargetBusy(target)).toBe(false);

    tasks.push({ type: "merge", continuation: { targetPath: "Notes/other.md" } });
    expect(continuations.isTargetBusy(target)).toBe(false);
    tasks.push({ type: "merge", continuation: { targetPath: target.path } });
    expect(continuations.isTargetBusy(target)).toBe(true);
  });
  it("uses the current vault and config directory for replacement backups", async () => {
    const original = createOriginalNote();
    const { memory, service, setWriterVault } = makeWriterAndService(original);
    const replacementStorage = createMemoryVault(original, ".alternate-config");
    setWriterVault(replacementStorage.vault as never);

    const result = await service.rebuildNoteOutline(memory.target);

    expect(result.status).toBe("completed");
    expect(result.backupPath).toMatch(/^\.alternate-config\/qnalog-outline-backups\/[^/]+\/source\.md$/);
    expect(replacementStorage.readPath(result.backupPath!)).toBe(original);
    expect(memory.markdown).toBe(original);
    expect(replacementStorage.readPath(memory.target.path)).toContain("Rebuilt topic");
  });
  it("replaces an empty last outline block without changing archived bytes", async () => {
    const archived = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- Archived bytes\n</details>";
    const empty = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n</details>";
    const original = `Unicode 保留。\n\n${createOriginalNote().replace(/<details>\n<summary>Live outline while recording \(draft\)<\/summary>\n\n- Old current topic\n<\/details>/, archived)}\n\n${empty}`;
    const last = readCurrentOutlineBlock(original)!;
    const { memory, writer } = makeWriterAndService(original);
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New topic\n</details>";

    const result = await writer.replaceRealtimeOutline(memory.target, original, generated);

    expect(result.status).toBe("written");
    expect(memory.markdown).toBe(`${original.slice(0, last.range.start)}${generated}${original.slice(last.range.end)}`);
    expect(memory.readPath(result.backupPath!)).toBe(original);
    const originalTranscript = readTranscriptBlocks(original);
    const updatedTranscript = readTranscriptBlocks(memory.markdown);
    expect(updatedTranscript.map((block) => block.segment.transcript?.sourceId))
      .toEqual(originalTranscript.map((block) => block.segment.transcript?.sourceId));
    expect(updatedTranscript.map((block) => block.visibleBlock))
      .toEqual(originalTranscript.map((block) => block.visibleBlock));
  });

  it("does not back up or process a stale expected snapshot", async () => {
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    memory.writeTarget(`${original}\n\nConcurrent change.`);
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New topic\n</details>";

    const result = await writer.replaceRealtimeOutline(memory.target, original, generated);

    expect(result).toEqual({ status: "stale", backupPath: null });
    expect(memory.processCount).toBe(0);
    expect(memory.backupPaths).toEqual([]);
  });

  it.each([
    ["wrong extension", new obsidian.TFile("Notes/source.txt"), "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>"],
    ["invalid details", new obsidian.TFile("Notes/source.md"), "not a details block"],
    ["trailing byte", new obsidian.TFile("Notes/source.md"), "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>\n"],
  ])("rejects %s before backup or process", async (_case, file, generated) => {
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);

    const result = await writer.replaceRealtimeOutline(file as MemoryFile, original, generated);

    expect(result).toEqual({
      status: "write-failed",
      backupPath: null,
      errorMessage: "Invalid outline replacement target or details block",
    });
    expect(memory.backupPaths).toEqual([]);
    expect(memory.processCount).toBe(0);
    expect(memory.markdown).toBe(original);
  });

  it.each([new Error("read unavailable"), "read unavailable"])("preserves initial read errors", async (failure) => {
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    const read = vi.spyOn(memory.vault, "read").mockRejectedValueOnce(failure);
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    try {
      const result = await writer.replaceRealtimeOutline(memory.target, original, generated);
      expect(result).toEqual({
        status: "write-failed",
        backupPath: null,
        errorMessage: failure instanceof Error ? failure.message : String(failure),
      });
      expect(memory.backupPaths).toEqual([]);
      expect(memory.processCount).toBe(0);
      expect(memory.markdown).toBe(original);
    } finally {
      read.mockRestore();
    }
  });

  it("allocates the next available backup timestamp directory", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    const root = ".obsidian/qnalog-outline-backups";
    await memory.vault.adapter!.mkdir(`${root}/2026-10-07T12-00-00-000Z`);
    await memory.vault.adapter!.mkdir(`${root}/2026-10-07T12-00-00-000Z-2`);
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    try {
      const result = await writer.replaceRealtimeOutline(memory.target, original, generated);
      expect(result.status).toBe("written");
      expect(result.backupPath).toBe(`${root}/2026-10-07T12-00-00-000Z-3/source.md`);
      expect(memory.readPath(result.backupPath!)).toBe(original);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a completed backup and concurrent bytes when process rejects after editing", async () => {
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    const concurrent = `${original}\n\nConcurrent process edit.`;
    const process = vi.spyOn(memory.vault, "process").mockImplementation(async (file, transform) => {
      memory.writeTarget(concurrent);
      transform(concurrent);
      throw new Error("process unavailable");
    });
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    try {
      const result = await writer.replaceRealtimeOutline(memory.target, original, generated);
      expect(result.status).toBe("write-failed");
      expect(result.errorMessage).toBe("process unavailable");
      expect(result.backupPath).toBeTruthy();
      expect(memory.readPath(result.backupPath!)).toBe(original);
      expect(memory.markdown).toBe(concurrent);
    } finally {
      process.mockRestore();
    }
  });

  it("keeps the replacement and backup when final readback fails", async () => {
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    const read = vi.spyOn(memory.vault, "read");
    read.mockImplementationOnce(async () => original);
    read.mockImplementationOnce(async () => original);
    read.mockImplementationOnce(async () => { throw new Error("readback unavailable"); });
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    try {
      const result = await writer.replaceRealtimeOutline(memory.target, original, generated);
      expect(result.status).toBe("write-failed");
      expect(result.errorMessage).toBe("readback unavailable");
      expect(result.backupPath).toBeTruthy();
      expect(memory.markdown).toContain("- New");
      expect(memory.readPath(result.backupPath!)).toBe(original);
    } finally {
      read.mockRestore();
    }
  });

  it("keeps target and adapter capabilities bound to their separate capture times", async () => {
    const original = createOriginalNote();
    const { memory, writer, setWriterVault } = makeWriterAndService(original);
    const backupVault = createMemoryVault(original, ".alternate-config");
    const latestVault = createMemoryVault(original, ".latest-config");
    const initialRead = vi.spyOn(memory.vault, "read");
    const backupAdapter = backupVault.vault.adapter!;
    const originalWrite = backupAdapter.write.bind(backupAdapter);
    const write = vi.spyOn(backupAdapter, "write");
    let releaseRead!: () => void;
    let reachedRead!: () => void;
    let releaseWrite!: () => void;
    let reachedWrite!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readReached = new Promise<void>((resolve) => { reachedRead = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeReached = new Promise<void>((resolve) => { reachedWrite = resolve; });
    initialRead.mockImplementationOnce(async () => {
      reachedRead();
      await readGate;
      return memory.markdown;
    });
    write.mockImplementationOnce(async function (path, content) {
      reachedWrite();
      await writeGate;
      return originalWrite(path, content);
    });
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    try {
      const pending = writer.replaceRealtimeOutline(memory.target, original, generated);
      await readReached;
      setWriterVault(backupVault.vault as never);
      releaseRead();
      await writeReached;
      setWriterVault(latestVault.vault as never);
      releaseWrite();
      const result = await pending;
      expect(result.status).toBe("written");
      expect(result.backupPath).toMatch(/^\.alternate-config\/qnalog-outline-backups\//);
      expect(backupVault.readPath(result.backupPath!)).toBe(original);
      expect(latestVault.backupPaths).toEqual([]);
      expect(memory.markdown).toContain("- New");
      expect(backupVault.markdown).toBe(original);
      expect(latestVault.markdown).toBe(original);
    } finally {
      releaseRead();
      releaseWrite();
      initialRead.mockRestore();
      write.mockRestore();
    }
  });
  it.each([0, 1, 2].flatMap((beforeLines) => [0, 1, 2].map((afterLines) => [beforeLines, afterLines] as const)))(
    "preserves insertion separators with %i leading and %i trailing newlines",
    async (beforeLines, afterLines) => {
      const info = "<details>\n<summary>Recording info</summary>\n\nDetails\n</details>";
      const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- Inserted\n</details>";
      const original = `A${"\n".repeat(beforeLines)}${info}${"\n".repeat(afterLines)}B`;
      const before = `A${"\n".repeat(beforeLines)}${info}`;
      const after = `${"\n".repeat(afterLines)}B`;
      const beforeSeparator = before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
      const afterSeparator = after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
      const expected = `${before}${beforeSeparator}${generated}${afterSeparator}${after}`;
      const { memory, writer } = makeWriterAndService(original);

      const result = await writer.replaceRealtimeOutline(memory.target, original, generated);

      expect(result.status).toBe("written");
      expect(memory.markdown).toBe(expected);
      expect(memory.readPath(result.backupPath!)).toBe(original);
    },
  );

  it("inserts after the last recording-info block", async () => {
    const first = "<details>\n<summary>Recording info</summary>\n\nFirst info\n</details>";
    const last = "<details>\n<summary>Recording info</summary>\n\nLast info\n</details>";
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- Inserted\n</details>";
    const original = `${first}\n\nBetween\n\n${last}\n\nTail`;
    const { memory, writer } = makeWriterAndService(original);

    const result = await writer.replaceRealtimeOutline(memory.target, original, generated);

    expect(result.status).toBe("written");
    expect(memory.markdown).toBe(`${first}\n\nBetween\n\n${last}\n\n${generated}\n\nTail`);
  });

  it.each([
    ["mkdir rejects", "mkdir unavailable"],
    ["backup write rejects", "write unavailable"],
    ["backup read rejects", "backup read unavailable"],
    ["backup read differs", "Outline backup readback did not match the original note"],
  ])("does not process the note when %s", async (scenario, message) => {
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    const adapter = memory.vault.adapter!;
    const spies = [
      vi.spyOn(adapter, "mkdir"),
      vi.spyOn(adapter, "write"),
      vi.spyOn(adapter, "read"),
    ];
    if (scenario === "mkdir rejects") spies[0].mockRejectedValueOnce(new Error(message));
    if (scenario === "backup write rejects") spies[1].mockRejectedValueOnce(new Error(message));
    if (scenario === "backup read rejects") spies[2].mockRejectedValueOnce(new Error(message));
    if (scenario === "backup read differs") spies[2].mockResolvedValueOnce("different bytes");
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    try {
      const result = await writer.replaceRealtimeOutline(memory.target, original, generated);
      expect(result.status).toBe("backup-failed");
      expect(result.backupPath).toBeNull();
      expect(result.errorMessage).toBe(message);
      expect(memory.processCount).toBe(0);
      expect(memory.markdown).toBe(original);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("reports a backup root that remains absent after mkdir", async () => {
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    const exists = vi.spyOn(memory.vault.adapter!, "exists").mockResolvedValue(false);
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    try {
      const result = await writer.replaceRealtimeOutline(memory.target, original, generated);
      expect(result).toEqual({
        status: "backup-failed",
        backupPath: null,
        errorMessage: "Could not create the outline backup folder",
      });
      expect(memory.processCount).toBe(0);
    } finally {
      exists.mockRestore();
    }
  });

  it("uses a root without a config-directory prefix when configDir is empty", async () => {
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original, "success", false, "");
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    const result = await writer.replaceRealtimeOutline(memory.target, original, generated);

    expect(result.status).toBe("written");
    expect(result.backupPath).toMatch(/^qnalog-outline-backups\/[^/]+\/source\.md$/);
    expect(memory.readPath(result.backupPath!)).toBe(original);
  });

  it("does not overwrite any backup after exhausting 100 timestamp directories", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    const adapter = memory.vault.adapter!;
    const root = ".obsidian/qnalog-outline-backups";
    const timestamp = "2026-10-07T12-00-00-000Z";
    const oldBytes = new Map<string, string>();
    for (let attempt = 0; attempt < 100; attempt++) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
      const path = `${root}/${timestamp}${suffix}`;
      await adapter.mkdir(path);
      const backupPath = `${path}/source.md`;
      await adapter.write(backupPath, `old-${attempt}`);
      oldBytes.set(backupPath, `old-${attempt}`);
    }
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    try {
      const result = await writer.replaceRealtimeOutline(memory.target, original, generated);
      expect(result).toEqual({
        status: "backup-failed",
        backupPath: null,
        errorMessage: "Could not allocate a unique outline backup timestamp",
      });
      expect(memory.processCount).toBe(0);
      expect(memory.markdown).toBe(original);
      for (const [path, bytes] of oldBytes) expect(memory.readPath(path)).toBe(bytes);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps storage failures to stopped service results without losing backup state", async () => {
    const original = createOriginalNote();
    const backupFailure = makeWriterAndService(original);
    backupFailure.memory.failBackupWrites();
    const backupResult = await backupFailure.service.rebuildNoteOutline(backupFailure.memory.target);
    expect(backupResult).toMatchObject({
      status: "stopped",
      stopReason: "backup-failed",
      backupPath: null,
      errorMessage: "Backup storage unavailable",
    });

    const writeFailure = makeWriterAndService(original);
    const process = vi.spyOn(writeFailure.memory.vault, "process").mockRejectedValue(new Error("process unavailable"));
    try {
      const result = await writeFailure.service.rebuildNoteOutline(writeFailure.memory.target);
      expect(result).toMatchObject({
        status: "stopped",
        stopReason: "write-failed",
        errorMessage: "process unavailable",
      });
      expect(result.backupPath).toBeTruthy();
      expect(writeFailure.memory.readPath(result.backupPath!)).toBe(original);
    } finally {
      process.mockRestore();
    }
  });
  it("skips a timestamp directory created by a racing mkdir", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    const adapter = memory.vault.adapter!;
    const mkdir = adapter.mkdir.bind(adapter);
    let timestampMkdirs = 0;
    const spy = vi.spyOn(adapter, "mkdir").mockImplementation(async (path) => {
      await mkdir(path);
      if (path.includes("2026-10-07T12-00-00-000Z") && ++timestampMkdirs === 1) {
        throw new Error("directory already created");
      }
    });
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    try {
      const result = await writer.replaceRealtimeOutline(memory.target, original, generated);
      expect(result.status).toBe("written");
      expect(result.backupPath).toBe(".obsidian/qnalog-outline-backups/2026-10-07T12-00-00-000Z-2/source.md");
      expect(memory.readPath(result.backupPath!)).toBe(original);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("preserves a backup file collision after creating its timestamp directory", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    const adapter = memory.vault.adapter!;
    const mkdir = adapter.mkdir.bind(adapter);
    let timestampMkdirs = 0;
    const spy = vi.spyOn(adapter, "mkdir").mockImplementation(async (path) => {
      await mkdir(path);
      if (path.includes("2026-10-07T12-00-00-000Z") && ++timestampMkdirs === 1) {
        await adapter.write(`${path}/source.md`, "pre-existing bytes");
      }
    });
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    try {
      const result = await writer.replaceRealtimeOutline(memory.target, original, generated);
      expect(result.status).toBe("written");
      expect(result.backupPath).toBe(".obsidian/qnalog-outline-backups/2026-10-07T12-00-00-000Z-2/source.md");
      expect(memory.readPath(".obsidian/qnalog-outline-backups/2026-10-07T12-00-00-000Z/source.md")).toBe("pre-existing bytes");
      expect(memory.readPath(result.backupPath!)).toBe(original);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps the note unchanged when process rejects before editing", async () => {
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    const process = vi.spyOn(memory.vault, "process").mockRejectedValue(new Error("process unavailable"));
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    try {
      const result = await writer.replaceRealtimeOutline(memory.target, original, generated);
      expect(result.status).toBe("write-failed");
      expect(result.errorMessage).toBe("process unavailable");
      expect(result.backupPath).toBeTruthy();
      expect(memory.markdown).toBe(original);
      expect(memory.readPath(result.backupPath!)).toBe(original);
    } finally {
      process.mockRestore();
    }
  });

  it("reports mismatched final readback without rolling back the replacement", async () => {
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    const read = vi.spyOn(memory.vault, "read");
    read.mockImplementationOnce(async () => original);
    read.mockImplementationOnce(async () => original);
    read.mockImplementationOnce(async () => "different final bytes");
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    try {
      const result = await writer.replaceRealtimeOutline(memory.target, original, generated);
      expect(result).toMatchObject({
        status: "write-failed",
        errorMessage: "Outline replacement readback did not match",
      });
      expect(result.backupPath).toBeTruthy();
      expect(memory.markdown).toContain("- New");
      expect(memory.readPath(result.backupPath!)).toBe(original);
    } finally {
      read.mockRestore();
    }
  });
  it("returns the adapter-unavailable backup error before processing", async () => {
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    const descriptor = Object.getOwnPropertyDescriptor(memory.vault, "adapter")!;
    Object.defineProperty(memory.vault, "adapter", { configurable: true, value: undefined });
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    try {
      const result = await writer.replaceRealtimeOutline(memory.target, original, generated);
      expect(result).toEqual({
        status: "backup-failed",
        backupPath: null,
        errorMessage: "Vault storage adapter is unavailable",
      });
      expect(memory.processCount).toBe(0);
      expect(memory.markdown).toBe(original);
    } finally {
      Object.defineProperty(memory.vault, "adapter", descriptor);
    }
  });

  it("returns the original mkdir error when a timestamp directory remains absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
    const original = createOriginalNote();
    const { memory, writer } = makeWriterAndService(original);
    const adapter = memory.vault.adapter!;
    const mkdir = adapter.mkdir.bind(adapter);
    const spy = vi.spyOn(adapter, "mkdir").mockImplementation(async (path) => {
      if (path.includes("2026-10-07T12-00-00-000Z")) throw new Error("timestamp mkdir failed");
      await mkdir(path);
    });
    const generated = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- New\n</details>";

    try {
      const result = await writer.replaceRealtimeOutline(memory.target, original, generated);
      expect(result).toMatchObject({
        status: "backup-failed",
        backupPath: null,
        errorMessage: "timestamp mkdir failed",
      });
      expect(memory.processCount).toBe(0);
      expect(memory.markdown).toBe(original);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});
