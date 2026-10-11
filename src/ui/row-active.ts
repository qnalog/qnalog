/**
 * Highlight of the list row for the open file.
 *
 * Rows carry their vault path in `data-path`. The highlight follows the open
 * file by changing classes and `aria-current` only: no row is rebuilt and the
 * list keeps its scroll position.
 */
export const ACTIVE_ROW_SELECTOR = "[data-path].qnalog-outline-recent-row, [data-path].qnalog-topics-row";

/** Marks every list row whose path is in `paths` as current and clears the others. */
export function syncActiveRow(root: ParentNode, paths: readonly string[]): void {
  const open = new Set(paths.filter(Boolean));
  root.querySelectorAll<HTMLElement>(ACTIVE_ROW_SELECTOR).forEach((row) => {
    const active = open.has(row.getAttribute("data-path") || "");
    row.classList.toggle("is-active", active);
    if (active) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  });
}
