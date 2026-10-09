import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  TFile: class TFile {
    path: string;
    extension: string;
    constructor(path: string) { this.path = path; this.extension = path.split(".").pop() || ""; }
  },
  normalizePath: (path: string) => String(path).replace(/\\/g, "/"),
}));
import * as obsidian from "obsidian";
import { ContinuationService, type ContinuationServiceHost } from "../src/session/continuation-service";
import type { QueueRecoveryEntrySummary, QueueTask, RecordingSession } from "../src/shared/types";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import { serializeTranscriptBlock } from "../src/transcript/transcript-markdown";

afterEach(() => vi.unstubAllGlobals());

function makeService() {
  const files = new Map<string, string>();
  const fileObjects = new Map<string, InstanceType<typeof obsidian.TFile>>();
  const createdFolders: string[] = [];
  const removed: string[] = [];
  const trashed: string[] = [];
  let tasks: QueueTask[] = [];
  let recovery: QueueRecoveryEntrySummary[] = [];
  let scheduled = 0;
  let addTaskImpl: ContinuationServiceHost["addTask"] = async task => {
    tasks.push(task as QueueTask);
    return task as QueueTask;
  };
  let removeTaskImpl: ContinuationServiceHost["removeTask"] = async id => { removed.push(id); };
  let trashFileImpl: ContinuationServiceHost["fileManager"]["trashFile"] = async file => { trashed.push(file.path); };
  const getFile = (path: string) => {
    let file = fileObjects.get(path);
    if (!file) {
      file = new obsidian.TFile(path);
      fileObjects.set(path, file);
    }
    return file;
  };
  const host: ContinuationServiceHost = {
    vault: {
      read: async file => files.get(file.path) ?? "",
      create: async (path, content) => {
        files.set(path, content);
        return getFile(path);
      },
      getAbstractFileByPath: path => files.has(path) ? getFile(path) : null,
      createFolder: async path => { createdFolders.push(path); },
    } as never,
    fileManager: { trashFile: file => trashFileImpl(file) } as never,
    getSettings: () => ({ mdFolder: "QnALog", noteFileNameFormatNew: "YYYY-MM-DD", consolidatedLayout: false, polishMode: "synthesis" }),
    detectModeFromMarkdown: () => "meeting",
    queueTasks: () => tasks,
    queueRecoveryEntries: () => recovery,
    addTask: task => addTaskImpl(task),
    removeTask: id => removeTaskImpl(id),
    scheduleTaskQueueRetry: () => { scheduled++; },
  };
  const service = new ContinuationService(host);
  return {
    service, host, files, getFile, createdFolders, removed, trashed,
    get tasks() { return tasks; }, set tasks(value: QueueTask[]) { tasks = value; },
    get recovery() { return recovery; }, set recovery(value: QueueRecoveryEntrySummary[]) { recovery = value; },
    get scheduled() { return scheduled; },
    setAddTask(value: ContinuationServiceHost["addTask"]) { addTaskImpl = value; },
    setRemoveTask(value: ContinuationServiceHost["removeTask"]) { removeTaskImpl = value; },
    setTrashFile(value: ContinuationServiceHost["fileManager"]["trashFile"]) { trashFileImpl = value; },
  };
}

function transcriptBody(sessionId = "old-session", text = "PRIOR BODY") {
  const prior = attachTextTranscript({ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text }, sessionId, "text-import");
  return { prior, markdown: serializeTranscriptBlock(prior, "### Original transcript", prior.text) };
}

function setupMoment() {
  vi.stubGlobal("window", {
    moment: () => ({ format: (format: string) => format === "YYYY-MM-DD HH:mm" ? "2026-09-21 10:00" : "2026-09-21" }),
  });
}

describe("continuation preparation and queue coordination consumers", () => {
  it("isolates target queues after rejection and lets another target run", async () => {
    const { service } = makeService();
    const firstTarget = new obsidian.TFile("first.md");
    const secondTarget = new obsidian.TFile("second.md");
    let rejectFirst!: (error: Error) => void;
    const firstGate = new Promise<void>((_, reject) => { rejectFirst = reject; });
    const first = service.runOnTarget(firstTarget, () => firstGate);
    const second = service.runOnTarget(firstTarget, async () => "second-result");
    const other = service.runOnTarget(secondTarget, async () => "other-result");
    await expect(other).resolves.toBe("other-result");
    const failure = new Error("fixed first failure");
    rejectFirst(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe("second-result");
  });

  it("moves tracked sessions between targets and updates renamed paths", () => {
    const { service } = makeService();
    const a = new obsidian.TFile("a.md");
    const b = new obsidian.TFile("b.md");
    const session = { id: "session-a", continuationSourcePath: "old.md", continuation: { targetPath: "a.md" } } as RecordingSession;
    service.trackSession(session, a);
    service.trackSession(session, b);
    expect(service.hasActiveSessions(a)).toBe(false);
    expect(service.hasActiveSessions(b)).toBe(true);
    session.continuation!.targetPath = "old.md";
    service.onRename(b, "old.md");
    expect(session.continuationSourcePath).toBe("b.md");
    expect(session.continuation?.targetPath).toBe("b.md");
    service.onRename(b, "b.md");
    service.onRename(new obsidian.TFile("untracked.md"), "old.md");
    expect(session.continuationSourcePath).toBe("b.md");
  });

  it("schedules pending continuations only after blockers clear", () => {
    const fixture = makeService();
    const target = fixture.getFile("target.md");
    fixture.files.set("target.md", "");
    const task = (overrides: Record<string, unknown> = {}) => ({
      type: "merge", id: "merge-b", sessionId: "s-b", status: "pending", mdPath: "stage.md",
      mode: "meeting", segments: [], continuation: { targetPath: "target.md", targetSourceId: "x", recordedAt: "r" },
      ...overrides,
    }) as QueueTask;
    fixture.tasks = [task()];
    const held = { id: "held", continuation: undefined } as RecordingSession;
    fixture.service.trackSession(held, target);
    fixture.service.releaseSession("unrelated");
    expect(fixture.scheduled).toBe(0);
    fixture.service.releaseSession("held");
    expect(fixture.scheduled).toBe(1);
    fixture.service.releaseSession("held");
    expect(fixture.scheduled).toBe(1);
    fixture.tasks = [task({ dependsOnSessionIds: ["active"] })];
    fixture.service.trackSession({ id: "active" } as RecordingSession, new obsidian.TFile("elsewhere.md"));
    fixture.service.notifyQueueChanged();
    expect(fixture.scheduled).toBe(1);
    fixture.tasks = [task(), { type: "transcribe", sessionId: "s-b" } as QueueTask];
    fixture.service.notifyQueueChanged();
    fixture.tasks = [task()];
    fixture.recovery = [{ taskType: "merge", sessionId: "s-b" } as QueueRecoveryEntrySummary];
    fixture.service.notifyQueueChanged();
    fixture.recovery = [];
    fixture.tasks = [task({ status: "running" })];
    fixture.service.notifyQueueChanged();
    expect(fixture.scheduled).toBe(1);
  });

  it("detects busy targets from sessions, queue tasks, and recovery entries", () => {
    const fixture = makeService();
    const target = new obsidian.TFile("notes/target.md");
    expect(fixture.service.isTargetBusy(target)).toBe(false);
    fixture.service.trackSession({ id: "active" } as RecordingSession, target);
    expect(fixture.service.isTargetBusy(target)).toBe(true);
    fixture.service.releaseSession("active");
    fixture.tasks = [{
      type: "merge", sessionId: "queued", mdPath: "stage.md", mode: "meeting", segments: [],
      continuation: { targetPath: "notes\\target.md", targetSourceId: "x", recordedAt: "r" },
    } as QueueTask];
    expect(fixture.service.isTargetBusy(target)).toBe(true);
    fixture.tasks = [];
    fixture.recovery = [{ targetPath: "notes\\target.md", taskType: "merge" } as QueueRecoveryEntrySummary];
    expect(fixture.service.isTargetBusy(target)).toBe(true);
    fixture.recovery = [{ taskType: "generate-prompt" } as QueueRecoveryEntrySummary];
    expect(fixture.service.isTargetBusy(target)).toBe(false);
    fixture.recovery = [];
    expect(fixture.service.isTargetBusy(target)).toBe(false);
  });

  it("resolves a continuation target only for a matching merge staging path", () => {
    const fixture = makeService();
    const target = fixture.getFile("QnALog/target.md");
    fixture.files.set(target.path, "");
    const task = {
      type: "merge", sessionId: "s", mdPath: "QnALog/stage.md", temporarySourcePath: "QnALog\\stage.md",
      mode: "meeting", segments: [], continuation: { targetPath: target.path, targetSourceId: "x", recordedAt: "r" },
    } as QueueTask;
    fixture.tasks = [task];
    expect(fixture.service.resolveTarget(new obsidian.TFile("QnALog/stage.md"))).toBe(target);
    fixture.tasks = [];
    expect(fixture.service.resolveTarget(new obsidian.TFile("QnALog/stage.md"))).toBeNull();
    fixture.tasks = [{ ...task, continuation: undefined } as QueueTask];
    expect(fixture.service.resolveTarget(new obsidian.TFile("QnALog/stage.md"))).toBeNull();
    fixture.tasks = [task];
    (fixture.host.vault as unknown as { getAbstractFileByPath(path: string): unknown }).getAbstractFileByPath = () => ({});
    expect(fixture.service.resolveTarget(new obsidian.TFile("QnALog/stage.md"))).toBeNull();
  });

  it("prepares a continuation task with the expected stage metadata and collision suffix", async () => {
    setupMoment();
    const fixture = makeService();
    const target = fixture.getFile("target.md");
    const { prior, markdown } = transcriptBody();
    fixture.files.set(target.path, markdown);
    const prepared = await fixture.service.prepare(target, "session-b", "stamp", "recorded");
    expect(prepared.stageFile.path).toBe("QnALog/2026-09-21 · Pending continuation-session-b.md");
    expect(fixture.files.get(prepared.stageFile.path)).toContain("<!-- qnalog-session:session-b -->");
    expect(fixture.files.get(prepared.stageFile.path)).toContain("<!-- qnalog-segments-start:session-b -->");
    expect(fixture.files.get(prepared.stageFile.path)).toContain("<!-- qnalog-segments-end:session-b -->");
    expect(prepared.mode).toBe("meeting");
    expect(prepared.continuation.targetSourceId).toBe(prior.transcript.sourceId);
    expect(fixture.tasks[0]).toMatchObject({
      type: "merge", sessionId: "session-b", mdPath: prepared.stageFile.path,
      temporarySourcePath: prepared.stageFile.path, segments: [], status: "live", retries: 0,
      createdAt: "recorded", updatedAt: "recorded", dependsOnSessionIds: [],
      continuation: { targetPath: target.path, targetSourceId: prior.transcript.sourceId },
    });
    expect(fixture.tasks[0]).not.toHaveProperty("realtimeOutline");
    const collision = makeService();
    const collisionTarget = collision.getFile("target.md");
    collision.files.set(collisionTarget.path, markdown);
    collision.files.set("QnALog/2026-09-21 · Pending continuation-session-c.md", "occupied");
    await collision.service.prepare(collisionTarget, "session-c", "stamp", "recorded");
    expect(collision.tasks[0].mdPath).toBe("QnALog/2026-09-21 · Pending continuation-session-c-2.md");
  });

  it("rejects invalid continuation targets but accepts a dependency-backed note", async () => {
    setupMoment();
    const fixture = makeService();
    const wrongType = new obsidian.TFile("target.txt");
    await expect(fixture.service.prepare(wrongType, "s", "stamp", "recorded")).rejects.toThrow("The target is not a Markdown note");
    expect(fixture.files.size).toBe(0);
    const target = fixture.getFile("target.md");
    fixture.files.set(target.path, "No transcript");
    await expect(fixture.service.prepare(target, "s", "stamp", "recorded"))
      .rejects.toThrow("This note has no original transcript segments to continue recording from");
    expect(fixture.tasks).toEqual([]);
    fixture.service.trackSession({ id: "session-a" } as RecordingSession, target);
    const prepared = await fixture.service.prepare(target, "s", "stamp", "recorded");
    expect(prepared.dependsOnSessionIds).toEqual(["session-a"]);
  });

  it("rolls back a failed queue add and preserves its original error", async () => {
    setupMoment();
    const fixture = makeService();
    const target = fixture.getFile("target.md");
    fixture.files.set(target.path, transcriptBody().markdown);
    const failure = new Error("fixed queue failure");
    let attemptedTaskId = "";
    fixture.setAddTask(async task => { attemptedTaskId = task.id || ""; throw failure; });
    await expect(fixture.service.prepare(target, "s", "stamp", "recorded")).rejects.toBe(failure);
    expect(fixture.removed).toEqual([attemptedTaskId]);
    expect(fixture.trashed).toEqual(["QnALog/2026-09-21 · Pending continuation-s.md"]);
    fixture.setRemoveTask(async () => { throw new Error("remove failure"); });
    fixture.setTrashFile(async () => { throw new Error("trash failure"); });
    await expect(fixture.service.prepare(target, "s", "stamp", "recorded")).rejects.toBe(failure);
  });

  it("re-reads the target after staging when it is renamed", async () => {
    setupMoment();
    const fixture = makeService();
    const target = fixture.getFile("target.md");
    fixture.files.set(target.path, transcriptBody().markdown);
    let releaseCreate!: () => void;
    let signalCreate!: () => void;
    const createStarted = new Promise<void>(resolve => { signalCreate = resolve; });
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve; });
    const originalCreate = fixture.host.vault.create;
    (fixture.host.vault as unknown as { create(path: string, content: string): Promise<obsidian.TFile> }).create = async (path, content) => {
      signalCreate();
      await createGate;
      return originalCreate(path, content) as Promise<obsidian.TFile>;
    };
    const preparing = fixture.service.prepare(target, "s", "stamp", "recorded");
    await createStarted;
    target.path = "renamed.md";
    const { prior, markdown } = transcriptBody("new-session");
    fixture.files.set("renamed.md", markdown);
    fixture.service.trackSession({ id: "session-c" } as RecordingSession, target);
    releaseCreate();
    const prepared = await preparing;
    expect(prepared.continuation.targetPath).toBe("renamed.md");
    expect(prepared.continuation.targetSourceId).toBe(prior.transcript.sourceId);
    expect(prepared.dependsOnSessionIds).toEqual(["session-c"]);
  });

  it("cancels prepared work even when cleanup fails", async () => {
    const fixture = makeService();
    const stage = new obsidian.TFile("stage.md");
    let trashCalls = 0;
    fixture.setTrashFile(async () => { trashCalls++; throw new Error("trash failure"); });
    await expect(fixture.service.cancelPrepared("task", stage)).resolves.toBeUndefined();
    const failure = new Error("fixed remove failure");
    fixture.setRemoveTask(async () => { throw failure; });
    await expect(fixture.service.cancelPrepared("task", stage)).rejects.toBe(failure);
    expect(trashCalls).toBe(2);
  });
});

describe("continuation target coordination", () => {
  it("tracks an active target session and serializes finalizers for that target", async () => {
    const target = new obsidian.TFile("meeting.md");
    const service = new ContinuationService({
      vault: {} as never,
      fileManager: {} as never,
      getSettings: () => ({ mdFolder: "QnALog", noteFileNameFormatNew: "YYYY-MM-DD HHmm", consolidatedLayout: false, polishMode: "synthesis" }),
      detectModeFromMarkdown: () => "synthesis",
      queueTasks: () => [],
      queueRecoveryEntries: () => [],
      addTask: async () => { throw new Error("unexpected queue write"); },
      removeTask: async () => undefined,
      scheduleTaskQueueRetry: () => undefined,
    });
    const session = { id: "session-a", continuation: undefined } as RecordingSession;
    service.trackSession(session, target);
    expect(service.hasActiveSessions(target)).toBe(true);
    expect(service.getTrackedSessionIds(target)).toEqual(["session-a"]);

    const order: string[] = [];
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>(resolve => { signalFirstStarted = resolve; });
    const first = service.runOnTarget(target, async () => {
      order.push("first-start");
      signalFirstStarted();
      await firstGate;
      order.push("first-end");
    });
    const second = service.runOnTarget(target, async () => { order.push("second"); });
    await firstStarted;
    expect(order).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
    service.releaseSession(session.id);
    expect(service.hasActiveSessions(target)).toBe(false);
  });
});
