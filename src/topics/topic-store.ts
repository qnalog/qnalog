import { NS_FM, NS_ROOT } from "../shared/namespace";
import { appendTopicMemberLinks, hashTopicPage, parseTopicPage, updateTopicFrontmatter, serializeTopicPage, applyTopicOps, type TopicPage } from "./topic-page";
import type { TopicChangePreview } from "./topic-integration";

export const TOPIC_HISTORY_LIMIT = 5;
export interface TopicStorePort {
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;
  process(path: string, transform: (content: string) => string): Promise<void>;
  listMarkdown(folder: string): Promise<Array<{ path: string; name: string }>>;
  ensureFolder(path: string): Promise<void>;
  deleteHistory(path: string): Promise<void>;
  trashFile(path: string): Promise<void>;
  now(): number;
}
export interface TopicStoreOptions { folder: string; port: TopicStorePort }
export interface TopicApplyResult { markdown: string; appliedCount: number; pageChangedDuringGeneration: boolean; resultingHash: string }
export type TopicUndoResult = { restored: true } | { restored: false; reason: "no-history" | "page-modified" };

function safeName(title: string): string {
  const value = title.trim().replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").replace(/[. ]+$/g, "");
  return value || "Topic";
}

export class TopicStore {
  private readonly port: TopicStorePort;
  private readonly folder: string;
  constructor(options: TopicStoreOptions) { this.port = options.port; this.folder = options.folder.replace(/\/+$/g, ""); }

  private historyFolder(topicId: string): string { return `${NS_ROOT}/.cache/topic-history/${encodeURIComponent(topicId)}`; }
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
    await this.port.create(path, updateTopicFrontmatter(initial, { [NS_FM.topicHash]: hashTopicPage(initial) }));
    return path;
  }

  async read(path: string): Promise<TopicPage | null> {
    return parseTopicPage(await this.port.read(path), path);
  }

  async list(): Promise<Array<{ path: string; page: TopicPage }>> {
    const files = await this.port.listMarkdown(this.folder);
    const pages: Array<{ path: string; page: TopicPage }> = [];
    for (const file of files) {
      const page = parseTopicPage(await this.port.read(file.path), file.path);
      if (page) pages.push({ path: file.path, page });
    }
    return pages.sort((a, b) => a.page.title.localeCompare(b.page.title) || a.page.id.localeCompare(b.page.id));
  }

  async apply(path: string, preview: TopicChangePreview, selectedIds: readonly string[]): Promise<TopicApplyResult> {
    const selected = new Set(selectedIds);
    const operations = preview.items.filter((item) => selected.has(item.id))
      .map(({ operation }) => ({ ...operation, sourceId: preview.sourceLinks?.[operation.sourceId] || operation.sourceId }));
    let appliedMarkdown = "";
    let pageChangedDuringGeneration = false;
    let appliedCount = 0;
    const hasChanges = operations.length > 0 || !!preview.memberLinks || !!preview.tags;
    if (!hasChanges) {
      appliedMarkdown = await this.port.read(path);
      pageChangedDuringGeneration = hashTopicPage(appliedMarkdown) !== preview.expectedHash;
      return { markdown: appliedMarkdown, appliedCount, pageChangedDuringGeneration, resultingHash: hashTopicPage(appliedMarkdown) };
    }
    for (;;) {
      const before = await this.port.read(path);
      const parsed = parseTopicPage(before, path);
      if (!parsed) throw new Error(`Topic page is invalid: ${path}`);
      const snapshotPath = await this.makeSnapshot(parsed.id, before);
      const beforeHash = hashTopicPage(before);
      let changed = false;
      await this.port.process(path, (current) => {
        if (hashTopicPage(current) !== beforeHash) {
          changed = true;
          return current;
        }
        const result = applyTopicOps(current, operations);
        const currentPage = parseTopicPage(result.markdown, path);
        if (!currentPage) throw new Error(`Topic page is invalid: ${path}`);
        const memberLinks = [...new Set([...currentPage.memberLinks, ...(preview.memberLinks || [])])];
        const tags = [...new Set([...currentPage.tags, ...(preview.tags || [])])];
        let next = appendTopicMemberLinks(result.markdown, memberLinks);
        const updates: Record<string, string | string[]> = {
          [NS_FM.topicUpdated]: new Date(this.port.now()).toISOString(),
          [NS_FM.topicUndoSnapshot]: snapshotPath,
        };
        if (preview.memberLinks) updates[NS_FM.topicMembers] = memberLinks;
        if (preview.tags) updates[NS_FM.topicTags] = tags;
        if (preview.tagAliases) updates[NS_FM.topicTagAliases] = JSON.stringify(preview.tagAliases);
        next = updateTopicFrontmatter(next, updates);
        next = updateTopicFrontmatter(next, { [NS_FM.topicHash]: hashTopicPage(next) });
        appliedMarkdown = next;
        appliedCount = result.applied.length;
        return next;
      });
      pageChangedDuringGeneration ||= changed || beforeHash !== preview.expectedHash;
      if (changed) continue;
      break;
    }
    return { markdown: appliedMarkdown, appliedCount, pageChangedDuringGeneration, resultingHash: hashTopicPage(appliedMarkdown) };
  }

  async addExcluded(topicId: string, path: string): Promise<void> {
    const topic = (await this.list()).find((entry) => entry.page.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    await this.port.process(topic.path, (markdown) => {
      const page = parseTopicPage(markdown, topic.path);
      if (!page) throw new Error(`Topic page is invalid: ${topic.path}`);
      return updateTopicFrontmatter(markdown, { [NS_FM.topicExcluded]: [...new Set([...page.excluded, path])] });
    });
  }

  async removeExcluded(topicId: string, path: string): Promise<void> {
    const topic = (await this.list()).find((entry) => entry.page.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    await this.port.process(topic.path, (markdown) => {
      const page = parseTopicPage(markdown, topic.path);
      if (!page) throw new Error(`Topic page is invalid: ${topic.path}`);
      return updateTopicFrontmatter(markdown, { [NS_FM.topicExcluded]: page.excluded.filter((item) => item !== path) });
    });
  }

  async undoLastUpdate(topicId: string): Promise<TopicUndoResult> {
    const currentPage = (await this.list()).find((entry) => entry.page.id === topicId);
    if (!currentPage) return { restored: false, reason: "page-modified" };
    const snapshotPath = currentPage.page.undoSnapshot;
    if (!snapshotPath || !snapshotPath.startsWith(`${this.historyFolder(topicId)}/`)) return { restored: false, reason: "no-history" };
    const snapshots = await this.port.listMarkdown(this.historyFolder(topicId));
    if (!snapshots.some((snapshot) => snapshot.path === snapshotPath)) return { restored: false, reason: "no-history" };
    const path = currentPage.path;
    const current = await this.port.read(path);
    const currentModel = parseTopicPage(current, path);
    if (!currentModel?.appliedHash || hashTopicPage(current) !== currentModel.appliedHash) return { restored: false, reason: "page-modified" };
    const snapshot = await this.port.read(snapshotPath);
    const expectedHash = hashTopicPage(current);
    await this.port.process(path, (latest) => hashTopicPage(latest) === expectedHash ? snapshot : latest);
    const restored = await this.port.read(path);
    if (hashTopicPage(restored) !== hashTopicPage(snapshot)) return { restored: false, reason: "page-modified" };
    return { restored: true };
  }

  async deleteTopic(topicId: string): Promise<void> {
    const topic = (await this.list()).find((entry) => entry.page.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    await this.port.trashFile(topic.path);
  }

  async mergeTopics(sourceId: string, targetId: string): Promise<void> {
    if (sourceId === targetId) throw new Error("A topic cannot be merged into itself");
    const topics = await this.list();
    const source = topics.find((item) => item.page.id === sourceId);
    const target = topics.find((item) => item.page.id === targetId);
    if (!source || !target) throw new Error("Source or target topic was not found");
    for (;;) {
      const targetPage = await this.port.read(target.path);
      const targetModel = parseTopicPage(targetPage, target.path);
      if (!targetModel || targetModel.id !== targetId) throw new Error(`Topic page is invalid: ${target.path}`);
      const snapshotPath = await this.makeSnapshot(targetId, targetPage);
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
        let next = updateTopicFrontmatter(body, {
          [NS_FM.topicMembers]: merged,
          [NS_FM.topicTags]: [...new Set([...current.tags, ...source.page.tags])],
          [NS_FM.topicUpdated]: new Date(this.port.now()).toISOString(),
          [NS_FM.topicUndoSnapshot]: snapshotPath,
        });
        next = updateTopicFrontmatter(next, { [NS_FM.topicHash]: hashTopicPage(next) });
        return next;
      });
      if (changed) continue;
      break;
    }
    const currentSource = (await this.list()).find((item) => item.page.id === sourceId);
    if (!currentSource) throw new Error(`Source topic was not found after merging: ${sourceId}`);
    await this.port.trashFile(currentSource.path);
  }
}
