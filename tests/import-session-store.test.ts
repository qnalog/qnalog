import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const notes = new Map<string, string>();
let importedAudioTexts = ["Imported audio transcript"];
let importedAudioIndex = 0;
let importedAudioDurationMs = 1200;
let importedAudioResultDurationMs = 1200;
let importedAudioBinary = new Uint8Array([1, 2, 3]).buffer;
let importedAudioNoSpeech = false;
let importedSourceText = "A decision and its owner";
let lastInitializedSession: RecordingSession | null = null;
const notices: string[] = [];
let importedAudioUnits: Array<{
  rawText: string;
  normalizedText: string;
  speakerId: string | null;
  speakerName: string | null;
  startMs: number | null;
  endMs: number | null;
  timing: "provider" | "audio-span" | "unknown";
}> = [];
vi.mock("obsidian", () => {
  class TFile {
    path: string;
    extension: string;
    name: string;
    basename: string;
    constructor(path: string) {
      this.path = path;
      this.extension = String(path).split(".").pop() || "";
      this.name = String(path).split("/").pop() || "";
      this.basename = this.name.replace(/\.[^.]+$/, "");
    }
  }
  class TFolder { constructor(public path: string) {} }
  class Notice { constructor(message?: string) { if (message) notices.push(message); } }
  class Modal { open() {} close() {} }
  class Setting { constructor() {} }
  return {
    TFile, TFolder, Notice, Modal, Setting, PluginSettingTab: class {},
    normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
  };
});

vi.mock("../src/asr/long-audio-transcription", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveImportTranscribeProvider: () => ({ id: "test-provider", endpoint: "https://asr.example.com/v1/transcriptions", apiKey: "test-key", model: "test-model" }),
    transcribeImportedAudio: async () => {
      const text = importedAudioTexts[importedAudioIndex++] || "";
      return { text, durationMs: importedAudioResultDurationMs, rawText: text, units: importedAudioUnits, ...(importedAudioNoSpeech ? { noSpeech: true } : {}) };
    },
  };
});
vi.mock("../src/notes/audio-refs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getAudioDurationMs: async () => importedAudioDurationMs };
});
import * as obsidian from "obsidian";
import { ImportService } from "../src/imports/import-service";
import type { ImportHost } from "../src/imports/import-service";
import { SessionStore } from "../src/session/session-store";
import type { RecordingSession } from "../src/shared/types";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { insertBeforeSessionSegmentsEnd } from "../src/notes/note-segment-store";
import { readTranscriptBlocks } from "../src/transcript/transcript-markdown";
import { verifyTranscriptCheckpoint } from "../src/imports/transcript-checkpoint";

function makeVariedTranscript(length: number): string {
  let state = length;
  return Array.from({ length }, () => {
    state = (state * 48_271) % 2_147_483_647;
    return String.fromCharCode(97 + state % 26);
  }).join("");
}

function makeHost(audioPaths = ["QnALog/Import/clip.wav"]): { host: ImportHost; sessionStore: SessionStore; sourcePath: string; audioPath: string; queuedTasks: unknown[]; diagnostics: unknown[][] } {
  const sourcePath = "QnALog/Import/source.txt";
  const audioPath = audioPaths[0];
  const folders = new Set<string>();
  const app = {
    vault: {
      getAbstractFileByPath(path: string) {
        if (path === sourcePath || audioPaths.includes(path) || notes.has(path)) return new obsidian.TFile(path);
        if (folders.has(path)) return new obsidian.TFolder(path);
        return null;
      },
      async read(file: { path: string }) { return file.path === sourcePath ? importedSourceText : notes.get(file.path) || ""; },
      async readBinary() { return importedAudioBinary; },
      async createFolder(path: string) { folders.add(path); },
      async create(path: string, content: string) { notes.set(path, content); return new obsidian.TFile(path); },
      async modify(file: { path: string }, content: string) { notes.set(file.path, content); },
    },
  };
  const sessionStore = new SessionStore();
  const queuedTasks: unknown[] = [];
  const diagnostics: unknown[][] = [];
  const host = {
    continuations: { trackSession: () => undefined, releaseSession: () => undefined } as never,
    app,
    diagnostics: { logDiagnostic: async (...args: unknown[]) => { diagnostics.push(args); } },
    noteWriter: {
      async appendToNote(path: string, content: string) { notes.set(path, (notes.get(path) || "") + content); },
      async insertBeforeSegmentsEnd(path: string, content: string, sessionId?: string) {
        await insertBeforeSessionSegmentsEnd({
          getVault: () => app.vault as never,
          appendToNote: async (target, value) => { notes.set(target, (notes.get(target) || "") + value); },
        }, path, content, sessionId);
      },
    },
    profiles: { getTranscribeProviderProfile: () => ({ title: "Test ASR" }) },
    queue: { add: async (task: unknown) => { queuedTasks.push(task); return Object.assign({ id: "retry-task" }, task); } },
    asrPipeline: { initializeSession: (session: RecordingSession) => { lastInitializedSession = session; }, setSessionWorkProgress: () => undefined, maybeDeleteSegmentCacheFile: async () => undefined, isSegmentCachePath: () => false },
    sessionStore,
    sessionFinalize: {
      finalizeSession: vi.fn(async (session: RecordingSession) => {
        expect(sessionStore.get()).toBe(session);
        expect(session.segments).toHaveLength(importedAudioTexts.length);
        sessionStore.end(session);
      }),
    },
    settings: {
      ...DEFAULT_SETTINGS,
      mdFolder: "QnALog/Minutes",
      llmEndpoint: "https://api.openai.com/v1",
      llmApiKey: "test-key",
      llmModel: "gpt-4o-mini",
    },
    shell: { refreshOutlineView: () => undefined, openOutlineView: async () => undefined },
    tasks: {
      _importBusy: null as null | Record<string, unknown>,
      updateImportActivity: () => undefined,
      updateImportRequest: () => undefined,
      updateBusyStatus: () => undefined,
    },
  } as unknown as ImportHost;
  return { host, sessionStore, sourcePath, audioPath, queuedTasks, diagnostics };
}

function differingRecordPaths(left: unknown, right: unknown, prefix = ""): string[] {
  if (Object.is(left, right)) return [];
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return [prefix || "root"];
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return [prefix || "root"];
    return left.flatMap((value, index) => differingRecordPaths(value, right[index], `${prefix}[${index}]`));
  }
  const leftRow = left as Record<string, unknown>;
  const rightRow = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRow), ...Object.keys(rightRow)]);
  return [...keys].flatMap((key) => differingRecordPaths(leftRow[key], rightRow[key], prefix ? `${prefix}.${key}` : key));
}

describe("text import session ownership", () => {
  it("publishes a text-import session before finalization and ends that exact session afterward", async () => {
    notes.clear();
    const { host, sessionStore, sourcePath } = makeHost();
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260930-120000" : "2026-09-30",
        toDate: () => new Date("2026-09-30T12:00:00.000Z"),
      }),
    });
    try {
      await new ImportService(host).importTextFiles([sourcePath], "synthesis");
    } finally {
      vi.unstubAllGlobals();
      importedAudioTexts = ["Imported audio transcript"];
      importedAudioIndex = 0;
    }

    expect(sessionStore.get()).toBeNull();
    expect([...notes.values()].join("\n")).toContain("A decision and its owner");
  });

  it("publishes an audio-import session before finalization and ends that exact session afterward", async () => {
    notes.clear();
    const { host, sessionStore, audioPath } = makeHost();
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260930-120100" : "2026-09-30",
        toDate: () => new Date("2026-09-30T12:01:00.000Z"),
      }),
      setTimeout: () => 1,
    });
    try {
      const result = await new ImportService(host).importAudioFiles([audioPath], "synthesis");
      expect(result?.segmentCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      importedAudioTexts = ["Imported audio transcript"];
      importedAudioIndex = 0;
    }

    expect(sessionStore.get()).toBeNull();
    expect([...notes.values()].join("\n")).toContain("Imported audio transcript");
  });

  it("imports generated 10-second silent WebM with stub ASR returning empty text", async () => {
    notes.clear();
    importedAudioTexts = [""];
    importedAudioIndex = 0;
    importedAudioDurationMs = 10_000;
    importedAudioResultDurationMs = 10_000;
    const silentAudio = readFileSync("tests/fixtures/silent-10s.webm");
    importedAudioBinary = silentAudio.buffer.slice(silentAudio.byteOffset, silentAudio.byteOffset + silentAudio.byteLength) as ArrayBuffer;
    const { host, audioPath } = makeHost();
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20261016-231200" : "2026-10-16",
        toDate: () => new Date("2026-10-16T23:12:00.000Z"),
      }),
      setTimeout: () => 1,
    });
    try {
      const result = await new ImportService(host).importAudioFiles([audioPath], "synthesis");
      expect(result).toMatchObject({ segmentCount: 1, pendingTranscriptionCount: 0 });
    } finally {
      vi.unstubAllGlobals();
      importedAudioTexts = ["Imported audio transcript"];
      importedAudioIndex = 0;
      importedAudioDurationMs = 1200;
      importedAudioResultDurationMs = 1200;
      importedAudioBinary = new Uint8Array([1, 2, 3]).buffer;
    }

    expect(lastInitializedSession?.segments[0]?.text).toBe("");
    expect(lastInitializedSession?.segments[0]?.error).toBeFalsy();
    expect(host.sessionFinalize.finalizeSession).toHaveBeenCalledOnce();
    expect(notes.size).toBeGreaterThan(0);
  });

  it("finishes an all-blank whole-file import as a no-speech note with no failed task and the audio kept", async () => {
    notes.clear();
    importedAudioTexts = [""];
    importedAudioIndex = 0;
    importedAudioNoSpeech = true;
    importedAudioDurationMs = 20_000;
    importedAudioResultDurationMs = 20_000;
    const { host, sessionStore, audioPath, queuedTasks } = makeHost(["QnALog/Import/silent-20s.wav"]);
    const updateImportActivity = vi.fn();
    host.tasks.updateImportActivity = updateImportActivity as never;
    // The real finalizer marks an all-blank import with the transcript-empty stage after writing the no-speech note.
    host.sessionFinalize.finalizeSession = vi.fn(async (session: RecordingSession) => {
      session.workProgress = { stage: "transcript-empty", label: "No speech detected", percent: 100 } as RecordingSession["workProgress"];
      sessionStore.end(session);
    });
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20261020-100000" : "2026-10-20",
        toDate: () => new Date("2026-10-20T10:00:00.000Z"),
      }),
      setTimeout: () => 1,
    });
    try {
      const result = await new ImportService(host).importAudioFiles(["QnALog/Import/silent-20s.wav"], "synthesis");
      expect(result).toMatchObject({ segmentCount: 1, pendingTranscriptionCount: 0 });
    } finally {
      vi.unstubAllGlobals();
      importedAudioTexts = ["Imported audio transcript"];
      importedAudioIndex = 0;
      importedAudioNoSpeech = false;
      importedAudioDurationMs = 1200;
      importedAudioResultDurationMs = 1200;
    }

    expect(audioPath).toBe("QnALog/Import/silent-20s.wav");
    expect(queuedTasks).toEqual([]);
    expect(lastInitializedSession?.segments[0]).toMatchObject({ text: "", error: null });
    const errorPatches = updateImportActivity.mock.calls.filter(([patch]) => patch && (patch as { error?: string }).error);
    expect(errorPatches).toEqual([]);
    const markdown = [...notes.values()].join("\n");
    expect(markdown).toContain("silent-20s.wav");
  });

  it("keeps anomalous long imported audio retryable and excludes its text", async () => {
    notes.clear();
    notices.length = 0;
    importedAudioTexts = ["<chinese>".repeat(4552)];
    importedAudioIndex = 0;
    importedAudioDurationMs = 4_000_000;
    importedAudioResultDurationMs = 4_000_000;
    const { host, audioPath, queuedTasks, diagnostics } = makeHost();
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260930-120101" : "2026-09-30",
        toDate: () => new Date("2026-09-30T12:01:01.000Z"),
      }),
      setTimeout: () => 1,
    });
    try {
      const result = await new ImportService(host).importAudioFiles([audioPath], "synthesis");
      expect(result?.pendingTranscriptionCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      importedAudioTexts = ["Imported audio transcript"];
      importedAudioIndex = 0;
      importedAudioDurationMs = 1200;
      importedAudioResultDurationMs = 1200;
    }

    const markdown = [...notes.values()].join("\n");
    expect(markdown).not.toContain("<chinese>");
    expect(markdown).toContain("transcription result does not match the recording duration");
    expect(queuedTasks[0]).toMatchObject({ audioPath, sourceAudioPath: audioPath, lastError: expect.stringContaining("recording duration") });
    expect(diagnostics).toContainEqual(expect.arrayContaining([
      "warn",
      "asr.long_recording_anomaly",
      expect.any(String),
      expect.objectContaining({ provider: "test-provider", model: "test-model", textLength: 40_968, durationMs: 4_000_000, signals: ["repetition"] }),
    ]));
    expect(notices).toContain("The transcription result does not match the recording duration. The recording has been kept and can be retried.");
    expect(host.sessionFinalize.finalizeSession).not.toHaveBeenCalled();
  });

  it("organizes a normal long imported transcript", async () => {
    notes.clear();
    importedAudioTexts = ["Imported audio transcript"];
    importedAudioIndex = 0;
    importedAudioDurationMs = 600_000;
    const { host, audioPath } = makeHost();
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260930-120102" : "2026-09-30",
        toDate: () => new Date("2026-09-30T12:01:02.000Z"),
      }),
      setTimeout: () => 1,
    });
    try {
      await new ImportService(host).importAudioFiles([audioPath], "synthesis");
    } finally {
      vi.unstubAllGlobals();
      importedAudioDurationMs = 1200;
    }
    expect([...notes.values()].join("\n")).toContain("Imported audio transcript");
    expect(host.sessionFinalize.finalizeSession).toHaveBeenCalledOnce();
  });

  it("writes a long whole-file import into the real transcript area before index data", async () => {
    notes.clear();
    const expected = makeVariedTranscript(4329);
    importedAudioTexts = [expected];
    importedAudioDurationMs = 300_000;
    importedAudioResultDurationMs = 300_000;
    importedAudioIndex = 0;
    const { host, audioPath } = makeHost();
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260930-120200" : "2026-09-30",
        toDate: () => new Date("2026-09-30T12:02:00.000Z"),
      }),
      setTimeout: () => 1,
    });
    try {
      await new ImportService(host).importAudioFiles([audioPath], "synthesis");
    } finally {
      vi.unstubAllGlobals();
      importedAudioTexts = ["Imported audio transcript"];
      importedAudioIndex = 0;
      importedAudioResultDurationMs = 1200;
      importedAudioDurationMs = 1200;
    }

    const markdown = [...notes.values()].join("\n");
    const detailRanges: Array<{ start: number; end: number }> = [];
    const detailTags = /<\/?details\b[^>]*>/gi;
    let depth = 0;
    let maximumDepth = 0;
    let openAt = -1;
    for (const match of markdown.matchAll(detailTags)) {
      if (/^<\/details/i.test(match[0])) {
        depth--;
        if (depth === 0 && openAt >= 0) detailRanges.push({ start: openAt, end: (match.index || 0) + match[0].length });
      } else {
        if (depth === 0) openAt = match.index || 0;
        depth++;
        maximumDepth = Math.max(maximumDepth, depth);
      }
    }
    const details = detailRanges.map(({ start, end }) => markdown.slice(start, end));
    const outsideDetails = detailRanges.reduceRight((text, { start, end }) => text.slice(0, start) + text.slice(end), markdown);
    const transcriptBlocks = readTranscriptBlocks(markdown);
    expect(verifyTranscriptCheckpoint(markdown, [{ text: expected }])).toMatchObject({
      ok: true,
      expectedSegments: 1,
      persistedSegments: 1,
    });
    expect(transcriptBlocks).toHaveLength(1);
    expect(transcriptBlocks[0].visibleBlock).toBe(expected);
    expect(depth).toBe(0);
    expect(maximumDepth).toBe(1);
    expect(outsideDetails).not.toMatch(/<!--\s*qnalog-/i);
    expect(details.filter((body) => /qnalog-transcript-start/.test(body))).not.toHaveLength(0);
    expect(markdown.match(/<summary>(?:Index data|索引数据)<\/summary>/g)).toHaveLength(1);
    expect(details.at(-1)).toMatch(/<summary>(?:Index data|索引数据)<\/summary>/);
    expect(details.at(-1)).not.toMatch(/qnalog-transcript-start/);
    expect(details.every((body) => body.length <= 3500)).toBe(true);
    expect([...markdown.matchAll(/qnalog-transcript-start:([^\s>]+):fragment:(\d+)/g)].map((match) => Number(match[2])))
      .toEqual([1, 2]);
    expect(markdown.indexOf("qnalog-segments-start:")).toBeGreaterThan(detailRanges[0].start);
    expect(markdown.indexOf("qnalog-segments-end:")).toBeGreaterThan(markdown.lastIndexOf("qnalog-transcript-end:"));
    expect(markdown.indexOf("qnalog-segments-end:")).toBeLessThan(detailRanges[detailRanges.length - 2].end);
  });

  it("persists a long imported transcript with provider utterances through the checkpoint", async () => {
    notes.clear();
    const expected = makeVariedTranscript(2480);
    importedAudioTexts = [expected];
    importedAudioDurationMs = 300_000;
    importedAudioResultDurationMs = 300_000;
    importedAudioIndex = 0;
    importedAudioUnits = Array.from({ length: Math.ceil(expected.length / 48) }, (_, index) => {
      const text = expected.slice(index * 48, (index + 1) * 48);
      return {
        rawText: text,
        normalizedText: text,
        speakerId: null,
        speakerName: null,
        startMs: index * 120,
        endMs: (index + 1) * 120,
        timing: "provider" as const,
      };
    });
    const expectedUtteranceCount = importedAudioUnits.length;
    const { host, audioPath } = makeHost();
    const originalBegin = host.sessionStore.begin.bind(host.sessionStore);
    vi.spyOn(host.sessionStore, "begin").mockImplementation((session) => {
      lastInitializedSession = session;
      originalBegin(session);
    });
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260930-120210" : "2026-09-30",
        toDate: () => new Date("2026-09-30T12:02:10.000Z"),
      }),
      setTimeout: () => 1,
    });
    try {
      await new ImportService(host).importAudioFiles([audioPath], "synthesis");
    } finally {
      vi.unstubAllGlobals();
      importedAudioTexts = ["Imported audio transcript"];
      importedAudioIndex = 0;
      importedAudioUnits = [];
      importedAudioResultDurationMs = 1200;
      importedAudioDurationMs = 1200;
    }

    const markdown = [...notes.values()].join("\n");
    const blocks = readTranscriptBlocks(markdown);
    const expectedRecord = lastInitializedSession?.segments[0]?.transcript;
    const persistedRecord = blocks[0]?.segment.transcript;
    expect(differingRecordPaths(expectedRecord, persistedRecord).slice(0, 20)).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].drifted).toBe(false);
    expect(blocks[0].visibleBlock).toBe(expected);
    expect(verifyTranscriptCheckpoint(markdown, lastInitializedSession!.segments)).toMatchObject({
      ok: true,
      expectedSegments: 1,
      persistedSegments: 1,
    });
    expect(readTranscriptBlocks(markdown)[0].visibleBlock).toBe(expected);
    expect(readTranscriptBlocks(markdown)[0].segment.transcript?.revisions[0].utterances).toHaveLength(expectedUtteranceCount);
  });

  it("does not bypass a failed transcript checkpoint when imported text exists", async () => {
    notes.clear();
    const importedText = makeVariedTranscript(4329);
    importedAudioTexts = [importedText];
    importedAudioDurationMs = 300_000;
    importedAudioResultDurationMs = 300_000;
    importedAudioIndex = 0;
    const { host, audioPath } = makeHost();
    const activity = vi.fn();
    const busyStatus = vi.fn();
    host.tasks.updateImportActivity = activity;
    host.tasks.updateBusyStatus = busyStatus;
    host.noteWriter.insertBeforeSegmentsEnd = async () => undefined;
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260930-120250" : "2026-09-30",
        toDate: () => new Date("2026-09-30T12:02:50.000Z"),
      }),
      setTimeout: () => 1,
    });
    try {
      await expect(new ImportService(host).importAudioFiles([audioPath], "synthesis"))
        .rejects.toThrow("(0/1)");
    } finally {
      vi.unstubAllGlobals();
      importedAudioTexts = ["Imported audio transcript"];
      importedAudioIndex = 0;
      importedAudioResultDurationMs = 1200;
      importedAudioDurationMs = 1200;
    }

    expect(host.tasks._importBusy).toBeNull();
    expect(busyStatus).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ phase: "persist", error: expect.stringContaining("(0/1)") }));
    expect(lastInitializedSession?.segments[0]?.text).toBe(importedText);
    expect(host.sessionFinalize.finalizeSession).not.toHaveBeenCalled();
    const markdown = [...notes.values()].join("\n");
    expect(markdown).toContain("(import failed; audio kept for retry)");
    expect(markdown).not.toContain("(importing…)");
  });

  it("keeps three imported audio transcripts in order when each splits into details fragments", async () => {
    notes.clear();
    const expectedTexts = [makeVariedTranscript(3000), makeVariedTranscript(4000), makeVariedTranscript(5000)];
    importedAudioTexts = expectedTexts;
    importedAudioDurationMs = 400_000;
    importedAudioResultDurationMs = 400_000;
    importedAudioIndex = 0;
    const paths = ["QnALog/Import/a.wav", "QnALog/Import/b.wav", "QnALog/Import/c.wav"];
    const { host } = makeHost(paths);
    const originalBegin = host.sessionStore.begin.bind(host.sessionStore);
    vi.spyOn(host.sessionStore, "begin").mockImplementation((session) => {
      lastInitializedSession = session;
      originalBegin(session);
    });
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260930-120300" : "2026-09-30",
        toDate: () => new Date("2026-09-30T12:03:00.000Z"),
      }),
      setTimeout: () => 1,
    });
    try {
      await new ImportService(host).importAudioFiles(paths, "synthesis");
    } finally {
      vi.unstubAllGlobals();
      importedAudioTexts = ["Imported audio transcript"];
      importedAudioIndex = 0;
      importedAudioResultDurationMs = 1200;
      importedAudioDurationMs = 1200;
    }
    const markdown = [...notes.values()].join("\n");
    const blocks = readTranscriptBlocks(markdown);
    expect(verifyTranscriptCheckpoint(markdown, lastInitializedSession!.segments)).toMatchObject({ ok: true, expectedSegments: 3, persistedSegments: 3 });
    expect(blocks.map((block) => block.visibleBlock)).toEqual(expectedTexts);
    expect(markdown.match(/<summary>(?:Index data|索引数据)<\/summary>/g)).toHaveLength(1);
    expect(markdown).not.toMatch(/^\*\*Segmented raw transcript \(\d+ segments\)\*\*$/m);
    expect(markdown).toMatch(/<summary>Raw transcript · Segment 1 \([^)]*\)(?: · Part 1\/\d+)?<\/summary>/);
  });

  it("keeps every continuation fragment of a 9000-character imported segment in order", async () => {
    notes.clear();
    const expected = makeVariedTranscript(9000);
    importedAudioTexts = [expected];
    importedAudioDurationMs = 700_000;
    importedAudioResultDurationMs = 700_000;
    importedAudioIndex = 0;
    const { host, audioPath } = makeHost();
    const originalBegin = host.sessionStore.begin.bind(host.sessionStore);
    vi.spyOn(host.sessionStore, "begin").mockImplementation((session) => {
      lastInitializedSession = session;
      originalBegin(session);
    });
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260930-120350" : "2026-09-30",
        toDate: () => new Date("2026-09-30T12:03:50.000Z"),
      }),
      setTimeout: () => 1,
    });
    try {
      await new ImportService(host).importAudioFiles([audioPath], "synthesis");
    } finally {
      vi.unstubAllGlobals();
      importedAudioTexts = ["Imported audio transcript"];
      importedAudioIndex = 0;
      importedAudioResultDurationMs = 1200;
      importedAudioDurationMs = 1200;
    }
    const markdown = [...notes.values()].join("\n");
    expect(readTranscriptBlocks(markdown).map((block) => block.visibleBlock)).toEqual([expected]);
    const fragmentNumbers = [...markdown.matchAll(/qnalog-transcript-start:[^\s>]+:fragment:(\d+)/g)].map((match) => Number(match[1]));
    expect(fragmentNumbers.length).toBeGreaterThanOrEqual(3);
    expect(fragmentNumbers).toEqual(fragmentNumbers.map((_number, index) => index + 1));
    expect(verifyTranscriptCheckpoint(markdown, lastInitializedSession!.segments)).toMatchObject({ ok: true, expectedSegments: 1, persistedSegments: 1 });
  });

  it("uses the same independent transcript area for long imported text", async () => {
    notes.clear();
    importedSourceText = "long text. ".repeat(400);
    const { host, sourcePath } = makeHost();
    vi.stubGlobal("window", {
      moment: () => ({
        format: (format: string) => format === "YYYYMMDD-HHmmss" ? "20260930-120400" : "2026-09-30",
        toDate: () => new Date("2026-09-30T12:04:00.000Z"),
      }),
      setTimeout: () => 1,
    });
    try {
      await new ImportService(host).importTextFiles([sourcePath], "synthesis");
    } finally {
      vi.unstubAllGlobals();
      importedSourceText = "A decision and its owner";
    }
    const markdown = [...notes.values()].join("\n");
    const blocks = readTranscriptBlocks(markdown);
    expect(blocks.map((block) => block.visibleBlock).join("\n")).toContain("long text.");
    expect(markdown.match(/<summary>(?:Index data|索引数据)<\/summary>/g)).toHaveLength(1);
    expect(markdown).not.toMatch(/<summary>(?:Index data|索引数据)<\/summary>[\s\S]*qnalog-transcript-start/);
  });
});
