import { extractSessionId } from "./note-document";
import { hashRealtimeOutlineText } from "./outline-text";
import { sanitizeFilename } from "../shared/util-common";
import { readNamespaceFrontmatter } from "../shared/namespace";
import type { Segment } from "../shared/types";

type NoteSourceFile = {
  path?: string;
  basename?: string;
  stat?: { ctime?: number } | null;
};
type NoteSourceMomentResult = { isValid?: () => boolean; toDate(): Date };
type NoteSourceMoment = ((
  value: string, formats: readonly unknown[] | string, strict: boolean,
) => NoteSourceMomentResult | null | undefined) & { ISO_8601: unknown };
type NoteSourceWindow = { moment?: NoteSourceMoment | null };
const stringifyNoteSourceValue = String as (value: unknown) => string;

export function getSourceIdFromMarkdown(
  markdown: unknown, file: NoteSourceFile | null | undefined,
): string {
  const text = stringifyNoteSourceValue(markdown || "");
  const sessionId = extractSessionId(text, "");
  if (sessionId) return sanitizeFilename(sessionId) || sessionId;
  const basis = `${file && file.path || "note"}:${file && file.stat && file.stat.ctime || ""}`;
  return `note-${hashRealtimeOutlineText(basis)}`;
}

export function inferNoteStartedAtIso(
  file: NoteSourceFile | null | undefined,
  frontmatter: Record<string, unknown> | null | undefined,
): string {
  const moment = (window as unknown as NoteSourceWindow).moment;
  const fm = frontmatter || {};
  const candidates = [
    readNamespaceFrontmatter(fm, "time"),
    fm["日期"] && fm["时间"] ? `${fm["日期"] as string}T${fm["时间"] as string}` : "",
    fm["日期"] || fm.date || "",
  ].map(value => stringifyNoteSourceValue(value || "").trim()).filter(Boolean);
  if (moment) {
    for (const value of candidates) {
      const parsed = moment(value, [
        moment.ISO_8601,
        "YYYY-MM-DDTHH:mm:ss",
        "YYYY-MM-DD HH:mm:ss",
        "YYYY-MM-DDTHH:mm",
        "YYYY-MM-DD HH:mm",
        "YYYY-MM-DD",
      ], true);
      if (parsed && parsed.isValid && parsed.isValid()) return parsed.toDate().toISOString();
    }
    const match = stringifyNoteSourceValue(file && file.basename || "").match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{4}))?/);
    if (match) {
      const parsed = moment(match[2] ? `${match[1]} ${match[2]}` : match[1], match[2] ? "YYYY-MM-DD HHmm" : "YYYY-MM-DD", true);
      if (parsed && parsed.isValid && parsed.isValid()) return parsed.toDate().toISOString();
    }
  }
  return new Date(file && file.stat && file.stat.ctime ? file.stat.ctime : Date.now()).toISOString();
}

export function normalizeSegmentsForMergedNote(
  segments: readonly Segment[] | null | undefined,
  offsetMs: unknown, startIndex: unknown,
  sourceFile: NoteSourceFile | null | undefined,
): Segment[] {
  const offset = Math.max(0, Number(offsetMs) || 0);
  const baseIndex = Math.max(0, Number(startIndex) || 0);
  const sourceName = sourceFile && sourceFile.basename ? sourceFile.basename : "";
  const sourcePath = sourceFile && sourceFile.path ? sourceFile.path : "";
  return (segments || []).map((seg, i) => {
    const rawStart = Math.max(0, Number(seg && seg.startOffsetMs) || 0);
    const rawEnd = Math.max(rawStart, Number(seg && seg.endOffsetMs) || 0);
    const start = rawStart + offset;
    const end = Math.max(start, rawEnd + offset);
    const localStart = Number(seg && seg.audioStartOffsetMs);
    const localEnd = Number(seg && seg.audioEndOffsetMs);
    return Object.assign({}, seg || {}, {
      index: baseIndex + i,
      startOffsetMs: start,
      endOffsetMs: end,
      audioStartOffsetMs: Number.isFinite(localStart) && localStart >= 0 ? localStart : rawStart,
      audioEndOffsetMs: Number.isFinite(localEnd) && localEnd >= 0 ? localEnd : rawEnd,
      sourceName: (seg && seg.sourceName) || sourceName,
      sourcePath: (seg && seg.sourcePath) || sourcePath,
    }) as Segment;
  });
}
