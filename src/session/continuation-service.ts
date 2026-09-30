import * as obsidian from "obsidian";
import type {
  ContinuationContext,
  MergeQueueTaskPayload,
  PluginSettings,
  QueueTask,
  QueueTaskLifecycle,
  RecordingSession,
} from "../shared/types";
import { extractDetailsBody } from "../notes/detail-blocks";
import { extractTranscriptSegments, getSourceIdFromMarkdown } from "../notes/note-markdown";
import { stripArchivedOutlineSections } from "../notes/realtime-outline";
import { getEffectivePolishMode } from "../shared/mode-meta";
import { labelPattern, labelText } from "../shared/note-labels";
import { nsMarker } from "../shared/namespace";
import { genId } from "../shared/util-common";
import { ensureVaultFolder, findAvailableVaultPath } from "../shared/util-vault";
import { t } from "../shared/i18n";

const OUTLINE_INTRO_LINE_RE = new RegExp(`^>\\s*(?:${labelPattern("outlineIntro").source})[^\\n]*\\n?`, "m");

/** Read the live outline from an existing note as a continuation seed, without archived copies. */
export function extractPriorOutline(markdown: string): string {
  const raw = extractDetailsBody(markdown, labelPattern("liveOutlineDraft"));
  return stripArchivedOutlineSections(
    String(raw || "")
      .replace(OUTLINE_INTRO_LINE_RE, "")
      .trim()
  );
}
export function getContinuationTargetIdentity(markdown: string, file: obsidian.TFile): string {
  const firstSourceId = extractTranscriptSegments(markdown)
    .find(segment => typeof segment.transcript?.sourceId === "string" && segment.transcript.sourceId.length > 0)
    ?.transcript?.sourceId;
  return firstSourceId || getSourceIdFromMarkdown(markdown, file);
}

export interface ContinuationPreparation {
  stageFile: obsidian.TFile;
  taskId: string;
  continuation: ContinuationContext;
  dependsOnSessionIds: string[];
  mode: string;
  priorOutline: string;
}

/** Narrow vault, queue, and scheduling capabilities used by continuation coordination. */
export interface ContinuationServiceHost {
  vault: Pick<obsidian.Vault, "read" | "create" | "getAbstractFileByPath" | "createFolder">;
  fileManager: Pick<obsidian.FileManager, "trashFile">;
  getSettings(): Pick<PluginSettings, "mdFolder" | "noteFileNameFormatNew" | "consolidatedLayout" | "polishMode">;
  detectModeFromMarkdown(file: obsidian.TFile): string | null | undefined;
  queueTasks(): readonly QueueTask[];
  addTask(task: MergeQueueTaskPayload & Partial<QueueTaskLifecycle>): Promise<QueueTask>;
  removeTask(id: string): Promise<void>;
  scheduleTaskQueueRetry(): void;
}

interface TrackedSession {
  session: RecordingSession;
  target: obsidian.TFile;
}

/** Serializes operations by target identity and tracks sessions against their logical target. */
export class ContinuationService {
  private readonly host: ContinuationServiceHost;
  private readonly sessionsByTarget = new Map<obsidian.TFile, Map<string, RecordingSession>>();
  private readonly trackedBySessionId = new Map<string, TrackedSession>();
  private readonly tails = new Map<obsidian.TFile, Promise<void>>();

  constructor(host: ContinuationServiceHost) {
    this.host = host;
  }

  trackSession(session: RecordingSession, target: obsidian.TFile): void {
    const previous = this.trackedBySessionId.get(session.id);
    if (previous && previous.target !== target) {
      const previousSessions = this.sessionsByTarget.get(previous.target);
      previousSessions?.delete(session.id);
      if (previousSessions?.size === 0) this.sessionsByTarget.delete(previous.target);
    }
    let sessions = this.sessionsByTarget.get(target);
    if (!sessions) {
      sessions = new Map();
      this.sessionsByTarget.set(target, sessions);
    }
    sessions.set(session.id, session);
    this.trackedBySessionId.set(session.id, { session, target });
    if (session.continuation && session.continuation.targetPath !== target.path) {
      session.continuation.targetPath = target.path;
    }
  }

  releaseSession(sessionId: string): void {
    const tracked = this.trackedBySessionId.get(sessionId);
    if (!tracked) return;
    this.trackedBySessionId.delete(sessionId);
    const sessions = this.sessionsByTarget.get(tracked.target);
    sessions?.delete(sessionId);
    if (sessions?.size === 0) this.sessionsByTarget.delete(tracked.target);
    this.notifyQueueChanged();
  }

  runOnTarget<T>(target: obsidian.TFile, operation: () => Promise<T>): Promise<T> {
    const predecessor: Promise<void> = this.tails.get(target) ?? Promise.resolve();
    const result = predecessor.catch(() => undefined).then(() => operation());
    const neutralTail = result.then<void>(() => undefined, () => undefined);
    this.tails.set(target, neutralTail);
    void neutralTail.then(() => {
      if (this.tails.get(target) === neutralTail) this.tails.delete(target);
    });
    return result;
  }

  async prepare(
    target: obsidian.TFile,
    sessionId: string,
    sessionStamp: string,
    recordedAt: string,
  ): Promise<ContinuationPreparation> {
    if (!(target instanceof obsidian.TFile) || target.extension !== "md") {
      throw new Error(t("The target is not a Markdown note"));
    }

    // This is intentionally a read-only snapshot: never repair transcript blocks here.
    let content = await this.host.vault.read(target);
    let snapshotPath = target.path;
    let targetSourceId = getContinuationTargetIdentity(content, target);
    let dependsOnSessionIds = this.getDependencySessionIds(target);
    if (!extractTranscriptSegments(content).length && dependsOnSessionIds.length === 0) {
      throw new Error(t("This note has no original transcript segments to continue recording from"));
    }

    const settings = this.host.getSettings();
    const detectedMode = this.host.detectModeFromMarkdown(target);
    const effectiveMode: unknown = getEffectivePolishMode(settings, settings.polishMode);
    const effectiveModeString = typeof effectiveMode === "string" ? effectiveMode : "";
    const mode = typeof detectedMode === "string" && detectedMode
      ? detectedMode
      : effectiveModeString || settings.polishMode;
    let priorOutline: string = extractPriorOutline(content);
    const moment = (window as unknown as { moment: (input: string) => { format(format: string): string } })
      .moment(recordedAt || sessionStamp);
    const noteName = String(moment.format(settings.noteFileNameFormatNew));
    const pendingLabel = t("Pending continuation");
    const requestedPath = obsidian.normalizePath(
      `${settings.mdFolder}/${noteName} · ${pendingLabel}-${sessionId}.md`,
    );
    const stagePath = findAvailableVaultPath({ vault: this.host.vault }, requestedPath);
    if (!stagePath) throw new Error(t("Could not build a path for the full recording file"));
    await ensureVaultFolder({ vault: this.host.vault }, settings.mdFolder);

    const stageTitle = `## ${labelText("appendToAt", mode, String(moment.format("YYYY-MM-DD HH:mm")))}`;
    const stageContent = [
      stageTitle,
      "",
      nsMarker("session", sessionId),
      nsMarker("segments-start", sessionId),
      nsMarker("segments-end", sessionId),
      "",
    ].join("\n");
    const taskId = genId();
    let stageFile: obsidian.TFile | null = null;
    try {
      const preparedStageFile = await this.host.vault.create(stagePath, stageContent);
      stageFile = preparedStageFile;
      if (target.path !== snapshotPath) {
        content = await this.host.vault.read(target);
        targetSourceId = getContinuationTargetIdentity(content, target);
        priorOutline = extractPriorOutline(content);
        dependsOnSessionIds = Array.from(new Set([
          ...dependsOnSessionIds,
          ...this.getDependencySessionIds(target),
        ]));
        if (!extractTranscriptSegments(content).length && dependsOnSessionIds.length === 0) {
          throw new Error(t("This note has no original transcript segments to continue recording from"));
        }
      }
      const continuation: ContinuationContext = {
        targetPath: target.path,
        targetSourceId,
        recordedAt,
        ...(priorOutline ? { realtimeOutline: priorOutline } : {}),
      };
      const task = await this.host.addTask({
        type: "merge",
        sessionId,
        mdPath: preparedStageFile.path,
        mode,
        segments: [],
        temporarySourcePath: preparedStageFile.path,
        continuation,
        id: taskId,
        status: "live",
        retries: 0,
        createdAt: recordedAt,
        updatedAt: recordedAt,
        dependsOnSessionIds,
      });
      return { stageFile: preparedStageFile, taskId: task.id, continuation, dependsOnSessionIds, mode, priorOutline };
    } catch (error) {
      try { await this.host.removeTask(taskId); } catch { /* preserve the preparation failure */ }
      if (stageFile) {
        try { await this.host.fileManager.trashFile(stageFile); } catch { /* preserve the preparation failure */ }
      }
      throw error;
    }
  }

  resolveTarget(stageFile: obsidian.TFile): obsidian.TFile | null {
    const stagePath = obsidian.normalizePath(stageFile.path);
    const task = this.host.queueTasks().find(candidate =>
      candidate.type === "merge"
      && candidate.continuation
      && obsidian.normalizePath(String(candidate.temporarySourcePath || "")) === stagePath,
    );
    if (!task || task.type !== "merge" || !task.continuation) return null;
    const target = this.host.vault.getAbstractFileByPath(task.continuation.targetPath);
    return target instanceof obsidian.TFile ? target : null;
  }

  isSessionTracked(sessionId: string): boolean {
    return this.trackedBySessionId.has(sessionId);
  }

  hasActiveSessions(target: obsidian.TFile): boolean {
    return (this.sessionsByTarget.get(target)?.size || 0) > 0;
  }

  getTrackedSessionIds(target: obsidian.TFile): string[] {
    return Array.from(this.sessionsByTarget.get(target)?.keys() || []);
  }

  async cancelPrepared(taskId: string, stageFile: obsidian.TFile): Promise<void> {
    try { await this.host.removeTask(taskId); } finally {
      try { await this.host.fileManager.trashFile(stageFile); } catch { /* retain the startup error */ }
    }
  }

  onRename(file: obsidian.TFile, oldPath: string): void {
    if (file.path === oldPath) return;
    const sessions = this.sessionsByTarget.get(file);
    if (!sessions) return;
    for (const session of sessions.values()) {
      if (session.continuationSourcePath) session.continuationSourcePath = file.path;
      if (session.continuation?.targetPath === oldPath) session.continuation.targetPath = file.path;
    }
  }

  notifyQueueChanged(): void {
    const tasks = this.host.queueTasks();
    const queuedSessionIds = new Set(tasks.flatMap(task => task.type === "generate-prompt" ? [] : [task.sessionId]).filter(Boolean));
    for (const task of tasks) {
      if (task.type !== "merge" || !task.continuation || task.status !== "pending") continue;
      if (this.trackedBySessionId.has(task.sessionId)) continue;
      const target = this.host.vault.getAbstractFileByPath(task.continuation.targetPath);
      if (target instanceof obsidian.TFile && this.hasActiveSessions(target)) continue;
      if (tasks.some(candidate => candidate.type === "transcribe" && candidate.sessionId === task.sessionId)) continue;
      if ((task.dependsOnSessionIds || []).some(id => queuedSessionIds.has(id) || this.trackedBySessionId.has(id))) continue;
      this.host.scheduleTaskQueueRetry();
      return;
    }
  }

  private getDependencySessionIds(target: obsidian.TFile): string[] {
    const ids = Array.from(this.sessionsByTarget.get(target)?.keys() || []);
    const targetPath = target.path;
    for (const task of this.host.queueTasks()) {
      if (task.type === "merge" && task.continuation?.targetPath === targetPath && task.sessionId) {
        ids.push(task.sessionId);
      }
    }
    return Array.from(new Set(ids));
  }
}
