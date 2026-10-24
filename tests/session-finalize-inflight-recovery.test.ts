import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class TFile { path: string; extension: string; constructor(path = "") { this.path = path; this.extension = path.split(".").pop() || ""; } }
  return {
    Modal: class Modal {},
    TFile,
    Notice: class Notice {},
    setIcon: () => undefined,
    normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
  };
});

import * as obsidian from "obsidian";
import { runSessionFinalization, type SessionFinalizeRunPort } from "../src/notes/session-finalize-run-flow";
import { TaskQueue, type TaskQueueHost } from "../src/queue/task-queue";
import { TaskActivityService } from "../src/tasks/task-activity-service";
import { NoteMarkdownConflictError } from "../src/notes/note-write-conflict";
import type { QueueTask, RecordingSession } from "../src/shared/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

/** A queue whose persisted rows are kept as JSON, the way data.json would hold them. */
function makeQueue(initialDisk: unknown[] = [], retryMergeTask: TaskQueueHost["retryMergeTask"] = async () => undefined) {
  const disk = { rows: initialDisk };
  const host: TaskQueueHost = {
    getMaxRetries: () => 3,
    persistQueue: async () => { disk.rows = JSON.parse(JSON.stringify(queue.persistedSnapshot())) as unknown[]; },
    updateBusyStatus: () => undefined,
    retryTranscribeTask: async () => { throw new Error("unexpected transcribe"); },
    retryMergeTask,
    runGeneratePromptTask: async () => undefined,
    scheduleTaskQueueRetry: () => undefined,
    isAsrServiceCircuitOpen: () => false,
    getAsrServiceRetryDelayMs: () => 0,
    getAsrServiceCircuitState: () => ({ consecutiveFailures: 0, openUntilMs: 0, lastError: "" }),
    recordAsrServiceAttemptSuccess: () => undefined,
    recordAsrServiceAttemptFailure: () => ({ consecutiveFailures: 0, openUntilMs: 0, lastError: "" }),
    completeTaskActivity: () => undefined,
    logCompletedWork: () => undefined,
    logDiagnostic: async () => undefined,
  };
  const queue = new TaskQueue(host);
  queue.load(initialDisk);
  return { queue, disk };
}

function setup(queue: TaskQueue) {
  const file = new obsidian.TFile("Notes/2026-10-23 10:00 · General (recording).md");
  const session: RecordingSession = {
    id: "session-1", sessionStamp: "stamp", startedAt: "2026-10-23T10:00:00.000Z", mdPath: file.path,
    mode: "general", finalized: false,
    segments: [{ index: 0, startOffsetMs: 0, endOffsetMs: 60_000, text: "A usable transcript." }],
  };
  const settings = { autoOpenNoteAfterFinish: false, sedimentAutoExtract: false, llmEndpoint: "", llmModel: "" };
  const port: SessionFinalizeRunPort = {
    hasQueue: () => true,
    updateQueueTask: (id, patch) => queue.update(id, patch), removeQueueTask: (id) => queue.remove(id),
    discardShortRecordingNote: vi.fn(async () => undefined), discardShortRecordingAudio: vi.fn(async () => undefined),
    logDiagnostic: vi.fn(async () => undefined),
    endSession: vi.fn(), requestOutlineRefresh: vi.fn(),
    getSettings: () => settings, getLlmConfigIssue: () => "",
    getVault: () => ({ getAbstractFileByPath: () => file, read: async () => "# placeholder note" } as never),
    openFile: vi.fn(async () => undefined), readSilenceTicks: () => ({ voiced: 0, silent: 0 }),
    setProgress: vi.fn(), cleanupSuccessfulSegmentAudio: vi.fn(async () => undefined), removeEmptySessionBlock: vi.fn(async () => undefined),
    appendPolishBlock: vi.fn(async () => undefined), rewriteConsolidated: vi.fn(async () => undefined),
    renameWithGeneratedTitle: vi.fn(async () => null), refreshNoteIndex: vi.fn(async () => undefined), autoExtractSediment: vi.fn(),
    syncTranscriptAudioSource: vi.fn(async () => undefined), confirmSpeakerNames: vi.fn(async (_s, segments) => ({ segments, frontmatter: null })), offerSpeakerNaming: vi.fn(async () => false),
    processMeetingWorkbench: vi.fn(async () => undefined), ensureRealtimeOutline: vi.fn(async () => undefined),
    mergeAndPolish: vi.fn(async () => "Polished"), clearCommittedBriefingCheckpoint: vi.fn(async () => undefined),
    addQueueTask: (task) => queue.add(task), requestDeferredAsrRetry: vi.fn(), requestTaskQueueRetry: vi.fn(),
    beginTaskMeter: vi.fn(() => ({ meter: true })), endTaskMeter: vi.fn(() => null), logCompletedWork: vi.fn(),
    saveVersion: vi.fn(async () => undefined), formatNow: (format) => `M:${format}`, buildTitleSource: () => "",
  };
  return { port, session };
}

const mergeTasks = (queue: TaskQueue): QueueTask[] => queue.tasks.filter((task) => task.type === "merge");

describe("first organize survives a reload while the model is still running", () => {
  it("persists a running merge task before the model call and removes it after the note is written", async () => {
    const { queue, disk } = makeQueue();
    const { port, session } = setup(queue);
    const model = deferred<string>();
    let seenDuringModelCall: unknown[] = [];
    vi.mocked(port.mergeAndPolish).mockImplementation(() => {
      seenDuringModelCall = JSON.parse(JSON.stringify(disk.rows)) as unknown[];
      return model.promise;
    });

    const finalizing = runSessionFinalization(port, session);
    await vi.waitFor(() => expect(port.mergeAndPolish).toHaveBeenCalled());

    expect(seenDuringModelCall).toHaveLength(1);
    expect(seenDuringModelCall[0]).toMatchObject({
      type: "merge", sessionId: "session-1", mdPath: session.mdPath, mode: "general", status: "running", liveFinalize: true,
    });
    const persisted = seenDuringModelCall[0] as { sessionMeta: Record<string, unknown>; segments: unknown[] };
    expect(persisted.segments).toHaveLength(1);
    expect(persisted.sessionMeta.startedAt).toBe("2026-10-23T10:00:00.000Z");
    expect(persisted.sessionMeta).not.toHaveProperty("_taskMeter");
    expect(persisted.sessionMeta).not.toHaveProperty("_previousKnowledge");

    model.resolve("Polished");
    await finalizing;
    expect(port.rewriteConsolidated).toHaveBeenCalled();
    expect(mergeTasks(queue)).toHaveLength(0);
    expect(disk.rows).toEqual([]);
  });

  it("after a reload mid-call the task comes back pending, the queue retries it, and the status bar is not idle", async () => {
    const { queue: liveQueue, disk } = makeQueue();
    const { port, session } = setup(liveQueue);
    vi.mocked(port.mergeAndPolish).mockImplementation(() => new Promise<string>(() => undefined)); // never answers: Obsidian is closed here
    void runSessionFinalization(port, session);
    await vi.waitFor(() => expect(port.mergeAndPolish).toHaveBeenCalled());
    const diskAtReload = JSON.parse(JSON.stringify(disk.rows)) as unknown[];

    const retryMergeTask = vi.fn(async () => undefined);
    const { queue: restarted } = makeQueue(diskAtReload, retryMergeTask);
    expect(mergeTasks(restarted)).toHaveLength(1);
    expect(restarted.tasks[0]).toMatchObject({ status: "pending", sessionId: "session-1", mdPath: session.mdPath });
    expect(restarted.tasks[0]).not.toHaveProperty("liveFinalize");
    expect(String(restarted.tasks[0].lastError)).toContain("Interrupted");

    const lines: string[] = [];
    const el = {
      empty: () => { lines.length = 0; }, removeClass: () => undefined, toggleClass: () => undefined, setAttr: () => undefined,
      createSpan: (opts: { text?: string }) => { if (opts.text) lines.push(opts.text); return {}; },
    };
    const tasks = new TaskActivityService({
      sessionStore: { get: () => null }, settings: { maxRetries: 3 }, queue: restarted, recorder: { state: "idle" },
    } as never);
    (tasks as unknown as { progressStatusEl: unknown }).progressStatusEl = el;
    tasks.updateBusyStatus();
    expect(lines.join(" ")).not.toContain("ready");

    await restarted.processAll();
    expect(retryMergeTask).toHaveBeenCalledTimes(1);
    expect(restarted.tasks).toHaveLength(0);
  });

  it("keeps the in-flight task away from the queue's retry entry points while the live run executes", async () => {
    const retryMergeTask = vi.fn(async () => undefined);
    const { queue } = makeQueue([], retryMergeTask);
    const { port, session } = setup(queue);
    const model = deferred<string>();
    vi.mocked(port.mergeAndPolish).mockImplementation(() => model.promise);
    const finalizing = runSessionFinalization(port, session);
    await vi.waitFor(() => expect(port.mergeAndPolish).toHaveBeenCalled());

    const task = mergeTasks(queue)[0];
    await queue.processAll();
    await queue.processOne(task);
    expect(retryMergeTask).not.toHaveBeenCalled();
    expect(task.status).toBe("running");

    // The activity list does not get a second "running" row for the same work.
    const activities = new TaskActivityService({
      sessionStore: { get: () => null }, settings: { maxRetries: 3 }, queue, recorder: { state: "idle" },
    } as never);
    const touched = vi.fn();
    (activities as unknown as { taskActivityStore: unknown }).taskActivityStore = {
      get: () => undefined, start: touched, patch: touched, event: touched, list: () => [],
    };
    activities.syncQueueTaskActivities();
    expect(touched).not.toHaveBeenCalled();

    model.resolve("Polished");
    await finalizing;
    expect(mergeTasks(queue)).toHaveLength(0);
  });

  it("a retryable model failure rewrites the same task as pending and it can run again", async () => {
    const retryMergeTask = vi.fn(async () => undefined);
    const { queue } = makeQueue([], retryMergeTask);
    const { port, session } = setup(queue);
    vi.mocked(port.mergeAndPolish).mockRejectedValueOnce(new Error("request timed out"));
    await runSessionFinalization(port, session);

    expect(mergeTasks(queue)).toHaveLength(1);
    expect(queue.tasks[0]).toMatchObject({ status: "pending", lastError: "request timed out", retries: 0 });
    expect(queue.tasks[0].type === "merge" && queue.tasks[0].liveFinalize).toBeFalsy();
    expect(port.requestTaskQueueRetry).toHaveBeenCalledWith(1500, "briefing-finalization-failure");
    await queue.processAll();
    expect(retryMergeTask).toHaveBeenCalledTimes(1);
  });

  it("a non-retryable model failure rewrites the same task as blocked", async () => {
    const { queue } = makeQueue();
    const { port, session } = setup(queue);
    const error = Object.assign(new Error("API key rejected"), { nonRetryable: true });
    vi.mocked(port.mergeAndPolish).mockRejectedValueOnce(error);
    await runSessionFinalization(port, session);

    expect(mergeTasks(queue)).toHaveLength(1);
    expect(queue.tasks[0]).toMatchObject({ status: "blocked" });
    expect(queue.tasks[0].type === "merge" && queue.tasks[0].liveFinalize).toBeFalsy();
    expect(port.requestTaskQueueRetry).not.toHaveBeenCalled();
  });

  it("a note write failure leaves one pending task, and a write conflict leaves one manual-only blocked task", async () => {
    const first = makeQueue();
    const a = setup(first.queue);
    vi.mocked(a.port.rewriteConsolidated).mockRejectedValueOnce(new Error("disk is read-only"));
    await runSessionFinalization(a.port, a.session);
    expect(mergeTasks(first.queue)).toHaveLength(1);
    expect(first.queue.tasks[0]).toMatchObject({ status: "pending" });
    expect(first.queue.tasks[0].type === "merge" && first.queue.tasks[0].liveFinalize).toBeFalsy();
    expect(a.port.requestTaskQueueRetry).toHaveBeenCalledWith(1500, "briefing-write-failure");

    const second = makeQueue();
    const b = setup(second.queue);
    vi.mocked(b.port.rewriteConsolidated).mockRejectedValueOnce(new NoteMarkdownConflictError("changed"));
    await runSessionFinalization(b.port, b.session);
    expect(mergeTasks(second.queue)).toHaveLength(1);
    expect(second.queue.tasks[0]).toMatchObject({ status: "blocked", manualRetryRequired: true });
    expect(b.port.requestTaskQueueRetry).not.toHaveBeenCalled();
  });

  it("does not persist a task for a continuation recording, which never calls the model here", async () => {
    const { queue } = makeQueue();
    const { port, session } = setup(queue);
    session.continuation = { targetPath: "Notes/target.md", targetSourceId: "t", recordedAt: "2026-10-23T10:00:00.000Z" } as never;
    const addSpy = vi.spyOn(queue, "add");
    await runSessionFinalization(port, session);
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("still organizes when the in-flight task cannot be saved", async () => {
    const { queue } = makeQueue();
    const { port, session } = setup(queue);
    vi.spyOn(queue, "add").mockRejectedValueOnce(new Error("data.json is locked"));
    await runSessionFinalization(port, session);
    expect(port.mergeAndPolish).toHaveBeenCalled();
    expect(port.rewriteConsolidated).toHaveBeenCalled();
    expect(mergeTasks(queue)).toHaveLength(0);
  });
});
