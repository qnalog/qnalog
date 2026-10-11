import { Menu, Modal, Notice, setIcon, type App } from "obsidian";
import type { TopicCandidate, TopicCandidates } from "../topics/topic-candidates";
import type { TopicsUiPort } from "./topics-ui-port";
import { TopicPreviewModal } from "./topic-preview-modal";
import { topicCandidateGroups } from "./topics-ui-port";
import { formatTopicCandidateReasons } from "./topics-ui-port";
import { qnalogConfirm } from "./helpers";
import { cleanTopicOverviewExcerpt } from "../topics/topic-overview-display";
import { suppressRowActivation } from "./topic-row-activation";

export class TopicsPanel {
  private readonly app: App;
  private readonly port: TopicsUiPort;
  private readonly refresh: () => void;
  private readonly activePath: string;

  constructor(app: App, port: TopicsUiPort, refresh: () => void, activePath = "") {
    this.app = app;
    this.port = port;
    this.refresh = refresh;
    this.activePath = activePath;
  }

  async render(root: HTMLElement): Promise<void> {
    const box = root.createDiv({ cls: "qnalog-topics-panel" });
    if (!this.port.isConfigured()) {
      this.renderEmpty(box);
      return;
    }
    try {
      const topics = await this.port.listTopics();
      if (!topics.length) {
        this.renderEmpty(box);
        return;
      }
      for (const topic of topics) {
        // The row of the note open in the editor is highlighted; the highlight does not move the list.
        const isActive = !!this.activePath && topic.path === this.activePath;
        const row = box.createDiv({ cls: `qnalog-topics-row${isActive ? " is-active" : ""}`, attr: { tabindex: "0", role: "button" } });
        row.addEventListener("click", () => void this.port.openTopic(topic.path));
        row.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void this.port.openTopic(topic.path); }
        });
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.showTopicMenu(event, topic.page.id, topic.page.title);
        });
        const heading = row.createDiv({ cls: "qnalog-topics-row-heading" });
        heading.createDiv({ cls: "qnalog-topics-row-title", text: topic.page.title });
        heading.createDiv({ cls: "qnalog-topics-row-members", text: this.port.text("{0} members").replace("{0}", String(topic.page.members.length)) });
        row.createDiv({ cls: "qnalog-topics-row-date", text: new Date(topic.page.updated).toLocaleDateString() });
        const badge = row.createSpan({ cls: "qnalog-topics-pending" });
        void this.port.countPending(topic.page.id).then((count) => {
          if (count > 0) { badge.setText(this.port.text("{0} pending").replace("{0}", String(count))); badge.addClass("is-visible"); }
          else badge.remove();
        }).catch(() => badge.remove());
      }
    } catch {
      this.renderEmpty(box);
    }
  }

  private renderEmpty(root: HTMLElement): void {
    const empty = root.createDiv({ cls: "qnalog-empty-state qnalog-topics-empty" });
    const icon = empty.createDiv({ cls: "qnalog-empty-state-icon" });
    try { setIcon(icon, "layers-3"); } catch { /* optional icon */ }
    empty.createDiv({ cls: "qnalog-empty-state-title", text: this.port.text("No topics yet") });
    empty.createDiv({ cls: "qnalog-empty-state-desc", text: this.port.text("Right-click a minutes note and choose Create topic.") });
  }

  private showTopicMenu(event: MouseEvent, topicId: string, title: string): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(this.port.text("Scan for notes to integrate")).setIcon("scan-search").onClick(() => void this.scan(topicId)));
    menu.addItem((item) => item.setTitle(this.port.text("Undo last update")).setIcon("undo-2").onClick(() => {
      void this.port.undoLastUpdate(topicId).then((result) => {
        if (result.restored === true) new Notice(this.port.text("Topic update undone."));
        else new Notice(result.reason === "page-modified" ? this.port.text("The topic page changed after the update. Undo was not applied.") : this.port.text("No topic update is available to undo."));
        this.refresh();
      });
    }));
    menu.addItem((item) => item.setTitle(this.port.text("Merge into…")).setIcon("git-merge").onClick(() => void this.chooseMergeTarget(topicId, event)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(this.port.text("Delete topic")).setIcon("trash").onClick(async () => {
      const confirmed = await qnalogConfirm(this.app, this.port.text("Delete topic"), this.port.text("Delete only the topic page “{0}”? No minutes notes will be deleted.").replace("{0}", title), this.port.text("Delete"));
      if (!confirmed) return;
      await this.port.deleteTopic(topicId);
      this.refresh();
    }));
    menu.showAtMouseEvent(event);
  }

  private async chooseMergeTarget(sourceId: string, event: MouseEvent): Promise<void> {
    const topics = (await this.port.listTopics()).filter((item) => item.page.id !== sourceId);
    if (!topics.length) { new Notice(this.port.text("No other topic is available.")); return; }
    const menu = new Menu();
    for (const topic of topics) menu.addItem((item) => item.setTitle(topic.page.title).onClick(async () => {
      const confirmed = await qnalogConfirm(this.app, this.port.text("Merge topics"), this.port.text("Add these members to “{0}” and move the source topic page to the trash?").replace("{0}", topic.page.title), this.port.text("Merge"));
      if (!confirmed) return;
      await this.port.mergeTopics(sourceId, topic.page.id);
      this.refresh();
    }));
    menu.showAtMouseEvent(event);
  }

  private async scan(topicId: string): Promise<void> {
    new TopicScanModal(this.app, this.port, topicId, this.refresh).open();
  }
}

class TopicScanModal extends Modal {
  private readonly port: TopicsUiPort;
  private readonly topicId: string;
  private readonly refresh: () => void;
  private candidates: TopicCandidates = { project: [], topic: [], content: [], byTag: [], byContent: [] };
  private readonly selected = new Set<string>();
  private startPath = "";
  private loading = true;
  private previewing = false;
  private progress = "";
  private scanController: AbortController | null = null;
  private previewController: AbortController | null = null;
  private topicTitles = new Map<string, string>();
  private previewButton: HTMLButtonElement | null = null;

  constructor(app: App, port: TopicsUiPort, topicId: string, refresh: () => void) {
    super(app);
    this.port = port;
    this.topicId = topicId;
    this.refresh = refresh;
  }

  onOpen(): void { void this.load(); }

  onClose(): void {
    this.scanController?.abort();
    if (this.previewController) this.port.cancel(this.topicId);
    this.previewController?.abort();
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.scanController = new AbortController();
    this.render();
    try {
      this.candidates = await this.port.scanUnintegrated(this.topicId, this.scanController.signal);
      if (this.scanController.signal.aborted) return;
      this.topicTitles = new Map((await this.port.listTopics()).map(({ page }) => [page.id, page.title]));
      if (this.scanController.signal.aborted) return;
      this.scanController = null;
      for (const candidate of [...this.candidates.project, ...this.candidates.topic, ...this.candidates.content]) {
        if (!candidate.defaultSelected) continue;
        this.selected.add(candidate.path);
        if (!this.startPath) this.startPath = candidate.path;
      }
      this.loading = false;
      this.render();
    } catch (error) {
      if (this.scanController?.signal.aborted) return;
      this.scanController = null;
      this.loading = false;
      this.render();
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.addClass("qnalog-topics-create");
    this.contentEl.createEl("h2", { text: this.port.text("Scan for notes to integrate") });
    const scroll = this.contentEl.createDiv({ cls: "qnalog-topics-scroll" });
    if (this.loading || this.previewing) {
      const label = this.loading ? this.port.text("Loading candidates…") : `${this.port.text("Generating preview…")} ${this.progress}`;
      scroll.createDiv({ cls: "qnalog-topics-loading", text: label });
    }
    for (const group of topicCandidateGroups(this.candidates)) {
      const section = scroll.createDiv({ cls: `qnalog-topics-candidate-group is-${group.tier}` });
      section.createEl("h3", { text: `${this.port.text(group.tier === "project" ? "Project tags" : group.tier === "topic" ? "Topic tags" : "Similar content")} (${group.items.length})` });
      for (const candidate of group.items) this.renderCandidate(section, candidate);
    }
    const footer = this.contentEl.createDiv({ cls: "qnalog-topics-modal-footer" });
    const actions = footer.createDiv({ cls: "qnalog-topics-modal-actions" });
    const cancel = actions.createEl("button", { text: this.port.text("Cancel"), attr: { type: "button" } });
    cancel.addEventListener("click", () => {
      this.scanController?.abort();
      this.previewController?.abort();
      this.close();
    });
    this.previewButton = actions.createEl("button", { cls: "mod-cta", text: this.port.text("Preview changes"), attr: { type: "button" } });
    this.updatePreviewButton();
    this.previewButton.addEventListener("click", () => void this.generatePreview());
  }

  /** Keeps the list in place on toggle: only the preview button state changes. */
  private updatePreviewButton(): void {
    if (this.previewButton) this.previewButton.disabled = this.loading || this.previewing || !this.selected.size;
  }

  private renderCandidate(parent: HTMLElement, candidate: TopicCandidate): void {
    // Whole-row toggle, as in the create dialog: the row is a <label> around the checkbox.
    const row = parent.createEl("label", { cls: "qnalog-topics-candidate" });
    const input = row.createEl("input", { attr: { type: "checkbox", "aria-label": candidate.title } });
    input.checked = this.selected.has(candidate.path);
    row.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (suppressRowActivation({ onCheckbox: target === input, onInteractive: !!target?.closest("button, a"), selectedText: window.getSelection()?.toString() ?? "", disabled: false })) event.preventDefault();
    });
    input.addEventListener("change", () => {
      if (input.checked) { this.selected.add(candidate.path); if (!this.startPath) this.startPath = candidate.path; }
      else this.selected.delete(candidate.path);
      this.updatePreviewButton();
    });
    row.createDiv({ cls: "qnalog-topics-candidate-title", text: `${candidate.date ? `${candidate.date} · ` : ""}${candidate.title}` });
    const cleanOverview = cleanTopicOverviewExcerpt(candidate.overview);
    const summary = row.createDiv({ cls: "qnalog-topics-candidate-summary", text: cleanOverview.slice(0, 120) });
    if (candidate.overview.length > 120) {
      const more = row.createEl("button", { text: this.port.text("Show more"), attr: { type: "button" } });
      more.addEventListener("click", () => { summary.setText(cleanOverview); more.remove(); });
    }
    for (const reason of formatTopicCandidateReasons(candidate, (key) => this.port.text(key))) row.createSpan({ cls: "qnalog-topics-reason", text: reason });
    for (const topicId of candidate.alreadyInTopics) row.createSpan({ cls: "qnalog-topics-membership", text: `${this.port.text("Already in topic")} “${this.topicTitles.get(topicId) || topicId}”` });
    if (candidate.missingOverview) row.createSpan({ cls: "qnalog-topics-missing", text: this.port.text("Overview missing") });
  }

  private async generatePreview(): Promise<void> {
    if (!this.startPath || !this.selected.size) return;
    this.previewing = true;
    this.previewController = new AbortController();
    this.render();
    try {
      const preview = await this.port.preview({
        startPath: this.startPath,
        memberPaths: [...this.selected],
        basis: "overview",
        topicId: this.topicId,
        signal: this.previewController.signal,
        onProgress: ({ completed, total }) => {
          this.progress = this.port.text("Completed {0}/{1} batches").replace("{0}", String(completed)).replace("{1}", String(total));
          this.render();
        },
      });
      this.previewController = null;
      this.close();
      new TopicPreviewModal(this.app, this.port, preview, () => this.refresh()).open();
    } catch (error) {
      if (this.previewController?.signal.aborted) return;
      this.previewController = null;
      this.previewing = false;
      this.render();
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }
}
