import { describe, expect, it } from "vitest";
import {
  buildTopicIntegrationMessages, estimateIntegrationCost, generateTopicOperations,
  generateTopicPageContent, generateTopicPageUpdateOperations,
  TOPIC_BODY_BATCH_CHARS, TOPIC_INTEGRATION_BATCH_SIZE, type TopicIntegrationMember,
  type TopicIntegrationPort,
} from "../src/topics/topic-integration";
import type { OverviewCard } from "../src/topics/overview-card";
import { applyTopicOps, parseTopicPageBlocks, renderTopicPage } from "../src/topics/topic-page";

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
  it("generates a structured model and limits references to supplied source IDs", async () => {
    const source = member("valid", "The project will ship in October.");
    const port = fakePort([JSON.stringify({
      overview: "The project is preparing for launch. The release is planned for October.", status: "active",
      threads: [{ title: "Release", summary: "The team has set a release window.", points: [{ text: "Release is planned for October.", sources: ["valid", "outside"] }] }],
      disagreements: [], open: [], unsorted: [],
    })]);
    const result = await generateTopicPageContent(port, { basis: "overview", members: [source] });
    expect(result.model.overview).toContain("preparing for launch");
    expect(result.model.threads[0].points[0].sources).toEqual(["valid"]);
    expect(port.calls[0][0].content).toContain("2-5 sentences");
    expect(port.calls[0][0].content).toContain("status (exactly one of active, done, paused, unknown)");
    expect(port.calls[0][0].content).toContain("kind exactly question, action, or bug");
    expect(port.calls[0][1].content).toContain("valid");
  });

  it("normalizes unknown status and open-item kinds and records the fallback", async () => {
    const source = member("valid", "The team is considering a new migration step.");
    const createPort = fakePort([JSON.stringify({
      overview: "The project is active.", status: "in progress", threads: [], disagreements: [],
      open: [{ kind: "task", text: "Review the migration.", sources: ["valid"] }], unsorted: [],
    })]);
    const created = await generateTopicPageContent(createPort, { basis: "overview", members: [source] });
    expect(created.model.status).toBe("unknown");
    expect(created.model.open[0].kind).toBe("action");
    expect(created.validationWarnings).toEqual([
      "Unknown topic status was mapped to unknown.",
      "Unknown topic open-item kind was mapped to action.",
    ]);

    const currentPage = renderTopicPage({ overview: "The topic covers migration.", status: "active", threads: [], disagreements: [], open: [], unsorted: [] }, []);
    const updatePort = fakePort([response([{ type: "add_open", kind: "task", text: "Review migration.", sources: ["valid"] }])]);
    const updated = await generateTopicPageUpdateOperations(updatePort, { basis: "overview", members: [source], currentPage });
    expect(updated.operations).toMatchObject([{ type: "add_open", kind: "action" }]);
    expect(updated.validationWarnings).toEqual(["Unknown topic open-item kind was mapped to action."]);
    expect(updatePort.calls[0][0].content).toContain("kind must be exactly question, action, or bug");
  });

  it("merges multi-batch body fragments without sending source bodies to the merge request", async () => {
    const members = Array.from({ length: TOPIC_INTEGRATION_BATCH_SIZE + 1 }, (_, index) => member(String(index), "brief", "PRIVATE BODY " + index));
    const model = { overview: "The project is progressing.", status: "active", threads: [], disagreements: [], open: [], unsorted: [] };
    const port = fakePort([JSON.stringify(model), JSON.stringify(model), JSON.stringify(model)]);
    const result = await generateTopicPageContent(port, { basis: "body", members });
    expect(result).toMatchObject({ completedBatches: 3, totalBatches: 3 });
    expect(port.calls).toHaveLength(3);
    expect(port.calls[0][1].content).toContain("PRIVATE BODY 0");
    expect(port.calls[2][0].content).toContain("structured evidence fragments");
    expect(port.calls[2][1].content).not.toContain("PRIVATE BODY 0");
    expect(port.calls[2][1].content).toContain("The project is progressing.");
  });

  it("revises overview blocks and degrades unsupported target blocks into a progress point", async () => {
    const source = member("valid", "New evidence changes the release date to October.");
    const markdown = renderTopicPage({ overview: "The release date is September.", status: "active", threads: [{ id: "release", title: "Release", summary: "The team planned a September release.", points: [{ id: "p", text: "The test is incomplete.", sources: ["valid"] }] }], disagreements: [], open: [], unsorted: [] }, [{ path: source.card.path, title: source.card.title, sourceId: source.card.sourceId, date: source.card.date }]);
    const blocks = parseTopicPageBlocks(markdown);
    const overview = blocks.find((block) => block.type === "overview")!;
    const point = blocks.find((block) => block.type === "point")!;
    const port = fakePort([response([
      { type: "revise_block", blockId: overview.id, newText: "The release date is October.", reason: "new evidence", sourceId: "valid" },
      { type: "revise_block", blockId: point.id, newText: "Changed point", reason: "not allowed", sourceId: "valid" },
    ])]);
    const result = await generateTopicPageUpdateOperations(port, { basis: "overview", members: [source], currentPage: markdown });
    expect(port.calls[0][1].content).toContain("The release date is September.");
    expect(result.operations).toHaveLength(2);
    expect(result.operations[0]).toMatchObject({ type: "revise_block", blockId: overview.id, expectedText: overview.text });
    expect(result.operations[1]).toMatchObject({ type: "add_point", text: "Changed point" });
    expect(result.degraded).toBe(1);
  });

  it("accepts revisions, disagreements, new actions, and resolved items from a focused update", async () => {
    const source = member("new-evidence", "The chosen setting key is now language-dependent. Add a mobile reload check. The old settings migration issue is resolved.", "The chosen setting key is now language-dependent. Add a mobile reload check. The old settings migration issue is resolved.");
    const existingModel = {
      overview: "The setting key remains fixed across interface languages.", status: "active" as const, threads: [], disagreements: [],
      open: [{ id: "migration", kind: "action" as const, text: "Preserve service settings during migration.", sources: ["new-evidence"], done: false }], unsorted: [],
    };
    const currentPage = renderTopicPage(existingModel, []);
    const overview = parseTopicPageBlocks(currentPage).find((block) => block.type === "overview")!;
    const open = parseTopicPageBlocks(currentPage).find((block) => block.type === "open")!;
    const port = fakePort([response([
      { type: "revise_block", blockId: overview.id, newText: "The chosen setting key is language-dependent.", reason: "The new note changes the current decision.", sourceId: "new-evidence" },
      { type: "add_disagreement", subject: "How the setting key is chosen", positions: [
        { text: "The key remains fixed across interface languages.", sourceId: "new-evidence", date: "2026-10-01" },
        { text: "The key changes with the Obsidian language.", sourceId: "new-evidence", date: "2026-10-11" },
      ] },
      { type: "add_open", kind: "action", text: "Verify topic-page reload on mobile.", sources: ["new-evidence"] },
      { type: "resolve_open", blockId: open.id, note: "Settings migration preserved the existing service values.", sourceId: "new-evidence" },
    ])]);
    const result = await generateTopicPageUpdateOperations(port, { basis: "body", members: [source], currentPage });
    expect(result.operations.map((operation) => operation.type)).toEqual(["revise_block", "add_disagreement", "add_open", "resolve_open"]);
    expect(result.operations[0]).toMatchObject({ blockId: overview.id, expectedText: overview.text });
    expect(result.operations[3]).toMatchObject({ blockId: open.id, expectedText: open.text });
    expect(port.calls[0][0].content).toContain("For a contradiction, output add_disagreement first");
    expect(port.calls[0][0].content).toContain("For a new unfinished task, output add_open");
    expect(port.calls[0][0].content).toContain("For an explicitly resolved item, use resolve_open when known");
    expect(port.calls[0][0].content).toContain("positions:[{text,sourceId,date?},{text,sourceId,date?}]");
    expect(port.calls[0][1].content).toContain(source.content);
  });

  it("rechecks an empty model response once and keeps valid operations from the retry", async () => {
    const source = member("retry-source", "Add a mobile reload check.");
    const currentPage = renderTopicPage({ overview: "The topic covers the plugin.", status: "active", threads: [], disagreements: [], open: [], unsorted: [] }, []);
    const port = fakePort([response([]), response([
      { type: "add_open", kind: "action", text: "Verify mobile topic-page reload.", sources: ["retry-source"] },
    ])]);
    const result = await generateTopicPageUpdateOperations(port, { basis: "overview", members: [source], currentPage });
    expect(port.calls).toHaveLength(2);
    expect(port.calls[1][0].content).toContain("Your previous response contained no applicable operation");
    expect(result.operations).toMatchObject([{ type: "add_open", text: "Verify mobile topic-page reload." }]);
    expect(result).toMatchObject({ completedBatches: 1, totalBatches: 1 });
  });

  it("explains an empty update response after its single retry", async () => {
    const source = member("empty", "Only repeated project context.");
    const port = fakePort([response([]), response([])]);
    const result = await generateTopicPageUpdateOperations(port, { basis: "overview", members: [source], currentPage: "existing page" });
    expect(result.operations).toEqual([]);
    expect(result.updateDiagnostics).toMatchObject({ requests: 2, rawOperations: 0, acceptedOperations: 0, retried: true, jsonParsable: [true, true] });
  });

  it("degrades a missing block ID into a point and counts the adjustment", async () => {
    const source = member("new-source", "A new project stage is starting.");
    const port = fakePort([response([{ type: "revise_block", blockId: "missing", newText: "The project entered a new stage.", reason: "new evidence", sourceId: "new-source" }])]);
    const result = await generateTopicPageUpdateOperations(port, { basis: "overview", members: [source], currentPage: "existing page" });
    expect(result.operations).toMatchObject([{ type: "add_point", text: "The project entered a new stage.", sources: ["new-source"] }]);
    expect(result.degraded).toBe(1);
    expect(result.updateDiagnostics?.discarded).toMatchObject({ "block-id-not-found": 1 });
  });

  it("replaces an out-of-batch source ID with the supplied member source", async () => {
    const source = member("new-source", "Verify the reading view.");
    const port = fakePort([response([{ type: "add_open", kind: "action", text: "Verify the reading view.", sources: ["not-a-member"] }])]);
    const result = await generateTopicPageUpdateOperations(port, { basis: "overview", members: [source], currentPage: "existing page" });
    expect(result.operations).toMatchObject([{ type: "add_open", sources: ["new-source"], sourceId: "new-source" }]);
    expect(result.degraded).toBe(1);
    expect(result.updateDiagnostics?.discarded).toMatchObject({ "source-not-member": 1 });
  });

  it("requires resolved items to go to status or timeline instead of the open-items section", () => {
    const system = buildTopicIntegrationMessages({ members: [], basis: "overview" }, []).find((message) => message.role === "system")?.content || "";
    expect(system).toContain("A question belongs in 未决问题与未完成行动 only while no answer is confirmed");
    expect(system).toContain("An action belongs there only while its completion remains open");
    expect(system).toContain("resolved or already handled matters in 当前状态 or 时间线");
  });
  it("includes bilingual examples and does not require an existing block ID", async () => {
    const source = member("new-source", "New useful project evidence.");
    const port = fakePort([response([]), response([])]);
    await generateTopicPageUpdateOperations(port, { basis: "overview", members: [source], currentPage: "page" });
    const prompt = port.calls[0][0].content;
    expect(prompt).toContain("Chinese examples");
    expect(prompt).toContain("English examples");
    expect(prompt.match(/add_disagreement/g)?.length).toBeGreaterThan(0);
    expect(prompt.match(/add_open/g)?.length).toBeGreaterThan(0);
    expect(prompt.match(/add_point/g)?.length).toBeGreaterThan(0);
    expect(prompt).toContain("Existing block IDs are optional");
    expect(prompt).toContain("Distinguish same/redundant from supplement and conflict");
    expect(prompt).toContain("assessments:[{memberId,claim,relation,relatedBlockId?}]");
    expect(prompt).toContain("A conflict assessment must have a corresponding add_disagreement");
    expect(prompt).toContain("Same setting, opposite decision");
  });
  it("retries a conflict assessment missing add_disagreement, then synthesizes the disagreement", async () => {
    const source = member("new-source", "属性名最终仍按界面语言切换。", "属性名最终仍按界面语言切换。");
    const page = renderTopicPage({ overview: "属性名应保持稳定。", status: "active", threads: [], disagreements: [], open: [], unsorted: [] }, []);
    const overview = parseTopicPageBlocks(page).find((block) => block.type === "overview")!;
    const payload = { assessments: [{ memberId: "new-source", claim: "属性名最终仍按界面语言切换。", relation: "conflict", relatedBlockId: overview.id }], operations: [] };
    const port = fakePort([JSON.stringify(payload), JSON.stringify(payload)]);
    const result = await generateTopicPageUpdateOperations(port, { basis: "overview", members: [source], currentPage: page });
    expect(port.calls).toHaveLength(2);
    expect(port.calls[1][0].content).toContain("marked these claims as conflict but omitted add_disagreement");
    expect(result.assessments).toEqual(payload.assessments);
    expect(result.operations).toMatchObject([{ type: "add_disagreement", positions: [{ text: overview.text }, { text: "属性名最终仍按界面语言切换。", sourceId: "new-source", date: "2025-03-04" }] }]);
    expect(result.programGeneratedOperationKeys).toHaveLength(1);
  });
  it("does not synthesize a disagreement when assessments contain no conflict", async () => {
    const source = member("new-source", "项目补充一条实现记录。");
    const port = fakePort([JSON.stringify({ assessments: [{ memberId: "new-source", claim: "项目补充一条实现记录。", relation: "supplement" }], operations: [{ type: "add_point", thread: "实现记录", text: "项目补充一条实现记录。", sources: ["new-source"] }] })]);
    const result = await generateTopicPageUpdateOperations(port, { basis: "overview", members: [source], currentPage: "page" });
    expect(result.operations.map(({ type }) => type)).toEqual(["add_point"]);
    expect(result.programGeneratedOperationKeys).toHaveLength(0);
  });
  it.each(["zh", "en"] as const)("renders update add_open in %s with localized type and punctuation before citation", (language) => {
    const memberSource = member("render-source", "Verify the reading view");
    const page = renderTopicPage({ overview: "The topic is current.", status: "active", threads: [], disagreements: [], open: [], unsorted: [] }, []);
    const english = language === "en";
    const inputPage = `---\nqnalog_topic_layout: 2\n---\n${english ? page.replace("## 进展脉络", "## Progress thread").replace("## 时间线", "## Timeline") : page}`;
    const result = applyTopicOps(inputPage, [{ type: "add_open", kind: "action", text: "Verify the reading view", sources: ["render-source"], sourceId: "render-source" }]);
    const line = result.markdown.split("\n").find((item) => item.startsWith("- [ ]")) || "";
    expect(line).toContain(english ? "Action: Verify the reading view.[^" : "行动：Verify the reading view.[^");
    expect(line).not.toMatch(/- \[ \] (?:action|task|bug|question)[:：]/);
    const modelLine = renderTopicPage({ overview: "The topic is current.", status: "active", threads: [], disagreements: [], open: [{ id: "render-source", kind: "action", text: "Verify the reading view", sources: ["render-source"], done: false }], unsorted: [] }, [{ path: memberSource.card.path, title: memberSource.card.title, sourceId: "render-source", date: memberSource.card.date }], english ? {
      overview: "Overview", status: "Status", progress: "Progress thread", disagreements: "Disagreements", open: "Open questions and actions", timeline: "Timeline", sources: "Source notes", inProgress: "In progress", updated: "Updated", notes: "notes", conflict: "Conflict", statusActive: "Active", statusDone: "Done", statusPaused: "Paused", statusUnknown: "Unknown", openQuestion: "Question", openAction: "Action", openBug: "Bug",
    } : {}).split("\n").find((item) => item.startsWith("- [ ]")) || "";
    expect(line.replace(/ \^tpc-[\da-f]{6}$/, "")).toBe(modelLine.replace(/ \^tpc-[\da-f]{6}$/, ""));
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
  it("reports the planned batch count once, before the first batch runs", async () => {
    const events: string[] = [];
    const port: TopicIntegrationPort = { request: async () => {
      events.push("request");
      return response([]);
    } };
    await generateTopicOperations(port, { basis: "overview", members: [member("one")], onPlanned: (total) => events.push(`planned:${total}`), onBatchProgress: (done, total) => events.push(`done:${done}/${total}`) });
    expect(events).toEqual(["planned:1", "request", "done:1/1"]);
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
