import * as obsidian from "obsidian";
import type { Segment } from "../shared/types";
import { t } from "../shared/i18n";

export type NoteMergeSourceFrontmatter = NonNullable<obsidian.CachedMetadata["frontmatter"]>;
export type NoteMergeSourceVault = Pick<obsidian.Vault, "read" | "modify">;

export interface NoteMergeSource {
  file: obsidian.TFile;
  content: string;
  frontmatter: NoteMergeSourceFrontmatter;
  mode: string | null;
  startedAt: string;
  rawDurationMs: number;
  segments: Segment[];
}

export interface NoteMergeSourceFlowHost {
  getVault(): NoteMergeSourceVault;
  getSourceIdFromMarkdown(markdown: string, file: obsidian.TFile): string;
  ensureTranscriptBlocks(markdown: string, sourceId: string): string;
  extractTranscriptSegments(markdown: string): Segment[];
  getFileFrontmatter(file: obsidian.TFile): obsidian.CachedMetadata["frontmatter"];
  getSegmentsDurationMs(segments: Segment[]): number;
  getDurationMs(markdown: string): number;
  normalizeSegmentsForMergedNote(segments: Segment[], offsetMs: number, startIndex: number, file: obsidian.TFile): Segment[];
  detectModeFromMarkdown(file: obsidian.TFile): string | null;
  inferNoteStartedAtIso(file: obsidian.TFile, frontmatter: NoteMergeSourceFrontmatter): string;
}

export async function readMergeSourceFlow(
  host: NoteMergeSourceFlowHost,
  file: unknown,
  offsetMs: number,
  startIndex: number,
): Promise<NoteMergeSource> {
  if (!(file instanceof obsidian.TFile) || file.extension !== "md") {
    throw new Error(t("Only QnALog Markdown minutes notes can be merged"));
  }
  let content = await host.getVault().read(file);
  const sourceId = host.getSourceIdFromMarkdown(content, file);
  const transcriptReady = host.ensureTranscriptBlocks(content, sourceId);
  if (transcriptReady !== content) {
    await host.getVault().modify(file, transcriptReady);
    content = transcriptReady;
  }
  const rawSegments = host.extractTranscriptSegments(content);
  if (!rawSegments.length) {
    throw new Error(t("No original transcription segments found in \"{0}\"").replace("{0}", file.basename));
  }
  const frontmatter = host.getFileFrontmatter(file) || {};
  const rawDurationMs = host.getSegmentsDurationMs(rawSegments) || host.getDurationMs(content);
  const segments = host.normalizeSegmentsForMergedNote(rawSegments, offsetMs, startIndex, file);
  if (segments.length) {
    segments[0] = Object.assign({}, segments[0], {
      text: `【来源纪要：${file.basename}】\n${segments[0].text || ""}`.trim(),
    });
  }
  return {
    file,
    content,
    frontmatter,
    mode: host.detectModeFromMarkdown(file),
    startedAt: host.inferNoteStartedAtIso(file, frontmatter),
    rawDurationMs,
    segments,
  };
}
