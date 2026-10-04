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
import { RealtimeOutlineService } from "../src/notes/realtime-outline-service";
import { readCurrentOutlineBlock } from "../src/notes/outline-storage";
import { createRealtimeOutlineSourceCoverage } from "../src/notes/outline-coverage";
import { serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
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


function createMemoryVault(initialMarkdown: string) {
  const files = new Map<string, { file: MemoryFile; markdown: string }>();
  const folders = new Map<string, InstanceType<typeof obsidian.TFolder>>();
  const adapterFiles = new Map<string, string>();
  const target = new obsidian.TFile("Notes/source.md");
  files.set(target.path, { file: target, markdown: initialMarkdown });
  let beforeProcess: (() => void) | null = null;
  let failBackupWrite = false;
  let processCount = 0;

  const vault = {
    configDir: ".obsidian",
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
  };
}

function makeWriterAndService(initialMarkdown: string, generation: "success" | "incomplete" | "failure" | "cancel" = "success", busy = false) {
  const memory = createMemoryVault(initialMarkdown);
  const app = {
    vault: memory.vault,
    metadataCache: { getFileCache: () => ({ frontmatter: { qnalog_mode: "meeting" } }) },
  };
  const writer = new NoteWriter({
    app,
    settings: { ...DEFAULT_SETTINGS, enableRealtimeOutline: false, polishMode: "meeting" },
    noteIndex: {} as never,
  } as never);
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
  return { memory, writer, service };
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
});
