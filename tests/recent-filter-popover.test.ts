import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentFilterPopoverSection } from "../src/recent/recent-filter-view";

type Listener = (event: FakeEvent) => void;

class FakeEvent {
  target: FakeNode | null;
  currentTarget: FakeEventTarget | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  constructor(readonly type: string, options: { target?: FakeNode; key?: string } = {}) {
    this.target = options.target || null;
    this.key = options.key || "";
  }
  readonly key: string;
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.propagationStopped = true; }
}

class FakeEventTarget {
  private readonly listeners = new Map<string, Array<{ listener: Listener; capture: boolean }>>();
  addEventListener(type: string, listener: Listener, options?: boolean | AddEventListenerOptions): void {
    const entries = this.listeners.get(type) || [];
    entries.push({ listener, capture: typeof options === "boolean" ? options : options?.capture === true });
    this.listeners.set(type, entries);
  }
  removeEventListener(type: string, listener: Listener, options?: boolean | EventListenerOptions): void {
    const capture = typeof options === "boolean" ? options : options?.capture === true;
    this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry.listener !== listener || entry.capture !== capture));
  }
  dispatchEvent(event: FakeEvent): boolean {
    event.currentTarget = this;
    for (const entry of [...(this.listeners.get(event.type) || [])]) entry.listener(event);
    return !event.defaultPrevented;
  }
  listenerCount(type: string): number { return this.listeners.get(type)?.length || 0; }
}

class FakeNode extends FakeEventTarget {
  readonly childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  constructor(readonly ownerDocument: FakeDocument | null) { super(); }
  appendChild<T extends FakeNode>(child: T): T {
    if (this instanceof FakeDocument) {
      if (!(child instanceof FakeElement) || this.documentElement) throw new Error("HierarchyRequestError");
      this.documentElement = child;
    }
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild<T extends FakeNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    if (this instanceof FakeDocument && child === this.documentElement) this.documentElement = null;
    return child;
  }
  contains(node: FakeNode | null): boolean {
    return node === this || this.childNodes.some((child) => child.contains(node));
  }
  createEl(tag: string, options: { cls?: string; text?: string } = {}): FakeElement {
    const element = (this instanceof FakeDocument ? this : this.ownerDocument)?.createElement(tag);
    if (!element) throw new Error("No owner document");
    element.className = options.cls || "";
    element.textContent = options.text || "";
    return this.appendChild(element);
  }
  createDiv(options: { cls?: string; text?: string } = {}): FakeElement { return this.createEl("div", options); }
  get isConnected(): boolean {
    let current: FakeNode | null = this;
    while (current && !(current instanceof FakeDocument)) current = current.parentNode;
    return current instanceof FakeDocument;
  }
}

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string>;
  readonly style: Record<string, string> = {};
  readonly tagName: string;
  hidden = false;
  className = "";
  private text = "";
  constructor(ownerDocument: FakeDocument, tag: string) {
    super(ownerDocument);
    this.tagName = tag.toUpperCase();
    this.dataset = new Proxy({}, {
      get: (_target, key: string) => this.getAttribute(`data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`) || "",
      set: (_target, key: string, value: string) => {
        this.setAttribute(`data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, String(value));
        return true;
      },
    });
  }
  get children(): FakeElement[] { return this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement); }
  get classList(): { contains(name: string): boolean; toggle(name: string, force?: boolean): boolean } {
    return {
      contains: (name) => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const names = this.className.split(/\s+/).filter(Boolean);
        const shouldAdd = force ?? !names.includes(name);
        const next = shouldAdd ? [...new Set([...names, name])] : names.filter((item) => item !== name);
        this.className = next.join(" ");
        return shouldAdd;
      },
    };
  }
  get textContent(): string { return this.text + this.childNodes.map((child) => child instanceof FakeElement ? child.textContent : "").join(""); }
  set textContent(value: string) { this.childNodes.splice(0); this.text = value; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  focus(): void { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  blur(): void { if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null; }
  click(): void { this.dispatchEvent(new FakeEvent("click", { target: this })); }
  remove(): void { this.parentNode?.removeChild(this); }
  replaceChildren(...nodes: FakeNode[]): void {
    for (const child of [...this.childNodes]) this.removeChild(child);
    for (const node of nodes) this.appendChild(node);
  }
  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const tagName = /^[a-z][\w-]*/i.exec(selector)?.[0].toUpperCase() || null;
    const attributes = Array.from(selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g));
    const matches = (node: FakeNode): node is FakeElement => node instanceof FakeElement
      && (!tagName || node.tagName === tagName)
      && attributes.every(([, name, value]) => {
        const actual = node.getAttribute(name);
        return value === undefined ? actual !== null : actual === value;
      });
    const found: FakeElement[] = [];
    const visit = (node: FakeNode) => {
      for (const child of node.childNodes) {
        if (matches(child)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found as T[];
  }
  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] || null; }
  getBoundingClientRect(): DOMRect {
    const styleWidth = Number.parseFloat(this.style.width || "");
    return { x: 0, y: 0, left: 0, top: 0, right: Number.isFinite(styleWidth) ? styleWidth : 280, bottom: 24, width: Number.isFinite(styleWidth) ? styleWidth : 280, height: 24, toJSON: () => ({}) } as DOMRect;
  }
}

class FakeDocument extends FakeNode {
  documentElement: FakeElement | null = null;
  body: FakeElement;
  activeElement: FakeElement | null = null;
  constructor() {
    super(null);
    const root = this.createElement("html");
    this.appendChild(root);
    this.body = this.createElement("body");
    root.appendChild(this.body);
  }
  createElement(tag: string): FakeElement { return new FakeElement(this, tag); }
}

class FakeWindow extends FakeEventTarget {
  innerWidth = 1024;
  innerHeight = 768;
  visualViewport: null = null;
  constructor(private readonly ownerDocument: FakeDocument) { super(); }
  createEl(tag: string, options: { cls?: string; text?: string } = {}): FakeElement {
    const element = this.ownerDocument.createElement(tag);
    element.className = options.cls || "";
    element.textContent = options.text || "";
    return element;
  }
  createDiv(options: { cls?: string; text?: string } = {}): FakeElement { return this.createEl("div", options); }
}

Object.defineProperty(FakeNode.prototype, "createEl", { value: FakeNode.prototype.createEl, configurable: true });
Object.defineProperty(FakeNode.prototype, "createDiv", { value: FakeNode.prototype.createDiv, configurable: true });

import { RecentFilterPopover } from "../src/ui/recent-filter-popover";

let testDocument: FakeDocument;
let testWindow: FakeWindow;

beforeEach(() => {
  testDocument = new FakeDocument();
  testWindow = new FakeWindow(testDocument);
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("document", testDocument);
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("activeDocument", testDocument);
  vi.stubGlobal("activeWindow", testWindow);
  vi.stubGlobal("createEl", (tag: string, options: { cls?: string; text?: string } = {}) => {
    const element = testDocument.createElement(tag);
    element.className = options.cls || "";
    element.textContent = options.text || "";
    return element;
  });
  vi.stubGlobal("createDiv", (options: { cls?: string; text?: string } = {}) => {
    const element = testDocument.createElement("div");
    element.className = options.cls || "";
    element.textContent = options.text || "";
    return element;
  });
});

afterEach(() => vi.unstubAllGlobals());

const sections: RecentFilterPopoverSection[] = [
  { id: "time", label: "Time range", selected: "all", options: [{ id: "all", label: "All" }, { id: "today", label: "Today" }, { id: "week", label: "This week" }] },
  { id: "mode", label: "Template", selected: "all", options: [{ id: "all", label: "All" }, { id: "meeting", label: "Meeting" }] },
  { id: "group", label: "Group by", selected: "folder", options: [{ id: "folder", label: "By folder" }, { id: "time", label: "By time" }] },
];

function fixture() {
  const onSelect = vi.fn();
  const anchor = testDocument.createElement("button");
  const searchRow = testDocument.createElement("div");
  testDocument.body.appendChild(searchRow);
  searchRow.appendChild(anchor);
  const popover = new RecentFilterPopover(onSelect, "Filter and view options");
  return { onSelect, anchor, searchRow, popover };
}

function buttonsIn(element: FakeElement): FakeElement[] { return element.querySelectorAll("button"); }

describe("RecentFilterPopover DOM lifecycle", () => {
  it("constructs under the document body without a hierarchy error", () => {
    expect(() => testDocument.createDiv()).toThrow("HierarchyRequestError");
    const popover = new RecentFilterPopover(vi.fn(), "label");
    const dialog = testDocument.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-label")).toBe("label");
    popover.dispose();
  });

  it("opens with all three sections and their option buttons", () => {
    const { anchor, searchRow, popover } = fixture();
    popover.toggle(anchor as unknown as HTMLElement, searchRow as unknown as HTMLElement, sections);
    const dialog = testDocument.body.querySelector('[role="dialog"]');
    expect(dialog?.hidden).toBe(false);
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
    expect(dialog?.children).toHaveLength(3);
    const groups = dialog?.childNodes as FakeElement[];
    expect(groups.map(buttonsIn).map((items) => items.length)).toEqual([3, 2, 2]);
    popover.dispose();
  });

  it("selects a new option and ignores clicks on the selected option", () => {
    const { onSelect, anchor, searchRow, popover } = fixture();
    popover.toggle(anchor as unknown as HTMLElement, searchRow as unknown as HTMLElement, sections);
    const dialog = testDocument.body.querySelector('[role="dialog"]') as FakeElement;
    const timeOptions = dialog.querySelectorAll('[data-section="time"]');
    timeOptions[1].click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("time", "today");
    timeOptions[0].click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    popover.dispose();
  });

  it("closes by toggle, Escape, and an outside pointer press, then removes itself on dispose", () => {
    const { anchor, searchRow, popover } = fixture();
    popover.toggle(anchor as unknown as HTMLElement, searchRow as unknown as HTMLElement, sections);
    const dialog = testDocument.body.querySelector('[role="dialog"]') as FakeElement;
    popover.toggle(anchor as unknown as HTMLElement, searchRow as unknown as HTMLElement, sections);
    expect(dialog.hidden).toBe(true);
    expect(anchor.getAttribute("aria-expanded")).toBe("false");

    popover.toggle(anchor as unknown as HTMLElement, searchRow as unknown as HTMLElement, sections);
    testDocument.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    expect(dialog.hidden).toBe(true);

    popover.toggle(anchor as unknown as HTMLElement, searchRow as unknown as HTMLElement, sections);
    testDocument.dispatchEvent(new FakeEvent("pointerdown", { target: testDocument.body }));
    expect(dialog.hidden).toBe(true);
    popover.dispose();
    expect(testDocument.body.querySelector('[role="dialog"]')).toBeNull();
    expect(testDocument.listenerCount("keydown")).toBe(0);
    expect(testWindow.listenerCount("resize")).toBe(0);
  });
});
