import { createRelatedNotesIndex, RELATED_NOTES_DEFAULT_MIN_SCORE, type RelatedNoteDocument, type RelatedNotesIndex } from "../indexing/related-notes";
import { normalizeTagKey, overviewCardTimestamp, type OverviewCard } from "./overview-card";
import { areTagKeysSimilar, GENERIC_TAG_MIN_DOCUMENTS, isGenericTag, isProjectTag, isTopicTag } from "./topic-tags";
import { t } from "../shared/i18n";

export interface TopicCandidate {
  tier: "project" | "topic" | "content";
  path: string;
  title: string;
  date: string;
  overview: string;
  matchedTags: string[];
  matchedTerms: string[];
  reasons: string[];
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
export interface TopicCandidates { project: TopicCandidate[]; topic: TopicCandidate[]; content: TopicCandidate[]; byTag: TopicCandidate[]; byContent: TopicCandidate[] }

const RECENCY_WINDOW_MS = 30 * 86400000;
const OVERVIEW_EXCERPT_CHARS = 120;
/** A topic tag used by fewer than three notes stays useful as a one-tag match. */
export const TOPIC_TAG_RARE_MAX_DOCUMENTS = GENERIC_TAG_MIN_DOCUMENTS;

function candidate(card: OverviewCard, now: number, tier: TopicCandidate["tier"], matchedTags: string[], matchedTerms: string[], reasons: string[], score: number, memberships: Readonly<Record<string, readonly string[]>>, selected: boolean, cancellable: boolean): TopicCandidate {
  const date = card.date || (card.mtime ? new Date(card.mtime).toISOString().slice(0, 10) : "");
  const daysOld = Math.max(0, now - overviewCardTimestamp(card));
  return {
    tier,
    path: card.path,
    title: card.title,
    date,
    overview: card.overview.slice(0, OVERVIEW_EXCERPT_CHARS),
    matchedTags,
    matchedTerms,
    reasons,
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
  const startLabels = start.tags;
  const startProject = startLabels.filter(isProjectTag);
  const hasProjectTags = startProject.length > 0;
  const project: TopicCandidate[] = [];
  const topic: TopicCandidate[] = [];
  const labeledPaths = new Set<string>();
  for (const card of eligible) {
    const matches: Array<{ label: string; key: string; tier: "project" | "topic" }> = [];
    for (const label of card.tags) for (const origin of startLabels) {
      const key = normalizeTagKey(label), originKey = normalizeTagKey(origin);
      if (!key || !originKey || !areTagKeysSimilar(key, originKey)) continue;
      const projectMatch = isProjectTag(origin) && isProjectTag(label);
      const topicMatch = isTopicTag(origin) && isTopicTag(label);
      if (projectMatch || (topicMatch && (key === originKey || !isGenericTag(key, documentFrequency.get(key) || 0, totalDocs)))) matches.push({ label, key, tier: projectMatch ? "project" : "topic" });
    }
    const projectMatches = [...new Set(matches.filter((m) => m.tier === "project").map((m) => m.label))];
    const topicMatches = [...new Set(matches.filter((m) => m.tier === "topic").map((m) => m.label))];
    const sharedCount = new Set(matches.map((m) => m.key)).size;
    const includeTopic = topicMatches.length > 0 && (sharedCount >= 2 || topicMatches.some((tag) => (documentFrequency.get(normalizeTagKey(tag)) || 0) < TOPIC_TAG_RARE_MAX_DOCUMENTS));
    if (projectMatches.length) {
      const similarReason = projectMatches.some((tag) => !startProject.some((original) => normalizeTagKey(original) === normalizeTagKey(tag)))
        ? [t("Similar tag spelling: ") + `${projectMatches[0]} ≈ ${startProject.find((original) => areTagKeysSimilar(original, projectMatches[0])) || projectMatches[0]}`] : [];
      project.push(candidate(card, now, "project", projectMatches, [], [t("Shared project identifier tag"), ...similarReason], projectMatches.length, input.members || {}, true, card.path !== start.path));
      labeledPaths.add(card.path);
    } else if (includeTopic && card.path !== start.path) {
      topic.push(candidate(card, now, "topic", topicMatches, [], [t("Shared topic tags")], topicMatches.length, input.members || {}, !hasProjectTags && sharedCount >= 2, card.path !== start.path));
      labeledPaths.add(card.path);
    }
  }
  if (!labeledPaths.has(start.path)) {
    project.unshift(candidate(start, now, "project", [], [], [t("Starting note")], 0, input.members || {}, true, false));
    if (!hasProjectTags) project[0].tier = "project";
  } else {
    const origin = project.findIndex((item) => item.path === start.path);
    if (origin > 0) project.unshift(...project.splice(origin, 1));
  }
  const sort = (items: TopicCandidate[]) => items.sort((a, b) => Number(b.path === start.path) - Number(a.path === start.path)
    || b.matchedTags.length - a.matchedTags.length
    || overviewCardTimestamp(cardByPath.get(b.path) || start) - overviewCardTimestamp(cardByPath.get(a.path) || start)
    || a.path.localeCompare(b.path));
  sort(project); sort(topic);

  const documents = eligible.map(relatedDocument);
  const relatedIndex = input.index || createRelatedNotesIndex(documents, { includeTagsInQuery: false });
  const eligiblePaths = new Set(eligible.map((card) => card.path));
  const contentMatches = relatedIndex.query(relatedDocument(start), {
    minScore: input.minScore ?? RELATED_NOTES_DEFAULT_MIN_SCORE,
    relativeCutoff: input.relativeCutoff ?? 0.45,
  });
  const content = contentMatches.filter((match) => eligiblePaths.has(match.path) && !labeledPaths.has(match.path) && match.path !== start.path && !excluded.has(match.path))
    .map((match) => {
      const card = cardByPath.get(match.path);
      return card ? candidate(card, now, "content", [], match.matchedTerms, [t("Similar content")], match.score, input.members || {}, false, true) : null;
    }).filter((value): value is TopicCandidate => value !== null);
  return { project, topic, content, byTag: [...project, ...topic], byContent: content };
}
