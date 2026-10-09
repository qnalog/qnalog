import { describe, expect, it, vi } from "vitest";
import {
  buildSedimentDecisionLog,
  getSedimentHotwordItems,
  cloneSedimentBucket,
  createEmptySedimentBucket,
  findSedimentNextPendingGroup,
  getActiveSedimentGroup,
  getSedimentDisplayItems,
  getSedimentSelectedIds,
  mergeSedimentPeopleCandidates,
  setSedimentSelectedIds,
  type SedimentBucketPort,
  type SedimentGroup,
  type SedimentPanelState,
} from "../src/sediment/sediment-flow/sediment-panel-state";
const ids = {
  getHotwordId: (section: string, term: unknown) => `${section}:${String(term)}`,
  getPersonId: (path: string, item: Record<string, unknown>) => `${path}:${String(item.name || "")}`,
  getTodoId: (item: Record<string, unknown>) => String(item.id || item.task || item.title || ""),
};

function makeState(): SedimentPanelState {
  const bucket = createEmptySedimentBucket();
  bucket.todos = [{ task: "Ship", owner: "Lee" }, { title: "Review" }];
  bucket.hotwords = { brands: ["Acme"] };
  return { bucket, groups: [], currentPeople: [{ name: "Ada", role: "Engineer", sourcePath: "notes/a.md" }] };
}

describe("sediment panel state contract", () => {
  it("creates independent defaults and clones nested bucket data", () => {
    const first = createEmptySedimentBucket();
    const second = createEmptySedimentBucket();
    first.selectedByGroup.todo = ["one"];
    expect(second.selectedByGroup.todo).toBeUndefined();
    const cloned = cloneSedimentBucket(first);
    cloned.selectedByGroup.todo.push("two");
    expect(first.selectedByGroup.todo).toEqual(["one"]);
  });

  it("preserves cached-first people ordering, deduplicates candidates and hydrates memory source path", () => {
    const cache = [{ cacheKey: "same", name: "Cached" }, { cacheKey: "cache", name: "Cache only" }];
    const merged = mergeSedimentPeopleCandidates("notes/a.md", [{ cacheKey: "same", name: "Memory" }, { cacheKey: "memory", name: "New" }], cache, (_path, item) => String(item.name));
    expect(merged).toEqual([cache[0], cache[1], { cacheKey: "memory", name: "New", sourcePath: "notes/a.md" }]);
  });

  it("writes default selection only for configured groups and filters stale selections", () => {
    const bucket = createEmptySedimentBucket();
    const writes: unknown[] = [];
    const port: SedimentBucketPort = { get: () => bucket, set: patch => { writes.push(patch); Object.assign(bucket, patch); }, ids };
    expect([...getSedimentSelectedIds(port, "todo", [{ id: "a" }, { id: "b" }])]).toEqual(["a", "b"]);
    expect(writes).toEqual([{ selectedByGroup: { todo: ["a", "b"] } }]);
    bucket.selectedByGroup.todo = ["b", "stale"];
    expect([...getSedimentSelectedIds(port, "todo", [{ id: "a" }, { id: "b" }])]).toEqual(["b"]);
    expect(writes).toHaveLength(1);
    expect([...getSedimentSelectedIds(port, "person", [{ id: "p" }])]).toEqual([]);
    setSedimentSelectedIds(port, "person", ["p", "p", ""]);
    expect(bucket.selectedByGroup.person).toEqual(["p"]);
  });

  it("projects stable display items and records restore plus keep/ignore decisions", () => {
    const state = makeState();
    const items = getSedimentDisplayItems(state, "todo", ids);
    expect(items.map(({ title, sub }) => [title, sub])).toEqual([["Ship", "Lee"], ["Review", ""]]);
    const log = buildSedimentDecisionLog(state, "todo", new Set([items[0].id!]), ids, "Added", "2026-10-09T00:00:00.000Z");
    expect(log.completedAt).toBe("2026-10-09T00:00:00.000Z");
    expect(log.restore?.todos).toEqual(state.bucket.todos);
    expect(log.items?.map(item => item.status)).toEqual(["kept", "ignored"]);
    expect(log.selectedIds).toEqual([items[0].id]);
  });
  it("projects hotwords in catalog order and snapshots exact person and hotword restore data", () => {
    const state = makeState();
    const hotwords = getSedimentHotwordItems({ people: ["Ada"], brands: ["Acme"] }, ids);
    expect(hotwords.map(item => item.title)).toEqual(["Ada", "Acme"]);
    const hotwordLog = buildSedimentDecisionLog(state, "hotword", new Set(), ids, "", "2026-10-09T00:00:00.000Z");
    const personLog = buildSedimentDecisionLog(state, "person", new Set(), ids, "", "2026-10-09T00:00:00.000Z");
    expect(hotwordLog.restore?.hotwords).toEqual(state.bucket.hotwords);
    expect(personLog.restore?.people).toEqual(state.currentPeople);
  });


  it("navigates pending groups in order and restores wrap-around behavior", () => {
    const groups: SedimentGroup[] = [
      { key: "person", label: "People", unit: "", pending: 0, total: 1, done: 1 },
      { key: "todo", label: "To-dos", unit: "", pending: 1, total: 2, done: 1 },
      { key: "hotword", label: "Hotwords", unit: "", pending: 1, total: 1, done: 0 },
    ];
    expect(findSedimentNextPendingGroup(groups)?.key).toBe("todo");
    expect(findSedimentNextPendingGroup(groups, "todo")?.key).toBe("hotword");
    expect(findSedimentNextPendingGroup(groups, "hotword")?.key).toBe("todo");
    const writes = vi.fn();
    expect(getActiveSedimentGroup(groups, "person", writes)).toBe("person");
    expect(writes).toHaveBeenCalledWith("person");
  });
});
