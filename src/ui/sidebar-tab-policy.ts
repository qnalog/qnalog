/**
 * Which idle-view tab the sidebar shows after an event.
 *
 * Browse tabs are the lists the user opened to look through notes or topics.
 * An ordinary note switch must not move the user off them. Recording and
 * finalization keep their original behavior and always show the outline.
 */
export const BROWSE_TABS = ["recent", "topics"] as const;
export type SidebarBrowseTab = (typeof BROWSE_TABS)[number];

export function isBrowseTab(tab: string): tab is SidebarBrowseTab {
  return (BROWSE_TABS as readonly string[]).includes(tab);
}

/**
 * Events that can change the idle-view tab:
 * - "session-start": a recording or import session became current (recording starts).
 * - "session-end": the current session ended (recording stops, or background finalization completes).
 * - "session-switch": the current session changed to a different one without an end in between.
 * - "leaf-change": the active editor leaf changed (a note or topic page was opened or focused).
 */
export type SidebarTabEvent = "session-start" | "session-end" | "session-switch" | "leaf-change";

/** The tab after `event`. "" means the default resolution, which shows the outline. */
export function nextSidebarTab(current: string, event: SidebarTabEvent): string {
  if (event === "leaf-change") return isBrowseTab(current) ? current : "";
  if (event === "session-switch" && isBrowseTab(current)) return current;
  return "outline";
}

/**
 * The scroll position to apply after a render. `null` means leave the scroll alone.
 * A requested preserve wins; browse tabs return their own saved position, so each list keeps its place.
 */
export function scrollTopAfterRender(input: {
  preserve: boolean;
  previousTop: number;
  tab: string;
  saved: Partial<Record<SidebarBrowseTab, number>>;
}): number | null {
  if (input.preserve) return input.previousTop;
  if (isBrowseTab(input.tab)) return input.saved[input.tab] ?? 0;
  return null;
}
