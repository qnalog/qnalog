import type { OverviewCardCachePort } from "./overview-card-cache";
import { OverviewCardCache } from "./overview-card-cache";
import { suggestTopics, type TopicSuggestion } from "./topic-suggestions";

export interface TopicsServiceHost { overviewCards: OverviewCardCachePort }
export type TopicsServicePort = OverviewCardCachePort;
export interface TopicsSuggestionsOptions { windowDays?: number; limit?: number }
export interface TopicsSuggestionsResult {
  suggestions: TopicSuggestion[];
  stats: { noteCount: number; windowedCount: number; overviewMissing: number; readCount: number; elapsedMs: number };
}

export class TopicsService {
  private readonly cache: OverviewCardCache;
  private lastSignature = "";
  private lastSuggestions: TopicSuggestion[] = [];
  constructor(host: TopicsServiceHost, roots: string[]) {
    this.cache = new OverviewCardCache(host.overviewCards, roots);
  }
  async getSuggestions(options: TopicsSuggestionsOptions = {}): Promise<TopicsSuggestionsResult> {
    const start = Date.now();
    this.cache.resetReadCount();
    const refreshed = await this.cache.refresh(options);
    const cards = this.cache.getCards(options);
    const signature = JSON.stringify([options.windowDays ?? null, options.limit ?? null, cards]);
    if (signature !== this.lastSignature) {
      this.lastSuggestions = suggestTopics(cards, new Map(), { limit: options.limit });
      this.lastSignature = signature;
    }
    return { suggestions: this.lastSuggestions, stats: {
      noteCount: this.cache.getNoteCount(), windowedCount: cards.length,
      overviewMissing: cards.filter((card) => card.overviewSource === "none").length,
      readCount: refreshed.readCount, elapsedMs: Date.now() - start,
    } };
  }
}
