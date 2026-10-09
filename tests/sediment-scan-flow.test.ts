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
  const tasks = {
    startTaskActivity: () => { order.push("task:start"); },
    patchTaskActivity: (_id: string, patch: { stage: string }) => { order.push(`task:${patch.stage}`); },
    cancelTaskActivity: () => { order.push("task:cancel"); },
    completeTaskActivity: () => { order.push("task:complete"); },
    failTaskActivity: () => { order.push("task:fail"); },
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
    showFailureNotice: () => { order.push("notice"); },
    errorMessage: () => "failed",
    logFailure: () => { order.push("log"); },
    tasks,
    ...overrides,
  };
  return { port, order, patches, advanceToken: () => { token += 1; } };
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

  it("increments the shared token and orders explicit cancellation updates", () => {
    const { port, order, patches } = fixture();
    cancelSedimentScan(port, file);
    expect(port.currentToken()).toBe(1);
    expect(order).toEqual(["bucket:stopped", "task:cancel", "render", "toast"]);
    expect(patches[0]).toEqual({ scanning: false, scanStartedAt: "" });
  });
});
