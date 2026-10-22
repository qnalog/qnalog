import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const outline = readFileSync(new URL("../src/ui/outline-view.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const topicPort = readFileSync(new URL("../src/ui/topics-ui-port.ts", import.meta.url), "utf8");
const joinMenu = readFileSync(new URL("../src/ui/topic-join-menu.ts", import.meta.url), "utf8");

describe("outline topic UI wiring", () => {
  it("renders the Topics tab from recording, finalizing, and idle paths", () => {
    expect((outline.match(/activeTab === "topics"/g) || []).length).toBe(4); // three render branches plus the active tab state
    expect(outline).toContain('text: i18nT("Topics")');
    expect(outline).toContain('idlePanelTab = "topics"');
  });

  it("injects a topic port through the view constructor without adding plugin service access", () => {
    expect(main).toContain("new OutlineView(leaf, this, this.createTopicsUiPort(), this.createErrataUiPort(), this.createRegenerateActionsPort(), this.createSedimentUiPort())");
    expect(outline).toContain("constructor(leaf, plugin, topicsUi: TopicsUiPort | null = null, errataUi: ErrataUiPort | null = null, regenerateUi: RegenerateActionsPort | null = null, sedimentUi: SedimentUiPort | null = null)");
    expect(outline).not.toMatch(/this\.plugin\.topics\b/);
  });

  it("offers create and join actions only through the source-note capability", () => {
    expect(outline).toContain("topicsUi?.isSourceNote(file.path)");
    expect(outline).toContain('i18nT("Create topic")');
    expect(outline).toContain('i18nT("Join topic…")');
    expect(topicPort).toContain("!topic.members.includes(path) && !topic.excluded.includes(path)");
    expect(topicPort).toContain("getTopicsSnapshot(): TopicSummary[]");
    expect(main).toContain("apply: async (preview, selection) => { const result = await this.topics.apply(preview, selection); await refreshTopicsSnapshot();");
    expect(outline).toContain("this.addTopicJoinMenu(target, file.path)");
    expect(outline).not.toContain("void this.addTopicJoinMenu");
    expect(joinMenu).toContain("topicJoinMenuEntries(topics, path)");
  });
});
