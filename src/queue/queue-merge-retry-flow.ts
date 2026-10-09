import * as obsidian from "obsidian";
import type { MergeQueueTaskPayload, QueueTaskDeferred, RecordingSession, Segment } from "../shared/types";
import { readSessionKnowledge } from "../briefing/session-knowledge";
import { labelPattern, labelText } from "../shared/note-labels";
import { t } from "../shared/i18n";

export type MergeRetryTask = MergeQueueTaskPayload & { createdAt?: string };
export type MergeRetrySession = RecordingSession;

export interface QueueMergeRetryPort {
  getVault(): Pick<obsidian.Vault, "getAbstractFileByPath" | "read" | "modify">;
  runOnTarget<T>(target: obsidian.TFile, operation: () => Promise<T>): Promise<T>;
  runContinuationAppend(task: MergeRetryTask): Promise<QueueTaskDeferred | void>;
  mergeAndPolish(segments: Segment[], mode: string, sessionMeta: Record<string, unknown>, speakerFrontmatter: Record<string, unknown> | null): Promise<string>;
  shouldRewriteConsolidated(session: MergeRetrySession): boolean;
  rewriteConsolidated(session: MergeRetrySession, polished: string): Promise<void>;
  mergeLeadingFrontmatter(documentText: string, generated: string): { content: string; body: string };
  getModePrefix(mode: string): string;
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
  if (port.shouldRewriteConsolidated(retrySession)) {
    await port.rewriteConsolidated(retrySession, polished);
  } else {
    const vault = port.getVault();
    const cur = await vault.read(file);
    const failMark = new RegExp(`_\\[(?:${labelPattern("mergeFailedQueued").source})[^\\]]*\\]_`);
    const merged = port.mergeLeadingFrontmatter(cur, polished);
    const next = failMark.test(cur)
      ? merged.content.replace(failMark, () => merged.body)
      : merged.content + "\n\n## " + labelText("mergedVersionAt", `${labelText("supplementaryRecording")} · ${port.getModePrefix(task.mode)}`) + "\n\n" + merged.body + "\n\n---\n";
    await port.getVault().modify(file, next);
  }
  await port.clearCommittedBriefingCheckpoint(task.sessionMeta);
  const renamed = await port.renameWithGeneratedTitle(file, polished, task.mode);
  const targetFile = renamed instanceof obsidian.TFile ? renamed : file;
  const meetingDate = readStartedAt(task.sessionMeta) || task.createdAt || "";
  await port.refreshNoteIndex(targetFile, { meetingDate, reason: "merge-retry" });
}

function readStartedAt(meta: unknown): unknown {
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>).startedAt : undefined;
}
