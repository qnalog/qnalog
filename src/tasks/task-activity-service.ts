/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// @ts-nocheck
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：界面任务状态：任务计量、状态栏与进度、导入进度、任务动作分发

import * as obsidian from "obsidian";
import { getModeMeta } from "../shared/mode-meta";
import type { LexVoiceSettings, RecordingSession } from "../shared/types";
import { formatElapsed } from "../shared/util-common";
import { isAsrTransportError } from "../shared/util-audio";
import { LIVE_ASR_TASK_STATUS } from "../asr/live-segment-policy";
import { diagnosticError } from "../shared/util-key-diag";
import { appendActivityEvent, buildAudioImportStages, classifyActivityRequest, getDominantActivityLiveness, normalizeAudioImportStage, summarizeActivityRequests, upsertActivityRequest } from "../shared/activity-progress";
import { getTaskErrorHint, getTaskErrorMessage } from "../shared/task-activity";
import { RecorderService } from "../audio/recorder-service";
import { TaskQueue } from "../queue/task-queue";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { QueueRetryService } from "../queue/queue-retry-service";
import { RealtimeOutlineService } from "../notes/realtime-outline-service";
import { TaskActivityStore } from "../shared/task-activity";
import { QueueModal } from "../ui/modals";

/** TaskActivityService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface TaskActivityHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  /** 状态栏元素：常驻显示队列与转写进度。 */
  addStatusBarItem(): HTMLElement;
  /** 交给插件在卸载时统一清理。 */
  register(cleanup: () => void): void;
  /** 注册需要随插件卸载清理的定时器。 */
  registerInterval(id: number): number;
  diagnostics: DiagnosticsService;
  getAsrServiceRetryDelayMs(): number;
  openSettings(tabId?: string): void;
  queue: TaskQueue | null;
  /** 队列失败恢复服务：熔断冷却结束后重新排期。 */
  queueRetry: QueueRetryService;
  recorder: RecorderService | null;
  refreshOutlineView(): void;
  resetAsrServiceCircuitForManualRetry(source?: string): unknown;
  session: RecordingSession | null;
  /** 实时大纲服务：用户取消等待与后台补跑。 */
  outline: RealtimeOutlineService;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: LexVoiceSettings;
}

export class TaskActivityService {
  declare host: TaskActivityHost;
  declare taskActivityStore;
  declare completedWorkLog;
  declare _taskMeter;
  declare _importBusy;
  declare _busyLabel;
  declare _busyContext;
  declare progressStatusEl;

  constructor(host) {
    this.host = host;
  }

  /** 建立任务状态存储与观察者；由插件在 onload 中调用。 */
  start() {
    this.taskActivityStore = new TaskActivityStore();
    this.host.register(this.taskActivityStore.subscribe(() => {
      try { this.updateBusyStatus(); } catch { /* task observers must not break work */ }
      try { this.host.refreshOutlineView(); } catch { /* task observers must not break work */ }
    }));
    this.host.registerInterval(window.setInterval(() => {
      try { this.taskActivityStore.prune(); } catch { /* maintenance must not break plugin */ }
      try { this.updateBusyStatus(); } catch { /* intentionally empty */ }
    }, 15_000));
  }

  /** 建立状态栏与本次启动的进度状态；由插件在 onload 中调用（晚于录音器与队列的建立）。 */
  startStatusBar() {
    // 转写进度状态栏：常驻、一眼可见队列/转写跑到哪——消解"点了转写就黑盒"的焦虑。点击打开队列。
    this._importBusy = null;
    this._busyLabel = null;
    this._busyContext = null;
    this.completedWorkLog = []; // 本次启动 OB 后已完成的处理（不持久化，重启清零），供"处理进度"面板展示
    this._taskMeter = null; // 单任务 token 计量窗口（beginTaskMeter→endTaskMeter）
    this.progressStatusEl = this.host.addStatusBarItem();
    this.progressStatusEl.addClass("lexvoice-statusbar");
    this.progressStatusEl.addEventListener("click", () => new QueueModal(this.host.app, this.host).open());
    this.updateBusyStatus();
  }

  getTaskActivities(options = {}) {
    return this.taskActivityStore
      ? this.taskActivityStore.list(Object.assign({ includeDone: true, includeCancelled: true }, options || {}))
      : [];
  }
  getTaskActivityErrorHint(activity) {
    const raw = getTaskErrorMessage(activity && activity.error, "");
    if (/file already exists|文件已存在|already exists/i.test(raw)) {
      return "目标版本文件已存在。已保留原始转写，重新整理不会覆盖原始材料。";
    }
    return getTaskErrorHint(activity && activity.errorKind ? activity.errorKind : "");
  }
  startTaskActivity(input) {
    if (!this.taskActivityStore || !input || !input.id) return null;
    const activity = this.taskActivityStore.start(input);
    this.taskActivityStore.event(activity.id, {
      type: "start",
      label: input.stageLabel || input.detail || "任务已开始",
    });
    return activity;
  }
  async runTaskActivity(input, executor, completion = {}) {
    if (!input || !input.id || typeof executor !== "function") {
      throw new Error("任务定义不完整");
    }
    const taskId = String(input.id);
    this.startTaskActivity(input);
    const controls = {
      patch: (patch = {}) => this.patchTaskActivity(taskId, patch),
      event: (label, detail = "", type = "update") => {
        if (!this.taskActivityStore) return null;
        return this.taskActivityStore.event(taskId, { type, label, detail });
      },
    };
    try {
      const result = await executor(controls);
      const current = this.taskActivityStore && this.taskActivityStore.get(taskId);
      if (current && !["done", "failed", "cancelled"].includes(current.status)) {
        const successPatch = Object.assign({}, completion);
        delete successPatch.failureLabel;
        delete successPatch.failureActions;
        this.completeTaskActivity(taskId, successPatch);
      }
      return result;
    } catch (error) {
      const current = this.taskActivityStore && this.taskActivityStore.get(taskId);
      if (!current || current.status !== "cancelled") {
        this.failTaskActivity(taskId, error, {
          stage: "failed",
          stageLabel: completion.failureLabel || "任务未完成",
          detail: getTaskErrorMessage(error),
          actions: completion.failureActions || input.actions || [],
        });
      }
      throw error;
    }
  }
  patchTaskActivity(id, patch = {}) {
    if (!this.taskActivityStore || !id) return null;
    const current = this.taskActivityStore.get(id);
    if (!current) return this.startTaskActivity(Object.assign({ id }, patch));
    return this.taskActivityStore.heartbeat(id, patch);
  }
  failTaskActivity(id, error, patch = {}) {
    if (!this.taskActivityStore || !id) return null;
    const message = getTaskErrorMessage(error);
    let current = this.taskActivityStore.get(id);
    if (!current) {
      current = this.startTaskActivity(Object.assign({
        id,
        title: "后台任务",
        status: "running",
      }, patch));
    }
    const failed = this.taskActivityStore.fail(id, error, patch);
    this.taskActivityStore.event(id, {
      type: "error",
      label: patch.stageLabel || "任务失败",
      detail: message,
    });
    return failed;
  }
  completeTaskActivity(id, patch = {}) {
    if (!this.taskActivityStore || !id) return null;
    const current = this.taskActivityStore.get(id);
    if (!current) return null;
    const completed = this.taskActivityStore.complete(id, patch);
    this.taskActivityStore.event(id, {
      type: "complete",
      label: patch.stageLabel || "任务已完成",
      detail: patch.detail || "",
    });
    return completed;
  }
  cancelTaskActivity(id, detail = "任务已取消") {
    if (!this.taskActivityStore || !id) return null;
    const current = this.taskActivityStore.get(id);
    if (!current) return null;
    const cancelled = this.taskActivityStore.cancel(id, detail);
    this.taskActivityStore.event(id, {
      type: "cancel",
      label: "任务已取消",
      detail,
    });
    return cancelled;
  }
  queueTaskActivityId(taskOrId) {
    const id = typeof taskOrId === "string" ? taskOrId : taskOrId && taskOrId.id;
    return id ? `queue:${id}` : "";
  }
  syncQueueTaskActivity(task) {
    if (!task || !task.id || !this.taskActivityStore) return null;
    const id = this.queueTaskActivityId(task);
    const type = String(task.type || "");
    const title = type === "transcribe"
      ? (task.wholeFileImport
        ? `整文件转写 · ${String(task.sourceAudioName || task.audioName || "导入音频")}`
        : `分段转写 · 第 ${Math.max(0, Number(task.segmentIndex) || 0) + 1} 段`)
      : type === "merge" ? "AI 整理"
        : type === "generate-prompt" ? "生成提示词" : "后台任务";
    const isPartialBriefing = type === "merge" && /纪要整理部分完成/.test(String(task.lastError || ""));
    const stageLabel = task.status === "running" || task.status === LIVE_ASR_TASK_STATUS ? "正在处理"
      : task.status === "blocked" ? "等待修复配置"
        : task.status === "missing" ? "缺少源文件"
          : task.status === "failed" ? (isPartialBriefing ? "部分完成 · 等待重试" : "本次处理失败") : "等待处理";
    const status = task.status === "running" || task.status === LIVE_ASR_TASK_STATUS || task.status === "processing"
      ? "running"
      : task.status === "failed" || task.status === "blocked" || task.status === "missing"
        ? "failed" : "queued";
    const maxAttempts = Math.max(1, Number(this.host.settings && this.host.settings.maxRetries) || 3);
    const actions = status === "failed"
      ? [
        { id: "retry-queue-task", label: "重试", primary: true },
        { id: "cancel-queue-task", label: "取消重试" },
      ]
      : status === "queued"
        ? [{ id: "cancel-queue-task", label: "取消重试" }]
        : [];
    const input = {
      id,
      kind: `queue-${type || "task"}`,
      title,
      subject: String(task.mdPath || task.audioPath || ""),
      status,
      stage: String(task.status || "pending"),
      stageLabel,
      detail: String(task.lastError || (status === "queued" ? "任务已保存，稍后自动处理" : "")),
      progress: null,
      count: task.attempt ? `第 ${task.attempt}/${maxAttempts} 次` : "",
      attempt: Math.max(0, Number(task.attempt) || Number(task.retries) + 1 || 0),
      maxAttempts,
      startedAt: task.startedAt ? Date.parse(task.startedAt) : (task.createdAt ? Date.parse(task.createdAt) : Date.now()),
      updatedAt: task.updatedAt ? Date.parse(task.updatedAt) : Date.now(),
      error: status === "failed" ? String(task.lastError || "任务未成功") : "",
      actions,
    };
    const existing = this.taskActivityStore.get(id);
    const activity = existing
      ? this.taskActivityStore.patch(id, input)
      : this.taskActivityStore.start(input);
    if (activity && (!existing || existing.status !== activity.status || existing.stage !== activity.stage)) {
      this.taskActivityStore.event(id, {
        type: `queue-${activity.status}`,
        label: stageLabel,
        detail: String(task.lastError || ""),
      });
    }
    return activity;
  }
  syncOutlineTaskActivity(state) {
    if (!state || !state.sessionId || !this.taskActivityStore) return null;
    const id = `outline:${state.sessionId}`;
    const session = this.host.session && this.host.session.id === state.sessionId ? this.host.session : null;
    const existing = this.taskActivityStore.get(id);
    if (state.phase === "idle" && !existing) return null;
    const subject = session && session.mdPath ? session.mdPath : "";
    const reason = String(state.reason || "");
    const reasonLabels = {
      segment: "等待新增转写",
      scheduled: "等待刷新",
      waiting: "等待转写空档",
      retry: "等待自动重试",
      backoff: "稍后自动重试",
      manual: "手动刷新",
      "manual-refresh": "手动刷新",
      final: "生成最终大纲",
    };
    const actions = state.phase === "running"
      ? [{ id: "cancel-outline", label: "停止本轮" }]
      : state.phase === "idle" && state.lastError
        ? [
          { id: "retry-outline", label: "重新生成", primary: true },
          { id: "dismiss-task", label: "关闭记录" },
        ]
        : state.phase !== "idle"
          ? [{ id: "cancel-outline", label: "取消等待" }]
          : [{ id: "dismiss-task", label: "关闭记录" }];
    if (!existing) {
      this.taskActivityStore.start({
        id,
        kind: "outline",
        title: "实时大纲",
        subject,
        status: state.phase === "running" ? "running" : "waiting",
        stage: state.phase,
        stageLabel: reasonLabels[reason] || (state.phase === "running" ? "正在生成大纲" : "等待刷新"),
        detail: "",
        startedAt: state.startedAt || Date.now(),
        updatedAt: Date.now(),
        retryAt: state.nextRunAt || 0,
        actions,
      });
    }
    if (state.phase === "running") {
      return this.taskActivityStore.heartbeat(id, {
        status: "running",
        stage: "running",
        stageLabel: reasonLabels[reason] || "正在生成大纲",
        detail: state.queued > 0 ? `本轮完成后还有 ${state.queued} 次更新待合并` : "正在根据最新转写更新结构",
        count: state.queued > 0 ? `${state.queued} 次更新待合并` : "",
        startedAt: state.startedAt || existing && existing.startedAt || Date.now(),
        error: "",
        errorKind: "",
        retryAt: 0,
        actions,
      });
    }
    if (state.phase === "scheduled" || state.phase === "backoff") {
      return this.taskActivityStore.heartbeat(id, {
        status: state.phase === "backoff" ? "retrying" : "waiting",
        stage: state.phase,
        stageLabel: state.phase === "backoff" ? "等待自动重试" : "等待刷新",
        detail: state.lastError || reasonLabels[reason] || "新的转写到达后自动继续",
        retryAt: state.nextRunAt || 0,
        error: state.lastError || "",
        actions,
      });
    }
    if (state.lastError && state.queued > 0) {
      return this.taskActivityStore.heartbeat(id, {
        status: "retrying",
        stage: "retrying",
        stageLabel: "本轮失败，等待重试",
        detail: state.lastError,
        error: state.lastError,
        retryAt: state.nextRunAt || 0,
        actions,
      });
    }
    if (state.lastError) {
      return this.failTaskActivity(id, state.lastError, {
        stage: "failed",
        stageLabel: "实时大纲未生成",
        detail: state.lastError,
        subject,
        actions,
      });
    }
    return this.completeTaskActivity(id, {
      stage: "done",
      stageLabel: "大纲已更新",
      detail: "已根据当前转写完成本轮更新",
      subject,
      progress: 100,
      actions,
    });
  }
  syncSessionTaskActivity(session) {
    if (!session || !session.id || !this.taskActivityStore) return null;
    const id = session.source === "import"
      ? `import:${session.id}`
      : `finalize:${session.id}`;
    const wp = session.workProgress || {};
    const sourceLabel = session.source === "text-import" ? "文本整理"
        : session.source === "import" ? "导入音频整理" : "录音纪要整理";
    const failureStages = new Set(["finalize-failed", "transcript-empty", "merge-failed"]);
    const retryStages = new Set(["merge-retrying"]);
    const actions = failureStages.has(wp.stage)
      ? [
        { id: "open-task-note", label: "打开原始材料", primary: true },
        { id: "dismiss-task", label: "关闭记录" },
      ]
      : [];
    const patch = {
      id,
      kind: "finalize",
      title: sourceLabel,
      subject: String(session.mdPath || ""),
      status: failureStages.has(wp.stage) ? "failed" : retryStages.has(wp.stage) ? "retrying" : "running",
      stage: String(wp.stage || "preparing"),
      stageLabel: String(wp.label || "准备 AI 整理"),
      detail: String(wp.detail || ""),
      progress: wp.percent == null ? null : Number(wp.percent),
      startedAt: session.processingStartedAt ? Date.parse(session.processingStartedAt) : Date.parse(session.startedAt || "") || Date.now(),
      updatedAt: wp.updatedAt ? Date.parse(wp.updatedAt) : Date.now(),
      error: failureStages.has(wp.stage) ? String(session.finalizationError || wp.detail || wp.label || "纪要整理失败") : "",
      actions: retryStages.has(wp.stage)
        ? [{ id: "open-task-note", label: "打开原始材料", primary: true }]
        : actions,
    };
    const existing = this.taskActivityStore.get(id);
    if (!existing) this.taskActivityStore.start(patch);
    if (failureStages.has(wp.stage)) return this.failTaskActivity(id, patch.error, patch);
    if (retryStages.has(wp.stage)) {
      return this.taskActivityStore.heartbeat(id, Object.assign({}, patch, {
        status: "retrying",
        error: String(session.finalizationError || wp.detail || ""),
        errorKind: session.finalizationError ? undefined : "",
      }));
    }
    if (wp.stage === "done") {
      return this.completeTaskActivity(id, Object.assign({}, patch, {
        stageLabel: wp.label || "纪要处理完成",
        actions: session.mdPath
          ? [{ id: "open-task-note", label: "打开纪要", primary: true }, { id: "dismiss-task", label: "关闭记录" }]
          : [{ id: "dismiss-task", label: "关闭记录" }],
      }));
    }
    return this.taskActivityStore.heartbeat(id, Object.assign({}, patch, {
      status: "running",
      error: "",
      errorKind: "",
    }));
  }
  syncImportTaskActivity(activity) {
    if (!activity || !activity.sessionId || !this.taskActivityStore) return null;
    const id = `import:${activity.sessionId}`;
    const phase = normalizeAudioImportStage(activity.phase);
    const labels = {
      prepare: "准备音频",
      transcribe: "语音转写",
      persist: "写入原始转写",
      organize: "AI 整理",
      write: "写入纪要",
    };
    const total = Math.max(0, Number(activity.segmentTotal) || 0);
    const done = phase === "persist"
      ? Math.max(0, Number(activity.writtenSegments) || 0)
      : Math.max(0, Number(activity.segmentDone) || 0);
    const failed = Math.max(0, Number(activity.failedSegments) || 0);
    const finished = Math.min(total, done + failed);
    const failure = String(activity.error || "");
    const progressCount = failure ? done : finished;
    const progress = total > 0 ? Math.max(0, Math.min(100, (progressCount / total) * 100)) : null;
    const existing = this.taskActivityStore.get(id);
    const completed = !!activity.completed;
    const patch = {
      id,
      kind: "audio-import",
      title: activity.file ? `导入音频 · ${activity.file}` : "导入音频",
      subject: String(activity.mdPath || activity.file || ""),
      status: failure ? "failed" : completed ? "done" : "running",
      stage: phase,
      stageLabel: labels[phase] || "处理音频",
      detail: failed > 0
        ? `${failed} 个音频文件未成功，原始音频已保留并进入重试流程`
        : String(activity.label || ""),
      progress,
      count: total > 0 ? `${done}/${total} 个文件` : activity.total > 1 ? `${activity.done || 0}/${activity.total} 个文件` : "",
      startedAt: Number(activity.startedAt) || Date.now(),
      updatedAt: Number(activity.updatedAt) || Date.now(),
      error: failure,
      actions: failure
        ? [{ id: "open-task-note", label: "打开原始材料", primary: true }, { id: "dismiss-task", label: "关闭记录" }]
        : completed
          ? [{ id: "open-task-note", label: "打开纪要", primary: true }, { id: "dismiss-task", label: "关闭记录" }]
          : [],
    };
    let next = existing
      ? this.taskActivityStore.heartbeat(id, patch)
      : this.taskActivityStore.start(patch);
    if (failure) next = this.failTaskActivity(id, failure, patch);
    else if (completed) next = this.completeTaskActivity(id, patch);
    if (next && (!existing || existing.stage !== next.stage)) {
      this.taskActivityStore.event(id, {
        type: "stage",
        label: next.stageLabel,
        detail: next.detail,
      });
    }
    return next;
  }
  async handleTaskActivityAction(taskId, actionId) {
    const activity = this.taskActivityStore && this.taskActivityStore.get(taskId);
    if (!activity) return;
    try {
      if (actionId === "dismiss-task") {
        this.taskActivityStore.remove(taskId);
        return;
      }
      if (actionId === "open-settings") {
        this.host.openSettings("advanced");
        return;
      }
      if (actionId === "retry-outline") {
        await this.host.outline.refreshRealtimeOutlineInBackground({ force: true, silent: false, reason: "task-center-retry" });
        return;
      }
      if (actionId === "cancel-outline") {
        this.host.outline.cancelRealtimeOutline(taskId.replace(/^outline:/, ""));
        this.cancelTaskActivity(taskId, "已停止本轮大纲生成");
        return;
      }
      if (actionId === "retry-queue-task") {
        const queueId = taskId.replace(/^queue:/, "");
        const task = this.host.queue && this.host.queue.tasks.find((item) => item && item.id === queueId);
        if (!task) throw new Error("对应的待处理任务已不存在");
        if (task.status === "failed" || task.status === "blocked" || task.status === "missing") {
          await this.host.queue.update(task.id, {
            status: "pending",
            retries: Math.max(0, Math.min(Number(task.retries) || 0, (this.host.settings.maxRetries || 3) - 1)),
          });
        }
        if (task.type === "transcribe") this.host.resetAsrServiceCircuitForManualRetry("task-center");
        try {
          await this.host.queue.processOne(task);
        } catch (error) {
          if (task.type === "transcribe" && isAsrTransportError(error)) {
            this.host.queueRetry.scheduleTaskQueueRetry(this.host.getAsrServiceRetryDelayMs(), "task-center-transport-failure");
          }
          throw error;
        }
        return;
      }
      if (actionId === "cancel-queue-task") {
        const queueId = taskId.replace(/^queue:/, "");
        await this.host.queue.remove(queueId);
        new obsidian.Notice("已取消自动重试；原始材料不会删除。", 5000);
        return;
      }
      if (actionId === "open-task-note") {
        const file = this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(activity.subject || ""));
        if (!(file instanceof obsidian.TFile)) throw new Error("对应笔记不存在或已被移动");
        const leaf = this.host.app.workspace.getLeaf(true);
        await leaf.openFile(file);
        await this.host.app.workspace.revealLeaf(leaf);
      }
    } catch (error) {
      const message = getTaskErrorMessage(error, "操作未完成");
      this.failTaskActivity(taskId, error, {
        stageLabel: "操作未完成",
        detail: message,
        actions: activity.actions,
      });
      try {
        await this.host.diagnostics.logDiagnostic("error", "task.action_failed", "任务操作失败", {
          taskId,
          actionId,
          error: diagnosticError(error),
        });
      } catch { /* diagnostics must not hide the original failure */ }
      new obsidian.Notice(`操作未完成：${message}`, 8000);
    }
  }
  // 转写进度状态栏：从队列 + 当前会话的实时状态渲染一行常驻指示器。
  // 挂在 refreshOutlineView（统一重绘入口）+ processAll 批量游标上，所有状态变化都能即时反映。
  updateBusyStatus() {
    const el = this.progressStatusEl;
    if (!el) return;
    const show = (icon, text, spin, muted) => {
      el.empty();
      el.removeClass("lexvoice-statusbar-hidden");
      el.toggleClass("lexvoice-statusbar-idle", !!muted);
      const ico = el.createSpan({ cls: "lexvoice-statusbar-icon" + (spin ? " lexvoice-statusbar-spin" : "") });
      try { obsidian.setIcon(ico, icon); } catch { /* intentionally empty */ }
      el.createSpan({ cls: "lexvoice-statusbar-text", text });
      el.setAttr("aria-label", text + "（点击查看转写队列）");
    };

    const q = this.host.queue;
    const maxR = (this.host.settings && this.host.settings.maxRetries) || 3;
    const tasks = q && Array.isArray(q.tasks) ? q.tasks : [];
    const runnable = tasks.filter((t) => t && t.status !== "running" && t.status !== "missing" && t.status !== "blocked" && (Number(t.retries) || 0) < maxR);

    const s = this.host.session;
    const wp = s && s.workProgress ? s.workProgress : null;
    const wpLabel = wp && wp.label ? String(wp.label) : "";
    const pct = wp && wp.percent != null && Number.isFinite(Number(wp.percent)) ? ` ${Math.round(Number(wp.percent))}%` : "";
    const postProcessing = !!(wp && (wp.stage === "write-note" || wp.stage === "done"));

    // 0) 导入多文件批量转写
    if (this._importBusy && Number(this._importBusy.total) > 0) {
      const ip = this._importBusy;
      if (ip.workflow === "audio-import") {
        const phase = normalizeAudioImportStage(ip.phase);
        const completed = Math.max(0, Number(ip.segmentDone) || 0);
        const total = Math.max(0, Number(ip.segmentTotal) || 0);
        const phaseLabel = phase === "prepare" ? "准备音频"
          : phase === "transcribe" ? "语音转写"
            : phase === "persist" ? "写入原始转写"
              : phase === "organize" ? "AI 整理" : "写入纪要";
        const chunkLabel = phase === "transcribe" && total > 1 ? ` ${completed}/${total} 段` : "";
        show("loader-2", `${phaseLabel}${chunkLabel}`, true);
      } else {
        show("loader-2", ip.label || `导入转写 ${Number(ip.done) || 0}/${ip.total}`, true);
      }
      return;
    }
    // A) 批量转写处理（重试全部 / 重新转写整篇 / 多任务串行跑）——叠加当前任务的实时阶段标签。
    // 只看 _batchTotal（processAll 和手动逐条循环都会设它），不要求 q.running，避免漏掉手动循环路径。
    if (q && Number(q._batchTotal) > 0) {
      const done = Math.min(Number(q._batchDone) || 0, Number(q._batchTotal));
      show("loader-2", `转写处理中 ${done}/${q._batchTotal}${wpLabel ? " · " + wpLabel : ""}`, true);
      return;
    }
    // A2) 通用长操作（重新整理 / 整篇重新润色等，无可计数子任务）
    if (this._busyLabel) {
      show("loader-2", String(this._busyLabel), true);
      return;
    }
    // B) 会后 AI 整理：多个子阶段（整理上下文 / 生成大纲 / 合并润色…）+ 百分比，跟着 workProgress 实时切换
    if (s && (s.finalizing || postProcessing)) {
      show("loader-2", (wpLabel || "AI 整理中") + pct, true);
      return;
    }
    // C) 录音进行中：实时走动的录音时长 + 已转写段数；某段在转写时叠加"转写中"
    const rec = this.host.recorder;
    const recState = rec && typeof rec.state === "string" ? rec.state : "idle";
    if (s && (recState === "recording" || recState === "paused")) {
      let elapsed = 0;
      try { elapsed = (rec.getInfo && rec.getInfo().elapsed) || 0; } catch { /* intentionally empty */ }
      const segN = Array.isArray(s.segments) ? s.segments.length : 0;
      if (recState === "paused") {
        show("pause", `录音已暂停 ${formatElapsed(elapsed)}`, false);
      } else if (Number(s.activeSegmentJobs) > 0) {
        show("loader-2", `录音 ${formatElapsed(elapsed)} · 转写中`, true);
      } else {
        show("mic", `录音 ${formatElapsed(elapsed)}${segN ? " · 已转写 " + segN + " 段" : ""}`, false);
      }
      return;
    }
    // C2) 非录音但仍有段落在转写（停止后的尾段收尾）
    if (s && Number(s.activeSegmentJobs) > 0) {
      show("loader-2", (wpLabel || "转写中") + pct, true);
      return;
    }
    // C3) 跨模块任务异常：不能因原业务弹窗关闭就消失。失败和卡住状态会常驻到用户处理或关闭记录。
    const taskActivities = this.getTaskActivities({ includeDone: false, includeCancelled: false });
    const attention = taskActivities.filter((activity) => activity && (activity.status === "failed" || activity.status === "stalled"));
    if (attention.length > 0) {
      show("triangle-alert", `${attention.length} 个任务需要处理`, false);
      return;
    }
    const background = taskActivities.filter((activity) => activity
      && !String(activity.kind || "").startsWith("queue-")
      && ["running", "waiting", "slow", "retrying"].includes(activity.status));
    if (background.length > 0) {
      const task = background[0];
      const stateText = task.status === "retrying" ? "等待重试"
        : task.status === "waiting" ? "等待继续"
          : task.status === "slow" ? (task.stageLabel || "处理中") : (task.stageLabel || "后台处理中");
      show(task.status === "waiting" || task.status === "retrying" ? "clock-3" : "loader-2",
        `${task.title} · ${stateText}`,
        task.status === "running" || task.status === "slow");
      return;
    }
    // D) 有待处理任务但空闲（可点重试）
    if (runnable.length > 0) {
      show("clock", `${runnable.length} 个待转写`, false);
      return;
    }
    // E) 空闲 → 低调常驻锚点
    show("circle-check", "QnALog 就绪", false, true);
  }
  // 兼容旧调用名：早期代码里残留 this.renderStatusBar() 调用点，但 renderStatusBar 从未定义
  // → 运行时抛 TypeError（曾导致"重试失败转写/清空队列"中途崩、完成提示不弹）。统一别名到 updateBusyStatus。
  renderStatusBar() { try { this.updateBusyStatus(); } catch { /* intentionally empty */ } }
  // 当前正在进行的处理标签（导入/批量/重整/录音整理/转写/录音），空闲返回 null。供处理进度面板的"处理中"区用。
  getCurrentActivityLabel() {
    if (this._importBusy && Number(this._importBusy.total) > 0) {
      const ip = this._importBusy;
      if (ip.workflow === "audio-import") {
        const detail = this.getCurrentActivityDetail();
        return detail ? [detail.step, detail.count].filter(Boolean).join(" · ") : "导入转写";
      }
      return ip.label || `导入转写 ${Number(ip.done) || 0}/${ip.total}`;
    }
    if (this.host.queue && Number(this.host.queue._batchTotal) > 0) {
      const done = Math.min(Number(this.host.queue._batchDone) || 0, Number(this.host.queue._batchTotal));
      return `转写处理中 ${done}/${this.host.queue._batchTotal}`;
    }
    if (this._busyLabel) return String(this._busyLabel);
    const s = this.host.session;
    const wp = s && s.workProgress;
    const postProcessing = !!(wp && (wp.stage === "write-note" || wp.stage === "done"));
    if (s && (s.finalizing || postProcessing)) return (wp && wp.label) || "AI 整理中";
    if (s && Number(s.activeSegmentJobs) > 0) return (s.workProgress && s.workProgress.label) || "转写中";
    if (this.host.recorder && this.host.recorder.state === "recording") return "录音中";
    return null;
  }
  updateImportActivity(patch = {}) {
    const current = this._importBusy;
    if (!current || current.workflow !== "audio-import") return null;
    const now = Date.now();
    const event = patch && patch.event ? patch.event : null;
    const cleanPatch = Object.assign({}, patch);
    delete cleanPatch.event;
    const previousPhase = normalizeAudioImportStage(current.phase);
    const nextPhase = normalizeAudioImportStage(cleanPatch.phase || current.phase);
    const stageState = Object.assign({}, current.stageState || {});
    const previousStage = Object.assign({}, stageState[previousPhase] || {});
    const nextStage = Object.assign({}, stageState[nextPhase] || {});

    if (!previousStage.startedAt) previousStage.startedAt = Number(current.phaseStartedAt) || Number(current.startedAt) || now;
    if (previousPhase !== nextPhase && !previousStage.completedAt) {
      previousStage.completedAt = now;
      previousStage.updatedAt = now;
      stageState[previousPhase] = previousStage;
    }
    if (!nextStage.startedAt) nextStage.startedAt = now;
    nextStage.updatedAt = now;
    stageState[nextPhase] = nextStage;

    let requests = Array.isArray(cleanPatch.requests)
      ? cleanPatch.requests
      : Array.isArray(current.requests)
        ? current.requests
        : [];
    const nextSegmentTotal = Math.max(0, Number(cleanPatch.segmentTotal ?? current.segmentTotal) || 0);
    if (nextSegmentTotal > 0) {
      requests = requests.map((request) => Object.assign({}, request, { chunkCount: nextSegmentTotal }));
    }
    let events = Array.isArray(current.events) ? current.events : [];
    if (previousPhase !== nextPhase) {
      events = appendActivityEvent(events, {
        at: now,
        stageId: nextPhase,
        type: "stage",
        label: ({
          prepare: "开始准备音频",
          transcribe: "开始语音转写",
          persist: "开始写入原始转写",
          organize: "开始 AI 整理",
          write: "开始写入纪要",
        })[nextPhase],
      });
    }
    if (event) {
      events = appendActivityEvent(events, Object.assign({}, event, {
        stageId: event.stageId || nextPhase,
        at: event.at || now,
      }));
    }

    const next = Object.assign({}, current, cleanPatch, {
      phase: nextPhase,
      phaseStartedAt: previousPhase === nextPhase
        ? Number(current.phaseStartedAt) || Number(current.startedAt) || now
        : now,
      stageState,
      requests,
      events,
      updatedAt: now,
    });
    this._importBusy = next;
    try { this.syncImportTaskActivity(next); } catch { /* progress must not interrupt import */ }
    try { this.updateBusyStatus(); } catch { /* intentionally empty */ }
    try { this.host.refreshOutlineView(); } catch { /* intentionally empty */ }
    return next;
  }
  updateImportRequest(patch) {
    const current = this._importBusy;
    if (!current || current.workflow !== "audio-import" || !patch || !patch.key) return null;
    const requests = upsertActivityRequest(current.requests, patch, 400);
    return this.updateImportActivity({ requests });
  }
  buildAudioImportActivityStages(activity, currentPhase) {
    const ip = activity && typeof activity === "object" ? activity : {};
    const phase = normalizeAudioImportStage(currentPhase || ip.phase);
    const now = Date.now();
    const prepareDone = Math.max(0, Number(ip.prepareDone) || 0);
    const prepareTotal = Math.max(0, Number(ip.prepareTotal) || 0);
    const segmentDone = Math.max(0, Number(ip.segmentDone) || 0);
    const segmentTotal = Math.max(0, Number(ip.segmentTotal) || 0);
    const writtenSegments = Math.max(0, Number(ip.writtenSegments) || 0);
    const failedSegments = Math.max(0, Number(ip.failedSegments) || 0);
    const processedSegments = Math.min(segmentTotal, segmentDone);
    const lifecycleRequests = (Array.isArray(ip.requests) ? ip.requests : [])
      .map((request) => Object.assign({}, request, {
        liveness: classifyActivityRequest(request, now),
      }))
      .sort((a, b) => Number(a.chunkIndex) - Number(b.chunkIndex));
    const requestSummary = summarizeActivityRequests(lifecycleRequests, now);
    const stageState = ip.stageState && typeof ip.stageState === "object" ? ip.stageState : {};
    const lifecycleEvents = Array.isArray(ip.events) ? ip.events : [];
    const rawStages = buildAudioImportStages(phase, !!ip.completed);

    return rawStages.map((stage) => {
      const telemetry = stageState[stage.id] || {};
      const stageEvents = lifecycleEvents
        .filter((event) => event && event.stageId === stage.id)
        .slice(-10);
      let liveness = stage.status === "done" ? "done" : stage.status === "pending" ? "pending" : "running";
      let summary = "";
      let detail = "";
      let requests = [];
      if (stage.id === "prepare") {
        summary = prepareTotal > 0 ? `${prepareDone}/${prepareTotal} 个文件已准备` : "";
        detail = "读取音频并确认文件、格式和时长。";
      } else if (stage.id === "transcribe") {
        requests = lifecycleRequests;
        summary = [
          stage.status === "active" ? String(ip.transcribeLabel || "") : "",
          segmentTotal > 0 ? `${processedSegments}/${segmentTotal} 个文件转写成功` : "",
          requestSummary.running ? `${requestSummary.running} 个请求已发出` : "",
          requestSummary.waiting ? `${requestSummary.waiting} 个请求等待响应` : "",
          requestSummary.slow ? `${requestSummary.slow} 个请求处理中` : "",
          requestSummary.stalled ? `${requestSummary.stalled} 个请求超过预期` : "",
          requestSummary.retrying ? `${requestSummary.retrying} 个请求等待重试` : "",
          failedSegments ? `${failedSegments} 个文件待重试` : "",
        ].filter(Boolean).join(" · ");
        detail = String(ip.transcribeDetail || "每个音频文件独立提交；失败时保留音频并登记到重试队列。");
        if (stage.status === "active") {
          liveness = getDominantActivityLiveness(requestSummary);
          if (liveness === "pending" || liveness === "done") {
            const quietMs = now - (Number(telemetry.updatedAt) || Number(ip.phaseStartedAt) || now);
            liveness = quietMs >= 90_000 ? "stalled" : quietMs >= 20_000 ? "slow" : "running";
          }
        } else if (failedSegments > 0 || requestSummary.failed > 0 || requestSummary.stalled > 0) {
          // “转写步骤已经走完”不等于“所有分段都成功”。失败段进入重试队列后，
          // 历史步骤仍保留告警状态，用户展开链路时能看见缺口，而不是被绿色完成态掩盖。
          liveness = "failed";
        }
      } else if (stage.id === "persist") {
        summary = segmentTotal > 0 ? `${writtenSegments}/${segmentTotal} 个文件已写入` : "";
        detail = "原始转写按时间顺序写入笔记，不会等待最终纪要后再一次性保存。";
      } else if (stage.id === "organize") {
        summary = String(ip.organizeLabel || "");
        detail = String(ip.organizeDetail || "使用已经落盘的原始转写生成结构化纪要。");
      } else if (stage.id === "write") {
        summary = String(ip.writeLabel || "");
        detail = String(ip.writeDetail || "把整理结果写回笔记并完成索引更新。");
      }
      if (stage.status === "active" && stage.id !== "transcribe") {
        const quietMs = now - (Number(telemetry.updatedAt) || Number(ip.updatedAt) || now);
        liveness = quietMs >= 120_000 ? "stalled" : quietMs >= 30_000 ? "slow" : "running";
      }
      if (stage.status === "active" && ip.error) {
        liveness = "failed";
        detail = String(ip.error);
      }
      return Object.assign({}, stage, {
        liveness,
        summary,
        detail,
        startedAt: Number(telemetry.startedAt) || null,
        updatedAt: Number(telemetry.updatedAt) || null,
        completedAt: Number(telemetry.completedAt) || null,
        events: stageEvents,
        requests,
        requestSummary: stage.id === "transcribe" ? requestSummary : null,
      });
    });
  }
  // 结构化的当前活动详情：任务类型 / 模式 / 当前步骤 / 进度% / 步骤说明。供处理进度面板展开展示。
  // 与 getCurrentActivityLabel 同源同优先级，只是返回结构而非一行字符串；空闲返回 null。
  getCurrentActivityDetail() {
    const modeLabelOf = (m) => { try { return (getModeMeta(this.host.settings, m) || {}).label || ""; } catch { return ""; } };
    const pctOf = (wp) => (wp && wp.percent != null && Number.isFinite(Number(wp.percent))) ? Number(wp.percent) : null;
    // 0) 导入多文件批量转写
    const ip = this._importBusy;
    if (ip && Number(ip.total) > 0) {
      const total = Number(ip.total);
      const n = Math.min((Number(ip.done) || 0) + 1, total);
      if (ip.workflow === "audio-import") {
        const phase = normalizeAudioImportStage(ip.phase);
        const prepareDone = Math.max(0, Number(ip.prepareDone) || 0);
        const prepareTotal = Math.max(0, Number(ip.prepareTotal) || 0);
        const segmentDone = Math.max(0, Number(ip.segmentDone) || 0);
        const segmentTotal = Math.max(0, Number(ip.segmentTotal) || 0);
        const writtenSegments = Math.max(0, Number(ip.writtenSegments) || 0);
        const activeSegments = Math.max(0, Number(ip.activeSegments) || 0);
        const failedSegments = Math.max(0, Number(ip.failedSegments) || 0);
        const processedSegments = Math.min(segmentTotal, segmentDone);
        let step = "准备音频";
        let stepDetail = ip.file
          ? `正在读取并分析 ${ip.file}`
          : "正在读取音频并准备整文件转写任务";
        let percent = null;
        let count = total > 1 ? `第 ${n} / ${total} 个文件` : "";
        if (phase === "prepare" && prepareTotal > 1) {
          percent = Math.max(0, Math.min(100, (prepareDone / prepareTotal) * 100));
          count = `已准备 ${prepareDone} / ${prepareTotal} 个文件`;
        }
        if (phase === "transcribe") {
          step = "语音转写";
          const runningText = activeSegments > 0 ? `${activeSegments} 个文件正在请求转写服务` : "正在等待转写服务返回";
          stepDetail = failedSegments > 0
            ? `${runningText}；${failedSegments} 个文件未成功，已保留并进入重试流程`
            : runningText;
          if (segmentTotal > 1) {
            percent = Math.max(0, Math.min(100, (processedSegments / segmentTotal) * 100));
            count = `成功 ${processedSegments} / ${segmentTotal} 个文件`;
          } else {
            count = segmentTotal === 1 && segmentDone > 0 ? "当前音频已转写" : "正在转写当前音频";
          }
        } else if (phase === "persist") {
          step = "写入原始转写";
          stepDetail = "正在按时间顺序写入 Obsidian 笔记，原始转写会完整保留";
          if (segmentTotal > 0) {
            percent = Math.max(0, Math.min(100, (writtenSegments / segmentTotal) * 100));
            count = `已写入 ${writtenSegments} / ${segmentTotal} 段`;
          }
        } else if (phase === "organize") {
          step = String(ip.organizeLabel || "AI 整理");
          stepDetail = String(ip.organizeDetail || "原始转写已保留，正在生成最终纪要");
          percent = Number.isFinite(Number(ip.organizePercent)) ? Number(ip.organizePercent) : null;
          count = segmentTotal > 0 ? `转写已完成 ${segmentDone} / ${segmentTotal} 段` : "";
        } else if (phase === "write") {
          step = String(ip.writeLabel || "写入纪要");
          stepDetail = String(ip.writeDetail || "正在把整理结果写入 Obsidian");
          percent = Number.isFinite(Number(ip.writePercent)) ? Number(ip.writePercent) : null;
          count = segmentTotal > 0 ? `${segmentDone} / ${segmentTotal} 段已转写` : "";
        }
        const stages = this.buildAudioImportActivityStages(ip, phase);
        const lifecycleEvents = Array.isArray(ip.events) ? ip.events : [];
        const activeStage = stages.find((stage) => stage.status === "active") || null;
        return {
          kind: "导入转写",
          modeLabel: modeLabelOf(ip.mode),
          step,
          stepDetail,
          percent,
          count,
          stages,
          liveness: ip.error ? "failed" : ip.completed ? "done" : activeStage ? activeStage.liveness : "running",
          events: lifecycleEvents.slice(-20),
          startedAt: Number(ip.startedAt) || null,
          stageStartedAt: Number(ip.phaseStartedAt) || null,
          updatedAt: Number(ip.updatedAt) || null,
          backgroundHint: "任务会继续在后台运行，可以关闭此窗口继续使用 Obsidian",
        };
      }
      return {
        kind: "导入转写",
        modeLabel: modeLabelOf(ip.mode),
        step: "转写音频中",
        stepDetail: ip.file ? `当前文件：${ip.file}` : "正在把音频发送到转写服务",
        percent: null,
        count: `第 ${n} / ${total} 个文件`,
      };
    }
    // A) 批量转写处理（重试全部 / 整篇重转）——叠加 workProgress 子阶段
    const q = this.host.queue;
    if (q && Number(q._batchTotal) > 0) {
      const done = Math.min(Number(q._batchDone) || 0, Number(q._batchTotal));
      const wp = this.host.session && this.host.session.workProgress;
      return {
        kind: "转写批处理",
        modeLabel: this.host.session ? modeLabelOf(this.host.session.mode) : "",
        step: (wp && wp.label) || "转写处理中",
        stepDetail: (wp && wp.detail) || "",
        percent: pctOf(wp),
        count: `${done} / ${q._batchTotal} 段`,
      };
    }
    // A2) 通用长操作（重新整理 / 整篇重新润色）
    if (this._busyLabel) {
      const context = this._busyContext && typeof this._busyContext === "object"
        ? this._busyContext
        : {};
      return {
        kind: String(context.kind || "重新整理"),
        modeLabel: String(context.targetModeLabel || ""),
        sourceFile: String(context.sourceFile || ""),
        sourceFolder: String(context.sourceFolder || ""),
        durationMs: Math.max(0, Number(context.durationMs) || 0),
        sourceModeLabel: String(context.sourceModeLabel || ""),
        targetModeLabel: String(context.targetModeLabel || ""),
        step: String(this._busyLabel),
        stepDetail: "",
        percent: null,
        count: "",
      };
    }
    // B/C) 录音 / 段落转写 / 会后 AI 整理（this.host.session）
    const s = this.host.session;
    if (s) {
      const wp = s.workProgress || null;
      const pct = pctOf(wp);
      const modeLabel = modeLabelOf(s.mode);
      const srcKind = s.source === "import" ? "导入整理" : s.source === "text-import" ? "文本整理" : "录音整理";
      if (s.finalizing) {
        return { kind: srcKind, modeLabel, step: (wp && wp.label) || "AI 整理中", stepDetail: (wp && wp.detail) || "", percent: pct, count: "" };
      }
      const rec = this.host.recorder;
      const recState = rec && typeof rec.state === "string" ? rec.state : "idle";
      if (recState === "recording" || recState === "paused") {
        let elapsed = 0; try { elapsed = (rec.getInfo && rec.getInfo().elapsed) || 0; } catch { /* intentionally empty */ }
        const segN = Array.isArray(s.segments) ? s.segments.length : 0;
        const countTxt = segN ? `已转写 ${segN} 段` : "";
        if (recState === "paused") {
          return { kind: "录音中", modeLabel, step: `录音已暂停 · ${formatElapsed(elapsed)}`, stepDetail: "", percent: null, count: countTxt };
        }
        if (Number(s.activeSegmentJobs) > 0) {
          return { kind: "录音中", modeLabel, step: `录音 ${formatElapsed(elapsed)} · 转写中`, stepDetail: (wp && wp.detail) || "正在转写已切分的音频段", percent: pct, count: countTxt };
        }
        return { kind: "录音中", modeLabel, step: `正在录音 · ${formatElapsed(elapsed)}`, stepDetail: segN ? "" : "等待第一段切分", percent: null, count: countTxt };
      }
      if (Number(s.activeSegmentJobs) > 0) {
        return { kind: srcKind, modeLabel, step: (wp && wp.label) || "转写中", stepDetail: (wp && wp.detail) || "", percent: pct, count: "" };
      }
    }
    return null;
  }
  // 记一笔"本次启动后已完成"的处理（供处理进度面板展示；不持久化，OB 重启清零）。
  logCompletedWork(title, detail, meter) {
    if (!Array.isArray(this.completedWorkLog)) this.completedWorkLog = [];
    const entry = { title: String(title || "完成"), detail: String(detail || ""), at: Date.now() };
    if (meter && Number(meter.durationMs) > 0) entry.durationMs = Math.round(Number(meter.durationMs));
    if (meter && Number(meter.tokens) > 0) { entry.tokens = Math.round(Number(meter.tokens)); entry.tokensExact = !!meter.exact; }
    this.completedWorkLog.unshift(entry);
    if (this.completedWorkLog.length > 80) this.completedWorkLog.length = 80;
    try { this.updateBusyStatus(); } catch { /* intentionally empty */ }
  }
  // —— 单任务 token 计量 —— beginTaskMeter 开窗，期间所有 LLM 调用经 callLlmWithMeta→addTaskMeter 累计，endTaskMeter 结算。
  beginTaskMeter() {
    const meter = { inChars: 0, outChars: 0, exactTokens: 0, calls: 0, hasExact: true, startedAt: Date.now() };
    this._taskMeter = meter;
    return meter;
  }
  addTaskMeter(inChars, outChars, usage, explicitMeter = null) {
    const m = explicitMeter || this._taskMeter; if (!m) return;
    m.calls++;
    m.inChars += Number(inChars) || 0;
    m.outChars += Number(outChars) || 0;
    const t = usage && Number(usage.total_tokens);
    if (t) m.exactTokens += t; else m.hasExact = false;
  }
  endTaskMeter(expectedMeter = null) {
    const m = expectedMeter || this._taskMeter;
    if (this._taskMeter === m) this._taskMeter = null;
    if (!m || !m.calls) return null;
    const exact = m.hasExact && m.exactTokens > 0;
    // 流式调用拿不到精确 usage 时按字符估算：中文为主的 MiMo 约 1.6 字/token（粗估、仅供心里有数，精确以模型控制台为准）。
    const tokens = exact ? m.exactTokens : Math.round((m.inChars + m.outChars) / 1.6);
    return { tokens, exact, durationMs: m.startedAt ? Math.max(0, Date.now() - m.startedAt) : 0 };
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
