import { createRelatedNotesIndex, type RelatedNoteDocument } from "../indexing/related-notes";
import { extractAllRawBlocksFromText, stripFrontmatterSimple } from "../notes/note-document";
import { extractIndexSource } from "../indexing/note-index";
import { NS_MACHINE_SHELL_RE } from "../shared/namespace";
import type { OverviewCardCachePort } from "./overview-card-cache";
import { OverviewCardCache } from "./overview-card-cache";
import { overviewCardTimestamp, type OverviewCard } from "./overview-card";
import { findTopicCandidates, type TopicCandidate, type TopicCandidates } from "./topic-candidates";
import { generateTopicOperations, estimateIntegrationCost, type TopicChangePreview, type TopicIntegrationMember, type TopicIntegrationPort } from "./topic-integration";
import { applyTopicOps, createTopicPage, hashTopicPage, parseTopicPage, serializeTopicPage, type TopicBasis, type TopicMember } from "./topic-page";
import { TopicStore, type TopicStorePort } from "./topic-store";
import { learnTopicTagSet, matchNoteToTopics, type TopicTagMatch } from "./topic-tags";
import { suggestTopicsAsync, type TopicSuggestion } from "./topic-suggestions";
import { t } from "../shared/i18n";

export interface TopicsServiceHost {
  overviewCards: OverviewCardCachePort;
  topicStore: TopicStorePort;
  getRoots(): string[];
  getFolder(): string;
  integration: TopicIntegrationPort;
  createId(): string;
  startActivity(id: string, title: string): void;
  completeActivity(id: string): void;
  failActivity(id: string, error: unknown): void;
  updateActivity?(id: string, patch: { progress: number; stageLabel: string; stage: string }): void;
  cancelActivity?(id: string, reason: string): void;
}
export type TopicsServicePort = OverviewCardCachePort;
export interface TopicsSuggestionsOptions { windowDays?: number; limit?: number; signal?: AbortSignal }
export interface TopicsSuggestionsResult {
  suggestions: TopicSuggestion[];
  stats: { noteCount: number; windowedCount: number; overviewMissing: number; readCount: number; elapsedMs: number };
}
export interface TopicCandidatesOptions { windowDays?: number; excluded?: string[]; minScore?: number; relativeCutoff?: number }
export interface TopicPreviewInput { startPath: string; memberPaths: string[]; basis: TopicBasis; title?: string; topicId?: string; bodyConfirmed?: boolean; signal?: AbortSignal }
export interface TopicEstimateInput { memberPaths: string[]; basis: TopicBasis }
export interface TopicPrompt extends TopicTagMatch { path: string }
interface PendingPreview { preview: TopicChangePreview }

function cardDocument(card: OverviewCard): RelatedNoteDocument {
  return { path: card.path, sourceId: card.sourceId, title: card.title, timestamp: overviewCardTimestamp(card), tags: card.tags, people: card.people, topics: [], summary: card.overview, decisions: [], actions: [], questions: [], bodyExcerpt: "", outLinks: card.outLinks, inLinks: card.inLinks, unresolvedTargets: card.unresolvedTargets, precision: card.precision, hasIndexCard: true };
}
function hashText(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index++) hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function bodyForIntegration(markdown: string): string {
  const raw = extractAllRawBlocksFromText(stripFrontmatterSimple(markdown)).withoutRaw;
  const visible = extractIndexSource(raw).replace(NS_MACHINE_SHELL_RE, "");
  const rawMaterial = visible.search(/^#{1,3}\s+(?:原始材料|Raw material|Original material)\s*$/im);
  return (rawMaterial >= 0 ? visible.slice(0, rawMaterial) : visible).trim();
}

export class TopicsService {
  private readonly host: TopicsServiceHost;
  private cache: OverviewCardCache | null = null;
  private store: TopicStore | null = null;
  private roots: string[] = [];
  private lastSignature = "";
  private lastSuggestions: TopicSuggestion[] = [];
  private readonly previews = new Map<string, PendingPreview>();
  private readonly controllers = new Map<string, AbortController>();
  constructor(host: TopicsServiceHost) { this.host = host; }

  private cacheForCurrentRoots(): OverviewCardCache {
    const nextRoots = this.host.getRoots();
    const sameRoots = nextRoots.length === this.roots.length && nextRoots.every((root, index) => root === this.roots[index]);
    if (!this.cache || !sameRoots) {
      this.roots = [...nextRoots];
      this.cache = new OverviewCardCache(this.host.overviewCards, this.roots);
      this.lastSignature = "";
      this.lastSuggestions = [];
    }
    return this.cache;
  }
  private storeForCurrentFolder(): TopicStore {
    const folder = this.host.getFolder();
    if (!this.store || this.storeFolder !== folder) {
      this.storeFolder = folder;
      this.store = new TopicStore({ folder, port: this.host.topicStore });
    }
    return this.store;
  }
  private storeFolder = "";
  private async refresh(options: { windowDays?: number; signal?: AbortSignal } = {}): Promise<{ cache: OverviewCardCache; cards: OverviewCard[] }> {
    options.signal?.throwIfAborted();
    const cache = this.cacheForCurrentRoots();
    await cache.refresh({ windowDays: options.windowDays });
    options.signal?.throwIfAborted();
    return { cache, cards: cache.getCards({ windowDays: options.windowDays }) };
  }
  private async loadMembers(paths: readonly string[], cards: readonly OverviewCard[], basis: TopicBasis): Promise<TopicIntegrationMember[]> {
    const byPath = new Map(cards.map((card) => [card.path, card]));
    const members: TopicIntegrationMember[] = [];
    for (const path of [...new Set(paths)]) {
      const card = byPath.get(path);
      if (!card) throw new Error(`Topic member is not in the current note scope: ${path}`);
      const content = basis === "body" ? bodyForIntegration(await this.host.overviewCards.readText(path)) : undefined;
      members.push({ card, content });
    }
    return members;
  }

  async getSuggestions(options: TopicsSuggestionsOptions = {}): Promise<TopicsSuggestionsResult> {
    options.signal?.throwIfAborted();
    const start = Date.now();
    const cache = this.cacheForCurrentRoots();
    cache.resetReadCount();
    const refreshed = await cache.refresh(options);
    const cards = cache.getCards(options);
    const signature = JSON.stringify([options.windowDays ?? null, options.limit ?? null, cards]);
    if (signature !== this.lastSignature) {
      this.lastSuggestions = await suggestTopicsAsync(cards, new Map(), { limit: options.limit, signal: options.signal });
      this.lastSignature = signature;
    }
    options.signal?.throwIfAborted();
    return { suggestions: this.lastSuggestions, stats: { noteCount: cache.getNoteCount(), windowedCount: cards.length, overviewMissing: cards.filter((card) => card.overviewSource === "none").length, readCount: refreshed.readCount, elapsedMs: Date.now() - start } };
  }

  async getCandidates(startPath: string, options: TopicCandidatesOptions = {}): Promise<TopicCandidates> {
    const { cards } = await this.refresh({ windowDays: options.windowDays });
    const start = cards.find((card) => card.path === startPath);
    if (!start) throw new Error(`Starting note is outside the configured note scope: ${startPath}`);
    const topics = await this.storeForCurrentFolder().list();
    const memberships: Record<string, string[]> = {};
    for (const { page } of topics) memberships[page.id] = page.members;
    const index = createRelatedNotesIndex(cards.map(cardDocument), { includeTagsInQuery: false });
    return findTopicCandidates({ start, cards, index, members: memberships, excluded: options.excluded, windowDays: options.windowDays, minScore: options.minScore, relativeCutoff: options.relativeCutoff });
  }

  async estimate(input: TopicEstimateInput): Promise<{ chars: number; requests: number }> {
    const { cards } = await this.refresh();
    const members = await this.loadMembers(input.memberPaths, cards, input.basis);
    return estimateIntegrationCost({ basis: input.basis, members });
  }

  async preview(input: TopicPreviewInput): Promise<TopicChangePreview> {
    if (input.basis === "body" && !input.bodyConfirmed) throw new Error("Estimate body-mode cost first and confirm before generating a preview");
    const topicId = input.topicId || this.host.createId();
    const activityId = input.topicId ? `topics:update:${input.topicId}` : `topics:create:${topicId}`;
    const controller = new AbortController();
    this.controllers.set(activityId, controller);
    const cancel = () => controller.abort();
    input.signal?.addEventListener("abort", cancel, { once: true });
    this.host.startActivity(activityId, input.topicId ? "Update topic" : "Create topic");
    try {
      const { cards } = await this.refresh({ signal: controller.signal });
      const existing = input.topicId ? (await this.storeForCurrentFolder().list()).find((item) => item.page.id === input.topicId) : undefined;
      if (input.topicId && !existing) throw new Error(`Topic not found: ${input.topicId}`);
      const existingMembers = new Set(existing?.page.members || []);
      const requestedPaths = [...new Set(input.memberPaths)];
      const selectedPaths = input.topicId
        ? requestedPaths.filter((path) => !existingMembers.has(path))
        : [input.startPath, ...requestedPaths.filter((path) => path !== input.startPath)];
      if (!selectedPaths.length) throw new Error("No new notes to integrate; all selected notes are already topic members");
      const members = await this.loadMembers(selectedPaths, cards, input.basis);
      const currentPage = existing ? await this.host.topicStore.read(existing.path) : "";
      const generated = await generateTopicOperations(this.host.integration, { members, basis: input.basis, currentPage, signal: controller.signal,
        onBatchProgress: (completed, total) => this.host.updateActivity?.(activityId, { stage: "processing", progress: Math.round(completed / total * 100), stageLabel: t("Completed {0}/{1} batches").replace("{0}", String(completed)).replace("{1}", String(total)) }),
      });
      if (generated.partialFailure && generated.completedBatches === 0) throw new Error(`Topic integration failed before any batch completed: ${generated.partialFailure}`);
      const memberRecords: TopicMember[] = members.map(({ card }) => ({ path: card.path, title: card.title, sourceId: card.sourceId }));
      const learned = learnTopicTagSet(members.map(({ card }) => card), cards);
      const currentHash = hashTopicPage(currentPage);
      const currentModel = currentPage ? parseTopicPage(currentPage, existing?.path) : null;
      const latestTopic = existing ? (await this.storeForCurrentFolder().list()).find((item) => item.page.id === topicId) : undefined;
      if (existing && !latestTopic) throw new Error(`Topic not found: ${topicId}`);
      const latestPage = latestTopic ? await this.host.topicStore.read(latestTopic.path) : "";
      const pageWasManuallyEdited = !!existing && (
        (!!currentModel?.appliedHash && currentModel.appliedHash !== currentHash)
        || currentHash !== hashTopicPage(latestPage)
      );
      const preview: TopicChangePreview = {
        topicId, expectedHash: currentHash, pageWasManuallyEdited,
        items: generated.operations.map((operation, index) => ({
          id: `${index}-${hashText(JSON.stringify(operation))}`, operation, type: operation.type,
          target: "targetId" in operation ? operation.targetId : "section" in operation ? operation.section : operation.type,
          text: "text" in operation ? operation.text : "", sourceId: operation.sourceId, cancellable: true,
        })),
        completedBatches: generated.completedBatches, totalBatches: generated.totalBatches,
        ...(generated.partialFailure ? { partialFailure: generated.partialFailure } : {}),
        sourceLinks: Object.fromEntries(memberRecords.map((member) => [member.sourceId, `[[${member.path.replace(/\.md$/i, "")}|${member.title}]]`])),
        ...(existing ? {
          memberLinks: [...new Set([...existing.page.memberLinks, ...memberRecords.map((member) => `[[${member.path.replace(/\.md$/i, "")}|${member.title}]]`)])],
          tags: [...new Set([...existing.page.tags, ...learned.tags])],
          tagAliases: { ...(existing.page.tagAliases || {}), ...learned.aliases },
        } : {
          create: { title: input.title || members[0]?.card.title || "Topic", basis: input.basis, tags: learned.tags, tagAliases: learned.aliases, members: memberRecords },
        }),
      };
      this.previews.set(activityId, { preview });
      return preview;
    } catch (error) {
      this.controllers.delete(activityId);
      if (controller.signal.aborted) this.host.cancelActivity?.(activityId, "Topic operation cancelled; the topic page was not changed");
      else this.host.failActivity(activityId, error);
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", cancel);
    }
  }

  cancel(id: string): void {
    const entry = [...this.controllers.entries()].find(([activityId]) =>
      activityId === id || activityId.endsWith(`:${id}`) || this.previews.get(activityId)?.preview.topicId === id);
    if (!entry) return;
    const [activityId, controller] = entry;
    const hadPreview = this.previews.has(activityId);
    controller.abort();
    this.controllers.delete(activityId);
    this.previews.delete(activityId);
    if (hadPreview) this.host.cancelActivity?.(activityId, "Topic operation cancelled; the topic page was not changed");
  }

  async apply(preview: TopicChangePreview, selection: readonly string[]): Promise<{ path: string; markdown: string; pageChangedDuringGeneration: boolean }> {
    const pendingEntry = [...this.previews.entries()].find(([, pending]) => pending.preview === preview);
    if (!pendingEntry) throw new Error("Topic preview is no longer available");
    const [activityId] = pendingEntry;
    const store = this.storeForCurrentFolder();
    try {
      if (preview.create) {
        const page = createTopicPage({ id: preview.topicId, title: preview.create.title, tags: preview.create.tags, members: preview.create.members, basis: preview.create.basis });
        page.tagAliases = preview.create.tagAliases || {};
        const selected = new Set(selection);
        const operations = preview.items.filter((item) => selected.has(item.id))
          .map(({ operation }) => ({ ...operation, sourceId: preview.sourceLinks?.[operation.sourceId] || operation.sourceId }));
        const initial = applyTopicOps(serializeTopicPage(page), operations).markdown;
        const parsed = parseTopicPage(initial);
        if (!parsed) throw new Error("Generated topic page could not be parsed");
        const path = await store.create(parsed, initial);
        const stored = await this.host.topicStore.read(path);
        this.previews.delete(activityId);
        this.controllers.delete(activityId);
        this.host.completeActivity(activityId);
        return { path, markdown: stored, pageChangedDuringGeneration: false };
      }
      const current = (await store.list()).find((entry) => entry.page.id === preview.topicId);
      if (!current) throw new Error(`Topic not found: ${preview.topicId}`);
      const result = await store.apply(current.path, preview, selection);
      this.previews.delete(activityId);
      this.controllers.delete(activityId);
      this.host.completeActivity(activityId);
      return { path: current.path, markdown: result.markdown, pageChangedDuringGeneration: result.pageChangedDuringGeneration };
    } catch (error) {
      this.controllers.delete(activityId);
      this.host.failActivity(activityId, error);
      throw error;
    }
  }

  async undoLastUpdate(topicId: string) { return this.storeForCurrentFolder().undoLastUpdate(topicId); }
  async deleteTopic(topicId: string): Promise<void> { return this.storeForCurrentFolder().deleteTopic(topicId); }
  async mergeTopics(sourceId: string, targetId: string): Promise<void> { return this.storeForCurrentFolder().mergeTopics(sourceId, targetId); }
  async ignoreNote(topicId: string, path: string): Promise<void> { return this.storeForCurrentFolder().addExcluded(topicId, path); }
  async restoreIgnoredNote(topicId: string, path: string): Promise<void> { return this.storeForCurrentFolder().removeExcluded(topicId, path); }

  async scanUnintegrated(topicId: string): Promise<TopicCandidates> {
    const topics = await this.storeForCurrentFolder().list();
    const topic = topics.find((item) => item.page.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    const { cards } = await this.refresh();
    if (!cards.length) return { project: [], topic: [], content: [], byTag: [], byContent: [] };
    const anchor = {
      ...cards[0],
      path: `__qnalog_topic__/${topicId}.md`,
      title: topic.page.title,
      tags: topic.page.tags,
      overview: topic.page.body,
      overviewSource: "abstract" as const,
    };
    const memberships: Record<string, string[]> = {};
    for (const { page } of topics) memberships[page.id] = page.members;
    const index = createRelatedNotesIndex(cards.map(cardDocument), { includeTagsInQuery: false });
    const initial = findTopicCandidates({ start: anchor, cards, index, members: memberships, windowDays: -1 });
    const excluded = new Set([...topic.page.members, ...topic.page.excluded]);
    const available = (items: TopicCandidate[]) => items.filter((candidate) => candidate.path !== anchor.path && !excluded.has(candidate.path));
    const project = available(initial.project), topicCandidates = available(initial.topic), content = available(initial.content);
    return { project, topic: topicCandidates, content, byTag: [...project, ...topicCandidates], byContent: content };
  }

  async noteArrived(path: string): Promise<TopicPrompt[]> {
    const cache = this.cacheForCurrentRoots();
    cache.invalidate(path);
    await cache.refresh();
    const cards = cache.getCards();
    const card = cards.find((item) => item.path === path);
    if (!card) return [];
    const topics = await this.storeForCurrentFolder().list();
    return matchNoteToTopics(card, topics.map(({ page }) => page), cards).map((match) => ({ ...match, path }));
  }

  async listTopics() { return this.storeForCurrentFolder().list(); }
}
