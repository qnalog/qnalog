/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：可持久化任务队列：转写 / 合并 / 提示词生成

import type { LiveAsrCircuitState } from "../asr/live-segment-policy";
import * as obsidian from "obsidian";
import { isLlmNonRetryableError } from "../llm/failure-policy";

import { genId } from "../shared/util-common";

import { getNextAsrTaskRetryCount, isAsrTransportError } from "../shared/util-audio";

import { LIVE_ASR_TASK_STATUS } from "../asr/live-segment-policy";

import { diagnosticError } from "../shared/util-key-diag";

import type { QueueRecoveryEntrySummary, QueueTask, QueueTaskDeferred, QueueTaskLifecycle, QueueTaskPayload } from "../shared/types";
import { restoreQueue, type QueueRecoveryResult } from "./queue-recovery";

import { t, t as i18nT } from "../shared/i18n";
import type { TaskActivity } from "../shared/task-activity";

export interface TaskQueueHost {
  getMaxRetries(): number | undefined;
  persistQueue(): Promise<void>;
  updateBusyStatus(): void;
  retryTranscribeTask(task: Extract<QueueTask, { type: "transcribe" }>): Promise<void>;
  retryMergeTask(task: Extract<QueueTask, { type: "merge" }>): Promise<QueueTaskDeferred | void>;
  runGeneratePromptTask(task: Extract<QueueTask, { type: "generate-prompt" }>): Promise<void>;
  scheduleTaskQueueRetry(delayMs: number, reason: string): void;
  isAsrServiceCircuitOpen(): boolean;
  getAsrServiceRetryDelayMs(): number;
  getAsrServiceCircuitState(): LiveAsrCircuitState;
  recordAsrServiceAttemptSuccess(): void;
  recordAsrServiceAttemptFailure(error: unknown): LiveAsrCircuitState;
  completeTaskActivity(task: QueueTask, patch: Partial<TaskActivity>): void;
  logCompletedWork(title: string, detail: string, meter: { durationMs: number } | null): void;
  logDiagnostic(level: "warn" | "error", code: string, message: string, data: Record<string, unknown>): Promise<void>;
}

export class TaskQueue {
  declare host: TaskQueueHost;
  declare tasks: QueueTask[];
  declare running: boolean;
  declare _inflight?: Set<string>;
  declare _batchTotal: number;
  declare changeListeners: Set<() => void>;
  declare _batchDone: number;
  declare retainedRows: QueueRecoveryResult["retained"];
  declare recoveryOrder: QueueRecoveryResult["order"];
  declare recoveryView: readonly QueueRecoveryEntrySummary[];
  constructor(host: TaskQueueHost) {
    this.host = host;
    this.tasks = [];
    this.running = false;
    this.changeListeners = new Set();
    this.retainedRows = [];
    this.recoveryOrder = [];
    this.recoveryView = Object.freeze([]);
  }
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => { this.changeListeners.delete(fn); };
  }
  emitChange(): void {
    for (const fn of this.changeListeners) {
      try { fn(); } catch { /* intentionally empty */ }
    }
  }
  load(saved: unknown): void {
    const restored = restoreQueue(saved, {
      createId: genId,
      nowIso: () => new Date().toISOString(),
      getMaxRetries: () => this.host.getMaxRetries() || 3,
    });
    const recoveryView = restored.retained.map(({ summary }) => Object.freeze({
      ...summary,
      audioPaths: Object.freeze(summary.audioPaths.slice()),
    }));
    this.tasks = restored.tasks;
    this.retainedRows = restored.retained;
    this.recoveryOrder = restored.order;
    this.recoveryView = Object.freeze(recoveryView);
  }
  snapshot(): QueueTask[] { return this.tasks.slice(); }
  recoveryEntries(): readonly QueueRecoveryEntrySummary[] { return this.recoveryView; }
  persistedSnapshot(): unknown[] {
    const tasksById = new Map(this.tasks.map(task => [task.id, task]));
    const retainedByIndex = new Map(this.retainedRows.map(entry => [entry.summary.entryIndex, entry.raw]));
    const output: unknown[] = [];
    const emittedTaskIds = new Set<string>();
    const emittedRetainedIndexes = new Set<number>();
    for (const entry of this.recoveryOrder) {
      if (entry.kind === "task") {
        const task = tasksById.get(entry.id);
        if (task) { output.push(task); emittedTaskIds.add(entry.id); }
      } else if (retainedByIndex.has(entry.entryIndex)) {
        output.push(retainedByIndex.get(entry.entryIndex));
        emittedRetainedIndexes.add(entry.entryIndex);
      }
    }
    for (const task of this.tasks) if (!emittedTaskIds.has(task.id)) output.push(task);
    for (const row of this.retainedRows) if (!emittedRetainedIndexes.has(row.summary.entryIndex)) output.push(row.raw);
    return output;
  }
  findActiveGeneratePromptTask(mode: string): QueueTask | undefined {
    return this.tasks.find(t =>
      t &&
      t.type === "generate-prompt" &&
      t.mode === mode &&
      t.status !== "failed" &&
      t.status !== "missing"
    );
  }
  findDuplicateTask(task: QueueTaskPayload & Partial<QueueTaskLifecycle>): QueueTask | undefined | null {
    if (!task || !task.type) return null;
    const samePath = (a: string | null | undefined, b: string | null | undefined) => obsidian.normalizePath(String(a || "")) === obsidian.normalizePath(String(b || ""));
    if (task.type === "transcribe") {
      return this.tasks.find(t => t && t.type === "transcribe"
        && samePath(t.mdPath, task.mdPath)
        && samePath(t.audioPath, task.audioPath)
        && Number(t.segmentIndex) === Number(task.segmentIndex));
    }
    if (task.type === "merge") {
      return this.tasks.find(t => t && t.type === "merge"
        && samePath(t.mdPath, task.mdPath)
        && String(t.sessionId || "") === String(task.sessionId || ""));
    }
    if (task.type === "generate-prompt") return this.findActiveGeneratePromptTask(task.mode);
    return null;
  }
  async add(task: QueueTaskPayload & Partial<QueueTaskLifecycle>): Promise<QueueTask> {
    const existing = this.findDuplicateTask(task);
    if (existing) {
      Object.assign(existing, task, {
        id: existing.id,
        createdAt: existing.createdAt || task.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        retries: Math.max(0, Number(existing.retries) || 0),
        status: task.status || existing.status || "pending",
      });
      await this.host.persistQueue();
      this.emitChange();
      return existing;
    }
    task.id = task.id || genId();
    task.createdAt = task.createdAt || new Date().toISOString();
    task.updatedAt = new Date().toISOString();
    task.retries = task.retries || 0;
    task.status = task.status || "pending";
    const queuedTask = task as QueueTask;
    this.tasks.push(queuedTask);
    await this.host.persistQueue();
    this.emitChange();
    return queuedTask;
  }
  /**
   * 从队列移除任务。
   * opts.preserveActivity 由调用方传入以表明「保留任务活动记录」，但本方法只改队列、不碰活动记录，
   * 因此该选项目前不影响行为；保留签名以免调用方语义丢失。
   */
  async remove(id: string, opts: { preserveActivity?: boolean } = {}): Promise<void> {
    void opts;
    this.tasks = this.tasks.filter(t => t.id !== id);
    await this.host.persistQueue();
    this.emitChange();
  }
  async update(id: string, patch: Partial<QueueTask>): Promise<void> {
    const t = this.tasks.find(x => x.id === id);
    if (!t) return;
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    await this.host.persistQueue();
    this.emitChange();
  }
  async processAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const maxRetries = this.host.getMaxRetries() || 3;
      const now = Date.now();
      const isRetryDue = (task: QueueTask): boolean => {
        if (!task.nextRetryAt) return true;
        const retryAt = Date.parse(String(task.nextRetryAt));
        return !Number.isFinite(retryAt) || retryAt <= now;
      };
      const pending = this.tasks.filter(t => t.status !== "running"
        && t.status !== LIVE_ASR_TASK_STATUS
        && t.status !== "missing"
        && t.status !== "blocked"
        && !this.hasUnresolvedDependencies(t)
        && isRetryDue(t)
        && (t.retries < maxRetries || (t.type === "transcribe" && isAsrTransportError(t.lastError || ""))));
      // 批量进度游标：喂状态栏指示器，让"重试全部 / 多任务"跑到哪一目了然。
      this._batchTotal = pending.length;
      this._batchDone = 0;
      try { this.host.updateBusyStatus(); } catch { /* intentionally empty */ }
      for (const t of pending) {
        if (t.type === "transcribe" && this.host.isAsrServiceCircuitOpen()) {
          const retryDelayMs = this.host.getAsrServiceRetryDelayMs();
          this.host.scheduleTaskQueueRetry(retryDelayMs, "asr-service-circuit-open");
          continue;
        }
        let transportAsrFailure = null;
        await this.processOne(t).catch((e) => {
          console.error("[QnALog] queue task failed", e);
          if (t && t.type === "transcribe" && isAsrTransportError(e)) transportAsrFailure = e;
        });
        this._batchDone++;
        try { this.host.updateBusyStatus(); } catch { /* intentionally empty */ }
        if (transportAsrFailure) {
          // 服务仍在限流/超时，继续扫后续音频只会扩大请求风暴。暂停整批，冷却后从持久化队列续跑。
          const retryDelayMs = this.host.getAsrServiceRetryDelayMs();
          try {
            await this.host.logDiagnostic("warn", "queue.asr_circuit_opened", i18nT("Background transcription hit a transient fault while processing; the batch was paused"), {
              remaining: Math.max(0, pending.length - this._batchDone),
              cooldownMs: retryDelayMs,
              consecutiveFailures: this.host.getAsrServiceCircuitState().consecutiveFailures,
              error: diagnosticError(transportAsrFailure),
            });
          } catch { /* intentionally empty */ }
          if (typeof this.host.scheduleTaskQueueRetry === "function") {
            this.host.scheduleTaskQueueRetry(retryDelayMs, "transient-asr-failure");
          }
          break;
        }
      }
    } finally {
      this.running = false;
      this._batchTotal = 0;
      this._batchDone = 0;
      try { this.host.updateBusyStatus(); } catch { /* intentionally empty */ }
    }
  }
  private hasUnresolvedDependencies(task: QueueTask): boolean {
    if (task.status === LIVE_ASR_TASK_STATUS) return true;
    const dependencies = Array.isArray(task.dependsOnSessionIds) ? task.dependsOnSessionIds : [];
    const retained = this.recoveryView;
    if (dependencies.some(sessionId => this.tasks.some(candidate =>
      candidate.type !== "generate-prompt" && candidate.sessionId === sessionId,
    ) || retained.some(entry => entry.taskType !== "generate-prompt" && entry.sessionId === sessionId))) return true;
    return task.type === "merge"
      && (this.tasks.some(candidate => candidate.type === "transcribe" && candidate.sessionId === task.sessionId)
        || retained.some(entry => entry.taskType !== "generate-prompt" && entry.sessionId === task.sessionId));
  }

  async processOne(task: QueueTask): Promise<void> {
    if (!task || !task.id) return;
    // Re-resolve by id: callers may retain a stale row after it was removed or replaced.
    const queuedTask = this.tasks.find(candidate => candidate.id === task.id);
    if (!queuedTask || this.hasUnresolvedDependencies(queuedTask)) return;
    task = queuedTask;
    // per-task 在途锁：processAll / 手动逐篇重试 / 队列面板逐条重试 / 启动自动重试 多条入口可能选中同一任务，
    // 若并发进入会对同一段音频发两次 ASR = 重复扣费。这个内存级 Set 同步闭合"选中→标 running"的竞态窗口。
    if (!this._inflight) this._inflight = new Set();
    if (this._inflight.has(task.id)) return;
    this._inflight.add(task.id);
    const startedAt = Date.now(); // 记录任务开始时间，完成时算时长
    try {
    // Recheck after acquiring the per-task lock, before mutating persisted state.
    const stillQueued = this.tasks.find(candidate => candidate.id === task.id);
    if (!stillQueued || this.hasUnresolvedDependencies(stillQueued)) return;
    task = stillQueued;
    await this.update(task.id, {
      status: "running",
      lastError: "",
      startedAt: new Date(startedAt).toISOString(),
      lastEventAt: new Date(startedAt).toISOString(),
      attempt: Math.max(1, (Number(task.retries) || 0) + 1),
    });
    try {
      let deferred: QueueTaskDeferred | void = undefined;
      if (task.type === "transcribe") {
        await this.host.retryTranscribeTask(task);
        this.host.recordAsrServiceAttemptSuccess();
      }
      else if (task.type === "merge") deferred = await this.host.retryMergeTask(task);
      else if (task.type === "generate-prompt") await this.host.runGeneratePromptTask(task);
      else throw new Error(t("Unknown task type: {0}").replace("{0}", String((task as QueueTask).type)));

      if (deferred && deferred.deferred === true) {
        await this.update(task.id, {
          status: deferred.status || "pending",
          lastError: deferred.reason,
          lastEventAt: new Date().toISOString(),
        });
        return;
      }
      try {
        this.host.completeTaskActivity(task, {
          stage: "done",
          stageLabel: task.type === "transcribe" ? t("Segment transcription complete")
            : task.type === "merge" ? t("AI organizing complete")
              : task.type === "generate-prompt" ? t("Prompt generation complete") : t("Task complete"),
          detail: String(task.mdPath || ""),
          actions: task.mdPath
            ? [{ id: "open-task-note", label: t("Open note"), primary: true }, { id: "dismiss-task", label: t("Close Recording") }]
            : [{ id: "dismiss-task", label: t("Close Recording") }],
        });
      } catch { /* task mirror must not block completion */ }
      await this.remove(task.id, { preserveActivity: true });
      try {
        const doneLabel = task.type === "transcribe" ? t("Transcription complete · segment {0}").replace("{0}", String((task.segmentIndex || 0) + 1))
          : task.type === "merge" ? t("AI organizing complete")
          : task.type === "generate-prompt" ? t("Prompt generation complete") : t("Task complete");
        const durationMs = Math.max(0, Date.now() - startedAt);
        this.host.logCompletedWork(doneLabel, task.mdPath || "", durationMs > 0 ? { durationMs } : null);
      } catch { /* intentionally empty */ }
    } catch (e) {
      const message = (e && e.message) || String(e);
      const isMissingAudio = task.type === "transcribe" && /音频不存在|临时切片不存在|Audio missing|Temporary clip missing/.test(message);
      const isBlockedMerge = task.type === "merge" && isLlmNonRetryableError(e);
      const isTransportAsr = task.type === "transcribe" && isAsrTransportError(e);
      const maxR = (this.host.getMaxRetries() || 3);
      const nextRetries = isBlockedMerge ? (task.retries || 0)
        : task.type === "transcribe" ? getNextAsrTaskRetryCount(task.retries, maxR, e)
        : (task.retries || 0) + 1;
      const serviceCircuit = isTransportAsr ? this.host.recordAsrServiceAttemptFailure(e) : null;
      const nextRetryAt = serviceCircuit && serviceCircuit.openUntilMs > Date.now()
        ? new Date(serviceCircuit.openUntilMs).toISOString()
        : undefined;
      await this.update(task.id, {
        status: isMissingAudio ? "missing" : isBlockedMerge ? "blocked" : isTransportAsr ? "pending" : "failed",
        retries: nextRetries,
        transportFailures: isTransportAsr ? Math.max(0, Number(task.transportFailures) || 0) + 1 : task.transportFailures,
        nextRetryAt,
        deferredReason: isTransportAsr ? "service-unavailable" : ("deferredReason" in task ? task.deferredReason : undefined),
        lastError: message,
        lastEventAt: new Date().toISOString(),
      });
      await this.host.logDiagnostic("error", "queue.task_failed", t("Queue task failed"), {
        taskType: task.type,
        retries: nextRetries,
        transportFailures: isTransportAsr ? Math.max(0, Number(task.transportFailures) || 0) + 1 : 0,
        nextRetryAt: nextRetryAt || "",
        maxRetries: this.host.getMaxRetries() || 3,
        mdPath: task.mdPath || "",
        audioPath: "audioPath" in task ? task.audioPath || "" : "",
        mode: task.mode || "",
        error: diagnosticError(e),
      });
      throw e;
    }
    } finally {
      this._inflight.delete(task.id);
    }
  }
  hasPendingGeneratePrompt(): boolean {
    return this.tasks.some(t => t && t.type === "generate-prompt" && t.status !== "failed");
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
