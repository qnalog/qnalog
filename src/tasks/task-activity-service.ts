/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：界面任务状态：任务计量、状态栏与进度、导入进度、任务动作分发

import * as obsidian from "obsidian";
import { getModeMeta } from "../shared/mode-meta";
import type { PluginSettings, RecordingSession } from "../shared/types";
import { formatElapsed } from "../shared/util-common";
import { isAsrTransportError } from "../shared/util-audio";
import { LIVE_ASR_TASK_STATUS } from "../asr/live-segment-policy";
import { diagnosticError } from "../shared/util-key-diag";
import { appendActivityEvent, audioImportStageFromWorkProgress, buildAudioImportStages, classifyActivityRequest, getDominantActivityLiveness, normalizeAudioImportStage, summarizeActivityRequests, upsertActivityRequest } from "../shared/activity-progress";
import { getTaskErrorHint, getTaskErrorMessage } from "../shared/task-activity";
import { RecorderService } from "../audio/recorder-service";
import { TaskQueue } from "../queue/task-queue";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { RealtimeOutlineService } from "../notes/realtime-outline-service";
import { TaskActivityStore } from "../shared/task-activity";
import type { TaskActivity, TaskActivityAction, TaskActivityInput } from "../shared/task-activity";
import type { AudioImportStageId } from "../shared/activity-progress";
import { QueueModal } from "../ui/modals";

import { t } from "../shared/i18n";
/** 任务成功完成时的附加信息：失败态专用的两个字段在成功时会被删掉。 */
type TaskActivityCompletion = Partial<TaskActivity> & {
  failureLabel?: string;
  failureActions?: TaskActivityAction[];
};

/**
 * 导入忙态（`_importBusy`）的补丁。
 * 与 TaskActivity 不是同一个对象：它描述音频导入的阶段、分段计数与请求轨迹，
 * 供状态栏与导入弹窗读取；这里只列出调用方实际会补写的字段。
 */
export type AudioImportBusyPatch = {
  workflow?: string;
  sessionId?: string;
  mdPath?: string;
  mode?: string;
  phase?: string;
  phaseStartedAt?: number;
  startedAt?: number;
  updatedAt?: number;
  stageState?: Record<string, unknown>;
  events?: unknown[];
  requests?: unknown[];
  asrConcurrency?: number;
  /** 单次事件记录：先取出写入事件列表，不并入忙态对象。 */
  event?: { type?: string; label?: string; detail?: string; stageId?: AudioImportStageId; at?: number } | null;
  // 进度计数与各阶段文案（导入流程与录音服务按阶段补写）
  done?: number;
  total?: number;
  prepareDone?: number;
  prepareTotal?: number;
  segmentDone?: number;
  segmentTotal?: number;
  activeSegments?: number;
  failedSegments?: number;
  writtenSegments?: number;
  persistedSegments?: number;
  missingSegmentIndexes?: number[];
  completed?: boolean;
  error?: string;
  label?: string;
  detail?: string;
  organizeLabel?: string;
  organizeDetail?: string;
  organizePercent?: number;
  transcribeLabel?: string;
  transcribeDetail?: string;
  writeLabel?: string;
  writeDetail?: string;
  writePercent?: number;
  file?: string;
  size?: number;
  model?: string;
  provider?: string;
  type?: string;
  status?: string;
  stage?: string;
  kind?: string;
  stageLabel?: string;
  audioName?: string;
  chunkCount?: number;
  chunkIndex?: number;
  key?: string;
  attempt?: number;
  deadlineAt?: number;
  maxAttempts?: number;
  expectedChars?: number;
  expectedSegments?: number;
  segmentCount?: number;
};

/** 本次启动后已完成的一笔处理；供「处理进度」面板展示，不持久化。 */
export type CompletedWorkEntry = {
  title: string;
  detail: string;
  at: number;
  durationMs?: number;
  tokens?: number;
  tokensExact?: boolean;
};

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

  openSettings(tabId?: string): void;
  queue: TaskQueue | null;
  /** 装配层转发：转写服务熔断冷却结束后重新排期（调用 QueueRetryService.scheduleTaskQueueRetry）。 */
  requestTaskQueueRetry(delayMs: number, reason: string): void;
  recorder: RecorderService | null;
  /** 装配层转发：任务状态变化后请求刷新侧边栏（调用 ViewShellService.refreshOutlineView）。 */
  requestOutlineRefresh(): void;

  session: RecordingSession | null;
  /** 实时大纲服务：用户取消等待与后台补跑。 */
  outline: RealtimeOutlineService;
  /** 录音采集服务：熔断状态与冷却时长。 */
  recording: { isAsrServiceCircuitOpen(): boolean; getAsrServiceRetryDelayMs(): number; resetAsrServiceCircuitForManualRetry(source?: string): unknown };
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
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
      try { this.host.requestOutlineRefresh(); } catch { /* task observers must not break work */ }
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
    this.progressStatusEl.addClass("qnalog-statusbar");
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
      label: input.stageLabel || input.detail || t("Task started"),
    });
    return activity;
  }
  async runTaskActivity(input: TaskActivityInput, executor, completion: TaskActivityCompletion = {}) {
    if (!input || !input.id || typeof executor !== "function") {
      throw new Error(t("Incomplete task definition"));
    }
    const taskId = String(input.id);
    this.startTaskActivity(input);
    const controls = {
      patch: (patch: Partial<TaskActivity> = {}) => this.patchTaskActivity(taskId, patch),
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
          stageLabel: completion.failureLabel || t("Task not completed"),
          detail: getTaskErrorMessage(error),
          actions: completion.failureActions || input.actions || [],
        });
      }
      throw error;
    }
  }
  patchTaskActivity(id, patch: Partial<TaskActivity> = {}) {
    if (!this.taskActivityStore || !id) return null;
    const current = this.taskActivityStore.get(id);
    if (!current) return this.startTaskActivity(Object.assign({ id }, patch));
    return this.taskActivityStore.heartbeat(id, patch);
  }
  failTaskActivity(id, error, patch: Partial<TaskActivity> = {}) {
    if (!this.taskActivityStore || !id) return null;
    const message = getTaskErrorMessage(error);
    let current = this.taskActivityStore.get(id);
    if (!current) {
      current = this.startTaskActivity(Object.assign({
        id,
        title: t("Background task"),
        status: "running",
      }, patch));
    }
    const failed = this.taskActivityStore.fail(id, error, patch);
    this.taskActivityStore.event(id, {
      type: "error",
      label: patch.stageLabel || t("Task failed"),
      detail: message,
    });
    return failed;
  }
  completeTaskActivity(id, patch: Partial<TaskActivity> = {}) {
    if (!this.taskActivityStore || !id) return null;
    const current = this.taskActivityStore.get(id);
    if (!current) return null;
    const completed = this.taskActivityStore.complete(id, patch);
    this.taskActivityStore.event(id, {
      type: "complete",
      label: patch.stageLabel || t("Task completed"),
      detail: patch.detail || "",
    });
    return completed;
  }
  cancelTaskActivity(id, detail = t("Task cancelled")) {
    if (!this.taskActivityStore || !id) return null;
    const current = this.taskActivityStore.get(id);
    if (!current) return null;
    const cancelled = this.taskActivityStore.cancel(id, detail);
    this.taskActivityStore.event(id, {
      type: "cancel",
      label: t("Task cancelled"),
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
        ? t("Whole-file transcription · {0}").replace("{0}", String(task.sourceAudioName || task.audioName || t("Import audio")))
        : t("Segmented transcription · segment {0}").replace("{0}", String(Math.max(0, Number(task.segmentIndex) || 0) + 1)))
      : type === "merge" ? t("AI Organize")
        : type === "generate-prompt" ? t("Generate prompt") : t("Background task");
    const isPartialBriefing = type === "merge" && /纪要整理部分完成|The minutes are partially complete/.test(String(task.lastError || ""));
    const stageLabel = task.status === "running" || task.status === LIVE_ASR_TASK_STATUS ? t("Currently processing")
      : task.status === "blocked" ? t("Waiting for configuration fix")
        : task.status === "missing" ? t("Source file missing")
          : task.status === "failed" ? (isPartialBriefing ? t("Partially completed · waiting to retry") : t("This run failed")) : t("Waiting to process");
    const status = task.status === "running" || task.status === LIVE_ASR_TASK_STATUS || task.status === "processing"
      ? "running"
      : task.status === "failed" || task.status === "blocked" || task.status === "missing"
        ? "failed" : "queued";
    const maxAttempts = Math.max(1, Number(this.host.settings && this.host.settings.maxRetries) || 3);
    const actions = status === "failed"
      ? [
        { id: "retry-queue-task", label: t("Retry"), primary: true },
        { id: "cancel-queue-task", label: t("Cancel retry") },
      ]
      : status === "queued"
        ? [{ id: "cancel-queue-task", label: t("Cancel retry") }]
        : [];
    const input = {
      id,
      kind: `queue-${type || "task"}`,
      title,
      subject: String(task.mdPath || task.audioPath || ""),
      status,
      stage: String(task.status || "pending"),
      stageLabel,
      detail: String(task.lastError || (status === "queued" ? t("Task saved; it will be processed automatically later") : "")),
      progress: null,
      count: task.attempt ? t("Attempt {0} of {1}").replace("{0}", task.attempt).replace("{1}", String(maxAttempts)) : "",
      attempt: Math.max(0, Number(task.attempt) || Number(task.retries) + 1 || 0),
      maxAttempts,
      startedAt: task.startedAt ? Date.parse(task.startedAt) : (task.createdAt ? Date.parse(task.createdAt) : Date.now()),
      updatedAt: task.updatedAt ? Date.parse(task.updatedAt) : Date.now(),
      error: status === "failed" ? String(task.lastError || t("Task did not succeed")) : "",
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
      segment: t("Waiting for new transcription"),
      scheduled: t("Waiting to refresh"),
      waiting: t("Waiting for a transcription gap"),
      retry: t("Waiting for automatic retry"),
      backoff: t("Retrying automatically later"),
      manual: t("Manual refresh"),
      "manual-refresh": t("Manual refresh"),
      final: t("Generate final outline"),
    };
    const actions = state.phase === "running"
      ? [{ id: "cancel-outline", label: t("Stop this round") }]
      : state.phase === "idle" && state.lastError
        ? [
          { id: "retry-outline", label: t("Regenerate"), primary: true },
          { id: "dismiss-task", label: t("Close Recording") },
        ]
        : state.phase !== "idle"
          ? [{ id: "cancel-outline", label: t("Cancel waiting") }]
          : [{ id: "dismiss-task", label: t("Close Recording") }];
    if (!existing) {
      this.taskActivityStore.start({
        id,
        kind: "outline",
        title: t("Live outline"),
        subject,
        status: state.phase === "running" ? "running" : "waiting",
        stage: state.phase,
        stageLabel: reasonLabels[reason] || (state.phase === "running" ? t("Generating outline") : t("Waiting to refresh")),
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
        stageLabel: reasonLabels[reason] || t("Generating outline"),
        detail: state.queued > 0 ? t("There will be {0} more updates to merge after this round").replace("{0}", state.queued) : t("Updating the structure from the latest transcription"),
        count: state.queued > 0 ? t("{0} updates pending merge").replace("{0}", state.queued) : "",
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
        stageLabel: state.phase === "backoff" ? t("Waiting for automatic retry") : t("Waiting to refresh"),
        detail: state.lastError || reasonLabels[reason] || t("Will continue automatically when new transcription arrives"),
        retryAt: state.nextRunAt || 0,
        error: state.lastError || "",
        actions,
      });
    }
    if (state.lastError && state.queued > 0) {
      return this.taskActivityStore.heartbeat(id, {
        status: "retrying",
        stage: "retrying",
        stageLabel: t("This round failed; waiting to retry"),
        detail: state.lastError,
        error: state.lastError,
        retryAt: state.nextRunAt || 0,
        actions,
      });
    }
    if (state.lastError) {
      return this.failTaskActivity(id, state.lastError, {
        stage: "failed",
        stageLabel: t("Live outline not generated"),
        detail: state.lastError,
        subject,
        actions,
      });
    }
    return this.completeTaskActivity(id, {
      stage: "done",
      stageLabel: t("Outline updated"),
      detail: t("This round of updates has been completed based on the current transcription"),
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
    const sourceLabel = session.source === "text-import" ? t("Text organization")
        : session.source === "import" ? t("Imported audio organization") : t("Recording minutes organization");
    const failureStages = new Set(["finalize-failed", "transcript-empty", "merge-failed"]);
    const retryStages = new Set(["merge-retrying"]);
    const actions = failureStages.has(wp.stage)
      ? [
        { id: "open-task-note", label: t("Open original material"), primary: true },
        { id: "dismiss-task", label: t("Close Recording") },
      ]
      : [];
    const patch: TaskActivityInput = {
      id,
      kind: "finalize",
      title: sourceLabel,
      subject: String(session.mdPath || ""),
      status: failureStages.has(wp.stage) ? "failed" : retryStages.has(wp.stage) ? "retrying" : "running",
      stage: String(wp.stage || "preparing"),
      stageLabel: String(wp.label || t("Preparing AI organization")),
      detail: String(wp.detail || ""),
      progress: wp.percent == null ? null : Number(wp.percent),
      startedAt: session.processingStartedAt ? Date.parse(session.processingStartedAt) : Date.parse(session.startedAt || "") || Date.now(),
      updatedAt: wp.updatedAt ? Date.parse(wp.updatedAt) : Date.now(),
      error: failureStages.has(wp.stage) ? String(session.finalizationError || wp.detail || wp.label || t("Minutes organization failed")) : "",
      actions: retryStages.has(wp.stage)
        ? [{ id: "open-task-note", label: t("Open original material"), primary: true }]
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
        stageLabel: wp.label || t("Minutes organization completed"),
        actions: session.mdPath
          ? [{ id: "open-task-note", label: t("Open minutes"), primary: true }, { id: "dismiss-task", label: t("Close Recording") }]
          : [{ id: "dismiss-task", label: t("Close Recording") }],
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
      prepare: t("Preparing audio"),
      transcribe: t("Speech transcription"),
      persist: t("Writing the original transcription"),
      organize: t("AI Organize"),
      write: t("Write to Minutes"),
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
    const patch: TaskActivityInput = {
      id,
      kind: "audio-import",
      title: activity.file ? t("Import audio · {0}").replace("{0}", activity.file) : t("Import audio"),
      subject: String(activity.mdPath || activity.file || ""),
      status: failure ? "failed" : completed ? "done" : "running",
      stage: phase,
      stageLabel: labels[phase] || t("Processing audio"),
      detail: failed > 0
        ? t("{0} audio files failed; the original audio has been kept and entered the retry flow").replace("{0}", String(failed))
        : String(activity.label || ""),
      progress,
      count: total > 0 ? t("{0}/{1} files").replace("{0}", String(done)).replace("{1}", String(total)) : activity.total > 1 ? t("{0}/{1} files").replace("{0}", activity.done || 0).replace("{1}", activity.total) : "",
      startedAt: Number(activity.startedAt) || Date.now(),
      updatedAt: Number(activity.updatedAt) || Date.now(),
      error: failure,
      actions: failure
        ? [{ id: "open-task-note", label: t("Open original material"), primary: true }, { id: "dismiss-task", label: t("Close Recording") }]
        : completed
          ? [{ id: "open-task-note", label: t("Open minutes"), primary: true }, { id: "dismiss-task", label: t("Close Recording") }]
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
        this.host.openSettings("inbox");
        return;
      }
      if (actionId === "retry-outline") {
        await this.host.outline.refreshRealtimeOutlineInBackground({ force: true, silent: false, reason: "task-center-retry" });
        return;
      }
      if (actionId === "cancel-outline") {
        this.host.outline.cancelRealtimeOutline(taskId.replace(/^outline:/, ""));
        this.cancelTaskActivity(taskId, t("Stopped this round of outline generation"));
        return;
      }
      if (actionId === "retry-queue-task") {
        const queueId = taskId.replace(/^queue:/, "");
        const task = this.host.queue && this.host.queue.tasks.find((item) => item && item.id === queueId);
        if (!task) throw new Error(t("The corresponding pending task no longer exists"));
        if (task.status === "failed" || task.status === "blocked" || task.status === "missing") {
          await this.host.queue.update(task.id, {
            status: "pending",
            retries: Math.max(0, Math.min(Number(task.retries) || 0, (this.host.settings.maxRetries || 3) - 1)),
          });
        }
        if (task.type === "transcribe") this.host.recording.resetAsrServiceCircuitForManualRetry("task-center");
        try {
          await this.host.queue.processOne(task);
        } catch (error) {
          if (task.type === "transcribe" && isAsrTransportError(error)) {
            this.host.requestTaskQueueRetry(this.host.recording.getAsrServiceRetryDelayMs(), "task-center-transport-failure");
          }
          throw error;
        }
        return;
      }
      if (actionId === "cancel-queue-task") {
        const queueId = taskId.replace(/^queue:/, "");
        await this.host.queue.remove(queueId);
        new obsidian.Notice(t("Auto-retry cancelled; the original material will not be deleted."), 5000);
        return;
      }
      if (actionId === "open-task-note") {
        const file = this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(activity.subject || ""));
        if (!(file instanceof obsidian.TFile)) throw new Error(t("The corresponding note does not exist or has been moved"));
        const leaf = this.host.app.workspace.getLeaf(true);
        await leaf.openFile(file);
        await this.host.app.workspace.revealLeaf(leaf);
      }
    } catch (error) {
      const message = getTaskErrorMessage(error, t("Operation not completed"));
      this.failTaskActivity(taskId, error, {
        stageLabel: t("Operation not completed"),
        detail: message,
        actions: activity.actions,
      });
      try {
        await this.host.diagnostics.logDiagnostic("error", "task.action_failed", t("Task action failed"), {
          taskId,
          actionId,
          error: diagnosticError(error),
        });
      } catch { /* diagnostics must not hide the original failure */ }
      new obsidian.Notice(`${t("Operation incomplete: ")}${message}`, 8000);
    }
  }
  // 转写进度状态栏：从队列 + 当前会话的实时状态渲染一行常驻指示器。
  // 挂在 refreshOutlineView（统一重绘入口）+ processAll 批量游标上，所有状态变化都能即时反映。
  updateBusyStatus() {
    const el = this.progressStatusEl;
    if (!el) return;
    // muted 缺省为 false：多数调用只给前三个参数，此时状态栏用普通样式而非空闲样式。
    const show = (icon, text, spin, muted = false) => {
      el.empty();
      el.removeClass("qnalog-statusbar-hidden");
      el.toggleClass("qnalog-statusbar-idle", !!muted);
      const ico = el.createSpan({ cls: "qnalog-statusbar-icon" + (spin ? " qnalog-statusbar-spin" : "") });
      try { obsidian.setIcon(ico, icon); } catch { /* intentionally empty */ }
      el.createSpan({ cls: "qnalog-statusbar-text", text });
      el.setAttr("aria-label", t("{0} (click to open the transcription queue)").replace("{0}", text));
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
        const phaseLabel = phase === "prepare" ? t("Preparing audio")
          : phase === "transcribe" ? t("Speech transcription")
            : phase === "persist" ? t("Writing the original transcription")
              : phase === "organize" ? t("AI Organize") : t("Write to Minutes");
        const chunkLabel = phase === "transcribe" && total > 1 ? ` ${t("{0}/{1} segments").replace("{0}", String(completed)).replace("{1}", String(total))}` : "";
        show("loader-2", `${phaseLabel}${chunkLabel}`, true);
      } else {
        show("loader-2", ip.label || t("Import transcription {0}/{1}").replace("{0}", String(Number(ip.done) || 0)).replace("{1}", ip.total), true);
      }
      return;
    }
    // A) 批量转写处理（重试全部 / 重新转写整篇 / 多任务串行跑）——叠加当前任务的实时阶段标签。
    // 只看 _batchTotal（processAll 和手动逐条循环都会设它），不要求 q.running，避免漏掉手动循环路径。
    if (q && Number(q._batchTotal) > 0) {
      const done = Math.min(Number(q._batchDone) || 0, Number(q._batchTotal));
      show("loader-2", t("Transcribing in progress {0}/{1}").replace("{0}", String(done)).replace("{1}", String(q._batchTotal)) + (wpLabel ? " · " + wpLabel : ""), true);
      return;
    }
    // A2) 通用长操作（重新整理 / 整篇重新润色等，无可计数子任务）
    if (this._busyLabel) {
      show("loader-2", String(this._busyLabel), true);
      return;
    }
    // B) 会后 AI 整理：多个子阶段（整理上下文 / 生成大纲 / 合并润色…）+ 百分比，跟着 workProgress 实时切换
    if (s && (s.finalizing || postProcessing)) {
      show("loader-2", (wpLabel || t("AI organizing")) + pct, true);
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
        show("pause", t("Recording paused {0}").replace("{0}", formatElapsed(elapsed)), false);
      } else if (Number(s.activeSegmentJobs) > 0) {
        show("loader-2", t("Recording {0} · Transcribing").replace("{0}", formatElapsed(elapsed)), true);
      } else {
        show("mic", segN ? t("Recording {0} · {1} segments transcribed").replace("{0}", formatElapsed(elapsed)).replace("{1}", String(segN)) : t("Recording {0}").replace("{0}", formatElapsed(elapsed)), false);
      }
      return;
    }
    // C2) 非录音但仍有段落在转写（停止后的尾段收尾）
    if (s && Number(s.activeSegmentJobs) > 0) {
      show("loader-2", (wpLabel || t("Transcription in progress")) + pct, true);
      return;
    }
    // C3) 跨模块任务异常：不能因原业务弹窗关闭就消失。失败和卡住状态会常驻到用户处理或关闭记录。
    const taskActivities = this.getTaskActivities({ includeDone: false, includeCancelled: false });
    const attention = taskActivities.filter((activity) => activity && (activity.status === "failed" || activity.status === "stalled"));
    if (attention.length > 0) {
      show("triangle-alert", `${attention.length}${t(" tasks need processing")}`, false);
      return;
    }
    const background = taskActivities.filter((activity) => activity
      && !String(activity.kind || "").startsWith("queue-")
      && ["running", "waiting", "slow", "retrying"].includes(activity.status));
    if (background.length > 0) {
      const task = background[0];
      const stateText = task.status === "retrying" ? t("Waiting to retry")
        : task.status === "waiting" ? t("Waiting to continue")
          : task.status === "slow" ? (task.stageLabel || t("Processing")) : (task.stageLabel || t("Running in background"));
      show(task.status === "waiting" || task.status === "retrying" ? "clock-3" : "loader-2",
        `${task.title} · ${stateText}`,
        task.status === "running" || task.status === "slow");
      return;
    }
    // D) 有待处理任务但空闲（可点重试）
    if (runnable.length > 0) {
      show("clock", t("{0} tasks pending transcription").replace("{0}", String(runnable.length)), false);
      return;
    }
    // E) 空闲 → 低调常驻锚点
    show("circle-check", t("Q&A Log is ready"), false, true);
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
        return detail ? [detail.step, detail.count].filter(Boolean).join(" · ") : t("Import transcription");
      }
      return ip.label || t("Import transcription {0}/{1}").replace("{0}", String(Number(ip.done) || 0)).replace("{1}", ip.total);
    }
    if (this.host.queue && Number(this.host.queue._batchTotal) > 0) {
      const done = Math.min(Number(this.host.queue._batchDone) || 0, Number(this.host.queue._batchTotal));
      return t("Transcribing in progress {0}/{1}").replace("{0}", String(done)).replace("{1}", String(this.host.queue._batchTotal));
    }
    if (this._busyLabel) return String(this._busyLabel);
    const s = this.host.session;
    const wp = s && s.workProgress;
    const postProcessing = !!(wp && (wp.stage === "write-note" || wp.stage === "done"));
    if (s && (s.finalizing || postProcessing)) return (wp && wp.label) || t("AI organizing");
    if (s && Number(s.activeSegmentJobs) > 0) return (s.workProgress && s.workProgress.label) || t("Transcription in progress");
    if (this.host.recorder && this.host.recorder.state === "recording") return t("Active recording");
    return null;
  }
  /** 会话进度同步：audio-import 流程进行中时，把切片阶段进度写进导入忙态；
   * 其它流程、其它会话或当前无导入任务时为空操作。
   * 原先由录音服务跨服务读 _importBusy 私有字段拼补丁，判断与拼装都在这里完成。 */
  syncImportBusyFromSessionProgress(session) {
    const busy = this._importBusy;
    if (!busy || busy.workflow !== "audio-import" || String(busy.sessionId || "") !== String(session && session.id || "")) return;
    const progress = session && session.workProgress || {};
    const stage = audioImportStageFromWorkProgress(progress.stage);
    this.updateImportActivity({
      phase: stage,
      organizeLabel: stage === "organize" ? String(progress.label || t("AI Organize")) : busy.organizeLabel,
      organizeDetail: stage === "organize" ? String(progress.detail || "") : busy.organizeDetail,
      organizePercent: stage === "organize" ? Number(progress.percent) || 0 : busy.organizePercent,
      writeLabel: stage === "write" ? String(progress.label || t("Write to Minutes")) : busy.writeLabel,
      writeDetail: stage === "write" ? String(progress.detail || "") : busy.writeDetail,
      writePercent: stage === "write" ? Number(progress.percent) || 0 : busy.writePercent,
    });
  }
  updateImportActivity(patch: AudioImportBusyPatch = {}) {
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
          prepare: t("Started preparing audio"),
          transcribe: t("Started speech transcription"),
          persist: t("Started writing the original transcription"),
          organize: t("Started AI organization"),
          write: t("Started writing minutes"),
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
    try { this.host.requestOutlineRefresh(); } catch { /* intentionally empty */ }
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
        summary = prepareTotal > 0 ? t("{0}/{1} files ready").replace("{0}", String(prepareDone)).replace("{1}", String(prepareTotal)) : "";
        detail = t("Read the audio and confirm the file, format, and duration.");
      } else if (stage.id === "transcribe") {
        requests = lifecycleRequests;
        summary = [
          stage.status === "active" ? String(ip.transcribeLabel || "") : "",
          segmentTotal > 0 ? t("{0}/{1} files transcribed successfully").replace("{0}", String(processedSegments)).replace("{1}", String(segmentTotal)) : "",
          requestSummary.running ? t("{0} requests sent").replace("{0}", String(requestSummary.running)) : "",
          requestSummary.waiting ? t("{0} requests awaiting response").replace("{0}", String(requestSummary.waiting)) : "",
          requestSummary.slow ? t("{0} requests in progress").replace("{0}", String(requestSummary.slow)) : "",
          requestSummary.stalled ? t("{0} requests taking longer than expected").replace("{0}", String(requestSummary.stalled)) : "",
          requestSummary.retrying ? t("{0} requests waiting to retry").replace("{0}", String(requestSummary.retrying)) : "",
          failedSegments ? t("{0} files pending retry").replace("{0}", String(failedSegments)) : "",
        ].filter(Boolean).join(" · ");
        detail = String(ip.transcribeDetail || t("Each audio file is submitted separately; on failure the audio is kept and registered in the retry queue."));
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
        summary = segmentTotal > 0 ? t("{0}/{1} files written").replace("{0}", String(writtenSegments)).replace("{1}", String(segmentTotal)) : "";
        detail = t("The original transcription is written to the note in chronological order; it does not wait for the final minutes to be saved all at once.");
      } else if (stage.id === "organize") {
        summary = String(ip.organizeLabel || "");
        detail = String(ip.organizeDetail || t("Build the structured minutes from the original transcription that has already been written to disk."));
      } else if (stage.id === "write") {
        summary = String(ip.writeLabel || "");
        detail = String(ip.writeDetail || t("Write the organized result back to the note and finish updating the index."));
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
        let step = t("Preparing audio");
        let stepDetail = ip.file
          ? t("Reading and analyzing {0}").replace("{0}", ip.file)
          : t("Reading the audio and preparing the whole-file transcription task");
        let percent = null;
        let count = total > 1 ? t("File {0} / {1}").replace("{0}", String(n)).replace("{1}", String(total)) : "";
        if (phase === "prepare" && prepareTotal > 1) {
          percent = Math.max(0, Math.min(100, (prepareDone / prepareTotal) * 100));
          count = t("Prepared {0} / {1} files").replace("{0}", String(prepareDone)).replace("{1}", String(prepareTotal));
        }
        if (phase === "transcribe") {
          step = t("Speech transcription");
          const runningText = activeSegments > 0 ? t("{0} files are requesting the transcription service").replace("{0}", String(activeSegments)) : t("Waiting for the transcription service to respond");
          stepDetail = failedSegments > 0
            ? t("{0}; {1} files failed; they have been kept and queued for retry").replace("{0}", runningText).replace("{1}", String(failedSegments))
            : runningText;
          if (segmentTotal > 1) {
            percent = Math.max(0, Math.min(100, (processedSegments / segmentTotal) * 100));
            count = t("Succeeded {0} / {1} files").replace("{0}", String(processedSegments)).replace("{1}", String(segmentTotal));
          } else {
            count = segmentTotal === 1 && segmentDone > 0 ? t("The current audio has been transcribed") : t("Transcribing the current audio");
          }
        } else if (phase === "persist") {
          step = t("Writing the original transcription");
          stepDetail = t("Writing to the Obsidian note in chronological order; the original transcription will be fully preserved");
          if (segmentTotal > 0) {
            percent = Math.max(0, Math.min(100, (writtenSegments / segmentTotal) * 100));
            count = t("{0} / {1} segments written").replace("{0}", String(writtenSegments)).replace("{1}", String(segmentTotal));
          }
        } else if (phase === "organize") {
          step = String(ip.organizeLabel || t("AI Organize"));
          stepDetail = String(ip.organizeDetail || t("The original transcription has been kept; generating the final minutes"));
          percent = Number.isFinite(Number(ip.organizePercent)) ? Number(ip.organizePercent) : null;
          count = segmentTotal > 0 ? t("Transcription complete: {0} / {1} segments").replace("{0}", String(segmentDone)).replace("{1}", String(segmentTotal)) : "";
        } else if (phase === "write") {
          step = String(ip.writeLabel || t("Write to Minutes"));
          stepDetail = String(ip.writeDetail || t("Writing the organized result to Obsidian"));
          percent = Number.isFinite(Number(ip.writePercent)) ? Number(ip.writePercent) : null;
          count = segmentTotal > 0 ? t("{0} / {1} segments transcribed").replace("{0}", String(segmentDone)).replace("{1}", String(segmentTotal)) : "";
        }
        const stages = this.buildAudioImportActivityStages(ip, phase);
        const lifecycleEvents = Array.isArray(ip.events) ? ip.events : [];
        const activeStage = stages.find((stage) => stage.status === "active") || null;
        return {
          kind: t("Import transcription"),
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
          backgroundHint: t("The task will keep running in the background; you can close this window and keep using Obsidian"),
        };
      }
      return {
        kind: t("Import transcription"),
        modeLabel: modeLabelOf(ip.mode),
        step: t("Transcribing audio"),
        stepDetail: ip.file ? t("Current file: {0}").replace("{0}", ip.file) : t("Sending the audio to the transcription service"),
        percent: null,
        count: t("File {0} / {1}").replace("{0}", String(n)).replace("{1}", String(total)),
      };
    }
    // A) 批量转写处理（重试全部 / 整篇重转）——叠加 workProgress 子阶段
    const q = this.host.queue;
    if (q && Number(q._batchTotal) > 0) {
      const done = Math.min(Number(q._batchDone) || 0, Number(q._batchTotal));
      const wp = this.host.session && this.host.session.workProgress;
      return {
        kind: t("Batch transcription"),
        modeLabel: this.host.session ? modeLabelOf(this.host.session.mode) : "",
        step: (wp && wp.label) || t("Transcribing in progress"),
        stepDetail: (wp && wp.detail) || "",
        percent: pctOf(wp),
        count: t("{0} / {1} segments").replace("{0}", String(done)).replace("{1}", String(q._batchTotal)),
      };
    }
    // A2) 通用长操作（重新整理 / 整篇重新润色）
    if (this._busyLabel) {
      const context = this._busyContext && typeof this._busyContext === "object"
        ? this._busyContext
        : {};
      return {
        kind: String(context.kind || t("Re-organize")),
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
      const srcKind = s.source === "import" ? t("Import organization") : s.source === "text-import" ? t("Text organization") : t("Recording organization");
      if (s.finalizing) {
        return { kind: srcKind, modeLabel, step: (wp && wp.label) || t("AI organizing"), stepDetail: (wp && wp.detail) || "", percent: pct, count: "" };
      }
      const rec = this.host.recorder;
      const recState = rec && typeof rec.state === "string" ? rec.state : "idle";
      if (recState === "recording" || recState === "paused") {
        let elapsed = 0; try { elapsed = (rec.getInfo && rec.getInfo().elapsed) || 0; } catch { /* intentionally empty */ }
        const segN = Array.isArray(s.segments) ? s.segments.length : 0;
        const countTxt = segN ? t("{0} segments transcribed").replace("{0}", String(segN)) : "";
        if (recState === "paused") {
          return { kind: t("Active recording"), modeLabel, step: t("Recording paused · {0}").replace("{0}", formatElapsed(elapsed)), stepDetail: "", percent: null, count: countTxt };
        }
        if (Number(s.activeSegmentJobs) > 0) {
          return { kind: t("Active recording"), modeLabel, step: t("Recording {0} · Transcribing").replace("{0}", formatElapsed(elapsed)), stepDetail: (wp && wp.detail) || t("Transcribing the segmented audio"), percent: pct, count: countTxt };
        }
        return { kind: t("Active recording"), modeLabel, step: t("Recording · {0}").replace("{0}", formatElapsed(elapsed)), stepDetail: segN ? "" : t("Waiting for the first segment split"), percent: null, count: countTxt };
      }
      if (Number(s.activeSegmentJobs) > 0) {
        return { kind: srcKind, modeLabel, step: (wp && wp.label) || t("Transcription in progress"), stepDetail: (wp && wp.detail) || "", percent: pct, count: "" };
      }
    }
    return null;
  }
  // 记一笔"本次启动后已完成"的处理（供处理进度面板展示；不持久化，OB 重启清零）。
  logCompletedWork(title, detail, meter) {
    if (!Array.isArray(this.completedWorkLog)) this.completedWorkLog = [];
    const entry: CompletedWorkEntry = { title: String(title || t("Done")), detail: String(detail || ""), at: Date.now() };
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
