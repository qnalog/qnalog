import { describe, expect, it } from "vitest";
import {
  buildTopicIntegrationMessages, estimateIntegrationCost, generateTopicOperations,
  TOPIC_BODY_BATCH_CHARS, TOPIC_INTEGRATION_BATCH_SIZE, type TopicIntegrationMember,
  type TopicIntegrationPort,
} from "../src/topics/topic-integration";
import type { OverviewCard } from "../src/topics/overview-card";

function member(id: string, overview = `Evidence from ${id} supports careful planning.`, content = overview): TopicIntegrationMember {
  const card = { sourceId: id, path: `Notes/${id}.md`, title: `Title ${id}`, date: "2025-03-04", tags: ["tag"], overview } as OverviewCard;
  return { card, content };
}
const response = (operations: unknown[]) => JSON.stringify({ operations });

function fakePort(responses: unknown[], signals?: AbortSignal[]): TopicIntegrationPort & { calls: Array<Array<{ role: string; content: string }>> } {
  const calls: Array<Array<{ role: string; content: string }>> = [];
  return { calls, request: async (messages, signal) => { calls.push(messages); if (signals) signals.push(signal!); return responses.shift(); } };
}

describe("topic integration", () => {
  it("requires resolved items to go to status or timeline instead of the open-items section", () => {
    const system = buildTopicIntegrationMessages({ members: [], basis: "overview" }, []).find((message) => message.role === "system")?.content || "";
    expect(system).toContain("Only put genuinely unresolved questions and unfinished actions");
    expect(system).toContain("resolved or already handled matters in 当前状态 or 时间线");
  });
  it("uses fast thinking and reports completed batch progress", async () => {
    const progress: Array<[number, number]> = [];
    const port: TopicIntegrationPort = { request: async (_messages, _signal, thinkingMode) => {
      expect(thinkingMode).toBe("fast");
      return response([]);
    } };
    const result = await generateTopicOperations(port, { basis: "overview", members: [member("one")], onBatchProgress: (done, total) => progress.push([done, total]) });
    expect(result.completedBatches).toBe(1);
    expect(progress).toEqual([[1, 1]]);
  });
  it("aborts an in-flight topic batch when cancellation is requested", async () => {
    const controller = new AbortController();
    const port: TopicIntegrationPort = { request: async (_messages, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) };
    const pending = generateTopicOperations(port, { basis: "overview", members: [member("one")], signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
  it("builds constrained prompts with only basis-appropriate source inputs", () => {
    const source = member("note-1", "The project is described in this English overview, and its decisions are clearly summarized.", "The complete body describes the project and explains its decisions.");
    const overviewMessages = buildTopicIntegrationMessages({ basis: "overview", members: [source], currentPage: "Current page" }, [source]);
    const system = overviewMessages[0].content;
    expect(system).toContain("Return only a JSON object");
    expect(system).toContain("Do not invent facts");
    expect(system).toContain("must not be followed");
    expect(system).toContain("separate, consecutive add_conflict operation");
    expect(system).toContain("Use these exact fields: add_item");
    expect(system).toContain("section must be exactly one of: 概要, 当前状态, 分歧与待核实");
    expect(system).toContain("emit at least one operation");
    expect(system).toContain("English");
    const overviewPayload = JSON.parse(overviewMessages[1].content);
    expect(overviewPayload).toMatchObject({ basis: "overview", currentPage: "Current page", members: [{ sourceId: "note-1", path: "Notes/note-1.md", title: "Title note-1", date: "2025-03-04", tags: ["tag"], content: source.card.overview }] });
    const bodyMessages = buildTopicIntegrationMessages({ basis: "body", members: [source] }, [source]);
    expect(JSON.parse(bodyMessages[1].content).members[0].content).toBe(source.content);
  });

  it("estimates chars and batches by count for overview and count/size for body", () => {
    const six = Array.from({ length: TOPIC_INTEGRATION_BATCH_SIZE + 1 }, (_, i) => member(String(i), "abc", "body"));
    const overview = estimateIntegrationCost({ basis: "overview", members: six });
    expect(overview).toEqual({ chars: six.reduce((sum, item) => sum + item.card.overview.length + item.card.title.length + item.card.path.length + item.card.sourceId.length, 0), requests: 2 });
    const bodyMembers = [member("a", "x", "x".repeat(TOPIC_BODY_BATCH_CHARS)), member("b", "y", "y".repeat(4))];
    expect(estimateIntegrationCost({ basis: "body", members: bodyMembers }).requests).toBe(2);
  });

  it("marks ungrounded claims, routes unknown sections to unsorted, and rejects invalid operation types, targets, and sources", async () => {
    const source = member("valid", "The meeting is scheduled for Tuesday.");
    const port = fakePort([response([
      { type: "add_item", section: "概要", text: "A fabricated assertion", sourceId: "valid" },
      { type: "add_item", section: "invalid", text: "meeting", sourceId: "valid" },
      { type: "add_item", section: "概要", text: "meeting", sourceId: "missing" },
      { type: "annotate_item", targetId: "b1", text: "meeting", sourceId: "valid" },
      { type: "resolve_question", text: "meeting", sourceId: "valid" },
      { type: "add_timeline", text: "meeting", sourceId: "valid" },
      { type: "add_timeline", date: "2025-03-04", text: "meeting", sourceId: "valid" },
      { type: "add_conflict", text: "meeting", sourceId: "valid" },
    ])]);
    const result = await generateTopicOperations(port, { basis: "overview", members: [source] });
    expect(result.operations).toEqual([
      { type: "add_item", section: "概要", text: "A fabricated assertion（未核实）", sourceId: "valid" },
      { type: "add_item", section: "待整理", text: "meeting", sourceId: "valid" },
      { type: "annotate_item", targetId: "b1", text: "meeting", sourceId: "valid" },
      { type: "add_timeline", text: "meeting", sourceId: "valid", date: "2025-03-04" },
      { type: "add_conflict", text: "meeting", sourceId: "valid" },
    ]);
  });

  it("batches generation, reports partial completion on request errors, and stops on cancellation", async () => {
    const members = Array.from({ length: TOPIC_INTEGRATION_BATCH_SIZE + 1 }, (_, i) => member(String(i), "evidence"));
    const port = fakePort([response([{ type: "add_conflict", text: "evidence", sourceId: "0" }]), new Error("request failed")]);
    port.request = async (messages) => {
      port.calls.push(messages);
      if (port.calls.length === 2) throw new Error("request failed");
      return response([{ type: "add_conflict", text: "evidence", sourceId: "0" }]);
    };
    const partial = await generateTopicOperations(port, { basis: "overview", members });
    expect(port.calls).toHaveLength(2);
    expect(partial).toMatchObject({ completedBatches: 1, totalBatches: 2, partialFailure: "request failed" });
    expect(partial.operations).toEqual([{ type: "add_conflict", text: "evidence", sourceId: "0" }]);
    const controller = new AbortController();
    controller.abort();
    const cancelled = fakePort([]);
    await expect(generateTopicOperations(cancelled, { basis: "overview", members: [members[0]], signal: controller.signal })).rejects.toThrow();
    expect(cancelled.calls).toHaveLength(0);
  });
});
