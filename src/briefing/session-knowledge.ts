import { NS_ACTIVE_VERSION_BODY_RE, NS_SESSION_KNOWLEDGE } from "../shared/namespace";
import { genId, isRecord } from "../shared/util-common";
import type { Segment } from "../shared/types";
import { getCurrentTranscript, getTranscriptSourceRevision, type Utterance } from "../transcript/session-transcript";


export type KnowledgeStatus = "complete" | "partial" | "unavailable" | "stale";
export type KnowledgeIssueReason = "missing-block" | "invalid-json" | "invalid-item" | "unknown-evidence" | "source-presummarized" | "source-changed" | "mode-off";
export interface KnowledgeItem { id: string; text: string; evidence: string[]; topicIds: string[] }
export interface KnowledgeTopic { id: string; title: string; summary: string; evidence: string[] }
export interface KnowledgeSourceRevision { segmentId: string; revision: number; normalizationRevision: number }
export interface UtteranceProjection { utteranceId: string; normalizedText: string; speakerName: string | null }
export interface SessionKnowledge {
  schemaVersion:  2;
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
const REASONS = new Set<KnowledgeIssueReason>(["missing-block", "invalid-json", "invalid-item", "unknown-evidence", "source-presummarized", "source-changed", "mode-off"]);
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
  if (marker.test(section)) return section.replace(marker, serialized);
  const body = section.trimEnd();
  return `${body}${body ? "\n\n" : ""}${serialized}`;
}

/** Remove complete blocks and discard any malformed protocol tail. */
export function stripSessionKnowledgeBlocks(raw: string): string {
  const text = String(raw || "").replace(knowledgeCommentPattern(true), "");
  const malformedTail = MARKER_START.exec(text);
  return (malformedTail ? text.slice(0, malformedTail.index) : text).trimEnd();
}

export function readSelectedSessionKnowledge(markdown: string): SessionKnowledge | null {
  const active = NS_ACTIVE_VERSION_BODY_RE.exec(String(markdown || ""));
  return active ? readSessionKnowledge(active[1]) : readSessionKnowledge(markdown);
}

/** Replace the snapshot for the selected display version without moving raw source blocks. */
export function upsertSelectedSessionKnowledge(markdown: string, knowledge: SessionKnowledge): string {
  const text = String(markdown || "");
  const serialized = serializeSessionKnowledge(knowledge);
  const active = NS_ACTIVE_VERSION_BODY_RE.exec(text);
  if (!active) return replaceKnowledgeInSection(text, serialized);
  const bodyStart = active[0].indexOf(active[1], active[0].indexOf("-->") + 3);
  const bodyEnd = bodyStart + active[1].length;
  const body = replaceKnowledgeInSection(active[1], serialized);
  const nextBlock = `${active[0].slice(0, bodyStart)}${body}${active[0].slice(bodyEnd)}`;
  return `${text.slice(0, active.index)}${nextBlock}${text.slice(active.index + active[0].length)}`;
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
  const empty = (): SessionKnowledge => ({ schemaVersion: 2, id: genId(), sourceRevision: context.sourceRevision, sources: sourceCopy(context.sources), status: "partial", issues, topics: [], decisions: [], actions: [], questions: [], projections: [...(context.projections ?? [])].map((projection) => ({ ...projection })) });
  if (!extracted.found) {
    issues.push({ part: context.part, reason: "missing-block" });
    const knowledge = empty(); knowledge.status = "unavailable";
    return { body: extracted.body, knowledge };
  }
  let value: unknown;
  try { value = extracted.payload === null ? null : JSON.parse(extracted.payload); }
  catch { value = null; }
  if (!isRecord(value) || value.schemaVersion !== 2 || !Array.isArray(value.topics) || !Array.isArray(value.decisions) || !Array.isArray(value.actions) || !Array.isArray(value.questions)) {
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
      entries[kind].push({ id, text: rawItem.text, evidence: [...new Set(rawItem.evidence)], topicIds });
    }
  }
  if (invalidItem) issues.push({ part: context.part, reason: "invalid-item" });
  if (unknownEvidence) issues.push({ part: context.part, reason: "unknown-evidence" });
  const knowledge = empty();
  knowledge.topics = [...topicByKey.values()];
  knowledge.decisions = entries.decisions; knowledge.actions = entries.actions; knowledge.questions = entries.questions;
  knowledge.status = issues.length ? "partial" : "complete";
  return { body: extracted.body, knowledge };
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
    schemaVersion: 2,
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
  for (const part of parts) {
    const topicIds = new Map<string, string>();
    for (const topic of part.topics) {
      const canonical = addExact(topics, { ...topic }, (entry) => JSON.stringify([entry.title, entry.summary, [...entry.evidence].sort()]));
      topicIds.set(topic.id, canonical.id);
    }
    for (const [items, target] of [[part.decisions, decisions], [part.actions, actions], [part.questions, questions]] as const) {
      for (const item of items) {
        const remapped = { ...item, topicIds: item.topicIds.map((id) => topicIds.get(id) || id) };
        addExact(target, remapped, (entry) => JSON.stringify([entry.text, [...entry.evidence].sort(), [...entry.topicIds].sort()]));
      }
    }
    for (const projection of part.projections) projections.set(projection.utteranceId, { ...projection });
  }
  const issues = parts.flatMap((part) => part.issues.map((issue) => ({ ...issue })));
  if (sourceConflicts.size) issues.push({ part: 0, reason: "source-changed" });
  if (parts.some((part) => part.sourceRevision !== revision)) issues.push({ part: 0, reason: "source-changed" });
  const status: KnowledgeStatus = sourceConflicts.size || issues.some((issue) => issue.reason === "source-changed" || issue.reason === "invalid-item" || issue.reason === "invalid-json" || issue.reason === "unknown-evidence")
    ? "partial"
    : parts.length && parts.every((part) => part.status === "unavailable")
      ? "unavailable"
      : parts.length && parts.every((part) => part.status === "complete") && !issues.length
        ? "complete"
        : "partial";
  return {
    schemaVersion: 2,
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

export function serializeSessionKnowledge(knowledge: SessionKnowledge): string {
  return `<!-- ${NS_SESSION_KNOWLEDGE} ${safeJson(knowledge)} -->`;
}

function validKnowledge(value: unknown): value is SessionKnowledge {
  if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.id !== "string" || typeof value.sourceRevision !== "string" || !Array.isArray(value.sources) || !Array.isArray(value.issues) || !Array.isArray(value.topics) || !Array.isArray(value.decisions) || !Array.isArray(value.actions) || !Array.isArray(value.questions) || !Array.isArray(value.projections) || typeof value.status !== "string" || !["complete", "partial", "unavailable", "stale"].includes(value.status)) return false;
  if (!value.sources.every((source) => isRecord(source) && typeof source.segmentId === "string" && Number.isInteger(source.revision) && Number.isInteger(source.normalizationRevision))) return false;
  if (!value.issues.every((issue) => isRecord(issue) && Number.isInteger(issue.part) && typeof issue.reason === "string" && REASONS.has(issue.reason as KnowledgeIssueReason))) return false;
  if (!value.topics.every((topic) => isRecord(topic) && typeof topic.id === "string" && typeof topic.title === "string" && typeof topic.summary === "string" && exactStrings(topic.evidence))) return false;
  const validItems = (items: unknown[]) => items.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.text === "string" && exactStrings(item.evidence) && Array.isArray(item.topicIds) && item.topicIds.every((id) => typeof id === "string"));
  return validItems(value.decisions) && validItems(value.actions) && validItems(value.questions) && value.projections.every((projection) => isRecord(projection) && typeof projection.utteranceId === "string" && typeof projection.normalizedText === "string" && (projection.speakerName === null || typeof projection.speakerName === "string"));
}

export function readSessionKnowledge(markdown: string): SessionKnowledge | null {
  const found = cleanRaw(markdown);
  if (!found.found || found.payload === null) return null;
  try { const value: unknown = JSON.parse(found.payload); return validKnowledge(value) ? value : null; }
  catch { return null; }
}

export function resolveKnowledgeEvidence(knowledge: SessionKnowledge, itemId: string, segments: readonly Segment[]): { status: "resolved" | "stale" | "missing" | "conflict"; utterances: Utterance[] } {
  const item = [...knowledge.topics, ...knowledge.decisions, ...knowledge.actions, ...knowledge.questions].find((candidate) => candidate.id === itemId);
  if (knowledge.status === "stale") return { status: "stale", utterances: [] };
  if (!item) return { status: "missing", utterances: [] };
  const sourceRevision = getTranscriptSourceRevision(segments);
  const sources = segments.flatMap((segment) => {
    if (!segment.transcript) return [];
    const current = getCurrentTranscript(segment.transcript);
    return [{ segmentId: segment.transcript.id, revision: current.revision, normalizationRevision: current.normalizationRevision }];
  });
  if (knowledge.sourceRevision !== sourceRevision || !sameSources(knowledge.sources, sources)) return { status: "stale", utterances: [] };
  const byId = new Map<string, Utterance>();
  const conflicts = new Set<string>();
  for (const segment of segments) {
    if (!segment.transcript) continue;
    for (const utterance of getCurrentTranscript(segment.transcript).utterances) {
      const previous = byId.get(utterance.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(utterance)) conflicts.add(utterance.id);
      else byId.set(utterance.id, utterance);
    }
  }
  if (item.evidence.some((id) => conflicts.has(id))) return { status: "conflict", utterances: [] };
  const utterances: Utterance[] = [];
  for (const id of item.evidence) {
    const utterance = byId.get(id);
    if (!utterance) return { status: "missing", utterances: [] };
    const projection = knowledge.projections.find((candidate) => candidate.utteranceId === id);
    utterances.push(projection ? { ...utterance, normalizedText: projection.normalizedText, speakerName: projection.speakerName } : utterance);
  }
  return { status: "resolved", utterances };
}
