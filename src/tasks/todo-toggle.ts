/**
 * Ticks or unticks one to-do from the summary, writing only the character inside the brackets.
 *
 * Before writing, the line at `entry.line` must still equal `entry.rawLine` in full; otherwise nothing is
 * written and the caller gets a conflict. The check runs on a fresh read and again inside the atomic
 * `process` callback, so a change between the two reads also leaves the note unchanged.
 *
 * Lines inside an active-version block are refused. Switching versions (`VersionStore.switchVersion`)
 * replaces that block's body with the stored snapshot (`versions/version-activation-store.ts`
 * `applyToSource` → `versions/active-version-block.ts` `replaceActiveVersionBlock`), and the snapshots in
 * `.versions` are never updated from the mother note, so a tick written there would be lost on the next
 * switch. The summary does not write to `.versions`; the user updates such to-dos in the note.
 */
import { isLineInActiveVersionBlock, isToggleableMark, parseTaskLine, type TodoEntry } from "./todo-summary";

export interface TodoTogglePort {
  /** Current text of the note, or null when the file no longer exists. */
  read(path: string): Promise<string | null>;
  /**
   * Atomic read-modify-write (`vault.process`). Returns false when the file no longer exists.
   * The callback returns the text to save; returning the input unchanged means no change.
   */
  process(path: string, update: (text: string) => string): Promise<boolean>;
}

export type TodoToggleConflict = "missing" | "changed" | "active-version" | "unsupported";

export type TodoToggleResult =
  | { status: "ok"; rawLine: string }
  | { status: "unchanged" }
  | { status: "conflict"; reason: TodoToggleConflict };

/** The checked line, or the reason it cannot be toggled. */
type LineCheck = { lines: string[]; line: string; eol: string } | TodoToggleConflict;

function checkLine(text: string, entry: Pick<TodoEntry, "line" | "rawLine">): LineCheck {
  const lines = text.split("\n");
  if (entry.line < 0 || entry.line >= lines.length) return "changed";
  const full = lines[entry.line];
  const eol = full.endsWith("\r") ? "\r" : "";
  const line = eol ? full.slice(0, -1) : full;
  if (line !== entry.rawLine) return "changed";
  const parsed = parseTaskLine(line);
  if (!parsed) return "changed";
  if (!isToggleableMark(parsed.mark)) return "unsupported";
  if (isLineInActiveVersionBlock(text, entry.line)) return "active-version";
  return { lines, line, eol };
}

/** The task line with its mark set to `[x]` or `[ ]`; null when it is not a task line. */
export function setTaskLineChecked(line: string, checked: boolean): string | null {
  const parsed = parseTaskLine(line);
  if (!parsed) return null;
  return `${parsed.head}${checked ? "x" : " "}${parsed.tail}`;
}

export async function toggleTodo(
  port: TodoTogglePort,
  entry: Pick<TodoEntry, "notePath" | "line" | "rawLine">,
  nextChecked: boolean,
): Promise<TodoToggleResult> {
  const current = await port.read(entry.notePath);
  if (current === null) return { status: "conflict", reason: "missing" };
  const first = checkLine(current, entry);
  if (typeof first === "string") return { status: "conflict", reason: first };
  const parsed = parseTaskLine(first.line);
  if (parsed && (parsed.mark !== " ") === nextChecked) return { status: "unchanged" };

  let outcome: TodoToggleResult = { status: "conflict", reason: "changed" };
  const found = await port.process(entry.notePath, (text) => {
    const check = checkLine(text, entry);
    if (typeof check === "string") {
      outcome = { status: "conflict", reason: check };
      return text;
    }
    const next = setTaskLineChecked(check.line, nextChecked);
    if (next === null || next === check.line) {
      outcome = next === null ? { status: "conflict", reason: "changed" } : { status: "unchanged" };
      return text;
    }
    check.lines[entry.line] = `${next}${check.eol}`;
    outcome = { status: "ok", rawLine: next };
    return check.lines.join("\n");
  });
  if (!found) return { status: "conflict", reason: "missing" };
  return outcome;
}
