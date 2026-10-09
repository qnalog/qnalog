import * as obsidian from "obsidian";
import { LIVE_ASR_TASK_STATUS } from "../asr/live-segment-policy";
import { formatLlmConfigIssue } from "../llm/failure-presentation";
import { isLlmServiceBlockedError } from "../llm/failure-policy";
import { t } from "../shared/i18n";
import type { QueueTask } from "../shared/types";
import { isAsrTransportError } from "../shared/util-audio";
import type { TaskQueue } from "./task-queue";

export type QueueRetryControlQueue = Pick<TaskQueue, "tasks" | "running" | "_batchTotal" | "_batchDone" | "recoveryEntries" | "processAll" | "processOne">;

export interface QueueRetryControlSession {
  activeSegmentJobs?: number;
  hasDeferredAsrJobs?: boolean;
  asrCircuitState?: { openUntilMs?: number };
}

export interface QueueRetryControlPort {
  getQueue(): QueueRetryControlQueue | null;
  getRecorderState(): string | null;
  getSession(): QueueRetryControlSession | null;
  getMaxRetries(): number | undefined;
  getLlmConfigIssue(): string;
  getTranscribeTasksForMarkdown(file: obsidian.TFile): QueueTask[];
  logDiagnostic(level: "info", code: string, message: string, data: Record<string, unknown>): Promise<void>;
  saveAll(): Promise<void>;
  requestOutlineRefresh(): void;
  notifyTaskBusyChanged(): void;
  asr: {
    getCircuitState(): { openUntilMs?: number } | null;
    isCircuitOpen(): boolean;
    getRetryDelayMs(): number;
    resetForManualRetry(source: string): void;
  };
}

export class QueueRetryControl {
  declare private readonly port: QueueRetryControlPort;
  declare private timer: number | null;
  declare private runAt: number;

  constructor(port: QueueRetryControlPort) {
    this.port = port;
    this.timer = null;
    this.runAt = 0;
  }

  dispose(): void {
    try { if (this.timer) window.clearTimeout(this.timer); } catch { /* intentionally empty */ }
    this.timer = null;
    this.runAt = 0;
  }

  schedule(delayMs = 1500, reason = "scheduled"): void {
    const delay = Math.max(1000, Number(delayMs) || 0);
    const newRunAt = Date.now() + delay;
    if (this.timer && Number(this.runAt) <= newRunAt) return;
    if (this.timer) window.clearTimeout(this.timer);
    this.runAt = newRunAt;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.runAt = 0;
      const session = this.port.getSession();
      const recorderState = this.port.getRecorderState();
      const recorderBusy = recorderState !== null && recorderState !== "idle";
      const segmentBusy = session && Number(session.activeSegmentJobs || 0) > 0;
      const queue = this.port.getQueue();
      const queueBusy = queue && queue.running;
      if (recorderBusy || segmentBusy || queueBusy) {
        this.schedule(30 * 1000, "activity-still-busy");
        return;
      }
      void this.port.logDiagnostic("info", "queue.scheduled_retry_started", t("Starting the scheduled background retry"), {
        reason,
        taskCount: queue && Array.isArray(queue.tasks) ? queue.tasks.length : 0,
      });
      const processing = queue
        ? queue.processAll()
        : Promise.reject(new Error("Task queue is not initialized"));
      void processing.catch((e) => console.error("[QnALog] scheduled queue retry failed", e));
    }, delay);
  }

  scheduleDeferredAsr(session: QueueRetryControlSession | null): void {
    if (!session || !session.hasDeferredAsrJobs) return;
    const serviceCircuit = this.port.asr.getCircuitState();
    const openUntilMs = Math.max(
      0,
      Number(session.asrCircuitState && session.asrCircuitState.openUntilMs) || 0,
      Number(serviceCircuit && serviceCircuit.openUntilMs) || 0,
    );
    const delayMs = Math.max(1500, openUntilMs > Date.now() ? openUntilMs - Date.now() + 1000 : 0);
    this.schedule(delayMs, "session-deferred-asr");
  }

  async retryAll(): Promise<void> {
    const queue = this.port.getQueue();
    if (!queue) throw new Error("Task queue is not initialized");
    if (!queue.tasks.length) {
      new obsidian.Notice(queue.recoveryEntries().length
        ? t("Recovery is paused. The original queue data and its material references are kept. Update QnALog for an unsupported task type; for damaged task data, keep a backup and use View log to share a diagnostic report with the maintainer. Related tasks stay paused until recovery data is repaired.")
        : t("Queue is empty"));
      return;
    }
    const blockedMergeTasks = queue.tasks.filter((task) => task && task.type === "merge" && task.status === "blocked");
    if (blockedMergeTasks.length) {
      const llmIssue = this.port.getLlmConfigIssue();
      if (llmIssue) {
        new obsidian.Notice(`${t("There are ")}${blockedMergeTasks.length}${t(" organizing tasks need configuration: ")}${formatLlmConfigIssue(llmIssue)}`, 9000);
      } else {
        const serviceBlocked = blockedMergeTasks.find((task) => isLlmServiceBlockedError(task.lastError || ""));
        for (const task of blockedMergeTasks) {
          task.status = "pending";
          task.lastError = "";
          task.updatedAt = new Date().toISOString();
        }
        await this.port.saveAll();
        new obsidian.Notice(serviceBlocked
          ? t("Restored {0} paused organizing tasks; retrying the LLM service").replace("{0}", String(blockedMergeTasks.length))
          : t("Restored {0} organizing tasks that need configuration").replace("{0}", String(blockedMergeTasks.length)));
      }
    }
    const maxRetries = this.port.getMaxRetries() || 3;
    const runnable = queue.tasks.filter((task) => task
      && task.status !== "blocked" && task.status !== "missing" && task.status !== "running" && task.status !== LIVE_ASR_TASK_STATUS
      && ((Number(task.retries) || 0) < maxRetries || (task.type === "transcribe" && isAsrTransportError(task.lastError || ""))));
    if (!runnable.length) {
      const missingCount = queue.tasks.filter((task) => task && task.status === "missing").length;
      const exhaustedCount = queue.tasks.filter((task) => task && task.status === "failed" && (Number(task.retries) || 0) >= maxRetries).length;
      const hints: string[] = [];
      if (missingCount) hints.push(t("{0} temporary clips missing").replace("{0}", String(missingCount)));
      if (exhaustedCount) hints.push(t("{0} have reached the retry limit — if the configuration is fixed (e.g. API key added or transcription service switched), right-click the note and choose \"Retry failed transcription\", or retry them one by one in the queue panel").replace("{0}", String(exhaustedCount)));
      new obsidian.Notice(hints.length ? t("No tasks can be retried automatically ({0})").replace("{0}", hints.join(t(";"))) : t("No tasks can be retried automatically"), hints.length ? 9000 : 4000);
      return;
    }
    if (runnable.some((task) => task.type === "transcribe")) {
      this.port.asr.resetForManualRetry("retry-all");
      for (const task of runnable) {
        if (task.type === "transcribe") task.nextRetryAt = undefined;
      }
      await this.port.saveAll();
    }
    new obsidian.Notice(`${t("Retry ")}${runnable.length}${t(" tasks...")}`);
    await queue.processAll();
    new obsidian.Notice(`${t("Remaining ")}${queue.tasks.length}${t(" tasks")}`);
  }

  async retryTranscribeForMarkdown(file: unknown): Promise<void> {
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") return;
    const queue = this.port.getQueue();
    if (!queue) throw new Error("Task queue is not initialized");
    const tasks = this.port.getTranscribeTasksForMarkdown(file)
      .filter((task) => ["failed", "missing", "pending"].includes(task.status || "pending") && !!task.lastError);
    if (!tasks.length) {
      new obsidian.Notice(t("This note currently has no transcription tasks to retry."), 5000);
      return;
    }
    new obsidian.Notice(`${t("QnALog: retrying ")}${tasks.length}${t(" transcript segments...")}`);
    let succeeded = 0;
    let failed = 0;
    let paused = false;
    const batch = tasks.slice();
    queue._batchTotal = batch.length;
    queue._batchDone = 0;
    this.port.notifyTaskBusyChanged();
    this.port.asr.resetForManualRetry("note-retry");
    try {
      for (const task of batch) {
        if (this.port.asr.isCircuitOpen()) break;
        try {
          await queue.processOne(task);
          succeeded++;
        } catch (error) {
          failed++;
          console.error("[QnALog] retry transcribe task from note list failed", error);
          if (isAsrTransportError(error)) {
            this.schedule(this.port.asr.getRetryDelayMs(), "note-retry-transport-failure");
            paused = true;
          }
        }
        queue._batchDone++;
        this.port.notifyTaskBusyChanged();
        if (paused) break;
      }
    } finally {
      queue._batchTotal = 0;
      queue._batchDone = 0;
      this.port.notifyTaskBusyChanged();
    }
    await this.port.saveAll();
    this.port.requestOutlineRefresh();
    new obsidian.Notice(paused
      ? t("Transcription service is still unavailable: {0} succeeded and {1} failed this round; the remaining segments are kept and will continue later").replace("{0}", String(succeeded)).replace("{1}", String(failed))
      : failed
        ? t("Transcription retry finished: {0} succeeded, {1} failed").replace("{0}", String(succeeded)).replace("{1}", String(failed))
        : t("Transcription retry finished: {0} succeeded").replace("{0}", String(succeeded)), 8000);
  }
}
