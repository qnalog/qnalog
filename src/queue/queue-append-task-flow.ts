import * as obsidian from "obsidian";
import type { MergeQueueTaskPayload, QueueTaskDeferred, RecordingSession, RealtimeOutlineSourceCoverage, Segment } from "../shared/types";
import type { TaskQueue } from "./task-queue";
import { labelPattern } from "../shared/note-labels";
import { formatElapsed } from "../shared/util-common";
import { stableHash } from "../shared/stable-hash";
import { nsMarker, NS_CONTINUATION_COMMITTED_MARKER } from "../shared/namespace";
import { t } from "../shared/i18n";

export type AppendTask = MergeQueueTaskPayload & { id: string; status: string; dependsOnSessionIds?: string[]; temporarySourcePath?: string };
type AppendQueue = Pick<TaskQueue, "tasks" | "recoveryEntries" | "update">;

export interface QueueAppendTaskPort {
  getVault(): Pick<obsidian.Vault, "getAbstractFileByPath" | "read">;
  trashFile(file: obsidian.TFile): Promise<void>;
  getFileCache(file: obsidian.TFile): { frontmatter?: Record<string, unknown> } | null;
  getQueue(): AppendQueue | null;
  isRealtimeOutlineEnabled(): boolean;
  isSessionTracked(id: string): boolean;
  hasActiveSessions(target: obsidian.TFile): boolean;
  runOnTarget<T>(target: obsidian.TFile, operation: () => Promise<T>): Promise<T>;
  discardShortRecordingNote(session: { id: string; mdPath: string }): Promise<void>;
  cleanupSuccessfulSegmentAudio(session: unknown): Promise<void>;
  patchTaskActivity(id: string, patch: Record<string, unknown>): void;
  queueTaskActivityId(task: AppendTask): string;
  commitContinuation(session: RecordingSession, polished: string, ids: readonly string[]): Promise<void>;
  mergeAndPolish(segments: Segment[], mode: string, sessionMeta: Record<string, unknown>, speakerFrontmatter: Record<string, unknown> | null): Promise<string>;
  clearCommittedBriefingCheckpoint(meta: Record<string, unknown>): Promise<void>;
  refreshNoteIndex(file: obsidian.TFile, options: { meetingDate: unknown; reason: string }): Promise<unknown>;
  extractPriorOutline(markdown: string): string;
  getContinuationTargetIdentity(markdown: string, file: obsidian.TFile): string;
  getTranscriptSegments(markdown: string): Segment[];
  getTranscriptRevision(transcript: NonNullable<Segment["transcript"]>): { revision: number; normalizationRevision: number };
  getOutlineBlock(markdown: string): { outline?: string; sourceCoverage?: RealtimeOutlineSourceCoverage } | null;
  isOutlineCoverageValid(coverage: unknown, outline: string, segments: readonly Segment[]): boolean;
  createOutlineCoverage(outline: string, segments: readonly Segment[], committedSegmentCount: number): RealtimeOutlineSourceCoverage;
  normalizeMergedSegments(segments: Segment[], durationMs: number, baseLength: number, file: obsidian.TFile): Segment[];
  inferStartedAt(file: obsidian.TFile, frontmatter: Record<string, unknown>): string;
  getAudioReferences(markdown: string): string[];
  getDurationMs(segments: Segment[]): number;
  getDetailsBody(markdown: string, pattern: RegExp): string;
  getSessionKnowledge(markdown: string): unknown;
  completeRealtimeOutline(
    segments: Segment[],
    resume: { outline?: string; sourceCoverage?: RealtimeOutlineSourceCoverage },
    mode: string,
    onProgress?: (progress: { outline: string; committedSegmentCount: number; sourceCoverage: RealtimeOutlineSourceCoverage }) => Promise<void> | void,
  ): Promise<{ outline: string; sourceCoverage: RealtimeOutlineSourceCoverage; complete: boolean } | null>;
  mergeContinuationOutlineText(base: string, fresh: string): string;
  saveVersion(file: obsidian.TFile, content: string, base: Segment[], input: unknown): Promise<unknown>;
  formatMoment(format: string, input?: unknown): string;
}

export async function runAppendTask(port: QueueAppendTaskPort, task: AppendTask): Promise<QueueTaskDeferred | void> {
  const context = task.continuation;
  if (!context || typeof context.targetPath !== "string" || typeof context.targetSourceId !== "string" || !context.targetSourceId) {
    return { deferred: true, status: "blocked", reason: t("Continuation recovery information is invalid; the separately recorded audio was kept.") } satisfies QueueTaskDeferred;
  }
  const cleanupBlocked = () => ({
    deferred: true,
    status: "blocked",
    reason: t("Continuation cleanup information is invalid; the target was not changed."),
  } satisfies QueueTaskDeferred);
  if (task.continuationDisposition !== undefined && task.continuationDisposition !== "discard") {
    return cleanupBlocked();
  }
  if (task.continuationDisposition === "discard") {
    if (port.isSessionTracked(task.sessionId)) {
      return { deferred: true, reason: t("Recording saved; waiting to merge into the target note.") } satisfies QueueTaskDeferred;
    }
    const stagePath = String(task.temporarySourcePath || task.mdPath || "");
    const normalizedStagePath = obsidian.normalizePath(stagePath);
    if (!normalizedStagePath || normalizedStagePath === obsidian.normalizePath(context.targetPath)) return cleanupBlocked();
    const stageFile = port.getVault().getAbstractFileByPath(stagePath);
    if (stageFile instanceof obsidian.TFolder) return cleanupBlocked();
    if (stageFile instanceof obsidian.TFile) {
      await port.discardShortRecordingNote({ id: task.sessionId, mdPath: stageFile.path });
    }
    return;
  }
  const target = port.getVault().getAbstractFileByPath(context.targetPath);
  if (!(target instanceof obsidian.TFile)) {
    return { deferred: true, status: "missing", reason: t("The target note is missing; the separately recorded audio was kept.") } satisfies QueueTaskDeferred;
  }
  if (port.isSessionTracked(task.sessionId)) {
    return { deferred: true, reason: t("Recording saved; waiting to merge into the target note.") } satisfies QueueTaskDeferred;
  }
  const retained = port.getQueue()?.recoveryEntries() || [];
  const activeDependencies = (task.dependsOnSessionIds || []).filter(id =>
    port.isSessionTracked(id)
    || port.getQueue()?.tasks.some(candidate => candidate.type !== "generate-prompt" && candidate.sessionId === id)
    || retained.some(entry => entry.taskType !== "generate-prompt" && entry.sessionId === id),
  );
  if (activeDependencies.length) {
    return { deferred: true, reason: t("Recording saved; waiting to merge into the target note.") } satisfies QueueTaskDeferred;
  }
  if (port.getQueue()?.tasks.some(candidate => candidate.type === "transcribe" && candidate.sessionId === task.sessionId)
    || retained.some(entry => entry.taskType !== "generate-prompt" && entry.sessionId === task.sessionId)) {
    return { deferred: true, reason: t("Recording saved; waiting to merge into the target note.") } satisfies QueueTaskDeferred;
  }
  return port.runOnTarget(target, async () => {
    const reloadedTarget = port.getVault().getAbstractFileByPath(target.path);
    if (!(reloadedTarget instanceof obsidian.TFile)) {
      return { deferred: true, status: "missing", reason: t("The target note is missing; the separately recorded audio was kept.") } satisfies QueueTaskDeferred;
    }
    if (port.hasActiveSessions(target)) {
      return { deferred: true, reason: t("Recording saved; waiting to merge into the target note.") } satisfies QueueTaskDeferred;
    }
    const targetMarkdown = await port.getVault().read(reloadedTarget);
    if (port.getContinuationTargetIdentity(targetMarkdown, reloadedTarget) !== context.targetSourceId) {
      return { deferred: true, status: "blocked", reason: t("The target note identity changed; the separately recorded audio was kept.") } satisfies QueueTaskDeferred;
    }
    const committedMarker = nsMarker(NS_CONTINUATION_COMMITTED_MARKER, task.sessionId);
    if (targetMarkdown.includes(committedMarker)) {
      const committedSegments = Array.isArray(task.segments) ? task.segments : [];
      if (!committedSegments.length) {
        return { deferred: true, status: "blocked", reason: t("A committed continuation has no saved transcript ledger; recovery material was kept.") } satisfies QueueTaskDeferred;
      }
      port.patchTaskActivity(port.queueTaskActivityId(task), {
        status: "running",
        stage: "write-note",
        stageLabel: t("Write to Minutes"),
        progress: 88,
        detail: t("Writing the organized result to Obsidian"),
        error: "",
        completedAt: 0,
      });
      await port.commitContinuation({
        id: task.sessionId,
        sessionStamp: port.formatMoment("YYYYMMDD-HHmmss", context.recordedAt),
        mdPath: reloadedTarget.path,
        mode: task.mode,
        startedAt: context.recordedAt,
        segments: committedSegments,
        finalized: false,
        continuation: context,
      }, "", []);
      const recoveryMeta = task.sessionMeta && typeof task.sessionMeta === "object" && !Array.isArray(task.sessionMeta)
        ? task.sessionMeta as Record<string, unknown>
        : null;
      if (recoveryMeta && recoveryMeta._briefingCheckpointId) {
        await port.clearCommittedBriefingCheckpoint(recoveryMeta);
      }
      await port.refreshNoteIndex(reloadedTarget, {
        meetingDate: context.recordedAt,
        reason: "continuation-merge-recovery",
      });
      await port.cleanupSuccessfulSegmentAudio({
        id: task.sessionId,
        segments: committedSegments,
        masterAudioPath: context.masterAudioPath || "",
        masterAudioName: context.masterAudioName || "",
      });
      const committedStage = port.getVault().getAbstractFileByPath(String(task.temporarySourcePath || task.mdPath || ""));
      if (committedStage instanceof obsidian.TFile) await port.trashFile(committedStage);
      return;
    }
    const stagePath = String(task.temporarySourcePath || task.mdPath || "");
    const stageFile = port.getVault().getAbstractFileByPath(stagePath);
    if (!(stageFile instanceof obsidian.TFile)) {
      return { deferred: true, status: "missing", reason: t("The separate recording file is missing; the target was not changed.") } satisfies QueueTaskDeferred;
    }
    const stageMarkdown = await port.getVault().read(stageFile);
    const fresh = port.getTranscriptSegments(stageMarkdown);
    if (!fresh.length) {
      return { deferred: true, status: "missing", reason: t("The separate recording has no complete transcript yet; its audio was kept.") } satisfies QueueTaskDeferred;
    }
    if (fresh.some(segment => !segment.transcript || segment.transcript.sourceId !== task.sessionId)) {
      return { deferred: true, status: "blocked", reason: t("The separate recording transcript identity is invalid; its audio was kept.") } satisfies QueueTaskDeferred;
    }
    const targetSegments = port.getTranscriptSegments(targetMarkdown);
    const freshIds = new Set(fresh.map(segment => segment.transcript?.sourceId).filter(Boolean));
    const freshBlockIds = new Set(fresh.map(segment => segment.transcript?.id).filter(Boolean));
    const existingFresh = targetSegments.filter(segment => freshBlockIds.has(segment.transcript?.id || ""));
    for (const segment of fresh) {
      const existing = existingFresh.filter(candidate => candidate.transcript?.id === segment.transcript?.id);
      const incomingRevision = segment.transcript ? port.getTranscriptRevision(segment.transcript) : null;
      const existingRevision = existing[0]?.transcript ? port.getTranscriptRevision(existing[0].transcript) : null;
      if (existing.length > 1 || (existing.length === 1
        && (!incomingRevision || !existingRevision
          || existing[0].transcript?.sourceId !== segment.transcript?.sourceId
          || existingRevision.revision !== incomingRevision.revision
          || existingRevision.normalizationRevision !== incomingRevision.normalizationRevision))) {
        return { deferred: true, status: "blocked", reason: t("A transcript source conflicts with the target note; the separate recording was kept.") } satisfies QueueTaskDeferred;
      }
    }
    const base = targetSegments.filter(segment => !freshIds.has(segment.transcript?.sourceId || ""));
    const durationMs = port.getDurationMs(base);
    const normalizedBatch = port.normalizeMergedSegments(fresh, durationMs, base.length, stageFile);
    const normalizedFresh = fresh.map((segment, index) => {
      const existing = existingFresh.find(candidate => candidate.transcript?.id === segment.transcript?.id);
      const normalized = existing || normalizedBatch[index];
      return { ...normalized, index: base.length + index };
    });
    const mergedSegments = [...base, ...normalizedFresh];
    let outlineText = "";
    let outlineCoverage: RealtimeOutlineSourceCoverage | undefined;
    let outlineCommittedCount = 0;
    if (port.isOutlineCoverageValid(context.realtimeOutlineSourceCoverage, context.realtimeOutline || "", mergedSegments)) {
      outlineText = context.realtimeOutline || "";
      outlineCoverage = context.realtimeOutlineSourceCoverage;
      outlineCommittedCount = context.realtimeOutlineSegmentCount || 0;
    } else {
      const currentOutline = port.getOutlineBlock(targetMarkdown);
      const targetOutline = port.extractPriorOutline(targetMarkdown);
      const targetProof = currentOutline?.sourceCoverage;
      if (targetProof && port.isOutlineCoverageValid(targetProof, targetOutline, base)) {
        const baseCommittedCount = targetProof.committedSegmentCount;
        const freshProofValid = port.isOutlineCoverageValid(
          context.realtimeOutlineSourceCoverage,
          context.realtimeOutline || "",
          fresh,
        );
        const freshIsComplete = freshProofValid
          && context.realtimeOutlineSegmentCount === fresh.length
          && stableHash(targetOutline) === context.priorOutlineHash;
        if (baseCommittedCount === base.length && freshIsComplete && context.realtimeOutline) {
          outlineText = port.mergeContinuationOutlineText(targetOutline, context.realtimeOutline);
          outlineCommittedCount = mergedSegments.length;
          outlineCoverage = port.createOutlineCoverage(outlineText, mergedSegments, outlineCommittedCount);
        } else {
          outlineText = targetOutline;
          outlineCommittedCount = baseCommittedCount;
          outlineCoverage = port.createOutlineCoverage(outlineText, mergedSegments, outlineCommittedCount);
        }
      }
    }
    const outlineEnabled = port.isRealtimeOutlineEnabled();
    if (outlineEnabled && port.getQueue()) {
      context.realtimeOutline = outlineText;
      context.realtimeOutlineSegmentCount = outlineCommittedCount;
      context.realtimeOutlineSourceCoverage = outlineCoverage;
      await port.getQueue()?.update(task.id, { continuation: context, segments: normalizedFresh });
    }
    const completedOutline = await port.completeRealtimeOutline(
      mergedSegments,
      { outline: outlineText, sourceCoverage: outlineCoverage },
      task.mode,
      async progress => {
        outlineText = progress.outline;
        outlineCommittedCount = progress.committedSegmentCount;
        outlineCoverage = progress.sourceCoverage;
        context.realtimeOutline = outlineText;
        context.realtimeOutlineSegmentCount = outlineCommittedCount;
        context.realtimeOutlineSourceCoverage = outlineCoverage;
        if (port.getQueue()) await port.getQueue()?.update(task.id, { continuation: context, segments: normalizedFresh });
      },
    );
    if (completedOutline) {
      outlineText = completedOutline.outline;
      outlineCoverage = completedOutline.sourceCoverage;
      outlineCommittedCount = outlineCoverage.committedSegmentCount;
      context.realtimeOutline = outlineText;
      context.realtimeOutlineSegmentCount = outlineCommittedCount;
      context.realtimeOutlineSourceCoverage = outlineCoverage;
      if (port.getQueue()) await port.getQueue()?.update(task.id, { continuation: context, segments: normalizedFresh });
    }
    task.segments = normalizedFresh;
    if (port.getQueue()) await port.getQueue()?.update(task.id, { segments: normalizedFresh });
    const metadata = port.getFileCache(reloadedTarget);
    const startedAt = port.inferStartedAt(reloadedTarget, metadata?.frontmatter || {});
    const savedSessionMeta = task.sessionMeta && typeof task.sessionMeta === "object" && !Array.isArray(task.sessionMeta)
      ? task.sessionMeta as Record<string, unknown>
      : {};
    const sessionMeta: Record<string, unknown> = Object.assign({}, savedSessionMeta, {
      startedAt,
      duration: formatElapsed(port.getDurationMs(mergedSegments)),
      _previousKnowledge: port.getSessionKnowledge(targetMarkdown),
    });
    const writeSession: RecordingSession = {
      id: task.sessionId,
      sessionStamp: port.formatMoment("YYYYMMDD-HHmmss", context.recordedAt),
      mdPath: reloadedTarget.path,
      mode: task.mode,
      startedAt,
      source: task.source || "",
      sourceMeta: task.sourceMeta || null,
      externalAudioSource: task.externalAudioSource || null,
      textImportSources: task.textImportSources || [],
      meetingWorkbench: sessionMeta.meetingWorkbench || null,
      segments: mergedSegments,
      realtimeOutline: outlineText,
      realtimeOutlineSegmentCount: outlineCommittedCount,
      realtimeOutlineSourceCoverage: outlineCoverage,
      realtimeOutlineCoverageScope: "whole-note",
      continuationSourcePath: reloadedTarget.path,
      continuationSourceTitle: reloadedTarget.basename,
      continuationRecordedAt: context.recordedAt,
      continuationPriorOutline: port.extractPriorOutline(targetMarkdown),
      continuationPriorAudioNames: port.getAudioReferences(targetMarkdown),
      continuationPriorRecordingInfo: port.getDetailsBody(targetMarkdown, labelPattern("recordingInfo")),
      continuationBaseSegments: base,
      continuationOffsetMs: durationMs,
      continuation: context,
      masterAudioPath: context.masterAudioPath || "",
      masterAudioName: context.masterAudioName || "",
      multiSourceAudio: true,
      finalized: false,
    };
    const persistedSessionMeta = () => Object.fromEntries(
      Object.entries(sessionMeta).filter(([key, value]) =>
        key !== "_taskActivityId" && key !== "_taskMeter" && typeof value !== "function"),
    );
    sessionMeta._taskActivityId = port.queueTaskActivityId(task);
    let polished: string;
    try {
      polished = await port.mergeAndPolish(mergedSegments, task.mode, sessionMeta, task.speakerFrontmatter || null);
    } catch (error) {
      task.sessionMeta = persistedSessionMeta();
      if (port.getQueue()) await port.getQueue()?.update(task.id, { sessionMeta: task.sessionMeta });
      throw error;
    }
    if (!polished) throw new Error(t("Merge returned an empty result"));
    task.sessionMeta = persistedSessionMeta();
    if (port.getQueue()) await port.getQueue()?.update(task.id, { sessionMeta: task.sessionMeta });
    try {
      await port.saveVersion(reloadedTarget, targetMarkdown, base, {
        kind: "pre-append", label: t("Before append") + " " + port.formatMoment("YYYY-MM-DD HH:mm"),
        mode: task.mode, idLabel: `pre-append-${port.formatMoment("YYYYMMDD-HHmmss")}`,
        body: targetMarkdown, activate: false,
      });
    } catch (error) {
      console.warn("[QnALog] pre-append version archive failed", error);
    }
    port.patchTaskActivity(port.queueTaskActivityId(task), {
      status: "running",
      stage: "write-note",
      stageLabel: t("Write to Minutes"),
      progress: 88,
      detail: t("Writing the organized result to Obsidian"),
      error: "",
      completedAt: 0,
    });
    await port.commitContinuation(writeSession, polished, []);
    if (sessionMeta._briefingCheckpointId) await port.clearCommittedBriefingCheckpoint(sessionMeta);
    await port.refreshNoteIndex(reloadedTarget, { meetingDate: startedAt, reason: "continuation-merge" });
    await port.cleanupSuccessfulSegmentAudio(writeSession);
    await port.trashFile(stageFile);
    return;
  });
}
