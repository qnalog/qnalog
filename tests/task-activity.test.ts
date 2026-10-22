import { describe, expect, it, vi } from "vitest";
import { setIcon } from "obsidian";
import {
  TaskActivityStore,
  classifyTaskError,
  createTaskActivity,
  deriveTaskActivityStatus,
  getTaskErrorHint,
} from "../src/shared/task-activity";
import { TaskActivityService } from "../src/tasks/task-activity-service";
import { t } from "../src/shared/i18n";

vi.mock("obsidian", () => ({
  Modal: class Modal {},
  Notice: class Notice {},
  TFile: class TFile { constructor(public path = "") {} },
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
  setIcon: vi.fn(),
}));

describe("task activity error classification", () => {
  it.each([
    ["LLM 调用超时 60s", "timeout"],
    ["429 Too Many Requests", "rate-limit"],
    ["401 Unauthorized", "authentication"],
    ["Failed to fetch", "network"],
    ["模型返回空文本", "empty-result"],
    ["音频文件不存在", "missing-input"],
    ["大模型配置不完整", "configuration"],
    ["unexpected parser failure", "internal"],
  ])("classifies %s as %s", (message, expected) => {
    expect(classifyTaskError(new Error(message))).toBe(expected);
  });

  it("provides a user-facing recovery hint", () => {
    expect(getTaskErrorHint("timeout")).toContain("retry");
    expect(getTaskErrorHint("authentication")).toMatch(/api key/i);
  });
});

describe("task activity liveness", () => {
  const now = 1_000_000;

  it("marks quiet running work slow and then stalled", () => {
    const activity = createTaskActivity({
      id: "task-1",
      status: "running",
      startedAt: now - 180_000,
      updatedAt: now - 40_000,
    }, now - 180_000);
    expect(deriveTaskActivityStatus(activity, now)).toBe("slow");
    expect(deriveTaskActivityStatus({ ...activity, updatedAt: now - 130_000 }, now)).toBe("stalled");
  });

  it("uses an explicit deadline as a hard stalled boundary", () => {
    const activity = createTaskActivity({
      id: "task-2",
      status: "waiting",
      startedAt: now - 10_000,
      updatedAt: now - 1_000,
      deadlineAt: now - 1,
    }, now - 10_000);
    expect(deriveTaskActivityStatus(activity, now)).toBe("stalled");
  });

  it("keeps terminal failures terminal", () => {
    const activity = createTaskActivity({
      id: "task-3",
      status: "failed",
      error: "timeout",
      updatedAt: now - 600_000,
    }, now - 600_000);
    expect(deriveTaskActivityStatus(activity, now)).toBe("failed");
  });
});

describe("TaskActivityStore", () => {
  it("records lifecycle events and preserves a failed task", () => {
    const store = new TaskActivityStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.start({
      id: "outline:session-1",
      kind: "outline",
      title: "实时大纲",
      stageLabel: "生成大纲",
      status: "running",
    });
    store.event("outline:session-1", {
      type: "request",
      label: "已发送大纲请求",
    });
    store.fail("outline:session-1", new Error("LLM 调用超时"), {
      actions: [{ id: "retry-outline", label: "重新生成", primary: true }],
    });

    const task = store.get("outline:session-1");
    expect(task?.status).toBe("failed");
    expect(task?.errorKind).toBe("timeout");
    expect(task?.events).toHaveLength(1);
    expect(task?.actions[0].id).toBe("retry-outline");
    expect(listener).toHaveBeenCalled();
  });

  it("keeps completed tasks briefly and can prune them", () => {
    const store = new TaskActivityStore();
    store.start({ id: "import:1", kind: "import", title: "导入转写" });
    store.complete("import:1");
    expect(store.list({ includeDone: true })).toHaveLength(1);
    store.prune({ doneAfterMs: 1, now: Date.now() + 10 });
    expect(store.list({ includeDone: true })).toHaveLength(0);
  });
});

describe("session task activity finalization stages", () => {
  function createService(session: Record<string, unknown>) {
    const service = new TaskActivityService({
      sessionStore: { get: () => session },
      settings: {},
      queue: null,
      recorder: { state: "idle" },
    } as never);
    service.taskActivityStore = new TaskActivityStore();
    const statusText: string[] = [];
    service.progressStatusEl = {
      empty: () => { statusText.length = 0; },
      removeClass: () => undefined,
      toggleClass: () => undefined,
      addClass: () => undefined,
      setAttr: () => undefined,
      createSpan: ({ text = "" }: { text?: string } = {}) => {
        statusText.push(text);
        return {};
      },
    } as never;
    return { service, statusText };
  }

  it.each([
    ["naming", "Generating title"],
    ["indexing", "Updating note index"],
  ])("keeps %s active in task activity and the status bar", (stage, label) => {
    const session: Record<string, unknown> = {
      id: "session-finalize", source: "recording", mdPath: "Notes/session.md",
      startedAt: "2026-10-09T10:00:00.000Z",
      workProgress: { stage, label: t(label), percent: stage === "naming" ? 94 : 97 },
    };
    const { service, statusText } = createService(session);

    service.syncSessionTaskActivity(session as never);
    service.updateBusyStatus();

    expect(service.taskActivityStore.get("finalize:session-finalize")?.status).toBe("running");
    expect(service.getCurrentActivityLabel()).toBe(t(label));
    expect(statusText).toContain(t(label) + ` ${stage === "naming" ? 94 : 97}%`);
  });

  it("marks the session task done only after the done stage", () => {
    const session: Record<string, unknown> = {
      id: "session-finalize", source: "recording", mdPath: "Notes/session.md",
      startedAt: "2026-10-09T10:00:00.000Z",
      workProgress: { stage: "naming", label: t("Generating title"), percent: 94 },
    };
    const { service } = createService(session);

    service.syncSessionTaskActivity(session as never);
    expect(service.taskActivityStore.get("finalize:session-finalize")?.status).toBe("running");

    session.workProgress = { stage: "indexing", label: t("Updating note index"), percent: 97 };
    service.syncSessionTaskActivity(session as never);
    expect(service.taskActivityStore.get("finalize:session-finalize")?.status).toBe("running");

    session.workProgress = { stage: "done", label: t("Processing complete"), percent: 100 };
    service.syncSessionTaskActivity(session as never);
    expect(service.taskActivityStore.get("finalize:session-finalize")?.status).toBe("done");
  });
});

describe("paused queue recovery status", () => {
  function createRecoveryStatusFixture() {
    const recoveryEntries: Array<Record<string, unknown>> = [{ issue: "unsupported-type" }];
    const queue = { tasks: [], recoveryEntries: () => recoveryEntries };
    const session: Record<string, unknown> = {};
    const service = new TaskActivityService({
      sessionStore: { get: () => session },
      settings: {},
      queue,
      recorder: { state: "idle" },
    } as never);
    service.taskActivityStore = new TaskActivityStore();
    const statusText: string[] = [];
    service.progressStatusEl = {
      empty: () => { statusText.length = 0; },
      removeClass: () => undefined,
      toggleClass: () => undefined,
      addClass: () => undefined,
      setAttr: () => undefined,
      createSpan: ({ text = "" }: { text?: string } = {}) => {
        statusText.push(text);
        return {};
      },
    } as never;
    return { service, statusText, recoveryEntries };
  }

  it("shows a warning and count instead of ready when only retained entries remain", () => {
    const { service, statusText } = createRecoveryStatusFixture();

    service.updateBusyStatus();

    expect(statusText.join(" ")).toContain(`1 · ${t("Paused recovery entries")}`);
    expect(statusText.join(" ")).not.toContain(t("QnALog is ready"));
    expect(setIcon).toHaveBeenCalledWith(expect.anything(), "triangle-alert");
  });

  it("keeps an ordinary active task ahead of the retained-entry warning", () => {
    const { service, statusText } = createRecoveryStatusFixture();
    service.taskActivityStore.start({
      id: "outline:active",
      kind: "outline",
      title: "Live outline",
      stageLabel: "Generating outline",
      status: "running",
    });

    service.updateBusyStatus();

    expect(statusText.join(" ")).toContain("Live outline");
    expect(statusText.join(" ")).not.toContain(t("Paused recovery entries"));
  });

  it("returns to ready after retained entries clear", () => {
    const { service, statusText, recoveryEntries } = createRecoveryStatusFixture();
    recoveryEntries.length = 0;

    service.updateBusyStatus();

    expect(statusText.join(" ")).toContain(t("QnALog is ready"));
  });
});
