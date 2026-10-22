import * as obsidian from "obsidian";
import type { MergeQueueTaskPayload, QueueTaskDeferred, RecordingSession, Segment } from "../shared/types";
import type { VersionSaveInput } from "../versions/version-save-store";
import { readSessionKnowledge } from "../briefing/session-knowledge";
import { t } from "../shared/i18n";

export type MergeRetryTask = MergeQueueTaskPayload & { createdAt?: string };
export type MergeRetrySession = RecordingSession;

export interface QueueMergeRetryPort {
  getVault(): Pick<obsidian.Vault, "getAbstractFileByPath" | "read">;
  runOnTarget<T>(target: obsidian.TFile, operation: () => Promise<T>): Promise<T>;
  runContinuationAppend(task: MergeRetryTask): Promise<QueueTaskDeferred | void>;
  mergeAndPolish(segments: Segment[], mode: string, sessionMeta: Record<string, unknown>, speakerFrontmatter: Record<string, unknown> | null): Promise<string>;
  rewriteConsolidated(session: MergeRetrySession, polished: string, expectedMarkdown: string): Promise<void>;
  saveVersion(file: obsidian.TFile, content: string, segments: Segment[], input: VersionSaveInput): Promise<unknown>;
  formatNow(format: string): string;
  clearCommittedBriefingCheckpoint(sessionMeta: unknown): Promise<void>;
  renameWithGeneratedTitle(file: obsidian.TFile, polished: string, mode: string): Promise<unknown>;
  refreshNoteIndex(file: obsidian.TFile, options: { meetingDate: unknown; reason: string }): Promise<unknown>;
  formatSessionStamp(startedAt: unknown): string;
  createSessionId(): string;
}

export async function retryMergeTask(port: QueueMergeRetryPort, task: MergeRetryTask): Promise<QueueTaskDeferred | void> {
  if (task.continuation) return port.runContinuationAppend(task);
  const target = port.getVault().getAbstractFileByPath(task.mdPath);
  if (!(target instanceof obsidian.TFile)) throw new Error(t("Note not found: {0}").replace("{0}", String(task.mdPath)));
  return port.runOnTarget(target, () => retryMergeTaskImpl(port, task));
}

async function retryMergeTaskImpl(port: QueueMergeRetryPort, task: MergeRetryTask): Promise<void> {
  const file = port.getVault().getAbstractFileByPath(task.mdPath);
  if (!(file instanceof obsidian.TFile)) throw new Error(t("Note not found: {0}").replace("{0}", String(task.mdPath)));
  const currentMarkdown = await port.getVault().read(file);
  // Queue task metadata comes from persisted JSON; preserve Object.assign's original runtime behavior.
  const sessionMeta = Object.assign({}, task.sessionMeta || {}, {
    _previousKnowledge: readSessionKnowledge(currentMarkdown),
  }) as Record<string, unknown>;
  if (task.manualRetryRequired) sessionMeta._freshBriefing = true;
  const polished = await port.mergeAndPolish(task.segments || [], task.mode, sessionMeta, task.speakerFrontmatter || null);
  if (!polished) throw new Error(t("Merge returned an empty result"));
  const retryStartedAt = (sessionMeta && sessionMeta.startedAt) || task.createdAt || new Date().toISOString();
  const retrySession: MergeRetrySession = {
    id: task.sessionId || port.createSessionId(),
    sessionStamp: port.formatSessionStamp(retryStartedAt),
    mdPath: file.path,
    mode: task.mode,
    // Preserve the original value without coercion.
    startedAt: retryStartedAt as string,
    finalized: true,
    source: task.source || "",
    sourceMeta: task.sourceMeta || null,
    externalAudioSource: task.externalAudioSource || null,
    textImportSources: task.textImportSources || [],
    meetingWorkbench: sessionMeta && sessionMeta.meetingWorkbench || null,
    segments: Array.isArray(task.segments) ? task.segments : [],
    multiSourceAudio: task.source === "merged-notes",
  };
  // Best-effort snapshot of the note text the rewrite will replace; a failure must not block the write.
  try {
    if (currentMarkdown) {
      await port.saveVersion(file, currentMarkdown, retrySession.segments, {
        kind: "pre-polish", label: t("Before polish") + " " + port.formatNow("YYYY-MM-DD HH:mm"), mode: task.mode,
        idLabel: "pre-polish-" + port.formatNow("YYYYMMDD-HHmmss"), body: currentMarkdown, activate: false,
      });
    }
  } catch (archiveError) {
    console.warn("[QnALog] pre-polish version archive failed", archiveError);
  }
  await port.rewriteConsolidated(retrySession, polished, currentMarkdown);
  await port.clearCommittedBriefingCheckpoint(task.sessionMeta);
  const renamed = await port.renameWithGeneratedTitle(file, polished, task.mode);
  const targetFile = renamed instanceof obsidian.TFile ? renamed : file;
  const meetingDate = readStartedAt(task.sessionMeta) || task.createdAt || "";
  await port.refreshNoteIndex(targetFile, { meetingDate, reason: "merge-retry" });
}

function readStartedAt(meta: unknown): unknown {
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>).startedAt : undefined;
}
