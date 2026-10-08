import * as obsidian from "obsidian";
import { t } from "../shared/i18n";

export interface NoteMergePreviousFlowHost {
  getRecentNotes(limit: number): Array<{ file: obsidian.TFile; timestamp: number }>;
  findPrevious(file: obsidian.TFile): obsidian.TFile | null;
  confirm(title: string, body: string, ctaText: string): Promise<unknown>;
  mergeFiles(files: obsidian.TFile[]): Promise<void>;
}

export function findPreviousRecentNoteFileFlow(
  host: Pick<NoteMergePreviousFlowHost, "getRecentNotes">,
  file: unknown,
): obsidian.TFile | null {
  if (!(file instanceof obsidian.TFile)) return null;
  const currentPath = obsidian.normalizePath(file.path);
  const recents = host.getRecentNotes(240);
  const current = recents.find((item) => item && item.file && obsidian.normalizePath(item.file.path) === currentPath);
  if (!current) return null;
  const older = recents
    .filter((item) => item && item.file && obsidian.normalizePath(item.file.path) !== currentPath && item.timestamp < current.timestamp)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  return older && older.file instanceof obsidian.TFile ? older.file : null;
}

export async function mergeMarkdownFileWithPreviousFlow(
  host: NoteMergePreviousFlowHost,
  file: unknown,
): Promise<void> {
  if (!(file instanceof obsidian.TFile)) return;
  const previous = host.findPrevious(file);
  if (!(previous instanceof obsidian.TFile)) {
    new obsidian.Notice(t("No most recent QnALog summary before this one was found."), 6000);
    return;
  }
  const ok = await host.confirm(
    t("Merge minutes"),
    t("A new merged minutes note will be created; the source files will be kept.\n\nSources:\n1. {0}\n2. {1}\n\nContinue?").replace(/\{[01]\}/g, (placeholder) => placeholder === "{0}" ? previous.basename : file.basename),
    t("Merge"),
  );
  if (!ok) return;
  try {
    await host.mergeFiles([previous, file]);
  } catch (error: unknown) {
    console.error("[QnALog] merge notes failed", error);
    const failure = error as { message?: unknown } | null | undefined;
    new obsidian.Notice(`${t("Merging minutes failed: ")}${((failure && failure.message) || error) as string}`, 8000);
  }
}
