import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const outline = readFileSync(new URL("../src/ui/outline-view.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const topicPort = readFileSync(new URL("../src/ui/topics-ui-port.ts", import.meta.url), "utf8");

describe("outline topic UI wiring", () => {
  it("renders the Topics tab from recording, finalizing, and idle paths", () => {
    expect((outline.match(/activeTab === "topics"/g) || []).length).toBe(4); // three render branches plus the active tab state
    expect(outline).toContain('text: i18nT("Topics")');
    expect(outline).toContain('idlePanelTab = "topics"');
  });

  it("injects a topic port through the view constructor without adding plugin service access", () => {
    expect(main).toContain("new OutlineView(leaf, this, this.createTopicsUiPort())");
    expect(outline).toContain("constructor(leaf, plugin, topicsUi: TopicsUiPort | null = null)");
    expect(outline).not.toMatch(/this\.plugin\.topics\b/);
  });

  it("offers create and join actions only through the source-note capability", () => {
    expect(outline).toContain("topicsUi?.isSourceNote(file.path)");
    expect(outline).toContain('i18nT("Create topic")');
    expect(outline).toContain('i18nT("Join topic…")');
    expect(topicPort).toContain("!page.members.includes(path) && !page.excluded.includes(path)");
  });
});
