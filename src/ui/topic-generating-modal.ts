import { Modal, type App } from "obsidian";
import type { TopicsUiPort } from "./topics-ui-port";

export class TopicGeneratingModal extends Modal {
  private readonly port: TopicsUiPort;
  private cancelled = false;

  constructor(app: App, port: TopicsUiPort) {
    super(app);
    this.port = port;
  }

  get isCancelled(): boolean { return this.cancelled; }

  onOpen(): void {
    this.titleEl.setText(this.port.text("QnALog · Topics"));
    this.contentEl.empty();
    this.contentEl.addClass("qnalog-topics-create");
    this.contentEl.addClass("is-generating");
    this.contentEl.createDiv({ cls: "qnalog-topics-dialog-heading", text: this.port.text("Generating preview") });
    this.contentEl.createDiv({ cls: "qnalog-topics-generating" })
      .createDiv({ cls: "qnalog-topics-generating-basis", text: this.port.text("Reading the topic and note overviews. This usually takes a few dozen seconds.") });
    const footer = this.contentEl.createDiv({ cls: "qnalog-topics-modal-footer" });
    const actions = footer.createDiv({ cls: "qnalog-topics-modal-actions" });
    actions.createEl("button", { text: this.port.text("Cancel"), attr: { type: "button" } })
      .addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.cancelled = true;
    this.contentEl.empty();
  }
}
