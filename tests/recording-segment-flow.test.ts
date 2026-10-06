import { describe, expect, it } from "vitest";
import type { PreparedLiveSegment, QueueTask, RecorderSegmentPayload, RecordingSession } from "../src/shared/types";
import { handleRecordedSegment, type RecordingSegmentHost } from "../src/audio/recording-segment-flow";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSession(): RecordingSession {
  return {
    id: "session-1",
    sessionStamp: "20261006-120000",
    startedAt: "2026-10-06T12:00:00.000Z",
    mdPath: "QnALog/notes/session.md",
    mode: "synthesis",
    segments: [{ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "earlier segment" }],
    finalized: false,
    writeQueue: Promise.resolve(),
    activeSegmentJobs: 0,
    pendingMeetingWorkbenchInteractions: [],
  };
}

function payload(index: number, isFinal = false): RecorderSegmentPayload {
  return {
    blob: new Blob([`segment-${index}`], { type: "audio/webm" }),
    index,
    startOffsetMs: index * 1000,
    endOffsetMs: (index + 1) * 1000,
    isFinal,
    ext: "webm",
    masterBlob: new Blob([`master-${index}`], { type: "audio/webm" }),
  };
}

function makeHost(options: {
  saveSegment?: (path: string, blob: Blob) => Promise<void>;
  saveMaster?: (index: number, blob: Blob) => Promise<void>;
  process?: (segment: PreparedLiveSegment) => Promise<void>;
  finalize?: () => Promise<void>;
  filterShortRecordings?: () => boolean;
} = {}): { host: RecordingSegmentHost; cached: Map<string, string>; masters: string[]; tasks: Map<string, Pick<QueueTask, "status"> & { lastError?: string }>; processOrder: number[]; diagnostics: unknown[] } {
  const cached = new Map<string, string>();
  const masters: string[] = [];
  const tasks = new Map<string, Pick<QueueTask, "status"> & { lastError?: string }>();
  const processOrder: number[] = [];
  const diagnostics: unknown[] = [];
  const host: RecordingSegmentHost = {
    getFilterShortRecordings: options.filterShortRecordings ?? (() => true),
    startMasterAudioSave: async (_session, seg) => {
      if (seg.masterBlob) {
        if (options.saveMaster) await options.saveMaster(seg.index, seg.masterBlob);
        masters.push(await seg.masterBlob.text());
      }
    },
    beginSessionSegmentWork: (session) => { session.activeSegmentJobs = (session.activeSegmentJobs ?? 0) + 1; },
    prepareLiveSegmentDescriptor: (_session, seg) => ({
      jobId: `job-${seg.index}`,
      queueTaskId: `task-${seg.index}`,
      segmentAudioPath: `cache/segment-${seg.index}.webm`,
      isFinal: seg.isFinal,
      endOffsetMs: seg.endOffsetMs,
    }),
    queueLiveSegmentPersistence: async (_session, descriptor, blob) => {
      if (!tasks.has(descriptor.queueTaskId ?? "")) tasks.set(descriptor.queueTaskId ?? "", { status: "live" });
      if (options.saveSegment) await options.saveSegment(descriptor.segmentAudioPath ?? "", blob);
      cached.set(descriptor.segmentAudioPath ?? "", await blob.text());
    },
    getQueueTask: (id) => tasks.get(id),
    keepLiveSegmentQueueTaskForRetry: async (_session, descriptor, error) => {
      const reason = error instanceof Error ? error.message : String(error);
      diagnostics.push(reason);
      tasks.set(descriptor.queueTaskId ?? "", { status: "pending", lastError: reason });
      return undefined;
    },
    markSessionAsrJobsDeferred: () => undefined,
    finishSessionSegmentWork: (session) => { session.activeSegmentJobs = Math.max(0, (session.activeSegmentJobs ?? 1) - 1); },
    scheduleMeetingWorkbenchInteraction: () => undefined,
    logDiagnostic: async (_level, _code, _message, data) => { diagnostics.push(data); },
    processRecordedSegment: async (_session, segment) => {
      processOrder.push(segment.endOffsetMs ?? -1);
      if (options.process) await options.process(segment);
    },
    finalizeRecordedSession: options.finalize ?? (async () => undefined),
  };
  return { host, cached, masters, tasks, processOrder, diagnostics };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
async function flushUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !condition(); attempt += 1) await Promise.resolve();
  expect(condition()).toBe(true);
}

describe("recording segment delivery", () => {
  it("ordinary cuts release their blobs after both saves, without waiting for transcription", async () => {
    const spool = deferred<void>();
    const master = deferred<void>();
    const prior = deferred<void>();
    const processing = deferred<void>();
    const fixture = makeHost({
      saveSegment: async () => spool.promise,
      saveMaster: async () => master.promise,
      process: async () => processing.promise,
    });
    const session = makeSession();
    session.writeQueue = prior.promise;
    let returned = false;

    const returnedPromise = handleRecordedSegment(fixture.host, session, payload(0));
    if (!returnedPromise) throw new Error("ordinary segment unexpectedly skipped");
    void returnedPromise.then(() => { returned = true; });
    await flushMicrotasks();
    expect(returned).toBe(false);
    expect(fixture.cached.size).toBe(0);
    expect(fixture.masters).toEqual([]);

    spool.resolve();
    await flushUntil(() => fixture.cached.has("cache/segment-0.webm"));
    expect(returned).toBe(false);
    expect(fixture.cached.get("cache/segment-0.webm")).toBe("segment-0");
    expect(fixture.masters).toEqual([]);

    master.resolve();
    await returnedPromise;
    expect(returned).toBe(true);
    expect(fixture.masters).toEqual(["master-0"]);
    expect(fixture.processOrder).toEqual([]);

    prior.resolve();
    await flushMicrotasks();
    expect(fixture.processOrder).toEqual([1000]);
    processing.resolve();
    await session.writeQueue;
  });

  it("final cuts preserve serial processing and wait separately for session finalization", async () => {
    const processGates = [deferred<void>(), deferred<void>()];
    const finalizeGate = deferred<void>();
    let started = 0;
    let didFinalize = false;
    const fixture = makeHost({
      process: async () => {
        const gate = processGates[started++];
        if (gate) await gate.promise;
      },
      finalize: () => {
        didFinalize = true;
        return finalizeGate.promise;
      },
    });
    const session = makeSession();

    const firstReturn = handleRecordedSegment(fixture.host, session, payload(0));
    if (!firstReturn) throw new Error("ordinary segment unexpectedly skipped");
    await firstReturn;
    await flushMicrotasks();
    expect(started).toBe(1);

    let finalReturned = false;
    const finalReturn = handleRecordedSegment(fixture.host, session, payload(1, true));
    if (!finalReturn) throw new Error("final segment unexpectedly skipped");
    void finalReturn.then(() => { finalReturned = true; });
    await flushMicrotasks();
    expect(started).toBe(1);
    expect(finalReturned).toBe(false);

    processGates[0].resolve();
    await flushUntil(() => started === 2);
    expect(fixture.processOrder).toEqual([1000, 2000]);
    expect(finalReturned).toBe(false);

    processGates[1].resolve();
    await flushUntil(() => didFinalize);
    expect(finalReturned).toBe(false);
    finalizeGate.resolve();
    await finalReturn;
    expect(finalReturned).toBe(true);
  });

  it("recovers a rejected prior chain, preserves failed material for retry, and does not replace terminal tasks", async () => {
    let failuresRemaining = 2;
    const fixture = makeHost({ process: async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("transcription failed");
      }
    } });
    const session = makeSession();
    const first = payload(0);

    const firstReturn = handleRecordedSegment(fixture.host, session, first);
    if (!firstReturn) throw new Error("ordinary segment unexpectedly skipped");
    await firstReturn;
    await session.writeQueue;
    expect(fixture.cached.get("cache/segment-0.webm")).toBe("segment-0");
    expect(fixture.tasks.get("task-0")).toEqual({ status: "pending", lastError: "transcription failed" });
    expect(fixture.diagnostics).toContain("transcription failed");
    expect(session.activeSegmentJobs).toBe(0);

    fixture.tasks.set("task-1", { status: "failed", lastError: "older failure" });
    const next = payload(1);
    const nextReturn = handleRecordedSegment(fixture.host, session, next);
    if (!nextReturn) throw new Error("next segment unexpectedly skipped");
    await nextReturn;
    await session.writeQueue;
    expect(fixture.cached.get("cache/segment-1.webm")).toBe("segment-1");
    expect(fixture.tasks.get("task-1")).toEqual({ status: "failed", lastError: "older failure" });

    session.writeQueue = Promise.reject(new Error("earlier write chain failed"));
    const finalReturn = handleRecordedSegment(fixture.host, session, payload(2, true));
    if (!finalReturn) throw new Error("final segment unexpectedly skipped");
    await finalReturn;
    expect(fixture.processOrder).toEqual([1000, 2000, 3000]);
    expect(session.activeSegmentJobs).toBe(0);
  });

  it("runs finalization through the rejected-chain branch when finally accounting rejects", async () => {
    let finishCalls = 0;
    let finalized = false;
    const fixture = makeHost({ finalize: async () => { finalized = true; } });
    const baseFinish = fixture.host.finishSessionSegmentWork;
    fixture.host.finishSessionSegmentWork = (session, jobId, reason) => {
      finishCalls += 1;
      if (finishCalls === 1) throw new Error("work accounting failed");
      baseFinish(session, jobId, reason);
    };
    const session = makeSession();

    const result = handleRecordedSegment(fixture.host, session, payload(0, true));
    if (!result) throw new Error("final segment unexpectedly skipped");
    await result;
    expect(finalized).toBe(true);
    expect(fixture.processOrder).toEqual([1000]);
  });

  it("reads short-recording protection at call time and ignores sessions that are absent", async () => {
    let protectShortRecordings = true;
    const fixture = makeHost({ filterShortRecordings: () => protectShortRecordings });
    const absentResult = handleRecordedSegment(fixture.host, undefined, payload(0, true));
    expect(absentResult).toBeUndefined();
    expect(fixture.masters).toEqual([]);
    expect(fixture.processOrder).toEqual([]);

    const session = makeSession();
    session.segments = [];
    const shortPayload = { ...payload(0, true), endOffsetMs: 2000 };
    await handleRecordedSegment(fixture.host, session, shortPayload);
    expect(session.shortRecordingTier).toBe("discard");
    expect(fixture.processOrder).toEqual([2000]);

    protectShortRecordings = false;
    const processSession = makeSession();
    processSession.segments = [];
    await handleRecordedSegment(fixture.host, processSession, shortPayload);
    expect(fixture.processOrder).toEqual([2000, 2000]);
  });
});
