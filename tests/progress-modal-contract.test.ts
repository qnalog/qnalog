import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Modal: class Modal {},
  Notice: class Notice {},
  setIcon: vi.fn(),
}));

import { QueueModal } from "../src/ui/modals";

class MemoryElement {
  className = "";
  text = "";
  children: MemoryElement[] = [];
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = { add: (name: string) => this.addClass(name), remove: (name: string) => this.removeClass(name) };
  isConnected = true;
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 500;
  disabled = false;
  onclick: ((event: { preventDefault(): void; stopPropagation(): void }) => unknown) | null = null;
  addClass(name: string) { this.className = `${this.className} ${name}`.trim(); }
  removeClass(name: string) { this.className = this.className.split(/\s+/).filter((part) => part !== name).join(" "); }
  empty() { this.children = []; this.text = ""; }
  remove() { this.isConnected = false; }
  addEventListener() {}
  removeEventListener() {}
  setText(value: string) { this.text = value; }
  setAttr(name: string, value: string) { this.attributes[name] = value; }
  setAttribute(name: string, value: string) { this.setAttr(name, value); }
  getAttribute(name: string) { return this.attributes[name] || null; }
  createDiv(options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) { return this.createChild(options); }
  createSpan(options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) { return this.createChild(options); }
  createEl(_tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) { return this.createChild(options); }
  private createChild(options: { cls?: string; text?: string; attr?: Record<string, string> }) {
    const child = new MemoryElement();
    child.className = options.cls || "";
    child.text = options.text || "";
    child.attributes = options.attr || {};
    this.children.push(child);
    return child;
  }
  querySelector(selector: string): MemoryElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector: string): MemoryElement[] {
    const className = selector.startsWith(".") ? selector.slice(1).split(/[ .]/).pop() || "" : "";
    const matches: MemoryElement[] = [];
    for (const child of this.children) {
      if (className && child.className.split(/\s+/).includes(className)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
  get textContent(): string { return [this.text, ...this.children.map((child) => child.textContent)].filter(Boolean).join(" "); }
  set textContent(value: string) { this.text = value; }
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function makeProgressHarness() {
  const task = {
    id: "merge-task",
    type: "merge",
    sessionId: "session-a",
    status: "failed",
    retries: 1,
    attempt: 1,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    lastError: "target write failed",
    segments: [{ index: 0 }],
    mdPath: "QnALog/Minutes/target.md",
  };
  let activityStatus = "failed";
  let detail: Record<string, unknown> = {
    queueTaskId: task.id,
    kind: "AI Organize",
    modeLabel: "",
    stage: "organize",
    step: "This run failed",
    stepDetail: task.lastError,
    percent: null,
    count: "Attempt 1 of 3",
    liveness: "failed",
    startedAt: Date.parse(task.startedAt),
    updatedAt: Date.parse(task.updatedAt),
    completedAt: Date.parse(task.updatedAt),
  };
  const queue = {
    tasks: [task],
    processOne: vi.fn(() => Promise.resolve()),
    remove: vi.fn(async () => undefined),
  };
  const queueRetry = { retryQueue: vi.fn(async () => undefined) };
  const tasks = {
    completedWorkLog: [],
    _taskMeter: null,
    _importBusy: null,
    getCurrentActivityDetail: () => detail,
    getCurrentActivityLabel: () => activityStatus === "running" ? String(detail.step) : null,
    getTaskActivities: () => [{
      id: `queue:${task.id}`,
      kind: "queue-merge",
      status: activityStatus,
      title: "AI Organize",
      stageLabel: String(detail.step),
      startedAt: Number(detail.startedAt),
      updatedAt: Number(detail.updatedAt),
      progress: detail.percent,
      error: String(detail.stepDetail),
      events: [],
      actions: [],
    }],
    syncQueueTaskActivities: () => undefined,
  };
  const plugin = {
    queue,
    queueRetry,
    tasks,
    diagnostics: { copyDiagnosticReport: vi.fn(async () => undefined) },
    getCurrentSession: () => null,
  };
  const modal = new QueueModal({} as never, plugin as never);
  modal.contentEl = new MemoryElement() as never;
  modal.modalEl = new MemoryElement() as never;

  return {
    modal,
    task,
    queue,
    queueRetry,
    get detail() { return detail; },
    get activityStatus() { return activityStatus; },
    setRunning(stage: string, label: string, progress: number | null = null) {
      activityStatus = "running";
      task.status = "running";
      task.startedAt = new Date().toISOString();
      task.lastError = "";
      detail = {
        ...detail,
        stage,
        step: label,
        stepDetail: stage === "write-note" ? "Writing the organized result to Obsidian" : "Waiting for the model response",
        percent: progress,
        liveness: "running",
        startedAt: Date.parse(task.startedAt),
        updatedAt: Date.now(),
        completedAt: 0,
      };
    },
    setFailed(error: string) {
      activityStatus = "failed";
      task.status = "failed";
      task.lastError = error;
      task.updatedAt = new Date().toISOString();
      detail = {
        ...detail,
        step: "This run failed",
        stepDetail: error,
        liveness: "failed",
        updatedAt: Date.parse(task.updatedAt),
        completedAt: Date.parse(task.updatedAt),
      };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("QueueModal rendered recovery states", () => {
  it("shows a failed queue task without an active pulse and redraws immediately on retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
      setInterval,
      clearInterval,
      moment: (value: number | string) => ({ format: () => new Date(value).toISOString().slice(11, 19) }),
    });
    const harness = makeProgressHarness();
    const request = deferred<void>();
    harness.queue.processOne.mockImplementation(() => {
      harness.setRunning("llm-merge", "AI organizing");
      return request.promise;
    });
    harness.modal.onOpen();
    let root = harness.modal.contentEl as never as MemoryElement;
    expect(root.textContent).toContain("Processing incomplete");
    expect(root.textContent).toContain("target write failed");
    expect(root.querySelector(".qnalog-progress-pipeline-pulse")).toBeNull();
    expect(root.querySelectorAll(".qnalog-progress-queue-row")).toHaveLength(1);

    const buttons = root.querySelectorAll(".qnalog-progress-queue-retry");
    const retryHandler = buttons[buttons.length - 1].onclick!;
    const retryPromise = retryHandler({ preventDefault() {}, stopPropagation() {} });
    root = harness.modal.contentEl as never as MemoryElement;
    expect(root.textContent).toContain("AI organizing");
    expect(root.querySelector(".qnalog-progress-pipeline-pulse")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1300);
    root = harness.modal.contentEl as never as MemoryElement;
    expect(root.querySelector(".qnalog-progress-timing")?.textContent).toContain("Elapsed 1s");

    harness.setRunning("write-note", "Write to Minutes", 88);
    harness.modal.onOpen();
    root = harness.modal.contentEl as never as MemoryElement;
    expect(root.textContent).toContain("Write to Minutes");
    expect(root.textContent).toContain("Writing the organized result to Obsidian");
    request.reject(new Error("target write failed again"));
    await retryPromise;
    harness.setFailed("target write failed again");
    harness.modal.onOpen();
    root = harness.modal.contentEl as never as MemoryElement;
    expect(root.textContent).toContain("Processing incomplete");
    expect(root.textContent).toContain("target write failed again");
    expect(root.querySelector(".qnalog-progress-state.is-active")).toBeNull();
    expect(root.querySelector(".qnalog-progress-pipeline-pulse")).toBeNull();
    harness.modal.onClose();
  });

  it("renders Retry all as running before its deferred queue promise resolves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
      setInterval,
      clearInterval,
      moment: (value: number | string) => ({ format: () => new Date(value).toISOString().slice(11, 19) }),
    });
    const harness = makeProgressHarness();
    const request = deferred<void>();
    harness.queueRetry.retryQueue.mockImplementation(() => {
      harness.setRunning("llm-merge", "AI organizing");
      return request.promise;
    });
    harness.modal.onOpen();
    let root = harness.modal.contentEl as never as MemoryElement;
    const retryAll = root.querySelector(".qnalog-progress-queue-head .qnalog-progress-queue-retry");
    expect(retryAll).not.toBeNull();
    const result = retryAll!.onclick!({ preventDefault() {}, stopPropagation() {} });
    root = harness.modal.contentEl as never as MemoryElement;
    expect(root.textContent).toContain("AI organizing");
    expect(root.querySelector(".qnalog-progress-pipeline-pulse")).not.toBeNull();
    request.resolve();
    await result;
    harness.modal.onClose();
  });
});
