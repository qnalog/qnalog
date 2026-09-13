export type LlmQueueItem<T = unknown> = {
  priority: number;
  seq: number;
  enqueuedAt: number;
  run: () => Promise<T> | T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  detachAbort?: () => void;
};

export type LlmRequestQueueOptions = {
  now?: () => number;
  backgroundMaxWaitMs?: number;
};

export const DEFAULT_BACKGROUND_MAX_WAIT_MS = 15_000;

export function createQueueAbortError(): Error {
  const error = new Error("LLM request cancelled");
  error.name = "AbortError";
  return error;
}

export class LlmRequestQueue {
  items: LlmQueueItem[] = [];
  running = 0;
  seq = 0;
  private readonly now: () => number;
  private readonly backgroundMaxWaitMs: number;

  constructor(options: LlmRequestQueueOptions = {}) {
    this.now = options.now || (() => Date.now());
    this.backgroundMaxWaitMs = Math.max(
      1_000,
      Math.round(Number(options.backgroundMaxWaitMs) || DEFAULT_BACKGROUND_MAX_WAIT_MS)
    );
  }

  enqueue<T>(priority: number, run: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(createQueueAbortError());
    return new Promise<T>((resolve, reject) => {
      const parsedPriority = Number(priority);
      const item: LlmQueueItem<T> = {
        priority: Number.isFinite(parsedPriority) ? parsedPriority : 1,
        seq: ++this.seq,
        enqueuedAt: this.now(),
        run,
        resolve,
        reject,
        signal,
      };
      if (signal) {
        const onAbort = () => {
          const index = this.items.indexOf(item);
          if (index < 0) return;
          this.items.splice(index, 1);
          item.detachAbort?.();
          reject(createQueueAbortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        item.detachAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.items.push(item);
      this.pump();
    });
  }

  pump(): void {
    if (this.running > 0) return;
    const now = this.now();
    // Priority 0 is an explicit user action and must always run before queued
    // background work. A long-waiting realtime outline may move ahead of normal
    // automatic work, but never ahead of a question or a user-triggered rewrite.
    const hasInteractive = this.items.some((item) => item.priority === 0);
    const overdueBackground = this.items
      .filter((item) =>
        item.priority === 2
        && now - item.enqueuedAt >= this.backgroundMaxWaitMs
      )
      .sort((a, b) => a.seq - b.seq)[0];
    let next: LlmQueueItem | undefined;
    if (!hasInteractive && overdueBackground) {
      const index = this.items.indexOf(overdueBackground);
      next = index >= 0 ? this.items.splice(index, 1)[0] : undefined;
    } else {
      next = this.items
        .sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq))
        .shift();
    }
    if (!next) return;
    next.detachAbort?.();
    this.running += 1;
    void Promise.resolve()
      .then(() => {
        if (next.signal?.aborted) throw createQueueAbortError();
        return next.run();
      })
      .then(next.resolve, next.reject)
      .finally(() => {
        this.running = Math.max(0, this.running - 1);
        this.pump();
      });
  }
}
