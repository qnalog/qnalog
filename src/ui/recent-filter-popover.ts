import type { RecentFilterPopoverSection, RecentFilterPopoverSectionId } from "../recent/recent-filter-view";

export type RecentFilterPopoverSelect = (section: RecentFilterPopoverSectionId, value: string) => void;

export class RecentFilterPopover {
  private readonly element: HTMLDivElement;
  private readonly onSelect: RecentFilterPopoverSelect;
  private anchor: HTMLElement | null = null;
  private searchRow: HTMLElement | null = null;
  private sections: RecentFilterPopoverSection[] = [];
  private openState = false;
  private readonly visualViewport: VisualViewport | null;

  constructor(onSelect: RecentFilterPopoverSelect, ariaLabel: string) {
    this.onSelect = onSelect;
    this.element = activeDocument.createElement("div");
    this.element.className = "qnalog-recent-filter-popover";
    this.element.setAttribute("role", "dialog");
    this.element.setAttribute("aria-label", ariaLabel);
    this.element.hidden = true;
    activeDocument.body.appendChild(this.element);
    this.element.addEventListener("click", (event) => event.stopPropagation());
    activeDocument.addEventListener("pointerdown", this.handleOutsidePointerDown, true);
    activeDocument.addEventListener("keydown", this.handleKeyDown, true);
    activeWindow.addEventListener("resize", this.reposition);
    activeWindow.addEventListener("scroll", this.reposition, true);
    this.visualViewport = activeWindow.visualViewport || null;
    this.visualViewport?.addEventListener("resize", this.reposition);
    this.visualViewport?.addEventListener("scroll", this.reposition);
  }

  setAnchor(anchor: HTMLElement, searchRow: HTMLElement, sections: RecentFilterPopoverSection[]): void {
    this.anchor = anchor;
    this.searchRow = searchRow;
    this.anchor.setAttribute("aria-expanded", String(this.openState));
    this.setSections(sections);
    if (this.openState) this.reposition();
  }

  setSections(sections: RecentFilterPopoverSection[]): void {
    const structureChanged = sections.length !== this.sections.length || sections.some((section, index) => {
      const oldSection = this.sections[index];
      return !oldSection || oldSection.id !== section.id
        || oldSection.options.length !== section.options.length
        || oldSection.options.some((option, optionIndex) => option.id !== section.options[optionIndex]?.id);
    });
    this.sections = sections;
    if (structureChanged) this.renderSections();
    else this.updatePressedStates();
  }

  toggle(anchor: HTMLElement, searchRow: HTMLElement, sections: RecentFilterPopoverSection[]): void {
    this.setAnchor(anchor, searchRow, sections);
    if (this.openState) {
      this.close();
      return;
    }
    const focusedElement = activeDocument.activeElement as HTMLElement | null;
    if (focusedElement && searchRow.contains(focusedElement) && typeof focusedElement.blur === "function") {
      focusedElement.blur();
    }
    this.openState = true;
    this.anchor?.setAttribute("aria-expanded", "true");
    this.element.hidden = false;
    this.reposition();
    this.focusSelectedTimeOption();
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.anchor?.setAttribute("aria-expanded", "false");
    this.element.hidden = true;
    if (this.anchor?.isConnected) this.anchor.focus();
  }

  dispose(): void {
    this.close();
    activeDocument.removeEventListener("pointerdown", this.handleOutsidePointerDown, true);
    activeDocument.removeEventListener("keydown", this.handleKeyDown, true);
    activeWindow.removeEventListener("resize", this.reposition);
    activeWindow.removeEventListener("scroll", this.reposition, true);
    this.visualViewport?.removeEventListener("resize", this.reposition);
    this.visualViewport?.removeEventListener("scroll", this.reposition);
    this.element.remove();
    this.anchor = null;
    this.searchRow = null;
  }

  private renderSections(): void {
    this.element.replaceChildren();
    for (const section of this.sections) {
      const group = activeDocument.createElement("section");
      group.className = "qnalog-recent-filter-popover-section";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", section.label);
      const label = activeDocument.createElement("div");
      label.className = "qnalog-recent-filter-popover-label";
      label.textContent = section.label;
      group.appendChild(label);
      const options = activeDocument.createElement("div");
      options.className = section.id === "mode" ? "qnalog-recent-filter-popover-templates" : "qnalog-segmented";
      for (const option of section.options) {
        const button = activeDocument.createElement("button");
        button.type = "button";
        button.className = section.id === "mode" ? "qnalog-option-chip" : "qnalog-segmented-option";
        button.textContent = option.label;
        button.dataset.section = section.id;
        button.dataset.option = option.id;
        button.setAttribute("aria-pressed", String(option.id === section.selected));
        button.addEventListener("click", () => {
          const current = this.sections.find((entry) => entry.id === section.id)?.selected;
          if (option.id === current) return;
          this.onSelect(section.id, option.id);
        });
        options.appendChild(button);
      }
      group.appendChild(options);
      this.element.appendChild(group);
    }
  }

  private updatePressedStates(): void {
    for (const section of this.sections) {
      for (const button of Array.from(this.element.querySelectorAll<HTMLButtonElement>(`[data-section="${section.id}"]`))) {
        const pressed = button.dataset.option === section.selected;
        button.setAttribute("aria-pressed", String(pressed));
        button.classList.toggle("is-selected", pressed);
      }
    }
  }

  private focusSelectedTimeOption(): void {
    const selected = this.element.querySelector<HTMLButtonElement>('[data-section="time"][aria-pressed="true"]');
    selected?.focus();
  }

  private reposition = (): void => {
    if (!this.openState || !this.anchor?.isConnected || !this.searchRow?.isConnected) return;
    const viewportWidth = activeWindow.innerWidth;
    const viewportHeight = this.visualViewport?.height || activeWindow.innerHeight;
    const narrow = viewportWidth < 480 || activeDocument.body.classList.contains("is-mobile");
    const width = Math.max(0, viewportWidth - 32);
    this.element.style.width = narrow ? `${width}px` : "min(320px, calc(100vw - 32px))";
    this.element.style.maxHeight = narrow ? "none" : "min(220px, 60vh, calc(100vh - 32px))";
    const anchorRect = this.anchor.getBoundingClientRect();
    const rowRect = this.searchRow.getBoundingClientRect();
    const measuredWidth = this.element.getBoundingClientRect().width || width;
    const left = narrow
      ? Math.max(0, (viewportWidth - width) / 2)
      : Math.max(16, Math.min(anchorRect.right - measuredWidth, viewportWidth - measuredWidth - 16));
    const desiredTop = (narrow ? rowRect.bottom : anchorRect.bottom) + (narrow ? 6 : 4);
    const landscape = viewportHeight < 480;
    const maxHeight = narrow ? Math.max(0, viewportHeight - (landscape ? 32 : desiredTop + 16)) : 0;
    if (narrow) this.element.style.maxHeight = `${maxHeight}px`;
    this.element.style.paddingBottom = narrow ? "calc(12px + env(safe-area-inset-bottom))" : "";
    this.element.style.overflowY = narrow ? "auto" : "";
    const measuredHeight = this.element.getBoundingClientRect().height;
    const top = Math.max(16, Math.min(desiredTop, viewportHeight - Math.min(measuredHeight, maxHeight || measuredHeight) - 16));
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  };

  private handleOutsidePointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.element.contains(target) || this.anchor?.contains(target)) return;
    this.close();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.openState) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };
}
