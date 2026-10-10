import { Modal, Notice, type App } from "obsidian";
import type { TopicCandidate, TopicCandidates } from "../topics/topic-candidates";
import type { TopicBasis } from "../topics/topic-page";
import type { TopicsUiPort } from "./topics-ui-port";
import { defaultTopicMemberPaths, suggestTopicTitle, topicCandidateGroups } from "./topics-ui-port";
import { TopicPreviewModal } from "./topic-preview-modal";

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
    this.render();
    try {
      const estimate = await this.port.estimate({ memberPaths: [...this.selected], basis: "body" });
      this.estimateText = this.port.text("Estimated: {0} characters, {1} requests").replace("{0}", estimate.chars.toLocaleString()).replace("{1}", String(estimate.requests));
      this.estimateReady = true;
      this.render();
    } catch (error) {
      this.estimateText = error instanceof Error ? error.message : String(error);
      this.estimateReady = false;
      this.render();
    }
  }

  private render(): void {
    const content = this.contentEl;
    content.empty();
    content.addClass("qnalog-topics-create");
    content.createEl("h2", { text: this.port.text("Create topic") });
    const titleInput = content.createEl("input", { cls: "qnalog-topics-title", attr: { type: "text", placeholder: this.port.text("Topic title"), "aria-label": this.port.text("Topic title") } });
    titleInput.value = this.title;
    titleInput.addEventListener("input", () => { this.title = titleInput.value; });

    const basis = content.createDiv({ cls: "qnalog-topics-basis" });
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
    if (this.basis === "body") {
      content.createDiv({ cls: "qnalog-topics-cost-warning", text: this.port.text("Finalized body content is sent to the configured model and may use more credits.") });
      if (this.estimateText) content.createDiv({ cls: "qnalog-topics-estimate", text: this.estimateText });
    }

    if (this.loading) content.createDiv({ cls: "qnalog-topics-loading", text: this.previewController
      ? `${this.port.text("Generating preview…")} ${this.previewProgress}`
      : this.port.text("Loading candidates…") });
    if (this.candidates) {
      for (const group of topicCandidateGroups(this.candidates)) {
        const section = content.createDiv({ cls: `qnalog-topics-candidate-group is-${group.tier}` });
        section.createEl("h3", { text: `${this.port.text(GROUP_LABELS[group.tier])} (${group.items.length})` });
        for (const candidate of group.items) this.renderCandidate(section, candidate);
      }
      if (this.windowIndex < TOPIC_CANDIDATE_WINDOWS.length - 1) {
        const widen = content.createEl("button", { cls: "qnalog-topics-expand", text: this.port.text("Expand range"), attr: { type: "button" } });
        widen.addEventListener("click", () => { this.windowIndex++; void this.loadCandidates(); });
      }
    }
    const actions = content.createDiv({ cls: "qnalog-topics-modal-actions" });
    const cancel = actions.createEl("button", { text: this.port.text("Cancel"), attr: { type: "button" } });
    cancel.addEventListener("click", () => {
      this.previewController?.abort();
      this.candidateController?.abort();
      this.close();
    });
    const create = actions.createEl("button", { cls: "mod-cta", text: this.port.text(this.basis === "body" ? "Confirm and create" : "Create"), attr: { type: "button" } });
    create.disabled = this.loading || !this.candidates || this.selected.size === 0 || !this.title.trim()
      || (this.basis === "body" && !this.estimateReady);
    create.addEventListener("click", () => void this.create(create));
  }

  private renderCandidate(parent: HTMLElement, candidate: TopicCandidate): void {
    const row = parent.createDiv({ cls: "qnalog-topics-candidate" });
    const checkbox = row.createEl("input", { attr: { type: "checkbox", "aria-label": candidate.title } });
    checkbox.checked = this.selected.has(candidate.path);
    checkbox.disabled = !candidate.cancellable;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) this.selected.add(candidate.path); else this.selected.delete(candidate.path);
      if (this.basis === "body") void this.refreshEstimate();
      else this.render();
    });
    const details = row.createDiv({ cls: "qnalog-topics-candidate-details" });
    details.createDiv({ cls: "qnalog-topics-candidate-title", text: `${candidate.date ? `${candidate.date} · ` : ""}${candidate.title}` });
    const summary = details.createDiv({ cls: "qnalog-topics-candidate-summary", text: candidate.overview.slice(0, TOPIC_EXCERPT_LIMIT) });
    if (candidate.overview.length > TOPIC_EXCERPT_LIMIT) {
      const more = details.createEl("button", { text: this.port.text("Show more"), attr: { type: "button" } });
      more.addEventListener("click", () => {
        summary.setText(candidate.overview);
        more.remove();
      });
    }
    for (const reason of candidate.reasons) details.createSpan({ cls: "qnalog-topics-reason", text: reason });
    for (const tag of candidate.matchedTags) details.createSpan({ cls: "qnalog-topics-reason", text: `${this.port.text("Shared tag")}: ${tag}` });
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
      this.loading = false;
      this.previewController = null;
      this.render();
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }
}
