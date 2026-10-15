import { NS_FM, NS_ROOT } from "../shared/namespace";
import { appendTopicMemberLinks, appendTopicMemberMetadata, buildTopicBlockIndex, hashTopicPage, isLegacyTopicStatusLine, parseTopicPage, readLegacyTopicMachineProperties, removeTopicMachineProperties, withTopicBlockIndex, updateTopicFrontmatter, serializeTopicPage, applyTopicOps, topicMemberMetadataCounts, type TopicBlockIndexEntry, type TopicOperation, type TopicPage } from "./topic-page";
import { topicMemberExcludeSelectionId, type TopicChangePreview } from "./topic-integration";
import { rebuildTopicTagAliases } from "./topic-tags";

export const TOPIC_HISTORY_LIMIT = 5;
export interface TopicStorePort {
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;
  process(path: string, transform: (content: string) => string): Promise<void>;
  listMarkdown(folder: string): Promise<Array<{ path: string; name: string }>>;
  ensureFolder(path: string): Promise<void>;
  deleteHistory(path: string): Promise<void>;
  readCache(path: string): Promise<string | null>;
  writeCache(path: string, content: string): Promise<void>;
  deleteCache(path: string): Promise<void>;
  readMemberTags(paths: readonly string[]): Promise<string[]>;
  trashFile(path: string): Promise<void>;
  now(): number;
  /** Optional diagnostic sink; receives identifiers only, never page text. */
  logDiagnostic?(code: string, data: Record<string, unknown>): void;
}
export interface TopicStoreOptions { folder: string; port: TopicStorePort }
export interface TopicApplyResult { markdown: string; appliedCount: number; pageChangedDuringGeneration: boolean; resultingHash: string; skipped: Array<{ id: string; reason: "block-modified" }> }
export type TopicUndoResult = { restored: true } | { restored: false; reason: "no-history" | "page-modified" };
export interface TopicMachineCache {
  version: 1;
  topicId: string;
  pageHash: string;
  tagAliases: Record<string, string[]>;
  blocks: TopicBlockIndexEntry[];
  lastSnapshot: string | null;
  updatedAt: string;
}

function safeName(title: string): string {
  const value = title.trim().replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").replace(/[. ]+$/g, "");
  return value || "Topic";
}

export class TopicStore {
  private readonly port: TopicStorePort;
  private readonly folder: string;
  constructor(options: TopicStoreOptions) { this.port = options.port; this.folder = options.folder.replace(/\/+$/g, ""); }

  private historyFolder(topicId: string): string { return `${NS_ROOT}/.cache/topic-history/${encodeURIComponent(topicId)}`; }
  private cachePath(topicId: string): string { return `${NS_ROOT}/.cache/topic-index/${encodeURIComponent(topicId)}.json`; }
  private async readCache(path: string): Promise<string | null> {
    try { return await this.port.readCache(path); } catch { return null; }
  }
  private parseCache(value: string | null, topicId: string): TopicMachineCache | null {
    if (!value) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const cache = parsed as Partial<TopicMachineCache>;
      if (cache.version !== 1 || cache.topicId !== topicId || typeof cache.pageHash !== "string" || typeof cache.updatedAt !== "string") return null;
      if (!cache.tagAliases || typeof cache.tagAliases !== "object" || Array.isArray(cache.tagAliases) || !Object.values(cache.tagAliases).every((values) => Array.isArray(values) && values.every((value) => typeof value === "string")) || !Array.isArray(cache.blocks)) return null;
      if (cache.lastSnapshot !== null && typeof cache.lastSnapshot !== "string") return null;
      const blocks = cache.blocks.filter((block): block is TopicBlockIndexEntry => !!block && typeof block.id === "string" && typeof block.kind === "string" && ["overview", "thread-summary", "point", "disagreement", "open", "other"].includes(block.kind) && Array.isArray(block.headingPath) && block.headingPath.every((part) => typeof part === "string") && typeof block.ordinal === "number" && Number.isInteger(block.ordinal) && block.ordinal >= 0 && typeof block.textHash === "string" && typeof block.normalizedPreview === "string" && [...block.normalizedPreview].length <= 40);
      if (blocks.length !== cache.blocks.length) return null;
      return { version: 1, topicId, pageHash: cache.pageHash, tagAliases: cache.tagAliases, blocks, lastSnapshot: cache.lastSnapshot || null, updatedAt: cache.updatedAt };
    } catch { return null; }
  }
  private async latestSnapshot(topicId: string): Promise<string | null> {
    try {
      const files = await this.port.listMarkdown(this.historyFolder(topicId));
      return files.sort((a, b) => b.name.localeCompare(a.name))[0]?.path || null;
    } catch { return null; }
  }
  private async ensureMachineCache(path: string, markdown: string, page: TopicPage): Promise<{ cache: TopicMachineCache; status: "valid" | "missing" | "corrupt" | "stale" }> {
    const cachePath = this.cachePath(page.id);
    const raw = await this.readCache(cachePath);
    const parsed = this.parseCache(raw, page.id);
    const pageHash = hashTopicPage(markdown);
    const status = parsed ? (parsed.pageHash === pageHash ? "valid" : "stale") : raw === null ? "missing" : "corrupt";
    if (parsed && status === "valid") return { cache: parsed, status };

    const legacy = readLegacyTopicMachineProperties(markdown);
    let memberTags: string[] = [];
    try { memberTags = await this.port.readMemberTags(page.members); } catch { /* cache rebuild can use the page tags alone */ }
    const aliases = parsed && parsed.pageHash === pageHash
      ? parsed.tagAliases
      : (Object.keys(legacy.tagAliases).length ? legacy.tagAliases : rebuildTopicTagAliases(page.tags, memberTags));
    const previousBlocks = parsed?.blocks.length ? parsed.blocks : legacy.blocks;
    let snapshots: Array<{ path: string; name: string }> = [];
    try { snapshots = await this.port.listMarkdown(this.historyFolder(page.id)); } catch { /* history is optional */ }
    const lastSnapshot = (parsed?.lastSnapshot && snapshots.some((file) => file.path === parsed.lastSnapshot))
      ? parsed.lastSnapshot
      : (legacy.lastSnapshot && snapshots.some((file) => file.path === legacy.lastSnapshot) ? legacy.lastSnapshot : await this.latestSnapshot(page.id));
    const cache: TopicMachineCache = {
      version: 1,
      topicId: page.id,
      // Preserve a stale hash until the next successful page write so edit detection and undo guards remain effective.
      pageHash: parsed?.pageHash || pageHash,
      tagAliases: aliases,
      blocks: buildTopicBlockIndex(markdown, previousBlocks),
      lastSnapshot,
      updatedAt: new Date(this.port.now()).toISOString(),
    };
    await this.persistCache(cache);
    return { cache, status };
  }
  private async persistCache(cache: TopicMachineCache): Promise<void> {
    const path = this.cachePath(cache.topicId);
    try {
      await this.port.ensureFolder(`${NS_ROOT}/.cache/topic-index`);
      await this.port.writeCache(path, JSON.stringify(cache));
    } catch {
      this.port.logDiagnostic?.("topic.cache_write_failed", { topicId: cache.topicId, path });
    }
  }
  private async cacheAfterWrite(topicId: string, markdown: string, tagAliases?: Record<string, string[]>, lastSnapshot?: string | null, blocks?: readonly TopicBlockIndexEntry[]): Promise<void> {
    try {
      const page = parseTopicPage(markdown);
      if (!page) return;
      const prior = this.parseCache(await this.readCache(this.cachePath(topicId)), topicId);
      let memberTags: string[] = [];
      try { memberTags = await this.port.readMemberTags(page.members); } catch { /* use canonical topic tags */ }
      const cache: TopicMachineCache = {
        version: 1, topicId, pageHash: hashTopicPage(markdown),
        tagAliases: tagAliases || prior?.tagAliases || rebuildTopicTagAliases(page.tags, memberTags),
        blocks: blocks ? [...blocks] : buildTopicBlockIndex(markdown, prior?.blocks),
        lastSnapshot: lastSnapshot === undefined ? prior?.lastSnapshot || null : lastSnapshot,
        updatedAt: new Date(this.port.now()).toISOString(),
      };
      await this.persistCache(cache);
    } catch {
      this.port.logDiagnostic?.("topic.cache_rebuild_failed", { topicId });
    }
  }
  private async makeSnapshot(topicId: string, markdown: string): Promise<string> {
    const folder = this.historyFolder(topicId);
    await this.port.ensureFolder(folder);
    const timestamp = this.port.now().toString();
    const files = await this.port.listMarkdown(folder);
    const existing = new Set(files.map((file) => file.path));
    let snapshotPath = `${folder}/${timestamp}.md`;
    for (let suffix = 2; existing.has(snapshotPath); suffix++) snapshotPath = `${folder}/${timestamp}-${suffix}.md`;
    await this.port.create(snapshotPath, markdown);
    const sorted = [...files, { path: snapshotPath, name: snapshotPath.split("/").pop() || "" }].sort((a, b) => a.name.localeCompare(b.name));
    for (const old of sorted.slice(0, Math.max(0, sorted.length - TOPIC_HISTORY_LIMIT))) await this.port.deleteHistory(old.path);
    return snapshotPath;
  }

  async create(page: TopicPage, content?: string): Promise<string> {
    await this.port.ensureFolder(this.folder);
    const base = `${this.folder}/${safeName(page.title)}.md`;
    const existing = new Set((await this.port.listMarkdown(this.folder)).map((file) => file.path));
    let path = base;
    for (let suffix = 2; existing.has(path); suffix++) path = `${this.folder}/${safeName(page.title)} ${suffix}.md`;
    const initial = content || serializeTopicPage(page);
    const clean = removeTopicMachineProperties(initial);
    await this.port.create(path, clean);
    await this.cacheAfterWrite(page.id, clean, page.tagAliases || {} , null);
    return path;
  }

  async read(path: string): Promise<TopicPage | null> {
    const markdown = await this.port.read(path);
    const page = parseTopicPage(markdown, path);
    if (!page) return null;
    const state = await this.ensureMachineCache(path, markdown, page);
    page.tagAliases = state.cache.tagAliases;
    page.appliedHash = state.cache.pageHash || undefined;
    page.undoSnapshot = state.cache.lastSnapshot || undefined;
    page.cacheStatus = state.status;
    return page;
  }

  async readIndexedMarkdown(path: string): Promise<string> {
    const markdown = await this.port.read(path);
    const page = parseTopicPage(markdown, path);
    if (!page) return markdown;
    const state = await this.ensureMachineCache(path, markdown, page);
    return withTopicBlockIndex(markdown, state.cache.blocks);
  }

  async list(): Promise<Array<{ path: string; page: TopicPage }>> {
    const files = await this.port.listMarkdown(this.folder);
    const pages: Array<{ path: string; page: TopicPage }> = [];
    for (const file of files) {
      const markdown = await this.port.read(file.path);
      const page = parseTopicPage(markdown, file.path);
      if (page) {
        const state = await this.ensureMachineCache(file.path, markdown, page);
        page.tagAliases = state.cache.tagAliases;
        page.appliedHash = state.cache.pageHash || undefined;
        page.undoSnapshot = state.cache.lastSnapshot || undefined;
        page.cacheStatus = state.status;
        pages.push({ path: file.path, page });
      }
    }
    return pages.sort((a, b) => a.page.title.localeCompare(b.page.title) || a.page.id.localeCompare(b.page.id));
  }

  async apply(path: string, preview: TopicChangePreview, selectedIds: readonly string[]): Promise<TopicApplyResult> {
    const selected = new Set(selectedIds);
    const operations = preview.items.filter((item) => selected.has(item.id))
      .map(({ operation }) => "sourceId" in operation && ["add_item", "annotate_item", "add_conflict", "resolve_question", "add_timeline"].includes(operation.type)
        ? { ...operation, sourceId: preview.sourceLinks?.[operation.sourceId] || operation.sourceId } : operation);
    const excludedMembers = preview.items.flatMap((item) => item.operation.type === "remove_member"
      && selected.has(item.id) && selected.has(topicMemberExcludeSelectionId(item.id)) ? [item.operation.path] : []);
    let appliedMarkdown = "";
    let pageChangedDuringGeneration = false;
    let appliedCount = 0;
    let skipped: TopicApplyResult["skipped"] = [];
    let updatedBlocks: TopicBlockIndexEntry[] | undefined;
    const hasChanges = operations.length > 0 || !!preview.memberLinks || !!preview.tags || !!preview.newMembers?.length || (preview.legacyAnchorCleanup === true && selected.has("__clean-legacy-markers__")) || (preview.legacyPropertyCleanup === true && selected.has("__clean-legacy-properties__")) || (preview.legacyStatusCleanup === true && selected.has("__clean-legacy-status__"));
    if (!hasChanges) {
      appliedMarkdown = await this.port.read(path);
      pageChangedDuringGeneration = hashTopicPage(appliedMarkdown) !== preview.expectedHash;
      return { markdown: appliedMarkdown, appliedCount, pageChangedDuringGeneration, resultingHash: hashTopicPage(appliedMarkdown), skipped: [] };
    }
    for (;;) {
      const before = await this.port.read(path);
      const parsed = parseTopicPage(before, path);
      if (!parsed) throw new Error(`Topic page is invalid: ${path}`);
      const memberRemovals = operations.filter((operation): operation is Extract<TopicOperation, { type: "remove_member" }> => operation.type === "remove_member");
      if (memberRemovals.length) applyTopicOps(before, memberRemovals);
      const machineState = await this.ensureMachineCache(path, before, parsed);
      const snapshotPath = await this.makeSnapshot(parsed.id, before);
      const beforeHash = hashTopicPage(before);
      const beforeMetadataCounts = topicMemberMetadataCounts(before);
      if (beforeMetadataCounts.members !== beforeMetadataCounts.timeline || beforeMetadataCounts.members !== beforeMetadataCounts.sources) {
        this.port.logDiagnostic?.("topic.member_metadata_before_mismatch", { ...beforeMetadataCounts });
      }
      let changed = false;
      await this.port.process(path, (current) => {
        if (hashTopicPage(current) !== beforeHash) {
          changed = true;
          return current;
        }
        const indexedCurrent = withTopicBlockIndex(current, machineState.cache.blocks);
        const result = applyTopicOps(indexedCurrent, operations);
        updatedBlocks = result.blockIndex;
        if (result.duplicateBlockIds?.length) this.port.logDiagnostic?.("topic.duplicate_block_id", { ids: result.duplicateBlockIds });
        const currentPage = parseTopicPage(result.markdown, path);
        if (!currentPage) throw new Error(`Topic page is invalid: ${path}`);
        const memberLinks = [...new Set([...currentPage.memberLinks, ...(preview.memberLinks || [])])];
        const tags = [...new Set([...currentPage.tags, ...(preview.tags || [])])];
        let next = currentPage.layout === 2 ? result.markdown : appendTopicMemberLinks(result.markdown, memberLinks);
        if (preview.legacyStatusCleanup && selected.has("__clean-legacy-status__")) {
          const prefixes = preview.legacyStatusPrefixes || [];
          next = next.split("\n").filter((line) => !isLegacyTopicStatusLine(line, prefixes)).join("\n");
        }
        next = appendTopicMemberMetadata(next, preview.metadataMembers || preview.newMembers || []);
        const updates: Record<string, string | string[]> = {
          [NS_FM.topicUpdated]: new Date(this.port.now()).toISOString(),
        };
        if (preview.memberLinks) updates[NS_FM.topicMembers] = memberLinks;
        if (preview.tags) updates[NS_FM.topicTags] = tags;
        if (excludedMembers.length) updates[NS_FM.topicExcluded] = [...new Set([...currentPage.excluded, ...excludedMembers])];
        next = updateTopicFrontmatter(next, updates);
        if (!parsed.legacyMachineProperties || (preview.legacyPropertyCleanup === true && selected.has("__clean-legacy-properties__"))) next = removeTopicMachineProperties(next);
        else next = updateTopicFrontmatter(next, {
          [NS_FM.topicTagAliases]: JSON.stringify(machineState.cache.tagAliases),
          [NS_FM.topicBlocks]: JSON.stringify(machineState.cache.blocks),
          [NS_FM.topicHash]: hashTopicPage(next),
          [NS_FM.topicUndoSnapshot]: snapshotPath,
        });
        const afterMetadataCounts = topicMemberMetadataCounts(next);
        if (afterMetadataCounts.members !== afterMetadataCounts.timeline || afterMetadataCounts.members !== afterMetadataCounts.sources) {
          this.port.logDiagnostic?.("topic.member_metadata_after_mismatch", { ...afterMetadataCounts });
        }
        appliedMarkdown = next;
        appliedCount = result.applied.length;
        skipped = result.skipped;
        return next;
      });
      pageChangedDuringGeneration ||= changed || beforeHash !== preview.expectedHash;
      if (changed) continue;
      await this.cacheAfterWrite(parsed.id, appliedMarkdown, preview.tagAliases || machineState.cache.tagAliases, snapshotPath, updatedBlocks);
      break;
    }
    return { markdown: appliedMarkdown, appliedCount, pageChangedDuringGeneration, resultingHash: hashTopicPage(appliedMarkdown), skipped };
  }

  async replaceWithV2Preview(preview: TopicChangePreview, selectedIds: readonly string[] = []): Promise<TopicApplyResult> {
    const replacement = preview.replacement;
    if (!replacement) throw new Error("Topic rebuild preview is missing replacement content");
    const before = await this.port.read(replacement.path);
    if (hashTopicPage(before) !== preview.expectedHash) throw new Error("The topic page changed after the rebuild preview. Generate a new preview before applying it.");
    const current = parseTopicPage(before, replacement.path);
    if (!current) throw new Error("Topic page is invalid: " + replacement.path);
    const machineState = await this.ensureMachineCache(replacement.path, before, current);
    const snapshotPath = await this.makeSnapshot(current.id, before);
    let markdown = updateTopicFrontmatter(replacement.markdown, {
      [NS_FM.topicUpdated]: new Date(this.port.now()).toISOString(),
    });
    if (!current.legacyMachineProperties || (preview.legacyPropertyCleanup && selectedIds.includes("__clean-legacy-properties__"))) markdown = removeTopicMachineProperties(markdown);
    else markdown = updateTopicFrontmatter(markdown, {
      [NS_FM.topicTagAliases]: JSON.stringify(machineState.cache.tagAliases),
      [NS_FM.topicBlocks]: JSON.stringify(machineState.cache.blocks),
      [NS_FM.topicHash]: hashTopicPage(markdown),
      [NS_FM.topicUndoSnapshot]: snapshotPath,
    });
    let changed = false;
    await this.port.process(replacement.path, (latest) => {
      if (hashTopicPage(latest) !== preview.expectedHash) { changed = true; return latest; }
      return markdown;
    });
    if (changed) throw new Error("The topic page changed after the rebuild preview. Generate a new preview before applying it.");
    const result = await this.port.read(replacement.path);
    await this.cacheAfterWrite(current.id, result, machineState.cache.tagAliases, snapshotPath);
    return { markdown: result, appliedCount: 1, pageChangedDuringGeneration: false, resultingHash: hashTopicPage(result), skipped: [] };
  }

  async addExcluded(topicId: string, path: string): Promise<void> {
    const topic = (await this.list()).find((entry) => entry.page.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    await this.port.process(topic.path, (markdown) => {
      const page = parseTopicPage(markdown, topic.path);
      if (!page) throw new Error(`Topic page is invalid: ${topic.path}`);
      return updateTopicFrontmatter(markdown, { [NS_FM.topicExcluded]: [...new Set([...page.excluded, path])] });
    });
    const updated = await this.port.read(topic.path);
    await this.cacheAfterWrite(topicId, updated);
  }

  async removeExcluded(topicId: string, path: string): Promise<void> {
    const topic = (await this.list()).find((entry) => entry.page.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    await this.port.process(topic.path, (markdown) => {
      const page = parseTopicPage(markdown, topic.path);
      if (!page) throw new Error(`Topic page is invalid: ${topic.path}`);
      return updateTopicFrontmatter(markdown, { [NS_FM.topicExcluded]: page.excluded.filter((item) => item !== path) });
    });
    const updated = await this.port.read(topic.path);
    await this.cacheAfterWrite(topicId, updated);
  }

  async undoLastUpdate(topicId: string): Promise<TopicUndoResult> {
    const currentPage = (await this.list()).find((entry) => entry.page.id === topicId);
    if (!currentPage) return { restored: false, reason: "page-modified" };
    const currentMarkdown = await this.port.read(currentPage.path);
    const state = await this.ensureMachineCache(currentPage.path, currentMarkdown, currentPage.page);
    const snapshotPath = state.cache.lastSnapshot;
    if (!snapshotPath || !snapshotPath.startsWith(`${this.historyFolder(topicId)}/`)) return { restored: false, reason: "no-history" };
    const snapshots = await this.port.listMarkdown(this.historyFolder(topicId));
    if (!snapshots.some((snapshot) => snapshot.path === snapshotPath)) return { restored: false, reason: "no-history" };
    const path = currentPage.path;
    const current = await this.port.read(path);
    if (currentPage.page.cacheStatus !== "valid" || state.status !== "valid" || !state.cache.pageHash || hashTopicPage(current) !== state.cache.pageHash) return { restored: false, reason: "page-modified" };
    const snapshot = await this.port.read(snapshotPath);
    const expectedHash = hashTopicPage(current);
    await this.port.process(path, (latest) => hashTopicPage(latest) === expectedHash ? snapshot : latest);
    const restored = await this.port.read(path);
    if (hashTopicPage(restored) !== hashTopicPage(snapshot)) return { restored: false, reason: "page-modified" };
    const remaining = snapshots.filter((item) => item.path !== snapshotPath).sort((a, b) => b.name.localeCompare(a.name));
    const restoredPage = parseTopicPage(restored, path);
    let restoredTags: string[] = [];
    try { restoredTags = restoredPage ? await this.port.readMemberTags(restoredPage.members) : []; } catch { /* the restored page is already authoritative */ }
    await this.cacheAfterWrite(topicId, restored, restoredPage ? rebuildTopicTagAliases(restoredPage.tags, restoredTags) : undefined, remaining[0]?.path || null);
    return { restored: true };
  }

  async deleteTopic(topicId: string): Promise<void> {
    const topic = (await this.list()).find((entry) => entry.page.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    await this.port.trashFile(topic.path);
    await this.removeCache(topicId);
  }

  async mergeTopics(sourceId: string, targetId: string): Promise<void> {
    if (sourceId === targetId) throw new Error("A topic cannot be merged into itself");
    const topics = await this.list();
    const source = topics.find((item) => item.page.id === sourceId);
    const target = topics.find((item) => item.page.id === targetId);
    if (!source || !target) throw new Error("Source or target topic was not found");
    let mergeSnapshotPath: string | undefined;
    for (;;) {
      const targetPage = await this.port.read(target.path);
      const targetModel = parseTopicPage(targetPage, target.path);
      if (!targetModel || targetModel.id !== targetId) throw new Error(`Topic page is invalid: ${target.path}`);
      const snapshotPath = await this.makeSnapshot(targetId, targetPage);
      mergeSnapshotPath = snapshotPath;
      const beforeHash = hashTopicPage(targetPage);
      let changed = false;
      await this.port.process(target.path, (markdown) => {
        if (hashTopicPage(markdown) !== beforeHash) {
          changed = true;
          return markdown;
        }
        const current = parseTopicPage(markdown, target.path);
        if (!current || current.id !== targetId) throw new Error(`Topic page is invalid: ${target.path}`);
        const merged = [...new Set([...current.memberLinks, ...source.page.memberLinks])];
        const explanation = `- 已合并自 [[${source.path.replace(/\.md$/i, "")}|${source.page.title}]]（主题 ${sourceId}）`;
        let body = appendTopicMemberLinks(markdown, source.page.memberLinks);
        if (!body.includes(explanation)) body = `${body.trimEnd()}\n\n## 已合并主题\n\n${explanation}\n`;
        let next = removeTopicMachineProperties(updateTopicFrontmatter(body, {
          [NS_FM.topicMembers]: merged,
          [NS_FM.topicTags]: [...new Set([...current.tags, ...source.page.tags])],
          [NS_FM.topicUpdated]: new Date(this.port.now()).toISOString(),
        }));
        return next;
      });
      if (changed) continue;
      break;
    }
    const currentSource = (await this.list()).find((item) => item.page.id === sourceId);
    if (!currentSource) throw new Error(`Source topic was not found after merging: ${sourceId}`);
    await this.port.trashFile(currentSource.path);
    const mergedTarget = await this.port.read(target.path);
    const mergedAliases = { ...target.page.tagAliases };
    for (const [key, values] of Object.entries(source.page.tagAliases || {})) mergedAliases[key] = [...new Set([...(mergedAliases[key] || []), ...values])];
    await this.cacheAfterWrite(targetId, mergedTarget, mergedAliases, mergeSnapshotPath || null);
    await this.removeCache(sourceId);
  }

  private async removeCache(topicId: string): Promise<void> {
    try { await this.port.deleteCache(this.cachePath(topicId)); }
    catch { this.port.logDiagnostic?.("topic.cache_delete_failed", { topicId }); }
  }
}
