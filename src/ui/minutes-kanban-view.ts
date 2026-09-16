import {
  ItemView,
  Menu,
  Modal,
  Notice,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  setIcon,
} from "obsidian";
import { NS_VIEW_MINUTES_KANBAN } from "../shared/namespace";
import { t } from '../shared/i18n';

export const VIEW_TYPE_MINUTES_KANBAN = NS_VIEW_MINUTES_KANBAN;

export type MinutesKanbanItem = {
  file: TFile;
  title: string;
  mode: string;
  modeLabel: string;
  icon: string;
  folderPath: string;
  timeLabel: string;
  durationLabel: string;
  canvasFiles: TFile[];
};

type KanbanGroupMode = "folder" | "type";

type MinutesKanbanColumn = {
  key: string;
  path: string;
  label: string;
  items: MinutesKanbanItem[];
};

export type MinutesKanbanAdapter = {
  getRootPath: () => string;
  listItems: () => MinutesKanbanItem[];
  getModeOptions: () => Array<{ value: string; label: string }>;
  moveItem: (item: MinutesKanbanItem, folderPath: string) => Promise<void>;
  createFolder: (name: string) => Promise<string>;
};

class FolderNameModal extends Modal {
  private onSubmit: (name: string) => void;

  constructor(view: MinutesKanbanView, onSubmit: (name: string) => void) {
    super(view.app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("qnalog-kanban-folder-modal");
    this.contentEl.createEl("h3", { text: t("New group") });
    const input = this.contentEl.createEl("input", {
      cls: "qnalog-kanban-folder-input",
      attr: { type: "text", placeholder: t("Folder name") },
    });
    const actions = this.contentEl.createDiv({ cls: "qnalog-kanban-folder-actions" });
    const cancel = actions.createEl("button", { text: t("Cancel") });
    cancel.onclick = () => this.close();
    const submit = actions.createEl("button", { cls: "mod-cta", text: t("Create") });
    const commit = () => {
      const name = input.value.trim();
      if (!name) return;
      this.close();
      this.onSubmit(name);
    };
    submit.onclick = commit;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commit();
    });
    window.setTimeout(() => input.focus(), 0);
  }
}

export class MinutesKanbanView extends ItemView {
  private adapter: MinutesKanbanAdapter;
  private query = "";
  private groupMode: KanbanGroupMode = "folder";
  private showCanvas = false;
  private expandedGroups = new Set<string>();
  private refreshTimer = 0;

  constructor(leaf: WorkspaceLeaf, adapter: MinutesKanbanAdapter) {
    super(leaf);
    this.adapter = adapter;
  }

  getViewType(): string { return VIEW_TYPE_MINUTES_KANBAN; }
  getDisplayText(): string { return t("Minutes board"); }
  getIcon(): string { return "columns-3"; }

  async onOpen(): Promise<void> {
    const refresh = () => this.queueRefresh();
    this.registerEvent(this.app.vault.on("create", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.registerEvent(this.app.vault.on("rename", refresh));
    this.registerEvent(this.app.metadataCache.on("changed", refresh));
    this.render();
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
  }

  private queueRefresh(): void {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = 0;
      this.render();
    }, 160);
  }

  private getFolderColumns(items: MinutesKanbanItem[]): MinutesKanbanColumn[] {
    const root = normalizePath(this.adapter.getRootPath() || "");
    const byPath = new Map<string, MinutesKanbanColumn>();
    const add = (pathValue: string) => {
      const path = normalizePath(pathValue || "");
      if (byPath.has(path)) return;
      const relative = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
      byPath.set(path, { key: `folder:${path}`, path, label: path === root ? "未分类" : (relative || t("Uncategorized")), items: [] });
    };
    add(root);
    for (const file of this.app.vault.getAllLoadedFiles()) {
      if (!(file instanceof TFolder)) continue;
      const path = normalizePath(file.path);
      if (path && root && path.startsWith(`${root}/`) && !path.slice(root.length + 1).includes("/")) add(path);
    }
    for (const item of items) {
      add(item.folderPath || root);
      byPath.get(normalizePath(item.folderPath || root))?.items.push(item);
    }
    return Array.from(byPath.values()).sort((left, right) => {
      if (left.path === root) return -1;
      if (right.path === root) return 1;
      return left.label.localeCompare(right.label, "zh-CN");
    });
  }

  private getTypeColumns(items: MinutesKanbanItem[]): MinutesKanbanColumn[] {
    const labels = new Map(this.adapter.getModeOptions().map((option) => [option.value, option.label]));
    const byMode = new Map<string, MinutesKanbanColumn>();
    for (const item of items) {
      const mode = item.mode || "off";
      if (!byMode.has(mode)) {
        byMode.set(mode, {
          key: `type:${mode}`,
          path: "",
          label: item.modeLabel || labels.get(mode) || t("Other notes"),
          items: [],
        });
      }
      byMode.get(mode)?.items.push(item);
    }
    return Array.from(byMode.values()).sort((left, right) => right.items.length - left.items.length
      || left.label.localeCompare(right.label, "zh-CN"));
  }

  private getColumns(items: MinutesKanbanItem[]): MinutesKanbanColumn[] {
    return this.groupMode === "type" ? this.getTypeColumns(items) : this.getFolderColumns(items);
  }

  private matches(item: MinutesKanbanItem): boolean {
    const query = this.query.trim().toLocaleLowerCase();
    return !query || item.title.toLocaleLowerCase().includes(query) || item.file.path.toLocaleLowerCase().includes(query);
  }

  private renderToolbar(root: HTMLElement, total: number, groupCount: number): void {
    const header = root.createDiv({ cls: "qnalog-kanban-header" });
    const title = header.createDiv({ cls: "qnalog-kanban-heading" });
    title.createEl("h2", { text: t("Minutes board") });
    title.createSpan({ text: `${total}${t(" notes · ")}${groupCount}${t(" groups")}` });
    const actions = header.createDiv({ cls: "qnalog-kanban-header-actions" });
    const addFolder = actions.createEl("button", {
      cls: "qnalog-kanban-new-group",
      attr: { type: "button", title: t("New group"), "aria-label": t("New group") },
    });
    setIcon(addFolder.createSpan(), "folder-plus");
    addFolder.createSpan({ text: t("New group") });
    addFolder.onclick = () => new FolderNameModal(this, (name) => {
      void this.adapter.createFolder(name)
        .then(() => this.render())
        .catch((error) => new Notice(`${t("Create failed: ")}${error instanceof Error ? error.message : String(error)}`));
    }).open();

    const filters = root.createDiv({ cls: "qnalog-kanban-filters" });
    const searchWrap = filters.createDiv({ cls: "qnalog-kanban-search" });
    setIcon(searchWrap.createSpan(), "search");
    const search = searchWrap.createEl("input", { attr: { type: "search", placeholder: t("AI organization failed; the original transcript can still be reorganized to generate the final minutes") } });
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderBoard(root);
    });
    const grouping = filters.createDiv({ cls: "qnalog-kanban-grouping", attr: { "aria-label": t("Grouping method") } });
    grouping.createSpan({ cls: "qnalog-kanban-grouping-label", text: t("Group by") });
    for (const option of [
      { value: "folder" as const, label: t("Folder") },
      { value: "type" as const, label: t("Type") },
    ]) {
      const button = grouping.createEl("button", {
        cls: `qnalog-kanban-grouping-option${this.groupMode === option.value ? " is-active" : ""}`,
        text: option.label,
        attr: { type: "button", "aria-pressed": String(this.groupMode === option.value) },
      });
      button.onclick = () => {
        if (this.groupMode === option.value) return;
        this.groupMode = option.value;
        this.render();
      };
    }
    const canvasToggle = filters.createEl("button", {
      cls: `qnalog-kanban-toggle${this.showCanvas ? " is-active" : ""}`,
      attr: { type: "button", role: "switch", "aria-checked": String(this.showCanvas) },
    });
    canvasToggle.createSpan({ text: t("Semantic map") });
    const toggleTrack = canvasToggle.createSpan({ cls: "qnalog-kanban-toggle-track" });
    toggleTrack.createSpan({ cls: "qnalog-kanban-toggle-knob" });
    canvasToggle.onclick = () => { this.showCanvas = !this.showCanvas; this.render(); };
    filters.createSpan({
      cls: "qnalog-kanban-hint",
      text: this.groupMode === "folder" ? "拖动卡片可换分组" : t("- One line per question, 3 lines in total"),
    });
  }

  private renderCard(parent: HTMLElement, item: MinutesKanbanItem): void {
    const card = parent.createDiv({ cls: "qnalog-kanban-card", attr: { draggable: "true", title: item.file.path } });
    const icon = card.createSpan({ cls: "qnalog-kanban-card-icon" });
    setIcon(icon, item.icon || "file-text");
    const content = card.createSpan({ cls: "qnalog-kanban-card-content" });
    content.createSpan({ cls: "qnalog-kanban-card-title", text: item.title || item.file.basename });
    content.createSpan({
      cls: "qnalog-kanban-card-meta",
      text: this.groupMode === "type"
        ? [item.timeLabel, this.getFolderLabel(item), item.durationLabel].filter(Boolean).join(" · ")
        : [item.timeLabel, item.modeLabel, item.durationLabel].filter(Boolean).join(" · "),
    });
    card.addEventListener("click", () => { void this.app.workspace.getLeaf(false).openFile(item.file); });
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/x-qnalog-note", item.file.path);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      card.addClass("is-dragging");
    });
    card.addEventListener("dragend", () => card.removeClass("is-dragging"));
    if (!this.showCanvas) return;
    for (const canvasFile of item.canvasFiles) {
      const canvasCard = parent.createDiv({ cls: "qnalog-kanban-card is-canvas", attr: { title: canvasFile.path } });
      const canvasIcon = canvasCard.createSpan({ cls: "qnalog-kanban-card-icon" });
      setIcon(canvasIcon, "layout-dashboard");
      const canvasContent = canvasCard.createSpan({ cls: "qnalog-kanban-card-content" });
      canvasContent.createSpan({ cls: "qnalog-kanban-card-title", text: item.title || canvasFile.basename });
      canvasContent.createSpan({ cls: "qnalog-kanban-card-meta", text: t("Semantic map") });
      canvasCard.addEventListener("click", () => { void this.app.workspace.getLeaf(false).openFile(canvasFile); });
    }
  }

  private getFolderLabel(item: MinutesKanbanItem): string {
    const root = normalizePath(this.adapter.getRootPath() || "");
    const path = normalizePath(item.folderPath || root);
    if (!path || path === root) return t("Uncategorized");
    return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  }

  private renderBoard(container: HTMLElement): void {
    const existing = container.querySelector(".qnalog-kanban-board");
    if (existing) existing.remove();
    const items = this.adapter.listItems();
    const itemByPath = new Map(items.map((item) => [normalizePath(item.file.path), item]));
    const board = container.createDiv({ cls: "qnalog-kanban-board" });
    for (const column of this.getColumns(items)) {
      const visible = column.items.filter((item) => this.matches(item));
      if (this.groupMode === "type" && !visible.length) continue;
      const columnEl = board.createDiv({ cls: "qnalog-kanban-column", attr: { "data-folder": column.path } });
      const head = columnEl.createDiv({ cls: "qnalog-kanban-column-head" });
      const label = head.createDiv({ cls: "qnalog-kanban-column-label" });
      label.createSpan({ text: column.label });
      head.createSpan({ cls: "qnalog-kanban-column-count", text: String(visible.length) });
      const menu = head.createEl("button", {
        cls: "clickable-icon qnalog-kanban-column-menu",
        attr: { type: "button", title: t("Grouping menu"), "aria-label": `${column.label}${t("Grouping menu")}` },
      });
      setIcon(menu, "more-horizontal");
      menu.onclick = (event) => {
        event.stopPropagation();
        const contextMenu = new Menu();
        if (this.expandedGroups.has(column.key)) {
          contextMenu.addItem((item) => item
            .setTitle(t("AI is identifying people, to-dos, and hotwords"))
            .setIcon("list-collapse")
            .onClick(() => {
              this.expandedGroups.delete(column.key);
              this.renderBoard(container);
            }));
        } else {
          contextMenu.addItem((item) => item
            .setTitle(t("Expand all"))
            .setIcon("list-tree")
            .setDisabled(visible.length <= 6)
            .onClick(() => {
              this.expandedGroups.add(column.key);
              this.renderBoard(container);
            }));
        }
        contextMenu.showAtMouseEvent(event);
      };
      const cards = columnEl.createDiv({ cls: "qnalog-kanban-cards" });
      const isExpanded = this.expandedGroups.has(column.key);
      const shown = isExpanded ? visible : visible.slice(0, 6);
      for (const item of shown) this.renderCard(cards, item);
      if (visible.length > shown.length) {
        const more = cards.createEl("button", {
          cls: "qnalog-kanban-more",
          attr: { type: "button" },
        });
        more.createSpan({ text: `${t("Another")}${visible.length - shown.length}${t(" notes")}` });
        setIcon(more.createSpan(), "chevron-down");
        more.onclick = () => {
          this.expandedGroups.add(column.key);
          this.renderBoard(container);
        };
      } else if (isExpanded && visible.length > 6) {
        const less = cards.createEl("button", {
          cls: "qnalog-kanban-more",
          attr: { type: "button" },
        });
        less.createSpan({ text: t("AI is filling in...") });
        setIcon(less.createSpan(), "chevron-up");
        less.onclick = () => {
          this.expandedGroups.delete(column.key);
          this.renderBoard(container);
        };
      }
      if (!visible.length) cards.createDiv({ cls: "qnalog-kanban-empty", text: t("- More structured: Strengthen heading levels and organize by \"conclusion → basis → impact/to-dos\".") });
      columnEl.addEventListener("dragover", (event) => {
        if (this.groupMode !== "folder") return;
        if (!event.dataTransfer?.types.includes("text/x-qnalog-note")) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        columnEl.addClass("is-drop-target");
      });
      columnEl.addEventListener("dragleave", (event) => {
        if (!columnEl.contains(event.relatedTarget as Node | null)) columnEl.removeClass("is-drop-target");
      });
      columnEl.addEventListener("drop", (event) => {
        if (this.groupMode !== "folder") return;
        event.preventDefault();
        columnEl.removeClass("is-drop-target");
        const path = normalizePath(event.dataTransfer?.getData("text/x-qnalog-note") || "");
        const item = itemByPath.get(path);
        if (!item) return;
        void this.adapter.moveItem(item, column.path)
          .then(() => this.render())
          .catch((error) => new Notice(`${t("Move failed:")}${error instanceof Error ? error.message : String(error)}`));
      });
    }
  }

  private render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    if (!root) return;
    root.empty();
    root.addClass("qnalog-kanban-view");
    const items = this.adapter.listItems();
    this.renderToolbar(root, items.length, this.getColumns(items).length);
    this.renderBoard(root);
  }
}
