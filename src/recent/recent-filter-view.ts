export interface RecentFilterState {
  time: string;
  mode: string;
}

export interface RecentFilterChip {
  kind: "time" | "mode";
  id: string;
  label: string;
}

export type RecentFilterPopoverSectionId = "time" | "mode" | "group";

export interface RecentFilterPopoverOption {
  id: string;
  label: string;
}

export interface RecentFilterPopoverSection {
  id: RecentFilterPopoverSectionId;
  label: string;
  selected: string;
  options: RecentFilterPopoverOption[];
}

export const RECENT_FILTER_ICONS = {
  search: "search",
  filterMenu: "sliders-horizontal",
  time: "calendar",
  template: "layout-template",
  folder: "folder",
  folderOpen: "folder-open",
  remove: "x",
  clearSearch: "x",
  selected: "check",
} as const;

export function countActiveRecentFilters(state: RecentFilterState): number {
  return Number((state.time || "all") !== "all") + Number((state.mode || "all") !== "all");
}

export function listActiveRecentFilterChips(
  state: RecentFilterState,
  labelOf: (kind: "time" | "mode", id: string) => string,
): RecentFilterChip[] {
  const chips: RecentFilterChip[] = [];
  if ((state.time || "all") !== "all") {
    const id = state.time;
    chips.push({ kind: "time", id, label: labelOf("time", id) });
  }
  if ((state.mode || "all") !== "all") {
    const id = state.mode;
    chips.push({ kind: "mode", id, label: labelOf("mode", id) });
  }
  return chips;
}

export function shouldShowFolderRootHeader(rootCount: number): boolean {
  return rootCount !== 1;
}

export function buildRecentFilterPopoverSections(
  state: RecentFilterState & { group: string },
  options: {
    time: RecentFilterPopoverOption[];
    mode: RecentFilterPopoverOption[];
    group: RecentFilterPopoverOption[];
  },
): RecentFilterPopoverSection[] {
  const timeOrder = ["all", "today", "week", "month"];
  const timeOptions = [...options.time].sort((left, right) => {
    const leftOrder = timeOrder.indexOf(left.id);
    const rightOrder = timeOrder.indexOf(right.id);
    return (leftOrder < 0 ? timeOrder.length : leftOrder) - (rightOrder < 0 ? timeOrder.length : rightOrder);
  });
  return [
    { id: "time", label: "Time range", selected: state.time || "all", options: timeOptions },
    { id: "mode", label: "Template", selected: state.mode || "all", options: [...options.mode] },
    { id: "group", label: "Group by", selected: state.group || "folder", options: [...options.group] },
  ];
}

export function shouldShowUncategorizedRootGroup(rootCount: number, childFolderCount: number, directNoteCount: number): boolean {
  return rootCount === 1 && childFolderCount > 0 && directNoteCount > 0;
}

export function matchesRecentSearch(
  query: string,
  fields: { title: string; displayTime: string; modeLabel: string },
): boolean {
  const normalized = String(query || "").trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [fields.title, fields.displayTime, fields.modeLabel]
    .some((field) => String(field || "").toLocaleLowerCase().includes(normalized));
}
