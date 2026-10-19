import * as obsidian from "obsidian";
import { NS_ERRATA_FOLDER, NS_FM, isTopicErrataFrontmatter } from "../shared/namespace";
import { t } from "../shared/i18n";
import { parseTopicErrata, type ParsedTopicErrata } from "./topic-errata-parser";
import { getTopicErrataSectionKey, getTopicErrataTitles, getTopicErrataTopicLabel } from "./topic-errata-sections";
import type { ScopedTopicErrata, ScopedTopicErrataEntry } from "./topic-errata-prompt";

export interface TopicErrataLink { link: string }
export interface TopicErrataUndoEntry { path: string; description: string; memberLink: string | null }
export interface TopicErrataAppendResult extends TopicErrataUndoEntry { added: boolean }
export interface TopicErrataStorePort {
  read(file: obsidian.TFile): Promise<string>;
  listErrataFiles(): obsidian.TFile[];
  getByPath(path: string): obsidian.TAbstractFile | null;
  getFrontmatter(file: obsidian.TFile): unknown;
  getLinks(file: obsidian.TFile): readonly TopicErrataLink[];
  resolveLink(link: string, sourcePath: string): obsidian.TAbstractFile | null;
  ensureFolder(path: string): Promise<void>;
  create(path: string, content: string): Promise<obsidian.TFile>;
  process(file: obsidian.TFile, transform: (current: string) => string): Promise<void>;
  uiLanguage(): string;
  diagnostic?(code: string, data: Record<string, unknown>): void;
}

function normalizePath(path: string): string { return obsidian.normalizePath(String(path || "")).replace(/^\/+|\/+$/g, ""); }
function linkToPath(link: string): string { return link.split("#")[0].split("|")[0].trim(); }
function renderDocument(topicPath: string, sectionTitles: ReturnType<typeof getTopicErrataTitles>, language: string): string {
  const topicLink = normalizePath(topicPath).replace(/\.md$/i, "");
  return `---\n${NS_FM.topicErrata}: true\n---\n${getTopicErrataTopicLabel(language)}[[${topicLink}]]\n\n## ${sectionTitles.offTopic}\n\n## ${sectionTitles.notes}\n`;
}
function insertionPoint(markdown: string): number | null {
  const lines = markdown.split(/\r?\n/);
  let offset = 0;
  for (const line of lines) {
    const ending = markdown.startsWith("\r\n", offset + line.length) ? 2 : markdown.startsWith("\n", offset + line.length) ? 1 : 0;
    const heading = line.match(/^\s*##\s+(.+?)\s*#*\s*$/);
    if (heading && getTopicErrataSectionKey(heading[1]) === "offTopic") return offset + line.length + ending;
    offset += line.length + ending;
  }
  return null;
}
function entryLine(description: string, memberPath?: string): string {
  const link = memberPath ? `[[${normalizePath(memberPath).replace(/\.md$/i, "")}]]：` : "";
  return `- ${link}${description.trim().replace(/\s+/g, " ")}`;
}
function normalizedDescription(description: string): string { return description.trim().replace(/\s+/g, " ").toLocaleLowerCase(); }
function parsedEntryLine(line: string): { memberLink: string | null; description: string } | null {
  const cleaned = line.trim().replace(/^[-*+]\s+/, "").replace(/^\d+[.)、]\s+/, "");
  const match = cleaned.match(/^(?:\[\[(.*?)\]\]\s*[：:]\s*)?(.+)$/);
  if (!match) return null;
  const description = match[2].trim().replace(/\s+/g, " ");
  return description ? { memberLink: match[1]?.split("|")[0].trim() || null, description } : null;
}

export class TopicErrataStore {
  private readonly port: TopicErrataStorePort;
  private readonly topicToErrata = new Map<string, string>();
  private readonly errataToTopic = new Map<string, string>();
  constructor(port: TopicErrataStorePort) { this.port = port; }

  /** Returns the destination path used when a new topic errata document is created. */
  pathForTopic(topicPath: string): string {
    const language = this.language();
    const basename = normalizePath(topicPath).split("/").pop()?.replace(/\.md$/i, "") || "";
    return normalizePath(`${NS_ERRATA_FOLDER}/${basename} · ${language === "zh" ? "主题勘误" : "Topic errata"}.md`);
  }

  rebuildIndex(): void {
    this.topicToErrata.clear();
    this.errataToTopic.clear();
    for (const file of this.port.listErrataFiles()) {
      if (!isTopicErrataFrontmatter(this.port.getFrontmatter(file))) continue;
      const first = this.port.getLinks(file)[0];
      if (!first) continue;
      const target = this.port.resolveLink(linkToPath(first.link), file.path);
      if (!(target instanceof obsidian.TFile) || this.isErrataFolder(target.path)) continue;
      const topicPath = normalizePath(target.path);
      const errataPath = normalizePath(file.path);
      this.topicToErrata.set(topicPath, errataPath);
      this.errataToTopic.set(errataPath, topicPath);
    }
  }

  refreshForVaultEvent(path: string, oldPath = ""): void {
    const current = normalizePath(path);
    const previous = normalizePath(oldPath);
    if (this.isErrataFolder(current) || this.isErrataFolder(previous)
      || this.topicToErrata.has(current) || this.topicToErrata.has(previous)
      || this.errataToTopic.has(current) || this.errataToTopic.has(previous)) this.rebuildIndex();
  }

  async find(topicPath: string): Promise<obsidian.TFile | null> {
    const key = normalizePath(topicPath);
    const indexed = this.topicToErrata.get(key);
    const indexedFile = indexed ? this.port.getByPath(indexed) : null;
    if (indexedFile instanceof obsidian.TFile) return indexedFile;
    this.rebuildIndex();
    const path = this.topicToErrata.get(key);
    const file = path ? this.port.getByPath(path) : null;
    return file instanceof obsidian.TFile ? file : null;
  }

  async ensure(topicPath: string): Promise<string> {
    const linked = await this.find(topicPath);
    if (linked) return linked.path;
    const path = this.pathForTopic(topicPath);
    await this.port.ensureFolder(NS_ERRATA_FOLDER);
    const existing = this.port.getByPath(path);
    if (existing instanceof obsidian.TFile) {
      if (this.pointsToTopic(existing, topicPath)) {
        this.rebuildIndex();
        return existing.path;
      }
      throw new Error(t("A different errata note already uses this file name."));
    }
    const language = this.language();
    try {
      const created = await this.port.create(path, renderDocument(topicPath, getTopicErrataTitles(language), language));
      this.rebuildIndex();
      return created.path;
    } catch (error) {
      const raced = this.port.getByPath(path);
      if (raced instanceof obsidian.TFile && this.pointsToTopic(raced, topicPath)) {
        this.rebuildIndex();
        return raced.path;
      }
      throw error;
    }
  }

  async load(topicPath: string, memberPaths: readonly string[]): Promise<ScopedTopicErrata> {
    const file = await this.find(topicPath);
    if (!file) return { entries: [], notes: [] };
    const markdown = await this.port.read(file);
    const parsed: ParsedTopicErrata = parseTopicErrata(markdown);
    const members = new Set(memberPaths.map(normalizePath));
    const entries: ScopedTopicErrataEntry[] = parsed.entries.flatMap((entry): ScopedTopicErrataEntry[] => {
      if (!entry.memberLink) return [{ ...entry, memberPath: null }];
      const target = this.port.resolveLink(linkToPath(entry.memberLink), file.path);
      if (!(target instanceof obsidian.TFile) || !members.has(normalizePath(target.path))) {
        this.port.diagnostic?.("topic.errata_member_not_in_topic", { topicPath, memberLink: entry.memberLink });
        return [];
      }
      return [{ ...entry, memberPath: normalizePath(target.path) }];
    });
    return { entries, notes: parsed.notes };
  }

  async append(topicPath: string, title: string, description: string, memberPath?: string): Promise<string> {
    return (await this.appendEntry(topicPath, title, description, memberPath)).path;
  }

  async appendEntry(topicPath: string, _title: string, description: string, memberPath?: string): Promise<TopicErrataAppendResult> {
    const path = await this.ensure(topicPath);
    const file = this.port.getByPath(path);
    if (!(file instanceof obsidian.TFile)) throw new Error(`Topic errata file not found: ${path}`);
    const language = this.language();
    const titles = getTopicErrataTitles(language);
    const content = entryLine(description, memberPath);
    let added = false;
    let callbackRan = false;
    let expectedMarkdown: string | undefined;
    const cleanDescription = description.trim().replace(/\s+/g, " ");
    const normalizedMemberLink = memberPath ? normalizePath(memberPath).replace(/\.md$/i, "") : null;
    try {
      await this.port.process(file, (markdown) => {
        callbackRan = true;
        const parsed = parseTopicErrata(markdown);
        const normalized = normalizedDescription(description);
        if (parsed.entries.some((entry) => normalizedDescription(entry.description) === normalized
          && ((entry.memberLink && normalizedMemberLink && this.linkResolvesToPath(entry.memberLink, path, memberPath || "")) || (!entry.memberLink && !normalizedMemberLink)))) {
          added = false;
          expectedMarkdown = markdown;
          return markdown;
        }
        const point = insertionPoint(markdown);
        added = true;
        expectedMarkdown = point === null
          ? `${markdown.trimEnd()}\n\n## ${titles.offTopic}\n${content}\n`
          : `${markdown.slice(0, point)}${content}\n${markdown.slice(point)}`;
        return expectedMarkdown;
      });
    } catch (error) {
      if (!callbackRan || expectedMarkdown === undefined) throw error;
      let currentMarkdown: string;
      try {
        currentMarkdown = await this.port.read(file);
      } catch {
        throw error;
      }
      if (currentMarkdown !== expectedMarkdown) throw error;
    }
    return { path, description: cleanDescription, memberLink: normalizedMemberLink, added };
  }

  async removeEntries(topicPath: string, entries: readonly TopicErrataUndoEntry[]): Promise<number> {
    if (!entries.length) return 0;
    const file = await this.find(topicPath);
    if (!file) return 0;
    const pending = entries.filter((entry) => normalizePath(entry.path) === normalizePath(file.path)).map((entry) => ({
      description: normalizedDescription(entry.description),
      memberLink: entry.memberLink ? normalizePath(entry.memberLink).replace(/\.md$/i, "") : null,
    }));
    if (!pending.length) return 0;
    let removed = 0;
    try {
      await this.port.process(file, (markdown) => {
        const remaining = [...pending];
        const ranges: Array<[number, number]> = [];
        let section: "offTopic" | "notes" | null = null;
        let offset = 0;
        while (offset < markdown.length) {
          const lineStart = offset;
          while (offset < markdown.length && markdown[offset] !== "\r" && markdown[offset] !== "\n") offset++;
          const line = markdown.slice(lineStart, offset);
          if (markdown.startsWith("\r\n", offset)) offset += 2;
          else if (markdown[offset] === "\r" || markdown[offset] === "\n") offset++;
          const heading = line.match(/^\s*##\s+(.+?)\s*#*\s*$/);
          if (heading) { section = getTopicErrataSectionKey(heading[1]); continue; }
          if (section !== "offTopic") continue;
          const candidate = parsedEntryLine(line);
          if (!candidate) continue;
          const index = remaining.findIndex((entry) => {
            if (normalizedDescription(candidate.description) !== entry.description) return false;
            if (!candidate.memberLink || !entry.memberLink) return !candidate.memberLink && !entry.memberLink;
            const target = this.port.resolveLink(linkToPath(candidate.memberLink), file.path);
            if (target instanceof obsidian.TFile) return normalizePath(target.path).replace(/\.md$/i, "") === entry.memberLink;
            return normalizePath(linkToPath(candidate.memberLink)).replace(/\.md$/i, "") === entry.memberLink;
          });
          if (index >= 0) {
            remaining.splice(index, 1);
            ranges.push([lineStart, offset]);
          }
        }
        removed = ranges.length;
        let next = markdown;
        for (const [start, end] of ranges.reverse()) next = `${next.slice(0, start)}${next.slice(end)}`;
        return next;
      });
      return removed;
    } catch (error) {
      this.port.diagnostic?.("topic.errata_remove_failed", { topicPath, errataPath: file.path, entryCount: pending.length });
      throw error;
    }
  }

  private language(): "zh" | "en" { return this.port.uiLanguage() === "zh" ? "zh" : "en"; }
  private isErrataFolder(path: string): boolean { return normalizePath(path).startsWith(`${NS_ERRATA_FOLDER}/`); }
  private pointsToTopic(file: obsidian.TFile, topicPath: string): boolean {
    const first = this.port.getLinks(file)[0];
    const target = first && this.port.resolveLink(linkToPath(first.link), file.path);
    return target instanceof obsidian.TFile && normalizePath(target.path) === normalizePath(topicPath);
  }
  private linkResolvesToPath(link: string, errataPath: string, targetPath: string): boolean {
    const target = this.port.resolveLink(linkToPath(link), errataPath);
    return target instanceof obsidian.TFile && normalizePath(target.path) === normalizePath(targetPath);
  }
}
