/**
 * "To-do summary" view in the main editor area: every Markdown to-do of the QnALog notes, with its source.
 *
 * Collecting, filtering and toggling live in `tasks/todo-summary*.ts` and `tasks/todo-toggle.ts`;
 * this module renders the controller's snapshot and binds clicks to the port.
 */
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { t } from "../shared/i18n";
import { NS_VIEW_TODO_SUMMARY } from "../shared/namespace";
import { NO_OWNER_KEY, type TodoEntry, type TodoGroup, type TodoGrouping, type TodoStatusFilter } from "../tasks/todo-summary";
import type { TodoToggleConflict, TodoTogglePort } from "../tasks/todo-toggle";
import {
  TodoSummaryController,
  type TodoSummarySnapshot,
  type TodoSummarySource,
  type TodoSummaryTimers,
} from "../tasks/todo-summary-controller";
import { precisionNote } from "./recording-search-panel";

export interface TodoSummaryViewPort extends TodoSummarySource, TodoTogglePort {
  /** Opens the note with the cursor on the 0-based line. */
  openNoteAtLine(path: string, line: number): Promise<void>;
  /** Plays a time link through the same path as time links in notes. */
  openTimeLink(linkPath: string, label: string, sourcePath: string): Promise<void>;
  notify(message: string): void;
  /** Calls back with changed paths (metadata change, rename with old and new path, delete); returns an unsubscribe. */
  subscribe(onChange: (paths: string[]) => void): () => void;
  timers?: TodoSummaryTimers;
}

export function todoConflictMessage(reason: TodoToggleConflict): string {
  if (reason === "active-version") return t("This note has saved versions, and switching versions replaces this part of the note. Open the note to update this to-do.");
  if (reason === "unsupported") return t("This to-do uses a custom status mark. Open the note to change it.");
  return t("The note has changed; open it to update this to-do.");
}

export interface TodoSummaryHandlers {
  onGrouping: (grouping: TodoGrouping) => void;
  onStatus: (status: TodoStatusFilter) => void;
  onOwner: (owner: string) => void;
  onHasDue: (hasDue: boolean) => void;
  onToggle: (entry: TodoEntry, checked: boolean) => void;
  onOpen: (entry: TodoEntry) => void;
  onOpenNote: (path: string) => void;
  onTimeLink: (entry: TodoEntry) => void;
}

function addSelect<T extends string>(
  parent: HTMLElement,
  label: string,
  options: ReadonlyArray<{ value: T; text: string }>,
  value: T,
  onChange: (value: T) => void,
): HTMLSelectElement {
  const select = parent.createEl("select", { cls: "dropdown qnalog-todo-summary-select", attr: { "aria-label": label, title: label } });
  for (const option of options) select.createEl("option", { text: option.text, attr: { value: option.value } });
  select.value = value;
  select.addEventListener("change", () => onChange(select.value as T));
  return select;
}

function bindActivate(el: HTMLElement, action: () => void): void {
  el.addEventListener("click", (evt: MouseEvent) => { evt.preventDefault(); action(); });
  el.addEventListener("keydown", (evt: KeyboardEvent) => {
    if (evt.key !== "Enter" && evt.key !== " ") return;
    evt.preventDefault();
    action();
  });
}

function renderHeader(root: HTMLElement, snapshot: TodoSummarySnapshot, handlers: TodoSummaryHandlers): void {
  const header = root.createDiv({ cls: "qnalog-todo-summary-header" });
  const titleRow = header.createDiv({ cls: "qnalog-todo-summary-title-row" });
  titleRow.createDiv({ cls: "qnalog-todo-summary-title", text: t("To-do summary") });
  titleRow.createDiv({
    cls: "qnalog-todo-summary-counts",
    text: t("Open {0} / Total {1}").replace("{0}", String(snapshot.totals.open)).replace("{1}", String(snapshot.totals.total)),
  });
  const controls = header.createDiv({ cls: "qnalog-todo-summary-controls" });
  addSelect<TodoGrouping>(controls, t("Group to-dos"), [
    { value: "note", text: t("By note") },
    { value: "owner", text: t("By owner") },
  ], snapshot.grouping, handlers.onGrouping);
  addSelect<TodoStatusFilter>(controls, t("To-do status"), [
    { value: "open", text: t("Not done") },
    { value: "done", text: t("Completed") },
    { value: "all", text: t("All") },
  ], snapshot.filter.status, handlers.onStatus);
  addSelect<string>(controls, t("Owner"), [
    { value: "", text: t("All owners") },
    ...snapshot.owners.map((owner) => ({
      value: owner.key,
      text: `${owner.key === NO_OWNER_KEY ? t("No owner") : owner.label} (${owner.count})`,
    })),
  ], snapshot.filter.owner, handlers.onOwner);
  const due = controls.createEl("label", { cls: "qnalog-todo-summary-due-filter" });
  const dueInput = due.createEl("input", { attr: { type: "checkbox" } });
  dueInput.checked = snapshot.filter.hasDue;
  dueInput.addEventListener("change", () => handlers.onHasDue(dueInput.checked));
  due.createSpan({ text: t("With due only") });
}

function renderRow(parent: HTMLElement, entry: TodoEntry, grouping: TodoGrouping, handlers: TodoSummaryHandlers): void {
  const row = parent.createDiv({ cls: `qnalog-todo-summary-row${entry.checked ? " is-done" : ""}` });
  const checkbox = row.createEl("input", {
    cls: "qnalog-todo-summary-checkbox",
    attr: { type: "checkbox", "aria-label": entry.checked ? t("Mark as not done") : t("Mark as done") },
  });
  checkbox.checked = entry.checked;
  checkbox.addEventListener("change", () => handlers.onToggle(entry, checkbox.checked));
  const body = row.createDiv({ cls: "qnalog-todo-summary-body" });
  const text = body.createDiv({
    cls: "qnalog-todo-summary-text",
    text: entry.text || entry.rawLine.trim(),
    attr: { role: "link", tabindex: "0", title: t("Open the note at this to-do") },
  });
  bindActivate(text, () => handlers.onOpen(entry));
  const meta = body.createDiv({ cls: "qnalog-todo-summary-meta" });
  if (entry.ownerLabel && grouping !== "owner") meta.createSpan({ cls: "qnalog-todo-summary-owner", text: t("Owner: {0}").replace("{0}", entry.ownerLabel) });
  if (entry.due) meta.createSpan({ cls: "qnalog-todo-summary-due", text: t("Due: {0}").replace("{0}", entry.due) });
  if (entry.acceptance === "assigned") meta.createSpan({ cls: "qnalog-todo-summary-acceptance", text: t("Not explicitly accepted") });
  if (grouping !== "note") {
    const source = meta.createSpan({
      cls: "qnalog-todo-summary-source",
      text: [entry.noteTitle, entry.noteDate].filter(Boolean).join(" · "),
      attr: { role: "link", tabindex: "0", title: t("Open the note at this to-do") },
    });
    bindActivate(source, () => handlers.onOpen(entry));
  }
  if (entry.evidence) {
    const note = precisionNote(entry.evidence.precision);
    const time = meta.createSpan({
      cls: "qnalog-todo-summary-time",
      text: note ? `${entry.evidence.label} ${note}` : entry.evidence.label,
      attr: { role: "link", tabindex: "0", title: t("Play from {0}").replace("{0}", entry.evidence.label) },
    });
    bindActivate(time, () => handlers.onTimeLink(entry));
  }
}

function renderGroup(root: HTMLElement, group: TodoGroup, grouping: TodoGrouping, handlers: TodoSummaryHandlers): void {
  const section = root.createDiv({ cls: "qnalog-todo-summary-group" });
  const head = section.createDiv({ cls: "qnalog-todo-summary-group-head" });
  if (grouping === "note" && group.notePath) {
    const notePath = group.notePath;
    const title = head.createDiv({
      cls: "qnalog-todo-summary-group-title is-link",
      text: group.label,
      attr: { role: "link", tabindex: "0", title: t("Open note") },
    });
    bindActivate(title, () => handlers.onOpenNote(notePath));
    if (group.date) head.createDiv({ cls: "qnalog-todo-summary-group-date", text: group.date });
  } else {
    head.createDiv({ cls: "qnalog-todo-summary-group-title", text: group.label || t("No owner") });
  }
  head.createDiv({ cls: "qnalog-todo-summary-group-count", text: String(group.entries.length) });
  for (const entry of group.entries) renderRow(section, entry, grouping, handlers);
}

/** Renders the whole view body from a snapshot. */
export function renderTodoSummary(root: HTMLElement, snapshot: TodoSummarySnapshot, handlers: TodoSummaryHandlers): void {
  root.empty();
  root.addClass("qnalog-todo-summary");
  renderHeader(root, snapshot, handlers);
  const list = root.createDiv({ cls: "qnalog-todo-summary-list" });
  if (snapshot.loading && !snapshot.totals.total) {
    list.createDiv({ cls: "qnalog-todo-summary-empty", text: t("Loading…") });
    return;
  }
  if (!snapshot.groups.length) {
    list.createDiv({
      cls: "qnalog-todo-summary-empty",
      text: snapshot.totals.total ? t("No to-dos match the filters.") : t("No to-dos in the QnALog notes folder."),
    });
    return;
  }
  for (const group of snapshot.groups) renderGroup(list, group, snapshot.grouping, handlers);
}

function defaultTimers(): TodoSummaryTimers {
  return {
    set: (callback, ms) => window.setTimeout(callback, ms),
    clear: (handle) => window.clearTimeout(handle),
  };
}

export class TodoSummaryView extends ItemView {
  readonly controller: TodoSummaryController;
  private unsubscribe: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly port: TodoSummaryViewPort) {
    super(leaf);
    this.controller = new TodoSummaryController(port, port.timers ?? defaultTimers(), () => this.render());
  }

  getViewType(): string { return NS_VIEW_TODO_SUMMARY; }
  getDisplayText(): string { return t("To-do summary"); }
  getIcon(): string { return "list-checks"; }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.port.subscribe((paths) => this.controller.notifyChanged(paths));
    await this.controller.reload();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.controller.dispose();
  }

  render(): void {
    renderTodoSummary(this.contentEl, this.controller.snapshot(), {
      onGrouping: (grouping) => this.controller.setGrouping(grouping),
      onStatus: (status) => this.controller.setFilter({ status }),
      onOwner: (owner) => this.controller.setFilter({ owner }),
      onHasDue: (hasDue) => this.controller.setFilter({ hasDue }),
      onToggle: (entry, checked) => { void this.toggle(entry, checked); },
      onOpen: (entry) => { void this.openNote(entry.notePath, entry.line); },
      onOpenNote: (path) => { void this.openNote(path, 0); },
      onTimeLink: (entry) => { void this.openTimeLink(entry); },
    });
  }

  async toggle(entry: TodoEntry, checked: boolean): Promise<void> {
    try {
      const result = await this.controller.toggle(entry, checked);
      if (result.status === "conflict") this.port.notify(todoConflictMessage(result.reason));
    } catch (error) {
      console.error("[QnALog] to-do toggle failed", error);
      this.port.notify(todoConflictMessage("changed"));
      this.render();
    }
  }

  private async openNote(path: string, line: number): Promise<void> {
    try { await this.port.openNoteAtLine(path, line); }
    catch (error) { console.error("[QnALog] open to-do source failed", error); }
  }

  private async openTimeLink(entry: TodoEntry): Promise<void> {
    if (!entry.evidence) return;
    try { await this.port.openTimeLink(entry.evidence.linkPath, entry.evidence.label, entry.notePath); }
    catch (error) { console.error("[QnALog] open to-do time link failed", error); }
  }
}

/** Shows the summary: reveals an open one, otherwise opens it in a new tab of the main area. */
export async function openTodoSummaryView(workspace: {
  getLeavesOfType(type: string): WorkspaceLeaf[];
  getLeaf(newLeaf: "tab"): WorkspaceLeaf;
  revealLeaf(leaf: WorkspaceLeaf): Promise<void>;
}): Promise<void> {
  const existing = workspace.getLeavesOfType(NS_VIEW_TODO_SUMMARY)[0];
  if (existing) {
    await workspace.revealLeaf(existing);
    return;
  }
  const leaf = workspace.getLeaf("tab");
  await leaf.setViewState({ type: NS_VIEW_TODO_SUMMARY, active: true });
  await workspace.revealLeaf(leaf);
}
