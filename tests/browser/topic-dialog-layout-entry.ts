import { TopicPreviewModal } from "../../src/ui/topic-preview-modal";
import { TopicCreateModal } from "../../src/ui/topic-create-modal";
import { TopicsPanel } from "../../src/ui/topics-panel";
import type { TopicCandidates } from "../../src/topics/topic-candidates";
import type { TopicChangePreview } from "../../src/topics/topic-integration";

const candidates: TopicCandidates = {
  project: Array.from({ length: 12 }, (_, index) => ({
    tier: "project" as const, path: `QnALog/Notes/${index}.md`, title: `Long candidate title ${index}`, date: "2026-10-11",
    overview: "# **底层数据结构的优化**\n> - __说话人__：昨晚睡前 `回顾` [[Notes/source.md|结构优化]] [文档](https://example.test)",
    matchedTags: ["项目/Q&ALog", "项目/QnALog"], matchedTerms: [], reasons: ["Shared project identifier tag"],
    reasonDetails: [{ kind: "project-tags" as const, labels: ["项目/Q&ALog", "项目/QnALog"], similar: true }],
    alreadyInTopics: [], missingOverview: false, score: 1, defaultSelected: true, cancellable: index !== 0,
  })),
  topic: [], content: [], byTag: [], byContent: [],
};

const port = {
  text: (key: string) => key,
  isConfigured: () => true,
  getVersion: () => "fixture",
  getCandidates: async () => candidates,
  listTopics: async () => [{ path: "QnALog/主题/Topic.md", page: { id: "fixture-topic", title: "Project topic", tags: [], members: [], memberLinks: [], excluded: [], basis: "overview" as const, created: "2026-10-01", updated: "2026-10-11", body: "" } }],
  countPending: async () => 0,
  estimate: async () => ({ chars: 400, requests: 1 }),
  preview: async () => preview,
  apply: async () => ({ path: "QnALog/主题/Topic.md", markdown: "", pageChangedDuringGeneration: false }),
  cancel: () => undefined,
  openTopic: async () => undefined,
  openSource: async () => undefined,
  undoLastUpdate: async () => ({ restored: true as const }),
};

const longText = "A long claim about the underlying data structures and how the project preserves every user edit while combining notes. ".repeat(3);
const preview: TopicChangePreview = {
  topicId: "fixture-topic", expectedHash: "fixture-hash", pageWasManuallyEdited: false,
  completedBatches: 1, totalBatches: 1,
  items: [{ id: "long-item", type: "add_conflict", operation: { type: "add_conflict", text: longText, sourceId: "source-id" }, target: "conflict", text: `${longText}（未核实）`, sourceId: "source-id", cancellable: true }],
  sourceLinks: { "source-id": `[[${"QnALog/转写纪要/2026-09-29 2149 · ".repeat(2)}综合纪要-问答日志-数据结构优化.md|问答日志-数据结构优化]]` },
  sourceDates: { "source-id": "2026-09-29" },
};

window.renderTopicCreate = async () => {
  new TopicCreateModal({} as never, port as never, "QnALog/Notes/0.md").open();
  await new Promise((resolve) => window.setTimeout(resolve, 20));
};
window.renderTopicPreview = () => new TopicPreviewModal({} as never, port as never, preview, () => undefined).open();
window.renderTopicsPanel = async () => {
  const root = document.createElement("div");
  root.id = "topics-panel-root";
  document.body.append(root);
  await new TopicsPanel({} as never, port as never, () => undefined).render(root);
};
