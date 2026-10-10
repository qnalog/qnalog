import { findRelatedNotes, type RelatedNoteDocument } from "../indexing/related-notes";
import type { OverviewCard } from "./overview-card";

export const TOPIC_SUGGESTION_EDGE_THRESHOLD = 0.18;
export const TOPIC_SUGGESTION_MIN_COHESION = 0.12;
export const TOPIC_SUGGESTION_MAX_MEMBERS = 24;
export const TOPIC_SUGGESTION_DEFAULT_LIMIT = 12;

export interface TopicSuggestion {
  id: string; draftName: string; memberPaths: string[]; dateRange: { from: string; to: string };
  snippets: string[]; cohesion: number; reasons: string[]; missingOverview: number;
}
export interface TopicSuggestionOptions { limit?: number; ignoredIds?: ReadonlySet<string>; edgeThreshold?: number; maxMembers?: number }

function hash(text: string): string {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0).toString(36);
}
function toDocument(card: OverviewCard): RelatedNoteDocument {
  return {
    path: card.path, sourceId: card.sourceId, title: card.title, timestamp: Date.parse(card.date) || card.mtime,
    tags: card.tags, people: card.people, topics: [], summary: card.overview, decisions: [], actions: [], questions: [],
    bodyExcerpt: "", outLinks: card.outLinks, inLinks: card.inLinks, unresolvedTargets: card.unresolvedTargets,
    precision: card.precision, hasIndexCard: true,
  };
}
function words(cards: readonly OverviewCard[]): string[] {
  const counts = new Map<string, number>();
  for (const card of cards) {
    for (const token of [...card.tags, ...(card.overview.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])]) {
      const value = token.trim(); if (value) counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return [...counts.keys()].sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b));
}
function draftName(cards: readonly OverviewCard[]): string { return words(cards).slice(0, 2).join(" · ") || cards.map((card) => card.title).sort()[0] || ""; }

export function suggestTopics(cardsInput: readonly OverviewCard[], existingMembers: ReadonlyMap<string, readonly string[]> = new Map(), options: TopicSuggestionOptions = {}): TopicSuggestion[] {
  const cards = [...cardsInput].sort((a, b) => a.path.localeCompare(b.path));
  if (cards.length < 2) return [];
  const docs = cards.map(toDocument);
  const byPath = new Map(cards.map((card) => [card.path, card]));
  const adjacency = new Map(cards.map((card) => [card.path, new Set<string>()]));
  const edgeReasons = new Map<string, Set<string>>();
  const edgeScores = new Map<string, number>();
  const threshold = options.edgeThreshold ?? TOPIC_SUGGESTION_EDGE_THRESHOLD;
  for (const doc of docs) {
    const matches = findRelatedNotes(docs, doc, { limit: docs.length, minScore: threshold, relativeCutoff: 0 });
    for (const match of matches) {
      const left = byPath.get(doc.path); const right = byPath.get(match.path);
      if (!left || !right) continue;
      const weight = match.score * (left.overview ? 1 : 0.5) * (right.overview ? 1 : 0.5);
      if (weight < threshold) continue;
      const key = [doc.path, match.path].sort().join("\n");
      edgeScores.set(key, Math.max(edgeScores.get(key) || 0, weight));
      edgeReasons.set(key, new Set([...(edgeReasons.get(key) || []), ...match.reasons]));
      adjacency.get(doc.path)?.add(match.path);
      adjacency.get(match.path)?.add(doc.path);
    }
  }
  const maxMembers = options.maxMembers ?? TOPIC_SUGGESTION_MAX_MEMBERS;
  const remaining = new Set(cards.map((card) => card.path));
  const suggestions: TopicSuggestion[] = [];
  while (remaining.size) {
    const seed = [...remaining].sort()[0];
    const members = [seed];
    remaining.delete(seed);
    while (members.length < maxMembers) {
      const candidates = new Set(members.flatMap((path) => [...(adjacency.get(path) || [])]).filter((path) => remaining.has(path)));
      const ranked = [...candidates].map((path) => {
        const average = members.reduce((sum, member) => sum + (edgeScores.get([member, path].sort().join("\n")) || 0), 0) / members.length;
        return { path, average };
      }).filter(({ average }) => average >= TOPIC_SUGGESTION_MIN_COHESION)
        .sort((a, b) => b.average - a.average || a.path.localeCompare(b.path));
      const best = ranked[0];
      if (!best) break;
      members.push(best.path);
      remaining.delete(best.path);
    }
    if (members.length < 2) continue;
    const suggestionCards = members.flatMap((path) => {
      const card = byPath.get(path);
      return card ? [card] : [];
    }).sort((a, b) => a.path.localeCompare(b.path));
    const memberPaths = suggestionCards.map((member) => member.path);
    if (memberPaths.some((path) => [...existingMembers.values()].some((paths) => paths.includes(path)))) continue;
    const pairs: number[] = [];
    for (let i = 0; i < memberPaths.length; i++) for (let j = i + 1; j < memberPaths.length; j++) {
      pairs.push(edgeScores.get([memberPaths[i], memberPaths[j]].join("\n")) || 0);
    }
    const cohesion = pairs.length ? pairs.reduce((sum, score) => sum + score, 0) / pairs.length : 0;
    if (cohesion < TOPIC_SUGGESTION_MIN_COHESION) continue;
    const id = `topic-${hash(memberPaths.join("\n"))}`;
    if (options.ignoredIds?.has(id)) continue;
    const dates = suggestionCards.map((member) => member.date).filter(Boolean).sort();
    const snippets = suggestionCards.filter((member) => member.overview).slice(0, 3).map((member) => member.overview.slice(0, 120));
    const reasons = new Set(suggestionCards.flatMap((member) => member.tags.map((tag) => `shared-tag:${tag}`)));
    if (suggestionCards.some((member) => suggestionCards.some((other) => other.path !== member.path && member.people.some((person) => other.people.includes(person))))) reasons.add("shared-person");
    const edgeKeys = [...edgeReasons.keys()].filter((key) => {
      const [left, right] = key.split("\n");
      return memberPaths.includes(left) && memberPaths.includes(right);
    });
    if (edgeKeys.some((key) => edgeReasons.get(key)?.has("lexical-overlap"))) reasons.add("lexical-overlap");
    if (edgeKeys.some((key) => [...(edgeReasons.get(key) || [])].some((reason) => reason !== "lexical-overlap"))) reasons.add("link-relation");
    if (suggestionCards.some((member) => !member.overview)) reasons.add("missing-overview");
    suggestions.push({ id, draftName: draftName(suggestionCards), memberPaths, dateRange: { from: dates[0] || "", to: dates[dates.length - 1] || "" }, snippets, cohesion,
      reasons: [...reasons].slice(0, 8), missingOverview: suggestionCards.filter((member) => !member.overview).length });
  }
  return suggestions.sort((a, b) => b.memberPaths.length - a.memberPaths.length || b.dateRange.to.localeCompare(a.dateRange.to) || b.cohesion - a.cohesion || a.id.localeCompare(b.id)).slice(0, Math.max(0, options.limit ?? TOPIC_SUGGESTION_DEFAULT_LIMIT));
}

export function suggestTopicsForNote(card: OverviewCard, cards: readonly OverviewCard[], options: TopicSuggestionOptions = {}): TopicSuggestion[] {
  return suggestTopics(cards, new Map(), options).filter((suggestion) => suggestion.memberPaths.includes(card.path));
}
