import { normalizeTagKey, type OverviewCard } from "./overview-card";
import type { TopicPage } from "./topic-page";

export const GENERIC_TAG_MIN_DOCUMENTS = 8;
export const GENERIC_TAG_SHARE = 0.2;

export interface LearnedTopicTagSet {
  tags: string[];
  documentFrequency: Record<string, number>;
}

export interface TopicTagMatch {
  topicId: string;
  title: string;
  matchedTags: string[];
}

export function learnTopicTagSet(selectedCards: readonly OverviewCard[], cards: readonly OverviewCard[]): LearnedTopicTagSet {
  const learned = [...new Set(selectedCards.flatMap((card) => card.tags.map(normalizeTagKey).filter(Boolean)))].sort();
  const pathsByTag = new Map<string, Set<string>>();
  for (const card of cards) for (const tag of new Set(card.tags.map(normalizeTagKey).filter(Boolean))) {
    const paths = pathsByTag.get(tag) || new Set<string>();
    paths.add(card.path);
    pathsByTag.set(tag, paths);
  }
  return { tags: learned, documentFrequency: Object.fromEntries(learned.map((tag) => [tag, pathsByTag.get(tag)?.size || 0])) };
}

/** Generic requires at least 8 notes and 20% of the corpus; both avoid tiny-sample and corpus-size bias. */
export function isGenericTag(_tagKey: string, df: number, totalDocs: number): boolean {
  return totalDocs > 0 && df >= GENERIC_TAG_MIN_DOCUMENTS && df / totalDocs >= GENERIC_TAG_SHARE;
}

export function matchNoteToTopics(
  card: OverviewCard,
  topics: readonly TopicPage[],
  cards: readonly OverviewCard[],
): TopicTagMatch[] {
  const noteTags = new Set(card.tags.map(normalizeTagKey).filter(Boolean));
  const totalDocs = new Set(cards.map((item) => item.path)).size;
  const docFrequency = new Map<string, number>();
  const pathsByTag = new Map<string, Set<string>>();
  for (const item of cards) for (const tag of new Set(item.tags.map(normalizeTagKey).filter(Boolean))) {
    const paths = pathsByTag.get(tag) || new Set<string>();
    paths.add(item.path);
    pathsByTag.set(tag, paths);
  }
  for (const topic of topics) for (const tag of topic.tags) {
    const key = normalizeTagKey(tag);
    if (key) docFrequency.set(key, pathsByTag.get(key)?.size || 0);
  }
  const matches: TopicTagMatch[] = [];
  for (const topic of topics) {
    if (topic.members.includes(card.path) || topic.excluded.includes(card.path)) continue;
    const matchedTags = [...new Set(topic.tags.map(normalizeTagKey).filter((tag) => noteTags.has(tag)))];
    const specific = matchedTags.some((tag) => !isGenericTag(tag, docFrequency.get(tag) || 0, totalDocs));
    if (specific || matchedTags.length >= 2) matches.push({ topicId: topic.id, title: topic.title, matchedTags: [...new Set(matchedTags)].sort() });
  }
  return matches.sort((a, b) => a.title.localeCompare(b.title) || a.topicId.localeCompare(b.topicId));
}
