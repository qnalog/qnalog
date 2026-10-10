import { createRelatedNotesIndex, type RelatedNoteDocument } from "../indexing/related-notes";
import { MODE_META, MODE_PREFIX_EN_TO_KEY, MODE_PREFIX_TO_KEY } from "../shared/catalog-modes";
import type { OverviewCard } from "./overview-card";
import { normalizeTagKey } from "./overview-card";

// Reviewed pairs score around 0.07; the lower edge cutoff admits card-only score variation, while cohesion blocks chains.
export const TOPIC_SUGGESTION_EDGE_THRESHOLD = 0.05;
export const TOPIC_SUGGESTION_MIN_COHESION = 0.07;
export const TOPIC_SUGGESTION_MAX_MEMBERS = 24;
// The evaluation fixture's largest valid topic has 40 notes; a one-sided top-15 cut discarded reciprocal edges.
export const TOPIC_SUGGESTION_NEIGHBOR_LIMIT = 40;
export const TOPIC_SUGGESTION_BATCH_SIZE = 256;
export const TOPIC_SUGGESTION_DEFAULT_LIMIT = 12;
export const TOPIC_SUGGESTION_NAME_MAX_CHARS = 16;

export interface TopicSuggestion {
  id: string; draftName: string; memberPaths: string[]; dateRange: { from: string; to: string };
  snippets: string[]; cohesion: number; reasons: string[]; missingOverview: number;
}
export interface TopicSuggestionOptions {
  limit?: number;
  ignoredIds?: ReadonlySet<string>;
  edgeThreshold?: number;
  minCohesion?: number;
  maxMembers?: number;
  neighborLimit?: number;
  batchSize?: number;
  signal?: AbortSignal;
}

interface TopicEdge { left: string; right: string; score: number; reasons: Set<string> }
interface TopicBuildContext {
  cards: OverviewCard[];
  docs: RelatedNoteDocument[];
  index: ReturnType<typeof createRelatedNotesIndex>;
  byPath: Map<string, OverviewCard>;
  edges: TopicEdge[];
  edgeScores: Map<string, number>;
  edgeReasons: Map<string, Set<string>>;
}

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

const modePrefixes = [...new Set([
  ...Object.keys(MODE_PREFIX_TO_KEY),
  ...Object.keys(MODE_PREFIX_EN_TO_KEY),
  ...Object.values(MODE_META).map(({ prefix }) => prefix),
])].sort((left, right) => right.length - left.length || left.localeCompare(right));

function titleText(title: string): string {
  const withoutDate = title
    .replace(/^\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{3,4})?\s*/, "")
    .replace(/^[-·\s]+/, "");
  const mode = modePrefixes.find((prefix) => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[-·\\s]|$)`, "i").test(withoutDate));
  return (mode ? withoutDate.slice(mode.length) : withoutDate).replace(/^[-·\s]+/, "").trim();
}
function titleFragments(card: OverviewCard): string[] {
  return titleText(card.title).split(/[-·\s]+/u).map((part) => part.trim()).filter((part) => Array.from(part).length >= 2);
}
function nameCandidates(card: OverviewCard): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const add = (display: string) => {
    const key = normalizeTagKey(display);
    if (!key || Array.from(display).length > TOPIC_SUGGESTION_NAME_MAX_CHARS) return;
    const displays = result.get(key) || [];
    if (!displays.includes(display)) displays.push(display);
    result.set(key, displays);
  };
  for (const tag of card.tags) add(tag);
  for (const fragment of titleFragments(card)) add(fragment);
  return result;
}
function longestCommonSubstring(titles: string[]): string {
  if (!titles.length) return "";
  const first = Array.from(titleText(titles[0]));
  const others = titles.slice(1).map((title) => Array.from(titleText(title)));
  let best = "";
  for (let start = 0; start < first.length; start++) {
    for (let end = first.length; end > start; end--) {
      if (end - start <= Array.from(best).length) break;
      const candidate = first.slice(start, end).join("").trim();
      if (Array.from(candidate).length < 3 || /[-·\s]/u.test(candidate)) continue;
      if (others.every((title) => title.join("").includes(candidate))) best = candidate;
    }
  }
  return best;
}
function draftName(cards: readonly OverviewCard[], allCards: readonly OverviewCard[]): string {
  const clusterCandidates = new Map<string, { count: number; variants: Map<string, number> }>();
  for (const card of cards) for (const [key, variants] of nameCandidates(card)) {
    const current = clusterCandidates.get(key) || { count: 0, variants: new Map<string, number>() };
    current.count++;
    for (const variant of variants) current.variants.set(variant, (current.variants.get(variant) || 0) + 1);
    clusterCandidates.set(key, current);
  }
  const documentFrequencies = new Map<string, number>();
  for (const card of allCards) for (const key of nameCandidates(card).keys()) {
    documentFrequencies.set(key, (documentFrequencies.get(key) || 0) + 1);
  }
  const ranked = [...clusterCandidates].map(([key, candidate]) => {
    const display = [...candidate.variants].sort((a, b) => b[1] - a[1] || Array.from(a[0]).length - Array.from(b[0]).length || a[0].localeCompare(b[0]))[0]?.[0] || key;
    const score = (candidate.count / cards.length) * Math.log((allCards.length + 1) / ((documentFrequencies.get(key) || 0) + 1));
    return { display, score };
  }).sort((a, b) => b.score - a.score || Array.from(a.display).length - Array.from(b.display).length || a.display.localeCompare(b.display));
  if (ranked.length && ranked[0].score > 0) return ranked[0].display;
  const common = longestCommonSubstring(cards.map((card) => card.title));
  if (common) return common;
  const firstTitle = titleFragments([...cards].sort((a, b) => a.path.localeCompare(b.path))[0] || cards[0])[0] || cards[0]?.title || "";
  return Array.from(firstTitle).slice(0, TOPIC_SUGGESTION_NAME_MAX_CHARS).join("");
}

function makeBuildContext(cardsInput: readonly OverviewCard[]): TopicBuildContext | null {
  const cards = [...cardsInput].sort((a, b) => a.path.localeCompare(b.path));
  if (cards.length < 2) return null;
  const docs = cards.map(toDocument);
  return {
    cards,
    docs,
    index: createRelatedNotesIndex(docs, { includeTagsInQuery: true }),
    byPath: new Map(cards.map((card) => [card.path, card])),
    edges: [],
    edgeScores: new Map(),
    edgeReasons: new Map(),
  };
}

function edgeKey(left: string, right: string): string {
  return left.localeCompare(right) < 0 ? `${left}\n${right}` : `${right}\n${left}`;
}
function rootOf(parent: Map<string, string>, path: string): string {
  let root = path;
  while (parent.get(root) !== root) root = parent.get(root) || root;
  let current = path;
  while (parent.get(current) !== root) {
    const next = parent.get(current) || root;
    parent.set(current, root);
    current = next;
  }
  return root;
}
function crossScore(left: Set<string>, right: Set<string>, scores: Map<string, number>): number {
  let total = 0;
  for (const leftPath of left) for (const rightPath of right) {
    total += scores.get(edgeKey(leftPath, rightPath)) || 0;
  }
  return total;
}

function* buildSuggestions(
  cardsInput: readonly OverviewCard[],
  existingMembers: ReadonlyMap<string, readonly string[]>,
  options: TopicSuggestionOptions,
): Generator<void, TopicSuggestion[], void> {
  const context = makeBuildContext(cardsInput);
  if (!context) return [];
  options.signal?.throwIfAborted();
  const cards = context.cards;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? TOPIC_SUGGESTION_BATCH_SIZE));
  const threshold = options.edgeThreshold ?? TOPIC_SUGGESTION_EDGE_THRESHOLD;
  const neighborLimit = options.neighborLimit ?? TOPIC_SUGGESTION_NEIGHBOR_LIMIT;
  const directed = new Map<string, Map<string, { score: number; reasons: string[] }>>();
  let work = 0;
  for (const doc of context.docs) {
    options.signal?.throwIfAborted();
    const matches = context.index.query(doc, { limit: neighborLimit, minScore: threshold, relativeCutoff: 0 });
    directed.set(doc.path, new Map(matches.map((match) => [match.path, { score: match.score, reasons: match.reasons }])));
    if (++work % batchSize === 0) yield;
  }
  for (const [left, matches] of directed) for (const [right, match] of matches) {
    options.signal?.throwIfAborted();
    if (left.localeCompare(right) < 0) {
      const reverse = directed.get(right)?.get(left);
      if (reverse) {
        const key = `${left}\n${right}`;
        context.edgeScores.set(key, Math.min(match.score, reverse.score));
        context.edgeReasons.set(key, new Set([...match.reasons, ...reverse.reasons]));
      }
    }
    if (++work % batchSize === 0) yield;
  }
  context.edges = [...context.edgeScores].map(([key, score]) => {
    const [left, right] = key.split("\n");
    return { left, right, score, reasons: context.edgeReasons.get(key) || new Set<string>() };
  }).sort((a, b) => b.score - a.score || a.left.localeCompare(b.left) || a.right.localeCompare(b.right));
  const parent = new Map(cards.map((card) => [card.path, card.path]));
  const membersByRoot = new Map(cards.map((card) => [card.path, new Set([card.path])]));
  const pairScoreSums = new Map(cards.map((card) => [card.path, 0]));
  const componentVersions = new Map(cards.map((card) => [card.path, 0]));
  const checkedMerges = new Set<string>();
  const maxMembers = options.maxMembers ?? TOPIC_SUGGESTION_MAX_MEMBERS;
  const minCohesion = options.minCohesion ?? TOPIC_SUGGESTION_MIN_COHESION;
  work = 0;
  for (const edge of context.edges) {
    options.signal?.throwIfAborted();
    const leftRoot = rootOf(parent, edge.left);
    const rightRoot = rootOf(parent, edge.right);
    if (leftRoot !== rightRoot) {
      const firstRoot = leftRoot.localeCompare(rightRoot) <= 0 ? leftRoot : rightRoot;
      const secondRoot = firstRoot === leftRoot ? rightRoot : leftRoot;
      const mergeKey = `${firstRoot}:${componentVersions.get(firstRoot) || 0}\n${secondRoot}:${componentVersions.get(secondRoot) || 0}`;
      if (!checkedMerges.has(mergeKey)) {
        checkedMerges.add(mergeKey);
        const leftMembers = membersByRoot.get(leftRoot) || new Set<string>();
        const rightMembers = membersByRoot.get(rightRoot) || new Set<string>();
        const combinedSize = leftMembers.size + rightMembers.size;
        if (combinedSize <= maxMembers) {
          const combinedScore = (pairScoreSums.get(leftRoot) || 0) + (pairScoreSums.get(rightRoot) || 0)
            + crossScore(leftMembers, rightMembers, context.edgeScores);
          const pairCount = combinedSize * (combinedSize - 1) / 2;
          if (combinedScore / pairCount >= minCohesion) {
            const root = firstRoot;
            const child = secondRoot;
            parent.set(child, root);
            membersByRoot.set(root, new Set([...leftMembers, ...rightMembers]));
            membersByRoot.delete(child);
            pairScoreSums.set(root, combinedScore);
            pairScoreSums.delete(child);
            componentVersions.set(root, (componentVersions.get(root) || 0) + 1);
            componentVersions.delete(child);
          }
        }
      }
    }
    if (++work % batchSize === 0) yield;
  }
  const groups = [...membersByRoot.values()].filter((members) => members.size >= 2)
    .map((members) => [...members].sort((a, b) => a.localeCompare(b)))
    .sort((a, b) => a[0].localeCompare(b[0]));
  const suggestions: TopicSuggestion[] = [];
  for (const paths of groups) {
    const suggestionCards = paths.flatMap((path) => {
      const card = context.byPath.get(path);
      return card ? [card] : [];
    });
    if (paths.some((path) => [...existingMembers.values()].some((knownPaths) => knownPaths.includes(path)))) continue;
    const pairScores: number[] = [];
    for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
      pairScores.push(context.edgeScores.get(edgeKey(paths[i], paths[j])) || 0);
    }
    const cohesion = pairScores.length ? pairScores.reduce((sum, score) => sum + score, 0) / pairScores.length : 0;
    if (cohesion < minCohesion) continue;
    const id = `topic-${hash(paths.join("\n"))}`;
    if (options.ignoredIds?.has(id)) continue;
    const dates = suggestionCards.map((member) => member.date).filter(Boolean).sort();
    const snippets = suggestionCards.filter((member) => member.overview).slice(0, 3)
      .map((member) => Array.from(member.overview).slice(0, 120).join(""));
    const reasons = new Set(suggestionCards.flatMap((member) => member.tags.map((tag) => `shared-tag:${tag}`)));
    if (suggestionCards.some((member) => suggestionCards.some((other) => other.path !== member.path && member.people.some((person) => other.people.includes(person))))) reasons.add("shared-person");
    const edgeKeys = [...context.edgeReasons.keys()].filter((key) => {
      const [left, right] = key.split("\n");
      return paths.includes(left) && paths.includes(right);
    });
    if (edgeKeys.some((key) => context.edgeReasons.get(key)?.has("lexical-overlap"))) reasons.add("lexical-overlap");
    if (edgeKeys.some((key) => [...(context.edgeReasons.get(key) || [])].some((reason) => reason !== "lexical-overlap"))) reasons.add("link-relation");
    if (suggestionCards.some((member) => !member.overview)) reasons.add("missing-overview");
    suggestions.push({
      id, draftName: draftName(suggestionCards, cards), memberPaths: paths,
      dateRange: { from: dates[0] || "", to: dates[dates.length - 1] || "" },
      snippets, cohesion, reasons: [...reasons].slice(0, 8),
      missingOverview: suggestionCards.filter((member) => !member.overview).length,
    });
    if (++work % batchSize === 0) yield;
  }
  return suggestions.sort((a, b) => b.memberPaths.length - a.memberPaths.length
    || b.dateRange.to.localeCompare(a.dateRange.to) || b.cohesion - a.cohesion || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, options.limit ?? TOPIC_SUGGESTION_DEFAULT_LIMIT));
}

/** Synchronous pure version used by tests and callers that do not need cancellation. */
export function suggestTopics(
  cards: readonly OverviewCard[],
  existingMembers: ReadonlyMap<string, readonly string[]> = new Map(),
  options: TopicSuggestionOptions = {},
): TopicSuggestion[] {
  const work = buildSuggestions(cards, existingMembers, options);
  let result = work.next();
  while (!result.done) result = work.next();
  return result.value;
}

/** Async variant shares the same algorithm while yielding between bounded work batches. */
/** Lets the host paint between batches; falls back to a microtask outside a window (tests). */
function yieldToEventLoop(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return new Promise<void>((resolve) => { window.setTimeout(resolve, 0); });
}

export async function suggestTopicsAsync(
  cards: readonly OverviewCard[],
  existingMembers: ReadonlyMap<string, readonly string[]> = new Map(),
  options: TopicSuggestionOptions = {},
): Promise<TopicSuggestion[]> {
  const work = buildSuggestions(cards, existingMembers, options);
  let result = work.next();
  while (!result.done) {
    options.signal?.throwIfAborted();
    await yieldToEventLoop();
    options.signal?.throwIfAborted();
    result = work.next();
  }
  options.signal?.throwIfAborted();
  return result.value;
}

export function suggestTopicsForNote(card: OverviewCard, cards: readonly OverviewCard[], options: TopicSuggestionOptions = {}): TopicSuggestion[] {
  return suggestTopics(cards, new Map(), options).filter((suggestion) => suggestion.memberPaths.includes(card.path));
}
