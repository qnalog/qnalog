import { describe, expect, it, vi } from "vitest";
import { commitSedimentGroupFlow } from "../src/sediment/sediment-flow/sediment-commit-flow";
import { restoreSedimentCommitFlow } from "../src/sediment/sediment-flow/sediment-undo-flow";
import { scheduleSedimentAutoAdvance, type SedimentAdvanceFlowPort } from "../src/sediment/sediment-flow/sediment-advance";

describe("sediment flow consumer contracts", () => {
  it("snapshots before commit mutations and preserves the commit tail order", async () => {
    const order: string[] = [];
    await commitSedimentGroupFlow({
      snapshotBucket: () => { order.push("snapshot"); return { before: true }; },
      write: async () => { order.push("write"); },
      recordDecisionLog: () => { order.push("decision"); },
      markDone: () => { order.push("done"); return true; },
      persistBucket: async () => { order.push("persist"); return true; },
      render: () => { order.push("render"); },
      showCommitToast: (undo) => { expect(undo).toEqual({ before: true }); order.push("toast"); },
      scheduleAutoAdvance: () => { order.push("schedule"); },
    });
    expect(order).toEqual(["snapshot", "write", "decision", "done", "persist", "render", "toast", "schedule"]);
  });

  it("gates the toast on persistence but advances whenever the group was completed", async () => {
    const order: string[] = [];
    await commitSedimentGroupFlow({
      snapshotBucket: () => ({}), write: async () => { order.push("write"); },
      recordDecisionLog: () => order.push("decision"), markDone: () => true,
      persistBucket: async () => false, render: () => order.push("render"),
      showCommitToast: () => order.push("toast"), scheduleAutoAdvance: () => order.push("schedule"),
    });
    expect(order).toEqual(["write", "decision", "render", "schedule"]);
  });

  it("restores invocation-time undo data in order and delegates failures", async () => {
    const order: string[] = [];
    const port = {
      restoreEntries: vi.fn(async (undo: { id: string }) => { order.push(`entries:${undo.id}`); }),
      restoreVocabulary: vi.fn(async () => { order.push("vocabulary"); }),
      restoreSourceSnapshot: vi.fn(async () => { order.push("source"); }),
      restoreBucket: vi.fn(async () => { order.push("bucket"); }),
      render: () => order.push("render"), showUndoToast: () => order.push("toast"),
      presentError: (error: unknown) => order.push(`error:${String(error)}`),
    };
    await restoreSedimentCommitFlow(port, { id: "second" });
    expect(port.restoreEntries).toHaveBeenCalledWith({ id: "second" });
    expect(order).toEqual(["entries:second", "vocabulary", "source", "bucket", "render", "toast"]);
    order.length = 0;
    await restoreSedimentCommitFlow({
      ...port,
      restoreVocabulary: async () => { throw new Error("restore failed"); },
    }, { id: "failure" });
    expect(order).toEqual(["entries:failure", "error:Error: restore failed"]);
    await restoreSedimentCommitFlow(port, null);
    expect(order).toEqual(["entries:failure", "error:Error: restore failed"]);
  });

  it("uses one 1000ms timer, cancels the prior timer, and clears transition before advancing", () => {
    const order: string[] = [];
    let timerRef: number | 0 = 7;
    let callback: (() => void) | null = null;
    const file = { path: "notes/current.md" };
    const port: SedimentAdvanceFlowPort<typeof file, number> = {
      isFile: () => true, normalizePath: path => path,
      getTimer: () => timerRef, setTimer: timer => { timerRef = timer; order.push(`timer:${timer}`); },
      clearTimer: timer => order.push(`clear:${timer}`),
      scheduleTimer: (fn, delay) => { expect(delay).toBe(1000); callback = fn; return 8; },
      getActiveNotePath: () => "notes/current.md",
      getGroups: () => [{ key: "todo", total: 1, done: 1 }, { key: "hotword", total: 2, done: 0 }],
      findNextPendingGroup: (groups, key) => groups.find(group => group.key !== key && group.done < group.total) || null,
      clearTransitionGroup: () => order.push("transition"),
      selectGroup: key => order.push(`select:${key}`), render: () => order.push("render"),
    };
    scheduleSedimentAutoAdvance(port, file, "todo");
    expect(order).toEqual(["clear:7", "timer:8"]);
    callback?.();
    expect(order).toEqual(["clear:7", "timer:8", "timer:0", "transition", "select:hotword"]);
  });

  it("cancels the advance effect when the active note no longer matches", () => {
    const order: string[] = [];
    let callback: (() => void) | null = null;
    const file = { path: "notes/current.md" };
    const port: SedimentAdvanceFlowPort<typeof file, number> = {
      isFile: () => true, normalizePath: path => path,
      getTimer: () => 0, setTimer: () => {}, clearTimer: () => {},
      scheduleTimer: fn => { callback = fn; return 1; },
      getActiveNotePath: () => "notes/other.md", getGroups: () => [],
      findNextPendingGroup: () => null,
      clearTransitionGroup: () => order.push("transition"),
      selectGroup: () => order.push("select"), render: () => order.push("render"),
    };
    scheduleSedimentAutoAdvance(port, file, "todo");
    callback?.();
    expect(order).toEqual([]);
  });
});
