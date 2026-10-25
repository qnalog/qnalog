/**
 * State and loading for the to-do summary view: reads the notes in scope through a narrow port, keeps the
 * filter and grouping, reloads after note changes (debounced) and runs single to-do toggles.
 * The view (`ui/todo-summary-view.ts`) only renders this state and binds events.
 */
import {
  DEFAULT_TODO_FILTER,
  collectTodoSummary,
  countTodos,
  filterTodos,
  groupTodos,
  hasTaskListItems,
  isTodoSummaryPathInScope,
  listTodoOwners,
  type TodoCounts,
  type TodoEntry,
  type TodoFilter,
  type TodoGroup,
  type TodoGrouping,
  type TodoListItem,
  type TodoNoteInput,
  type TodoOwnerOption,
  type TodoSummaryScope,
} from "./todo-summary";
import { toggleTodo, type TodoTogglePort, type TodoToggleResult } from "./todo-toggle";

/** Delay between the last note change and the reload. */
export const TODO_SUMMARY_REFRESH_DEBOUNCE_MS = 600;

/** A mother note as listed by the notes tab (`recent/recent-notes.ts` `getRecentNotes`). */
export interface TodoSummaryNoteRef {
  path: string;
  title: string;
  timestamp: number;
  dateLabel: string;
}

export interface TodoSummarySource {
  listNotes(): TodoSummaryNoteRef[];
  getScope(): TodoSummaryScope;
  /** Cached list items of a note; null when the cache has none yet. */
  getListItems(path: string): TodoListItem[] | null;
  getFrontmatter(path: string): Record<string, unknown> | null;
  /** Note text for collecting (a cached read is enough); null when the file is gone. */
  readCached(path: string): Promise<string | null>;
}

export interface TodoSummaryTimers {
  set(callback: () => void, ms: number): number;
  clear(handle: number): void;
}

/**
 * Reads every note in scope that has task list items and collects its to-dos.
 * Notes whose list items are not cached yet are read and scanned line by line.
 */
export async function loadTodoSummaryEntries(source: TodoSummarySource): Promise<TodoEntry[]> {
  const scope = source.getScope();
  const inputs: TodoNoteInput[] = [];
  for (const note of source.listNotes()) {
    if (!isTodoSummaryPathInScope(note.path, scope)) continue;
    const listItems = source.getListItems(note.path);
    if (listItems && !hasTaskListItems(listItems)) continue;
    const text = await source.readCached(note.path);
    if (text === null) continue;
    inputs.push({
      path: note.path,
      title: note.title,
      noteTime: note.timestamp,
      noteDate: note.dateLabel,
      frontmatter: source.getFrontmatter(note.path),
      listItems,
      text,
    });
  }
  return collectTodoSummary(inputs, scope);
}

export interface TodoSummarySnapshot {
  loading: boolean;
  /** Counts over every collected to-do. */
  totals: TodoCounts;
  /** Counts after the filter. */
  shown: TodoCounts;
  groups: TodoGroup[];
  owners: TodoOwnerOption[];
  filter: TodoFilter;
  grouping: TodoGrouping;
}

export class TodoSummaryController {
  private entries: TodoEntry[] = [];
  private loading = false;
  private filter: TodoFilter = { ...DEFAULT_TODO_FILTER };
  private grouping: TodoGrouping = "note";
  private pending: number | null = null;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly source: TodoSummarySource & TodoTogglePort,
    private readonly timers: TodoSummaryTimers,
    private readonly onChange: () => void,
  ) {}

  snapshot(): TodoSummarySnapshot {
    const shownEntries = filterTodos(this.entries, this.filter);
    return {
      loading: this.loading,
      totals: countTodos(this.entries),
      shown: countTodos(shownEntries),
      groups: groupTodos(shownEntries, this.grouping),
      owners: listTodoOwners(this.entries),
      filter: { ...this.filter },
      grouping: this.grouping,
    };
  }

  async reload(): Promise<void> {
    const generation = ++this.generation;
    this.loading = true;
    this.onChange();
    try {
      const entries = await loadTodoSummaryEntries(this.source);
      if (generation !== this.generation || this.disposed) return;
      this.entries = entries;
      if (this.filter.owner && !listTodoOwners(entries).some((owner) => owner.key === this.filter.owner)) {
        this.filter = { ...this.filter, owner: "" };
      }
    } finally {
      if (generation === this.generation && !this.disposed) {
        this.loading = false;
        this.onChange();
      }
    }
  }

  /** Reload after changes to files in scope, or to files the summary currently shows (renames, deletes). */
  notifyChanged(paths: readonly string[]): void {
    if (this.disposed) return;
    const scope = this.source.getScope();
    const shown = new Set(this.entries.map((entry) => entry.notePath));
    if (!paths.some((path) => shown.has(path) || isTodoSummaryPathInScope(path, scope))) return;
    if (this.pending !== null) this.timers.clear(this.pending);
    this.pending = this.timers.set(() => {
      this.pending = null;
      void this.reload();
    }, TODO_SUMMARY_REFRESH_DEBOUNCE_MS);
  }

  setFilter(patch: Partial<TodoFilter>): void {
    this.filter = { ...this.filter, ...patch };
    this.onChange();
  }

  setGrouping(grouping: TodoGrouping): void {
    this.grouping = grouping;
    this.onChange();
  }

  /** Writes one toggle. On success the entry is updated at once; on a conflict the summary reloads. */
  async toggle(entry: TodoEntry, nextChecked: boolean): Promise<TodoToggleResult> {
    const result = await toggleTodo(this.source, entry, nextChecked);
    if (result.status === "ok") {
      this.entries = this.entries.map((item) => item.id === entry.id
        ? { ...item, checked: nextChecked, mark: nextChecked ? "x" : " ", rawLine: result.rawLine }
        : item);
      this.onChange();
    } else if (result.status === "conflict") {
      await this.reload();
    }
    return result;
  }

  dispose(): void {
    this.disposed = true;
    if (this.pending !== null) this.timers.clear(this.pending);
    this.pending = null;
  }
}
