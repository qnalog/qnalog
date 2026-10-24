/**
 * "Find in recording" field in the sidebar note panel, under the inline audio player.
 *
 * The search itself is `notes/recording-search.ts`; this module builds the field and the result rows,
 * debounces typing, keeps the query and focus across sidebar re-renders, and reports a clicked row's
 * target to the caller, which seeks the inline player through the time-link path.
 */
import { setIcon } from "obsidian";
import { t } from "../shared/i18n";
import {
  searchRecording,
  type RecordingSearchIndex,
  type RecordingSearchOutcome,
  type RecordingSearchResult,
  type RecordingSearchTarget,
} from "../notes/recording-search";
import type { TranscriptTiming } from "../transcript/session-transcript";

/** Delay between the last keystroke and the search. */
export const RECORDING_SEARCH_DEBOUNCE_MS = 200;
/** How long a focus request from the command stays valid while the note panel is still loading. */
const FOCUS_REQUEST_TTL_MS = 5000;

export interface RecordingSearchTimers {
  set(callback: () => void, ms: number): number;
  clear(handle: number): void;
  now(): number;
}

export interface RecordingSearchRenderOptions {
  index: RecordingSearchIndex;
  /** Note path; the query is kept while the panel shows the same note. */
  filePath: string;
  onSeek: (target: RecordingSearchTarget) => void;
}

/** One piece of a result snippet; `hit` pieces are highlighted. */
export interface SnippetPart {
  text: string;
  hit: boolean;
}

/** Splits a snippet into plain and highlighted pieces by its hit ranges. */
export function snippetParts(result: Pick<RecordingSearchResult, "snippet" | "hits">): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let at = 0;
  for (const hit of result.hits) {
    if (hit.start > at) parts.push({ text: result.snippet.slice(at, hit.start), hit: false });
    if (hit.end > hit.start) parts.push({ text: result.snippet.slice(hit.start, hit.end), hit: true });
    at = Math.max(at, hit.end);
  }
  if (at < result.snippet.length) parts.push({ text: result.snippet.slice(at), hit: false });
  return parts;
}

/** Text shown next to the time: nothing for provider times, "approx." for audio spans, the segment note for segment starts. */
export function precisionNote(precision: TranscriptTiming): string {
  if (precision === "audio-span") return t("approx.");
  if (precision === "segment") return t("approximately in this segment");
  return "";
}

/** The status line under the rows: "No matches", the count over the limit, or nothing. */
export function outcomeStatus(outcome: RecordingSearchOutcome): string {
  if (!outcome.terms.length) return "";
  if (!outcome.total) return t("No matches");
  if (outcome.more > 0) return t("{0} more results not shown; add words to narrow the search.").replace("{0}", String(outcome.more));
  return "";
}

function defaultTimers(): RecordingSearchTimers {
  return {
    set: (callback, ms) => window.setTimeout(callback, ms),
    clear: (handle) => window.clearTimeout(handle),
    now: () => Date.now(),
  };
}

export class RecordingSearchController {
  private readonly timers: RecordingSearchTimers;
  private query = "";
  private filePath = "";
  private timer = 0;
  private focusRequestedAt = 0;
  private restoreFocus = false;
  private selection: { start: number; end: number } | null = null;
  private input: HTMLInputElement | null = null;

  constructor(timers: RecordingSearchTimers = defaultTimers()) {
    this.timers = timers;
  }

  /** Current query text as typed. */
  getQuery(): string {
    return this.query;
  }

  /** The command asks for the field to be focused on the next render of a searchable note. */
  requestFocus(): void {
    this.focusRequestedAt = this.timers.now();
  }

  /** Call before the sidebar empties its DOM: remembers whether the field had focus, so the new field gets it back. */
  captureFocusBeforeRender(): void {
    const input = this.input;
    const active = input && input.isConnected ? input.ownerDocument.activeElement : null;
    this.restoreFocus = !!input && active === input;
    this.selection = this.restoreFocus && input
      ? { start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length }
      : null;
  }

  /**
   * The note panel loaded without a searchable recording. Returns true when a focus request from the
   * command was pending, so the caller can say why the field is missing.
   */
  takeUnavailableFocusRequest(): boolean {
    const pending = this.hasFocusRequest();
    this.focusRequestedAt = 0;
    this.restoreFocus = false;
    this.input = null;
    return pending;
  }

  dispose(): void {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = 0;
    this.input = null;
  }

  private hasFocusRequest(): boolean {
    return !!this.focusRequestedAt && this.timers.now() - this.focusRequestedAt <= FOCUS_REQUEST_TTL_MS;
  }

  render(parent: HTMLElement, options: RecordingSearchRenderOptions): void {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = 0;
    if (options.filePath !== this.filePath) {
      this.filePath = options.filePath;
      this.query = "";
    }
    const section = parent.createDiv({ cls: "qnalog-outline-section qnalog-recording-search" });
    const box = section.createDiv({ cls: "qnalog-recording-search-box" });
    const icon = box.createSpan({ cls: "qnalog-recording-search-icon" });
    try { setIcon(icon, "search"); } catch { /* intentionally empty */ }
    const input = box.createEl("input", {
      cls: "qnalog-recording-search-input",
      attr: { type: "search", placeholder: t("Find in recording"), "aria-label": t("Find in recording"), spellcheck: "false", enterkeyhint: "search" },
    });
    input.value = this.query;
    const results = section.createDiv({ cls: "qnalog-recording-search-results", attr: { role: "list" } });
    const status = section.createDiv({ cls: "qnalog-recording-search-status", attr: { role: "status", "aria-live": "polite" } });
    this.input = input;

    const show = () => {
      results.empty();
      status.setText("");
      const outcome = searchRecording(options.index, this.query);
      this.renderRows(results, outcome.results, options.onSeek);
      status.setText(outcomeStatus(outcome));
      section.toggleClass("has-query", outcome.terms.length > 0);
    };
    input.addEventListener("input", () => {
      this.query = input.value;
      if (this.timer) this.timers.clear(this.timer);
      this.timer = this.timers.set(() => {
        this.timer = 0;
        show();
      }, RECORDING_SEARCH_DEBOUNCE_MS);
    });
    input.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Escape" && input.value) {
        evt.preventDefault();
        input.value = "";
        this.query = "";
        if (this.timer) this.timers.clear(this.timer);
        this.timer = 0;
        show();
      } else if (evt.key === "Enter") {
        // Search at once instead of waiting for the debounce.
        evt.preventDefault();
        if (this.timer) this.timers.clear(this.timer);
        this.timer = 0;
        show();
      } else if (evt.key === "ArrowDown") {
        const first = results.querySelector<HTMLElement>(".qnalog-recording-search-row");
        if (first) { evt.preventDefault(); first.focus(); }
      }
    });
    show();

    if (this.hasFocusRequest() || this.restoreFocus) {
      const selection = this.selection;
      this.focusRequestedAt = 0;
      this.restoreFocus = false;
      this.selection = null;
      input.focus();
      if (selection) {
        try { input.setSelectionRange(selection.start, selection.end); } catch { /* intentionally empty */ }
      }
    }
  }

  private renderRows(host: HTMLElement, rows: readonly RecordingSearchResult[], onSeek: (target: RecordingSearchTarget) => void): void {
    rows.forEach((result, position) => {
      // 用 div 加按钮语义，不用 <button>：Obsidian 的按钮样式（居中、固定高度）会让多行结果错位重叠。
      const row = host.createDiv({
        cls: `qnalog-recording-search-row${result.target ? "" : " is-unplayable"}`,
        attr: { role: "button", tabindex: result.target ? "0" : "-1" },
      });
      const timeLabel = result.timeLabel || t("time unknown");
      const note = precisionNote(result.precision);
      row.setAttribute("aria-label", result.target
        ? t("Play from {0}").replace("{0}", note ? `${timeLabel} ${note}` : timeLabel)
        : timeLabel);
      if (!result.target) row.setAttribute("aria-disabled", "true");
      const meta = row.createDiv({ cls: "qnalog-recording-search-meta" });
      meta.createSpan({ cls: "qnalog-recording-search-time", text: timeLabel });
      if (note && result.target) meta.createSpan({ cls: "qnalog-recording-search-precision", text: note });
      if (result.speaker) {
        meta.createSpan({
          cls: `qnalog-recording-search-speaker${result.matchedIn === "text" ? "" : " is-hit"}`,
          text: result.speaker,
        });
      }
      const snippet = row.createDiv({ cls: "qnalog-recording-search-snippet" });
      for (const part of snippetParts(result)) {
        if (part.hit) snippet.createEl("mark", { cls: "qnalog-recording-search-hit", text: part.text });
        else snippet.createSpan({ text: part.text });
      }
      const target = result.target;
      if (target) row.addEventListener("click", () => onSeek(target));
      row.addEventListener("keydown", (evt: KeyboardEvent) => {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          if (target) onSeek(target);
          return;
        }
        if (evt.key !== "ArrowDown" && evt.key !== "ArrowUp") return;
        const all = Array.from(host.querySelectorAll<HTMLElement>(".qnalog-recording-search-row"));
        const next = evt.key === "ArrowDown" ? all[position + 1] : position === 0 ? this.input : all[position - 1];
        if (next) { evt.preventDefault(); next.focus(); }
      });
    });
  }
}
