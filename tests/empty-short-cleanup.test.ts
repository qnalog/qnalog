import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notices: [] as Array<[string, number | undefined]>,
  confirm: vi.fn(),
  trash: vi.fn(),
}));
vi.mock("obsidian", () => ({
  TFile: class {
    path: string;
    extension: string;
    constructor(path: string, extension?: string) {
      this.path = path;
      this.extension = extension ?? path.split(".").pop() ?? "";
    }
  },
  TFolder: class {
    path: string;
    children: unknown[];
    constructor(path: string, children: unknown[] = []) { this.path = path; this.children = children; }
  },
  Notice: class { constructor(message: string, timeout?: number) { mocks.notices.push([String(message), timeout]); } },
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
}));
vi.mock("../src/ui/helpers", () => ({ qnalogConfirm: mocks.confirm, trashVaultFileRef: mocks.trash }));

import * as obsidian from "obsidian";
import { buildConsolidatedNoteContent } from "../src/notes/note-write-content";
import { buildRewriteSegmentBlock } from "../src/notes/note-transcript-materials";
import { CleanupService } from "../src/vault/cleanup-service";
import { t } from "../src/shared/i18n";

const NOTE_TITLE = "# 个人笔记 2026-09-14 11:33 · 个人笔记";
const MATERIALS = {
  recordingInfo: "",
  externalAudioSource: "",
  meetingWorkbench: "",
  realtimeOutline: "",
  textImportSource: "",
};

function buildNote(audioRefs: string[] = ["Audio/rec.webm"], text = ""): string {
  const audioLink = audioRefs[0] ? `![[${audioRefs[0]}]]` : "";
  const segment = { index: 0, startOffsetMs: 0, endOffsetMs: 4000, text, error: text ? undefined : "transcription failed" };
  return buildConsolidatedNoteContent({
    currentMarkdown: "",
    title: NOTE_TITLE,
    sessionId: "s1",
    continuationSessionId: "",
    totalMs: 4000,
    segmentCount: 1,
    textImport: false,
    retainAudio: true,
    isContinuation: false,
    masterAudioBlock: "",
    audioRow: audioRefs.map((ref) => `![[${ref}]]`).join(" "),
    priorAudioAppendix: "",
    rawBlocks: buildRewriteSegmentBlock(segment, audioLink),
    polish: { frontmatter: "", body: "", sedimentBlock: "" },
    materials: MATERIALS,
  });
}

function makeFixture(options: { mdFolder?: string; folderExists?: boolean; currentPath?: string } = {}) {
  const mdFolder = options.mdFolder ?? "Notes";
  const files = new Map<string, unknown>();
  const contents = new Map<string, string>();
  const folder = new obsidian.TFolder(mdFolder);
  if (options.folderExists !== false) files.set(mdFolder, folder);
  const host = {
    app: {
      vault: {
        getAbstractFileByPath: vi.fn((path: string) => files.get(path) ?? null),
        read: vi.fn(async (file: obsidian.TFile) => {
          if (!contents.has(file.path)) throw new Error(`missing note content: ${file.path}`);
          return contents.get(file.path)!;
        }),
      },
    },
    settings: { mdFolder, audioFolder: "Audio" },
    sessionStore: { get: vi.fn(() => options.currentPath ? { mdPath: options.currentPath } : null) },
    queue: { tasks: [] as Array<Record<string, unknown>> },
    saveAll: vi.fn(async () => undefined),
  };
  const service = new CleanupService(host as never);
  const addNote = (path: string, markdown = buildNote()) => {
    const file = new obsidian.TFile(path, "md");
    files.set(path, file);
    contents.set(path, markdown);
    folder.children.push(file);
    return file;
  };
  const addAudio = (path: string) => {
    const file = new obsidian.TFile(path, "webm");
    files.set(path, file);
    return file;
  };
  return { files, contents, folder, host, service, addNote, addAudio };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notices.length = 0;
  mocks.confirm.mockResolvedValue(true);
  mocks.trash.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("empty short recording cleanup consumer contract", () => {
  it("confirms once, trashes every note before unique audio, prunes matching queue rows, and saves once", async () => {
    const f = makeFixture();
    const first = f.addNote("Notes/first.md", buildNote(["Audio/first.webm"]));
    const second = f.addNote("Notes/second.md", buildNote(["Audio/second.webm"]));
    const firstAudio = f.addAudio("Audio/first.webm");
    const secondAudio = f.addAudio("Audio/second.webm");
    f.host.queue.tasks = [
      { type: "merge", id: "note-task", mdPath: first.path },
      { type: "transcribe", id: "audio-task", mdPath: "Other/note.md", audioPath: firstAudio.path },
      { type: "generate-prompt", id: "unrelated", mode: "meeting" },
    ];

    await f.service.cleanupEmptyShortRecordings();

    expect(mocks.confirm).toHaveBeenCalledOnce();
    const [, title, body, cta] = mocks.confirm.mock.calls[0] as unknown[];
    expect(title).toBe(t("Clean up blank short recordings"));
    expect(body).toContain("Found 2 blank short recordings.");
    expect(body).toContain("2 notes and 2 audio files.");
    expect(body).toContain("- Notes/first.md (00:04, 1 audio files)");
    expect(body).toContain("- Notes/second.md (00:04, 1 audio files)");
    expect(cta).toBe(t("Clean up"));
    expect(mocks.trash.mock.calls.map(([, file]) => (file as obsidian.TFile).path)).toEqual([
      first.path, second.path, firstAudio.path, secondAudio.path,
    ]);
    expect(f.host.queue.tasks.map((task) => task.id)).toEqual(["unrelated"]);
    expect(f.host.saveAll).toHaveBeenCalledOnce();
    expect(mocks.notices).toEqual([[`${t("Cleanup complete: minutes ")}2${t(" notes, recording ")}2${t(", removed from the queue ")}2`, 10000]]);
  });

  it("does nothing after cancellation", async () => {
    const f = makeFixture();
    const note = f.addNote("Notes/blank.md");
    f.addAudio("Audio/rec.webm");
    f.host.queue.tasks = [{ type: "merge", id: "keep", mdPath: note.path }];
    mocks.confirm.mockResolvedValue(false);

    await f.service.cleanupEmptyShortRecordings();

    expect(mocks.trash).not.toHaveBeenCalled();
    expect(f.host.queue.tasks.map((task) => task.id)).toEqual(["keep"]);
    expect(f.host.saveAll).not.toHaveBeenCalled();
    expect(mocks.notices).toEqual([]);
  });
  it("continues after confirmation when the queue is null", async () => {
    const f = makeFixture();
    const note = f.addNote("Notes/blank.md");
    const audio = f.addAudio("Audio/rec.webm");
    mocks.confirm.mockImplementation(async () => {
      Reflect.set(f.host, "queue", null);
      return true;
    });

    await f.service.cleanupEmptyShortRecordings();

    expect(mocks.trash.mock.calls.map(([, file]) => (file as obsidian.TFile).path)).toEqual([note.path, audio.path]);
    expect(f.host.saveAll).not.toHaveBeenCalled();
    expect(mocks.notices).toEqual([[`${t("Cleanup complete: minutes ")}1${t(" notes, recording ")}1${t(", removed from the queue ")}0`, 10000]]);
  });

  it("skips the active session note", async () => {
    const f = makeFixture({ currentPath: "Notes/current.md" });
    const note = f.addNote("Notes/current.md");

    await f.service.cleanupEmptyShortRecordings();

    expect(f.host.app.vault.read).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.trash).not.toHaveBeenCalled();
    expect(mocks.notices).toEqual([[t("No blank short recordings matching the criteria were found"), undefined]]);
    expect(note.path).toBe("Notes/current.md");
  });

  it("reports a missing transcript folder without reading or confirming", async () => {
    const f = makeFixture({ mdFolder: "Missing", folderExists: false });

    await f.service.cleanupEmptyShortRecordings();

    expect(f.host.app.vault.read).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.notices).toEqual([[`${t("Transcript minutes folder not found: ")}Missing`, 8000]]);
  });

  it("reports zero candidates without opening confirmation", async () => {
    const f = makeFixture();
    f.addNote("Notes/has-text.md", buildNote(["Audio/rec.webm"], "你好"));

    await f.service.cleanupEmptyShortRecordings();

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.notices).toEqual([[t("No blank short recordings matching the criteria were found"), undefined]]);
  });

  it("counts and trashes a shared audio reference once and ignores unresolved references", async () => {
    const f = makeFixture();
    f.addNote("Notes/first.md", buildNote(["Audio/shared.webm", "Audio/missing.webm"]));
    f.addNote("Notes/second.md", buildNote(["Audio/shared.webm"]));
    const audio = f.addAudio("Audio/shared.webm");

    await f.service.cleanupEmptyShortRecordings();

    expect(mocks.confirm.mock.calls[0]?.[2]).toContain("2 notes and 1 audio files.");
    expect(mocks.trash.mock.calls.map(([, file]) => (file as obsidian.TFile).path)).toEqual([
      "Notes/first.md", "Notes/second.md", audio.path,
    ]);
  });

  it("continues scanning after a note read fails", async () => {
    const f = makeFixture();
    const unreadable = f.addNote("Notes/unreadable.md");
    f.addNote("Notes/readable.md");
    f.host.app.vault.read.mockImplementation(async (file) => {
      if (file.path === unreadable.path) throw new Error("read failed");
      return f.contents.get(file.path)!;
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await f.service.cleanupEmptyShortRecordings();

    expect(log).toHaveBeenCalledWith("[QnALog] cleanup scan failed:", unreadable.path, expect.any(Error));
    expect(mocks.confirm.mock.calls[0]?.[2]).toContain("Found 1 blank short recordings.");
    expect(mocks.trash.mock.calls.map(([, file]) => (file as obsidian.TFile).path)).toContain("Notes/readable.md");
  });

  it("continues trashing after a note deletion fails and reports the failure", async () => {
    const f = makeFixture();
    const rejected = f.addNote("Notes/rejected.md");
    const retained = f.addNote("Notes/retained.md");
    mocks.trash.mockImplementation(async (_app: unknown, file: obsidian.TFile) => {
      if (file.path === rejected.path) throw new Error("trash failed");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await f.service.cleanupEmptyShortRecordings();

    expect(log).toHaveBeenCalledWith("[QnALog] cleanup note delete failed:", rejected.path, expect.any(Error));
    expect(mocks.trash.mock.calls.map(([, file]) => (file as obsidian.TFile).path)).toContain(retained.path);
    expect(mocks.notices[0]?.[0]).toContain(t(", failed {0}").replace("{0}", "1"));
  });

  it("skips audio removed while the confirmation dialog is open", async () => {
    const f = makeFixture();
    f.addNote("Notes/blank.md");
    const audio = f.addAudio("Audio/rec.webm");
    mocks.confirm.mockImplementation(async () => {
      f.files.delete(audio.path);
      return true;
    });
    await f.service.cleanupEmptyShortRecordings();

    expect(mocks.trash.mock.calls.map(([, file]) => (file as obsidian.TFile).path)).toEqual(["Notes/blank.md"]);
    expect(mocks.notices[0]?.[0]).toContain(`${t(" notes, recording ")}0`);
    expect(mocks.notices[0]?.[0]).not.toContain("failed");
  });

  it("reads the transcript folder from settings on every run", async () => {
    const f = makeFixture();
    f.addNote("Notes/first.md");
    mocks.confirm.mockResolvedValue(false);
    await f.service.cleanupEmptyShortRecordings();

    const nextFolder = new obsidian.TFolder("Other");
    f.files.set("Other", nextFolder);
    f.host.settings.mdFolder = "Other";
    const nextNote = new obsidian.TFile("Other/second.md", "md");
    f.files.set(nextNote.path, nextNote);
    f.contents.set(nextNote.path, buildNote());
    nextFolder.children.push(nextNote);

    await f.service.cleanupEmptyShortRecordings();

    expect(f.host.app.vault.read.mock.calls.map(([file]) => file.path)).toEqual([
      "Notes/first.md", "Other/second.md",
    ]);
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(mocks.confirm.mock.calls[1]?.[2]).toContain("Other/second.md");
  });
});
