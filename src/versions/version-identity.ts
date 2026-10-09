import * as obsidian from "obsidian";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { hashRealtimeOutlineText } from "../notes/outline-text";
import { sanitizeFilename } from "../shared/util-common";
import type { PluginSettings, Segment } from "../shared/types";
import type { VersionSegmentStatus } from "./version-save-store";

export function buildSegmentStatusList(segments: readonly Segment[] | null | undefined): VersionSegmentStatus[] {
  return (segments || []).map((seg, i) => {
    const text = String(seg && seg.text || "").trim();
    const start = Number(seg && seg.startOffsetMs) || 0;
    const end = Number(seg && seg.endOffsetMs) || start;
    return {
      id: `seg-${String(i + 1).padStart(4, "0")}`,
      index: i,
      startOffsetMs: start,
      endOffsetMs: end,
      status: text ? "done" : "pending",
      textHash: text ? hashRealtimeOutlineText(text) : "",
    };
  });
}

export function getVersionStoreFolder(
  settings: Pick<PluginSettings, "mdFolder"> | null | undefined,
  sourceId: string,
): string {
  const base = obsidian.normalizePath(String(settings && settings.mdFolder || DEFAULT_SETTINGS.mdFolder || "QnALog"));
  const safeId = sanitizeFilename(sourceId) || "unknown-session";
  return obsidian.normalizePath(`${base}/.versions/${safeId}`);
}

export function normalizeVersionId(label: string): string {
  const stamp = window.moment ? window.moment().format("YYYYMMDD-HHmmss") : new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const safe = sanitizeFilename(label) || "version";
  return `${stamp}-${safe}`;
}
