import { Notice, type App } from "obsidian";
import type { TopicsUiPort } from "./topics-ui-port";
import { TopicCreateModal } from "./topic-create-modal";
import { TopicPreviewModal } from "./topic-preview-modal";

export function openCreateTopic(app: App, port: TopicsUiPort, path: string, onApplied: () => void): void {
  new TopicCreateModal(app, port, path, onApplied).open();
}

export async function openTopicJoin(app: App, port: TopicsUiPort, path: string, topicId: string, onApplied: () => void): Promise<void> {
  try {
    const preview = await port.preview({ startPath: path, memberPaths: [path], basis: "overview", topicId });
    new TopicPreviewModal(app, port, preview, () => onApplied()).open();
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error), 8000);
  }
}
