import * as obsidian from "obsidian";
import { t } from "../shared/i18n";
import type { RecordingSession, Segment, SessionMetaForMerge } from "../shared/types";
import { formatElapsed, genId } from "../shared/util-common";
import { normalizeMeetingWorkbench } from "./meeting-workbench-state";
import type { NoteMergeSource } from "./note-merge-source-flow";

export interface NoteMergeSourceMetadata {
  path: string;
  title: string;
  durationMs: number;
}

export type NoteMergeMoment = (input?: string) => {
  isValid?: () => boolean;
  format(pattern: string): string;
};

export type NoteMergeVault = Pick<obsidian.Vault, "create" | "getAbstractFileByPath">;

export interface NoteMergeFlowHost {
  readSource(file: unknown, offsetMs: number, startIndex: number): Promise<NoteMergeSource>;
  getFallbackMode(): string;
  getMarkdownFolder(): string;
  getNoteFileNameFormat(): string;
  getMoment(): NoteMergeMoment | null | undefined;
  ensureFolder(path: string): Promise<void>;
  findAvailableMarkdownPath(path: string): string;
  getVault(): NoteMergeVault;
  mergeAndPolish(segments: Segment[], mode: string, meta: SessionMetaForMerge): Promise<string>;
  rewrite(session: RecordingSession, polished: string): Promise<void>;
  clearCheckpoint(meta: SessionMetaForMerge): Promise<void>;
  rename(path: string, polished: string, mode: string): Promise<obsidian.TFile | null>;
  appendMetadata(file: obsidian.TFile, sources: NoteMergeSourceMetadata[]): Promise<void>;
  refreshIndex(file: obsidian.TFile, meetingDate: string): Promise<void>;
  openFile: (file: obsidian.TFile) => Promise<void>;
  getFallbackPrefix: () => string;
  getFallbackFilename: () => string;
}

export async function mergeMarkdownFilesAsNewFlow(
  host: NoteMergeFlowHost,
  files: Iterable<unknown> | null | undefined,
): Promise<void> {
  const sources: NoteMergeSource[] = [];
  let offsetMs = 0;
  let startIndex = 0;
  for (const file of files || []) {
    const source = await host.readSource(file, offsetMs, startIndex);
    sources.push(source);
    offsetMs += Math.max(0, Number(source.rawDurationMs) || 0);
    startIndex += source.segments.length;
  }
  if (sources.length < 2) {
    new obsidian.Notice(t("At least two summaries are required to merge."));
    return;
  }
  const segments = sources.flatMap((source) => source.segments);
  if (!segments.length) {
    new obsidian.Notice(t("No original transcriptions found to merge."), 8000);
    return;
  }
  const mode = sources[sources.length - 1].mode || sources[0].mode || host.getFallbackMode();
  await host.ensureFolder(host.getMarkdownFolder());
  const moment = host.getMoment();
  const startedAtIso = sources[0].startedAt || new Date().toISOString();
  const startedAt = moment ? moment(startedAtIso) : null;
  const stamp = startedAt && startedAt.isValid && startedAt.isValid()
    ? startedAt.format(host.getNoteFileNameFormat())
    : (moment ? moment().format(host.getNoteFileNameFormat()) : host.getFallbackFilename());
  const targetPath = host.findAvailableMarkdownPath(obsidian.normalizePath(`${host.getMarkdownFolder()}/${stamp} · ${t("Merge")}.md`));
  if (!targetPath) throw new Error(t("Failed to generate a path for the merged minutes file"));

  new obsidian.Notice(`${t("QnALog: merging ")}${sources.length}${t(" minutes notes...")}`, 8000);
  await host.getVault().create(targetPath, "");
  const session: RecordingSession & { mergedSources: NoteMergeSourceMetadata[] } = {
    id: genId(),
    sessionStamp: moment ? moment().format("YYYYMMDD-HHmmss") : String(Date.now()),
    mdPath: targetPath,
    mode,
    startedAt: startedAtIso,
    finalized: true,
    source: "merged-notes",
    segments,
    multiSourceAudio: true,
    meetingWorkbench: { notes: "", draft: "", materials: [], entries: [] },
    mergedSources: sources.map((source) => ({
      path: source.file.path,
      title: source.file.basename,
      durationMs: source.rawDurationMs,
    })),
  };
  const lastSeg = segments[segments.length - 1];
  const sessionMeta: SessionMetaForMerge = {
    startedAt: session.startedAt,
    duration: lastSeg ? formatElapsed(lastSeg.endOffsetMs || 0) : "",
    source: "merged-notes",
    meetingWorkbench: normalizeMeetingWorkbench(session.meetingWorkbench),
  };
  const polished = await host.mergeAndPolish(segments.map((segment) => ({ ...segment })), mode, sessionMeta);
  await host.rewrite(session, polished);
  await host.clearCheckpoint(sessionMeta);
  let finalFile = host.getVault().getAbstractFileByPath(session.mdPath);
  const renamed = await host.rename(session.mdPath, polished, mode);
  if (renamed instanceof obsidian.TFile) {
    session.mdPath = renamed.path;
    finalFile = renamed;
  }
  if (finalFile instanceof obsidian.TFile) {
    await host.appendMetadata(finalFile, session.mergedSources);
    await host.refreshIndex(finalFile, session.startedAt);
    const openFile: (file: obsidian.TFile) => Promise<void> = host.openFile;
    try { await openFile(finalFile); } catch { /* intentionally empty */ }
  }
  new obsidian.Notice(`${t("Generated merged minutes: ")}${finalFile instanceof obsidian.TFile ? finalFile.basename : host.getFallbackPrefix()}`);
}
