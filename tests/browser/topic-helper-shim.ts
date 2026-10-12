import { Modal } from "obsidian";

export function qnalogConfirm(app: unknown, title: string, body: string, ctaText = "Confirm", windowTitle?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app as never);
    modal.onOpen = () => {
      if (windowTitle) modal.titleEl.setText(windowTitle);
      if (windowTitle) modal.contentEl.createDiv({ cls: "qnalog-topics-dialog-heading", text: title });
      else modal.contentEl.createEl("h3", { text: title });
      modal.contentEl.createEl("p", { text: body });
      const actions = modal.contentEl.createDiv({ cls: "modal-button-container qnalog-modal-actions" });
      actions.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("click", () => { resolve(false); modal.close(); });
      actions.createEl("button", { cls: "mod-warning", text: ctaText, attr: { type: "button" } }).addEventListener("click", () => { resolve(true); modal.close(); });
    };
    modal.onClose = () => resolve(false);
    modal.open();
  });
}
