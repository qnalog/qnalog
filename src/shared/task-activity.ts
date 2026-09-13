export type TaskActivityStatus =
  | "queued"
  | "running"
  | "waiting"
  | "slow"
  | "stalled"
  | "retrying"
  | "failed"
  | "cancelled"
  | "done";

export type TaskActivityErrorKind =
  | "configuration"
  | "authentication"
  | "rate-limit"
  | "timeout"
  | "network"
  | "empty-result"
  | "missing-input"
  | "cancelled"
  | "internal";

export type TaskActivityEvent = {
  id: string;
  at: number;
  type: string;
  label: string;
  detail: string;
};

export type TaskActivityAction = {
  id: string;
  label: string;
  primary?: boolean;
};

export type TaskActivity = {
  id: string;
  kind: string;
  title: string;
  subject: string;
  status: TaskActivityStatus;
  stage: string;
  stageLabel: string;
  detail: string;
  progress: number | null;
  count: string;
  attempt: number;
  maxAttempts: number;
  startedAt: number;
  updatedAt: number;
  deadlineAt: number;
  retryAt: number;
  completedAt: number;
  error: string;
  errorKind: TaskActivityErrorKind | "";
  actions: TaskActivityAction[];
  events: TaskActivityEvent[];
};

export type TaskActivityInput = Partial<Omit<TaskActivity, "id">> & {
  id: string;
};

type TaskActivityListener = (activities: TaskActivity[]) => void;

const TERMINAL_STATUSES = new Set<TaskActivityStatus>([
  "failed",
  "cancelled",
  "done",
]);

const ACTIVE_STATUSES = new Set<TaskActivityStatus>([
  "queued",
  "running",
  "waiting",
  "slow",
  "stalled",
  "retrying",
]);

function cleanText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).trim();
  }
  return "";
}

function isTaskActivityEvent(value: unknown): value is TaskActivityEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.id === "string"
    && typeof event.at === "number"
    && typeof event.type === "string"
    && typeof event.label === "string"
    && typeof event.detail === "string";
}

function normalizeTaskActivityStatus(value: unknown): TaskActivityStatus {
  return typeof value === "string" && (ACTIVE_STATUSES.has(value as TaskActivityStatus) || TERMINAL_STATUSES.has(value as TaskActivityStatus))
    ? value as TaskActivityStatus
    : "queued";
}

function normalizeTaskActivityErrorKind(value: unknown): TaskActivityErrorKind | "" {
  if (typeof value !== "string") return "";
  const kinds: TaskActivityErrorKind[] = [
    "configuration",
    "authentication",
    "rate-limit",
    "timeout",
    "network",
    "empty-result",
    "missing-input",
    "cancelled",
    "internal",
  ];
  return kinds.includes(value as TaskActivityErrorKind) ? value as TaskActivityErrorKind : "";
}

function finiteTimestamp(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function clampProgress(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
}

function normalizeActions(value: unknown): TaskActivityAction[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: TaskActivityAction[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const action = item as Partial<TaskActivityAction>;
    const id = cleanText(action.id);
    const label = cleanText(action.label);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, label, primary: !!action.primary });
  }
  return result;
}

export function getTaskErrorMessage(error: unknown, fallback = "任务执行失败"): string {
  if (error instanceof Error && error.message) return error.message.trim();
  if (error && typeof error === "object" && "message" in error) {
    const message = cleanText((error as { message?: unknown }).message);
    if (message) return message;
  }
  return cleanText(error) || fallback;
}

export function classifyTaskError(error: unknown): TaskActivityErrorKind {
  const message = getTaskErrorMessage(error, "").toLowerCase();
  const name = error instanceof Error ? cleanText(error.name).toLowerCase() : "";
  if (name === "aborterror" || /取消|cancel(?:led)?|aborted/.test(message)) return "cancelled";
  if (/401|403|unauthori[sz]ed|forbidden|api.?key|密钥|鉴权|认证/.test(message)) return "authentication";
  if (/429|rate.?limit|too many requests|限流|频率/.test(message)) return "rate-limit";
  if (/timeout|timed out|超时|deadline/.test(message)) return "timeout";
  if (/failed to fetch|network|econn|enotfound|socket|网络|连接/.test(message)) return "network";
  if (/empty|no (?:usable )?(?:text|output|result)|空结果|空文本|无输出|没有有效转写/.test(message)) return "empty-result";
  if (/not found|missing|不存在|找不到|缺少|无法读取/.test(message)) return "missing-input";
  if (/config|configuration|未配置|配置不完整|模型名称|endpoint|端点/.test(message)) return "configuration";
  return "internal";
}

export function getTaskErrorHint(kind: TaskActivityErrorKind | ""): string {
  const hints: Record<TaskActivityErrorKind, string> = {
    configuration: "请检查对应服务的地址、模型和功能配置。",
    authentication: "请检查 API Key、账号权限或登录状态。",
    "rate-limit": "服务正在限流。稍后重试，或降低并发与请求频率。",
    timeout: "服务在预期时间内没有返回。可重试，并检查网络或模型负载。",
    network: "请检查网络、代理和服务端是否可访问。",
    "empty-result": "服务已响应，但没有返回可用内容。原始材料会保留。",
    "missing-input": "任务所需的文件或输入已不存在，请重新选择来源。",
    cancelled: "任务已取消，原始材料不会因此删除。",
    internal: "任务遇到未预期异常。请打开诊断信息查看详细记录。",
  };
  return kind ? hints[kind] : "";
}

export function appendTaskActivityEvent(
  events: unknown,
  event: Partial<TaskActivityEvent>,
  limit = 80,
): TaskActivityEvent[] {
  const at = finiteTimestamp(event.at) || Date.now();
  const type = cleanText(event.type) || "update";
  const label = cleanText(event.label) || "任务状态已更新";
  const next: TaskActivityEvent = {
    id: cleanText(event.id) || `${at}:${type}:${label}`,
    at,
    type,
    label,
    detail: cleanText(event.detail),
  };
  const previous = Array.isArray(events)
    ? events.filter(isTaskActivityEvent)
    : [];
  return previous.concat(next).slice(-Math.max(1, Math.floor(limit)));
}

export function createTaskActivity(input: TaskActivityInput, now = Date.now()): TaskActivity {
  const startedAt = finiteTimestamp(input.startedAt) || now;
  const status = normalizeTaskActivityStatus(input.status);
  const error = cleanText(input.error);
  const errorKind = normalizeTaskActivityErrorKind(input.errorKind)
    || (error ? classifyTaskError(error) : "");
  return {
    id: cleanText(input.id),
    kind: cleanText(input.kind) || "task",
    title: cleanText(input.title) || "后台任务",
    subject: cleanText(input.subject),
    status,
    stage: cleanText(input.stage),
    stageLabel: cleanText(input.stageLabel),
    detail: cleanText(input.detail),
    progress: clampProgress(input.progress),
    count: cleanText(input.count),
    attempt: Math.max(0, Math.floor(Number(input.attempt) || 0)),
    maxAttempts: Math.max(0, Math.floor(Number(input.maxAttempts) || 0)),
    startedAt,
    updatedAt: finiteTimestamp(input.updatedAt) || now,
    deadlineAt: finiteTimestamp(input.deadlineAt),
    retryAt: finiteTimestamp(input.retryAt),
    completedAt: TERMINAL_STATUSES.has(status)
      ? finiteTimestamp(input.completedAt) || now
      : finiteTimestamp(input.completedAt),
    error,
    errorKind,
    actions: normalizeActions(input.actions),
    events: Array.isArray(input.events) ? input.events.slice(-80) : [],
  };
}

export function patchTaskActivity(
  current: TaskActivity,
  patch: Partial<TaskActivity>,
  now = Date.now(),
): TaskActivity {
  const nextStatus = normalizeTaskActivityStatus(patch.status ?? current.status);
  const hasError = "error" in patch;
  const error = hasError ? cleanText(patch.error) : current.error;
  const errorKind = patch.errorKind !== undefined
    ? normalizeTaskActivityErrorKind(patch.errorKind)
    : error
      ? classifyTaskError(error)
      : "";
  return {
    ...current,
    ...patch,
    id: current.id,
    status: nextStatus,
    title: patch.title !== undefined ? cleanText(patch.title) : current.title,
    subject: patch.subject !== undefined ? cleanText(patch.subject) : current.subject,
    stage: patch.stage !== undefined ? cleanText(patch.stage) : current.stage,
    stageLabel: patch.stageLabel !== undefined ? cleanText(patch.stageLabel) : current.stageLabel,
    detail: patch.detail !== undefined ? cleanText(patch.detail) : current.detail,
    count: patch.count !== undefined ? cleanText(patch.count) : current.count,
    progress: Object.prototype.hasOwnProperty.call(patch, "progress")
      ? clampProgress(patch.progress)
      : current.progress,
    attempt: patch.attempt !== undefined
      ? Math.max(0, Math.floor(Number(patch.attempt) || 0))
      : current.attempt,
    maxAttempts: patch.maxAttempts !== undefined
      ? Math.max(0, Math.floor(Number(patch.maxAttempts) || 0))
      : current.maxAttempts,
    updatedAt: finiteTimestamp(patch.updatedAt) || now,
    deadlineAt: patch.deadlineAt === 0 ? 0 : finiteTimestamp(patch.deadlineAt) || current.deadlineAt,
    retryAt: patch.retryAt === 0 ? 0 : finiteTimestamp(patch.retryAt) || current.retryAt,
    completedAt: TERMINAL_STATUSES.has(nextStatus)
      ? finiteTimestamp(patch.completedAt) || current.completedAt || now
      : 0,
    error,
    errorKind,
    actions: patch.actions !== undefined ? normalizeActions(patch.actions) : current.actions,
    events: Array.isArray(patch.events) ? patch.events.slice(-80) : current.events,
  };
}

export function deriveTaskActivityStatus(
  activity: TaskActivity,
  now = Date.now(),
  options: { slowAfterMs?: number; stalledAfterMs?: number } = {},
): TaskActivityStatus {
  if (TERMINAL_STATUSES.has(activity.status)) return activity.status;
  if (activity.status === "retrying" && activity.retryAt > now) return "retrying";
  if (activity.deadlineAt > 0 && now > activity.deadlineAt) return "stalled";
  if (activity.status === "queued") return "queued";

  const quietFor = Math.max(0, now - (activity.updatedAt || activity.startedAt || now));
  const slowAfterMs = Math.max(5_000, Number(options.slowAfterMs) || 30_000);
  const stalledAfterMs = Math.max(slowAfterMs + 1, Number(options.stalledAfterMs) || 120_000);
  if (quietFor >= stalledAfterMs) return "stalled";
  if (quietFor >= slowAfterMs) return "slow";
  if (activity.status === "waiting" || activity.status === "retrying") return activity.status;
  return "running";
}

export function isTaskActivityActive(activity: TaskActivity): boolean {
  return ACTIVE_STATUSES.has(activity.status);
}

export class TaskActivityStore {
  private readonly activities = new Map<string, TaskActivity>();
  private readonly listeners = new Set<TaskActivityListener>();
  private sequence = 0;

  subscribe(listener: TaskActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(input: Omit<TaskActivityInput, "id"> & { id?: string }): TaskActivity {
    const now = Date.now();
    const id = cleanText(input.id) || `task-${now.toString(36)}-${(++this.sequence).toString(36)}`;
    const existing = this.activities.get(id);
    const activity = existing
      ? patchTaskActivity(existing, {
        ...input,
        status: input.status || "running",
        startedAt: input.startedAt || existing.startedAt || now,
        completedAt: 0,
        error: input.error || "",
        errorKind: input.errorKind || "",
      }, now)
      : createTaskActivity({ ...input, id, status: input.status || "running" }, now);
    this.activities.set(id, activity);
    this.emit();
    return { ...activity, events: activity.events.slice(), actions: activity.actions.slice() };
  }

  patch(id: string, patch: Partial<TaskActivity>): TaskActivity | null {
    const current = this.activities.get(id);
    if (!current) return null;
    const next = patchTaskActivity(current, patch);
    this.activities.set(id, next);
    this.emit();
    return { ...next, events: next.events.slice(), actions: next.actions.slice() };
  }

  event(id: string, event: Partial<TaskActivityEvent>): TaskActivity | null {
    const current = this.activities.get(id);
    if (!current) return null;
    return this.patch(id, {
      updatedAt: finiteTimestamp(event.at) || Date.now(),
      events: appendTaskActivityEvent(current.events, event),
    });
  }

  heartbeat(id: string, patch: Partial<TaskActivity> = {}): TaskActivity | null {
    return this.patch(id, { ...patch, updatedAt: Date.now() });
  }

  fail(id: string, error: unknown, patch: Partial<TaskActivity> = {}): TaskActivity | null {
    const message = getTaskErrorMessage(error);
    return this.patch(id, {
      ...patch,
      status: "failed",
      error: message,
      errorKind: classifyTaskError(error),
      completedAt: Date.now(),
    });
  }

  complete(id: string, patch: Partial<TaskActivity> = {}): TaskActivity | null {
    return this.patch(id, {
      ...patch,
      status: "done",
      progress: patch.progress === null ? null : (patch.progress ?? 100),
      completedAt: Date.now(),
      error: "",
      errorKind: "",
    });
  }

  cancel(id: string, detail = "任务已取消"): TaskActivity | null {
    return this.patch(id, {
      status: "cancelled",
      detail,
      completedAt: Date.now(),
      error: "",
      errorKind: "cancelled",
    });
  }

  remove(id: string): void {
    if (!this.activities.delete(id)) return;
    this.emit();
  }

  get(id: string, now = Date.now()): TaskActivity | null {
    const activity = this.activities.get(id);
    if (!activity) return null;
    return this.withDerivedStatus(activity, now);
  }

  list(options: {
    includeDone?: boolean;
    includeCancelled?: boolean;
    now?: number;
  } = {}): TaskActivity[] {
    const now = options.now || Date.now();
    return Array.from(this.activities.values())
      .map((activity) => this.withDerivedStatus(activity, now))
      .filter((activity) => options.includeDone || activity.status !== "done")
      .filter((activity) => options.includeCancelled || activity.status !== "cancelled")
      .sort((a, b) => {
        const priority = (status: TaskActivityStatus): number => ({
          failed: 0,
          stalled: 1,
          running: 2,
          slow: 3,
          waiting: 4,
          retrying: 5,
          queued: 6,
          cancelled: 7,
          done: 8,
        }[status]);
        return priority(a.status) - priority(b.status) || b.updatedAt - a.updatedAt;
      });
  }

  prune(options: { doneAfterMs?: number; cancelledAfterMs?: number; now?: number } = {}): void {
    const now = options.now || Date.now();
    const doneAfterMs = Math.max(0, Number(options.doneAfterMs) || 10 * 60_000);
    const cancelledAfterMs = Math.max(0, Number(options.cancelledAfterMs) || 5 * 60_000);
    let changed = false;
    for (const [id, activity] of this.activities) {
      const age = Math.max(0, now - (activity.completedAt || activity.updatedAt || now));
      if ((activity.status === "done" && age >= doneAfterMs)
        || (activity.status === "cancelled" && age >= cancelledAfterMs)) {
        this.activities.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private withDerivedStatus(activity: TaskActivity, now: number): TaskActivity {
    const status = deriveTaskActivityStatus(activity, now);
    return {
      ...activity,
      status,
      events: activity.events.slice(),
      actions: activity.actions.slice(),
    };
  }

  private emit(): void {
    const snapshot = this.list({ includeDone: true, includeCancelled: true });
    for (const listener of this.listeners) listener(snapshot);
  }
}
