import * as obsidian from "obsidian";
import { t } from "../shared/i18n";

export class ErrataModal extends obsidian.Modal {
  private readonly initialWrongText: string;
  private readonly onSubmit: (wrongText: string, correctText: string) => Promise<void>;
  private wrongInput: HTMLInputElement | null = null;
  private correctInput: HTMLInputElement | null = null;
  private submitButton: HTMLButtonElement | null = null;

  constructor(
    app: obsidian.App,
    initialWrongText: string,
    onSubmit: (wrongText: string, correctText: string) => Promise<void>,
  ) {
    super(app);
    this.initialWrongText = initialWrongText;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t("Add a correction to the errata") });
    this.wrongInput = this.addTextField(contentEl, t("Wrong word"), this.initialWrongText);
    this.correctInput = this.addTextField(contentEl, t("Correct word"), "");
    this.correctInput.focus();

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelButton = actions.createEl("button", { text: t("Cancel"), attr: { type: "button" } });
    cancelButton.addEventListener("click", () => this.close());
    this.submitButton = actions.createEl("button", { text: t("Add correction"), attr: { type: "button" } });
    this.submitButton.addClass("mod-cta");
    this.submitButton.addEventListener("click", () => { void this.submit(); });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private addTextField(parent: HTMLElement, label: string, value: string): HTMLInputElement {
    const field = parent.createDiv({ cls: "qnalog-errata-field" });
    field.createEl("label", { text: label });
    const input = field.createEl("input", { attr: { type: "text" } });
    input.value = value;
    return input;
  }

  private async submit(): Promise<void> {
    if (!this.wrongInput || !this.correctInput || !this.submitButton) return;
    const wrongText = this.wrongInput.value.trim();
    const correctText = this.correctInput.value.trim();
    if (!wrongText || !correctText) {
      new obsidian.Notice(t("Enter both the wrong word and the correct word."), 5000);
      return;
    }
    this.submitButton.disabled = true;
    try {
      await this.onSubmit(wrongText, correctText);
      new obsidian.Notice(t("Added to the errata. It will apply to newly generated notes after reorganization."), 6000);
      this.close();
    } catch (error: unknown) {
      const detail = error instanceof Error && error.message ? error.message : t("Unknown error");
      new obsidian.Notice(`${t("Could not save the errata: ")}${detail}`, 8000);
      this.submitButton.disabled = false;
      this.correctInput.focus();
    }
  }
}
