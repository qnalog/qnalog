import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
  Notice: class Notice {},
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import { TFile, TFolder } from "obsidian";
import { LiveAsrPipelineService } from "../src/asr/live-asr-pipeline-service";
import type { LiveAsrPipelineHost } from "../src/asr/live-asr-pipeline-service";
function makeService(writeBinary: () => Promise<void>) {
  const diagnostics = { logDiagnostic: vi.fn().mockResolvedValue(undefined) };
  const addQueueTask = vi.fn().mockResolvedValue({ id: "task-1" });
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
        remove: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
        stat: vi.fn().mockResolvedValue({ mtime: 0 }),
      },
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
  return { service: new LiveAsrPipelineService(host), diagnostics, addQueueTask, host };
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

    expect(result.deleted).toBe(1);
    expect(result.skipped).toBe(3);
    if (cleanupRoute === "trash") {
      expect(trashFile.mock.calls.map(([file]) => file.path)).toEqual([unrelatedPath]);
      expect(adapterRemove).not.toHaveBeenCalled();
    } else {
      expect(adapterRemove).toHaveBeenCalledExactlyOnceWith(unrelatedPath);
      expect(trashFile).not.toHaveBeenCalled();
    }
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
