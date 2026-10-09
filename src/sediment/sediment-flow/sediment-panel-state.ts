import { t as i18nT } from "../../shared/i18n";
import { SEDIMENT_GROUP_CONFIG, VOCABULARY_SECTIONS } from "../../shared/catalog-sediment";
import { primitiveText } from "../../shared/util-common";
export type SedimentIdPort = {
  getHotwordId(sectionKey: string, term: unknown): string;
  getPersonId(sourcePath: string, item: Record<string, unknown>): string;
  getTodoId(item: Record<string, unknown>): string;
};

export type SedimentCandidateBucket = {
  people: unknown[]; todos: unknown[]; cards: unknown[]; hotwords: unknown;
  scannedAt: string; scanStartedAt?: string; initialCounts: Record<string, number>; doneGroups: string[];
  selectedByGroup: Record<string, string[]>; decisionLogByGroup: Record<string, unknown>;
  transitionGroup: string; scanning: boolean; [key: string]: unknown;
};
export type SedimentDecisionRestore = { people?: unknown[]; todos?: unknown[]; hotwords?: unknown };
export type SedimentItem = { id?: string; title?: string; sub?: string; meta?: string; label?: string; status?: string; statusText?: string; completedAt?: string; raw?: unknown; type?: string; icon?: string; iconName?: string; sectionKey?: string; term?: unknown };
export type SedimentGroupReview = { groupKey: string; completedAt: string; restore?: SedimentDecisionRestore; selectedIds?: string[]; items?: SedimentItem[] };
export type SedimentGroup = { key: string; label: string; unit: string; lead?: string; dest?: string; model?: string; pending: number; total: number; done: number; emptyDone?: boolean; status?: string; next?: string | null; items?: SedimentItem[] };
export type SedimentPanelState = { bucket: SedimentCandidateBucket; groups: SedimentGroup[]; currentPeople: unknown[]; hasPipelineStarted?: boolean; otherPeopleCount?: number; ignoredPeople?: unknown[]; vocabScanned?: boolean; peopleScanned?: boolean; scanning?: boolean; percent?: number; label?: string; detail?: string; error?: string };
export type SedimentBucketPort = { get(): SedimentCandidateBucket; set(patch: Partial<SedimentCandidateBucket>): void; ids: SedimentIdPort };

export function createEmptySedimentBucket(): SedimentCandidateBucket { return { people: [], todos: [], cards: [], hotwords: createVocabularyGroups(), scannedAt: "", scanStartedAt: "", initialCounts: {}, doneGroups: [], selectedByGroup: {}, decisionLogByGroup: {}, transitionGroup: "", scanning: false }; }
export function createVocabularyGroups(): Record<string, unknown[]> { return Object.fromEntries(VOCABULARY_SECTIONS.map(section => [section.key, []])); }
export function cloneSedimentBucket(bucket: SedimentCandidateBucket): SedimentCandidateBucket { try { return JSON.parse(JSON.stringify(bucket)) as SedimentCandidateBucket; } catch { return { ...bucket }; } }
export function getSedimentCandidateSignature(buckets: Record<string, SedimentCandidateBucket>): string { return Object.keys(buckets || {}).sort().map(path => { const bucket = buckets[path] || createEmptySedimentBucket(); return [path, bucket.scannedAt || "", (bucket.people || []).length, (bucket.todos || []).length, countSedimentHotwordCandidates(bucket.hotwords), JSON.stringify(bucket.initialCounts || {}), (bucket.doneGroups || []).join(","), bucket.transitionGroup || "", bucket.scanning ? 1 : 0, JSON.stringify(bucket.selectedByGroup || {}), JSON.stringify(bucket.decisionLogByGroup || {})].join(":"); }).join(";"); }
export function mergeSedimentPeopleCandidates(currentPath: string, memoryPeople: unknown[], cachedPeople: unknown[], getCacheKey: (sourcePath: string, item: Record<string, unknown>) => string): unknown[] {
  const byKey = new Map<string, unknown>();
  for (const raw of cachedPeople || []) {
    const item = raw as Record<string, unknown> | null;
    const rawKey = item && (item.cacheKey || item.key || getCacheKey(primitiveText(item.sourcePath) || currentPath, item));
    const key = primitiveText(rawKey);
    if (key) byKey.set(key, raw);
  }
  for (const raw of memoryPeople || []) {
    const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const item: Record<string, unknown> = { ...source, sourcePath: source.sourcePath || currentPath };
    const rawKey = item.cacheKey || item.key || getCacheKey(primitiveText(item.sourcePath) || currentPath, item);
    const key = primitiveText(rawKey);
    if (key && !byKey.has(key)) byKey.set(key, item);
  }
  return Array.from(byKey.values());
}
export function countSedimentHotwordCandidates(groups: unknown): number {
  let count = 0;
  const source = groups && typeof groups === "object" ? groups as Record<string, unknown> : {};
  for (const def of VOCABULARY_SECTIONS) {
    const terms = source[def.key];
    if (Array.isArray(terms)) count += terms.length;
  }
  return count;
}
export function getSedimentHotwordItems(groups: unknown, ids: SedimentIdPort): SedimentItem[] {
  const items: SedimentItem[] = [];
  const source = groups && typeof groups === "object" ? groups as Record<string, unknown> : {};
  for (const def of VOCABULARY_SECTIONS) {
    const terms = source[def.key];
    if (!Array.isArray(terms)) continue;
    for (const term of terms) {
      items.push({
        id: ids.getHotwordId(def.key, term),
        title: primitiveText(term),
        sub: i18nT(def.label || def.title),
        sectionKey: def.key,
        term,
      });
    }
  }
  return items;
}

export function getSedimentGroupRawItems(state: SedimentPanelState, groupKey: string, ids: SedimentIdPort): unknown[] {
  if (groupKey === "person") return state.currentPeople || [];
  if (groupKey === "todo") return state.bucket.todos || [];
  if (groupKey === "hotword") return getSedimentHotwordItems(state.bucket.hotwords, ids);
  return [];
}

export function getSedimentDisplayItems(state: SedimentPanelState, groupKey: string, ids: SedimentIdPort): SedimentItem[] {
  const iconName = groupKey === "todo" ? "check-square" : groupKey === "hotword" ? "badge-check" : "user-round";
  const rawItems = getSedimentGroupRawItems(state, groupKey, ids);
  if (groupKey === "todo") {
    return rawItems.map(value => {
      const item = asRecord(value);
      return {
        id: ids.getTodoId(item),
        raw: value,
        iconName,
        title: primitiveText(item.task || item.title) || i18nT("Unnamed to-do"),
        sub: [primitiveText(item.owner), primitiveText(item.due)].filter(Boolean).join(" · "),
        meta: "",
      };
    });
  }
  if (groupKey === "hotword") {
    return rawItems.map(value => ({ ...(value as SedimentItem), raw: value, iconName, meta: "" }));
  }
  return rawItems.map(value => {
    const item = asRecord(value);
    return {
      id: ids.getPersonId(primitiveText(item.sourcePath), item),
      raw: value,
      iconName,
      title: primitiveText(item.name) || i18nT("Unnamed person"),
      sub: primitiveText(item.role) || i18nT("Role to be filled in"),
      meta: primitiveText(item.org) || primitiveText(item.organization) || i18nT("Organization to be filled in"),
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
export function getSedimentSelectedIds(port: SedimentBucketPort, groupKey: string, items: SedimentItem[]): Set<string> { const bucket = port.get(); const selected = { ...(bucket.selectedByGroup || {}) }; const allIds = (items || []).map(item => item.id).filter((id): id is string => !!id); const current = Array.isArray(selected[groupKey]) ? selected[groupKey].filter(id => allIds.includes(id)) : null; if (current) return new Set(current); const config = SEDIMENT_GROUP_CONFIG as Record<string, { defaultAllSelected?: boolean }>; if (config[groupKey]?.defaultAllSelected) { selected[groupKey] = allIds; port.set({ selectedByGroup: selected }); return new Set(allIds); } return new Set(); }
export function setSedimentSelectedIds(port: SedimentBucketPort, groupKey: string, ids: string[]): void { const selectedByGroup = { ...(port.get().selectedByGroup || {}) }; selectedByGroup[groupKey] = Array.from(new Set(ids || [])).filter(Boolean); port.set({ selectedByGroup }); }
export function getActiveSedimentGroup(groups: SedimentGroup[], current: string, writeCurrent: (key: string) => void): string { const keys = new Set((groups || []).map(group => group.key)); let key = current || "person"; if (!keys.has(key)) key = "person"; const active = (groups || []).find(group => group.key === key); if (active && active.total > 0) { writeCurrent(key); return key; } const pending = findSedimentNextPendingGroup(groups); if (pending) key = pending.key; else { const done = (groups || []).find(group => group.total > 0); if (done) key = done.key; } if (!keys.has(key) && groups.length) key = groups[0].key; writeCurrent(key); return key; }
export function getSedimentNodeState(group: SedimentGroup | null | undefined, currentKey: string): "empty" | "done" | "current" | "pending" { if (!group || !group.total) return "empty"; if (group.done >= group.total) return "done"; if (group.key === currentKey) return "current"; return "pending"; }
export function findSedimentNextPendingGroup(groups: SedimentGroup[], afterKey = ""): SedimentGroup | null { const list = (groups || []).filter(Boolean); if (!list.length) return null; const start = afterKey ? Math.max(0, list.findIndex(group => group.key === afterKey) + 1) : 0; const ordered = list.slice(start).concat(list.slice(0, start)); return ordered.find(group => group.total > 0 && group.done < group.total) || null; }
export function getSedimentGroupReview(port: SedimentBucketPort, groupKey: string): SedimentGroupReview | null { const logs = port.get().decisionLogByGroup || {}; return (logs[groupKey] as SedimentGroupReview) || null; }
export function setSedimentDecisionLog(port: SedimentBucketPort, groupKey: string, log: SedimentGroupReview | null): void { const decisionLogByGroup = { ...(port.get().decisionLogByGroup || {}) }; if (log) decisionLogByGroup[groupKey] = log; else delete decisionLogByGroup[groupKey]; port.set({ decisionLogByGroup }); }
export function buildSedimentDecisionLog(state: SedimentPanelState, groupKey: string, selectedIds: Set<string>, ids: SedimentIdPort, actionLabel = "", now = new Date().toISOString()): SedimentGroupReview { const selected = new Set(selectedIds || []); const displayItems = getSedimentDisplayItems(state, groupKey, ids); const restore: SedimentDecisionRestore = {}; if (groupKey === "person") restore.people = cloneArray(state.currentPeople || []); else if (groupKey === "todo") restore.todos = cloneArray(state.bucket.todos || []); else if (groupKey === "hotword") restore.hotwords = cloneUnknown(state.bucket.hotwords || createVocabularyGroups()); return { groupKey, completedAt: now, restore, selectedIds: Array.from(selected), items: displayItems.map(item => { const kept = selected.has(item.id || ""); return { id: item.id, title: item.title || "", sub: item.sub || "", meta: item.meta || "", status: kept ? "kept" : "ignored", statusText: kept ? actionLabel || i18nT("Added") : i18nT("Ignored") }; }) }; }
export function appendSedimentDecisionItems(port: SedimentBucketPort, groupKey: string, rawItems: unknown[], status: string, statusText: string, state: SedimentPanelState, ids: SedimentIdPort, sourcePath = "", now = new Date().toISOString()): void {
  const logs = { ...(port.get().decisionLogByGroup || {}) };
  const current: SedimentGroupReview = (logs[groupKey] as SedimentGroupReview) || { groupKey, completedAt: "", restore: {}, selectedIds: [], items: [] };
  if (!current.restore || !Object.keys(current.restore).length) {
    if (groupKey === "person") current.restore = { people: JSON.parse(JSON.stringify(state.currentPeople || [])) as unknown[] };
    else current.restore = buildSedimentDecisionLog(state, groupKey, new Set(), ids).restore || {};
  }
  current.items = current.items || [];
  current.selectedIds = current.selectedIds || [];
  for (const raw of rawItems || []) {
    if (!raw) continue;
    const item = asRecord(raw);
    const id = groupKey === "person" ? ids.getPersonId(primitiveText(item.sourcePath) || sourcePath, item) : primitiveText(item.id);
    current.items = current.items.filter(entry => entry.id !== id);
    current.items.push({
      id,
      title: primitiveText(item.name) || primitiveText(item.title) || primitiveText(item.task),
      sub: primitiveText(item.role) || primitiveText(item.type),
      meta: primitiveText(item.org) || primitiveText(item.organization) || primitiveText(item.note) || primitiveText(item.summary),
      status,
      statusText,
    });
    if (status === "kept" && !current.selectedIds.includes(id)) current.selectedIds.push(id);
  }
  current.completedAt = current.completedAt || now;
  logs[groupKey] = current;
  port.set({ decisionLogByGroup: logs });
}
function cloneArray(value: unknown[]): unknown[] { return JSON.parse(JSON.stringify(value)) as unknown[]; }
function cloneUnknown(value: unknown): unknown { return JSON.parse(JSON.stringify(value)) as unknown; }
