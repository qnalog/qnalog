import type { TopicPrompt } from "./topics-service";

/** Session-only topic prompts keyed by the exact note/topic pair. */
export class TopicPromptStore {
  private readonly byPath = new Map<string, TopicPrompt[]>();

  get(path: string): TopicPrompt[] { return [...(this.byPath.get(path) || [])]; }

  set(path: string, prompts: readonly TopicPrompt[]): void {
    this.byPath.set(path, [...prompts]);
  }

  remove(path: string, topicId: string): void {
    const remaining = (this.byPath.get(path) || []).filter((prompt) => prompt.topicId !== topicId);
    if (remaining.length) this.byPath.set(path, remaining);
    else this.byPath.delete(path);
  }

  clearPath(path: string): void { this.byPath.delete(path); }
}
