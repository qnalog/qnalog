type ElementOptions = { cls?: string; text?: string; attr?: Record<string, string> };

declare global {
  interface HTMLElement {
    createDiv(options?: ElementOptions): HTMLDivElement;
    createEl(tag: string, options?: ElementOptions): HTMLElement;
    createSpan(options?: ElementOptions): HTMLSpanElement;
    addClass(value: string): void;
    empty(): void;
    setText(value: string): void;
  }
  interface Window {
    renderTopicCreate(): Promise<void>;
    renderTopicPreview(): void;
    renderTopicsPanel(): Promise<void>;
  }
}

HTMLElement.prototype.addClass = function (value: string): void { this.classList.add(...value.split(/\s+/).filter(Boolean)); };
HTMLElement.prototype.empty = function (): void { this.replaceChildren(); };
HTMLElement.prototype.setText = function (value: string): void { this.textContent = value; };
HTMLElement.prototype.createEl = function (tag: string, options: ElementOptions = {}): HTMLElement {
  const element = document.createElement(tag);
  if (options.cls) element.className = options.cls;
  if (options.text !== undefined) element.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr || {})) element.setAttribute(key, value);
  this.append(element);
  return element;
};
HTMLElement.prototype.createDiv = function (options: ElementOptions = {}): HTMLDivElement { return this.createEl("div", options) as HTMLDivElement; };
HTMLElement.prototype.createSpan = function (options: ElementOptions = {}): HTMLSpanElement { return this.createEl("span", options) as HTMLSpanElement; };

export class Modal {
  readonly modalEl: HTMLDivElement;
  readonly contentEl: HTMLDivElement;
  private readonly closeButton: HTMLButtonElement;

  constructor(_app: unknown) {
    const container = document.createElement("div");
    container.className = "modal-container";
    this.modalEl = document.createElement("div");
    this.modalEl.className = "modal";
    this.closeButton = document.createElement("button");
    this.closeButton.className = "modal-close-button";
    this.closeButton.textContent = "×";
    this.closeButton.addEventListener("click", () => this.close());
    this.contentEl = document.createElement("div");
    this.contentEl.className = "modal-content";
    this.modalEl.append(this.closeButton, this.contentEl);
    container.append(this.modalEl);
    document.body.append(container);
  }

  open(): void { this.onOpen(); }
  close(): void { this.onClose(); this.modalEl.parentElement?.remove(); }
  onOpen(): void { /* Obsidian lifecycle hook */ }
  onClose(): void { /* Obsidian lifecycle hook */ }
}

export class Notice {
  readonly messageEl = document.createElement("div");
  noticeEl = this.messageEl;
  constructor(message: string) { this.messageEl.textContent = message; }
}

export class Menu {
  addItem(callback: (item: { setTitle(value: string): unknown; setIcon(value: string): unknown; onClick(callback: () => void): unknown }) => void): void {
    callback({ setTitle: () => this, setIcon: () => this, onClick: () => this });
  }
  addSeparator(): void { /* no menu interaction in layout checks */ }
  showAtMouseEvent(): void { /* no menu interaction in layout checks */ }
}

export function setIcon(parent: HTMLElement, name: string): void {
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.dataset.icon = name;
  parent.append(icon);
}
