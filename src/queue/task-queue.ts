/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：可持久化任务队列：转写 / 合并 / 提示词生成

import type QnALogPlugin from "../main";
import * as obsidian from "obsidian";
import { isLlmNonRetryableError } from "../llm/core";

import { genId } from "../shared/util-common";

import { getAsrTransportTaskRecoveryPatch, getNextAsrTaskRetryCount, isAsrTransportError } from "../shared/util-audio";

import { LIVE_ASR_TASK_STATUS } from "../asr/live-segment-policy";

import { diagnosticError } from "../shared/util-key-diag";

import type { QueueTask, QueueTaskDeferred } from "../shared/types";

import { t, t as i18nT } from "../shared/i18n";
export class TaskQueue {
  declare plugin: QnALogPlugin;
  declare tasks: QueueTask[];
  declare running: boolean;
  declare _inflight?: Set<string>;
  declare _batchTotal: number;
  declare changeListeners: Set<() => void>;
  declare _batchDone: number;
  constructor(plugin: QnALogPlugin) {
    this.plugin = plugin;
    this.tasks = [];
    this.running = false;
    this.changeListeners = new Set();
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
  load(saved: unknown) {
    const raw = Array.isArray(saved) ? saved.slice() : [];
    this.tasks = raw
      .filter(t => t && typeof t === "object" && t.type)
      .map(t => {
        const task = Object.assign({}, t);
        task.id = task.id || genId();
        task.retries = Math.max(0, Number(task.retries) || 0);
        task.createdAt = task.createdAt || new Date().toISOString();
        task.updatedAt = task.updatedAt || task.createdAt;
        if (task.status === "running" || task.status === "processing" || task.status === LIVE_ASR_TASK_STATUS) {
          task.status = "pending";
          task.lastError = task.lastError || i18nT("Interrupted during the last run; restored to pending");
        }
        const invalidDependencies = task.dependsOnSessionIds !== undefined
          && (!Array.isArray(task.dependsOnSessionIds)
            || task.dependsOnSessionIds.some(id => typeof id !== "string" || !id.trim()));
        if (task.dependsOnSessionIds !== undefined) {
          task.dependsOnSessionIds = Array.isArray(task.dependsOnSessionIds)
            ? task.dependsOnSessionIds.filter(id => typeof id === "string" && id.trim())
            : [];
        }
        if (task.type === "merge" && task.continuation !== undefined) {
          const continuation = task.continuation;
          const validContinuation = !invalidDependencies && typeof task.sessionId === "string" && task.sessionId.trim().length > 0
            && continuation && typeof continuation === "object"
            && typeof continuation.targetPath === "string" && continuation.targetPath.trim().length > 0
            && typeof continuation.targetSourceId === "string" && continuation.targetSourceId.trim().length > 0
            && typeof continuation.recordedAt === "string" && Number.isFinite(Date.parse(continuation.recordedAt))
            && (continuation.realtimeOutline === undefined || typeof continuation.realtimeOutline === "string")
            && (continuation.masterAudioPath === undefined || typeof continuation.masterAudioPath === "string")
            && (continuation.masterAudioName === undefined || typeof continuation.masterAudioName === "string");
          if (!validContinuation) {
            task.status = "blocked";
            task.lastError = i18nT("Continuation recovery information is invalid; the separately recorded audio was kept.");
          }
        }
        if (!["pending", "failed", "missing", "processing", "blocked"].includes(task.status)) task.status = "pending";
        const maxRetries = (this.plugin && this.plugin.settings && this.plugin.settings.maxRetries) || 3;
        if (task.type === "transcribe"
          && task.status === "failed"
          && task.retries >= maxRetries
          && /音频不存在|Audio missing/.test(String(task.lastError || ""))) {
          task.status = "pending";
          task.retries = Math.max(0, maxRetries - 1);
          task.lastError = i18nT("Temporary clip missing; upgraded to recover the clip from the full recording and retry");
        }
        const transportRecoveryPatch = getAsrTransportTaskRecoveryPatch(task, maxRetries);
        if (transportRecoveryPatch) {
          // 网络/服务中断属于服务级故障，不应让某一个音频片段永久耗尽重试额度。
          // 保留音频并恢复为 pending，等待共享熔断器允许下一次探测。
          Object.assign(task, transportRecoveryPatch);
        }
        if (task.type === "merge"
          && task.status === "failed"
          && isLlmNonRetryableError(task.lastError || "")) {
          task.status = "blocked";
          task.lastError = task.lastError || i18nT("LLM unavailable; waiting for you to resolve it before retrying");
        }
        if (task.type === "merge"
          && task.status === "failed"
          && task.retries >= maxRetries
          && !isLlmNonRetryableError(task.lastError || "")
          && /Failed to fetch|LLM 调用超时|LLM request timed out|429|500|502|503|504/.test(String(task.lastError || ""))) {
          task.status = "pending";
          task.retries = Math.max(0, maxRetries - 1);
          task.lastError = i18nT("The last organizing attempt looks like a transient network or server failure; upgraded to retryable");
        }
        return task;
      });
  }
  snapshot() { return this.tasks.slice(); }
  findActiveGeneratePromptTask(mode) {
    return this.tasks.find(t =>
      t &&
      t.type === "generate-prompt" &&
      t.mode === mode &&
      t.status !== "failed" &&
      t.status !== "missing"
    );
  }
  findDuplicateTask(task) {
    if (!task || !task.type) return null;
    const samePath = (a, b) => obsidian.normalizePath(String(a || "")) === obsidian.normalizePath(String(b || ""));
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
  async add(task) {
    const existing = this.findDuplicateTask(task);
    if (existing) {
      Object.assign(existing, task, {
        id: existing.id,
        createdAt: existing.createdAt || task.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        retries: Math.max(0, Number(existing.retries) || 0),
        status: task.status || existing.status || "pending",
      });
      await this.plugin.saveAll();
      this.emitChange();
      return existing;
    }
    task.id = task.id || genId();
    task.createdAt = task.createdAt || new Date().toISOString();
    task.updatedAt = new Date().toISOString();
    task.retries = task.retries || 0;
    task.status = task.status || "pending";
    this.tasks.push(task);
    await this.plugin.saveAll();
    this.emitChange();
    return task;
  }
  /**
   * 从队列移除任务。
   * opts.preserveActivity 由调用方传入以表明「保留任务活动记录」，但本方法只改队列、不碰活动记录，
   * 因此该选项目前不影响行为；保留签名以免调用方语义丢失。
   */
  async remove(id, opts: { preserveActivity?: boolean } = {}) {
    void opts;
    this.tasks = this.tasks.filter(t => t.id !== id);
    await this.plugin.saveAll();
    this.emitChange();
  }
  async update(id, patch) {
    const t = this.tasks.find(x => x.id === id);
    if (!t) return;
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    await this.plugin.saveAll();
    this.emitChange();
  }
  async processAll() {
    if (this.running) return;
    this.running = true;
    try {
      const maxRetries = this.plugin.settings.maxRetries || 3;
      const now = Date.now();
      const isRetryDue = (task) => {
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
      try { this.plugin.tasks.updateBusyStatus(); } catch { /* intentionally empty */ }
      for (const t of pending) {
        if (t.type === "transcribe" && this.plugin.asrPipeline.isAsrServiceCircuitOpen()) {
          const retryDelayMs = this.plugin.asrPipeline.getAsrServiceRetryDelayMs();
          this.plugin.queueRetry.scheduleTaskQueueRetry(retryDelayMs, "asr-service-circuit-open");
          continue;
        }
        let transportAsrFailure = null;
        await this.processOne(t).catch((e) => {
          console.error("[QnALog] queue task failed", e);
          if (t && t.type === "transcribe" && isAsrTransportError(e)) transportAsrFailure = e;
        });
        this._batchDone++;
        try { this.plugin.tasks.updateBusyStatus(); } catch { /* intentionally empty */ }
        if (transportAsrFailure) {
          // 服务仍在限流/超时，继续扫后续音频只会扩大请求风暴。暂停整批，冷却后从持久化队列续跑。
          const retryDelayMs = this.plugin.asrPipeline.getAsrServiceRetryDelayMs();
          try {
            await this.plugin.diagnostics.logDiagnostic("warn", "queue.asr_circuit_opened", i18nT("Background transcription hit a transient fault while processing; the batch was paused"), {
              remaining: Math.max(0, pending.length - this._batchDone),
              cooldownMs: retryDelayMs,
              consecutiveFailures: this.plugin.asrPipeline.getAsrServiceCircuitState().consecutiveFailures,
              error: diagnosticError(transportAsrFailure),
            });
          } catch { /* intentionally empty */ }
          if (this.plugin && typeof this.plugin.queueRetry.scheduleTaskQueueRetry === "function") {
            this.plugin.queueRetry.scheduleTaskQueueRetry(retryDelayMs, "transient-asr-failure");
          }
          break;
        }
      }
    } finally {
      this.running = false;
      this._batchTotal = 0;
      this._batchDone = 0;
      try { this.plugin.tasks.updateBusyStatus(); } catch { /* intentionally empty */ }
    }
  }
  private hasUnresolvedDependencies(task: QueueTask): boolean {
    if (task.status === LIVE_ASR_TASK_STATUS) return true;
    const dependencies = Array.isArray(task.dependsOnSessionIds) ? task.dependsOnSessionIds : [];
    if (dependencies.some(sessionId => this.tasks.some(candidate =>
      candidate.type !== "generate-prompt" && candidate.sessionId === sessionId,
    ))) return true;
    return task.type === "merge"
      && this.tasks.some(candidate => candidate.type === "transcribe" && candidate.sessionId === task.sessionId);
  }

  async processOne(task: QueueTask) {
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
      let deferred: QueueTaskDeferred | void;
      if (task.type === "transcribe") {
        await this.plugin.queueRetry.retryTranscribeTask(task);
        this.plugin.asrPipeline.recordAsrServiceAttemptSuccess();
      }
      else if (task.type === "merge") deferred = await this.plugin.queueRetry.retryMergeTask(task);
      else if (task.type === "generate-prompt") await this.plugin.queueRetry.runGeneratePromptTask(task);
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
        this.plugin.tasks.completeTaskActivity(this.plugin.tasks.queueTaskActivityId(task), {
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
        this.plugin.tasks.logCompletedWork(doneLabel, task.mdPath || "", durationMs > 0 ? { durationMs } : null);
      } catch { /* intentionally empty */ }
    } catch (e) {
      const message = (e && e.message) || String(e);
      const isMissingAudio = task.type === "transcribe" && /音频不存在|临时切片不存在|Audio missing|Temporary clip missing/.test(message);
      const isBlockedMerge = task.type === "merge" && isLlmNonRetryableError(e);
      const isTransportAsr = task.type === "transcribe" && isAsrTransportError(e);
      const maxR = (this.plugin.settings && this.plugin.settings.maxRetries) || 3;
      const nextRetries = isBlockedMerge ? (task.retries || 0)
        : task.type === "transcribe" ? getNextAsrTaskRetryCount(task.retries, maxR, e)
        : (task.retries || 0) + 1;
      const serviceCircuit = isTransportAsr ? this.plugin.asrPipeline.recordAsrServiceAttemptFailure(e) : null;
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
      await this.plugin.diagnostics.logDiagnostic("error", "queue.task_failed", t("Queue task failed"), {
        taskType: task.type,
        retries: nextRetries,
        transportFailures: isTransportAsr ? Math.max(0, Number(task.transportFailures) || 0) + 1 : 0,
        nextRetryAt: nextRetryAt || "",
        maxRetries: this.plugin.settings.maxRetries || 3,
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
  hasPendingGeneratePrompt() {
    return this.tasks.some(t => t && t.type === "generate-prompt" && t.status !== "failed");
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
