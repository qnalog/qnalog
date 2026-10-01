import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class TFile {
    path: string;
    extension: string;
    basename: string;
    name: string;
    constructor(path: string) {
      this.path = path;
      this.extension = path.split(".").pop() || "";
      this.basename = path.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
      this.name = path.split("/").pop() || "";
    }
  },
  Modal: class Modal {},
  Notice: class Notice {},
  setIcon: vi.fn(),
  setTooltip: vi.fn(),
}));

import * as obsidian from "obsidian";
import { BubbleWidget } from "../src/ui/modals";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function file(path: string): InstanceType<typeof obsidian.TFile> {
  return new obsidian.TFile(path);
}
function widget(activeFile: InstanceType<typeof obsidian.TFile> | null, cachedRead: (target: InstanceType<typeof obsidian.TFile>) => Promise<string>) {
  const instance = Object.create(BubbleWidget.prototype) as BubbleWidget;
  instance.plugin = {
    app: {
      workspace: { getActiveFile: () => activeFile },
      vault: { cachedRead },
    },
  } as never;
  instance.appendFile = null;
  instance._activeNoteReadId = 0;
  instance.scheduleUpdate = vi.fn();
  return {
    instance,
    setActive(target: InstanceType<typeof obsidian.TFile> | null) { activeFile = target; },
  };
}
class FakeElement {
  className = "";
  textContent = "";
  children: FakeElement[] = [];
  onclick: ((event: { stopPropagation(): void }) => void) | null = null;
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  createEl(_tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
    return this.addChild(options);
  }
  createDiv(options: { cls?: string; text?: string } = {}) { return this.addChild(options); }
  createSpan(options: { cls?: string; text?: string } = {}) { return this.addChild(options); }
  addChild(options: { cls?: string; text?: string; attr?: Record<string, string> }) {
    const child = new FakeElement();
    child.className = options.cls || "";
    child.textContent = options.text || "";
    child.attributes = options.attr || {};
    this.children.push(child);
    return child;
  }
  addClass(name: string) { this.className += ` ${name}`; }
  removeClass(name: string) { this.className = this.className.replace(name, ""); }
  empty() { this.children = []; this.textContent = ""; }
  setText(value: string) { this.textContent = value; }
  setAttr(name: string, value: string) { this.attributes[name] = value; }
  querySelector(selector: string): FakeElement | null {
    const classNames = selector.split(/[ .]/).filter(Boolean);
    for (const child of this.children) {
      if (classNames.every((name) => child.className.split(/\s+/).includes(name))) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}


const noteMarker = "<!-- qnalog-session:session-a -->";

describe("bubble continuation target", () => {
  it("keeps the newer active note when an earlier cached read resolves last", async () => {
    const a = file("A.md");
    const b = file("B.md");
    const readA = deferred<string>();
    const readB = deferred<string>();
    const target = widget(a, (current) => current === a ? readA.promise : readB.promise);
    const pendingA = target.instance.refreshActiveNote();
    target.setActive(b);
    expect(b instanceof obsidian.TFile).toBe(true);
    const pendingB = target.instance.refreshActiveNote();
    expect(target.instance.plugin.app.workspace.getActiveFile()).toBe(b);

    readB.resolve(noteMarker);
    await expect(pendingB).resolves.toBe(b);
    readA.resolve(noteMarker);
    await expect(pendingA).resolves.toBeNull();
    expect(target.instance.appendFile).toBe(b);
  });

  it("does not restore a stale target after switching to an ordinary note or no note", async () => {
    const a = file("A.md");
    const ordinary = file("ordinary.md");
    const readA = deferred<string>();
    const target = widget(a, (current) => current === a ? readA.promise : Promise.resolve("ordinary markdown"));
    const pendingA = target.instance.refreshActiveNote();
    target.setActive(ordinary);
    await expect(target.instance.refreshActiveNote()).resolves.toBeNull();
    readA.resolve(noteMarker);
    await expect(pendingA).resolves.toBeNull();
    expect(target.instance.appendFile).toBeNull();

    target.setActive(a);
    const pendingAgain = target.instance.refreshActiveNote();
    target.setActive(null);
    await expect(target.instance.refreshActiveNote()).resolves.toBeNull();
    readA.resolve(noteMarker);
    await expect(pendingAgain).resolves.toBeNull();
    expect(target.instance.appendFile).toBeNull();
  });

  it("rejects an older read for the same note when a newer refresh has started", async () => {
    const active = file("same.md");
    const older = deferred<string>();
    const newer = deferred<string>();
    let calls = 0;
    const target = widget(active, () => (++calls === 1 ? older.promise : newer.promise));
    const pendingOlder = target.instance.refreshActiveNote();
    const pendingNewer = target.instance.refreshActiveNote();
    newer.resolve(noteMarker);
    await expect(pendingNewer).resolves.toBe(active);
    older.resolve(noteMarker);
    await expect(pendingOlder).resolves.toBeNull();
    expect(target.instance.appendFile).toBe(active);
  });
  it("validates the clicked target again and does not start if focus changes while it is read", async () => {
    const active = file("active.md");
    const previous = file("previous.md");
    const target = widget(active, async () => noteMarker);
    const startRecording = vi.fn();
    target.instance.appendFile = previous;
    target.instance.el = new FakeElement() as never;
    target.instance.plugin = Object.assign(target.instance.plugin, {
      settings: { bubbleSize: "large" },
      recorder: { getInfo: () => ({ state: "idle", elapsed: 0 }) },
      queue: null,
      shell: { openRecentNote: vi.fn() },
      recording: { startRecording },
    }) as never;
    target.instance.render();
    const appendButton = (target.instance.el as never as FakeElement).querySelector(".qnalog-bubble-btn.append");
    expect(appendButton).not.toBeNull();
    appendButton!.onclick!({ stopPropagation: vi.fn() });
    await flushMicrotasks();
    expect(startRecording).toHaveBeenCalledWith({ appendToFile: active });

    const clicked = file("clicked.md");
    const switched = file("switched.md");
    const pendingRead = deferred<string>();
    const second = widget(clicked, () => pendingRead.promise);
    const secondStart = vi.fn();
    second.instance.appendFile = previous;
    second.instance.el = new FakeElement() as never;
    second.instance.plugin = Object.assign(second.instance.plugin, {
      settings: { bubbleSize: "large" },
      recorder: { getInfo: () => ({ state: "idle", elapsed: 0 }) },
      queue: null,
      shell: { openRecentNote: vi.fn() },
      recording: { startRecording: secondStart },
    }) as never;
    second.instance.render();
    const secondButton = (second.instance.el as never as FakeElement).querySelector(".qnalog-bubble-btn.append");
    secondButton!.onclick!({ stopPropagation: vi.fn() });
    second.setActive(switched);
    pendingRead.resolve(noteMarker);
    await flushMicrotasks();
    expect(secondStart).not.toHaveBeenCalled();
  });
});
