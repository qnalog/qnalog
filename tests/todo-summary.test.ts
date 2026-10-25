import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  parseYaml: () => ({}),
  Notice: class Notice {},
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import {
  NO_OWNER_KEY,
  collectNoteTodos,
  collectTodoSummary,
  countTodos,
  filterTodos,
  findSkippedTodoLines,
  groupTodos,
  isTodoSummaryNoteExcluded,
  isTodoSummaryPathInScope,
  listTodoOwners,
  pairTodoTexts,
  parseTaskLine,
  todoOwnerKey,
  type TodoEntry,
  type TodoListItem,
  type TodoNoteInput,
} from "../src/tasks/todo-summary";
import { NS_TYPE_DERIVED, NS_TYPE_TOPIC, NS_TYPE_VERSION_CACHE } from "../src/shared/namespace";
import { replaceActiveVersionBlock } from "../src/versions/active-version-block";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { AUDIO, BODY_LINES, buildNote, knowledgeWith, lineOf, DEFAULT_ACTIONS } from "./helpers/todo-summary-fixture";

const previousLanguage = getActiveUiLanguage();
beforeAll(() => setActiveUiLanguage(resolveUiLanguage("en", "en")));
afterAll(() => setActiveUiLanguage(previousLanguage));

const SCOPE = { notesFolder: "QnALog/Notes", excludedFolders: ["QnALog/Notes/Topics", "Daily"] };

/** List items as Obsidian's metadata cache reports them for the given task texts (and one plain item). */
function cachedItems(note: string, taskTexts: string[], plainTexts: string[] = []): TodoListItem[] {
  return [
    ...taskTexts.map((text) => ({ line: lineOf(note, text), task: text.includes("invite") ? "x" : " " })),
    ...plainTexts.map((text) => ({ line: lineOf(note, text) })),
  ];
}

function input(note: string, overrides: Partial<TodoNoteInput> = {}): TodoNoteInput {
  return {
    path: "QnALog/Notes/2026-10-20 1000 Pilot.md",
    title: "Pilot",
    noteTime: Date.UTC(2026, 9, 20, 10),
    noteDate: "2026-10-20",
    frontmatter: { qnalog_mode: "meeting" },
    listItems: null,
    text: note,
    ...overrides,
  };
}

const VISIBLE_TASKS = [
  "Prepare the launch checklist",
  "Send the pilot invite to the partners",
  "Book the review room",
  "Draft the review agenda",
  "Call the vendor about pricing",
];

describe("to-do summary scope", () => {
  it("keeps notes under the notes folder and leaves out other folders, excluded folders and hidden folders", () => {
    expect(isTodoSummaryPathInScope("QnALog/Notes/2026-10-20 Pilot.md", SCOPE)).toBe(true);
    expect(isTodoSummaryPathInScope("QnALog/Notes/Sub/2026-10-20 Pilot.md", SCOPE)).toBe(true);
    expect(isTodoSummaryPathInScope("QnALog/Other/2026-10-20 Pilot.md", SCOPE)).toBe(false);
    expect(isTodoSummaryPathInScope("Projects/Pilot.md", SCOPE)).toBe(false);
    expect(isTodoSummaryPathInScope("QnALog/Notes/Topics/Pilot topic.md", SCOPE)).toBe(false);
    expect(isTodoSummaryPathInScope("QnALog/Notes/.versions/pilot/original.md", SCOPE)).toBe(false);
    expect(isTodoSummaryPathInScope("QnALog/Notes/2026-10-20 Pilot.canvas", SCOPE)).toBe(false);
    expect(isTodoSummaryPathInScope("Daily/2026-10-20.md", { notesFolder: "", excludedFolders: ["Daily"] })).toBe(false);
    expect(isTodoSummaryPathInScope("2026-10-20 Pilot.md", { notesFolder: "", excludedFolders: ["Daily"] })).toBe(true);
  });

  it("ignores an excluded folder that contains the notes folder", () => {
    const scope = { notesFolder: "QnALog/Notes", excludedFolders: ["QnALog", "QnALog/Notes"] };
    expect(isTodoSummaryPathInScope("QnALog/Notes/2026-10-20 Pilot.md", scope)).toBe(true);
  });

  it("leaves out derived versions, version caches, topic pages and topic errata, but keeps promoted variants", () => {
    expect(isTodoSummaryNoteExcluded({ qnalog_mode: "meeting" })).toBe(false);
    expect(isTodoSummaryNoteExcluded({ qnalog_type: NS_TYPE_DERIVED })).toBe(true);
    expect(isTodoSummaryNoteExcluded({ qnalog_contains_raw: false })).toBe(true);
    expect(isTodoSummaryNoteExcluded({ qnalog_type: NS_TYPE_DERIVED, qnalog_promoted_variant: true })).toBe(false);
    expect(isTodoSummaryNoteExcluded({ qnalog_type: NS_TYPE_VERSION_CACHE })).toBe(true);
    expect(isTodoSummaryNoteExcluded({ qnalog_type: NS_TYPE_TOPIC })).toBe(true);
    expect(isTodoSummaryNoteExcluded({ qnalog_topic_errata: true })).toBe(true);
  });

  it("collects only the notes in scope", () => {
    const note = buildNote();
    const entries = collectTodoSummary([
      input(note),
      input(note, { path: "QnALog/Notes/【Clean】Pilot.md", frontmatter: { qnalog_type: NS_TYPE_DERIVED } }),
      input(note, { path: "QnALog/Notes/Topics/Pilot.md" }),
      input(note, { path: "Daily/2026-10-20.md" }),
      input(note, { path: "Elsewhere/Pilot.md" }),
    ], SCOPE);
    expect(new Set(entries.map((entry) => entry.notePath))).toEqual(new Set(["QnALog/Notes/2026-10-20 1000 Pilot.md"]));
  });
});

describe("task lines and skipped regions", () => {
  it("reads -, *, numbered, indented and quoted task lines and their checked state", () => {
    const note = buildNote();
    const entries = collectNoteTodos(input(note));
    expect(entries.map((entry) => entry.text)).toEqual(VISIBLE_TASKS);
    expect(entries.map((entry) => entry.checked)).toEqual([false, true, false, false, false]);
    const agenda = entries.find((entry) => entry.text === "Draft the review agenda")!;
    expect(agenda.rawLine).toBe("   - [ ] Draft the review agenda");
    expect(agenda.line).toBe(lineOf(note, "Draft the review agenda"));
  });

  it("skips front matter, code fences, the evidence block, HTML comments, details blocks and the original material", () => {
    const note = buildNote();
    const skipped = findSkippedTodoLines(note);
    for (const text of [
      "Example task inside a code fence",
      "Task inside the evidence block",
      "Task inside an HTML comment",
      "Task inside raw material",
      "Task after the original material heading",
      "qnalog_mode: meeting",
    ]) expect(skipped.has(lineOf(note, text)), text).toBe(true);
    for (const text of VISIBLE_TASKS) expect(skipped.has(lineOf(note, text)), text).toBe(false);
  });

  it("uses the cached list items: plain items and stale lines are ignored, skipped regions stay skipped", () => {
    const note = buildNote();
    const items = [
      ...cachedItems(note, ["Prepare the launch checklist", "Task inside raw material"], ["plain list item"]),
      { line: lineOf(note, "The team agreed"), task: " " },
      { line: 9999, task: " " },
    ];
    const entries = collectNoteTodos(input(note, { listItems: items }));
    expect(entries.map((entry) => entry.text)).toEqual(["Prepare the launch checklist"]);
  });

  it("parses the parts of a task line", () => {
    expect(parseTaskLine("> 2. [X] Done item")).toEqual({ head: "> 2. [", mark: "X", tail: "] Done item", text: "Done item" });
    expect(parseTaskLine("- [ ]")).toEqual({ head: "- [", mark: " ", tail: "]", text: "" });
    expect(parseTaskLine("- [] not a task")).toBeNull();
    expect(parseTaskLine("- [ ]no space")).toBeNull();
    expect(parseTaskLine("text - [ ] inline")).toBeNull();
  });
});

describe("pairing with session knowledge", () => {
  it("adds owner, due, acceptance and the evidence time of the paired v3 to-do", () => {
    const entries = collectNoteTodos(input(buildNote()));
    const checklist = entries.find((entry) => entry.text === "Prepare the launch checklist")!;
    expect(checklist).toMatchObject({ owner: "Speaker 2", ownerLabel: "[Speaker 2]", due: "by Friday", acceptance: "assigned" });
    expect(checklist.evidence).toEqual({ linkPath: AUDIO, label: "00:42", startMs: 42_000, precision: "audio-span" });
    const invite = entries.find((entry) => entry.text === "Send the pilot invite to the partners")!;
    expect(invite).toMatchObject({ owner: "Bob", ownerLabel: "Bob", acceptance: "accepted" });
    expect(invite.due).toBeUndefined();
    expect(invite.evidence).toMatchObject({ label: "00:50", precision: "provider" });
    const vendor = entries.find((entry) => entry.text === "Call the vendor about pricing")!;
    expect(vendor.owner).toBeUndefined();
    expect(vendor.acceptance).toBe("assigned");
  });

  it("shows unpaired lines with their text only", () => {
    const entries = collectNoteTodos(input(buildNote()));
    for (const text of ["Book the review room", "Draft the review agenda"]) {
      const entry = entries.find((item) => item.text === text)!;
      expect(entry.owner).toBeUndefined();
      expect(entry.due).toBeUndefined();
      expect(entry.acceptance).toBeUndefined();
      expect(entry.evidence).toBeUndefined();
    }
  });

  it("does not fill in fields for notes with v2 or no session knowledge", () => {
    for (const knowledge of [knowledgeWith(DEFAULT_ACTIONS, 2), null]) {
      const entries = collectNoteTodos(input(buildNote({ knowledge })));
      expect(entries.map((entry) => entry.text)).toEqual(VISIBLE_TASKS);
      expect(entries.every((entry) => !entry.owner && !entry.due && !entry.acceptance && !entry.evidence)).toBe(true);
    }
  });

  it("pairs one to one by Han bigram and word overlap, best match first", () => {
    expect(pairTodoTexts(
      ["事项：整理发布清单 责任人：『张华』 截止：周五", "预订评审会议室"],
      ["联系供应商确认报价", "整理发布清单"],
    )).toEqual([1, -1]);
    expect(pairTodoTexts(["整理发布清单", "整理发布清单"], ["整理发布清单"])).toEqual([0, -1]);
    expect(pairTodoTexts(["Prepare the launch checklist", "Prepare the launch checklist and slides"], ["Prepare the launch checklist and slides"])).toEqual([-1, 0]);
    expect(pairTodoTexts(["Book the review room"], ["Prepare the launch checklist"])).toEqual([-1]);
  });

  it("gives each knowledge to-do to only one line when two lines say the same thing", () => {
    const body = [...BODY_LINES.slice(0, 5), "- [ ] Prepare the launch checklist", ...BODY_LINES.slice(5)];
    const entries = collectNoteTodos(input(buildNote({ body })));
    const twins = entries.filter((entry) => entry.text === "Prepare the launch checklist");
    expect(twins).toHaveLength(2);
    expect(twins.filter((entry) => entry.owner === "Speaker 2")).toHaveLength(1);
  });
});

describe("active-version blocks", () => {
  it("marks lines inside the active-version block", () => {
    const base = buildNote();
    const versioned = replaceActiveVersionBlock(base, { label: "Clean copy" }, "- [ ] Task in the version body\n\nText.");
    const entries = collectNoteTodos(input(versioned));
    const inside = entries.find((entry) => entry.text === "Task in the version body")!;
    expect(inside.inActiveVersion).toBe(true);
  });
});

function entry(overrides: Partial<TodoEntry>): TodoEntry {
  return {
    id: `${overrides.notePath ?? "a.md"}#${overrides.line ?? 0}`,
    notePath: "a.md", noteTitle: "A", noteTime: 1, noteDate: "2026-10-01",
    line: 0, rawLine: "- [ ] x", text: "x", checked: false, mark: " ", inActiveVersion: false,
    ...overrides,
  };
}

describe("grouping, filtering and counts", () => {
  const entries = [
    entry({ notePath: "old.md", noteTitle: "Old", noteTime: 1, line: 3, text: "old open", owner: "Alice", ownerLabel: "[Alice]" }),
    entry({ notePath: "new.md", noteTitle: "New", noteTime: 5, line: 7, text: "new done", checked: true, mark: "x", owner: "alice", due: "Friday" }),
    entry({ notePath: "new.md", noteTitle: "New", noteTime: 5, line: 2, text: "new open", owner: "Bob" }),
    entry({ notePath: "new.md", noteTitle: "New", noteTime: 5, line: 9, text: "no owner", due: "next week" }),
  ];

  it("counts open, done and total", () => {
    expect(countTodos(entries)).toEqual({ open: 3, done: 1, total: 4 });
  });

  it("groups by note, newest note first, lines in order", () => {
    const groups = groupTodos(entries, "note");
    expect(groups.map((group) => group.label)).toEqual(["New", "Old"]);
    expect(groups[0].entries.map((item) => item.line)).toEqual([2, 7, 9]);
    expect(groups[0].counts).toEqual({ open: 2, done: 1, total: 3 });
  });

  it("groups by owner with case-folded keys, the largest group first and no owner last", () => {
    const groups = groupTodos(entries, "owner");
    expect(groups.map((group) => group.key)).toEqual(["alice", "bob", NO_OWNER_KEY]);
    expect(groups[0].entries).toHaveLength(2);
    expect(groups[2].label).toBe("");
  });

  it("filters by status, owner and due", () => {
    expect(filterTodos(entries, { status: "open", owner: "", hasDue: false }).map((item) => item.text)).toEqual(["old open", "new open", "no owner"]);
    expect(filterTodos(entries, { status: "done", owner: "", hasDue: false }).map((item) => item.text)).toEqual(["new done"]);
    expect(filterTodos(entries, { status: "all", owner: "alice", hasDue: false })).toHaveLength(2);
    expect(filterTodos(entries, { status: "all", owner: NO_OWNER_KEY, hasDue: false }).map((item) => item.text)).toEqual(["no owner"]);
    expect(filterTodos(entries, { status: "open", owner: "", hasDue: true }).map((item) => item.text)).toEqual(["no owner"]);
  });

  it("lists owners for the filter with counts", () => {
    expect(listTodoOwners(entries).map((owner) => [owner.key, owner.count])).toEqual([["alice", 2], ["bob", 1], [NO_OWNER_KEY, 1]]);
    expect(todoOwnerKey({ owner: "  Alice  " })).toBe("alice");
    expect(todoOwnerKey({})).toBe(NO_OWNER_KEY);
  });
});
