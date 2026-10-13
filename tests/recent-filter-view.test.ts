import { describe, expect, it } from "vitest";
import {
  buildRecentFilterPopoverSections,
  countActiveRecentFilters,
  listActiveRecentFilterChips,
  matchesRecentSearch,
  RECENT_FILTER_ICONS,
  shouldShowFolderRootHeader,
  shouldShowUncategorizedRootGroup,
} from "../src/recent/recent-filter-view";

describe("recent filter view helpers", () => {
  it("returns no active filters for defaults", () => {
    const state = { time: "all", mode: "all" };
    expect(countActiveRecentFilters(state)).toBe(0);
    expect(listActiveRecentFilterChips(state, (_kind, id) => id)).toEqual([]);
  });

  it("lists a time filter", () => {
    const state = { time: "week", mode: "all" };
    expect(countActiveRecentFilters(state)).toBe(1);
    expect(listActiveRecentFilterChips(state, (kind, id) => `${kind}:${id}`)).toEqual([
      { kind: "time", id: "week", label: "time:week" },
    ]);
  });

  it("lists a template filter", () => {
    const state = { time: "all", mode: "meeting" };
    expect(countActiveRecentFilters(state)).toBe(1);
    expect(listActiveRecentFilterChips(state, (kind, id) => `${kind}:${id}`)).toEqual([
      { kind: "mode", id: "meeting", label: "mode:meeting" },
    ]);
  });

  it("lists both active filters", () => {
    const state = { time: "today", mode: "meeting" };
    expect(countActiveRecentFilters(state)).toBe(2);
    expect(listActiveRecentFilterChips(state, (_kind, id) => id).map((chip) => chip.id)).toEqual(["today", "meeting"]);
  });

  it("shows a folder root header for zero or multiple roots", () => {
    expect(shouldShowFolderRootHeader(0)).toBe(true);
    expect(shouldShowFolderRootHeader(1)).toBe(false);
    expect(shouldShowFolderRootHeader(2)).toBe(true);
  });

  it("builds the filter popover sections with the active options selected", () => {
    const sections = buildRecentFilterPopoverSections(
      { time: "today", mode: "meeting", group: "folder" },
      {
        time: [{ id: "week", label: "This week" }, { id: "all", label: "All dates" }, { id: "today", label: "Today" }],
        mode: [{ id: "all", label: "All templates" }, { id: "meeting", label: "Meeting" }],
        group: [{ id: "time", label: "By time" }, { id: "folder", label: "By folder" }],
      },
      (key) => `T:${key}`,
    );
    expect(sections.map(({ id, selected }) => [id, selected])).toEqual([
      ["time", "today"], ["mode", "meeting"], ["group", "folder"],
    ]);
    expect(sections[0].options.map(({ id }) => id)).toEqual(["all", "today", "week"]);
    expect(sections[0].options.every(({ label }) => label.startsWith("T:"))).toBe(true);
    expect(sections[2].options.every(({ label }) => label.startsWith("T:"))).toBe(true);
    expect(sections[1].options[0].label).toBe("T:All");
    expect(sections[1].options[1].label).toBe("Meeting");
  });

  it("shows an uncategorized group only for a single root with children and direct notes", () => {
    expect(shouldShowUncategorizedRootGroup(1, 0, 2)).toBe(false);
    expect(shouldShowUncategorizedRootGroup(1, 2, 3)).toBe(true);
    expect(shouldShowUncategorizedRootGroup(1, 2, 0)).toBe(false);
    expect(shouldShowUncategorizedRootGroup(2, 2, 3)).toBe(false);
  });

  it("matches title, display time, and template without case sensitivity", () => {
    const fields = { title: "Quarterly Planning", displayTime: "Monday, October 12", modeLabel: "Meeting Notes" };
    expect(matchesRecentSearch("QUARTERLY", fields)).toBe(true);
    expect(matchesRecentSearch("october", fields)).toBe(true);
    expect(matchesRecentSearch("meeting", fields)).toBe(true);
    expect(matchesRecentSearch("unrelated", fields)).toBe(false);
    expect(matchesRecentSearch("  ", fields)).toBe(true);
  });

  it("maps each icon role to a non-empty Lucide name", () => {
    for (const iconName of Object.values(RECENT_FILTER_ICONS)) {
      expect(iconName.trim().length).toBeGreaterThan(0);
    }
  });
});
