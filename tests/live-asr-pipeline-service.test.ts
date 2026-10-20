import { describe, expect, it, vi } from "vitest";

const masterNoticeMessages = vi.hoisted(() => [] as string[]);

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
  Notice: class Notice { constructor(message: unknown) { masterNoticeMessages.push(String(message)); } },
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import { TFile, TFolder } from "obsidian";
import { LiveAsrPipelineService } from "../src/asr/live-asr-pipeline-service";
import type { LiveAsrPipelineHost } from "../src/asr/live-asr-pipeline-service";
function makeService(writeBinary: () => Promise<void>) {
  const diagnostics = { logDiagnostic: vi.fn().mockResolvedValue(undefined) };
  const addQueueTask = vi.fn().mockResolvedValue({ id: "task-1" });
  const masterFiles = new Map<string, ArrayBuffer>();
  const host = {
    getSettings: () => ({
      segmentCacheFolder: "QnALog/.cache/segments",
      keepSegmentAudioFiles: false,
      audioChannelMode: "mono",
      activeTranscribeProvider: "test",
      transcribeProviders: {},
      transcribeEndpoint: "https://asr.example.com/v1/transcriptions",
      transcribeApiKey: "test-key",
      transcribeModel: "test-model",
      transcribeLanguage: "",
      audioFolder: "QnALog/Audio",
      consolidatedLayout: true,
    }),
    vault: {
      adapter: {
        exists: vi.fn().mockResolvedValue(false),
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeBinary,
        readBinary: vi.fn(async (path: string) => {
          const data = masterFiles.get(path);
          if (!data) throw new Error(`missing ${path}`);
          return data.slice(0);
        }),
        remove: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
        stat: vi.fn().mockResolvedValue({ mtime: 0 }),
      },
      createBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
        masterFiles.set(path, data.slice(0));
        return Object.assign(new TFile(), { path });
      }),
      getAbstractFileByPath: vi.fn(() => null),
      createFolder: vi.fn().mockResolvedValue(new TFolder()),
    },
    fileManager: { trashFile: vi.fn().mockResolvedValue(undefined) },
    diagnostics,
    queueTasks: () => [],
    queueRecoveryEntries: () => [],
    addQueueTask,
    updateQueueTask: vi.fn().mockResolvedValue(undefined),
    removeQueueTask: vi.fn().mockResolvedValue(undefined),
    removeLiveTranscriptBlock: vi.fn().mockResolvedValue(undefined),
    getRecorderBufferSummary: () => ({ masterChunkCount: 0, masterChunkBytes: 0, currentSegmentChunkCount: 0, currentSegmentChunkBytes: 0 }),
    syncImportBusyFromSessionProgress: vi.fn(),
    requestOutlineRefresh: vi.fn(),
    requestBubbleUpdate: vi.fn(),
  } as unknown as LiveAsrPipelineHost;
  return { service: new LiveAsrPipelineService(host), diagnostics, addQueueTask, host, masterFiles };
}

describe.each(["trash", "adapter"] as const)("LiveAsrPipelineService retained audio references via %s", (cleanupRoute) => {
  it("protects every retained reference shape from forced and expired cleanup", async () => {
    const { service, host } = makeService(vi.fn().mockResolvedValue(undefined));
    const cacheFolder = "QnALog/.cache/segments";
    const storedId = "damaged-task";
    const retainedEntries = [
      // Retained audio references from the top-level audioPath field.
      { entryIndex: 0, issue: "invalid-field" as const, storedId, audioPaths: ["QnALog/.cache/segments/top-level-audio-path.wav"] },
      // Retained audio references from a nested Segment.segmentAudioPath field.
      { entryIndex: 1, issue: "invalid-field" as const, storedId, audioPaths: ["QnALog/.cache/segments/nested-segment-audio-path.wav"] },
      // Retained audio references from a transcript revision utterance audioRef.path.
      { entryIndex: 2, issue: "invalid-field" as const, storedId, audioPaths: ["QnALog/.cache/segments/transcript-revision-audio-ref-path.wav"] },
    ];
    const retainedPaths = retainedEntries.flatMap(entry => entry.audioPaths);
    const unrelatedPath = `${cacheFolder}/unreferenced.wav`;
    host.queueRecoveryEntries = () => retainedEntries;
    const nowOld = Date.now() - 2 * 60 * 60 * 1000;
    const cacheFiles = [...retainedPaths, unrelatedPath].map(path => {
      const file = new TFile();
      Object.assign(file, { path, stat: { mtime: nowOld } });
      return file;
    });
    const trashFile = vi.fn().mockResolvedValue(undefined);
    host.fileManager.trashFile = trashFile;
    const adapterRemove = vi.fn().mockResolvedValue(undefined);
    host.vault.adapter.exists = vi.fn().mockResolvedValue(true);
    host.vault.adapter.remove = adapterRemove;
    host.vault.adapter.list = vi.fn().mockImplementation(async (path: string) =>
      path === cacheFolder ? { files: [...retainedPaths, unrelatedPath], folders: [] } : { files: [], folders: [] },
    );
    host.vault.adapter.stat = vi.fn().mockResolvedValue({ mtime: nowOld });
    host.vault.getAbstractFileByPath = (path: string) => {
      if (cleanupRoute === "adapter") return null;
      if (path === cacheFolder) {
        const folder = new TFolder();
        Object.assign(folder, { path, children: cacheFiles });
        return folder;
      }
      return cacheFiles.find(file => file.path === path) ?? null;
    };

    for (const path of retainedPaths) {
      await service.maybeDeleteSegmentCacheFile(path, storedId, true);
    }
    const result = await service.cleanupExpiredSegmentCacheFiles(60 * 60 * 1000);

    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(4);
    if (cleanupRoute === "trash") {
      expect(trashFile).not.toHaveBeenCalled();
      expect(adapterRemove).not.toHaveBeenCalled();
    } else {
      expect(adapterRemove).not.toHaveBeenCalled();
      expect(trashFile).not.toHaveBeenCalled();
    }
  });

  it("keeps expired cache audio without a verified final recording copy", async () => {
    const { service, host } = makeService(vi.fn().mockResolvedValue(undefined));
    const cacheFolder = "QnALog/.cache/segments";
    const path = `${cacheFolder}/qnalog-20261001-120000-seg01.webm`;
    const oldMtime = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const cacheFile = Object.assign(new TFile(), { path, name: path.split("/").pop(), stat: { mtime: oldMtime } });
    let cachePresent = true;
    const trashFile = vi.fn(async () => { cachePresent = false; });
    const adapterRemove = vi.fn(async () => { cachePresent = false; });
    host.fileManager.trashFile = trashFile;
    host.vault.adapter.exists = vi.fn().mockResolvedValue(true);
    host.vault.adapter.remove = adapterRemove;
    host.vault.adapter.list = vi.fn().mockResolvedValue({ files: [path], folders: [] });
    host.vault.adapter.stat = vi.fn().mockResolvedValue({ mtime: oldMtime });
    host.vault.getAbstractFileByPath = (candidate: string) => {
      if (cleanupRoute === "trash" && candidate === cacheFolder) {
        return Object.assign(new TFolder(), { path: cacheFolder, children: [cacheFile] });
      }
      return cleanupRoute === "trash" && candidate === path ? cacheFile : null;
    };

    const result = await service.cleanupExpiredSegmentCacheFiles(60 * 60 * 1000);

    expect(result).toMatchObject({ deleted: 0, skipped: 1, failed: 0 });
    expect(trashFile).not.toHaveBeenCalled();
    expect(adapterRemove).not.toHaveBeenCalled();
    expect(cachePresent).toBe(true);
    expect(host.diagnostics.logDiagnostic).toHaveBeenCalledWith(
      "info",
      "segment_cache.cleanup",
      expect.any(String),
      expect.objectContaining({ retainedWithoutVerifiedFinalCopy: 1 }),
    );
  });

  it("does not treat a same-name master file as proof that expired cache audio is safe to delete", async () => {
    const { service, host } = makeService(vi.fn().mockResolvedValue(undefined));
    const cacheFolder = "QnALog/.cache/segments";
    const path = `${cacheFolder}/qnalog-20261001-120000-seg01.webm`;
    const masterPath = "QnALog/Audio/qnalog-20261001-120000.webm";
    const oldMtime = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const cacheFile = Object.assign(new TFile(), { path, name: path.split("/").pop(), stat: { mtime: oldMtime } });
    const masterFile = Object.assign(new TFile(), { path: masterPath, name: masterPath.split("/").pop() });
    let cachePresent = true;
    const trashFile = vi.fn(async () => { cachePresent = false; });
    const adapterRemove = vi.fn(async () => { cachePresent = false; });
    host.fileManager.trashFile = trashFile;
    host.vault.adapter.exists = vi.fn().mockResolvedValue(true);
    host.vault.adapter.remove = adapterRemove;
    host.vault.adapter.list = vi.fn().mockResolvedValue({ files: [path], folders: [] });
    host.vault.adapter.stat = vi.fn().mockResolvedValue({ mtime: oldMtime });
    host.vault.getAbstractFileByPath = (candidate: string) => {
      if (cleanupRoute === "trash" && candidate === cacheFolder) {
        return Object.assign(new TFolder(), { path: cacheFolder, children: [cacheFile] });
      }
      if (candidate === masterPath) return masterFile;
      return cleanupRoute === "trash" && candidate === path ? cacheFile : null;
    };

    const result = await service.cleanupExpiredSegmentCacheFiles(60 * 60 * 1000);

    expect(result).toMatchObject({ deleted: 0, skipped: 1, failed: 0 });
    expect(trashFile).not.toHaveBeenCalled();
    expect(adapterRemove).not.toHaveBeenCalled();
    expect(cachePresent).toBe(true);
  });

  it("keeps the only segment cache when master readback verification fails for a keep-audio short recording", async () => {
    masterNoticeMessages.length = 0;
    const { service, host, masterFiles } = makeService(vi.fn().mockResolvedValue(undefined));
    const cachePath = "QnALog/.cache/segments/qnalog-short-segment.webm";
    const notePath = "QnALog/转写纪要/short-recording.md";
    const cacheFile = Object.assign(new TFile(), { path: cachePath });
    const masterPath = "QnALog/Audio/qnalog-20261020-120000.webm";
    let cachePresent = true;
    const trashFile = vi.fn(async (file: TFile) => {
      if (file.path === cachePath) cachePresent = false;
    });
    const adapterRemove = vi.fn(async (path: string) => {
      if (path === cachePath) cachePresent = false;
    });
    host.fileManager.trashFile = trashFile;
    host.vault.adapter.exists = vi.fn(async (path: string) => path === cachePath && cachePresent);
    host.vault.adapter.remove = adapterRemove;
    host.vault.createFolder = vi.fn().mockResolvedValue(new TFolder()) as never;
    host.vault.createBinary = vi.fn(async (path: string, data: ArrayBuffer) => {
      masterFiles.set(path, data.slice(0));
      return Object.assign(new TFile(), { path: masterPath });
    }) as never;
    host.discardMasterPartials = vi.fn().mockRejectedValue(new Error("master readback verification failed"));
    host.vault.getAbstractFileByPath = (path: string) => {
      if (cleanupRoute === "trash" && path === cachePath) return cacheFile;
      return null;
    };

    const session = {
      id: "short-session",
      sessionStamp: "20261020-120000",
      mdPath: notePath,
      shortRecordingTier: "keep-audio",
      masterAudioPath: "",
      masterAudioName: "",
      segments: [{ segmentAudioPath: cachePath }],
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await service.saveMasterAudio(session as never, {
      masterBlob: new Blob(["recorded speech"], { type: "audio/webm" }),
      masterMime: "audio/webm",
      masterExt: "webm",
    } as never);
    consoleError.mockRestore();
    expect(host.discardMasterPartials).toHaveBeenCalledWith("short-session", masterPath, 15);
    expect(session.masterAudioPath).toBe("");

    await service.discardShortRecordingNote(session as never);

    expect(cachePresent).toBe(true);
    expect(trashFile).not.toHaveBeenCalledWith(cacheFile);
    expect(adapterRemove).not.toHaveBeenCalledWith(cachePath);
  });

  it("keeps discard-tier cache and session-note cleanup behavior", async () => {
    const { service, host } = makeService(vi.fn().mockResolvedValue(undefined));
    const cachePath = "QnALog/.cache/segments/qnalog-silent-short-segment.webm";
    const notePath = "QnALog/转写纪要/short-recording.md";
    const cacheFile = Object.assign(new TFile(), { path: cachePath });
    const noteFile = Object.assign(new TFile(), { path: notePath });
    let cachePresent = true;
    const trashFile = vi.fn(async (file: TFile) => {
      if (file.path === cachePath) cachePresent = false;
    });
    const adapterRemove = vi.fn(async (path: string) => {
      if (path === cachePath) cachePresent = false;
    });
    host.fileManager.trashFile = trashFile;
    host.vault.adapter.exists = vi.fn(async (path: string) => path === cachePath && cachePresent);
    host.vault.adapter.remove = adapterRemove;
    host.vault.getAbstractFileByPath = (path: string) => {
      if (path === notePath) return noteFile;
      if (cleanupRoute === "trash" && path === cachePath) return cacheFile;
      return null;
    };

    await service.discardShortRecordingNote({
      id: "silent-session",
      mdPath: notePath,
      shortRecordingTier: "discard",
      segments: [{ segmentAudioPath: cachePath }],
    } as never);

    expect(cachePresent).toBe(false);
    expect(trashFile).toHaveBeenCalledWith(noteFile);
    if (cleanupRoute === "trash") expect(trashFile).toHaveBeenCalledWith(cacheFile);
    else expect(adapterRemove).toHaveBeenCalledWith(cachePath);
  });
});


describe("LiveAsrPipelineService segment persistence", () => {
  it("keeps the original blob available when cache writing fails and does not register a retry task", async () => {
    const writeBinary = vi.fn().mockRejectedValue(new Error("vault is read-only"));
    const { service, diagnostics, addQueueTask } = makeService(writeBinary);
    const session = {
      id: "session-1",
      sessionStamp: "20260930-120000",
      mdPath: "QnALog/Minutes/session.md",
      mode: "meeting",
      captureMode: "mic",
      segments: [],
    };
    service.initializeSession(session as never);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const descriptor = service.prepareLiveSegmentDescriptor(session, {
      blob,
      index: 0,
      startOffsetMs: 0,
      endOffsetMs: 1200,
      ext: "webm",
      isFinal: false,
    });

    const persisted = await service.queueLiveSegmentPersistence(session, descriptor, blob);

    expect(persisted).toMatchObject({ persisted: false, fallbackBlob: blob });
    expect(writeBinary).toHaveBeenCalledOnce();
    expect(addQueueTask).not.toHaveBeenCalled();
    expect(session.liveAsrJobs.get(descriptor.jobId)?.state).toBe("queued");
    expect(session.activeSegmentJobs).toBe(1);
    expect(diagnostics.logDiagnostic).toHaveBeenCalledWith(
      "error",
      "asr.segment_cache_write_failed",
      expect.any(String),
      expect.objectContaining({ segmentIndex: 0, durationMs: 1200 }),
    );
  });
});
