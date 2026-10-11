import { Modal, Notice, setIcon, type App } from "obsidian";
import type { TopicChangePreview } from "../topics/topic-integration";
import { stripTopicUnverifiedMarker } from "../topics/topic-integration";
import { topicSectionEnglishLabel } from "../topics/topic-page";
import type { TopicsUiPort } from "./topics-ui-port";
import { suppressRowActivation } from "./topic-row-activation";

export class TopicPreviewModal extends Modal {
  private readonly port: TopicsUiPort;
  private readonly preview: TopicChangePreview;
  private onApplied: (path: string) => void;
  private closed = false;
  private applied = false;

  constructor(app: App, port: TopicsUiPort, preview: TopicChangePreview, onApplied: (path: string) => void) {
    super(app);
    this.port = port;
    this.preview = preview;
    this.onApplied = onApplied;
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.applied) this.port.cancel(this.preview.topicId);
    this.contentEl.empty();
  }

  private render(): void {
    const content = this.contentEl;
    content.empty();
    content.addClass("qnalog-topics-preview");
    content.createEl("h2", { text: this.port.text("Preview topic changes") });
    const scroll = content.createDiv({ cls: "qnalog-topics-scroll" });
    if (this.preview.pageWasManuallyEdited) scroll.createDiv({ cls: "qnalog-topics-notice", text: this.port.text("The page was manually edited since the last update. Changes will use the current version.") });
    if (this.preview.partialFailure) scroll.createDiv({ cls: "qnalog-topics-notice is-warning", text: this.port.text("Some batches failed; {0}/{1} completed batches were kept.").replace("{0}", String(this.preview.completedBatches)).replace("{1}", String(this.preview.totalBatches)) });

    const model = this.preview.create?.model || this.preview.replacement?.model;
    if (model) {
      const group = (title: string) => {
        const section = scroll.createDiv({ cls: "qnalog-topics-preview-section" });
        section.createEl("h3", { text: this.port.text(title) });
        return section;
      };
      const addReferences = (parent: HTMLDivElement, sourceIds: readonly string[]) => {
        const metadata = parent.createDiv({ cls: "qnalog-topics-preview-meta" });
        for (const sourceId of [...new Set(sourceIds)]) {
          const source = this.preview.sourceLinks?.[sourceId] || sourceId;
          const title = /\|([^|\]]+)\]\]$/.exec(source)?.[1] || source.replace(/^\[\[|\]\]$/g, "").split("/").pop() || source;
          const link = metadata.createEl("button", { cls: "qnalog-topics-source-link", text: title, attr: { type: "button" } });
          link.addEventListener("click", () => void this.port.openSource(source));
          const date = this.preview.sourceDates?.[sourceId];
          if (date) metadata.createSpan({ cls: "qnalog-topics-preview-date", text: date });
        }
      };
      const overview = group("Overview");
      overview.createDiv({ cls: "qnalog-topics-preview-text", text: model.overview });
      const threads = group("Progress thread");
      for (const thread of model.threads) {
        threads.createEl("h4", { text: thread.title });
        threads.createDiv({ cls: "qnalog-topics-preview-text", text: thread.summary });
        for (const point of thread.points) {
          const row = threads.createDiv({ cls: "qnalog-topics-preview-item" });
          row.createDiv({ cls: "qnalog-topics-preview-text", text: point.text });
          addReferences(row, point.sources);
        }
      }
      if (model.disagreements.length) {
        const disagreements = group("Disagreements and verification");
        for (const item of model.disagreements) {
          disagreements.createEl("h4", { text: item.subject });
          for (const position of item.positions) {
            const row = disagreements.createDiv({ cls: "qnalog-topics-preview-item is-conflict" });
            row.createDiv({ cls: "qnalog-topics-preview-text", text: position.text });
            addReferences(row, [position.sourceId]);
          }
        }
      }
      if (model.open.length) {
        const open = group("Open questions and actions");
        for (const item of model.open) {
          const row = open.createDiv({ cls: "qnalog-topics-preview-item" });
          row.createDiv({ cls: "qnalog-topics-preview-text", text: (item.kind ? item.kind + ": " : "") + item.text });
          addReferences(row, item.sources);
        }
      }
    }

    const selected = new Set(this.preview.items.map((item) => item.id));
    const sections = new Map<string, HTMLDivElement>();
    for (const item of this.preview.items) {
      const section = item.operation.type === "add_timeline" ? "Timeline"
        : item.operation.type === "add_conflict" || item.operation.type === "add_disagreement" ? "Disagreements and verification"
          : item.operation.type === "add_open" || item.operation.type === "resolve_open" ? "Open questions and actions"
            : item.operation.type === "add_point" || item.operation.type === "add_thread" || item.operation.type === "revise_block" ? "Progress thread"
              : item.operation.type === "add_item" ? topicSectionEnglishLabel(item.operation.section) : "Current status";
      let group = sections.get(section);
      if (!group) {
        group = scroll.createDiv({ cls: "qnalog-topics-preview-section" });
        group.createEl("h3", { text: this.port.text(section) });
        sections.set(section, group);
      }
      // Same whole-row toggle as the create dialog: the row is a <label> around the checkbox.
      const isRevision = item.operation.type === "revise_block";
      const row = group.createEl("label", { cls: `qnalog-topics-preview-item${item.type === "add_conflict" || item.type === "add_disagreement" ? " is-conflict" : ""}${isRevision ? " is-revision" : ""}` });
      const main = row.createDiv({ cls: "qnalog-topics-preview-main" });
      const checkbox = main.createEl("input", { attr: { type: "checkbox", "aria-label": this.port.text("Include this change") } });
      row.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (suppressRowActivation({ onCheckbox: target === checkbox, onInteractive: !!target?.closest("button, a"), selectedText: window.getSelection()?.toString() ?? "", disabled: false })) event.preventDefault();
      });
      checkbox.checked = true;
      checkbox.addEventListener("change", () => checkbox.checked ? selected.add(item.id) : selected.delete(item.id));
      const icon = main.createSpan({ cls: "qnalog-topics-operation-icon" });
      const iconName = item.type === "add_conflict" || item.type === "add_disagreement" ? "alert-triangle" : item.type === "add_timeline" ? "clock-3" : item.type === "resolve_question" || item.type === "resolve_open" ? "check-circle-2" : item.type === "annotate_item" || item.type === "add_point" ? "message-square-plus" : item.type === "revise_block" ? "pencil" : "plus";
      try { setIcon(icon, iconName); } catch { /* icon fallback is decorative */ }
      const verification = stripTopicUnverifiedMarker(item.text);
      if (item.operation.type === "revise_block") {
        const diff = main.createDiv({ cls: "qnalog-topics-revision" });
        diff.createDiv({ cls: "qnalog-topics-revision-old", text: item.expectedText || "" });
        diff.createDiv({ cls: "qnalog-topics-revision-new", text: verification.text });
      } else main.createDiv({ cls: "qnalog-topics-preview-text", text: verification.text });
      const metadata = row.createDiv({ cls: "qnalog-topics-preview-meta" });
      const source = this.preview.sourceLinks?.[item.sourceId] || item.sourceId;
      const title = /\|([^|\]]+)\]\]$/.exec(source)?.[1] || source.replace(/^\[\[|\]\]$/g, "").split("/").pop() || source;
      const link = metadata.createEl("button", { cls: "qnalog-topics-source-link", text: title, attr: { type: "button" } });
      link.addEventListener("click", () => void this.port.openSource(source));
      const date = this.preview.sourceDates?.[item.sourceId];
      if (date) metadata.createSpan({ cls: "qnalog-topics-preview-date", text: date });
      if (item.type === "add_conflict" || item.type === "add_disagreement") metadata.createSpan({ cls: "qnalog-topics-preview-badge is-conflict", text: this.port.text("Disagreement") });
      if (verification.unverified) metadata.createSpan({ cls: "qnalog-topics-unverified", text: this.port.text("Unverified") });
    }

    const footer = content.createDiv({ cls: "qnalog-topics-modal-footer" });
    const actions = footer.createDiv({ cls: "qnalog-topics-modal-actions" });
    const cancel = actions.createEl("button", { text: this.port.text("Cancel"), attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const apply = actions.createEl("button", { cls: "mod-cta", text: this.port.text("Apply selected"), attr: { type: "button" } });
    apply.addEventListener("click", () => {
      apply.disabled = true;
      void this.port.apply(this.preview, [...selected]).then(async (result) => {
        this.applied = true;
        this.close();
        if (result.pageChangedDuringGeneration) new Notice(this.port.text("The topic page changed during generation. Changes were positioned on the latest version."));
        if (result.skipped?.length) new Notice(this.port.text("Some revisions were skipped because their blocks changed: {0}").replace("{0}", result.skipped.map((item) => item.id).join(", ")), 8000);
        await this.port.openTopic(result.path);
        if (this.preview.create) new Notice(this.port.text("Topic created."), 6000);
        else {
          const notice = new Notice(this.port.text("Topic updated. Undo is available."), 10000);
          const undo = notice.messageEl.createEl("button", { cls: "qnalog-topics-undo", text: this.port.text("Undo"), attr: { type: "button" } });
          undo.addEventListener("click", () => {
            void this.port.undoLastUpdate(this.preview.topicId).then((outcome) => {
              if (outcome.restored === true) new Notice(this.port.text("Topic update undone."));
              else new Notice(outcome.reason === "page-modified" ? this.port.text("The topic page changed after the update. Undo was not applied.") : this.port.text("No topic update is available to undo."));
            });
          });
        }
        this.onApplied(result.path);
      }).catch((error: unknown) => {
        apply.disabled = false;
        new Notice(error instanceof Error ? error.message : "Topic update failed.", 8000);
      });
    });
  }
}
