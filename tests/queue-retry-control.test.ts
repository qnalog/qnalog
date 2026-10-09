import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { notices } = vi.hoisted(() => ({ notices: [] as Array<{ message: string; duration?: number }> }));
vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  TFile: class TFile { extension = "md"; path = ""; },
  TFolder: class TFolder {},
  Notice: class Notice { constructor(public message: string, public duration?: number) { notices.push({ message, duration }); } },
  requestUrl: vi.fn(async () => ({ status: 200, text: "{}" })),
}));

import * as obsidian from "obsidian";
import { QueueRetryService } from "../src/queue/queue-retry-service";
import { t } from "../src/shared/i18n";
import { formatLlmConfigIssue } from "../src/llm/failure-presentation";

interface TestTask {
  type?: string; status?: string; retries?: number; lastError?: unknown; mdPath?: string;
  nextRetryAt?: number; updatedAt?: string; id?: string;
}
function fixture() {
  const queue = {
    tasks: [] as TestTask[], running: false, _batchTotal: 0, _batchDone: 0,
    recoveryEntries: vi.fn(() => []), processAll: vi.fn(async () => undefined),
    processOne: vi.fn(async (_task: TestTask) => undefined),
  };
  const saveAll = vi.fn(async () => undefined);
  const requestOutlineRefresh = vi.fn();
  const notifyTaskBusyChanged = vi.fn();
  const logDiagnostic = vi.fn(async () => undefined);
  const asrPipeline = {
    getAsrServiceCircuitState: vi.fn((): { openUntilMs?: number } | null => null), isAsrServiceCircuitOpen: vi.fn(() => false),
    getAsrServiceRetryDelayMs: vi.fn(() => 7000), resetAsrServiceCircuitForManualRetry: vi.fn(),
  };
  const sessionStore = { get: vi.fn(() => null as { activeSegmentJobs?: number } | null) };
  const host = {
    queue, saveAll, requestOutlineRefresh, notifyTaskBusyChanged, diagnostics: { logDiagnostic },
    asrPipeline, sessionStore, recorder: null as { state: string } | null,
    settings: { maxRetries: 3, llmEndpoint: "https://api.example.com/v1/chat/completions", llmModel: "test-model", llmApiKey: "configured" },
    app: { vault: { getAbstractFileByPath: vi.fn() } },
  };
  return { service: new QueueRetryService(host as never), host, queue, saveAll, requestOutlineRefresh, notifyTaskBusyChanged, logDiagnostic, asrPipeline, sessionStore };
}
const mdFile = (path = "Notes/a.md") => Object.assign(new obsidian.TFile(), { path, extension: "md" });

beforeEach(() => { notices.length = 0; vi.useFakeTimers(); vi.stubGlobal("window", globalThis); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("QueueRetryService scheduled retries", () => {
  it("applies the 1000ms lower bound and reports scheduled start with task count", async () => {
    const f = fixture(); f.queue.tasks.push({ id: "a" });
    f.service.scheduleTaskQueueRetry(0, "x");
    await vi.advanceTimersByTimeAsync(999);
    expect(f.queue.processAll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.queue.processAll).toHaveBeenCalledTimes(1);
    expect(f.logDiagnostic).toHaveBeenCalledWith("info", "queue.scheduled_retry_started", t("Starting the scheduled background retry"), { reason: "x", taskCount: 1 });
  });

  it.each([[1500, 5000], [5000, 1500]])("keeps the earlier due time for %s then %s", async (first, second) => {
    const f = fixture();
    f.service.scheduleTaskQueueRetry(first, "first"); f.service.scheduleTaskQueueRetry(second, "second");
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.queue.processAll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3500);
    expect(f.queue.processAll).toHaveBeenCalledTimes(1);
  });

  it.each(["recording", "segments", "queue"]) ("retries after activity clears (%s)", async (busy) => {
    const f = fixture(); let recorderState = "idle"; let activeJobs = 0;
    f.host.recorder = { get state() { return recorderState; } } as never;
    f.sessionStore.get.mockImplementation(() => ({ activeSegmentJobs: activeJobs }));
    if (busy === "recording") recorderState = "recording";
    if (busy === "segments") activeJobs = 2;
    if (busy === "queue") f.queue.running = true;
    f.service.scheduleTaskQueueRetry(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.queue.processAll).not.toHaveBeenCalled();
    recorderState = "idle"; activeJobs = 0; f.queue.running = false;
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.queue.processAll).toHaveBeenCalledTimes(1);
  });

  it("logs rejected scheduled processing and can schedule again after dispose", async () => {
    const f = fixture(); const error = new Error("failed"); const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.queue.processAll.mockRejectedValueOnce(error);
    f.service.scheduleTaskQueueRetry(1000); f.service.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.queue.processAll).not.toHaveBeenCalled();
    f.service.scheduleTaskQueueRetry(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledWith("[QnALog] scheduled queue retry failed", error);
    f.service.dispose(); spy.mockRestore();
  });

  it("waits for the maximum session or service ASR circuit deadline", async () => {
    const f = fixture(); const now = Date.now();
    f.asrPipeline.getAsrServiceCircuitState.mockReturnValue({ openUntilMs: now + 20000 });
    f.service.scheduleDeferredAsrRetry({ hasDeferredAsrJobs: true, asrCircuitState: { openUntilMs: now + 10000 } } as never);
    await vi.advanceTimersByTimeAsync(20999);
    expect(f.queue.processAll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.queue.processAll).toHaveBeenCalledTimes(1);
    expect(f.logDiagnostic).toHaveBeenCalledWith("info", "queue.scheduled_retry_started", t("Starting the scheduled background retry"), { reason: "session-deferred-asr", taskCount: 0 });
  });
  it("uses the 1500ms deferred retry floor when neither ASR circuit is open", async () => {
    const f = fixture();
    f.service.scheduleDeferredAsrRetry({ hasDeferredAsrJobs: true });
    await vi.advanceTimersByTimeAsync(1499);
    expect(f.queue.processAll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.queue.processAll).toHaveBeenCalledOnce();
    expect(f.logDiagnostic).toHaveBeenCalledWith("info", "queue.scheduled_retry_started", t("Starting the scheduled background retry"), { reason: "session-deferred-asr", taskCount: 0 });
  });

  it("does not schedule deferred retry without deferred jobs", async () => {
    const f = fixture(); f.service.scheduleDeferredAsrRetry(null);
    f.service.scheduleDeferredAsrRetry({ hasDeferredAsrJobs: false } as never);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.queue.processAll).not.toHaveBeenCalled();
  });
});

describe("QueueRetryService retry all", () => {
  it("distinguishes an empty queue from preserved recovery entries", async () => {
    const f = fixture(); f.queue.recoveryEntries.mockReturnValueOnce([]).mockReturnValueOnce([{}] as never);
    await f.service.retryQueue(); expect(notices.at(-1)?.message).toBe(t("Queue is empty"));
    await f.service.retryQueue();
    expect(notices.at(-1)?.message).toBe(t("Recovery is paused. The original queue data and its material references are kept. Update QnALog for an unsupported task type; for damaged task data, keep a backup and use View log to share a diagnostic report with the maintainer. Related tasks stay paused until recovery data is repaired."));
    expect(f.saveAll).not.toHaveBeenCalled(); expect(f.queue.processAll).not.toHaveBeenCalled();
  });

  it("leaves blocked merge tasks unchanged while LLM configuration is missing", async () => {
    const f = fixture(); const task: TestTask = { type: "merge", status: "blocked", lastError: "config", updatedAt: "old" };
    f.queue.tasks.push(task); f.host.settings.llmEndpoint = "";
    await f.service.retryQueue();
    expect(task.status).toBe("blocked"); expect(f.saveAll).not.toHaveBeenCalled();
    expect(notices[0]).toEqual({ message: `${t("There are ")}1${t(" organizing tasks need configuration: ")}${formatLlmConfigIssue(t("LLM service address is not configured"))}`, duration: 9000 });
    expect(notices[1]?.message).toBe(t("No tasks can be retried automatically"));
  });

  it("restores blocked merge tasks when configuration is available", async () => {
    const f = fixture(); const task: TestTask = { type: "merge", status: "blocked", lastError: "unauthorized", updatedAt: "old" };
    f.queue.tasks.push(task); f.queue.processAll.mockImplementation(async () => { expect(f.saveAll).toHaveBeenCalledOnce(); f.queue.tasks = []; });
    await f.service.retryQueue();
    expect(task).toMatchObject({ status: "pending", lastError: "" }); expect(task.updatedAt).not.toBe("old");
    expect(f.saveAll).toHaveBeenCalledOnce(); expect(notices[0].message).toBe(t("Restored {0} paused organizing tasks; retrying the LLM service").replace("{0}", "1"));
  });

  it("filters non-runnable tasks, preserves transport failures beyond max retries, and clears only runnable ASR deadlines", async () => {
    const f = fixture();
    const runnable: TestTask = { type: "transcribe", status: "failed", retries: 3, lastError: { asrTransport: true }, nextRetryAt: 42 };
    const maxed: TestTask = { type: "transcribe", status: "failed", retries: 3, lastError: "bad input", nextRetryAt: 43 };
    f.queue.tasks.push(runnable, maxed, { type: "transcribe", status: "blocked" }, { type: "merge", status: "missing" }, { type: "merge", status: "running" }, { type: "merge", status: "live" });
    f.queue.processAll.mockImplementation(async () => { expect(f.saveAll).toHaveBeenCalledOnce(); f.queue.tasks = []; });
    await f.service.retryQueue();
    expect(runnable.nextRetryAt).toBeUndefined(); expect(maxed.nextRetryAt).toBe(43);
    expect(f.asrPipeline.resetAsrServiceCircuitForManualRetry).toHaveBeenCalledWith("retry-all");
    expect(f.saveAll).toHaveBeenCalledOnce(); expect(f.queue.processAll).toHaveBeenCalledOnce();
    expect(notices.map((item) => item.message)).toEqual([`${t("Retry ")}1${t(" tasks...")}`, `${t("Remaining ")}0${t(" tasks")}`]);
  });

  it("reports exhausted work and records the original null-queue rejection", async () => {
    const f = fixture(); f.queue.tasks.push({ type: "merge", status: "failed", retries: 3 });
    await f.service.retryQueue();
    expect(notices.at(-1)?.message).toContain(t("No tasks can be retried automatically"));
    expect(notices.at(-1)?.duration).toBe(9000);
    const unavailable = new QueueRetryService({ queue: null } as never);
    await expect(unavailable.retryQueue()).rejects.toThrow("Task queue is not initialized");
  });
});

describe("QueueRetryService retry from Markdown", () => {
  it("ignores non-markdown inputs and reports when no task matches", async () => {
    const f = fixture();
    await f.service.retryTranscribeTasksForMarkdown({ path: "Notes/a.md", extension: "md" });
    await f.service.retryTranscribeTasksForMarkdown(Object.assign(new obsidian.TFile(), { path: "Notes/a.txt", extension: "txt" }));
    expect(notices).toHaveLength(0); expect(f.saveAll).not.toHaveBeenCalled();
    await f.service.retryTranscribeTasksForMarkdown(mdFile());
    expect(notices.at(-1)).toEqual({ message: t("This note currently has no transcription tasks to retry."), duration: 5000 });
  });

  it("processes only errored transcription tasks while reporting batch progress", async () => {
    const f = fixture(); const a: TestTask = { type: "transcribe", mdPath: "Notes/a.md", status: "failed", lastError: "error" }; const b: TestTask = { type: "transcribe", mdPath: "Notes/a.md", status: "pending", lastError: "error" };
    f.queue.tasks.push(a, b, { type: "transcribe", mdPath: "Notes/a.md", status: "failed", lastError: "" }, { type: "merge", mdPath: "Notes/a.md", status: "failed", lastError: "error" });
    const seen: Array<[number, number]> = [];
    f.queue.processOne.mockImplementation(async () => { seen.push([f.queue._batchTotal, f.queue._batchDone]); });
    await f.service.retryTranscribeTasksForMarkdown(mdFile());
    expect(seen).toEqual([[2, 0], [2, 1]]); expect(f.queue._batchTotal).toBe(0); expect(f.queue._batchDone).toBe(0);
    expect(f.notifyTaskBusyChanged).toHaveBeenCalledTimes(4);
    expect(f.asrPipeline.resetAsrServiceCircuitForManualRetry).toHaveBeenCalledWith("note-retry");
    expect(f.saveAll).toHaveBeenCalledOnce(); expect(f.requestOutlineRefresh).toHaveBeenCalledOnce();
    expect(notices.map((item) => item.message)).toEqual([`${t("QnALog: retrying ")}2${t(" transcript segments...")}`, t("Transcription retry finished: {0} succeeded").replace("{0}", "2")]);
  });
  it("stops note retries when the ASR circuit remains open and still saves and refreshes", async () => {
    const f = fixture();
    f.queue.tasks.push({ type: "transcribe", mdPath: "Notes/a.md", status: "failed", lastError: "error" });
    f.asrPipeline.isAsrServiceCircuitOpen.mockReturnValue(true);
    await f.service.retryTranscribeTasksForMarkdown(mdFile());
    expect(f.queue.processOne).not.toHaveBeenCalled();
    expect(f.queue._batchTotal).toBe(0);
    expect(f.queue._batchDone).toBe(0);
    expect(f.notifyTaskBusyChanged).toHaveBeenCalledTimes(2);
    expect(f.saveAll).toHaveBeenCalledOnce();
    expect(f.requestOutlineRefresh).toHaveBeenCalledOnce();
    expect(notices.at(-1)?.message).toBe(t("Transcription retry finished: {0} succeeded").replace("{0}", "0"));
  });

  it("stops and schedules after transport failure, but continues after ordinary failures", async () => {
    const f = fixture(); f.queue.tasks.push(
      { type: "transcribe", mdPath: "Notes/a.md", status: "failed", lastError: "error" },
      { type: "transcribe", mdPath: "Notes/a.md", status: "failed", lastError: "error" },
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.queue.processOne.mockRejectedValueOnce({ asrTransport: true });
    await f.service.retryTranscribeTasksForMarkdown(mdFile());
    expect(f.queue.processOne).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(1);
    expect(notices.at(-1)).toEqual({ message: t("Transcription service is still unavailable: {0} succeeded and {1} failed this round; the remaining segments are kept and will continue later").replace("{0}", "0").replace("{1}", "1"), duration: 8000 });
    f.service.dispose(); notices.length = 0; f.queue.processOne.mockReset().mockRejectedValueOnce(new Error("ordinary")).mockResolvedValueOnce(undefined);
    await f.service.retryTranscribeTasksForMarkdown(mdFile());
    expect(f.queue.processOne).toHaveBeenCalledTimes(2); expect(notices.at(-1)?.message).toBe(t("Transcription retry finished: {0} succeeded, {1} failed").replace("{0}", "1").replace("{1}", "1"));
    expect(f.saveAll).toHaveBeenCalledTimes(2); expect(f.requestOutlineRefresh).toHaveBeenCalledTimes(2); spy.mockRestore();
  });
});
