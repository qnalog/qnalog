import { Modal, Notice, type App } from "obsidian";
import type { TopicCandidate, TopicCandidates } from "../topics/topic-candidates";
import type { TopicBasis } from "../topics/topic-page";
import type { TopicsUiPort } from "./topics-ui-port";
import { defaultTopicMemberPaths, formatTopicCandidateReasons, suggestTopicTitle, topicCandidateGroups } from "./topics-ui-port";
import { cleanTopicOverviewExcerpt } from "../topics/topic-overview-display";
import { TopicPreviewModal } from "./topic-preview-modal";
import { suppressRowActivation } from "./topic-row-activation";
import { elapsedSeconds, previewProgressView } from "./topic-preview-progress";
import type { TopicPreviewProgress } from "../topics/topics-service";

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
  private mode: "list" | "generating" | "failed" = "list";
  private failure = "";
  private progress: TopicPreviewProgress | null = null;
  private startedAt = 0;
  private timer: number | null = null;
  private progressBar: HTMLElement | null = null;
  private progressFill: HTMLElement | null = null;
  private progressText: HTMLElement | null = null;
  private elapsedEl: HTMLElement | null = null;
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

  onClose(): void {
    this.stopTimer();
    this.previewController?.abort();
    this.candidateController?.abort();
    this.contentEl.empty();
  }

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
    if (this.mode === "generating") { this.renderGenerating(); return; }
    if (this.mode === "failed") { this.renderFailed(); return; }
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

    if (this.loading) scroll.createDiv({ cls: "qnalog-topics-loading", text: this.port.text("Loading candidates…") });
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
      this.candidateController?.abort();
      this.close();
    });
    const create = actions.createEl("button", { cls: "mod-cta", text: this.port.text(this.basis === "body" ? "Confirm and create" : "Create"), attr: { type: "button" } });
    this.createButton = create;
    create.addEventListener("click", () => void this.create());
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

  private async create(): Promise<void> {
    if (this.mode === "generating" || this.loading || !this.selected.size) return;
    const controller = new AbortController();
    this.previewController = controller;
    this.progress = null;
    this.startedAt = Date.now();
    this.mode = "generating";
    this.startTimer();
    this.render();
    try {
      const preview = await this.port.preview({
        startPath: this.startPath,
        memberPaths: [...this.selected],
        basis: this.basis,
        title: this.title.trim(),
        bodyConfirmed: this.basis === "body",
        signal: controller.signal,
        onProgress: (progress) => {
          if (this.previewController !== controller) return;
          this.progress = progress;
          this.updateProgressUi();
        },
      });
      // Cancelled or closed while the request was running: the result is dropped.
      if (this.previewController !== controller) return;
      this.previewController = null;
      this.stopTimer();
      this.close();
      new TopicPreviewModal(this.app, this.port, preview, () => this.onApplied()).open();
    } catch {
      if (this.previewController !== controller) return;
      this.previewController = null;
      this.stopTimer();
      this.failure = this.port.text("The topic page could not be generated. You can retry. The page was not modified.");
      this.mode = "failed";
      this.render();
    }
  }

  /** Stops the request, returns to the candidate list, and keeps the selection and title. */
  private cancelGeneration(): void {
    const controller = this.previewController;
    this.previewController = null;
    controller?.abort();
    this.stopTimer();
    this.mode = "list";
    this.render();
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = window.setInterval(() => this.updateProgressUi(), 1000);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }

  private renderGenerating(): void {
    const content = this.contentEl;
    content.empty();
    content.addClass("qnalog-topics-create");
    content.createEl("h2", { text: this.port.text("Generating preview") });
    const box = content.createDiv({ cls: "qnalog-topics-generating", attr: { "aria-busy": "true" } });
    const basisLabel = this.port.text(this.basis === "body" ? "Finalized body" : "Overview");
    const notes = this.port.text("{0} notes").replace("{0}", String(this.selected.size));
    box.createDiv({ cls: "qnalog-topics-generating-basis", text: this.port.text("Basis: {0} · {1}").replace("{0}", basisLabel).replace("{1}", notes) });
    this.progressBar = box.createDiv({ cls: "qnalog-topics-progress", attr: { role: "progressbar", "aria-label": this.port.text("Generating preview"), "aria-valuemin": "0" } });
    this.progressFill = this.progressBar.createDiv({ cls: "qnalog-topics-progress-fill" });
    this.progressText = box.createDiv({ cls: "qnalog-topics-progress-text", attr: { "aria-live": "polite" } });
    this.elapsedEl = box.createDiv({ cls: "qnalog-topics-progress-elapsed" });
    if (this.basis === "body") box.createDiv({ cls: "qnalog-topics-cost-warning", text: this.port.text("Finalized body is long and may take several minutes.") });
    const footer = content.createDiv({ cls: "qnalog-topics-modal-footer" });
    const actions = footer.createDiv({ cls: "qnalog-topics-modal-actions" });
    const cancel = actions.createEl("button", { text: this.port.text("Cancel"), attr: { type: "button" } });
    cancel.addEventListener("click", () => this.cancelGeneration());
    this.updateProgressUi();
  }

  /** Updates the bar, batch text and elapsed time in place; called on each progress report and once a second. */
  private updateProgressUi(): void {
    if (!this.progressBar || !this.progressFill || !this.progressText || !this.elapsedEl) return;
    const view = previewProgressView(this.progress);
    this.progressBar.classList.toggle("is-indeterminate", !view.determinate);
    if (view.determinate) {
      this.progressBar.setAttribute("aria-valuenow", String(view.completed));
      this.progressBar.setAttribute("aria-valuemax", String(view.total));
      this.progressFill.setCssProps({ "--qnalog-topics-progress": `${Math.round(view.fraction * 100)}%` });
      this.progressText.setText(this.port.text("Batch {0}/{1}").replace("{0}", String(view.completed)).replace("{1}", String(view.total)));
    } else {
      this.progressBar.removeAttribute("aria-valuenow");
      this.progressBar.removeAttribute("aria-valuemax");
      this.progressFill.setCssProps({ "--qnalog-topics-progress": "" });
      this.progressText.setText(this.port.text("Processing…"));
    }
    const seconds = elapsedSeconds(this.startedAt, Date.now());
    this.elapsedEl.setText(this.port.text("Elapsed {0} s").replace("{0}", String(seconds)));
  }

  private renderFailed(): void {
    const content = this.contentEl;
    content.empty();
    content.addClass("qnalog-topics-create");
    content.createEl("h2", { text: this.port.text("Generation failed") });
    content.createDiv({ cls: "qnalog-topics-notice is-warning", text: this.failure.slice(0, 240) });
    content.createDiv({ cls: "qnalog-topics-notice", text: this.port.text("Your selection and title are kept. Retry, or go back to change the selection.") });
    const footer = content.createDiv({ cls: "qnalog-topics-modal-footer" });
    const actions = footer.createDiv({ cls: "qnalog-topics-modal-actions" });
    const back = actions.createEl("button", { text: this.port.text("Back to candidates"), attr: { type: "button" } });
    back.addEventListener("click", () => { this.mode = "list"; this.render(); });
    const retry = actions.createEl("button", { cls: "mod-cta qnalog-topics-retry", text: this.port.text("Retry"), attr: { type: "button" } });
    retry.addEventListener("click", () => void this.create());
  }
}
