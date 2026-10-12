import { Notice, type App } from "obsidian";
import type { TopicChangePreview } from "../topics/topic-integration";
import type { TopicsUiPort } from "./topics-ui-port";
import { TopicCreateModal } from "./topic-create-modal";
import { TopicPreviewModal } from "./topic-preview-modal";
import { TopicGeneratingModal } from "./topic-generating-modal";

export function openCreateTopic(app: App, port: TopicsUiPort, path: string, onApplied: () => void): void {
  new TopicCreateModal(app, port, path, onApplied).open();
}

export async function openTopicJoin(app: App, port: TopicsUiPort, path: string, topicId: string, onApplied: () => void): Promise<void> {
  return runTopicPreviewRequest(app, port, () => port.preview({ startPath: path, memberPaths: [path], basis: "overview", topicId }), onApplied);
}

export async function runTopicPreviewRequest(
  app: App,
  port: TopicsUiPort,
  request: () => Promise<TopicChangePreview>,
  onApplied: () => void,
): Promise<void> {
  const waiting = new TopicGeneratingModal(app, port);
  waiting.open();
  try {
    const preview = await request();
    if (waiting.isCancelled) return;
    waiting.close();
    new TopicPreviewModal(app, port, preview, () => onApplied()).open();
  } catch (error) {
    if (waiting.isCancelled) return;
    waiting.close();
    new Notice(error instanceof Error ? error.message : String(error), 8000);
  }
}
