import { describe, expect, it, vi } from "vitest";
import type { RecordingSession } from "../src/shared/types";
import { finalizeSessionFlow, type SessionFinalizeFlowHost } from "../src/notes/session-finalize-flow";

function makeSession(): RecordingSession {
  return {
    id: "session-1",
    sessionStamp: "20261006-120000",
    startedAt: "2026-10-06T12:00:00.000Z",
    mdPath: "QnALog/转写纪要/session.md",
    mode: "synthesis",
    segments: [],
    finalized: false,
    transcript: undefined,
  } as RecordingSession;
}

function makeHost(overrides: Partial<SessionFinalizeFlowHost> = {}): SessionFinalizeFlowHost {
  return {
    runFinalizer: async () => undefined,
    reportFailure: async () => undefined,
    settleContinuation: () => undefined,
    releaseSession: () => undefined,
    ...overrides,
  };
}

describe("session finalize flow", () => {
  it("shares one in-flight finalization and marks completion only after its write resolves", async () => {
    const session = makeSession();
    const gate = Promise.withResolvers<void>();
    let revisions = 0;
    const flow = makeHost({ runFinalizer: async () => { revisions++; await gate.promise; } });
    const first = finalizeSessionFlow(flow, session);
    expect(session.finalized).toBe(false);
    expect(session.finalizePromise).toBeDefined();
    const second = finalizeSessionFlow(flow, session);
    gate.resolve();
    await Promise.all([first, second]);
    expect(revisions).toBe(1);
    expect(session).toMatchObject({ finalized: true, finalizationError: "", finalizePromise: null });
    await finalizeSessionFlow(flow, session);
    expect(revisions).toBe(1);
  });

  it("retains failure state and permits a later same-session retry", async () => {
    const session = makeSession();
    session.segments = [{ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "kept transcript", audioPath: "kept.webm" }];
    let attempt = 0;
    const host = makeHost({
      runFinalizer: async () => { if (attempt++ === 0) throw new Error("write failed"); },
    });
    await finalizeSessionFlow(host, session);
    expect(session).toMatchObject({ finalized: false, finalizing: false, finalizationError: "write failed", finalizePromise: null });
    expect(session.segments[0]?.text).toBe("kept transcript");
    await finalizeSessionFlow(host, session);
    expect(session).toMatchObject({ finalized: true, finalizationError: "", finalizePromise: null });
    expect(attempt).toBe(2);
  });

  it("lets a reentrant caller finish with the inner finalizer while outer settlement remains pending", async () => {
    const session = makeSession();
    const finalizer = Promise.withResolvers<void>();
    const settlement = Promise.withResolvers<void>();
    const host = makeHost({
      runFinalizer: () => finalizer.promise,
      settleContinuation: () => settlement.promise,
    });
    const outer = finalizeSessionFlow(host, session);
    const inner = finalizeSessionFlow(host, session);
    finalizer.resolve();
    await inner;
    expect(session.finalized).toBe(true);
    expect(session.finalizePromise).not.toBeNull();
    let outerFinished = false;
    void outer.then(() => { outerFinished = true; });
    await Promise.resolve();
    expect(outerFinished).toBe(false);
    settlement.resolve();
    await outer;
    expect(session.finalizePromise).toBeNull();
  });

  it("does not clear a replacement promise installed during settlement", async () => {
    const session = makeSession();
    const replacement = Promise.withResolvers<void>();
    const host = makeHost({ settleContinuation: () => { session.finalizePromise = replacement.promise; return undefined; } });
    await finalizeSessionFlow(host, session);
    expect(session.finalizePromise).toBe(replacement.promise);
  });

  it("releases synchronously when no settlement exists and propagates release errors", async () => {
    const session = makeSession();
    const events: string[] = [];
    await finalizeSessionFlow(makeHost({ releaseSession: () => { events.push("release"); } }), session);
    expect(events).toEqual(["release"]);
    expect(session.finalizePromise).toBeNull();

    const brokenSession = makeSession();
    await expect(finalizeSessionFlow(makeHost({ releaseSession: () => { throw new Error("release failed"); } }), brokenSession))
      .rejects.toThrow("release failed");
    expect(brokenSession.finalized).toBe(true);
    expect(brokenSession.finalizePromise).not.toBeNull();
  });
});
