import { buildRelatedNotesCorpus, type RelatedNotesCorpusPort } from "../indexing/related-notes-corpus";
import type { RelatedNoteDocument } from "../indexing/related-notes";
import { buildOverviewCard, type OverviewCard } from "./overview-card";
import { NS_TYPE_TOPIC, readNamespaceFrontmatter } from "../shared/namespace";

export const OVERVIEW_DEFAULT_WINDOW_DAYS = 90;
export interface OverviewCardStore { load(): Promise<OverviewCard[]>; save(cards: readonly OverviewCard[]): Promise<void> }
export interface OverviewCardCachePort extends RelatedNotesCorpusPort {
  listNoteFiles(): Array<{ path: string; basename: string; mtime: number; ctime?: number }>;
  getMtime(path: string): number | null;
}
export interface OverviewRefreshResult { added: number; updated: number; removed: number; unchanged: number; readCount: number; elapsedMs: number }
export interface OverviewRefreshOptions { windowDays?: number }

export class OverviewCardCache {
  private readonly cards = new Map<string, OverviewCard>();
  private readonly mtimes = new Map<string, number>();
  private readonly markdownByPath = new Map<string, string>();
  private readCount = 0;
  private readonly port: OverviewCardCachePort;
  private readonly roots: string[];
  constructor(port: OverviewCardCachePort, roots: string[]) { this.port = port; this.roots = roots; }

  async refresh(options: OverviewRefreshOptions = {}): Promise<OverviewRefreshResult> {
    const start = Date.now();
    const files = this.port.listNoteFiles().filter((file) => file.path.toLowerCase().endsWith(".md")
      && readNamespaceFrontmatter((this.port.getFrontmatter(file.path) || {}) as Record<string, unknown>, "type") !== NS_TYPE_TOPIC);
    const paths = new Set(files.map((file) => file.path));
    let removed = 0;
    for (const path of [...this.mtimes.keys()]) if (!paths.has(path)) { this.cards.delete(path); this.mtimes.delete(path); this.markdownByPath.delete(path); removed++; }
    let added = 0; let updated = 0; let unchanged = 0; let readCount = 0;
    const cutoff = Number.isFinite(options.windowDays) && (options.windowDays ?? 0) >= 0
      ? this.port.now() - (options.windowDays ?? OVERVIEW_DEFAULT_WINDOW_DAYS) * 86400000
      : this.port.now() - OVERVIEW_DEFAULT_WINDOW_DAYS * 86400000;
    const eligible = files.filter((file) => (this.port.getMtime(file.path) ?? file.mtime) >= cutoff);
    const noSourceChanges = removed === 0 && eligible.every((file) => this.mtimes.get(file.path) === (this.port.getMtime(file.path) ?? file.mtime));
    if (noSourceChanges) {
      unchanged = [...this.cards.keys()].filter((path) => eligible.some((file) => file.path === path)).length;
      return { added, updated, removed, unchanged, readCount, elapsedMs: Date.now() - start };
    }
    const changedPaths = new Set(eligible.filter((file) => this.mtimes.get(file.path) !== (this.port.getMtime(file.path) ?? file.mtime)).map((file) => file.path));
    const corpus = await buildRelatedNotesCorpus({
      ...this.port,
      listNoteFiles: () => eligible,
      readText: async (path) => {
        const file = files.find((entry) => entry.path === path);
        const mtime = this.port.getMtime(path) ?? file?.mtime ?? -1;
        if (this.mtimes.get(path) === mtime && this.markdownByPath.has(path)) return this.markdownByPath.get(path) || "";
        const text = await this.port.readText(path);
        this.markdownByPath.set(path, text);
        this.mtimes.set(path, mtime);
        readCount++;
        this.readCount++;
        return text;
      },
    }, { roots: this.roots, bodyExcerptChars: 0, minimumBodyChars: 0 });
    const documents = new Map<string, RelatedNoteDocument>(corpus.documents.map((doc) => [doc.path, doc]));
    for (const file of eligible) {
      const mtime = this.port.getMtime(file.path) ?? file.mtime;
      this.mtimes.set(file.path, mtime);
      const document = documents.get(file.path);
      if (!document) continue;
      const prior = this.cards.get(file.path);
      if (prior && !changedPaths.has(file.path)) unchanged++;
      else {
        const markdown = this.markdownByPath.get(file.path) || "";
        const card = buildOverviewCard({ document, markdown, frontmatter: this.port.getFrontmatter(file.path), mtime, ctime: file.ctime });
        if (prior) updated++; else added++;
        this.cards.set(file.path, card);
        this.mtimes.set(file.path, mtime);
      }
      const card = this.cards.get(file.path);
      if (card) {
        card.outLinks = [...document.outLinks];
        card.inLinks = [...document.inLinks];
        card.unresolvedTargets = [...document.unresolvedTargets];
      }
    }
    return { added, updated, removed, unchanged, readCount, elapsedMs: Date.now() - start };
  }

  getCards(options: OverviewRefreshOptions = {}): OverviewCard[] {
    const days = options.windowDays ?? OVERVIEW_DEFAULT_WINDOW_DAYS;
    const cutoff = this.port.now() - days * 86400000;
    return [...this.cards.values()].filter((card) => card.mtime >= cutoff).sort((a, b) => a.path.localeCompare(b.path));
  }
  invalidate(path: string): void {
    this.cards.delete(path);
    this.mtimes.delete(path);
    this.markdownByPath.delete(path);
  }
  getNoteCount(): number { return this.cards.size; }
  getReadCount(): number { return this.readCount; }
  resetReadCount(): void { this.readCount = 0; }
}
