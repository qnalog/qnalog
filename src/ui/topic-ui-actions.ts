import type { TopicsUiPort } from "./topics-ui-port";
import type { TopicChangePreview } from "../topics/topic-integration";
import { TopicCreateModal } from "./topic-create-modal";
import { TopicPreviewModal } from "./topic-preview-modal";
import { runTopicPreviewRequest as runTopicPreviewRequestInternal } from "./topic-preview-runner";
import type { App } from "obsidian";

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
  onApplied: (path: string) => void,
): Promise<void> {
  return runTopicPreviewRequestInternal(app, port, request, (preview) => new TopicPreviewModal(app, port, preview, onApplied).open());
}
