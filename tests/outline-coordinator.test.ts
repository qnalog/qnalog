import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RealtimeOutlineCoordinator,
  runInOutlineSessionTail,
  type OutlineCoordinatorRequest,
} from "../src/outline-coordinator";

describe("RealtimeOutlineCoordinator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function flushAsyncWork() {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  }

  function makeCoordinator(overrides: {
    evaluate?: (request: OutlineCoordinatorRequest) => { ready: boolean; retry?: boolean; delayMs?: number; reason?: string };
    execute?: (request: OutlineCoordinatorRequest) => Promise<unknown>;
    onFailure?: () => { retry: boolean; delayMs?: number; reason?: string };
  } = {}) {
    let sessionId = "s1";
    const execute = overrides.execute || vi.fn(async () => "ok");
    const coordinator = new RealtimeOutlineCoordinator({
      getActiveSessionId: () => sessionId,
      evaluate: overrides.evaluate || (() => ({ ready: true })),
      execute,
      onFailure: overrides.onFailure,
    }, {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
      clearTimeout: handle => clearTimeout(handle),
    });
    return { coordinator, execute, setSessionId: (value: string) => { sessionId = value; } };
  }

  it("keeps pending work while ASR is busy and resumes later", async () => {
    let busy = true;
    const { coordinator, execute } = makeCoordinator({
      evaluate: () => busy
        ? { ready: false, retry: true, delayMs: 2000, reason: "asr-busy" }
        : { ready: true },
    });

    coordinator.schedule({ sessionId: "s1", silent: true, reason: "segment" });
    expect(coordinator.getState().phase).toBe("backoff");
    expect(execute).not.toHaveBeenCalled();

    busy = false;
    await vi.advanceTimersByTimeAsync(2000);
    await vi.runAllTicks();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps the same incremental batch after a network failure", async () => {
    let calls = 0;
    const { coordinator } = makeCoordinator({
      execute: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("network error");
        return "ok";
      }),
      onFailure: () => ({ retry: true, delayMs: 30000, reason: "network-backoff" }),
    });

    coordinator.schedule({ sessionId: "s1", silent: true, reason: "segment" });
    await flushAsyncWork();
    expect(calls).toBe(1);
    expect(coordinator.getState().queued).toBe(1);

    await vi.advanceTimersByTimeAsync(30000);
    await flushAsyncWork();
    expect(calls).toBe(2);
  });

  it("coalesces repeated triggers while a run is active", async () => {
    let release!: () => void;
    const firstRun = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const { coordinator } = makeCoordinator({
      execute: vi.fn(async () => {
        calls += 1;
        if (calls === 1) await firstRun;
      }),
    });

    coordinator.schedule({ sessionId: "s1", silent: true, reason: "segment-1" });
    await flushAsyncWork();
    coordinator.schedule({ sessionId: "s1", silent: true, reason: "segment-2" });
    coordinator.schedule({ sessionId: "s1", silent: true, reason: "segment-3" });
    expect(coordinator.getState().queued).toBe(1);

    release();
    await flushAsyncWork();
    expect(calls).toBe(2);
  });

  it("drops stale pending work after the active session changes", async () => {
    const { coordinator, execute, setSessionId } = makeCoordinator();
    coordinator.schedule({ sessionId: "s1", silent: true, delayMs: 5000 });
    setSessionId("s2");
    coordinator.schedule({ sessionId: "s2", silent: true });
    await flushAsyncWork();
    expect(execute).toHaveBeenCalledTimes(1);
    expect((execute as ReturnType<typeof vi.fn>).mock.calls[0][0].sessionId).toBe("s2");
  });

  it("aborts the active request and clears pending work on cancel", async () => {
    let aborted = false;
    const { coordinator } = makeCoordinator({
      execute: vi.fn((request) => new Promise((resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("cancelled"));
        }, { once: true });
      })),
    });

    coordinator.schedule({ sessionId: "s1", silent: true });
    await flushAsyncWork();
    coordinator.schedule({ sessionId: "s1", silent: true, reason: "queued" });
    coordinator.cancel("s1");
    await flushAsyncWork();
    expect(aborted).toBe(true);
    expect(coordinator.getState().queued).toBe(0);
  });

  it("serializes read-modify-write tasks for the same session", async () => {
    const session = {};
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let active = 0;
    let maxActive = 0;
    const first = runInOutlineSessionTail(session, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await firstGate;
      active -= 1;
      return "first";
    });
    const second = runInOutlineSessionTail(session, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      return "second";
    });

    await flushAsyncWork();
    expect(maxActive).toBe(1);
    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(maxActive).toBe(1);
  });

  it("does not poison the session tail after a failed task", async () => {
    const session = {};
    const first = runInOutlineSessionTail(session, async () => {
      throw new Error("failed");
    });
    const second = runInOutlineSessionTail(session, async () => "recovered");

    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe("recovered");
  });
});
