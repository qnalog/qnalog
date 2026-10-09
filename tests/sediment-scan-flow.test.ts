import { describe, expect, it } from "vitest";
import {
  cancelSedimentScan,
  scanSedimentFile,
  type SedimentScanFlowPort,
  type SedimentScanFile,
} from "../src/sediment/sediment-flow/sediment-scan-flow";

const file: SedimentScanFile = { path: "minutes/source.md", basename: "source.md" };
const generated = { people: ["person"], todos: ["todo"], hotwords: { general: ["term"] } };

function fixture(overrides: Partial<SedimentScanFlowPort> = {}) {
  let token = 0;
  const order: string[] = [];
  const patches: Array<Record<string, unknown>> = [];
  const cancellationCalls: Array<{ id: string; reason: string }> = [];
  const failures: Array<{ id: string; error: unknown; result: unknown }> = [];
  const notices: Array<{ error: unknown; duration: number }> = [];
  const activities = new Map<string, { status: string }>();
  const setActivityStatus = (id: string, status: string) => {
    const activity = activities.get(id);
    if (activity) activity.status = status;
  };
  const tasks = {
    startTaskActivity: (input: Parameters<SedimentScanFlowPort["tasks"]["startTaskActivity"]>[0]) => { activities.set(input.id, { status: input.status }); order.push("task:start"); },
    patchTaskActivity: (_id: string, patch: { stage: string }) => { order.push(`task:${patch.stage}`); },
    cancelTaskActivity: (id: string, reason: string) => { cancellationCalls.push({ id, reason }); setActivityStatus(id, "cancelled"); order.push("task:cancel"); },
    completeTaskActivity: (id: string) => { setActivityStatus(id, "done"); order.push("task:complete"); },
    failTaskActivity: (id: string, error: unknown, result: unknown) => { failures.push({ id, error, result }); setActivityStatus(id, "failed"); order.push("task:fail"); },
  };
  const port: SedimentScanFlowPort = {
    currentToken: () => token,
    incrementToken: () => { token += 1; return token; },
    patchBucket: (_file, patch) => { patches.push(patch); order.push(patch.scanning === true ? "bucket:scanning" : patch.scannedAt ? "bucket:results" : "bucket:stopped"); },
    persistBucket: async () => { order.push("persist"); return true; },
    readMarkdown: async () => { order.push("read"); return "# markdown"; },
    generate: async () => { order.push("generate"); return generated; },
    normalizeAndAddIds: (objects) => { order.push("normalize"); return objects as { people: unknown[]; todos: unknown[]; hotwords: unknown }; },
    normalizePath: path => path,
    createVocabularyGroups: () => ({ general: [] }),
    initialCounts: () => ({ person: 1, todo: 1 }),
    countRawPeople: () => 1,
    countRawTodos: () => 1,
    countRawHotwords: () => 1,
    selectGroupState: () => { order.push("select-state"); return { groups: [{ key: "todo" }] }; },
    findNextPendingGroup: groups => groups[0],
    setSelectedGroup: group => { order.push(`select:${group}`); },
    setSwitcherOpen: open => { order.push(`switcher:${open}`); },
    render: () => { order.push("render"); },
    showToast: () => { order.push("toast"); },
    showFailureNotice: (error: unknown, duration: number) => { notices.push({ error, duration }); order.push("notice"); },
    errorMessage: () => "failed",
    logFailure: () => { order.push("log"); },
    tasks,
    ...overrides,
  };
  return { port, order, patches, cancellationCalls, failures, notices, activities, advanceToken: () => { token += 1; } };
}

describe("sediment scan flow contract", () => {
  it("renders scanning immediately before reading, then persists, renders, toasts, and completes in order", async () => {
    const { port, order, patches } = fixture();
    await scanSedimentFile(port, file);

    expect(order).toEqual([
      "task:start", "bucket:scanning", "render", "read", "task:extracting", "generate", "normalize",
      "bucket:results", "task:persisting", "persist", "select-state", "select:todo", "switcher:false",
      "render", "toast", "task:complete",
    ]);
    expect(patches[0]).toMatchObject({ scanning: true });
    expect(patches[1]).toMatchObject({ people: ["person"], todos: ["todo"], doneGroups: [], scanning: false });
  });

  it.each(["read", "generate", "persist"] as const)("resets scanning and reports a %s failure", async (failurePoint) => {
    const { port, order, patches } = fixture({
      ...(failurePoint === "read" ? { readMarkdown: async () => { throw new Error("read failed"); } } : {}),
      ...(failurePoint === "generate" ? { generate: async () => { throw new Error("generate failed"); } } : {}),
      ...(failurePoint === "persist" ? { persistBucket: async () => false } : {}),
    });
    await scanSedimentFile(port, file);

    expect(patches.at(-1)).toEqual({ scanning: false, scanStartedAt: "" });
    expect(order.slice(-5)).toEqual(["bucket:stopped", "render", "log", "task:fail", "notice"]);
    expect(order.at(-1)).toBe("notice");
  });

  it("discards a generated result after the token changes without touching scan state or task activity", async () => {
    let resolveGeneration!: (value: unknown) => void;
    const generation = new Promise<unknown>(resolve => { resolveGeneration = resolve; });
    const { port, order, patches, cancellationCalls, failures, notices, activities, advanceToken } = fixture({ generate: async () => generation });
    const scanning = scanSedimentFile(port, file);
    await Promise.resolve();
    await Promise.resolve();
    advanceToken();
    const eventsBeforeStaleResult = order.length;
    resolveGeneration(generated);
    await scanning;

    expect(order.slice(eventsBeforeStaleResult)).toEqual([]);
    expect(cancellationCalls).toEqual([]);
    expect(patches).toHaveLength(1);
    expect(order.filter(event => event === "render")).toHaveLength(1);
    expect(order).not.toContain("normalize");
    expect(order).not.toContain("persist");
    expect(order).not.toContain("toast");
    expect(notices).toEqual([]);
    expect(failures).toEqual([]);
    expect(activities.get(`sediment:${file.path}`)?.status).toBe("running");
  });

  it("does not reset or report a cancelled scan's later failure", async () => {
    let rejectGeneration!: (error: unknown) => void;
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const generation = new Promise<unknown>((_resolve, reject) => { rejectGeneration = reject; });
    const { port, order, patches, cancellationCalls, failures, notices, activities } = fixture({
      generate: async () => {
        resolveStarted();
        return generation;
      },
    });
    const scanning = scanSedimentFile(port, file);
    await started;
    cancelSedimentScan(port, file);
    const patchesAfterCancel = patches.length;
    const eventsAfterCancel = order.length;

    rejectGeneration(new Error("stale failure"));
    await scanning;

    expect(patches).toHaveLength(patchesAfterCancel);
    expect(order.slice(eventsAfterCancel)).toEqual([]);
    expect(cancellationCalls).toHaveLength(1);
    expect(failures).toHaveLength(0);
    expect(notices).toHaveLength(0);
    expect(activities.get(`sediment:${file.path}`)?.status).toBe("cancelled");
  });

  it.each(["result", "failure"] as const)("does not cancel a replacement task activity when stale scan A returns a %s", async staleOutcome => {
    let rejectFirst!: (error: unknown) => void;
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    let resolveFirstStarted!: () => void;
    let resolveSecondStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { resolveFirstStarted = resolve; });
    const secondStarted = new Promise<void>(resolve => { resolveSecondStarted = resolve; });
    const firstGeneration = new Promise<unknown>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    const secondGeneration = new Promise<unknown>(resolve => { resolveSecond = resolve; });
    let generationCount = 0;
    const { port, order, patches, cancellationCalls, failures, notices, activities } = fixture({
      generate: async () => {
        generationCount += 1;
        if (generationCount === 1) {
          resolveFirstStarted();
          return firstGeneration;
        }
        resolveSecondStarted();
        return secondGeneration;
      },
    });
    const taskId = `sediment:${file.path}`;
    const firstScan = scanSedimentFile(port, file);
    await firstStarted;
    cancelSedimentScan(port, file);
    const secondScan = scanSedimentFile(port, file);
    await secondStarted;
    expect(patches.at(-1)).toMatchObject({ scanning: true });
    expect(activities.get(taskId)?.status).toBe("running");
    const patchesBeforeFirstOutcome = patches.length;
    const eventsBeforeFirstOutcome = order.length;

    if (staleOutcome === "failure") rejectFirst(new Error("stale failure"));
    else resolveFirst(generated);
    await firstScan;

    expect(patches).toHaveLength(patchesBeforeFirstOutcome);
    expect(patches.at(-1)).toMatchObject({ scanning: true });
    expect(order.slice(eventsBeforeFirstOutcome)).toEqual([]);
    expect(cancellationCalls).toHaveLength(1);
    expect(activities.get(taskId)?.status).toBe("running");
    expect(failures).toEqual([]);
    expect(notices).toEqual([]);

    resolveSecond(generated);
    await secondScan;
    expect(patches.at(-1)).toMatchObject({ scanning: false, scannedAt: expect.any(String) });
    expect(activities.get(taskId)?.status).toBe("done");
  });


  it("preserves current-scan failure reset, logging, task failure, and notice order", async () => {
    const error = new Error("current scan failure");
    const { port, order, patches, failures, notices } = fixture({
      generate: async () => { throw error; },
    });
    await scanSedimentFile(port, file);

    expect(patches.at(-1)).toEqual({ scanning: false, scanStartedAt: "" });
    expect(order.slice(-5)).toEqual(["bucket:stopped", "render", "log", "task:fail", "notice"]);
    expect(failures).toEqual([{
      id: `sediment:${file.path}`,
      error,
      result: expect.objectContaining({ detail: "failed" }),
    }]);
    expect(notices).toEqual([{ error, duration: 8000 }]);
  });

  it("increments the shared token and orders explicit cancellation updates", () => {
    const { port, order, patches, cancellationCalls } = fixture();
    cancelSedimentScan(port, file);
    expect(port.currentToken()).toBe(1);
    expect(order).toEqual(["bucket:stopped", "task:cancel", "render", "toast"]);
    expect(patches[0]).toEqual({ scanning: false, scanStartedAt: "" });
    expect(cancellationCalls).toHaveLength(1);
    expect(cancellationCalls[0].id).toBe(`sediment:${file.path}`);
  });
});
