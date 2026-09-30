import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class TFile { path: string; extension: string; constructor(path: string) { this.path = path; this.extension = "md"; } },
  Modal: class Modal {},
  Notice: class Notice {},
}));

import { TaskActivityService } from "../src/tasks/task-activity-service";
import { TaskActivityStore } from "../src/shared/task-activity";

describe("persisted queue activity recovery", () => {
  it("restores failed attempts, resets on retry, and preserves model progress across queue updates", () => {
    const time = Date.now();
    const queueTask = {
      id: "merge-a",
      type: "merge",
      status: "failed",
      retries: 3,
      attempt: 3,
      createdAt: new Date(time - 10_000).toISOString(),
      startedAt: new Date(time - 5_000).toISOString(),
      updatedAt: new Date(time - 1_000).toISOString(),
      lastEventAt: new Date(time - 1_000).toISOString(),
      lastError: "target write failed",
      mdPath: "QnALog/Minutes/target.md",
      mode: "synthesis",
    };
    const host = {
      queue: { tasks: [queueTask] },
      settings: { maxRetries: 3 },
      sessionStore: { get: () => null },
      recorder: { state: "idle" },
      requestOutlineRefresh: vi.fn(),
      requestTaskQueueRetry: vi.fn(),
      register: vi.fn(),
      registerInterval: vi.fn(),
      addStatusBarItem: vi.fn(),
    };
    const service = Object.create(TaskActivityService.prototype) as TaskActivityService;
    service.host = host as never;
    service.taskActivityStore = new TaskActivityStore();
    service.syncQueueTaskActivities();

    const failed = service.getCurrentActivityDetail();
    expect(failed).toMatchObject({
      queueTaskId: "merge-a",
      liveness: "failed",
      stepDetail: "target write failed",
      completedAt: Date.parse(queueTask.lastEventAt),
    });
    expect(service.getCurrentActivityLabel()).toBeNull();

    queueTask.status = "running";
    queueTask.startedAt = new Date(Date.now() - 1_000).toISOString();
    queueTask.updatedAt = queueTask.startedAt;
    queueTask.lastEventAt = queueTask.startedAt;
    queueTask.lastError = "";
    queueTask.attempt = 4;
    service.syncQueueTaskActivities();
    const activityId = service.queueTaskActivityId(queueTask);
    service.patchTaskActivity(activityId, {
      status: "running",
      stage: "llm-merge",
      stageLabel: "AI organizing",
      detail: "Organizing part 2",
      progress: 64,
      deadlineAt: Date.now() + 60_000,
    });
    queueTask.updatedAt = new Date(Date.now()).toISOString();
    service.syncQueueTaskActivities();

    const running = service.getCurrentActivityDetail();
    expect(running).toMatchObject({
      liveness: "running",
      stage: "llm-merge",
      stepDetail: "Organizing part 2",
      percent: 64,
      startedAt: Date.parse(queueTask.startedAt),
    });
    expect(service.getCurrentActivityLabel()).toBe("AI organizing");

    queueTask.status = "failed";
    queueTask.updatedAt = new Date(Date.now()).toISOString();
    queueTask.lastEventAt = queueTask.updatedAt;
    queueTask.lastError = "write failed again";
    service.syncQueueTaskActivities();
    const retriedFailure = service.getCurrentActivityDetail();
    expect(retriedFailure).toMatchObject({
      liveness: "failed",
      stage: "llm-merge",
      stepDetail: "write failed again",
      completedAt: Date.parse(queueTask.lastEventAt),
    });
    expect(service.getCurrentActivityLabel()).toBeNull();

    host.queue.tasks = [];
    service.syncQueueTaskActivities();
    expect(service.taskActivityStore.get(activityId)?.status).toBe("cancelled");
  });

  it("keeps a completed queue activity after its queue row is removed", () => {
    const task = { id: "merge-done", type: "merge", status: "running", createdAt: "2026-09-30T10:00:00.000Z", startedAt: "2026-09-30T10:00:01.000Z" };
    const host = {
      queue: { tasks: [task] },
      settings: { maxRetries: 3 },
      sessionStore: { get: () => null },
      recorder: { state: "idle" },
      requestOutlineRefresh: vi.fn(),
      register: vi.fn(),
      registerInterval: vi.fn(),
      addStatusBarItem: vi.fn(),
    };
    const service = Object.create(TaskActivityService.prototype) as TaskActivityService;
    service.host = host as never;
    service.taskActivityStore = new TaskActivityStore();
    service.syncQueueTaskActivities();
    const activityId = service.queueTaskActivityId(task);
    service.completeTaskActivity(activityId);
    host.queue.tasks = [];
    service.syncQueueTaskActivities();
    expect(service.taskActivityStore.get(activityId)?.status).toBe("done");
  });
});
