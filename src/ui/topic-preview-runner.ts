import { Notice, type App } from "obsidian";
import type { TopicChangePreview } from "../topics/topic-integration";
import type { TopicsUiPort } from "./topics-ui-port";
import { TopicGeneratingModal } from "./topic-generating-modal";

export async function runTopicPreviewRequest(
  app: App,
  port: TopicsUiPort,
  request: () => Promise<TopicChangePreview>,
  presentPreview: (preview: TopicChangePreview) => void,
): Promise<void> {
  const waiting = new TopicGeneratingModal(app, port);
  waiting.open();
  try {
    const preview = await request();
    if (waiting.isCancelled) return;
    waiting.close();
    presentPreview(preview);
  } catch (error) {
    if (waiting.isCancelled) return;
    waiting.close();
    new Notice(error instanceof Error ? error.message : String(error), 8000);
  }
}
