import type { OverviewCardCachePort } from "./overview-card-cache";
import { OverviewCardCache } from "./overview-card-cache";
import { suggestTopicsAsync, type TopicSuggestion } from "./topic-suggestions";

export interface TopicsServiceHost {
  overviewCards: OverviewCardCachePort;
  getRoots(): string[];
}
export type TopicsServicePort = OverviewCardCachePort;
export interface TopicsSuggestionsOptions { windowDays?: number; limit?: number; signal?: AbortSignal }
export interface TopicsSuggestionsResult {
  suggestions: TopicSuggestion[];
  stats: { noteCount: number; windowedCount: number; overviewMissing: number; readCount: number; elapsedMs: number };
}

export class TopicsService {
  private readonly host: TopicsServiceHost;
  private cache: OverviewCardCache | null = null;
  private roots: string[] = [];
  private lastSignature = "";
  private lastSuggestions: TopicSuggestion[] = [];
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
    return { suggestions: this.lastSuggestions, stats: {
      noteCount: cache.getNoteCount(), windowedCount: cards.length,
      overviewMissing: cards.filter((card) => card.overviewSource === "none").length,
      readCount: refreshed.readCount, elapsedMs: Date.now() - start,
    } };
  }
}
