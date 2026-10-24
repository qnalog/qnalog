import { NS_SESSION_KNOWLEDGE } from "../shared/namespace";
import { findActiveVersionBlock } from "../notes/note-document";
import { labelText } from "../shared/note-labels";
import { genId, isRecord } from "../shared/util-common";
import type { Segment } from "../shared/types";
import { getCurrentTranscript, getTranscriptSourceRevision, type Utterance } from "../transcript/session-transcript";


export type KnowledgeStatus = "complete" | "partial" | "unavailable" | "stale";
/**
 * Issue reasons. The last five record a field that the parser normalized (a status, an acceptance
 * value or an owner/due string); the item itself is kept, so these do not make the knowledge partial.
 */
export type KnowledgeIssueReason = "missing-block" | "invalid-json" | "invalid-item" | "unknown-evidence" | "source-presummarized" | "source-changed" | "mode-off"
  | "decision-status-defaulted" | "decision-supersede-unresolved" | "decision-confirm-downgraded" | "action-acceptance-defaulted" | "action-field-dropped";
/** Decision status (schemaVersion 3). Missing or invalid values from the model become "proposed". */
export type DecisionStatus = "confirmed" | "proposed" | "disputed" | "open" | "superseded";
/** Whether the owner of an action took it on (schemaVersion 3). Missing or invalid values become "assigned". */
export type ActionAcceptance = "accepted" | "assigned" | "volunteered";
/**
 * One decision, action or question. `status` and `supersededBy` exist only on schemaVersion 3 decisions;
 * `owner`, `due` and `acceptance` only on schemaVersion 3 actions. Version 2 items carry none of them.
 */
export interface KnowledgeItem {
  id: string;
  text: string;
  evidence: string[];
  topicIds: string[];
  status?: DecisionStatus;
  /** Id of the decision in the same knowledge that replaced this one; set only when status is "superseded". */
  supersededBy?: string;
  /** The owner as said in the transcript (verbatim, at most OWNER_DUE_MAX_CHARS). */
  owner?: string;
  /** The due time as said in the transcript (verbatim, never converted to a date). */
  due?: string;
  acceptance?: ActionAcceptance;
}
export interface KnowledgeTopic { id: string; title: string; summary: string; evidence: string[] }
export interface KnowledgeSourceRevision { segmentId: string; revision: number; normalizationRevision: number }
export interface UtteranceProjection { utteranceId: string; normalizedText: string; speakerName: string | null }
export interface SessionKnowledge {
  /** 3 since status-tagged decisions; notes written before keep version 2 and are read unchanged. */
  schemaVersion: 2 | 3;
  id: string;
  sourceRevision: string;
  sources: KnowledgeSourceRevision[];
  status: KnowledgeStatus;
  issues: Array<{ part: number; reason: KnowledgeIssueReason }>;
  topics: KnowledgeTopic[];
  decisions: KnowledgeItem[];
  actions: KnowledgeItem[];
  questions: KnowledgeItem[];
  projections: UtteranceProjection[];
}
export interface ParseSessionKnowledgeContext {
  allowed: readonly Utterance[];
  part: number;
  sources: readonly KnowledgeSourceRevision[];
  sourceRevision: string;
  previous?: SessionKnowledge;
  projections?: readonly UtteranceProjection[];
}

const MARKER_START = new RegExp(`<!--\\s*${NS_SESSION_KNOWLEDGE}(?=\\s|-->)`);
const MARKER_PAYLOAD = new RegExp(`<!--\\s*${NS_SESSION_KNOWLEDGE}\\s+([\\s\\S]*?)\\s*-->`);
export const SESSION_KNOWLEDGE_SCHEMA_VERSION = 3;
/** Owner and due strings longer than this (in code points) are dropped instead of being cut. */
export const OWNER_DUE_MAX_CHARS = 40;
const NORMALIZATION_REASONS = new Set<KnowledgeIssueReason>(["decision-status-defaulted", "decision-supersede-unresolved", "decision-confirm-downgraded", "action-acceptance-defaulted", "action-field-dropped"]);
const REASONS = new Set<KnowledgeIssueReason>(["missing-block", "invalid-json", "invalid-item", "unknown-evidence", "source-presummarized", "source-changed", "mode-off", ...NORMALIZATION_REASONS]);
const DECISION_STATUSES = new Set<DecisionStatus>(["confirmed", "proposed", "disputed", "open", "superseded"]);
const ACCEPTANCES = new Set<ActionAcceptance>(["accepted", "assigned", "volunteered"]);
/** True when the issue only records a normalized status or field; such issues keep the knowledge complete. */
export function isNormalizationIssue(reason: KnowledgeIssueReason): boolean {
  return NORMALIZATION_REASONS.has(reason);
}
function isDecisionStatus(value: unknown): value is DecisionStatus {
  return typeof value === "string" && DECISION_STATUSES.has(value as DecisionStatus);
}
function isAcceptance(value: unknown): value is ActionAcceptance {
  return typeof value === "string" && ACCEPTANCES.has(value as ActionAcceptance);
}
/** Owner or due as said: whitespace collapsed to one line; empty, non-string or over-long values give null. */
function verbatimField(value: unknown): { value: string | null; dropped: boolean } {
  if (value === undefined || value === null) return { value: null, dropped: false };
  if (typeof value !== "string") return { value: null, dropped: true };
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return { value: null, dropped: false };
  if (Array.from(text).length > OWNER_DUE_MAX_CHARS) return { value: null, dropped: true };
  return { value: text, dropped: false };
}
function safeJson(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/`/g, "\\u0060").replace(/--/g, "\\u002d\\u002d");
}
function cleanRaw(raw: string): { body: string; payload: string | null; found: boolean } {
  const text = String(raw || "");
  const marker = MARKER_START.exec(text);
  if (!marker) return { body: text.trimEnd(), payload: null, found: false };
  const tail = text.slice(marker.index);
  const payload = MARKER_PAYLOAD.exec(tail)?.[1]?.trim() ?? null;
  return { body: text.slice(0, marker.index).trimEnd(), payload, found: true };
}
function knowledgeCommentPattern(global = false): RegExp {
  return new RegExp(`<!--\\s*${NS_SESSION_KNOWLEDGE}\\s+[\\s\\S]*?-->`, global ? "g" : "");
}

function replaceKnowledgeInSection(section: string, serialized: string): string {
  const marker = knowledgeCommentPattern();
  const replaced = marker.test(section) ? section.replace(marker, (prior, offset: number, whole: string) => {
    const before = whole.slice(0, offset);
    return before.lastIndexOf("<details>") > before.lastIndexOf("</details>")
      ? serialized
      : `<details><summary>${labelText("indexData")}</summary>${serialized}</details>`;
  }) : null;
  if (replaced !== null) return replaced.replace(
    /<details>\s*<summary>[^<]*(?:QnALog session data|会话数据)[^<]*<\/summary>/gi,
    `<details><summary>${labelText("indexData")}</summary>`,
  );
  const body = section.trimEnd();
  return `${body}${body ? "\n\n" : ""}<details><summary>${labelText("indexData")}</summary>${serialized}</details>`;
}

/** Remove complete blocks and discard any malformed protocol tail. */
export function stripSessionKnowledgeBlocks(raw: string): string {
  const text = String(raw || "").replace(knowledgeCommentPattern(true), "");
  const malformedTail = MARKER_START.exec(text);
  return (malformedTail ? text.slice(0, malformedTail.index) : text).trimEnd();
}

export function readSelectedSessionKnowledge(markdown: string): SessionKnowledge | null {
  const active = findActiveVersionBlock(markdown);
  return active ? readSessionKnowledge(active.body) : readSessionKnowledge(markdown);
}

/** Keep the snapshot selected by the established reader and remove older protocol copies. */
export function normalizeSessionKnowledgeMarkers(markdown: string): string {
  const text = String(markdown || "");
  const pattern = knowledgeCommentPattern(true);
  const matches = [...text.matchAll(pattern)];
  if (matches.length <= 1) return text;
  const selected = readSelectedSessionKnowledge(text);
  const selectedIndex = selected
    ? matches.findIndex((match) => readSessionKnowledge(match[0])?.id === selected.id)
    : 0;
  const keep = selectedIndex >= 0 ? selectedIndex : 0;
  let result = text;
  for (const [index, match] of [...matches.entries()].reverse()) {
    if (index === keep) continue;
    const start = match.index || 0;
    result = result.slice(0, start) + result.slice(start + match[0].length);
  }
  return result;
}

/** Replace the snapshot for the selected display version without moving raw source blocks. */
export function upsertSelectedSessionKnowledge(markdown: string, knowledge: SessionKnowledge): string {
  const text = String(markdown || "");
  const serialized = serializeSessionKnowledge(knowledge);
  const active = findActiveVersionBlock(text);
  if (!active) return replaceKnowledgeInSection(text, serialized);
  const body = replaceKnowledgeInSection(active.body, serialized);
  return `${text.slice(0, active.bodyStart)}${body}${text.slice(active.bodyEnd)}`;
}
function exactStrings(values: unknown): values is string[] {
  return Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === "string" && value.length > 0);
}
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);
}
function sourceCopy(sources: readonly KnowledgeSourceRevision[]): KnowledgeSourceRevision[] {
  return sources.map((source) => ({ ...source })).sort((a, b) => a.segmentId.localeCompare(b.segmentId));
}
function sameSources(a: readonly KnowledgeSourceRevision[], b: readonly KnowledgeSourceRevision[]): boolean {
  return JSON.stringify(sourceCopy(a)) === JSON.stringify(sourceCopy(b));
}
function previousId(
  previous: SessionKnowledge | undefined,
  kind: "topic" | "decision" | "action" | "question",
  content: string,
  evidence: string[],
  sources: readonly KnowledgeSourceRevision[],
  allowedUnits: ReadonlyMap<string, Utterance>,
  topics: string[] = [],
): string | null {
  if (!previous) return null;
  const currentSources = new Map(sourceCopy(sources).map((source) => [source.segmentId, source]));
  const previousSources = new Map(sourceCopy(previous.sources).map((source) => [source.segmentId, source]));
  if (!evidence.every((id) => {
    const unit = allowedUnits.get(id);
    const current = unit && currentSources.get(unit.parentSegmentId);
    const prior = unit && previousSources.get(unit.parentSegmentId);
    return !!current && !!prior && JSON.stringify(current) === JSON.stringify(prior);
  })) return null;
  const candidates = kind === "topic" ? previous.topics : previous[`${kind}s`];
  const found = candidates.find((item) => {
    if (kind === "topic") {
      const topic = item as KnowledgeTopic;
      return JSON.stringify([topic.title, topic.summary]) === content && sameSet(topic.evidence, evidence);
    }
    const entry = item as KnowledgeItem;
    return entry.text === content && sameSet(entry.evidence, evidence) && sameSet(entry.topicIds, topics);
  });
  return found?.id ?? null;
}

/** Removes the protocol tail whether its JSON is valid or not, keeping it out of visible prose. */
export function parseSessionKnowledgeResponse(raw: string, context: ParseSessionKnowledgeContext): { body: string; knowledge: SessionKnowledge } {
  const extracted = cleanRaw(raw);
  const issues: SessionKnowledge["issues"] = [];
  const allowedUnits = new Map(context.allowed.map((unit) => [unit.id, unit]));
  const allowed = new Set(allowedUnits.keys());
  const empty = (): SessionKnowledge => ({ schemaVersion: 3, id: genId(), sourceRevision: context.sourceRevision, sources: sourceCopy(context.sources), status: "partial", issues, topics: [], decisions: [], actions: [], questions: [], projections: [...(context.projections ?? [])].map((projection) => ({ ...projection })) });
  if (!extracted.found) {
    issues.push({ part: context.part, reason: "missing-block" });
    const knowledge = empty(); knowledge.status = "unavailable";
    return { body: extracted.body, knowledge };
  }
  let value: unknown;
  try { value = extracted.payload === null ? null : JSON.parse(extracted.payload); }
  catch { value = null; }
  if (!isRecord(value) || (value.schemaVersion !== 2 && value.schemaVersion !== 3) || !Array.isArray(value.topics) || !Array.isArray(value.decisions) || !Array.isArray(value.actions) || !Array.isArray(value.questions)) {
    issues.push({ part: context.part, reason: "invalid-json" });
    return { body: extracted.body, knowledge: empty() };
  }
  const previous = context.previous;
  const topicByKey = new Map<string, KnowledgeTopic>();
  let invalidItem = false;
  let unknownEvidence = false;
  for (const rawTopic of value.topics) {
    if (!isRecord(rawTopic) || typeof rawTopic.key !== "string" || !rawTopic.key || typeof rawTopic.title !== "string" || !rawTopic.title.trim() || typeof rawTopic.summary !== "string" || !rawTopic.summary.trim() || !exactStrings(rawTopic.evidence)) { invalidItem = true; continue; }
    if (rawTopic.evidence.some((id) => !allowed.has(id))) { unknownEvidence = true; continue; }
    if (topicByKey.has(rawTopic.key)) { invalidItem = true; continue; }
    const id = previousId(previous, "topic", JSON.stringify([rawTopic.title, rawTopic.summary]), rawTopic.evidence, context.sources, allowedUnits) ?? `topic:${genId()}`;
    topicByKey.set(rawTopic.key, { id, title: rawTopic.title, summary: rawTopic.summary, evidence: [...new Set(rawTopic.evidence)] });
  }
  const entries: Record<"decisions" | "actions" | "questions", KnowledgeItem[]> = { decisions: [], actions: [], questions: [] };
  const normalized = new Set<KnowledgeIssueReason>();
  const decisionByKey = new Map<string, KnowledgeItem>();
  const supersedeKeys = new Map<KnowledgeItem, string>();
  for (const kind of ["decisions", "actions", "questions"] as const) {
    const rawItems = value[kind];
    if (!Array.isArray(rawItems)) { invalidItem = true; continue; }
    for (const rawItem of rawItems) {
      if (!isRecord(rawItem) || typeof rawItem.text !== "string" || !rawItem.text.trim() || !Array.isArray(rawItem.topics) || !rawItem.topics.every((key) => typeof key === "string") || !exactStrings(rawItem.evidence)) { invalidItem = true; continue; }
      if (rawItem.evidence.some((id) => !allowed.has(id))) { unknownEvidence = true; continue; }
      if (rawItem.topics.some((key) => !topicByKey.has(key))) { invalidItem = true; continue; }
      const topicIds = rawItem.topics.flatMap((key) => {
        const topic = topicByKey.get(key);
        return topic ? [topic.id] : [];
      });
      const id = previousId(previous, kind.slice(0, -1) as "decision" | "action" | "question", rawItem.text, rawItem.evidence, context.sources, allowedUnits, topicIds) ?? `${kind.slice(0, -1)}:${genId()}`;
      const item: KnowledgeItem = { id, text: rawItem.text, evidence: [...new Set(rawItem.evidence)], topicIds };
      if (kind === "decisions") {
        if (isDecisionStatus(rawItem.status)) item.status = rawItem.status;
        else { item.status = "proposed"; normalized.add("decision-status-defaulted"); }
        if (typeof rawItem.key === "string" && rawItem.key && !decisionByKey.has(rawItem.key)) decisionByKey.set(rawItem.key, item);
        if (item.status === "superseded") supersedeKeys.set(item, typeof rawItem.supersededBy === "string" ? rawItem.supersededBy : "");
      } else if (kind === "actions") {
        for (const field of ["owner", "due"] as const) {
          const verbatim = verbatimField(rawItem[field]);
          if (verbatim.value) item[field] = verbatim.value;
          if (verbatim.dropped) normalized.add("action-field-dropped");
        }
        if (isAcceptance(rawItem.acceptance)) item.acceptance = rawItem.acceptance;
        else { item.acceptance = "assigned"; normalized.add("action-acceptance-defaulted"); }
      }
      entries[kind].push(item);
    }
  }
  for (const [item, key] of supersedeKeys) {
    const target = decisionByKey.get(key);
    if (target && target !== item) item.supersededBy = target.id;
    else { item.status = "proposed"; normalized.add("decision-supersede-unresolved"); }
  }
  for (const item of entries.decisions) {
    if (downgradeSingleUtteranceConfirmation(item)) normalized.add("decision-confirm-downgraded");
  }
  if (invalidItem) issues.push({ part: context.part, reason: "invalid-item" });
  if (unknownEvidence) issues.push({ part: context.part, reason: "unknown-evidence" });
  for (const reason of normalized) issues.push({ part: context.part, reason });
  const knowledge = empty();
  knowledge.topics = [...topicByKey.values()];
  knowledge.decisions = entries.decisions; knowledge.actions = entries.actions; knowledge.questions = entries.questions;
  knowledge.status = issues.some((issue) => !isNormalizationIssue(issue.reason)) ? "partial" : "complete";
  return { body: extracted.body, knowledge };
}

/**
 * Soft check on "confirmed": a confirmation needs the proposal and the agreement, so a decision whose
 * evidence is a single utterance (necessarily one speaker) becomes "proposed". The item is kept.
 */
function downgradeSingleUtteranceConfirmation(item: KnowledgeItem): boolean {
  if (item.status !== "confirmed" || new Set(item.evidence).size >= 2) return false;
  item.status = "proposed";
  return true;
}

/** Exact-deduplicates merged part objects and refuses to resolve any conflicting utterance identity. */
export function createUnavailableSessionKnowledge(
  segments: readonly Segment[],
  reason: KnowledgeIssueReason,
): SessionKnowledge {
  const sources = new Map<string, KnowledgeSourceRevision>();
  for (const segment of segments) {
    if (!segment.transcript) continue;
    const current = getCurrentTranscript(segment.transcript);
    sources.set(segment.transcript.id, {
      segmentId: segment.transcript.id,
      revision: current.revision,
      normalizationRevision: current.normalizationRevision,
    });
  }
  return {
    schemaVersion: 3,
    id: `knowledge:${genId()}`,
    sourceRevision: getTranscriptSourceRevision(segments),
    sources: sourceCopy([...sources.values()]),
    status: "unavailable",
    issues: [{ part: 0, reason }],
    topics: [],
    decisions: [],
    actions: [],
    questions: [],
    projections: [],
  };
}
export function mergeSessionKnowledge(parts: readonly SessionKnowledge[], segments: readonly Segment[]): SessionKnowledge {
  const sourcesById = new Map<string, KnowledgeSourceRevision>();
  const sourceConflicts = new Set<string>();
  const utteranceContent = new Map<string, string>();
  for (const segment of segments) {
    if (!segment.transcript) continue;
    const current = getCurrentTranscript(segment.transcript);
    const source = { segmentId: segment.transcript.id, revision: current.revision, normalizationRevision: current.normalizationRevision };
    const previousSource = sourcesById.get(source.segmentId);
    if (previousSource && JSON.stringify(previousSource) !== JSON.stringify(source)) sourceConflicts.add(source.segmentId);
    else sourcesById.set(source.segmentId, source);
    for (const utterance of current.utterances) {
      const content = JSON.stringify(utterance);
      const old = utteranceContent.get(utterance.id);
      if (old !== undefined && old !== content) sourceConflicts.add(utterance.id);
      else utteranceContent.set(utterance.id, content);
    }
  }
  const sources = [...sourcesById.values()];
  const revision = getTranscriptSourceRevision(segments);
  const topics: KnowledgeTopic[] = [];
  const decisions: KnowledgeItem[] = [];
  const actions: KnowledgeItem[] = [];
  const questions: KnowledgeItem[] = [];
  const addExact = <T extends { id: string }>(target: T[], item: T, key: (entry: T) => string): T => {
    const identity = key(item);
    const existing = target.find((entry) => key(entry) === identity);
    if (existing) return existing;
    target.push({ ...item });
    return item;
  };
  const projections = new Map<string, UtteranceProjection>();
  const itemKey = (entry: KnowledgeItem) => JSON.stringify([entry.text, [...entry.evidence].sort(), [...entry.topicIds].sort()]);
  // Part-local decision id → merged decision id, for resolving supersededBy after exact duplicates collapse.
  const decisionIds = new Map<string, string>();
  const decisionsByText = new Map<string, KnowledgeItem[]>();
  for (const part of parts) {
    const topicIds = new Map<string, string>();
    for (const topic of part.topics) {
      const canonical = addExact(topics, { ...topic }, (entry) => JSON.stringify([entry.title, entry.summary, [...entry.evidence].sort()]));
      topicIds.set(topic.id, canonical.id);
    }
    for (const [items, target] of [[part.actions, actions], [part.questions, questions]] as const) {
      for (const item of items) {
        const remapped = { ...item, topicIds: item.topicIds.map((id) => topicIds.get(id) || id) };
        addExact(target, remapped, itemKey);
      }
    }
    for (const item of part.decisions) {
      const remapped: KnowledgeItem = { ...item, topicIds: item.topicIds.map((id) => topicIds.get(id) || id) };
      let canonical = decisions.find((entry) => itemKey(entry) === itemKey(remapped));
      if (!canonical) { canonical = remapped; decisions.push(canonical); }
      decisionIds.set(item.id, canonical.id);
      // The same decision text in a later part: the later part's status applies to every copy.
      const text = decisionText(item.text);
      const sameText = decisionsByText.get(text) ?? [];
      if (!sameText.includes(canonical)) sameText.push(canonical);
      decisionsByText.set(text, sameText);
      for (const entry of sameText) setDecisionStatus(entry, item);
    }
    for (const projection of part.projections) projections.set(projection.utteranceId, { ...projection });
  }
  let supersedeUnresolved = false;
  for (const decision of decisions) {
    if (decision.status !== "superseded") continue;
    const target = decision.supersededBy ? decisionIds.get(decision.supersededBy) : undefined;
    if (target && target !== decision.id && decisions.some((entry) => entry.id === target)) decision.supersededBy = target;
    else { setDecisionStatus(decision, { status: "proposed" }); supersedeUnresolved = true; }
  }
  const issues = parts.flatMap((part) => part.issues.map((issue) => ({ ...issue })));
  if (supersedeUnresolved) issues.push({ part: 0, reason: "decision-supersede-unresolved" });
  if (sourceConflicts.size) issues.push({ part: 0, reason: "source-changed" });
  if (parts.some((part) => part.sourceRevision !== revision)) issues.push({ part: 0, reason: "source-changed" });
  const blockingIssues = issues.filter((issue) => !isNormalizationIssue(issue.reason));
  const status: KnowledgeStatus = sourceConflicts.size || blockingIssues.some((issue) => issue.reason === "source-changed" || issue.reason === "invalid-item" || issue.reason === "invalid-json" || issue.reason === "unknown-evidence")
    ? "partial"
    : parts.length && parts.every((part) => part.status === "unavailable")
      ? "unavailable"
      : parts.length && parts.every((part) => part.status === "complete") && !blockingIssues.length
        ? "complete"
        : "partial";
  return {
    schemaVersion: 3,
    id: genId(),
    sourceRevision: revision,
    sources: sourceCopy(sources),
    status,
    issues,
    topics,
    decisions,
    actions,
    questions,
    projections: [...projections.values()],
  };
}

function decisionText(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/** Copies status and supersededBy from `source`; a version 2 source (no status) leaves the target unchanged. */
function setDecisionStatus(target: KnowledgeItem, source: Pick<KnowledgeItem, "status" | "supersededBy">): void {
  if (!source.status) return;
  target.status = source.status;
  if (source.status === "superseded" && source.supersededBy) target.supersededBy = source.supersededBy;
  else delete target.supersededBy;
}

export function serializeSessionKnowledge(knowledge: SessionKnowledge): string {
  return `<!-- ${NS_SESSION_KNOWLEDGE} ${safeJson(knowledge)} -->`;
}

function validKnowledge(value: unknown): value is SessionKnowledge {
  if (!isRecord(value) || (value.schemaVersion !== 2 && value.schemaVersion !== 3) || typeof value.id !== "string" || typeof value.sourceRevision !== "string" || !Array.isArray(value.sources) || !Array.isArray(value.issues) || !Array.isArray(value.topics) || !Array.isArray(value.decisions) || !Array.isArray(value.actions) || !Array.isArray(value.questions) || !Array.isArray(value.projections) || typeof value.status !== "string" || !["complete", "partial", "unavailable", "stale"].includes(value.status)) return false;
  if (!value.sources.every((source) => isRecord(source) && typeof source.segmentId === "string" && Number.isInteger(source.revision) && Number.isInteger(source.normalizationRevision))) return false;
  if (!value.issues.every((issue) => isRecord(issue) && Number.isInteger(issue.part) && typeof issue.reason === "string" && REASONS.has(issue.reason as KnowledgeIssueReason))) return false;
  if (!value.topics.every((topic) => isRecord(topic) && typeof topic.id === "string" && typeof topic.title === "string" && typeof topic.summary === "string" && exactStrings(topic.evidence))) return false;
  const validItems = (items: unknown[]) => items.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.text === "string" && exactStrings(item.evidence) && Array.isArray(item.topicIds) && item.topicIds.every((id) => typeof id === "string")
    && (item.status === undefined || isDecisionStatus(item.status))
    && (item.supersededBy === undefined || typeof item.supersededBy === "string")
    && (item.owner === undefined || typeof item.owner === "string")
    && (item.due === undefined || typeof item.due === "string")
    && (item.acceptance === undefined || isAcceptance(item.acceptance)));
  return validItems(value.decisions) && validItems(value.actions) && validItems(value.questions) && value.projections.every((projection) => isRecord(projection) && typeof projection.utteranceId === "string" && typeof projection.normalizedText === "string" && (projection.speakerName === null || typeof projection.speakerName === "string"));
}

export function readSessionKnowledge(markdown: string): SessionKnowledge | null {
  const found = cleanRaw(markdown);
  if (!found.found || found.payload === null) return null;
  try { const value: unknown = JSON.parse(found.payload); return validKnowledge(value) ? value : null; }
  catch { return null; }
}

/** Current-ledger lookup for one knowledge snapshot; built once and reused for every item of a note. */
export interface KnowledgeEvidenceIndex {
  /** False when the snapshot's source revision or source list no longer matches the ledger. */
  fresh: boolean;
  byId: Map<string, Utterance>;
  conflicts: Set<string>;
  projections: Map<string, UtteranceProjection>;
}

export function buildKnowledgeEvidenceIndex(knowledge: SessionKnowledge, segments: readonly Segment[]): KnowledgeEvidenceIndex {
  const sourceRevision = getTranscriptSourceRevision(segments);
  const sources = segments.flatMap((segment) => {
    if (!segment.transcript) return [];
    const current = getCurrentTranscript(segment.transcript);
    return [{ segmentId: segment.transcript.id, revision: current.revision, normalizationRevision: current.normalizationRevision }];
  });
  const fresh = knowledge.sourceRevision === sourceRevision && sameSources(knowledge.sources, sources);
  const byId = new Map<string, Utterance>();
  const conflicts = new Set<string>();
  const projections = new Map<string, UtteranceProjection>();
  if (!fresh) return { fresh, byId, conflicts, projections };
  for (const segment of segments) {
    if (!segment.transcript) continue;
    for (const utterance of getCurrentTranscript(segment.transcript).utterances) {
      const previous = byId.get(utterance.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(utterance)) conflicts.add(utterance.id);
      else byId.set(utterance.id, utterance);
    }
  }
  for (const projection of knowledge.projections) {
    if (!projections.has(projection.utteranceId)) projections.set(projection.utteranceId, projection);
  }
  return { fresh, byId, conflicts, projections };
}

/** One evidence utterance with the snapshot's projection applied; null when missing, conflicting or stale. */
export function resolveIndexedUtterance(index: KnowledgeEvidenceIndex, utteranceId: string): Utterance | null {
  if (!index.fresh || index.conflicts.has(utteranceId)) return null;
  const utterance = index.byId.get(utteranceId);
  if (!utterance) return null;
  const projection = index.projections.get(utteranceId);
  return projection ? { ...utterance, normalizedText: projection.normalizedText, speakerName: projection.speakerName } : utterance;
}

export function resolveKnowledgeEvidence(knowledge: SessionKnowledge, itemId: string, segments: readonly Segment[]): { status: "resolved" | "stale" | "missing" | "conflict"; utterances: Utterance[] } {
  const item = [...knowledge.topics, ...knowledge.decisions, ...knowledge.actions, ...knowledge.questions].find((candidate) => candidate.id === itemId);
  if (knowledge.status === "stale") return { status: "stale", utterances: [] };
  if (!item) return { status: "missing", utterances: [] };
  const index = buildKnowledgeEvidenceIndex(knowledge, segments);
  if (!index.fresh) return { status: "stale", utterances: [] };
  if (item.evidence.some((id) => index.conflicts.has(id))) return { status: "conflict", utterances: [] };
  const utterances: Utterance[] = [];
  for (const id of item.evidence) {
    const utterance = resolveIndexedUtterance(index, id);
    if (!utterance) return { status: "missing", utterances: [] };
    utterances.push(utterance);
  }
  return { status: "resolved", utterances };
}
