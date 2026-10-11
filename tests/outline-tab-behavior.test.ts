import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class ItemView {}
  class Modal {}
  class SuggestModal {}
  class FuzzySuggestModal {}
  class PluginSettingTab {}
  return {
    ItemView, Modal, SuggestModal, FuzzySuggestModal, PluginSettingTab,
    normalizePath: (path: string) => path.replace(/\\/g, "/"),
    setIcon: () => undefined,
  };
});
vi.mock("../src/recent/recent-notes", async () => {
  const actual = await vi.importActual<typeof import("../src/recent/recent-notes")>("../src/recent/recent-notes");
  return { ...actual, getQueueTasksForMarkdown: () => [], getRecentQueueProcessingState: () => null };
});

import { OutlineView } from "../src/ui/outline-view";

const TABS = ["", "outline", "extract", "ask", "recent", "topics"];
const BROWSE = new Set(["recent", "topics"]);

function viewWith(tab: string, sessionId: string, showRecentHome = true): OutlineView {
  const view = Object.create(OutlineView.prototype) as OutlineView;
  Object.assign(view, { idlePanelTab: tab, outlineSessionId: sessionId, showRecentHome });
  return view;
}

describe("outline sidebar tab on note, session and recording events", () => {
  for (const tab of TABS) {
    const label = tab || "(default)";
    it(`${label}: opening or focusing a note keeps browse tabs and resets the others to the default`, () => {
      const view = viewWith(tab, "");
      view.handleActiveLeafChange();
      expect(view.idlePanelTab).toBe(BROWSE.has(tab) ? tab : "");
      if (!BROWSE.has(tab)) expect(view.showRecentHome).toBe(true);
    });

    it(`${label}: starting a recording shows the outline`, () => {
      const view = viewWith(tab, "");
      view.syncSessionOutline({ id: "session-a", segments: [] });
      expect(view.idlePanelTab).toBe("outline");
      expect(view.showRecentHome).toBe(false);
    });

    it(`${label}: ending a session (recording stop or finalization) shows the outline`, () => {
      const view = viewWith(tab, "session-a", false);
      view.syncSessionOutline(null);
      expect(view.idlePanelTab).toBe("outline");
      expect(view.showRecentHome).toBe(false);
    });

    it(`${label}: switching to another session keeps browse tabs and shows the outline otherwise`, () => {
      const view = viewWith(tab, "session-a", true);
      view.syncSessionOutline({ id: "session-b", segments: [] });
      expect(view.idlePanelTab).toBe(BROWSE.has(tab) ? tab : "outline");
    });
  }

  it("an unchanged session id leaves the tab alone", () => {
    const view = viewWith("recent", "session-a");
    view.syncSessionOutline({ id: "session-a", segments: [] });
    expect(view.idlePanelTab).toBe("recent");
  });
});
