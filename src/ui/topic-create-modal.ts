import { Modal, Notice, type App } from "obsidian";
import type { TopicCandidate, TopicCandidates } from "../topics/topic-candidates";
import type { TopicBasis } from "../topics/topic-page";
import type { TopicsUiPort } from "./topics-ui-port";
import { defaultTopicMemberPaths, formatTopicCandidateReasons, suggestTopicTitle, topicCandidateGroups } from "./topics-ui-port";
import { cleanTopicOverviewExcerpt } from "../topics/topic-overview-display";
import { TopicPreviewModal } from "./topic-preview-modal";
import { suppressRowActivation } from "./topic-row-activation";

const TOPIC_CANDIDATE_WINDOWS = [90, 180, 365] as const;
const TOPIC_EXCERPT_LIMIT = 120;
const GROUP_LABELS = { project: "Project tags", topic: "Topic tags", content: "Similar content" } as const;

export class TopicCreateModal extends Modal {
  private readonly port: TopicsUiPort;
  private readonly startPath: string;
  private candidates: TopicCandidates | null = null;
  private selected = new Set<string>();
  private windowIndex = 0;
  private basis: TopicBasis = "overview";
  private title = "";
  private loading = false;
  private estimateText = "";
  private onApplied: () => void;
  private previewController: AbortController | null = null;
  private candidateController: AbortController | null = null;
  private previewProgress = "";
  private topicTitles = new Map<string, string>();
  private estimateReady = false;
  // Elements kept between selection changes so a toggle updates them without rebuilding the list.
  private scrollEl: HTMLElement | null = null;
  private groupHeadings = new Map<TopicCandidate["tier"], HTMLElement>();
  private estimateEl: HTMLElement | null = null;
  private createButton: HTMLButtonElement | null = null;

  constructor(app: App, port: TopicsUiPort, startPath: string, onApplied: () => void = () => undefined) {
    super(app);
    this.port = port;
    this.startPath = startPath;
    this.onApplied = onApplied;
  }

  onOpen(): void { void this.loadCandidates(); }

  onClose(): void { this.previewController?.abort(); this.candidateController?.abort(); this.contentEl.empty(); }

  private async loadCandidates(): Promise<void> {
    this.candidateController?.abort();
    this.candidateController = new AbortController();
    this.loading = true;
    this.render();
    try {
      const result = await this.port.getCandidates(this.startPath, { windowDays: TOPIC_CANDIDATE_WINDOWS[this.windowIndex], signal: this.candidateController.signal });
      if (this.candidateController.signal.aborted) return;
      this.candidateController = null;
      this.candidates = result;
      this.topicTitles = new Map((await this.port.listTopics()).map(({ page }) => [page.id, page.title]));
      this.selected = new Set(defaultTopicMemberPaths(result));
      const start = [...result.project, ...result.topic, ...result.content].find((candidate) => candidate.path === this.startPath);
      this.title = this.title || suggestTopicTitle(start);
      this.loading = false;
      this.render();
      if (this.basis === "body") await this.refreshEstimate();
    } catch (error) {
      if (this.candidateController?.signal.aborted) return;
      this.candidateController = null;
      this.loading = false;
      this.render();
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }

  private async refreshEstimate(): Promise<void> {
    if (!this.candidates) return;
    this.estimateReady = false;
    this.updateSelectionUi();
    try {
      const estimate = await this.port.estimate({ memberPaths: [...this.selected], basis: "body" });
      this.estimateText = this.port.text("Estimated: {0} characters, {1} requests").replace("{0}", estimate.chars.toLocaleString()).replace("{1}", String(estimate.requests));
      this.estimateReady = true;
    } catch (error) {
      this.estimateText = error instanceof Error ? error.message : String(error);
      this.estimateReady = false;
    }
    this.updateSelectionUi();
  }

  private render(): void {
    const content = this.contentEl;
    // Full redraws (candidate expansion, loading, basis change) keep the list position.
    const previousScroll = this.scrollEl?.scrollTop ?? 0;
    content.empty();
    content.addClass("qnalog-topics-create");
    content.createEl("h2", { text: this.port.text("Create topic") });
    const scroll = content.createDiv({ cls: "qnalog-topics-scroll" });
    this.scrollEl = scroll;
    const titleInput = scroll.createEl("input", { cls: "qnalog-topics-title", attr: { type: "text", placeholder: this.port.text("Topic title"), "aria-label": this.port.text("Topic title") } });
    titleInput.value = this.title;
    titleInput.addEventListener("input", () => { this.title = titleInput.value; this.updateSelectionUi(); });

    const basis = scroll.createDiv({ cls: "qnalog-topics-basis" });
    for (const [value, label] of [["overview", "Overview"], ["body", "Finalized body"]] as const) {
      const option = basis.createEl("label", { cls: "qnalog-topics-radio" });
      const radio = option.createEl("input", { attr: { type: "radio", name: "qnalog-topic-basis", value } });
      radio.checked = this.basis === value;
      radio.addEventListener("change", () => {
        this.basis = value;
        this.estimateText = "";
        this.render();
        if (value === "body") void this.refreshEstimate();
      });
      option.createSpan({ text: this.port.text(label) });
    }
    this.estimateEl = null;
    if (this.basis === "body") {
      scroll.createDiv({ cls: "qnalog-topics-cost-warning", text: this.port.text("Finalized body content is sent to the configured model and may use more credits.") });
      this.estimateEl = scroll.createDiv({ cls: "qnalog-topics-estimate", text: this.estimateText });
    }

    if (this.loading) scroll.createDiv({ cls: "qnalog-topics-loading", text: this.previewController
      ? `${this.port.text("Generating preview…")} ${this.previewProgress}`
      : this.port.text("Loading candidates…") });
    this.groupHeadings.clear();
    if (this.candidates) {
      for (const group of topicCandidateGroups(this.candidates)) {
        const section = scroll.createDiv({ cls: `qnalog-topics-candidate-group is-${group.tier}` });
        this.groupHeadings.set(group.tier, section.createEl("h3"));
        for (const candidate of group.items) this.renderCandidate(section, candidate);
      }
    }
    const footer = content.createDiv({ cls: "qnalog-topics-modal-footer" });
    if (this.candidates && this.windowIndex < TOPIC_CANDIDATE_WINDOWS.length - 1) {
      const widen = footer.createEl("button", { cls: "qnalog-topics-expand", text: this.port.text("Expand range"), attr: { type: "button" } });
      widen.addEventListener("click", () => { this.windowIndex++; void this.loadCandidates(); });
    }
    const actions = footer.createDiv({ cls: "qnalog-topics-modal-actions" });
    const cancel = actions.createEl("button", { text: this.port.text("Cancel"), attr: { type: "button" } });
    cancel.addEventListener("click", () => {
      this.previewController?.abort();
      this.candidateController?.abort();
      this.close();
    });
    const create = actions.createEl("button", { cls: "mod-cta", text: this.port.text(this.basis === "body" ? "Confirm and create" : "Create"), attr: { type: "button" } });
    this.createButton = create;
    create.addEventListener("click", () => void this.create(create));
    this.updateSelectionUi();
    scroll.scrollTop = previousScroll;
  }

  /** Updates headings, estimate and the create button in place; never rebuilds candidate rows. */
  private updateSelectionUi(): void {
    if (this.candidates) {
      for (const group of topicCandidateGroups(this.candidates)) {
        const heading = this.groupHeadings.get(group.tier);
        if (!heading) continue;
        const picked = group.items.filter((item) => this.selected.has(item.path)).length;
        const label = this.port.text(GROUP_LABELS[group.tier]);
        const count = this.port.text("Selected {0} of {1}").replace("{0}", String(picked)).replace("{1}", String(group.items.length));
        heading.setText(`${label} · ${count}`);
      }
    }
    if (this.estimateEl) this.estimateEl.setText(this.estimateText);
    if (this.createButton) {
      this.createButton.disabled = this.loading || !this.candidates || this.selected.size === 0 || !this.title.trim()
        || (this.basis === "body" && !this.estimateReady);
    }
  }

  private renderCandidate(parent: HTMLElement, candidate: TopicCandidate): void {
    // The whole row is a <label>: a click on any text toggles the checkbox once, and Space works on the focused checkbox.
    const row = parent.createEl("label", {
      cls: candidate.cancellable ? "qnalog-topics-candidate" : "qnalog-topics-candidate is-disabled",
      attr: candidate.cancellable ? {} : { "aria-disabled": "true" },
    });
    const checkbox = row.createEl("input", { attr: { type: "checkbox", "aria-label": candidate.title } });
    checkbox.checked = this.selected.has(candidate.path);
    checkbox.disabled = !candidate.cancellable;
    row.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const cancel = suppressRowActivation({
        onCheckbox: target === checkbox,
        onInteractive: !!target?.closest("button, a"),
        selectedText: window.getSelection()?.toString() ?? "",
        disabled: checkbox.disabled,
      });
      if (cancel) event.preventDefault();
    });
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) this.selected.add(candidate.path);
      else this.selected.delete(candidate.path);
      if (this.basis === "body") void this.refreshEstimate();
      else this.updateSelectionUi();
    });
    const details = row.createDiv({ cls: "qnalog-topics-candidate-details" });
    details.createDiv({ cls: "qnalog-topics-candidate-title", text: `${candidate.date ? `${candidate.date} · ` : ""}${candidate.title}` });
    const cleanOverview = cleanTopicOverviewExcerpt(candidate.overview);
    const summary = details.createDiv({ cls: "qnalog-topics-candidate-summary", text: cleanOverview.slice(0, TOPIC_EXCERPT_LIMIT) });
    if (candidate.overview.length > TOPIC_EXCERPT_LIMIT) {
      const more = details.createEl("button", { text: this.port.text("Show more"), attr: { type: "button" } });
      more.addEventListener("click", () => {
        summary.setText(cleanOverview);
        more.remove();
      });
    }
    for (const reason of formatTopicCandidateReasons(candidate, (key) => this.port.text(key))) details.createSpan({ cls: "qnalog-topics-reason", text: reason });
    for (const topicId of candidate.alreadyInTopics) details.createSpan({ cls: "qnalog-topics-membership", text: `${this.port.text("Already in topic")} “${this.topicTitles.get(topicId) || topicId}”` });
    if (candidate.missingOverview) details.createSpan({ cls: "qnalog-topics-missing", text: this.port.text("Overview missing") });
  }

  private async create(button: HTMLButtonElement): Promise<void> {
    if (this.loading || !this.selected.size) return;
    this.loading = true;
    this.previewController = new AbortController();
    button.disabled = true;
    this.render();
    try {
      const preview = await this.port.preview({
        startPath: this.startPath,
        memberPaths: [...this.selected],
        basis: this.basis,
        title: this.title.trim(),
        bodyConfirmed: this.basis === "body",
        signal: this.previewController.signal,
        onProgress: (completed, total) => {
          this.previewProgress = this.port.text("Completed {0}/{1} batches").replace("{0}", String(completed)).replace("{1}", String(total));
          this.render();
        },
      });
      this.previewController = null;
      this.close();
      new TopicPreviewModal(this.app, this.port, preview, () => this.onApplied()).open();
    } catch (error) {
      if (this.previewController?.signal.aborted) { this.loading = false; this.previewController = null; return; }
      this.loading = false;
      this.previewController = null;
      this.render();
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }
}
