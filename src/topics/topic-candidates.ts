import { createRelatedNotesIndex, RELATED_NOTES_DEFAULT_MIN_SCORE, type RelatedNoteDocument, type RelatedNotesIndex } from "../indexing/related-notes";
import { normalizeTagKey, overviewCardTimestamp, type OverviewCard } from "./overview-card";
import { isGenericTag } from "./topic-tags";

export interface TopicCandidate {
  path: string;
  title: string;
  date: string;
  overview: string;
  matchedTags: string[];
  matchedTerms: string[];
  alreadyInTopics: string[];
  missingOverview: boolean;
  score: number;
  defaultSelected: boolean;
  cancellable: boolean;
}
export interface FindTopicCandidatesInput {
  start: OverviewCard;
  cards: readonly OverviewCard[];
  index?: RelatedNotesIndex;
  members?: Readonly<Record<string, readonly string[]>>;
  excluded?: readonly string[];
  windowDays?: number;
  minScore?: number;
  relativeCutoff?: number;
}
export interface TopicCandidates { byTag: TopicCandidate[]; byContent: TopicCandidate[] }

const RECENCY_WINDOW_MS = 30 * 86400000;
const OVERVIEW_EXCERPT_CHARS = 120;

function candidate(card: OverviewCard, now: number, matchedTags: string[], matchedTerms: string[], score: number, memberships: Readonly<Record<string, readonly string[]>>, selected: boolean, cancellable: boolean): TopicCandidate {
  const date = card.date || (card.mtime ? new Date(card.mtime).toISOString().slice(0, 10) : "");
  const daysOld = Math.max(0, now - overviewCardTimestamp(card));
  return {
    path: card.path,
    title: card.title,
    date,
    overview: card.overview.slice(0, OVERVIEW_EXCERPT_CHARS),
    matchedTags,
    matchedTerms,
    alreadyInTopics: Object.entries(memberships).filter(([, paths]) => paths.includes(card.path)).map(([id]) => id).sort(),
    missingOverview: card.overviewSource === "none",
    score: score + (daysOld <= RECENCY_WINDOW_MS ? 0.0001 : 0),
    defaultSelected: selected,
    cancellable,
  };
}

function relatedDocument(card: OverviewCard): RelatedNoteDocument {
  return {
    path: card.path, sourceId: card.sourceId, title: card.title, timestamp: overviewCardTimestamp(card),
    tags: card.tags, people: card.people, topics: [], summary: card.overview, decisions: [], actions: [], questions: [],
    bodyExcerpt: "", outLinks: [], inLinks: [], unresolvedTargets: [], precision: card.precision, hasIndexCard: true,
  };
}

export function findTopicCandidates(input: FindTopicCandidatesInput): TopicCandidates {
  const cards = input.cards;
  const cardByPath = new Map(cards.map((card) => [card.path, card]));
  const start = cardByPath.get(input.start.path) || input.start;
  const now = Math.max(overviewCardTimestamp(start), ...cards.map(overviewCardTimestamp));
  const excluded = new Set(input.excluded || []);
  const cutoff = input.windowDays === undefined || input.windowDays < 0 ? Number.NEGATIVE_INFINITY : now - input.windowDays * 86400000;
  const eligible = cards.filter((card) => card.path === start.path || (!excluded.has(card.path) && overviewCardTimestamp(card) >= cutoff));
  const tagPaths = new Map<string, Set<string>>();
  for (const card of cards) for (const tag of new Set(card.tags.map(normalizeTagKey).filter(Boolean))) {
    const paths = tagPaths.get(tag) || new Set<string>();
    paths.add(card.path);
    tagPaths.set(tag, paths);
  }
  const documentFrequency = new Map([...tagPaths].map(([tag, paths]) => [tag, paths.size] as const));
  const totalDocs = new Set(cards.map((card) => card.path)).size;
  const startTags = new Set(start.tags.map(normalizeTagKey).filter(Boolean));
  const byTag: TopicCandidate[] = [];
  const byTagPaths = new Set<string>();
  for (const card of eligible) {
    const matchedTags = [...new Set(card.tags.map(normalizeTagKey).filter((tag) =>
      startTags.has(tag) && !isGenericTag(tag, documentFrequency.get(tag) || 0, totalDocs)))].sort();
    if (!matchedTags.length && card.path !== start.path) continue;
    byTagPaths.add(card.path);
    byTag.push(candidate(card, now, matchedTags, [], matchedTags.length, input.members || {}, true, card.path !== start.path));
  }
  if (!byTagPaths.has(start.path)) {
    byTagPaths.add(start.path);
    byTag.push(candidate(start, now, [], [], 0, input.members || {}, true, false));
  }
  byTag.sort((a, b) => Number(b.path === start.path) - Number(a.path === start.path)
    || b.matchedTags.length - a.matchedTags.length
    || overviewCardTimestamp(cardByPath.get(b.path) || start) - overviewCardTimestamp(cardByPath.get(a.path) || start)
    || a.path.localeCompare(b.path));

  const documents = eligible.map(relatedDocument);
  const relatedIndex = input.index || createRelatedNotesIndex(documents, { includeTagsInQuery: false });
  const eligiblePaths = new Set(eligible.map((card) => card.path));
  const contentMatches = relatedIndex.query(relatedDocument(start), {
    minScore: input.minScore ?? RELATED_NOTES_DEFAULT_MIN_SCORE,
    relativeCutoff: input.relativeCutoff ?? 0.45,
  });
  const byContent = contentMatches.filter((match) => eligiblePaths.has(match.path) && !byTagPaths.has(match.path) && !excluded.has(match.path))
    .map((match) => {
      const card = cardByPath.get(match.path);
      return card ? candidate(card, now, [], match.matchedTerms, match.score, input.members || {}, false, true) : null;
    }).filter((value): value is TopicCandidate => value !== null);
  return { byTag, byContent };
}
