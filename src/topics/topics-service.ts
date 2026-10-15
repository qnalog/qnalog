import { createRelatedNotesIndex, type RelatedNoteDocument } from "../indexing/related-notes";
import { extractAllRawBlocksFromText, stripFrontmatterSimple } from "../notes/note-document";
import { extractIndexSource } from "../indexing/note-index";
import { NS_MACHINE_SHELL_RE } from "../shared/namespace";
import type { OverviewCardCachePort } from "./overview-card-cache";
import { OverviewCardCache } from "./overview-card-cache";
import { overviewCardTimestamp, type OverviewCard } from "./overview-card";
import { findTopicCandidates, type TopicCandidate, type TopicCandidates } from "./topic-candidates";
import { generateTopicOperations, generateTopicPageContent, generateTopicPageUpdateOperations, generateTopicCleaningOperations, estimateTopicCleaningInput, estimateIntegrationCost, TopicGenerationError, type TopicChangePreview, type TopicIntegrationMember, type TopicIntegrationPort } from "./topic-integration";
import { applyTopicOps, createTopicPage, hashTopicPage, isLegacyTopicStatusLine, parseTopicPage, parseTopicPageBlocks, renderTopicPage, serializeTopicPage, topicBlockHeadingLabel, topicBlockSourcePaths, type TopicBasis, type TopicMember, type TopicPageV2Model } from "./topic-page";
import { TopicStore, type TopicStorePort } from "./topic-store";
import { learnTopicTagSet, learnVerifiedTopicTagUpdates, matchNoteToTopics, type TopicTagMatch } from "./topic-tags";
import { suggestTopicsAsync, type TopicSuggestion } from "./topic-suggestions";
import { t } from "../shared/i18n";
import type { TopicErrataStore } from "./topic-errata-store";
import { stripBlockMarkers } from "./topic-block-markers";

export interface TopicsServiceHost {
  overviewCards: OverviewCardCachePort;
  topicStore: TopicStorePort;
  topicErrata?: TopicErrataStore;
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
export interface TopicCandidatesOptions { windowDays?: number; excluded?: string[]; minScore?: number; relativeCutoff?: number; signal?: AbortSignal }
export interface TopicPreviewProgress { completed: number; total: number }
export interface TopicPreviewInput { startPath: string; memberPaths: string[]; basis: TopicBasis; title?: string; topicId?: string; rebuild?: boolean; bodyConfirmed?: boolean; signal?: AbortSignal; onProgress?: (progress: TopicPreviewProgress) => void }
export interface TopicEstimateInput { memberPaths: string[]; basis: TopicBasis }
export interface TopicPrompt extends TopicTagMatch { path: string }
interface PendingPreview {
  preview: TopicChangePreview;
  managesActivity: boolean;
  onApplied?: (selection: ReadonlySet<string>, skipped: readonly { id: string; reason: "block-modified" }[]) => Promise<void>;
}

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
    await cache.refresh({ windowDays: options.windowDays, signal: options.signal });
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
    const { cards } = await this.refresh({ windowDays: options.windowDays, signal: options.signal });
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
      const selectedPaths = input.rebuild && existing
        ? existing.page.members
        : input.topicId
        ? requestedPaths.filter((path) => !existingMembers.has(path))
        : [input.startPath, ...requestedPaths.filter((path) => path !== input.startPath)];
      if (!selectedPaths.length && !input.rebuild) throw new Error("No new notes to integrate; all selected notes are already topic members");
      const members = await this.loadMembers(selectedPaths, cards, input.basis);
      const topicErrata = existing && this.host.topicErrata ? await this.host.topicErrata.load(existing.path, existing.page.members) : undefined;
      const existingEvidenceMembers = existing && !input.rebuild
        ? await this.loadMembers(existing.page.members.filter((path) => cards.some((card) => card.path === path)), cards, input.basis)
        : [];
      const topicStore = this.storeForCurrentFolder();
      const currentPage = existing ? await topicStore.readIndexedMarkdown(existing.path) : "";
      const generationInput = { members, existingMembers: existingEvidenceMembers, basis: input.basis, currentPage: input.rebuild ? "" : currentPage, topicErrata, signal: controller.signal,
        onPlanned: (total: number) => input.onProgress?.({ completed: 0, total }),
        onBatchProgress: (completed: number, total: number) => {
          const stageLabel = t("Completed {0}/{1} batches").replace("{0}", String(completed)).replace("{1}", String(total));
          this.host.updateActivity?.(activityId, { stage: "processing", progress: Math.round(completed / total * 100), stageLabel });
          input.onProgress?.({ completed, total });
        },
      };
      let generatedOperations: Awaited<ReturnType<typeof generateTopicOperations>>["operations"] = [];
      let generatedModel: TopicPageV2Model | undefined;
      let completedBatches = 0;
      let totalBatches = 0;
      let partialFailure: string | undefined;
      let validationWarnings: string[] | undefined;
      let createDiagnostics: TopicChangePreview["createDiagnostics"];
      let updateDiagnostics: TopicChangePreview["updateDiagnostics"];
      let duplicateDetails: TopicChangePreview["duplicateDetails"];
      let overviewGeneratedFromThreads = false;
      let degraded: number | undefined;
      let assessments: TopicChangePreview["assessments"];
      let programGeneratedOperations: number | undefined;
      let programGeneratedOperationKeys: string[] | undefined;
      if (input.topicId && !input.rebuild) {
        const isV2 = parseTopicPage(currentPage, existing?.path)?.layout === 2;
        const generated = isV2
          ? await generateTopicPageUpdateOperations(this.host.integration, generationInput)
          : await generateTopicOperations(this.host.integration, generationInput);
        generatedOperations = generated.operations;
        completedBatches = generated.completedBatches;
        totalBatches = generated.totalBatches;
        partialFailure = generated.partialFailure;
        validationWarnings = generated.validationWarnings;
        updateDiagnostics = generated.updateDiagnostics;
        duplicateDetails = generated.duplicateDetails;
        degraded = generated.degraded;
        assessments = generated.assessments;
        programGeneratedOperationKeys = generated.programGeneratedOperationKeys;
        programGeneratedOperations = generated.programGeneratedOperationKeys?.length;
      } else {
        const generated = await generateTopicPageContent(this.host.integration, generationInput);
        generatedModel = generated.model;
        createDiagnostics = generated.createDiagnostics;
        overviewGeneratedFromThreads = generated.overviewGeneratedFromThreads;
        completedBatches = generated.completedBatches;
        totalBatches = generated.totalBatches;
        partialFailure = generated.partialFailure;
        validationWarnings = generated.validationWarnings;
      }
      if (partialFailure && completedBatches === 0) throw new TopicGenerationError("Topic integration failed before any batch completed: " + partialFailure);
      const memberRecords: TopicMember[] = members.map(({ card }) => ({ path: card.path, title: card.title, sourceId: card.sourceId, date: card.date, summary: card.overview }));
      let replacement: TopicChangePreview["replacement"];
      if (input.rebuild && existing && generatedModel) {
        const rebuilt = createTopicPage({ id: existing.page.id, title: existing.page.title, tags: existing.page.tags, members: memberRecords, basis: input.basis, created: existing.page.created });
        rebuilt.layout = 2;
        rebuilt.excluded = existing.page.excluded;
        rebuilt.tagAliases = existing.page.tagAliases;
        rebuilt.body = renderTopicPage(generatedModel, memberRecords, {
          overview: t("Overview"), progress: t("Topic progress"),
          disagreements: t("Disagreements and verification"), open: t("Topic open items"),
          timeline: t("Timeline"), sources: t("Source notes"), conflict: t("Conflicting accounts"),
          openQuestion: t("Topic open question"), openAction: t("Topic open action"), openBug: t("Topic open bug"),
        });
        replacement = { path: existing.path, markdown: serializeTopicPage(rebuilt), model: generatedModel };
      }
      const learned = learnTopicTagSet(members.map(({ card }) => card), cards);
      const verifiedTagUpdate = existing && !input.rebuild ? learnVerifiedTopicTagUpdates({
        existingTags: existing.page.tags,
        existingAliases: existing.page.tagAliases,
        existingMembers: cards.filter((card) => existing.page.members.includes(card.path)),
        newMembers: members.map(({ card }) => card),
      }) : undefined;
      const currentHash = hashTopicPage(currentPage);
      const currentModel = currentPage ? parseTopicPage(currentPage, existing?.path) : null;
      const latestTopic = existing ? (await this.storeForCurrentFolder().list()).find((item) => item.page.id === topicId) : undefined;
      if (existing && !latestTopic) throw new Error(`Topic not found: ${topicId}`);
      const latestPage = latestTopic ? await topicStore.readIndexedMarkdown(latestTopic.path) : "";
      const pageWasManuallyEdited = !!existing && (
        existing.page.cacheStatus !== "valid"
        ||
        (!!currentModel?.appliedHash && currentModel.appliedHash !== currentHash)
        || currentHash !== hashTopicPage(latestPage)
      );
      const preview: TopicChangePreview = {
        topicId, expectedHash: currentHash, pageWasManuallyEdited,
        ...(existing && /\s\^tpc-[\da-f]{6}\b/i.test(currentPage) ? { legacyAnchorCleanup: true } : {}),
        ...(existing && [t("Legacy topic status prefix zh"), t("Legacy topic status prefix en")].some((prefix) => currentPage.split("\n").some((line) => isLegacyTopicStatusLine(line, [prefix])))
          ? { legacyStatusCleanup: true, legacyStatusPrefixes: [t("Legacy topic status prefix zh"), t("Legacy topic status prefix en")] } : {}),
        ...(existing?.page.legacyMachineProperties ? { legacyPropertyCleanup: true } : {}),
        newMembers: memberRecords,
        ...(existing && !input.rebuild ? { metadataMembers: [
          ...existingEvidenceMembers.map(({ card }) => ({ path: card.path, title: card.title, sourceId: card.sourceId, date: card.date, summary: card.overview })),
          ...memberRecords,
        ] } : {}),
        items: generatedOperations.map((operation, index) => ({
          id: `${index}-${hashText(JSON.stringify(operation))}`, operation, type: operation.type,
          target: "targetId" in operation ? operation.targetId : "blockId" in operation ? (topicBlockHeadingLabel(currentPage, operation.blockId) || t("Corresponding section")) : "thread" in operation ? operation.thread : "title" in operation ? operation.title : "section" in operation ? operation.section : operation.type,
          text: "text" in operation ? operation.text : "newText" in operation ? operation.newText : "summary" in operation ? operation.summary : "note" in operation ? operation.note : "", sourceId: operation.sourceId, cancellable: true,
          ...( "expectedText" in operation && operation.expectedText ? { expectedText: operation.expectedText } : {}),
          ...(programGeneratedOperationKeys?.includes(JSON.stringify(operation)) ? { programGenerated: true } : {}),
        })),
        completedBatches, totalBatches,
        ...(partialFailure ? { partialFailure } : {}),
        ...(validationWarnings?.length ? { validationWarnings } : {}),
        ...(createDiagnostics ? { createDiagnostics } : {}),
        ...(updateDiagnostics ? { updateDiagnostics } : {}),
        ...(duplicateDetails?.length ? { duplicateDetails } : {}),
        ...(degraded ? { degraded } : {}),
        ...(assessments?.length ? { assessments } : {}),
        ...(programGeneratedOperations ? { programGeneratedOperations } : {}),
        sourceLinks: Object.fromEntries([...existingEvidenceMembers.map(({ card }) => card), ...members.map(({ card }) => card)].map((member) => [member.sourceId, `[[${member.path.replace(/\.md$/i, "")}|${member.title}]]`])),
        sourceDates: Object.fromEntries([...existingEvidenceMembers, ...members].map(({ card }) => [card.sourceId, card.date])),
        ...(existing && !input.rebuild ? {
          memberLinks: [...new Set([...existing.page.memberLinks, ...memberRecords.map((member) => `[[${member.path.replace(/\.md$/i, "")}|${member.title}]]`)])],
          tags: [...new Set([...existing.page.tags, ...(verifiedTagUpdate?.tags || [])])],
          tagAliases: verifiedTagUpdate?.aliases || existing.page.tagAliases || {},
        } : input.rebuild ? { ...(replacement ? { replacement } : {}) } : {
          create: { title: input.title || members[0]?.card.title || "Topic", basis: input.basis, tags: learned.tags, tagAliases: learned.aliases, members: memberRecords, ...(generatedModel ? { model: generatedModel } : {}), ...(overviewGeneratedFromThreads ? { overviewGeneratedFromThreads: true } : {}) },
        }),
      };
      this.previews.set(activityId, { preview, managesActivity: true });
      return preview;
    } catch (error) {
      this.controllers.delete(activityId);
      if (controller.signal.aborted) {
        this.host.cancelActivity?.(activityId, "Topic operation cancelled; the topic page was not changed");
        throw error;
      }
      else if (error instanceof TopicGenerationError) {
        const message = t("The topic page could not be generated. You can retry. The page was not modified.");
        const userError = new Error(message);
        this.host.failActivity(activityId, userError);
        throw userError;
      } else {
        this.host.failActivity(activityId, error);
        throw error;
      }
    } finally {
      input.signal?.removeEventListener("abort", cancel);
    }
  }

  cancel(id: string): void {
    const matches = (activityId: string, pending?: PendingPreview) => activityId === id || activityId.endsWith(`:${id}`) || pending?.preview.topicId === id;
    const pendingEntry = [...this.previews.entries()].find(([activityId, pending]) => matches(activityId, pending));
    const controllerEntry = [...this.controllers.entries()].find(([activityId]) => matches(activityId, this.previews.get(activityId)));
    const activityId = pendingEntry?.[0] || controllerEntry?.[0];
    if (!activityId) return;
    controllerEntry?.[1].abort();
    this.controllers.delete(activityId);
    this.previews.delete(activityId);
    if (pendingEntry?.[1].managesActivity) this.host.cancelActivity?.(activityId, "Topic operation cancelled; the topic page was not changed");
  }

  async apply(preview: TopicChangePreview, selection: readonly string[]): Promise<{ path: string; markdown: string; pageChangedDuringGeneration: boolean; skipped?: Array<{ id: string; reason: "block-modified" }> }> {
    const pendingEntry = [...this.previews.entries()].find(([, pending]) => pending.preview === preview);
    if (!pendingEntry) throw new Error("Topic preview is no longer available");
    const [activityId] = pendingEntry;
    const managesActivity = pendingEntry[1].managesActivity;
    const store = this.storeForCurrentFolder();
    try {
      if (preview.create) {
        const page = createTopicPage({ id: preview.topicId, title: preview.create.title, tags: preview.create.tags, members: preview.create.members, basis: preview.create.basis });
        page.tagAliases = preview.create.tagAliases || {};
        if (preview.create.model) {
          page.layout = 2;
          page.body = renderTopicPage(preview.create.model, preview.create.members, {
            overview: t("Overview"), progress: t("Topic progress"),
            disagreements: t("Disagreements and verification"), open: t("Topic open items"),
            timeline: t("Timeline"), sources: t("Source notes"), conflict: t("Conflicting accounts"),
            openQuestion: t("Topic open question"), openAction: t("Topic open action"), openBug: t("Topic open bug"),
          });
        }
        const selected = new Set(selection);
        const operations = preview.items.filter((item) => selected.has(item.id))
          .map(({ operation }) => ({ ...operation, sourceId: preview.sourceLinks?.[operation.sourceId] || operation.sourceId }));
        const initial = applyTopicOps(serializeTopicPage(page), operations, {
          openQuestion: t("Topic open question"), openAction: t("Topic open action"), openBug: t("Topic open bug"),
        }).markdown;
        const parsed = parseTopicPage(initial);
        if (!parsed) throw new Error("Generated topic page could not be parsed");
        const path = await store.create(parsed, initial);
        const stored = await this.host.topicStore.read(path);
        this.previews.delete(activityId);
        this.controllers.delete(activityId);
        if (managesActivity) this.host.completeActivity(activityId);
        return { path, markdown: stored, pageChangedDuringGeneration: false, skipped: [] };
      }
      if (preview.replacement) {
        const result = await store.replaceWithV2Preview(preview, selection);
        this.previews.delete(activityId);
        this.controllers.delete(activityId);
        if (managesActivity) this.host.completeActivity(activityId);
        return { path: preview.replacement.path, markdown: result.markdown, pageChangedDuringGeneration: false, skipped: [] };
      }
      const current = (await store.list()).find((entry) => entry.page.id === preview.topicId);
      if (!current) throw new Error(`Topic not found: ${preview.topicId}`);
      const result = await store.apply(current.path, preview, selection);
      await pendingEntry[1].onApplied?.(new Set(selection), result.skipped);
      this.previews.delete(activityId);
      this.controllers.delete(activityId);
      if (managesActivity) this.host.completeActivity(activityId);
      return { path: current.path, markdown: result.markdown, pageChangedDuringGeneration: result.pageChangedDuringGeneration, skipped: result.skipped };
    } catch (error) {
      this.controllers.delete(activityId);
      if (managesActivity) this.host.failActivity(activityId, error);
      throw error;
    }
  }

  async previewExcludeBlock(topicPath: string, blockId: string): Promise<TopicChangePreview> {
    if (!this.host.topicErrata) throw new Error("Topic errata storage is unavailable");
    const topic = (await this.storeForCurrentFolder().list()).find((entry) => entry.path === topicPath);
    if (!topic) throw new Error("Topic not found: " + topicPath);
    const store = this.storeForCurrentFolder();
    const markdown = await store.readIndexedMarkdown(topic.path);
    const block = parseTopicPageBlocks(markdown).find((item) => item.id === blockId);
    if (!block) throw new Error("The selected topic block could not be found.");
    const sources = topicBlockSourcePaths(markdown, block).filter((path) => topic.page.members.includes(path));
    const description = stripBlockMarkers(block.text);
    const operation = { type: "remove_block" as const, blockId: block.id, expectedText: block.text, sourceId: topic.page.members[0] || topic.page.id };
    const preview: TopicChangePreview = {
      topicId: topic.page.id,
      expectedHash: hashTopicPage(markdown),
      pageWasManuallyEdited: topic.page.cacheStatus !== "valid" || (!!topic.page.appliedHash && topic.page.appliedHash !== hashTopicPage(markdown)),
      items: [{ id: `off-topic-${hashText(JSON.stringify(operation))}`, operation, type: operation.type, target: topicBlockHeadingLabel(markdown, block.id) || t("Corresponding section"), text: block.text, sourceId: operation.sourceId, expectedText: block.text, cancellable: true }],
      completedBatches: 0,
      totalBatches: 0,
    };
    this.previews.set(`topics:manual:${topic.page.id}`, {
      preview,
      managesActivity: false,
      onApplied: async (selection, skipped) => {
        if (!description || !selection.has(preview.items[0].id) || skipped.some((item) => item.id === block.id)) return;
        const scope = sources.length ? sources : [undefined];
        for (const source of scope) await this.host.topicErrata?.append(topic.path, topic.page.title, description, source);
      },
    });
    return preview;
  }

  async estimateContentCleaning(topicId: string): Promise<{ chars: number; tokens: number }> {
    const topic = (await this.storeForCurrentFolder().list()).find((entry) => entry.page.id === topicId);
    if (!topic) throw new Error("Topic not found: " + topicId);
    const markdown = await this.storeForCurrentFolder().readIndexedMarkdown(topic.path);
    const errata = this.host.topicErrata ? await this.host.topicErrata.load(topic.path, topic.page.members) : { entries: [], notes: [] };
    if (!errata.entries.length) return { chars: 0, tokens: 0 };
    return estimateTopicCleaningInput(markdown, topic.page.members, errata);
  }

  async previewContentCleaning(topicId: string): Promise<TopicChangePreview> {
    if (!this.host.topicErrata) throw new Error("Topic errata storage is unavailable");
    const topic = (await this.storeForCurrentFolder().list()).find((entry) => entry.page.id === topicId);
    if (!topic) throw new Error("Topic not found: " + topicId);
    const store = this.storeForCurrentFolder();
    const markdown = await store.readIndexedMarkdown(topic.path);
    const errata = await this.host.topicErrata.load(topic.path, topic.page.members);
    if (!errata.entries.length) {
      const preview: TopicChangePreview = {
        topicId, expectedHash: hashTopicPage(markdown), pageWasManuallyEdited: topic.page.cacheStatus !== "valid",
        items: [], completedBatches: 0, totalBatches: 0, inputChars: 0, estimatedTokens: 0,
      };
      this.previews.set(`topics:clean:${topicId}`, { preview, managesActivity: false });
      return preview;
    }
    const generated = await generateTopicCleaningOperations(this.host.integration, { markdown, members: topic.page.members, errata });
    const items = generated.operations.map((operation, index) => ({
      id: `clean-${index}-${hashText(JSON.stringify(operation))}`,
      operation, type: operation.type,
      target: topicBlockHeadingLabel(markdown, operation.blockId) || t("Corresponding section"),
      text: operation.type === "revise_block" ? operation.newText : operation.expectedText,
      sourceId: operation.sourceId,
      expectedText: operation.expectedText,
      cancellable: true,
    }));
    const preview: TopicChangePreview = {
      topicId, expectedHash: hashTopicPage(markdown), pageWasManuallyEdited: topic.page.cacheStatus !== "valid",
      items, completedBatches: 1, totalBatches: 1, inputChars: generated.inputChars, estimatedTokens: Math.ceil(generated.inputChars / 4),
      ...(Object.keys(generated.discarded).length ? { validationWarnings: [t("Some topic blocks could not be cleaned because their source or footnotes did not pass validation.")] } : {}),
    };
    this.previews.set(`topics:clean:${topicId}`, { preview, managesActivity: false });
    return preview;
  }

  async undoLastUpdate(topicId: string) { return this.storeForCurrentFolder().undoLastUpdate(topicId); }
  async previewRebuild(topicId: string, onProgress?: TopicPreviewInput["onProgress"]): Promise<TopicChangePreview> {
    const topic = (await this.storeForCurrentFolder().list()).find((entry) => entry.page.id === topicId);
    if (!topic) throw new Error("Topic not found: " + topicId);
    if (topic.page.layout === 2) throw new Error("This topic page already uses the new layout");
    if (!topic.page.members.length) throw new Error("This topic has no member notes to rebuild from");
    return this.preview({ topicId, startPath: topic.page.members[0], memberPaths: topic.page.members, basis: "overview", rebuild: true, onProgress });
  }
  async deleteTopic(topicId: string): Promise<void> { return this.storeForCurrentFolder().deleteTopic(topicId); }
  async mergeTopics(sourceId: string, targetId: string): Promise<void> { return this.storeForCurrentFolder().mergeTopics(sourceId, targetId); }
  async ignoreNote(topicId: string, path: string): Promise<void> { return this.storeForCurrentFolder().addExcluded(topicId, path); }
  async restoreIgnoredNote(topicId: string, path: string): Promise<void> { return this.storeForCurrentFolder().removeExcluded(topicId, path); }

  async scanUnintegrated(topicId: string, signal?: AbortSignal): Promise<TopicCandidates> {
    const topics = await this.storeForCurrentFolder().list();
    const topic = topics.find((item) => item.page.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    const { cards } = await this.refresh({ signal });
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

  async countPending(topicId: string): Promise<number> {
    const topics = await this.storeForCurrentFolder().list();
    const topic = topics.find((entry) => entry.page.id === topicId);
    if (!topic) return 0;
    const { cards } = await this.refresh();
    const updatedAt = Date.parse(topic.page.updated) || 0;
    return cards.filter((card) => overviewCardTimestamp(card) > updatedAt
      && matchNoteToTopics(card, [topic.page], cards).length > 0).length;
  }
}
