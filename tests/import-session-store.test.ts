import { describe, expect, it, vi } from "vitest";

const notes = new Map<string, string>();
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
  class Notice { constructor() {} }
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
    transcribeImportedAudio: async () => ({ text: "Imported audio transcript", durationMs: 1200, rawText: "Imported audio transcript", units: [] }),
  };
});
vi.mock("../src/notes/audio-refs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getAudioDurationMs: async () => 1200 };
});
import * as obsidian from "obsidian";
import { ImportService } from "../src/imports/import-service";
import type { ImportHost } from "../src/imports/import-service";
import { SessionStore } from "../src/session/session-store";
import type { RecordingSession } from "../src/shared/types";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";

function makeHost(): { host: ImportHost; sessionStore: SessionStore; sourcePath: string; audioPath: string } {
  const sourcePath = "QnALog/Import/source.txt";
  const audioPath = "QnALog/Import/clip.wav";
  const folders = new Set<string>();
  const app = {
    vault: {
      getAbstractFileByPath(path: string) {
        if (path === sourcePath || path === audioPath || notes.has(path)) return new obsidian.TFile(path);
        if (folders.has(path)) return new obsidian.TFolder(path);
        return null;
      },
      async read(file: { path: string }) { return file.path === sourcePath ? "A decision and its owner" : notes.get(file.path) || ""; },
      async readBinary() { return new Uint8Array([1, 2, 3]).buffer; },
      async createFolder(path: string) { folders.add(path); },
      async create(path: string, content: string) { notes.set(path, content); return new obsidian.TFile(path); },
      async modify(file: { path: string }, content: string) { notes.set(file.path, content); },
    },
  };
  const sessionStore = new SessionStore();
  const host = {
    app,
    diagnostics: { logDiagnostic: async () => undefined },
    noteWriter: {
      async appendToNote(path: string, content: string) { notes.set(path, (notes.get(path) || "") + content); },
      async insertBeforeSegmentsEnd(path: string, content: string) { notes.set(path, (notes.get(path) || "") + content); },
    },
    profiles: { getTranscribeProviderProfile: () => ({ title: "Test ASR" }) },
    queue: { add: async (task: unknown) => Object.assign({ id: "retry-task" }, task) },
    asrPipeline: { initializeSession: () => undefined, setSessionWorkProgress: () => undefined, maybeDeleteSegmentCacheFile: async () => undefined, isSegmentCachePath: () => false },
    sessionStore,
    sessionFinalize: {
      async finalizeSession(session: RecordingSession) {
        expect(sessionStore.get()).toBe(session);
        expect(session.segments).toHaveLength(1);
        sessionStore.end(session);
      },
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
  return { host, sessionStore, sourcePath, audioPath };
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
    }

    expect(sessionStore.get()).toBeNull();
    expect([...notes.values()].join("\n")).toContain("Imported audio transcript");
  });
});
