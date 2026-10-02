import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
  TFile: class TFile { path: string; extension: string; constructor(path: string) { this.path = path; this.extension = path.split(".").pop() || ""; } },
}));

import { TaskQueue } from "../src/queue/task-queue";

describe("continuation queue lifecycle", () => {
  it("keeps a continuation deferred until its earlier target session is gone", async () => {
    const retryMergeTask = vi.fn().mockResolvedValue({ deferred: true, reason: "waiting for earlier session" });
    const plugin = {
      settings: { maxRetries: 3 },
      saveAll: vi.fn(async () => undefined),
      queueRetry: { retryMergeTask },
      tasks: {
        updateBusyStatus: vi.fn(),
        queueTaskActivityId: vi.fn(() => "activity"),
        completeTaskActivity: vi.fn(),
        logCompletedWork: vi.fn(),
      },
      diagnostics: { logDiagnostic: vi.fn(async () => undefined) },
      asrPipeline: { recordAsrServiceAttemptSuccess: vi.fn() },
    };
    const queue = new TaskQueue(plugin as never);
    queue.load([
      { id: "earlier", type: "merge", sessionId: "session-a", status: "pending", mdPath: "target.md" },
      {
        id: "continuation", type: "merge", sessionId: "session-b", status: "pending", mdPath: "stage.md",
        continuation: { targetPath: "target.md", targetSourceId: "source-a", recordedAt: "2026-09-21T10:00:00.000Z" },
        dependsOnSessionIds: ["session-a"], retries: 2,
      },
    ]);

    const continuation = queue.tasks.find(task => task.id === "continuation")!;
    await queue.processOne(continuation);
    expect(retryMergeTask).not.toHaveBeenCalled();
    expect(continuation.status).toBe("pending");
    expect(continuation.retries).toBe(2);

    await queue.remove("earlier");
    await queue.processOne(continuation);
    expect(retryMergeTask).toHaveBeenCalledTimes(1);
    expect(continuation.status).toBe("pending");
    expect(continuation.lastError).toBe("waiting for earlier session");
    expect(continuation.retries).toBe(2);
  });
  it("drops malformed outline proof without blocking transcript recovery", () => {
    const queue = new TaskQueue({
      settings: { maxRetries: 3 },
      saveAll: vi.fn(async () => undefined),
    } as never);
    queue.load([{
      id: "continuation",
      type: "merge",
      sessionId: "session-b",
      status: "pending",
      mdPath: "stage.md",
      continuation: {
        targetPath: "target.md",
        targetSourceId: "source-a",
        recordedAt: "2026-09-21T10:00:00.000Z",
        realtimeOutline: "- Partial outline",
        realtimeOutlineSourceCoverage: "invalid proof",
      },
    }]);

    const task = queue.tasks[0];
    expect(task?.type).toBe("merge");
    if (!task || task.type !== "merge" || !task.continuation) throw new Error("continuation task was not restored");
    expect(task.status).toBe("pending");
    expect(task.continuation.realtimeOutline).toBe("- Partial outline");
    expect(task.continuation.realtimeOutlineSourceCoverage).toBeUndefined();
  });
});
