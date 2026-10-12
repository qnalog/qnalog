/**
 * Decides whether a click on a topic candidate row must stop the row's own
 * activation (the native label → checkbox toggle).
 *
 * The row is a <label> around the checkbox, so a click on the text toggles the
 * checkbox once by the browser. This rule cancels that activation when the
 * click should not change the selection: a text selection made by dragging,
 * a button or link inside the row, or a disabled row.
 */
export interface TopicRowClick {
  /** The click landed on the checkbox itself; the browser already toggles it. */
  onCheckbox: boolean;
  /** The click landed on a button or link inside the row (expand, source link). */
  onInteractive: boolean;
  /** Non-empty when the user dragged to select text. */
  selectedText: string;
  disabled: boolean;
}

export function suppressRowActivation(click: TopicRowClick): boolean {
  if (click.onCheckbox) return false;
  return click.disabled || click.onInteractive || click.selectedText.length > 0;
}

export function bindKeyboardFocusOutline(row: HTMLElement): void {
  row.addEventListener("focusin", (event) => {
    const target = event.target;
    row.classList.toggle("is-keyboard-focus", target instanceof HTMLElement && target.matches(":focus-visible"));
  });
  row.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !row.contains(next)) row.classList.remove("is-keyboard-focus");
  });
}
