import { TopicPreviewModal } from "../../src/ui/topic-preview-modal";
import { TopicCreateModal } from "../../src/ui/topic-create-modal";
import { TopicScanModal, TopicsPanel } from "../../src/ui/topics-panel";
import { syncActiveRow } from "../../src/ui/row-active";
import { qnalogConfirm } from "../../src/ui/helpers";

(window as unknown as { syncActiveRow: typeof syncActiveRow }).syncActiveRow = syncActiveRow;
import type { TopicCandidates } from "../../src/topics/topic-candidates";
import type { TopicChangePreview } from "../../src/topics/topic-integration";

const candidates: TopicCandidates = {
  project: Array.from({ length: 60 }, (_, index) => ({
    tier: "project" as const, path: `QnALog/Notes/${index}.md`, title: `Long candidate title ${index} ${"Unbrokenwordsegment".repeat(6)}`, date: "2026-10-11",
    overview: "# **底层数据结构的优化**\n> - __说话人__：昨晚睡前 `回顾` [[Notes/source.md|结构优化]] [文档](https://example.test)" + " 展开以查看完整概要".repeat(8),
    matchedTags: ["项目/Q&ALog", "项目/QnALog"], matchedTerms: [], reasons: ["Shared project identifier tag"],
    reasonDetails: [{ kind: "project-tags" as const, labels: ["项目/Q&ALog", "项目/QnALog"], similar: true }],
    alreadyInTopics: [], missingOverview: false, score: 1, defaultSelected: true, cancellable: index !== 0,
  })),
  topic: [], content: [], byTag: [], byContent: [],
};
const scanCandidates: TopicCandidates = {
  project: candidates.project.slice(0, 5).map((candidate, index) => ({
    ...candidate,
    title: `Scan candidate ${index + 1}`,
    matchedTags: ["项目/Q&ALog", "项目/VeryLongProjectTagLabelForLayout"],
    reasonDetails: [{ kind: "project-tags", labels: ["项目/Q&ALog", "项目/VeryLongProjectTagLabelForLayout"], similar: true }],
  })),
  topic: [], content: [], byTag: [], byContent: [],
};

type PendingPreview = { resolve(): void; reject(error: Error): void; onProgress?: (progress: { completed: number; total: number }) => void };
let pendingPreview: PendingPreview | null = null;
(window as unknown as { topicPreviewDriver: unknown }).topicPreviewDriver = {
  pending: () => pendingPreview !== null,
  progress: (completed: number, total: number) => pendingPreview?.onProgress?.({ completed, total }),
  finish: () => { const current = pendingPreview; pendingPreview = null; current?.resolve(); },
  fail: (message: string) => { const current = pendingPreview; pendingPreview = null; current?.reject(new Error(message)); },
};

// Every port.cancel call is recorded so the check can assert which close paths cancel a preview.
const cancelledTopics: string[] = [];
(window as unknown as { cancelledTopics: string[] }).cancelledTopics = cancelledTopics;

const port = {
  text: (key: string) => key === "QnALog · Topics" ? "QnALog · Topics" : key,
  isConfigured: () => true,
  getVersion: () => "fixture",
  getCandidates: async () => candidates,
  scanUnintegrated: async () => scanCandidates,
  listTopics: async () => Array.from({ length: 8 }, (_, index) => ({ path: `QnALog/主题/Topic-${index}.md`, page: { id: `fixture-topic-${index}`, title: `Project topic ${index}`, tags: [], members: [], memberLinks: [], excluded: [], basis: "overview" as const, created: "2026-10-01", updated: "2026-10-11", body: "" } })),
  countPending: async () => 0,
  estimate: async () => ({ chars: 400, requests: 1 }),
  // Stays pending until the check drives it, so progress, cancel, failure and retry can be exercised.
  preview: (input: { onProgress?: (progress: { completed: number; total: number }) => void; signal?: AbortSignal }) => new Promise<TopicChangePreview>((resolve, reject) => {
    pendingPreview = { resolve: () => resolve(preview), reject: (error) => reject(error), onProgress: input.onProgress };
    input.signal?.addEventListener("abort", () => { pendingPreview = null; reject(new DOMException("aborted", "AbortError")); }, { once: true });
  }),
  apply: async () => ({ path: "QnALog/主题/Topic.md", markdown: "", pageChangedDuringGeneration: false }),
  cancel: (id: string) => { cancelledTopics.push(id); },
  openTopic: async () => undefined,
  openSource: async () => undefined,
  undoLastUpdate: async () => ({ restored: true as const }),
};

const longText = "A long claim about the underlying data structures and how the project preserves every user edit while combining notes. ".repeat(3);
const unbrokenText = `https://example.test/${"a".repeat(160)}`;
const preview: TopicChangePreview = {
  topicId: "fixture-topic", expectedHash: "fixture-hash", pageWasManuallyEdited: false,
  completedBatches: 1, totalBatches: 1,
  items: [
    { id: "disagreement", type: "add_disagreement", operation: { type: "add_disagreement", subject: "Front Matter property naming strategy", positions: [
      { text: longText, sourceId: "source-id", sourceTitle: "问答日志-数据结构优化", date: "2026-09-29" },
      { text: "The existing page uses a different property name.", sourceId: "source-id", sourceTitle: "A very long source title whose label must wrap without covering the date", date: "2026-09-30", fromPage: true, provenance: "unverified" },
    ], sourceId: "source-id" }, target: "add_disagreement", text: "", sourceId: "source-id", cancellable: true },
    { id: "resolved-item", type: "resolve_open", operation: { type: "resolve_open", blockId: "tpc-a1b2c3", note: "The issue was resolved.", expectedText: "The issue remains open.", sourceId: "source-id" }, target: "resolve_open", text: "The issue was resolved.", expectedText: "The issue remains open.", sourceId: "source-id", cancellable: true },
    { id: "revision-item", type: "revise_block", operation: { type: "revise_block", blockId: "tpc-a1b2c3", newText: "A revised progress summary.", expectedText: "An old progress summary.", reason: "new evidence", sourceId: "source-id" }, target: "tpc-a1b2c3", text: "A revised progress summary.", expectedText: "An old progress summary.", sourceId: "source-id", cancellable: true },
    { id: "long-item", type: "add_item", operation: { type: "add_item", section: "进展脉络", text: `${longText} ${unbrokenText}`, sourceId: "source-id" }, target: "Progress thread", text: `${longText} ${unbrokenText}（未核实）`, sourceId: "source-id", cancellable: true },
    { id: "second-item", type: "add_timeline", operation: { type: "add_timeline", date: "2026-10-10", text: "A second timeline entry.", sourceId: "source-id" }, target: "add_timeline", text: "A second timeline entry.", sourceId: "source-id", cancellable: true },
  ],
  sourceLinks: { "source-id": `[[${"QnALog/转写纪要/2026-09-29 2149 · ".repeat(2)}综合纪要-问答日志-数据结构优化.md|问答日志-数据结构优化]]` },
  sourceDates: { "source-id": "2026-09-29" },
};

window.renderTopicCreate = async () => {
  new TopicCreateModal({} as never, port as never, "QnALog/Notes/0.md").open();
  await new Promise((resolve) => window.setTimeout(resolve, 20));
};
window.renderTopicPreview = () => new TopicPreviewModal({} as never, port as never, preview, () => undefined).open();
window.renderTopicScan = async () => {
  new TopicScanModal({} as never, port as never, "fixture-topic", () => undefined).open();
  await new Promise((resolve) => window.setTimeout(resolve, 20));
};
window.renderTopicsPanel = async () => {
  const root = document.createElement("div");
  root.id = "topics-panel-root";
  document.body.append(root);
  await new TopicsPanel({} as never, port as never, () => undefined).render(root);
};
window.renderTopicConfirm = (kind) => {
  const title = kind === "Generic confirmation" ? "Clear queue" : kind;
  const cta = kind === "Delete topic" ? "Delete" : kind === "Merge topics" ? "Merge" : "Clear";
  void qnalogConfirm({} as never, title, "Confirm this action?", cta, kind === "Generic confirmation" ? undefined : "QnALog · Topics");
};
