import { describe, expect, it } from "vitest";
import { isBrowseTab, nextSidebarTab, scrollTopAfterRender, type SidebarTabEvent } from "../src/ui/sidebar-tab-policy";

// Every current tab value, including "" (the default resolution) and the non-browse tabs.
const TABS = ["", "outline", "extract", "ask", "recent", "topics"];

// Expected tab after each event, one row per current tab.
const EXPECTED: Record<string, Record<SidebarTabEvent, string>> = {
  "":        { "session-start": "outline", "session-end": "outline", "session-switch": "outline", "leaf-change": "" },
  outline:   { "session-start": "outline", "session-end": "outline", "session-switch": "outline", "leaf-change": "" },
  extract:   { "session-start": "outline", "session-end": "outline", "session-switch": "outline", "leaf-change": "" },
  ask:       { "session-start": "outline", "session-end": "outline", "session-switch": "outline", "leaf-change": "" },
  recent:    { "session-start": "outline", "session-end": "outline", "session-switch": "recent", "leaf-change": "recent" },
  topics:    { "session-start": "outline", "session-end": "outline", "session-switch": "topics", "leaf-change": "topics" },
};

describe("sidebar tab policy", () => {
  it("covers every tab and event combination", () => {
    for (const tab of TABS) {
      for (const event of Object.keys(EXPECTED[tab]) as SidebarTabEvent[]) {
        expect(nextSidebarTab(tab, event), `${tab || "(default)"} on ${event}`).toBe(EXPECTED[tab][event]);
      }
    }
  });

  it("keeps a browse tab when a note is opened and never moves the user off it", () => {
    expect(nextSidebarTab("recent", "leaf-change")).toBe("recent");
    expect(nextSidebarTab("topics", "leaf-change")).toBe("topics");
  });

  it("starting or ending a recording always shows the outline, even from a browse tab", () => {
    expect(nextSidebarTab("recent", "session-start")).toBe("outline");
    expect(nextSidebarTab("topics", "session-end")).toBe("outline");
  });

  it("recognizes only recent and topics as browse tabs", () => {
    expect(["recent", "topics"].map(isBrowseTab)).toEqual([true, true]);
    expect(["", "outline", "extract", "ask"].map(isBrowseTab)).toEqual([false, false, false, false]);
  });

  it("restores the saved position for a browse tab and leaves other tabs alone", () => {
    const saved = { recent: 640, topics: 120 };
    expect(scrollTopAfterRender({ preserve: false, previousTop: 900, tab: "recent", saved })).toBe(640);
    expect(scrollTopAfterRender({ preserve: false, previousTop: 900, tab: "topics", saved })).toBe(120);
    expect(scrollTopAfterRender({ preserve: false, previousTop: 900, tab: "topics", saved: {} })).toBe(0);
    expect(scrollTopAfterRender({ preserve: false, previousTop: 900, tab: "outline", saved })).toBeNull();
  });

  it("lets an explicit preserve request win over the saved position", () => {
    expect(scrollTopAfterRender({ preserve: true, previousTop: 900, tab: "recent", saved: { recent: 640 } })).toBe(900);
    expect(scrollTopAfterRender({ preserve: true, previousTop: 300, tab: "outline", saved: {} })).toBe(300);
  });
});
