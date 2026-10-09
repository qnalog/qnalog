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
  const tasks = {
    startTaskActivity: () => { order.push("task:start"); },
    patchTaskActivity: (_id: string, patch: { stage: string }) => { order.push(`task:${patch.stage}`); },
    cancelTaskActivity: (id: string, reason: string) => { cancellationCalls.push({ id, reason }); order.push("task:cancel"); },
    completeTaskActivity: () => { order.push("task:complete"); },
    failTaskActivity: (id: string, error: unknown, result: unknown) => { failures.push({ id, error, result }); order.push("task:fail"); },
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
  return { port, order, patches, cancellationCalls, failures, notices, advanceToken: () => { token += 1; } };
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

  it("cancels through the shared token and discards a generated result once it returns", async () => {
    let resolveGeneration!: (value: unknown) => void;
    const generation = new Promise<unknown>(resolve => { resolveGeneration = resolve; });
    const { port, order, patches, advanceToken } = fixture({ generate: async () => generation });
    const scanning = scanSedimentFile(port, file);
    await Promise.resolve();
    await Promise.resolve();
    advanceToken();
    resolveGeneration(generated);
    await scanning;

    expect(order).toContain("task:cancel");
    expect(order).not.toContain("normalize");
    expect(order).not.toContain("persist");
    expect(patches).toHaveLength(1);
  });

  it("does not reset or report a cancelled scan's later failure", async () => {
    let rejectGeneration!: (error: unknown) => void;
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const generation = new Promise<unknown>((_resolve, reject) => { rejectGeneration = reject; });
    const { port, order, patches, cancellationCalls, failures, notices } = fixture({
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
    expect(order.slice(eventsAfterCancel)).toEqual(["task:cancel"]);
    expect(cancellationCalls).toHaveLength(2);
    expect(cancellationCalls[1]).toEqual(cancellationCalls[0]);
    expect(failures).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  it("does not let a cancelled scan failure reset a replacement scan", async () => {
    let rejectFirst!: (error: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    let resolveFirstStarted!: () => void;
    let resolveSecondStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { resolveFirstStarted = resolve; });
    const secondStarted = new Promise<void>(resolve => { resolveSecondStarted = resolve; });
    const firstGeneration = new Promise<unknown>((_resolve, reject) => { rejectFirst = reject; });
    const secondGeneration = new Promise<unknown>(resolve => { resolveSecond = resolve; });
    let generationCount = 0;
    const { port, order, patches, failures, notices } = fixture({
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
    const firstScan = scanSedimentFile(port, file);
    await firstStarted;
    cancelSedimentScan(port, file);
    const secondScan = scanSedimentFile(port, file);
    await secondStarted;
    expect(patches.at(-1)).toMatchObject({ scanning: true });
    const patchesBeforeFirstFailure = patches.length;
    const eventsBeforeFirstFailure = order.length;

    rejectFirst(new Error("stale failure"));
    await firstScan;

    expect(patches).toHaveLength(patchesBeforeFirstFailure);
    expect(patches.at(-1)).toMatchObject({ scanning: true });
    expect(order.slice(eventsBeforeFirstFailure)).toEqual(["task:cancel"]);
    expect(failures).toHaveLength(0);
    expect(notices).toHaveLength(0);

    resolveSecond(generated);
    await secondScan;
    expect(patches.at(-1)).toMatchObject({ scanning: false, scannedAt: expect.any(String) });
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
    const { port, order, patches } = fixture();
    cancelSedimentScan(port, file);
    expect(port.currentToken()).toBe(1);
    expect(order).toEqual(["bucket:stopped", "task:cancel", "render", "toast"]);
    expect(patches[0]).toEqual({ scanning: false, scanStartedAt: "" });
  });
});
