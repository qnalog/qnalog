import { afterEach, describe, expect, it, vi } from "vitest";
import type * as SedimentModule from "../src/sediment";
import { getTaskErrorMessage } from "../src/shared/task-activity";
import type * as VocabularyModule from "../src/vocabulary";

vi.mock("obsidian", () => {
  class ItemView {}
  class TFile {
    path: string;
    basename: string;
    constructor(path: string) {
      this.path = path;
      this.basename = path.split("/").pop()?.replace(/\.md$/, "") || "";
    }
  }
  class Notice {
    static messages: Array<{ message: string; duration?: number }> = [];
    constructor(message: string, duration?: number) { Notice.messages.push({ message, duration }); }
  }
  class Modal {
    onOpen?: () => void;
    contentEl = { addClass: () => undefined, createDiv: () => fakeElement() };
    open(): void { this.onOpen?.(); }
    close(): void {}
  }
  return {
    ItemView, TFile, Notice, Modal, SuggestModal: class {}, FuzzySuggestModal: class {}, PluginSettingTab: class {},
    normalizePath: (path: string) => path.replace(/\\/g, "/"), setIcon: () => undefined,
  };
});
vi.mock("../src/sediment", async () => {
  const actual = await vi.importActual<typeof SedimentModule>("../src/sediment");
  return { ...actual, writeSedimentObjectCards: vi.fn(), getSedimentPersonId: vi.fn((sourcePath: string) => sourcePath) };
});
vi.mock("../src/vocabulary", async () => {
  const actual = await vi.importActual<typeof VocabularyModule>("../src/vocabulary");
  return { ...actual, loadVocabularyGroups: vi.fn() };
});

import * as obsidian from "obsidian";
import { OutlineView } from "../src/ui/outline-view";
import { writeSedimentObjectCards } from "../src/sediment";
import { loadVocabularyGroups } from "../src/vocabulary";

const TFile = obsidian.TFile as unknown as new (path: string) => { path: string; basename: string };
const Notice = obsidian.Notice as unknown as { messages: Array<{ message: string; duration?: number }> };
const eventLog: string[] = [];
const sourceFile = new TFile("Notes/source.md");

function fakeElement() {
  const created: Array<{ text?: string; onclick?: () => void }> = [];
  return {
    created,
    addClass: () => undefined,
    setText: () => undefined,
    createDiv: () => fakeElement(),
    createEl: (_tag: string, options: { text?: string } = {}) => {
      const element: { text?: string; disabled?: boolean; onclick?: () => void } = { text: options.text };
      created.push(element);
      return element;
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  eventLog.length = 0;
  Notice.messages.length = 0;
});

function makeView(groupKey: string, items = [{ id: "candidate-1", raw: { id: "candidate-1", sectionKey: "general", term: "term" } }]) {
  const view = Object.create(OutlineView.prototype) as OutlineView;
  const bucket = { todos: items, hotwords: { general: ["term"] }, selectedByGroup: { [groupKey]: ["candidate-1"] }, decisionLogByGroup: {} };
  const targetFile = sourceFile;
  const state = { bucket, groups: [], currentPeople: [{ name: "Pat", sourcePath: targetFile.path }] };
  const vocabularyFile = new TFile("Config/vocabulary.md");
  const app = {
    vault: {
      read: vi.fn(async (file: unknown) => {
        eventLog.push(file === targetFile ? "read source snapshot" : "read vocabulary snapshot");
        return file === targetFile ? "source before" : "vocabulary before";
      }),
      getAbstractFileByPath: vi.fn((path: string) => path === targetFile.path ? targetFile : path === vocabularyFile.path ? vocabularyFile : null),
      cachedRead: vi.fn(async () => { throw new Error("  scan failed  "); }),
      modify: vi.fn(async () => { throw new Error("  undo failed  "); }),
    },
  };
  const plugin = {
    settings: { vocabularyFile: vocabularyFile.path, customVocabulary: "custom before" },
    tasks: {
      startTaskActivity: vi.fn(), patchTaskActivity: vi.fn(), cancelTaskActivity: vi.fn(),
      completeTaskActivity: vi.fn(), failTaskActivity: vi.fn(),
    },
    vocabulary: { writeVocabularyFile: vi.fn(async () => { eventLog.push("write vocabulary"); }) },
    knowledgeExtraction: { markKnowledgeExtractionSource: vi.fn() },
    saveSettings: vi.fn(async () => undefined),
    people: {
      applyPeopleDirectorySuggestions: vi.fn(async () => ({ entries: [], created: 1, updated: 0 })),
      removeCachedPeopleSuggestions: vi.fn(),
      ignorePeopleDirectorySuggestion: vi.fn(async () => true),
    },
  };
  Object.assign(view, {
    app, plugin,
    getSedimentPanelState: vi.fn(() => state),
    getSedimentDisplayItems: vi.fn(() => items),
    getSedimentSelectedIds: vi.fn(() => new Set(items.map(item => item.id))),
    getSedimentCandidateBucket: vi.fn(() => bucket),
    cloneSedimentBucket: vi.fn(() => { eventLog.push("clone bucket"); return { filePath: targetFile.path, bucketBefore: { ...bucket }, entries: [] }; }),
    setSedimentDecisionLog: vi.fn(() => { eventLog.push("decision log"); }),
    buildSedimentDecisionLog: vi.fn(() => ({ groupKey, completedAt: "now", restore: {} })),
    setSedimentCandidateBucket: vi.fn((_file: unknown, patch: Record<string, unknown>) => {
      eventLog.push(patch.todos ? "clear candidates" : patch.hotwords ? "clear candidates" : "persist selection");
      Object.assign(bucket, patch);
    }),
    markSedimentGroupDone: vi.fn(() => { eventLog.push("mark done"); return true; }),
    markSedimentGroupDoneIfEmpty: vi.fn(() => true),
    persistSedimentCandidateBucket: vi.fn(async () => { eventLog.push("persist"); return true; }),
    render: vi.fn(() => { eventLog.push("render"); }),
    showSedimentCommitToast: vi.fn((_message: string, undo: unknown) => { eventLog.push("toast"); Object.assign(view, { lastToastUndo: undo }); }),
    showSedimentToast: vi.fn(() => { eventLog.push("toast"); }),
    scheduleSedimentAutoAdvance: vi.fn(() => { eventLog.push("auto advance"); }),
    buildVocabularyGroupsFromHotwordItems: vi.fn(() => ({ general: ["term"] })),
    applyHotwordRenamesToNote: vi.fn(async () => []),
    removeSedimentPeopleCandidates: vi.fn(),
    applyPeopleRenamesToNote: vi.fn(async () => []),
    keepPeopleSuggestions: vi.fn((file: unknown, suggestions: unknown[]) => OutlineView.prototype.keepPeopleSuggestions.call(view, file, suggestions)),
  });
  vi.mocked(writeSedimentObjectCards).mockImplementation(async () => {
    eventLog.push("write cards");
    return { entries: [] };
  });
  vi.mocked(loadVocabularyGroups).mockImplementation(async () => ({ general: [] }));
  return { view, app, plugin, bucket, state, targetFile, vocabularyFile };
}

describe("OutlineView sediment wiring", () => {
  it.each(["todo", "hotword"] as const)("preserves %s commit ordering", async groupKey => {
    const { view, bucket, targetFile } = makeView(groupKey);
    await view.commitSedimentGroup(targetFile, groupKey);
    const writeIndex = eventLog.findIndex(event => event === (groupKey === "todo" ? "write cards" : "write vocabulary"));
    const decisionIndex = eventLog.indexOf("decision log");
    const clearIndex = eventLog.indexOf("clear candidates");
    const doneIndex = eventLog.indexOf("mark done");
    const persistIndex = eventLog.indexOf("persist");
    const renderIndex = eventLog.indexOf("render");
    const toastIndex = eventLog.indexOf("toast");
    const advanceIndex = eventLog.indexOf("auto advance");
    expect(eventLog.indexOf("clone bucket")).toBeLessThan(writeIndex);
    expect(decisionIndex).toBeGreaterThan(writeIndex);
    expect(clearIndex).toBeGreaterThan(decisionIndex);
    expect(doneIndex).toBeGreaterThan(clearIndex);
    expect(persistIndex).toBeGreaterThan(doneIndex);
    expect(renderIndex).toBeGreaterThan(persistIndex);
    expect(toastIndex).toBeGreaterThan(renderIndex);
    expect(advanceIndex).toBeGreaterThan(toastIndex);
    if (groupKey === "todo") expect(bucket.todos).toEqual([]);
  });

  it("does not defer synchronous bucket snapshots or decision logs", async () => {
    const { view, targetFile } = makeView("todo");
    vi.mocked(view.cloneSedimentBucket).mockImplementation(() => {
      eventLog.push("clone bucket");
      queueMicrotask(() => eventLog.push("after snapshot microtask"));
      return { filePath: targetFile.path, bucketBefore: {}, entries: [] };
    });
    vi.mocked(view.setSedimentDecisionLog).mockImplementation(() => {
      eventLog.push("decision log");
      queueMicrotask(() => eventLog.push("after decision-log microtask"));
    });

    await view.commitSedimentGroup(targetFile, "todo");

    expect(eventLog.indexOf("write cards")).toBeLessThan(eventLog.indexOf("after snapshot microtask"));
    expect(eventLog.indexOf("mark done")).toBeLessThan(eventLog.indexOf("after decision-log microtask"));
  });


  it("captures hotword source and vocabulary snapshots before writing vocabulary", async () => {
    const { view, targetFile } = makeView("hotword");
    await view.commitSedimentGroup(targetFile, "hotword");
    const vocabularyWriteIndex = eventLog.indexOf("write vocabulary");
    expect(eventLog.indexOf("read source snapshot")).toBeLessThan(vocabularyWriteIndex);
    expect(eventLog.indexOf("read vocabulary snapshot")).toBeLessThan(vocabularyWriteIndex);
    const undoRecord = view as unknown as { lastToastUndo: { sourceSnapshot?: { content: string }; vocabulary?: { previousContent: string } } };
    const undo = undoRecord.lastToastUndo;
    expect(undo.sourceSnapshot?.content).toBe("source before");
    expect(undo.vocabulary?.previousContent).toBe("vocabulary before");
  });

  it("routes an unknown group through keepPeopleSuggestions", async () => {
    const { view, targetFile, state } = makeView("unknown", []);
    await view.commitSedimentGroup(targetFile, "unknown");
    expect(view.keepPeopleSuggestions).toHaveBeenCalledWith(targetFile, state.currentPeople);
  });

  it("writes the person decision log before ignoreSedimentGroup returns", async () => {
    const { view, targetFile } = makeView("person");
    await view.ignoreSedimentGroup(targetFile, "person");
    expect(view.setSedimentDecisionLog).toHaveBeenCalledTimes(1);
    expect(eventLog).toEqual(["decision log"]);
  });
  it.each([
    [new TFile("Notes/source.md"), "Notes/source.md"],
    [{ path: "Notes/source.md", basename: "source" }, ""],
  ])("uses a note path only for a TFile in decision items", (file, expectedSourcePath) => {
    const { view, bucket, state } = makeView("person");
    view.appendSedimentDecisionItems(file, "person", [{ name: "Pat" }], "kept", "Added", state);
    const review = bucket.decisionLogByGroup.person as { items: Array<{ id: string }> };
    expect(review.items[0]?.id).toBe(expectedSourcePath);
  });


  it.each([
    [new Error("  x  "), "  x  "],
    [{ message: "m" }, "m"],
    ["string", "string"],
    [null, "null"],
  ])("keeps scan failure Notice text for %j", async (error, expected) => {
    const { view, app, plugin, targetFile } = makeView("todo");
    vi.mocked(app.vault.cachedRead).mockRejectedValueOnce(error);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await view.extractSedimentForFile(targetFile);
    expect(Notice.messages.at(-1)?.message).toBe(`Failed to scan this note:${expected}`);
    expect(plugin.tasks.failTaskActivity).toHaveBeenCalledWith(expect.any(String), error, expect.objectContaining({ detail: getTaskErrorMessage(error) }));
  });

  it.each([
    [new Error("  x  "), "  x  "],
    [{ message: "m" }, "m"],
    ["string", "string"],
    [null, "null"],
  ])("keeps undo failure Notice text for %j", async (error, expected) => {
    const { view, app, targetFile } = makeView("todo");
    vi.mocked(app.vault.modify).mockRejectedValueOnce(error);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await view.restoreSedimentUndo({ entries: [{ path: targetFile.path, created: false }], filePath: targetFile.path });
    expect(Notice.messages.at(-1)?.message).toBe(`Undo failed:${expected}`);
  });

  it("shows the keep-people toast when bucket persistence returns false", async () => {
    const { view, plugin, targetFile, state } = makeView("person");
    vi.mocked(view.persistSedimentCandidateBucket).mockResolvedValueOnce(false);
    await view.keepPeopleSuggestions(targetFile, state.currentPeople);
    expect(view.showSedimentCommitToast).toHaveBeenCalledTimes(1);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("shows the ignore-people toast when bucket persistence returns false", async () => {
    const { view, plugin, targetFile, state } = makeView("person");
    vi.mocked(view.persistSedimentCandidateBucket).mockResolvedValueOnce(false);
    await view.ignorePeopleSuggestions(state.currentPeople, targetFile);
    expect(view.showSedimentToast).toHaveBeenCalledTimes(1);
    expect(plugin.people.ignorePeopleDirectorySuggestion).toHaveBeenCalledTimes(1);
  });
});
