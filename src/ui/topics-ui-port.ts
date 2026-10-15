import type { TopicCandidate, TopicCandidates } from "../topics/topic-candidates";
import type { TopicChangePreview } from "../topics/topic-integration";
import type { TopicBasis, TopicPage } from "../topics/topic-page";
import type { TopicPreviewProgress, TopicPrompt } from "../topics/topics-service";
import { NS_TYPE_TOPIC, isDerivedVersionType } from "../shared/namespace";
import { isProjectTag } from "../topics/topic-tags";

export interface TopicListEntry { path: string; page: TopicPage }
export interface TopicSummary { id: string; title: string; members: string[]; excluded: string[]; updated: string }

export class TopicSummarySnapshot {
  private topics: TopicSummary[] = [];
  replace(entries: readonly TopicListEntry[]): void {
    this.topics = entries.map(({ page }) => ({ id: page.id, title: page.title, members: [...page.members], excluded: [...page.excluded], updated: page.updated }));
  }
  get(): TopicSummary[] { return this.topics.map((topic) => ({ ...topic, members: [...topic.members], excluded: [...topic.excluded] })); }
}

/** Narrow UI capabilities for topic actions; it does not expose the plugin or settings object. */
export interface TopicsUiPort {
  isConfigured(): boolean;
  getVersion(): string;
  text(key: string): string;
  getCandidates(path: string, options?: { windowDays?: number; signal?: AbortSignal }): Promise<TopicCandidates>;
  estimate(input: { memberPaths: string[]; basis: TopicBasis }): Promise<{ chars: number; requests: number }>;
  preview(input: { startPath: string; memberPaths: string[]; basis: TopicBasis; title?: string; topicId?: string; bodyConfirmed?: boolean; signal?: AbortSignal; onProgress?: (progress: TopicPreviewProgress) => void }): Promise<TopicChangePreview>;
  previewRebuild(topicId: string, onProgress?: (progress: TopicPreviewProgress) => void): Promise<TopicChangePreview>;
  previewExcludeBlock(path: string, blockId: string): Promise<TopicChangePreview>;
  estimateContentCleaning(topicId: string): Promise<{ chars: number; tokens: number }>;
  previewContentCleaning(topicId: string): Promise<TopicChangePreview>;
  getUncontributedMembers(topicId: string): Promise<Array<{ path: string; title: string }>>;
  previewOrphanMembers(topicId: string): Promise<TopicChangePreview>;
  apply(preview: TopicChangePreview, selectedIds: readonly string[]): Promise<{ path: string; markdown: string; pageChangedDuringGeneration: boolean; skipped?: Array<{ id: string; reason: "block-modified" }> }>;
  cancel(id: string): void;
  listTopics(): Promise<TopicListEntry[]>;
  getTopicsSnapshot(): TopicSummary[];
  countPending(topicId: string): Promise<number>;
  scanUnintegrated(topicId: string, signal?: AbortSignal): Promise<TopicCandidates>;
  undoLastUpdate(topicId: string): Promise<{ restored: true } | { restored: false; reason: "no-history" | "page-modified" }>;
  deleteTopic(topicId: string): Promise<void>;
  mergeTopics(sourceId: string, targetId: string): Promise<void>;
  ignoreNote(topicId: string, path: string): Promise<void>;
  noteArrived(path: string): Promise<TopicPrompt[]>;
  refreshPrompt(path: string): Promise<void>;
  getPrompts(path: string): TopicPrompt[];
  removePrompt(path: string, topicId: string): void;
  isSourceNote(path: string): boolean;
  prepareSourceNote(path: string): Promise<boolean>;
  openTopic(path: string): Promise<void>;
  openTopicErrata(topicId: string): Promise<void>;
  openSource(path: string): Promise<void>;
}

export function topicCandidateGroups(candidates: TopicCandidates): Array<{ tier: TopicCandidate["tier"]; items: TopicCandidate[] }> {
  return [
    { tier: "project", items: candidates.project },
    { tier: "topic", items: candidates.topic },
    { tier: "content", items: candidates.content },
  ];
}

export function formatTopicCandidateReasons(candidate: TopicCandidate, text: (key: string) => string): string[] {
  const reason = candidate.reasonDetails[0];
  if (!reason) return candidate.reasons.slice(0, 1).map((key) => text(key));
  if (reason.kind === "content") return [text("Similar content")];
  const label = reason.kind === "project-tags" ? text("Project tags: ") : text("Topic tags: ");
  const names = [...new Set(reason.labels.map((tag) => tag.replace(/^#+/, "").replace(/^[^/]+\//, "")))];
  const displayed = names.slice(0, 3).join(String.fromCharCode(0x3001)) + (names.length > 3 ? "…" : "");
  return [`${label}${displayed}${reason.similar ? text(" (similar spelling)") : ""}`];
}

export function defaultTopicMemberPaths(candidates: TopicCandidates): string[] {
  return topicCandidateGroups(candidates).flatMap(({ items }) => items.filter((item) => item.defaultSelected).map((item) => item.path));
}

export function getJoinableTopics(topics: readonly TopicSummary[], path: string): TopicSummary[] {
  return topics.filter((topic) => !topic.members.includes(path) && !topic.excluded.includes(path))
    .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
}

export function topicJoinMenuEntries(topics: readonly TopicSummary[], path: string): { topics: TopicSummary[]; more: boolean } {
  const eligible = getJoinableTopics(topics, path);
  return { topics: eligible.slice(0, 8), more: eligible.length > 8 };
}

export function suggestTopicTitle(start?: TopicCandidate): string {
  if (!start) return "";
  const projectTag = start.matchedTags.find(isProjectTag);
  return (projectTag ? projectTag.replace(/^#?[^/]+\//, "") : start.title)
    .replace(/^\d{4}[-/.\u5e74]\d{1,2}[-/.\u6708]\d{1,2}\u65e5?\s*[-—_ ]*/, "")
    .replace(/^(?:\u7efc\u5408\u7eaa\u8981|\u7eaa\u8981|Summary|Minutes)[-_\uFF1A: ]*/i, "").trim();
}

export function isTopicSourceEligible(input: { type: unknown; mergedInto: unknown; isTopicErrata: boolean; underMinutesRoot: boolean; hasMergeMarker: boolean }): boolean {
  return input.underMinutesRoot && !input.isTopicErrata && !isDerivedVersionType(input.type) && input.type !== NS_TYPE_TOPIC
    && !input.mergedInto && !input.hasMergeMarker;
}
