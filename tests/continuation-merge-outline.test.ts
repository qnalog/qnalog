import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
  TFile: class TFile {
    path: string;
    extension: string;
    basename: string;
    constructor(path: string) {
      this.path = path;
      this.extension = path.split(".").pop() || "";
      this.basename = path.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
    }
  },
}));

vi.mock("../src/briefing/merge-pipeline", () => ({
  mergeAndPolish: vi.fn(async () => "Organized full transcript"),
}));

import * as obsidian from "obsidian";
import { QueueRetryService } from "../src/queue/queue-retry-service";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import { serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
import type { Segment } from "../src/shared/types";
afterEach(() => vi.unstubAllGlobals());
function segment(index: number, sourceId: string, text: string): Segment {
  return attachTextTranscript({
    index,
    startOffsetMs: index * 1000,
    endOffsetMs: (index + 1) * 1000,
    audioStartOffsetMs: index * 1000,
    audioEndOffsetMs: (index + 1) * 1000,
    audioName: `${sourceId}.webm`,
    audioPath: `${sourceId}.webm`,
    text,
  }, sourceId, "text-import");
}

function persistedSegment(segmentValue: Segment): string {
  return serializeTranscriptBlock(segmentValue, `### Segment ${segmentValue.index + 1}`, segmentValue.text);
}

describe("continuation queue merge normalization", () => {
  it("normalizes fresh segments once as a batch and reuses already committed transcript rows", async () => {
    const targetPath = "Minutes/target.md";
    const stagePath = "Minutes/stage.md";
    const target = new obsidian.TFile(targetPath);
    const stage = new obsidian.TFile(stagePath);
    const base = Array.from({ length: 8 }, (_, index) => segment(index, "target-source", `old ${index}`));
    const fresh = Array.from({ length: 3 }, (_, index) => segment(index, "fresh-session", `new ${index}`));
    const previouslyWrittenFresh = {
      ...fresh[0],
      startOffsetMs: 8000,
      endOffsetMs: 9000,
      index: 8,
    };
    let targetMarkdown = [
      "# Target",
      "<!-- qnalog-session:target -->",
      ...base.map(persistedSegment),
      persistedSegment(previouslyWrittenFresh),
    ].join("\n\n");
    const stageMarkdown = [
      "# Fresh",
      "<!-- qnalog-session:fresh-session -->",
      ...fresh.map(persistedSegment),
    ].join("\n\n");
    const task = {
      id: "append-task",
      type: "merge",
      sessionId: "fresh-session",
      mdPath: stagePath,
      temporarySourcePath: stagePath,
      mode: "synthesis",
      status: "pending",
      retries: 0,
      createdAt: "2026-10-02T12:00:00.000Z",
      updatedAt: "2026-10-02T12:00:00.000Z",
      segments: fresh,
      continuation: {
        targetPath,
        targetSourceId: "target-source",
        recordedAt: "2026-10-02T12:00:00.000Z",
      },
    };
    const committed = vi.fn(async (writeSession: { segments: Segment[] }) => {
      const latest = writeSession.segments.slice(-3);
      expect(latest.map(item => item.index)).toEqual([8, 9, 10]);
      expect(latest.map(item => [item.startOffsetMs, item.endOffsetMs])).toEqual([
        [8000, 9000], [9000, 10000], [10000, 11000],
      ]);
      expect(latest.map(item => [item.audioStartOffsetMs, item.audioEndOffsetMs])).toEqual([
        [0, 1000], [1000, 2000], [2000, 3000],
      ]);
      expect(latest.map(item => item.transcript?.id)).toEqual(fresh.map(item => item.transcript?.id));
      expect(latest.map(item => item.transcript?.currentRevision)).toEqual(fresh.map(item => item.transcript?.currentRevision));
    });
    const queue = {
      tasks: [task],
      update: vi.fn(async (_id: string, patch: Record<string, unknown>) => Object.assign(task, patch)),
    };
    const host = {
      app: {
        vault: {
          getAbstractFileByPath: (path: string) => path === targetPath ? target : path === stagePath ? stage : null,
          read: async (file: InstanceType<typeof obsidian.TFile>) => file.path === targetPath ? targetMarkdown : stageMarkdown,
        },
        metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
        fileManager: { trashFile: vi.fn(async () => undefined) },
      },
      continuations: {
        isSessionTracked: () => false,
        hasActiveSessions: () => false,
        runOnTarget: async (_file: unknown, action: () => Promise<unknown>) => action(),
      },
      queue,
      settings: { enableRealtimeOutline: false },
      outline: { completeRealtimeOutlineForMergedSegments: vi.fn(async () => null), mergeContinuationOutlineText: vi.fn() },
      noteWriter: { commitContinuation: committed },
      tasks: { queueTaskActivityId: () => "activity", patchTaskActivity: vi.fn() },
      versions: { saveVersion: vi.fn(async () => undefined) },
      noteIndex: { refreshNoteIndexSafely: vi.fn(async () => undefined) },
      asrPipeline: { cleanupSuccessfulSegmentAudio: vi.fn(async () => undefined) },
      diagnostics: { logDiagnostic: vi.fn(async () => undefined) },
      vocabulary: {},
    };
    const service = new QueueRetryService(host as never);
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-10-02 12:00:00" }) });

    await service.runAppendTask(task as never);

    expect(committed).toHaveBeenCalledTimes(1);
  });
});
