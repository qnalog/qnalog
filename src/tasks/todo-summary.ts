/**
 * To-do summary: collects the Markdown task lines (`- [ ]` / `- [x]`) of QnALog notes, pairs them with the
 * to-dos of the note's session knowledge, and groups, filters and counts them for the summary view.
 *
 * Boundaries (MAINTAINING §6.1 item 3, §7.4 items 1 and 5):
 * - only notes under the QnALog notes folder; derived versions, version caches, `.versions`, topic pages,
 *   person and to-do cards and daily notes are left out;
 * - the completion state is the task mark in the note; nothing else is inferred;
 * - task lines inside the front matter, `<details>` blocks (raw material and machine data), HTML comments,
 *   code fences, the evidence-links block and everything after the "Original material" heading are skipped;
 * - owner, due, acceptance and the evidence time come from session knowledge v3 to-dos paired by text
 *   similarity, one to one. Unpaired lines and notes with v2 or no knowledge show the line text only.
 *
 * Pure module: no Obsidian, DOM or file access.
 */
import {
  NS_TYPE_PERSON,
  NS_TYPE_PERSON_MERGED,
  NS_TYPE_TODO_CARD,
  NS_TYPE_TOPIC,
  NS_TYPE_VERSION_CACHE,
  isTopicErrataFrontmatter,
  isUnpromotedVariantFrontmatter,
  readNamespaceFrontmatter,
} from "../shared/namespace";
import { isPathUnderRecentNoteRoots, normalizeRecentNoteRoot } from "../recent/recent-note-paths";
import { findActiveVersionBlock, iterateNoteDetailsBlocks } from "../notes/note-document";
import { labelPattern } from "../shared/note-labels";
import { findEvidenceLinkBlockRanges } from "../briefing/evidence-links";
import {
  buildKnowledgeEvidenceIndex,
  readSelectedSessionKnowledge,
  resolveIndexedUtterance,
  type ActionAcceptance,
  type KnowledgeItem,
  type SessionKnowledge,
} from "../briefing/session-knowledge";
import { extractTranscriptSegments } from "../notes/note-transcript-ledger";
import { utteranceTime } from "../notes/recording-search";
import { tokenize } from "../indexing/related-notes";
import { bracketsForNumberedLabel, collectSpeakerMentionNames, formatSpeakerMention, noteBodyMentionBrackets } from "../audio/speaker-mentions";
import { formatElapsed } from "../shared/util-common";
import type { TranscriptTiming } from "../transcript/session-transcript";
import type { Segment } from "../shared/types";

/** One list item from Obsidian's metadata cache: the 0-based line and the character inside the brackets. */
export interface TodoListItem {
  line: number;
  /** `" "` for an open task, another character for a checked one, undefined for a plain list item. */
  task?: string;
}

export interface TodoNoteInput {
  path: string;
  title: string;
  /** Note time in milliseconds; groups are ordered newest first by this value. */
  noteTime: number;
  /** Date shown next to the source title, for example `2026-10-25`. */
  noteDate: string;
  frontmatter: Record<string, unknown> | null | undefined;
  /** List items from the metadata cache; null scans every line of `text`. */
  listItems: readonly TodoListItem[] | null | undefined;
  text: string;
}

export interface TodoSummaryScope {
  /** The QnALog notes folder (`mdFolder`); an empty value means the vault root. */
  notesFolder: string;
  /** Folders inside the scope that hold no meeting notes: topics, daily notes. */
  excludedFolders: readonly string[];
}

/** Time link of the paired to-do's first evidence sentence, in the audio file's own clock. */
export interface TodoEvidenceTime {
  linkPath: string;
  /** `mm:ss` or `h:mm:ss`, the label a time link carries. */
  label: string;
  startMs: number;
  precision: Exclude<TranscriptTiming, "unknown">;
}

export interface TodoEntry {
  /** `path#line`; unique within one collection. */
  id: string;
  notePath: string;
  noteTitle: string;
  noteTime: number;
  noteDate: string;
  /** 0-based line number in the note. */
  line: number;
  /** The whole line as read (without a trailing carriage return); the toggle writes only when it still matches. */
  rawLine: string;
  /** Text after the checkbox. */
  text: string;
  checked: boolean;
  /** The character inside the brackets. */
  mark: string;
  /** True when the line sits inside the note's active-version block (see `todo-toggle.ts`). */
  inActiveVersion: boolean;
  /** Owner as said (session knowledge v3). */
  owner?: string;
  /** Owner for display: with speaker brackets (『』 or []) when the owner is a known speaker of the note. */
  ownerLabel?: string;
  /** Due as said, never converted to a date. */
  due?: string;
  acceptance?: ActionAcceptance;
  evidence?: TodoEvidenceTime;
}

/** Minimum similarity for pairing a task line with a session-knowledge to-do. */
export const TODO_PAIRING_THRESHOLD = 0.6;

// —— Scope ——

const EXCLUDED_TYPES = new Set<string>([NS_TYPE_VERSION_CACHE, NS_TYPE_TOPIC, NS_TYPE_PERSON, NS_TYPE_PERSON_MERGED, NS_TYPE_TODO_CARD]);

function isUnder(path: string, folder: string): boolean {
  const root = normalizeRecentNoteRoot(folder);
  return !!root && (path === root || path.startsWith(`${root}/`));
}

/** True when a note path belongs to the summary: under the notes folder, outside excluded and hidden folders. */
export function isTodoSummaryPathInScope(pathValue: string, scope: TodoSummaryScope): boolean {
  const path = normalizeRecentNoteRoot(pathValue);
  if (!path || !/\.md$/i.test(path)) return false;
  if (path.split("/").some((part) => part.startsWith("."))) return false;
  if (!isPathUnderRecentNoteRoots(path, [scope.notesFolder])) return false;
  // An excluded folder that is the notes folder or one of its parents (daily notes kept in `QnALog/`)
  // would exclude every note; only folders inside the notes folder or beside it are excluded.
  const notesRoot = normalizeRecentNoteRoot(scope.notesFolder);
  return !scope.excludedFolders.some((folder) => isUnder(path, folder) && !isUnder(notesRoot, folder));
}

/** True when the front matter marks a file that is not a mother note: a derived version, cache, topic page or card. */
export function isTodoSummaryNoteExcluded(frontmatter: Record<string, unknown> | null | undefined): boolean {
  const fm = frontmatter || {};
  if (isUnpromotedVariantFrontmatter(fm) || isTopicErrataFrontmatter(fm)) return true;
  const type = readNamespaceFrontmatter(fm, "type");
  return typeof type === "string" && EXCLUDED_TYPES.has(type.trim());
}

// —— Task lines ——

export interface ParsedTaskLine {
  /** Everything up to and including `[`: quote markers, indentation and the list marker. */
  head: string;
  mark: string;
  /** `]` and the rest of the line. */
  tail: string;
  text: string;
}

const TASK_LINE_RE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([^\][])(\](?:[ \t].*)?)$/;

/** Splits a Markdown task line; null when the line is not a task. */
export function parseTaskLine(line: string): ParsedTaskLine | null {
  const match = TASK_LINE_RE.exec(line);
  if (!match) return null;
  return { head: match[1], mark: match[2], tail: match[3], text: match[3].slice(1).trim() };
}

/** Open (`[ ]`) and checked (`[x]` / `[X]`) tasks can be toggled; other marks are shown but not changed. */
export function isToggleableMark(mark: string): boolean {
  return mark === " " || mark === "x" || mark === "X";
}

type Range = { start: number; end: number };

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOfOffset(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

const FENCE_RE = /^(?:[ \t]*>)*[ \t]{0,3}(`{3,}|~{3,})/;
const ORIGINAL_MATERIAL_HEADING_RE = new RegExp(`^#{1,6}[ \\t]+(?:${labelPattern("originalMaterial").source})[ \\t]*$`);

/**
 * Lines whose task marks are not to-dos of the note: front matter, `<details>` blocks, HTML comments,
 * the evidence-links block, code fences and everything from the "Original material" heading on.
 */
export function findSkippedTodoLines(text: string): Set<number> {
  const source = String(text || "");
  const starts = lineStarts(source);
  const lines = source.split("\n");
  const skipped = new Set<number>();
  const addLines = (from: number, to: number) => { for (let line = from; line <= to; line++) skipped.add(line); };
  const addRange = (range: Range) => addLines(lineOfOffset(starts, range.start), lineOfOffset(starts, Math.max(range.start, range.end - 1)));

  const frontmatter = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (frontmatter) addRange({ start: 0, end: frontmatter[0].length });
  for (const range of iterateNoteDetailsBlocks(source)) addRange(range);
  for (const match of source.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) addRange({ start: match.index, end: match.index + match[0].length });
  for (const range of findEvidenceLinkBlockRanges(source)) addRange(range);

  let fence: { char: string; length: number } | null = null;
  for (let line = 0; line < lines.length; line++) {
    const content = lines[line].replace(/\r$/, "");
    if (!fence && ORIGINAL_MATERIAL_HEADING_RE.test(content) && !skipped.has(line)) {
      addLines(line, lines.length - 1);
      break;
    }
    const marker = FENCE_RE.exec(content);
    if (fence) {
      skipped.add(line);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
    } else if (marker) {
      skipped.add(line);
      fence = { char: marker[1][0], length: marker[1].length };
    }
  }
  return skipped;
}

function activeVersionLines(text: string): Range | null {
  const block = findActiveVersionBlock(text);
  if (!block) return null;
  const starts = lineStarts(text);
  return { start: lineOfOffset(starts, block.start), end: lineOfOffset(starts, Math.max(block.start, block.end - 1)) };
}

/** True when the 0-based line lies inside the note's active-version block. */
export function isLineInActiveVersionBlock(text: string, line: number): boolean {
  const range = activeVersionLines(text);
  return !!range && line >= range.start && line <= range.end;
}

// —— Pairing with session knowledge ——

function similarity(left: ReadonlySet<string>, right: ReadonlySet<string>): { overlap: number; dice: number } {
  if (!left.size || !right.size) return { overlap: 0, dice: 0 };
  let common = 0;
  for (const token of left) if (right.has(token)) common++;
  return { overlap: common / Math.min(left.size, right.size), dice: (2 * common) / (left.size + right.size) };
}

function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")));
}

/**
 * Pairs task texts with to-do texts one to one. A pair needs an overlap of at least `threshold` on the
 * shorter side's tokens (Han bigrams and Latin words); higher overlap wins, then higher Dice, then order.
 * Returns, per task index, the index of the paired to-do or -1.
 */
export function pairTodoTexts(taskTexts: readonly string[], todoTexts: readonly string[], threshold = TODO_PAIRING_THRESHOLD): number[] {
  const tasks = taskTexts.map(tokenSet);
  const todos = todoTexts.map(tokenSet);
  const candidates: Array<{ task: number; todo: number; overlap: number; dice: number }> = [];
  tasks.forEach((taskTokens, task) => {
    todos.forEach((todoTokens, todo) => {
      const score = similarity(taskTokens, todoTokens);
      if (score.overlap >= threshold) candidates.push({ task, todo, ...score });
    });
  });
  candidates.sort((a, b) => b.overlap - a.overlap || b.dice - a.dice || a.task - b.task || a.todo - b.todo);
  const result = taskTexts.map(() => -1);
  const usedTodos = new Set<number>();
  for (const candidate of candidates) {
    if (result[candidate.task] >= 0 || usedTodos.has(candidate.todo)) continue;
    result[candidate.task] = candidate.todo;
    usedTodos.add(candidate.todo);
  }
  return result;
}

function evidenceTime(item: KnowledgeItem, knowledge: SessionKnowledge, segments: readonly Segment[]): TodoEvidenceTime | undefined {
  if (!item.evidence.length || !segments.length) return undefined;
  const index = buildKnowledgeEvidenceIndex(knowledge, segments);
  for (const id of item.evidence) {
    const utterance = resolveIndexedUtterance(index, id);
    const time = utterance ? utteranceTime(utterance) : null;
    if (time && time.precision !== "unknown") {
      return { linkPath: time.linkPath, label: formatElapsed(time.startMs), startMs: time.startMs, precision: time.precision };
    }
  }
  return undefined;
}

function knowledgeTodos(knowledge: SessionKnowledge | null): KnowledgeItem[] {
  if (!knowledge || knowledge.schemaVersion !== 3 || knowledge.status === "stale" || knowledge.status === "unavailable") return [];
  return knowledge.actions.filter((item) => item.text.trim());
}

// —— Collection ——

/** Numbered speaker labels (`Speaker 3` and the Chinese form) get brackets even before naming. */
function isNumberedSpeakerLabel(owner: string): boolean {
  return bracketsForNumberedLabel(owner) !== null && /\d+$/.test(owner);
}

/** Task lines of one note with paired session-knowledge fields; the note itself is not scope-checked here. */
export function collectNoteTodos(note: TodoNoteInput): TodoEntry[] {
  const text = String(note.text || "");
  const lines = text.split("\n");
  const skipped = findSkippedTodoLines(text);
  const active = activeVersionLines(text);
  const candidateLines = note.listItems
    ? [...new Set(note.listItems.filter((item) => item.task !== undefined).map((item) => item.line))]
    : lines.map((_, line) => line);
  const entries: TodoEntry[] = [];
  for (const line of candidateLines.sort((a, b) => a - b)) {
    if (line < 0 || line >= lines.length || skipped.has(line)) continue;
    const rawLine = lines[line].replace(/\r$/, "");
    const parsed = parseTaskLine(rawLine);
    if (!parsed) continue;
    entries.push({
      id: `${note.path}#${line}`,
      notePath: note.path,
      noteTitle: note.title,
      noteTime: note.noteTime,
      noteDate: note.noteDate,
      line,
      rawLine,
      text: parsed.text,
      checked: parsed.mark !== " ",
      mark: parsed.mark,
      inActiveVersion: !!active && line >= active.start && line <= active.end,
    });
  }
  if (!entries.length) return entries;

  const knowledge = readSelectedSessionKnowledge(text);
  const todos = knowledgeTodos(knowledge);
  if (!knowledge || !todos.length) return entries;
  const pairs = pairTodoTexts(entries.map((entry) => entry.text), todos.map((item) => item.text));
  if (pairs.every((index) => index < 0)) return entries;
  const segments = extractTranscriptSegments(text);
  const speakers = new Set(collectSpeakerMentionNames(segments, note.frontmatter || {}, knowledge.projections));
  const brackets = noteBodyMentionBrackets(text);
  entries.forEach((entry, position) => {
    const item = pairs[position] >= 0 ? todos[pairs[position]] : null;
    if (!item) return;
    const owner = item.owner?.trim();
    if (owner) {
      entry.owner = owner;
      entry.ownerLabel = speakers.has(owner) || isNumberedSpeakerLabel(owner)
        ? formatSpeakerMention(owner, brackets)
        : owner;
    }
    const due = item.due?.trim();
    if (due) entry.due = due;
    if (item.acceptance) entry.acceptance = item.acceptance;
    const time = evidenceTime(item, knowledge, segments);
    if (time) entry.evidence = time;
  });
  return entries;
}

/** All to-dos of the notes in scope, newest note first, then by line. */
export function collectTodoSummary(notes: readonly TodoNoteInput[], scope: TodoSummaryScope): TodoEntry[] {
  return notes
    .filter((note) => isTodoSummaryPathInScope(note.path, scope) && !isTodoSummaryNoteExcluded(note.frontmatter))
    .flatMap(collectNoteTodos)
    .sort(compareEntries);
}

function compareEntries(a: TodoEntry, b: TodoEntry): number {
  return b.noteTime - a.noteTime || a.notePath.localeCompare(b.notePath) || a.line - b.line;
}

/** True when the cached list items hold at least one task; notes without tasks need not be read. */
export function hasTaskListItems(listItems: readonly TodoListItem[] | null | undefined): boolean {
  return !!listItems && listItems.some((item) => item.task !== undefined);
}

// —— Filtering, grouping and counts ——

export type TodoStatusFilter = "open" | "done" | "all";
export type TodoGrouping = "note" | "owner";

export interface TodoFilter {
  status: TodoStatusFilter;
  /** Owner key from `todoOwnerKey`; empty for every owner, `NO_OWNER_KEY` for to-dos without one. */
  owner: string;
  /** Only to-dos with a due. */
  hasDue: boolean;
}

export const DEFAULT_TODO_FILTER: TodoFilter = { status: "open", owner: "", hasDue: false };
/** Owner key of to-dos without an owner. */
export const NO_OWNER_KEY = "\u0000none";

/** Grouping key for an owner: whitespace collapsed, case folded, brackets of speaker marks ignored. */
export function todoOwnerKey(entry: Pick<TodoEntry, "owner">): string {
  const owner = String(entry.owner || "").replace(/\s+/g, " ").trim();
  return owner ? owner.normalize("NFKC").toLocaleLowerCase() : NO_OWNER_KEY;
}

export function filterTodos(entries: readonly TodoEntry[], filter: TodoFilter): TodoEntry[] {
  return entries.filter((entry) => {
    if (filter.status === "open" && entry.checked) return false;
    if (filter.status === "done" && !entry.checked) return false;
    if (filter.owner && todoOwnerKey(entry) !== filter.owner) return false;
    if (filter.hasDue && !entry.due) return false;
    return true;
  });
}

export interface TodoCounts { open: number; done: number; total: number }

export function countTodos(entries: readonly TodoEntry[]): TodoCounts {
  const done = entries.filter((entry) => entry.checked).length;
  return { open: entries.length - done, done, total: entries.length };
}

export interface TodoOwnerOption { key: string; label: string; count: number }

/** Owners for the owner filter, most to-dos first; to-dos without an owner come last. */
export function listTodoOwners(entries: readonly TodoEntry[]): TodoOwnerOption[] {
  const byKey = new Map<string, TodoOwnerOption>();
  for (const entry of entries) {
    const key = todoOwnerKey(entry);
    const existing = byKey.get(key);
    if (existing) existing.count++;
    else byKey.set(key, { key, label: key === NO_OWNER_KEY ? "" : (entry.ownerLabel || entry.owner || ""), count: 1 });
  }
  return [...byKey.values()].sort((a, b) => Number(a.key === NO_OWNER_KEY) - Number(b.key === NO_OWNER_KEY)
    || b.count - a.count || a.label.localeCompare(b.label));
}

export interface TodoGroup {
  key: string;
  /** Note title or owner label; empty for the "no owner" group. */
  label: string;
  /** Note date for note groups. */
  date: string;
  notePath?: string;
  entries: TodoEntry[];
  counts: TodoCounts;
}

/**
 * Groups by source note (newest note first) or by owner (most to-dos first, "no owner" last).
 * Entries keep the collection order inside a group.
 */
export function groupTodos(entries: readonly TodoEntry[], by: TodoGrouping): TodoGroup[] {
  const groups = new Map<string, TodoGroup>();
  const sorted = [...entries].sort(compareEntries);
  for (const entry of sorted) {
    const key = by === "note" ? entry.notePath : todoOwnerKey(entry);
    let group = groups.get(key);
    if (!group) {
      group = by === "note"
        ? { key, label: entry.noteTitle, date: entry.noteDate, notePath: entry.notePath, entries: [], counts: { open: 0, done: 0, total: 0 } }
        : { key, label: key === NO_OWNER_KEY ? "" : (entry.ownerLabel || entry.owner || ""), date: "", entries: [], counts: { open: 0, done: 0, total: 0 } };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  const list = [...groups.values()];
  for (const group of list) group.counts = countTodos(group.entries);
  if (by === "owner") {
    list.sort((a, b) => Number(a.key === NO_OWNER_KEY) - Number(b.key === NO_OWNER_KEY)
      || b.entries.length - a.entries.length || a.label.localeCompare(b.label));
  }
  return list;
}
