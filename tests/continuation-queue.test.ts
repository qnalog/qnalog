import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
  TFile: class TFile { path: string; extension: string; constructor(path: string) { this.path = path; this.extension = path.split(".").pop() || ""; } },
}));

import { TaskQueue } from "../src/queue/task-queue";
import type { TaskQueueHost } from "../src/queue/task-queue";
import type { MergeQueueTaskPayload, QueueTaskLifecycle, TranscribeQueueTaskPayload } from "../src/shared/types";

function makeQueueHost(overrides: Partial<TaskQueueHost> = {}): TaskQueueHost {
  return {
    getMaxRetries: () => 3,
    persistQueue: async () => undefined,
    updateBusyStatus: () => undefined,
    retryTranscribeTask: async (_task) => { throw new Error("Unexpected transcription task in queue fixture"); },
    retryMergeTask: async (_task) => { throw new Error("Unexpected merge task in queue fixture"); },
    runGeneratePromptTask: async (_task) => { throw new Error("Unexpected prompt task in queue fixture"); },
    scheduleTaskQueueRetry: () => undefined,
    isAsrServiceCircuitOpen: () => false,
    getAsrServiceRetryDelayMs: () => 0,
    getAsrServiceCircuitState: () => ({ consecutiveFailures: 0, openUntilMs: 0, lastError: "" }),
    recordAsrServiceAttemptSuccess: () => undefined,
    recordAsrServiceAttemptFailure: () => ({ consecutiveFailures: 0, openUntilMs: 0, lastError: "" }),
    completeTaskActivity: () => undefined,
    logCompletedWork: () => undefined,
    logDiagnostic: async () => undefined,
    ...overrides,
  };
}

describe("continuation queue lifecycle", () => {
  it("coalesces normalized transcription paths while retaining the first queue identity", async () => {
    const persisted: unknown[][] = [];
    const queue = new TaskQueue(makeQueueHost({
      persistQueue: async () => persisted.push(JSON.parse(JSON.stringify(queue.snapshot()))),
    }));
    const first: TranscribeQueueTaskPayload & Partial<QueueTaskLifecycle> = {
      type: "transcribe", sessionId: "session-a", mdPath: "notes\\meeting.md",
      audioPath: "audio\\clip.wav", segmentIndex: 2, audioName: "first.wav", ephemeralAudio: true,
      retries: 2,
    };
    const original = await queue.add(first);
    const originalId = original.id;
    const originalCreatedAt = original.createdAt;
    const second: TranscribeQueueTaskPayload & Partial<QueueTaskLifecycle> = {
      type: "transcribe", sessionId: "session-a", mdPath: "notes/meeting.md",
      audioPath: "audio/clip.wav", segmentIndex: 2, audioName: "updated.wav", lastError: "retry later",
    };

    const duplicate = await queue.add(second);

    expect(duplicate.id).toBe(originalId);
    expect(duplicate.createdAt).toBe(originalCreatedAt);
    expect(duplicate.retries).toBe(2);
    expect(duplicate.audioName).toBe("updated.wav");
    expect(duplicate.lastError).toBe("retry later");
    expect(queue.snapshot()).toHaveLength(1);
    expect(persisted.at(-1)).toEqual(queue.snapshot());
  });

  it.each([
    { type: "transcribe" as const, task: { type: "transcribe" as const, sessionId: "session-a", mdPath: "meeting.md", audioPath: "clip.wav", segmentIndex: 0 } },
    { type: "generate-prompt" as const, task: { type: "generate-prompt" as const, mode: "meeting" } },
  ])("removes successfully completed $type work after recording completion", async ({ type, task }) => {
    const persisted: unknown[][] = [];
    const completeTaskActivity = vi.fn();
    const logCompletedWork = vi.fn();
    const handler = vi.fn();
    const queue = new TaskQueue(makeQueueHost({
      persistQueue: async () => persisted.push(JSON.parse(JSON.stringify(queue.snapshot()))),
      completeTaskActivity,
      logCompletedWork,
      ...(type === "transcribe" ? { retryTranscribeTask: handler } : { runGeneratePromptTask: handler }),
    }));
    const queued = await queue.add(task);

    await queue.processOne(queued);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(completeTaskActivity).toHaveBeenCalledWith(queued, expect.objectContaining({ stage: "done" }));
    expect(logCompletedWork).toHaveBeenCalledTimes(1);
    expect(queue.snapshot()).toEqual([]);
    expect(persisted.some(snapshot => snapshot.some(row => row.id === queued.id && row.status === "running"))).toBe(true);
    expect(persisted.at(-1)).toEqual([]);
  });

  it("keeps a continuation deferred until its earlier target session is gone", async () => {
    const persisted: unknown[][] = [];
    const completeTaskActivity = vi.fn();
    const logCompletedWork = vi.fn();
    const retryMergeTask = vi.fn().mockResolvedValue({ deferred: true, reason: "waiting for earlier session" });
    const queue = new TaskQueue(makeQueueHost({
      persistQueue: async () => persisted.push(JSON.parse(JSON.stringify(queue.snapshot()))),
      retryMergeTask,
      completeTaskActivity,
      logCompletedWork,
    }));
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

    expect(persisted.at(-1)).toEqual([expect.objectContaining({
      id: "continuation", status: "pending", retries: 2, lastError: "waiting for earlier session",
    })]);
    expect(completeTaskActivity).not.toHaveBeenCalled();
    expect(logCompletedWork).not.toHaveBeenCalled();
  });

  it("preserves a retryable ASR transport failure through persisted queue recovery", async () => {
    const persisted: unknown[][] = [];
    const error = new Error("Failed to fetch");
    const recordAsrServiceAttemptFailure = vi.fn(() => ({
      consecutiveFailures: 1, openUntilMs: Date.parse("2100-01-01T00:00:00.000Z"), lastError: error.message,
    }));
    const completeTaskActivity = vi.fn();
    const logCompletedWork = vi.fn();
    const queue = new TaskQueue(makeQueueHost({
      persistQueue: async () => persisted.push(JSON.parse(JSON.stringify(queue.snapshot()))),
      retryTranscribeTask: async () => { throw error; },
      recordAsrServiceAttemptFailure,
      completeTaskActivity,
      logCompletedWork,
    }));
    const queued = await queue.add({
      type: "transcribe", sessionId: "session-a", mdPath: "meeting.md",
      audioPath: "clip.wav", segmentIndex: 1, retries: 2, transportFailures: 0,
    });
    await expect(queue.processOne(queued)).rejects.toBe(error);

    expect(queued.status).toBe("pending");
    expect(queued.retries).toBe(2);
    expect(queued.transportFailures).toBe(1);
    expect(queued.nextRetryAt).toBe("2100-01-01T00:00:00.000Z");
    expect(queued.deferredReason).toBe("service-unavailable");
    expect(recordAsrServiceAttemptFailure).toHaveBeenCalledWith(error);
    expect(completeTaskActivity).not.toHaveBeenCalled();
    expect(logCompletedWork).not.toHaveBeenCalled();
    const restored = new TaskQueue(makeQueueHost());
    restored.load(persisted.at(-1));
    expect(restored.snapshot()).toEqual([expect.objectContaining({
      id: queued.id, audioPath: "clip.wav", sessionId: "session-a", status: "pending",
      retries: 2, transportFailures: 1, nextRetryAt: "2100-01-01T00:00:00.000Z",
    })]);
  });
  it("drops malformed outline proof without blocking transcript recovery", () => {
    const queue = new TaskQueue(makeQueueHost());
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
  it("blocks an unknown continuation disposition without rewriting the task", () => {
    const queue = new TaskQueue(makeQueueHost());
    queue.load([{
      id: "continuation-cleanup",
      type: "merge",
      sessionId: "session-cleanup",
      status: "pending",
      mdPath: "stage.md",
      continuationDisposition: "unexpected",
      continuation: {
        targetPath: "target.md",
        targetSourceId: "source-a",
        recordedAt: "2026-09-21T10:00:00.000Z",
      },
    }]);

    expect(queue.tasks[0]).toMatchObject({
      status: "blocked",
      lastError: "Continuation cleanup information is invalid; the target was not changed.",
      continuationDisposition: "unexpected",
    });
  });
  it("reads the current retry limit when processing tasks", async () => {
    let settings = { maxRetries: 2 };
    let persistedQueue = "";
    let queue!: TaskQueue;
    queue = new TaskQueue(makeQueueHost({
      getMaxRetries: () => settings.maxRetries,
      persistQueue: async () => { persistedQueue = JSON.stringify(queue.snapshot()); },
      runGeneratePromptTask: async () => undefined,
    }));
    queue.load([{
      id: "prompt-retry",
      type: "generate-prompt",
      mode: "synthesis",
      status: "failed",
      retries: 2,
      createdAt: "2026-09-21T10:00:00.000Z",
      updatedAt: "2026-09-21T10:00:00.000Z",
    }]);

    await queue.processAll();
    expect(queue.snapshot()).toMatchObject([{ id: "prompt-retry", status: "failed", retries: 2 }]);

    settings = { maxRetries: 3 };
    await queue.processAll();
    expect(queue.snapshot()).toEqual([]);
    expect(persistedQueue).toBe("[]");
  });
  it.each([
    { lastError: "insufficient quota", status: "blocked", retries: 3 },
    { lastError: "Failed to fetch", status: "pending", retries: 2 },
  ] as const)("restores a failed merge from its JSON snapshot ($lastError)", ({ lastError, status, retries }) => {
    const makeTask = (): MergeQueueTaskPayload & QueueTaskLifecycle => ({
      id: "merge-policy-load",
      type: "merge",
      sessionId: "policy-session",
      mdPath: "policy.md",
      mode: "monologue",
      status: "failed",
      retries: 3,
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
      lastError: "",
      segments: [{ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "policy fixture transcript" }],
    });
    const storedTask = makeTask();
    storedTask.lastError = lastError;
    const persistedJson = JSON.stringify([storedTask]);
    const queue = new TaskQueue(makeQueueHost());
    queue.load(JSON.parse(persistedJson));

    expect(queue.snapshot()).toMatchObject([{
      id: "merge-policy-load",
      sessionId: "policy-session",
      mdPath: "policy.md",
      status,
      retries,
      segments: [{ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "policy fixture transcript" }],
    }]);
  });


  it.each([
    { error: Object.assign(new Error("upstream rejection"), { nonRetryable: true }), status: "blocked", retries: 2 },
    { error: new Error("Failed to fetch"), status: "failed", retries: 3 },
  ] as const)("persists failed merge classification and restores it ($status)", async ({ error, status, retries }) => {
    let persistedJson = "";
    const completeTaskActivity = vi.fn();
    const logCompletedWork = vi.fn();
    let queue!: TaskQueue;
    queue = new TaskQueue(makeQueueHost({
      persistQueue: async () => { persistedJson = JSON.stringify(queue.snapshot()); },
      retryMergeTask: async () => { throw error; },
      completeTaskActivity,
      logCompletedWork,
    }));
    queue.load([{
      id: "merge-policy-process",
      type: "merge",
      sessionId: "policy-session",
      mdPath: "policy.md",
      mode: "monologue",
      status: "pending",
      retries: 2,
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
      segments: [{ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "policy fixture transcript" }],
    }]);

    await expect(queue.processOne(queue.tasks[0])).rejects.toBe(error);
    const persistedTask = JSON.parse(persistedJson) as Array<MergeQueueTaskPayload & QueueTaskLifecycle>;
    expect(persistedTask[0]).toMatchObject({
      id: "merge-policy-process",
      sessionId: "policy-session",
      mdPath: "policy.md",
      status,
      retries,
      segments: [{ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "policy fixture transcript" }],
    });
    expect(completeTaskActivity).not.toHaveBeenCalled();
    expect(logCompletedWork).not.toHaveBeenCalled();

    const restoredQueue = new TaskQueue(makeQueueHost());
    restoredQueue.load(persistedTask);
    expect(restoredQueue.snapshot()).toMatchObject([{
      id: "merge-policy-process",
      sessionId: "policy-session",
      mdPath: "policy.md",
      status: status === "failed" ? "pending" : "blocked",
      retries: status === "failed" ? 2 : 2,
      segments: [{ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "policy fixture transcript" }],
    }]);
  });
});
