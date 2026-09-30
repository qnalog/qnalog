import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
  Notice: class Notice {},
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

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
