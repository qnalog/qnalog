import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

const uiMocks = vi.hoisted(() => ({ notices: [] as string[] }));

vi.mock("obsidian", () => {
  class ItemView {}
  class Modal {}
  class TFile {}
  class SuggestModal {}
  class FuzzySuggestModal {}
  class PluginSettingTab {}
  class Menu {}
  class Notice { constructor(message: string) { uiMocks.notices.push(String(message)); } }
  return {
    ItemView, Modal, TFile, SuggestModal, FuzzySuggestModal, PluginSettingTab, Menu, Notice,
    normalizePath: (path: string) => path.replace(/\\/g, "/"),
    parseYaml: (yaml: string) => JSON.parse(yaml),
    setIcon: () => undefined,
  };
});
vi.mock("../src/recent/recent-notes", async () => {
  const actual = await vi.importActual<typeof import("../src/recent/recent-notes")>("../src/recent/recent-notes");
  return { ...actual, getQueueTasksForMarkdown: () => [], getRecentQueueProcessingState: () => null };
});

import { OutlineView } from "../src/ui/outline-view";
import { RecordingSearchController, type RecordingSearchTimers } from "../src/ui/recording-search-panel";
import { buildRecordingSearchIndex } from "../src/notes/recording-search";
import { attachTranscriptResult } from "../src/transcript/session-transcript";
import type { AsrTranscriptUnit } from "../src/asr/transcript-result";
import type { Segment } from "../src/shared/types";

const initialUiLanguage = getActiveUiLanguage();
afterEach(() => {
  setActiveUiLanguage(initialUiLanguage);
  uiMocks.notices.length = 0;
});

/** Minimal stand-in for the Obsidian-augmented DOM the panel uses. */
class FakeDocument { activeElement: FakeElement | null = null; }
class FakeElement {
  children: FakeElement[] = [];
  text = "";
  value = "";
  disabled = false;
  isConnected = true;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  classes = new Set<string>();
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(evt: unknown) => void>> = {};
  constructor(readonly ownerDocument: FakeDocument, readonly tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
    this.text = options.text || "";
    for (const name of (options.cls || "").split(/\s+/).filter(Boolean)) this.classes.add(name);
    Object.assign(this.attrs, options.attr || {});
  }
  createEl(tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
    const child = new FakeElement(this.ownerDocument, tag, options);
    this.children.push(child);
    return child;
  }
  createDiv(options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) { return this.createEl("div", options); }
  createSpan(options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) { return this.createEl("span", options); }
  empty() {
    const drop = (element: FakeElement) => { element.isConnected = false; element.children.forEach(drop); };
    this.children.forEach(drop);
    this.children = [];
  }
  setText(text: string) { this.text = text; }
  toggleClass(cls: string, on: boolean) { if (on) this.classes.add(cls); else this.classes.delete(cls); }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  addEventListener(type: string, listener: (evt: unknown) => void) { (this.listeners[type] ||= []).push(listener); }
  dispatch(type: string, evt: Record<string, unknown> = {}) {
    const event = { preventDefault: () => undefined, ...evt };
    for (const listener of this.listeners[type] || []) listener(event);
  }
  focus() { this.ownerDocument.activeElement = this; }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  all(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.all()]); }
  byClass(cls: string): FakeElement[] { return this.all().filter((element) => element.classes.has(cls)); }
  querySelector(selector: string) { return this.byClass(selector.replace(/^\./, ""))[0] || null; }
  querySelectorAll(selector: string) { return this.byClass(selector.replace(/^\./, "")); }
  textContent(): string { return this.text + this.children.map((child) => child.textContent()).join(""); }
}

const AUDIO = "QnALog/Audio/meeting.webm";
function unit(text: string, startMs: number, timing: AsrTranscriptUnit["timing"], speaker: string): AsrTranscriptUnit {
  return { rawText: text, normalizedText: text, speakerId: "spk-1", speakerName: speaker, startMs, endMs: startMs + 1500, timing };
}
function meetingSegment(): Segment {
  const units = [
    unit("我们下周三发布试点版本。", 12_400, "provider", "张华"),
    unit("预算还剩十一万。", 75_000, "audio-span", "李明"),
    unit("预算下周再确认。", 95_000, "provider", "张华"),
  ];
  const text = units.map((item) => item.rawText).join(" ");
  return attachTranscriptResult({ index: 0, startOffsetMs: 0, endOffsetMs: 600_000, text, audioPath: AUDIO, audioName: "meeting.webm" },
    "meeting", { text, rawText: null, providerId: "test-asr", units }, "asr");
}

function manualTimers() {
  let pending: Array<{ id: number; callback: () => void; ms: number }> = [];
  let next = 1;
  let clock = 1_000;
  const timers: RecordingSearchTimers = {
    set: (callback, ms) => { const id = next++; pending.push({ id, callback, ms }); return id; },
    clear: (handle) => { pending = pending.filter((entry) => entry.id !== handle); },
    now: () => clock,
  };
  return {
    timers,
    pendingDelays: () => pending.map((entry) => entry.ms),
    flush: () => { const due = pending; pending = []; due.forEach((entry) => entry.callback()); },
    advanceClock: (ms: number) => { clock += ms; },
  };
}

function setup(options: { segments?: Segment[]; withPlayer?: boolean } = {}) {
  setActiveUiLanguage(resolveUiLanguage("en", "en"));
  const doc = new FakeDocument();
  const root = new FakeElement(doc, "div");
  const timer = manualTimers();
  const payload = { file: { path: AUDIO }, localMs: 12_000, globalMs: 12_000, label: "00:12", linkPath: AUDIO, sourcePath: "Notes/meeting.md" };
  const openAudioTimeLink = vi.fn(async (_linkPath: string, _label: string, _sourcePath: string, opts: { onTimeLink: (value: unknown) => unknown }) => {
    opts.onTimeLink(payload);
  });
  const seekInlineAudio = vi.fn(() => true);
  const view = Object.create(OutlineView.prototype) as OutlineView;
  Object.assign(view, {
    plugin: { audioLinks: { openAudioTimeLink } },
    inlineAudioEl: options.withPlayer === false ? null : {},
    recordingSearch: new RecordingSearchController(timer.timers),
    seekInlineAudio,
  });
  const data = { recordingSearch: buildRecordingSearchIndex(options.segments ?? [meetingSegment()]) };
  const file = { path: "Notes/meeting.md" };
  const render = () => {
    view.recordingSearch.captureFocusBeforeRender();
    root.empty();
    view.renderRecordingSearch(root as unknown as HTMLElement, data, file);
  };
  render();
  const input = () => root.byClass("qnalog-recording-search-input")[0];
  const rows = () => root.byClass("qnalog-recording-search-row");
  const status = () => root.byClass("qnalog-recording-search-status")[0];
  const type = (value: string) => {
    const field = input();
    field.value = value;
    field.dispatch("input");
  };
  return { view, root, doc, timer, payload, openAudioTimeLink, seekInlineAudio, render, input, rows, status, type };
}

describe("find in recording in the sidebar note panel", () => {
  it("filters the rows after the typing pause and highlights the hit", () => {
    const panel = setup();
    expect(panel.input().attrs.placeholder).toBe("Find in recording");
    expect(panel.rows()).toHaveLength(0);

    panel.type("试点");
    expect(panel.rows()).toHaveLength(0);
    expect(panel.timer.pendingDelays()).toEqual([200]);
    panel.timer.flush();
    expect(panel.rows()).toHaveLength(1);
    const [row] = panel.rows();
    expect(row.byClass("qnalog-recording-search-time")[0].text).toBe("00:12");
    expect(row.byClass("qnalog-recording-search-speaker")[0].text).toBe("张华");
    expect(row.byClass("qnalog-recording-search-hit").map((mark) => mark.text)).toEqual(["试点"]);
    expect(row.byClass("qnalog-recording-search-precision")).toHaveLength(0);

    panel.type("预算");
    panel.timer.flush();
    expect(panel.rows().map((item) => item.byClass("qnalog-recording-search-time")[0].text)).toEqual(["01:15", "01:35"]);
    // The audio-span time is marked as approximate.
    expect(panel.rows()[0].byClass("qnalog-recording-search-precision")[0].text).toBe("approx.");

    panel.type("张华");
    panel.timer.flush();
    const speakers = panel.rows().map((item) => item.byClass("qnalog-recording-search-speaker")[0]);
    expect(speakers.map((item) => item.text)).toEqual(["张华", "张华"]);
    expect(speakers.every((item) => item.classes.has("is-hit"))).toBe(true);

    panel.type("没有这个词");
    panel.timer.flush();
    expect(panel.rows()).toHaveLength(0);
    expect(panel.status().text).toBe("No matches");

    panel.type("");
    panel.timer.flush();
    expect(panel.rows()).toHaveLength(0);
    expect(panel.status().text).toBe("");
  });

  it("clicking a row seeks the inline player through the time-link path with the row's time", async () => {
    const panel = setup();
    panel.type("试点");
    panel.timer.flush();
    panel.rows()[0].dispatch("click");
    await Promise.resolve();
    expect(panel.openAudioTimeLink).toHaveBeenCalledTimes(1);
    expect(panel.openAudioTimeLink).toHaveBeenCalledWith(AUDIO, "00:12", "Notes/meeting.md", expect.objectContaining({ onTimeLink: expect.any(Function) }));
    expect(panel.seekInlineAudio).toHaveBeenCalledWith(panel.payload);
  });

  it("keeps the query and the focus when the sidebar re-renders", () => {
    const panel = setup();
    panel.input().focus();
    panel.type("预算");
    panel.render();
    expect(panel.input().value).toBe("预算");
    expect(panel.doc.activeElement).toBe(panel.input());
    expect(panel.rows()).toHaveLength(2);
  });

  it("focuses the field when the command asked for it", () => {
    const panel = setup();
    expect(panel.doc.activeElement).toBeNull();
    panel.view.recordingSearch.requestFocus();
    panel.render();
    expect(panel.doc.activeElement).toBe(panel.input());
  });

  it("shows no field without a transcript or without a recording", () => {
    const noTranscript = setup({ segments: [] });
    expect(noTranscript.root.children).toHaveLength(0);
    const noPlayer = setup({ withPlayer: false });
    expect(noPlayer.root.children).toHaveLength(0);
    // A focus request from the command is answered with a notice instead of a missing field.
    noPlayer.view.recordingSearch.requestFocus();
    noPlayer.render();
    expect(uiMocks.notices).toEqual(["This note has no recording with a transcript to search."]);
  });
});
