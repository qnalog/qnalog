import { Modal, Notice, setIcon, type App } from "obsidian";
import type { TopicChangePreview } from "../topics/topic-integration";
import { stripTopicUnverifiedMarker } from "../topics/topic-integration";
import { topicLabelSeparator, topicOpenKindLabel, topicSectionEnglishLabel } from "../topics/topic-page";
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
    if (this.preview.pageWasManuallyEdited) scroll.createDiv({ cls: "qnalog-topics-notice", text: this.port.text("The page may have been modified. Changes will use the current version.") });
    if (this.preview.partialFailure) scroll.createDiv({ cls: "qnalog-topics-notice is-warning", text: this.port.text("Some batches failed; {0}/{1} completed batches were kept.").replace("{0}", String(this.preview.completedBatches)).replace("{1}", String(this.preview.totalBatches)) });
    if (this.preview.create?.overviewGeneratedFromThreads) scroll.createDiv({ cls: "qnalog-topics-notice is-warning", text: this.port.text("The overview was generated from the thread summaries by the program. You can edit it on the page.") });

    const model = this.preview.create?.model || this.preview.replacement?.model;
    const validationWarnings = [...new Set([...(this.preview.validationWarnings || []), ...(model?.validationWarnings || [])])];
    if (validationWarnings.length) {
      const normalizedValues = validationWarnings.some((warning) => warning.startsWith("Unknown topic "));
      scroll.createDiv({ cls: "qnalog-topics-notice is-warning", text: this.port.text(normalizedValues ? "Unknown topic values were normalized to safe defaults." : "Some disagreement details need verification. Review the marked positions.") });
      if (validationWarnings.includes("An open item was not matched to the supporting claim and was added as a point instead.")) {
        scroll.createDiv({ cls: "qnalog-topics-notice is-warning", text: this.port.text("No matching open item was found; the claim was added as a point.") });
      }
    }
    if ((this.preview.degraded || 0) > 0) {
      scroll.createDiv({ cls: "qnalog-topics-notice is-warning", text: this.port.text("{0} changes were adjusted to fit the current page; review the affected entries.").replace("{0}", String(this.preview.degraded)) });
      scroll.createDiv({ cls: "qnalog-topics-notice is-warning", text: this.port.text("The original block could not be located. This change will be appended to the end of its section.") });
    }
    if (this.preview.programGeneratedOperations) scroll.createDiv({ cls: "qnalog-topics-notice", text: this.port.text("{0} conflict changes were completed from conflict assessments by the program.").replace("{0}", String(this.preview.programGeneratedOperations)) });
    if (this.preview.assessments?.length || this.preview.duplicateDetails?.length) {
      const details = scroll.createEl("details", { cls: "qnalog-topics-preview-assessments" });
      details.createEl("summary", { text: this.port.text("Assessment details") });
      for (const assessment of this.preview.assessments || []) {
        const relation = assessment.relation === "same" ? "Same or duplicate" : assessment.relation === "supplement" ? "Supplement" : assessment.relation === "conflict" ? "Conflict" : "Unrelated";
        details.createDiv({ cls: "qnalog-topics-preview-text", text: `${relation}: ${assessment.claim}` });
      }
      for (const duplicate of this.preview.duplicateDetails || []) {
        const key = duplicate.reason === "existing-page" ? "Duplicate point omitted because it matches an existing page point: {0}. Existing point: {1}" : "Duplicate point omitted from this update: {0}. Retained point: {1}";
        details.createDiv({ cls: "qnalog-topics-preview-text", text: this.port.text(key).replace("{0}", duplicate.discardedText).replace("{1}", duplicate.keptText) });
      }
    }
    const emptyUpdate = !this.preview.create && !this.preview.replacement && this.preview.items.length === 0 && !this.preview.legacyAnchorCleanup && !this.preview.legacyPropertyCleanup && !this.preview.legacyStatusCleanup;
    if (emptyUpdate) {
      const diagnostics = this.preview.updateDiagnostics;
      const checked = diagnostics?.rawOperations || 0;
      const duplicates = diagnostics?.duplicateOperations || 0;
      scroll.createDiv({ cls: "qnalog-topics-notice", text: this.port.text("No page changes were proposed (received {0} candidate operations; {1} duplicates).").replace("{0}", String(checked)).replace("{1}", String(duplicates)) });
    }
    if (model) {
      const group = (title: string) => {
        const section = scroll.createDiv({ cls: "qnalog-topics-preview-section" });
        section.createDiv({ cls: "qnalog-topics-preview-heading is-section", text: this.port.text(title) });
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
        threads.createDiv({ cls: "qnalog-topics-preview-heading is-thread", text: thread.title });
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
          disagreements.createDiv({ cls: "qnalog-topics-preview-heading is-thread", text: item.subject });
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
          const kind = topicOpenKindLabel(item.kind, { openQuestion: this.port.text("Topic open question"), openAction: this.port.text("Topic open action"), openBug: this.port.text("Topic open bug") });
          row.createDiv({ cls: "qnalog-topics-preview-text", text: `${kind}${topicLabelSeparator(kind)}${item.text}` });
          addReferences(row, item.sources);
        }
      }
    }

    const selected = new Set(this.preview.items.map((item) => item.id));
    if (this.preview.legacyAnchorCleanup) {
      const row = scroll.createEl("label", { cls: "qnalog-topics-preview-item" });
      const checkbox = row.createEl("input", { attr: { type: "checkbox", "aria-label": this.port.text("Clean old block markers") } });
      checkbox.checked = true;
      selected.add("__clean-legacy-markers__");
      row.createSpan({ text: this.port.text("Clean old block markers") });
      checkbox.addEventListener("change", () => checkbox.checked ? selected.add("__clean-legacy-markers__") : selected.delete("__clean-legacy-markers__"));
    }
    if (this.preview.legacyPropertyCleanup) {
      const row = scroll.createEl("label", { cls: "qnalog-topics-preview-item" });
      const checkbox = row.createEl("input", { attr: { type: "checkbox", "aria-label": this.port.text("Clean old topic properties") } });
      checkbox.checked = true;
      selected.add("__clean-legacy-properties__");
      row.createSpan({ text: this.port.text("Clean old topic properties") });
      checkbox.addEventListener("change", () => checkbox.checked ? selected.add("__clean-legacy-properties__") : selected.delete("__clean-legacy-properties__"));
    }
    if (this.preview.legacyStatusCleanup) {
      const row = scroll.createEl("label", { cls: "qnalog-topics-preview-item" });
      const checkbox = row.createEl("input", { attr: { type: "checkbox", "aria-label": this.port.text("Clean old status line") } });
      checkbox.checked = true;
      selected.add("__clean-legacy-status__");
      row.createSpan({ text: this.port.text("Clean old status line") });
      checkbox.addEventListener("change", () => checkbox.checked ? selected.add("__clean-legacy-status__") : selected.delete("__clean-legacy-status__"));
    }
    const sections = new Map<string, HTMLDivElement>();
    for (const item of this.preview.items) {
      const section = item.operation.type === "add_timeline" ? "Timeline"
        : item.operation.type === "add_conflict" || item.operation.type === "add_disagreement" ? "Disagreements and verification"
          : item.operation.type === "add_open" || item.operation.type === "resolve_open" ? "Open questions and actions"
            : item.operation.type === "add_point" || item.operation.type === "add_thread" || item.operation.type === "revise_block" ? "Progress thread"
              : item.operation.type === "add_item" ? topicSectionEnglishLabel(item.operation.section) : "Progress thread";
      let group = sections.get(section);
      if (!group) {
        group = scroll.createDiv({ cls: "qnalog-topics-preview-section" });
        group.createDiv({ cls: "qnalog-topics-preview-heading is-section", text: this.port.text(section) });
        sections.set(section, group);
      }
      // Same whole-row toggle as the create dialog: the row is a <label> around the checkbox.
      const isRevision = item.operation.type === "revise_block";
      const row = group.createEl("label", { cls: `qnalog-topics-preview-item${item.type === "add_conflict" || item.type === "add_disagreement" ? " is-conflict" : ""}${isRevision ? " is-revision" : ""}` });
      if (item.programGenerated) row.createSpan({ cls: "qnalog-topics-notice", text: this.port.text("Completed by program from conflict assessment") });
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
        const old = diff.createDiv({ cls: "qnalog-topics-revision-old" });
        old.createSpan({ cls: "qnalog-topics-revision-label", text: this.port.text("Old") });
        old.createSpan({ text: item.expectedText || "" });
        const fresh = diff.createDiv({ cls: "qnalog-topics-revision-new" });
        fresh.createSpan({ cls: "qnalog-topics-revision-label", text: this.port.text("New") });
        fresh.createSpan({ text: verification.text });
      } else if (item.operation.type === "add_disagreement") {
        main.createDiv({ cls: "qnalog-topics-preview-text", text: item.operation.subject });
        for (const position of item.operation.positions) {
          const stance = main.createDiv({ cls: `qnalog-topics-preview-item${position.provenance ? " is-unverified" : ""}` });
          const provenance = position.provenance === "source-pending" ? this.port.text("Source pending verification") : position.provenance === "unverified" ? this.port.text("Unverified") : position.provenance === "page-narrative" ? this.port.text("Page narrative") : "";
          stance.createDiv({ cls: "qnalog-topics-preview-text", text: `${position.date ? `${position.date}: ` : ""}${position.text}${provenance ? ` (${provenance})` : ""}` });
          const source = stance.createDiv({ cls: "qnalog-topics-preview-meta" });
          if (position.fromPage) source.createSpan({ cls: "qnalog-topics-preview-date", text: this.port.text("Existing page block") });
          if (position.sourceId) {
            const linkTarget = this.preview.sourceLinks?.[position.sourceId] || position.sourceId;
            const title = position.sourceTitle || /\|([^|\]]+)\]\]$/.exec(linkTarget)?.[1] || linkTarget;
            const link = source.createEl("button", { cls: "qnalog-topics-source-link", text: title, attr: { type: "button" } });
            link.addEventListener("click", () => void this.port.openSource(linkTarget));
            if (position.date) source.createSpan({ cls: "qnalog-topics-preview-date", text: position.date });
          }
        }
      } else if (item.operation.type === "resolve_open") {
        main.createDiv({ cls: "qnalog-topics-preview-text", text: `${this.port.text("Will mark this item as resolved")}: ${item.expectedText || item.operation.expectedText || item.target}` });
        main.createDiv({ cls: "qnalog-topics-preview-text", text: verification.text });
      } else {
        let changeText = verification.text;
        if (item.operation.type === "add_open") {
          const kind = topicOpenKindLabel(item.operation.kind, { openQuestion: this.port.text("Topic open question"), openAction: this.port.text("Topic open action"), openBug: this.port.text("Topic open bug") });
          changeText = `${kind}${topicLabelSeparator(kind)}${verification.text}`;
        }
        main.createDiv({ cls: "qnalog-topics-preview-text", text: changeText });
      }
      if ("blockId" in item.operation || "relatedBlockId" in item.operation) row.createDiv({ cls: "qnalog-topics-preview-meta", text: item.target });
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
    const apply = actions.createEl("button", { cls: "mod-cta", text: this.port.text(emptyUpdate ? "Add member and timeline only" : "Apply selected"), attr: { type: "button" } });
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
