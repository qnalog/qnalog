export type OutlineCoordinatorPhase = "idle" | "scheduled" | "running" | "backoff";

export type OutlineCoordinatorRequest = {
  sessionId: string;
  silent?: boolean;
  force?: boolean;
  final?: boolean;
  reason?: string;
  delayMs?: number;
  timeoutMs?: number;
  maxTokens?: number;
  local?: boolean;
  signal?: AbortSignal;
};

export type OutlineReadiness = {
  ready: boolean;
  retry?: boolean;
  delayMs?: number;
  reason?: string;
};

export type OutlineRetryDecision = {
  retry: boolean;
  delayMs?: number;
  reason?: string;
};

export type OutlineCoordinatorState = {
  phase: OutlineCoordinatorPhase;
  sessionId: string;
  runId: number;
  queued: number;
  reason: string;
  startedAt: number;
  nextRunAt: number;
  lastError: string;
};

type PendingRequest = {
  request: OutlineCoordinatorRequest;
  background: boolean;
  notBefore: number;
  seq: number;
  resolve?: (value: unknown) => void;
  reject?: (reason?: unknown) => void;
};

type TimerHandle = number;

type TimerApi = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

type CoordinatorHooks = {
  getActiveSessionId: () => string;
  evaluate: (request: OutlineCoordinatorRequest) => OutlineReadiness;
  execute: (request: OutlineCoordinatorRequest) => Promise<unknown>;
  onFailure?: (request: OutlineCoordinatorRequest, error: unknown) => OutlineRetryDecision;
  onStateChange?: (state: OutlineCoordinatorState) => void;
};

export type OutlineSessionTail = {
  _outlineGenTail?: Promise<void>;
};

export function runInOutlineSessionTail<T>(
  session: OutlineSessionTail,
  task: () => Promise<T>
): Promise<T> {
  const previous = session._outlineGenTail ?? Promise.resolve();
  const run = Promise.resolve(previous)
    .catch(() => undefined)
    .then(task);
  session._outlineGenTail = run.then<void>(() => undefined, () => undefined);
  return run;
}

const DEFAULT_TIMER_API: TimerApi = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

function requestPriority(request: OutlineCoordinatorRequest): number {
  if (request.final) return 0;
  if (request.force || !request.silent) return 1;
  return 2;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

function mergeBackgroundRequest(
  current: OutlineCoordinatorRequest,
  incoming: OutlineCoordinatorRequest
): OutlineCoordinatorRequest {
  return {
    ...current,
    ...incoming,
    silent: current.silent !== false && incoming.silent !== false,
    force: !!(current.force || incoming.force),
    final: !!(current.final || incoming.final),
    reason: incoming.reason || current.reason,
  };
}

export class RealtimeOutlineCoordinator {
  private readonly hooks: CoordinatorHooks;
  private readonly timerApi: TimerApi;
  private pending: PendingRequest[] = [];
  private timer: TimerHandle | null = null;
  private runningItem: PendingRequest | null = null;
  private runningAbort: AbortController | null = null;
  private seq = 0;
  private runSeq = 0;
  private disposed = false;
  private state: OutlineCoordinatorState = {
    phase: "idle",
    sessionId: "",
    runId: 0,
    queued: 0,
    reason: "",
    startedAt: 0,
    nextRunAt: 0,
    lastError: "",
  };

  constructor(hooks: CoordinatorHooks, timerApi: Partial<TimerApi> = {}) {
    this.hooks = hooks;
    this.timerApi = { ...DEFAULT_TIMER_API, ...timerApi };
  }

  getState(): OutlineCoordinatorState {
    return { ...this.state, queued: this.pending.length };
  }

  schedule(request: OutlineCoordinatorRequest): void {
    if (this.disposed || !request.sessionId) return;
    const now = this.timerApi.now();
    const notBefore = now + Math.max(0, Math.round(Number(request.delayMs) || 0));
    const existing = this.pending.find((item) =>
      item.background
      && item.request.sessionId === request.sessionId
      && requestPriority(item.request) === requestPriority(request)
    );
    if (existing) {
      existing.request = mergeBackgroundRequest(existing.request, request);
      // New work may move a check earlier, but must not postpone an existing retry.
      existing.notBefore = Math.min(existing.notBefore, notBefore);
    } else {
      this.pending.push({
        request: { ...request },
        background: true,
        notBefore,
        seq: ++this.seq,
      });
    }
    this.pump();
  }

  request(request: OutlineCoordinatorRequest): Promise<unknown> {
    if (this.disposed || !request.sessionId) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      this.pending.push({
        request: { ...request },
        background: false,
        notBefore: this.timerApi.now() + Math.max(0, Math.round(Number(request.delayMs) || 0)),
        seq: ++this.seq,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  cancel(sessionId: string): void {
    if (!sessionId) return;
    const keep: PendingRequest[] = [];
    for (const item of this.pending) {
      if (item.request.sessionId === sessionId) item.resolve?.(undefined);
      else keep.push(item);
    }
    this.pending = keep;
    if (this.runningItem && this.runningItem.request.sessionId === sessionId) {
      this.runningAbort?.abort();
    }
    this.clearTimer();
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.runningAbort?.abort();
    for (const item of this.pending) item.resolve?.(undefined);
    this.pending = [];
    this.setState({ phase: "idle", queued: 0, reason: "disposed", nextRunAt: 0 });
  }

  private setState(patch: Partial<OutlineCoordinatorState>): void {
    this.state = { ...this.state, ...patch, queued: this.pending.length };
    try { this.hooks.onStateChange?.(this.getState()); } catch { /* state observers must not break scheduling */ }
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timerApi.clearTimeout(this.timer);
    this.timer = null;
  }

  private armTimer(delayMs: number, reason: string, phase: OutlineCoordinatorPhase = "scheduled"): void {
    this.clearTimer();
    const delay = Math.max(1, Math.round(Number(delayMs) || 1));
    this.setState({
      phase,
      reason,
      nextRunAt: this.timerApi.now() + delay,
      sessionId: this.hooks.getActiveSessionId() || this.state.sessionId,
    });
    this.timer = this.timerApi.setTimeout(() => {
      this.timer = null;
      this.pump();
    }, delay);
  }

  private dropStaleRequests(): void {
    const activeSessionId = this.hooks.getActiveSessionId();
    const keep: PendingRequest[] = [];
    for (const item of this.pending) {
      if (!activeSessionId || item.request.sessionId !== activeSessionId) item.resolve?.(undefined);
      else keep.push(item);
    }
    this.pending = keep;
  }

  private pump(): void {
    if (this.disposed || this.runningItem) return;
    this.dropStaleRequests();
    if (!this.pending.length) {
      this.clearTimer();
      this.setState({ phase: "idle", reason: "", nextRunAt: 0, startedAt: 0 });
      return;
    }

    this.pending.sort((a, b) =>
      (requestPriority(a.request) - requestPriority(b.request))
      || (a.notBefore - b.notBefore)
      || (a.seq - b.seq)
    );
    const item = this.pending[0];
    const now = this.timerApi.now();
    if (item.notBefore > now) {
      this.armTimer(item.notBefore - now, item.request.reason || "scheduled");
      return;
    }

    const readiness = this.hooks.evaluate(item.request);
    if (!readiness.ready) {
      if (readiness.retry) {
        const delay = Math.max(1, Math.round(Number(readiness.delayMs) || 1000));
        item.notBefore = now + delay;
        this.armTimer(delay, readiness.reason || "waiting", "backoff");
        return;
      }
      this.pending.shift();
      item.resolve?.(undefined);
      this.setState({ reason: readiness.reason || "not-runnable" });
      queueMicrotask(() => this.pump());
      return;
    }

    this.pending.shift();
    this.start(item);
  }

  private start(item: PendingRequest): void {
    this.clearTimer();
    this.runningItem = item;
    this.runningAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
    const request = {
      ...item.request,
      signal: this.runningAbort ? this.runningAbort.signal : undefined,
    };
    const runId = ++this.runSeq;
    this.setState({
      phase: "running",
      sessionId: request.sessionId,
      runId,
      reason: request.reason || (request.final ? "final" : request.force ? "manual" : "background"),
      startedAt: this.timerApi.now(),
      nextRunAt: 0,
      lastError: "",
    });

    void Promise.resolve()
      .then(() => this.hooks.execute(request))
      .then((value) => item.resolve?.(value))
      .catch((error: unknown) => {
        const cancelled = !!(this.runningAbort && this.runningAbort.signal.aborted);
        if (!cancelled) {
          const decision = this.hooks.onFailure?.(request, error) || { retry: false };
          if (item.background && decision.retry && request.sessionId === this.hooks.getActiveSessionId()) {
            item.notBefore = this.timerApi.now() + Math.max(1, Math.round(Number(decision.delayMs) || 1000));
            item.request.reason = decision.reason || "retry";
            this.pending.push(item);
          }
          this.setState({ lastError: errorText(error), reason: decision.reason || "failed" });
        }
        if (!item.background) item.reject?.(error);
      })
      .finally(() => {
        this.runningItem = null;
        this.runningAbort = null;
        this.setState({ phase: "idle", startedAt: 0, nextRunAt: 0 });
        this.pump();
      });
  }
}
