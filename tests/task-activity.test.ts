import { describe, expect, it, vi } from "vitest";
import {
  TaskActivityStore,
  classifyTaskError,
  createTaskActivity,
  deriveTaskActivityStatus,
  getTaskErrorHint,
} from "../src/shared/task-activity";

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
    expect(getTaskErrorHint("timeout")).toContain("重试");
    expect(getTaskErrorHint("authentication")).toContain("API Key");
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
