import { normalizeTagKey, type OverviewCard } from "./overview-card";
import type { TopicPage } from "./topic-page";

export const GENERIC_TAG_MIN_DOCUMENTS = 8;
export const GENERIC_TAG_SHARE = 0.2;
export const TOPIC_TAG_MIN_SHARED_MEMBERS = 2;

export interface LearnedTopicTagSet {
  tags: string[];
  aliases: Record<string, string[]>;
  documentFrequency: Record<string, number>;
}

export interface TopicTagMatch {
  topicId: string;
  title: string;
  matchedTags: string[];
}

export function learnTopicTagSet(selectedCards: readonly OverviewCard[], cards: readonly OverviewCard[]): LearnedTopicTagSet {
  const labelsByKey = new Map<string, Set<string>>();
  const pathsByKey = new Map<string, Set<string>>();
  const representativeKeys: string[] = [];
  const representativeLabels = new Map<string, string>();
  for (const card of selectedCards) for (const label of card.tags) {
    const rawKey = normalizeTagKey(label);
    if (!rawKey) continue;
    const key = representativeKeys.find((known) => sameTagClass(representativeLabels.get(known) || known, label) && areTagKeysSimilar(known, rawKey)) || rawKey;
    if (!representativeKeys.includes(key)) { representativeKeys.push(key); representativeLabels.set(key, label); }
    const labels = labelsByKey.get(key) || new Set<string>(); labels.add(label.replace(/^#/, "")); labelsByKey.set(key, labels);
    const paths = pathsByKey.get(key) || new Set<string>(); paths.add(card.path); pathsByKey.set(key, paths);
  }
  const allLabels = new Map<string, Set<string>>();
  const allPaths = new Map<string, Set<string>>();
  for (const card of cards) for (const label of new Set(card.tags)) {
    const rawKey = normalizeTagKey(label); if (!rawKey) continue;
    const key = representativeKeys.find((known) => sameTagClass(representativeLabels.get(known) || known, label) && areTagKeysSimilar(known, rawKey)) || rawKey;
    const labels = allLabels.get(key) || new Set<string>(); labels.add(label.replace(/^#/, "")); allLabels.set(key, labels);
    const paths = allPaths.get(key) || new Set<string>(); paths.add(card.path); allPaths.set(key, paths);
  }
  const learned = [...labelsByKey.keys()].filter((key) => {
    const label = [...(labelsByKey.get(key) || [])][0] || key;
    return isProjectTag(label) || (!isGenericTag(key, allPaths.get(key)?.size || 0, cards.length) && (pathsByKey.get(key)?.size || 0) >= TOPIC_TAG_MIN_SHARED_MEMBERS);
  }).sort();
  const pathsByTag = new Map<string, Set<string>>();
  for (const card of cards) for (const tag of new Set(card.tags.map(normalizeTagKey).filter(Boolean))) {
    const paths = pathsByTag.get(tag) || new Set<string>();
    paths.add(card.path);
    pathsByTag.set(tag, paths);
  }
  const tags = learned.map((key) => [...(labelsByKey.get(key) || [])].sort((a, b) => a.localeCompare(b))[0] || key);
  const aliases = Object.fromEntries(learned.map((key, index) => [tags[index], [...(labelsByKey.get(key) || [])].sort()]));
  return { tags, aliases, documentFrequency: Object.fromEntries(learned.map((key, index) => [tags[index], allPaths.get(key)?.size || pathsByTag.get(key)?.size || 0])) };
}

function sameTagClass(key: string, label: string): boolean {
  return isProjectTag(key) === isProjectTag(label) && isTopicTag(key) === isTopicTag(label);
}

export function isProjectTag(label: string): boolean { return /^#?项目\//i.test(label.trim()); }
export function isTopicTag(label: string): boolean { return !/^#?(?:项目|行业|公司)\//i.test(label.trim()); }
export function areTagKeysSimilar(a: string, b: string): boolean {
  const left = normalizeTagKey(a).replace(/[^\p{L}\p{N}]/gu, "");
  const right = normalizeTagKey(b).replace(/[^\p{L}\p{N}]/gu, "");
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.min(left.length, right.length) >= 4 && (left.startsWith(right) || right.startsWith(left) || left.includes(right) || right.includes(left))) return true;
  if (Math.min(left.length, right.length) < 5 || Math.abs(left.length - right.length) > 1) return false;
  let edits = 0, i = 0, j = 0;
  while (i < left.length && j < right.length) { if (left[i] === right[j]) { i++; j++; continue; } if (++edits > 1) return false; if (left.length > right.length) i++; else if (right.length > left.length) j++; else { i++; j++; } }
  return edits + (i < left.length || j < right.length ? 1 : 0) <= 1;
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
    const expanded = topic.tags.flatMap((tag) => [tag, ...(topic.tagAliases?.[tag] || [])]);
    const matchedTags = [...new Set(expanded.map(normalizeTagKey).filter((tag) => noteTags.has(tag)))];
    const specific = matchedTags.some((tag) => !isGenericTag(tag, docFrequency.get(tag) || 0, totalDocs));
    if (specific || matchedTags.length >= 2) matches.push({ topicId: topic.id, title: topic.title, matchedTags: [...new Set(matchedTags)].sort() });
  }
  return matches.sort((a, b) => a.title.localeCompare(b.title) || a.topicId.localeCompare(b.topicId));
}
