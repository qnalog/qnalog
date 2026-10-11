import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class FakeElement {
    children: FakeElement[] = [];
    text = "";
    cls = "";
    value = "";
    checked = false;
    disabled = false;
    classList = { toggle: () => undefined };
    listeners = new Map<string, (event?: { key?: string }) => void>();
    constructor(text = "", cls = "") { this.text = text; this.cls = cls; }
    empty() { this.children = []; }
    addClass(cls: string) { this.cls += ` ${cls}`; }
    createEl(_tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
      const element = this.add(new FakeElement(options.text || "", options.cls || ""));
      element.value = options.attr?.value || "";
      return element;
    }
    createDiv(options: { cls?: string; text?: string } = {}) { return this.add(new FakeElement(options.text || "", options.cls || "")); }
    createSpan(options: { cls?: string; text?: string } = {}) { return this.add(new FakeElement(options.text || "", options.cls || "")); }
    add(child: FakeElement) { this.children.push(child); return child; }
    addEventListener(name: string, callback: (event?: { key?: string }) => void) { this.listeners.set(name, callback); }
    setText(text: string) { this.text = text; }
    setAttribute() {}
    removeAttribute() {}
    setCssProps() {}
    remove() { this.text = ""; }
  }
  class Modal {
    contentEl = new FakeElement();
    app: unknown;
    constructor(app: unknown) { this.app = app; }
    open() { this.onOpen(); }
    close() { this.onClose(); }
    onOpen() {}
    onClose() {}
  }
  class Notice {}
  return { Modal, Notice };
});

import type { TopicCandidates } from "../src/topics/topic-candidates";
import { TopicCreateModal } from "../src/ui/topic-create-modal";
import { defaultTopicMemberPaths, getJoinableTopics, topicJoinMenuEntries, isTopicSourceEligible, suggestTopicTitle, topicCandidateGroups } from "../src/ui/topics-ui-port";
import { NS_TYPE_DERIVED, NS_TYPE_TOPIC } from "../src/shared/namespace";

function fixture(): TopicCandidates {
  const candidate = (path: string, tier: "project" | "topic" | "content", selected: boolean, cancellable: boolean) => ({
    path, title: path.split("/").pop() || path, date: "2026-10-10", overview: "**Overview** with __details__.", matchedTags: ["项目/QALog"],
    matchedTerms: [], reasons: ["Shared project identifier tag"], reasonDetails: [{ kind: "project-tags", labels: ["项目/QALog"], similar: false }], alreadyInTopics: ["existing-id"], missingOverview: false,
    score: 1, defaultSelected: selected, cancellable, tier,
  });
  return {
    project: [candidate("Notes/start.md", "project", true, false), candidate("Notes/project.md", "project", true, true)],
    topic: [candidate("Notes/topic.md", "topic", false, true)],
    content: [candidate("Notes/content.md", "content", false, true)],
    byTag: [], byContent: [],
  };
}

function allText(element: { text: string; children: Array<unknown> }): string {
  return `${element.text} ${element.children.map((child) => allText(child as typeof element)).join(" ")}`;
}

function descendants(element: { children: Array<unknown> }): Array<{ children: Array<unknown>; checked?: boolean; disabled?: boolean; value?: string; listeners?: Map<string, () => void> }> {
  return element.children.flatMap((child) => [child as ReturnType<typeof descendants>[number], ...descendants(child as typeof element)]);
}

describe("topic create dialog", () => {
  it("groups candidates and selects only the project tier by default, with a fixed start note", async () => {
    const candidates = fixture();
    expect(topicCandidateGroups(candidates).map((group) => [group.tier, group.items.length])).toEqual([["project", 2], ["topic", 1], ["content", 1]]);
    expect(defaultTopicMemberPaths(candidates)).toEqual(["Notes/start.md", "Notes/project.md"]);
    const port = {
      isConfigured: () => true, getVersion: () => "v1", text: (key: string) => key,
      getCandidates: vi.fn(async () => candidates), listTopics: vi.fn(async () => [{ path: "Topics/current.md", page: { id: "existing-id", title: "Existing project" } }]),
      estimate: vi.fn(async () => ({ chars: 420, requests: 1 })),
      preview: vi.fn(), apply: vi.fn(), cancel: vi.fn(), scanUnintegrated: vi.fn(), undoLastUpdate: vi.fn(), deleteTopic: vi.fn(), mergeTopics: vi.fn(),
      ignoreNote: vi.fn(), noteArrived: vi.fn(), refreshPrompt: vi.fn(), getPrompts: vi.fn(), removePrompt: vi.fn(), isSourceNote: vi.fn(), openTopic: vi.fn(), openSource: vi.fn(), countPending: vi.fn(),
    };
    const modal = new TopicCreateModal({} as never, port as never, "Notes/start.md");
    modal.open();
    await vi.waitFor(() => expect(port.getCandidates).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(allText(modal.contentEl as never)).toContain("Overview with details."));
    const renderedSummary = allText(modal.contentEl as never);
    expect(renderedSummary).toContain("Overview with details.");
    expect(renderedSummary).not.toContain("**");
    await vi.waitFor(() => expect(allText(modal.contentEl as never)).toContain("Already in topic “Existing project”"));
    const startCheckbox = descendants(modal.contentEl as never).find((item) => item.disabled === true && item.checked === true);
    expect(startCheckbox?.disabled).toBe(true);
  });

  it("derives a short title and sorts eligible topics for the context menu", () => {
    expect(suggestTopicTitle({ title: "2026-10-10 · 综合纪要-数据结构优化", matchedTags: ["项目/QALog"] } as never)).toBe("QALog");
    expect(suggestTopicTitle({ title: "2026-10-10-纪要-数据结构优化", matchedTags: [] } as never)).toBe("数据结构优化");
    const topics = Array.from({ length: 12 }, (_, index) => ({
      id: String(index), title: String(index), updated: new Date(2026, 0, index + 1).toISOString(), members: index === 11 ? ["note.md"] : [], excluded: index === 10 ? ["note.md"] : [],
    }));
    const result = getJoinableTopics(topics as never, "note.md");
    expect(result).toHaveLength(10);
    expect(result[0].id).toBe("9");
    expect(result.some(({ id }) => id === "10" || id === "11")).toBe(false);
    expect(topicJoinMenuEntries(topics, "note.md")).toMatchObject({ topics: result.slice(0, 8), more: true });
    expect(topicJoinMenuEntries([], "note.md")).toEqual({ topics: [], more: false });
  });

  it("keeps derived, merged, and topic pages out of the source-note entry", () => {
    const original = { type: "meeting", mergedInto: null, underMinutesRoot: true, hasMergeMarker: false };
    expect(isTopicSourceEligible(original)).toBe(true);
    expect(isTopicSourceEligible({ ...original, type: NS_TYPE_DERIVED })).toBe(false);
    expect(isTopicSourceEligible({ ...original, type: NS_TYPE_TOPIC })).toBe(false);
    expect(isTopicSourceEligible({ ...original, mergedInto: "[[Primary]]" })).toBe(false);
    expect(isTopicSourceEligible({ ...original, hasMergeMarker: true })).toBe(false);
    expect(isTopicSourceEligible({ ...original, underMinutesRoot: false })).toBe(false);
  });

  it("keeps empty candidate groups empty and returns no default selections", () => {
    const empty: TopicCandidates = { project: [], topic: [], content: [], byTag: [], byContent: [] };
    expect(topicCandidateGroups(empty).map(({ items }) => items)).toEqual([[], [], []]);
    expect(defaultTopicMemberPaths(empty)).toEqual([]);
  });

  it("shows body estimate and credit notice after selecting finalized body", async () => {
    const candidates = fixture();
    const port = {
      isConfigured: () => true, getVersion: () => "v1", text: (key: string) => key,
      getCandidates: vi.fn(async () => candidates), listTopics: vi.fn(async () => []), estimate: vi.fn(async () => ({ chars: 420, requests: 2 })),
      preview: vi.fn(), apply: vi.fn(), cancel: vi.fn(), scanUnintegrated: vi.fn(), undoLastUpdate: vi.fn(), deleteTopic: vi.fn(), mergeTopics: vi.fn(),
      ignoreNote: vi.fn(), noteArrived: vi.fn(), refreshPrompt: vi.fn(), getPrompts: vi.fn(), removePrompt: vi.fn(), isSourceNote: vi.fn(), openTopic: vi.fn(), openSource: vi.fn(), countPending: vi.fn(),
    };
    const modal = new TopicCreateModal({} as never, port as never, "Notes/start.md");
    modal.open();
    await vi.waitFor(() => expect(port.getCandidates).toHaveBeenCalledOnce());
    const radios = descendants(modal.contentEl as never).filter((item) => item.value);
    const bodyRadio = radios.find((item) => item.value === "body");
    expect(bodyRadio).toBeDefined();
    bodyRadio!.checked = true;
    bodyRadio!.listeners?.get("change")?.();
    await vi.waitFor(() => expect(port.estimate).toHaveBeenCalled());
    await vi.waitFor(() => expect(allText(modal.contentEl as never)).toContain("Estimated: 420 characters, 2 requests"));
    expect(allText(modal.contentEl as never)).toContain("may use more credits");
  });

  it.each([
    ["en", "The topic page could not be generated. You can retry. The page was not modified."],
    ["zh", "未能生成主题页。可以重试，页面未被修改。"],
  ])("shows a localized error and retry button in the %s interface", async (language, expected) => {
    vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => undefined });
    try {
    const sourceMessage = "The topic page could not be generated. You can retry. The page was not modified.";
    const translations: Record<string, string> = language === "zh" ? { [sourceMessage]: expected, Retry: "重试" } : {};
    const candidates = fixture();
    const port = {
      isConfigured: () => true, getVersion: () => "v1", text: (key: string) => translations[key] || key,
      getCandidates: vi.fn(async () => candidates), listTopics: vi.fn(async () => []), estimate: vi.fn(async () => ({ chars: 1, requests: 1 })),
      preview: vi.fn(async () => { throw new Error("Topic response must contain an overview"); }),
      apply: vi.fn(), cancel: vi.fn(), scanUnintegrated: vi.fn(), undoLastUpdate: vi.fn(), deleteTopic: vi.fn(), mergeTopics: vi.fn(),
      ignoreNote: vi.fn(), noteArrived: vi.fn(), refreshPrompt: vi.fn(), getPrompts: vi.fn(), removePrompt: vi.fn(), isSourceNote: vi.fn(), openTopic: vi.fn(), openSource: vi.fn(), countPending: vi.fn(),
    };
    const modal = new TopicCreateModal({} as never, port as never, "Notes/start.md");
    modal.open();
    await vi.waitFor(() => expect(port.getCandidates).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(descendants(modal.contentEl as never).some((item) => item.text === "Create" && item.listeners?.has("click"))).toBe(true));
    const createButton = descendants(modal.contentEl as never).find((item) => item.text === "Create" && item.listeners?.has("click"));
    createButton?.listeners?.get("click")?.();
    await vi.waitFor(() => expect(port.preview).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(allText(modal.contentEl as never)).toContain(expected));
    const content = allText(modal.contentEl as never);
    expect(content).not.toContain("Topic response must contain an overview");
    expect(content).toContain(language === "zh" ? "重试" : "Retry");
    const retryButton = descendants(modal.contentEl as never).find((item) => item.text === (language === "zh" ? "重试" : "Retry") && item.listeners?.has("click"));
    retryButton?.listeners?.get("click")?.();
    await vi.waitFor(() => expect(port.preview).toHaveBeenCalledTimes(2));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
