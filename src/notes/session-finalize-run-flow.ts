import * as obsidian from "obsidian";
import type { MergeQueueTaskPayload, PluginSettings, QueueTask, QueueTaskLifecycle, RecordingSession, Segment, SessionMetaForMerge, SessionWorkProgress } from "../shared/types";
import type { VersionSaveInput } from "../versions/version-save-store";
import { t } from "../shared/i18n";
import { SHORT_RECORDING_SKIP_NOTE_MS } from "../shared/limits";
import { isTextImportSession, shouldRewriteConsolidatedNote } from "../briefing/note-layout-policy";
import { BriefingPipelineIncompleteError } from "../briefing/pipeline";
import { readSessionKnowledge } from "../briefing/session-knowledge";
import { isLlmNonRetryableError } from "../llm/failure-policy";
import { formatLlmFailureIssue } from "../llm/failure-presentation";
import { normalizeMeetingWorkbench } from "./meeting-workbench-state";
import { getErrorMessage, formatElapsed } from "../shared/util-common";
import { diagnosticError } from "../shared/util-key-diag";
import { getSegmentsForFinalSession } from "./session-finalize-sources";
type FinalizeProgress = Omit<SessionWorkProgress, "percent"> & { percent?: number | null };

export interface SessionShortRecordingPort {
  hasQueue(): boolean;
  updateQueueTask(id: string, patch: Partial<QueueTask>): Promise<unknown>;
  removeQueueTask(id: string): Promise<unknown>;
  discardShortRecordingNote(session: RecordingSession): Promise<unknown>;
  logDiagnostic(level: string, code: string, message: string, data: unknown): Promise<unknown>;
  endSession(session: RecordingSession): void;
  requestOutlineRefresh(): void;
}

export async function finishShortRecordingFlow(port: SessionShortRecordingPort, session: RecordingSession): Promise<void> {
  const tier = session.shortRecordingTier;
  const limitSeconds = Math.round(SHORT_RECORDING_SKIP_NOTE_MS / 1000);
  const durationMs = Math.max(0, Number(session.shortRecordingDurationMs) || 0);
  const discardedContinuation = tier === "discard"
    && !!session.continuation
    && !!session.continuationTaskId
    && port.hasQueue();
  const continuationTaskId = session.continuationTaskId || "";
  if (discardedContinuation) {
    await port.updateQueueTask(continuationTaskId, {
      status: "live",
      mdPath: session.mdPath,
      temporarySourcePath: session.mdPath,
      continuation: session.continuation,
      segments: [],
      continuationDisposition: "discard",
      lastError: "",
    });
  }
  await port.discardShortRecordingNote(session);
  if (discardedContinuation) await port.removeQueueTask(continuationTaskId);
  const audioName = session.masterAudioName || "";
  if (tier === "discard") {
    new obsidian.Notice(t("Filtered out recordings shorter than three seconds"));
  } else if (audioName) {
    new obsidian.Notice(t("Recording under {0} seconds: audio kept in the recording folder, no minutes created and no transcript kept. Import it manually if needed. ({1})").replace("{0}", String(limitSeconds)).replace("{1}", audioName), 8000);
  } else {
    // 母带录音器没产出音频（设备被收回等）→ 没有可留的文件，如实说明。
    new obsidian.Notice(t("Recording under {0} seconds and its audio could not be saved; skipped.").replace("{0}", String(limitSeconds)), 8000);
  }
  try {
    await port.logDiagnostic("info", "recording.short_recording_skipped", t("Short recording was not transcribed automatically"), {
      tier,
      durationMs,
      audioName,
      mdPath: session.mdPath,
    });
  } catch { /* diagnostics must not change finalization behavior */ }
  port.endSession(session);
  port.requestOutlineRefresh();
}
export interface SessionSpeakerPreparation {
  segments: Segment[];
  frontmatter: Record<string, unknown> | null;
  utteranceProjections?: Array<{ utteranceId: string; normalizedText: string; speakerName: string | null }>;
}

export type FinalizeSettings = Pick<PluginSettings, "autoOpenNoteAfterFinish" | "sedimentAutoExtract" | "llmEndpoint" | "llmModel" | "consolidatedLayout">;

export interface SessionFinalizeRunPort extends SessionShortRecordingPort {
  getSettings(): FinalizeSettings;
  getLlmConfigIssue(): string | null | undefined;
  getVault(): Pick<obsidian.Vault, "getAbstractFileByPath" | "read">;
  openFile(file: obsidian.TFile): Promise<unknown>;
  readSilenceTicks(): { voiced: number; silent: number };
  setProgress(session: RecordingSession, patch: Partial<FinalizeProgress>): void;
  cleanupSuccessfulSegmentAudio(session: RecordingSession): Promise<unknown>;
  removeEmptySessionBlock(session: RecordingSession): Promise<unknown>;
  appendPolishBlock(session: RecordingSession, polished: string, error: unknown, nonRetryable: boolean): Promise<unknown>;
  rewriteConsolidated(session: RecordingSession, polished: string): Promise<unknown>;
  renameWithGeneratedTitle(path: string, polished: string, mode: string): Promise<unknown>;
  refreshNoteIndex(path: string, options: { meetingDate: string; reason: string }): Promise<unknown>;
  autoExtractSediment(path: string): unknown;
  syncTranscriptAudioSource(session: RecordingSession): Promise<void>;
  confirmSpeakerNames(session: RecordingSession, segments: Segment[]): Promise<SessionSpeakerPreparation>;
  processMeetingWorkbench(session: RecordingSession, options: { force: boolean }): Promise<unknown>;
  ensureRealtimeOutline(session: RecordingSession): Promise<unknown>;
  mergeAndPolish(segments: Segment[], mode: string, sessionMeta: SessionMetaForMerge, speakerFrontmatter: Record<string, unknown> | null): Promise<string>;
  clearCommittedBriefingCheckpoint(meta: SessionMetaForMerge): Promise<unknown>;
  addQueueTask(task: MergeQueueTaskPayload & Partial<QueueTaskLifecycle>): Promise<unknown>;
  requestDeferredAsrRetry(session: RecordingSession): void;
  requestTaskQueueRetry(delayMs: number, reason: string): void;
  beginTaskMeter(): unknown;
  endTaskMeter(meter: unknown): { tokens: number; exact: boolean; durationMs: number } | null;
  logCompletedWork(title: string, detail: string, meter: { tokens?: number; exact?: boolean; durationMs?: number } | null): void;
  saveVersion(file: obsidian.TFile, content: string, segments: Segment[], input: VersionSaveInput): Promise<unknown>;
  formatNow(format: string): string;
  buildTitleSource(segments: Segment[]): string;
}

export async function runSessionFinalization(port: SessionFinalizeRunPort, session: RecordingSession): Promise<void> {
  const silence = port.readSilenceTicks();
  const _silVoiced = silence.voiced;
  const _silSilent = silence.silent;
  if (session.shortRecordingTier) {
    await finishShortRecordingFlow(port, session);
    return;
  }
  if (!session.segments || session.segments.length === 0) {
    await port.removeEmptySessionBlock(session);
    new obsidian.Notice(t("⏭ This recording was too short or had no valid audio; skipped"));
    port.endSession(session);
    port.requestOutlineRefresh();
    return;
  }
  const _silTotal = _silVoiced + _silSilent;
  if (!session.source && _silTotal >= 30 && (_silVoiced / _silTotal) < 0.02 && !session._silenceNotified) {
    session._silenceNotified = true;
    new obsidian.Notice(t("Almost no sound was detected in the whole session; please check the selected microphone / computer audio device (Settings → Advanced → Audio device check)."), 9000);
  }
  const textImportSession = isTextImportSession(session);
  await port.syncTranscriptAudioSource(session);
  const segmentsForFinal = getSegmentsForFinalSession(session);
  let writeSession = segmentsForFinal === session.segments
    ? session
    : Object.assign({}, session, { segments: segmentsForFinal, multiSourceAudio: true });
  const usableTranscriptSegments = segmentsForFinal.filter(s => s && String(s.text || "").trim());
  if (!usableTranscriptSegments.length) {
    const noTranscriptError = new Error(t("No usable transcript text for organizing; the recording and failed slices were kept"));
    port.setProgress(session, { stage: "transcript-empty", label: t("No valid transcript obtained"), percent: null, detail: t("The recording was kept; check the transcription service and retry from the pending queue") });
    try {
      await port.logDiagnostic("error", "session.no_transcript", t("No valid transcript for the whole session; AI organizing was skipped to avoid wasted charges"), {
        mode: session.mode, segmentCount: segmentsForFinal.length, failedSegments: segmentsForFinal.filter(s => s && s.error).length, mdPath: session.mdPath,
      });
    } catch { /* intentionally empty */ }
    await port.appendPolishBlock(writeSession, "", noTranscriptError, true);
    new obsidian.Notice(t("No valid transcript obtained; the recording and failed slices have been kept. Please check the transcription service and retry from the pending queue."), 10000);
    if (port.getSettings().autoOpenNoteAfterFinish) {
      const file = port.getVault().getAbstractFileByPath(session.mdPath);
      if (file instanceof obsidian.TFile) {
        try { await port.openFile(file); } catch { /* intentionally empty */ }
      }
    }
    port.requestDeferredAsrRetry(session);
    port.endSession(session);
    port.requestOutlineRefresh();
    return;
  }
  let speakerPreparation: SessionSpeakerPreparation = { segments: segmentsForFinal, frontmatter: null, utteranceProjections: [] };
  try {
    speakerPreparation = await port.confirmSpeakerNames(session, segmentsForFinal);
  } catch (error) {
    console.warn("[QnALog] speaker confirmation failed; continuing with generic labels", error);
    try {
      await port.logDiagnostic("warn", "speaker.confirmation_failed", t("Speaker name confirmation did not finish; numbers were kept and organizing continued"), { mdPath: session.mdPath, error: diagnosticError(error) });
    } catch { /* intentionally empty */ }
  }
  const segmentsForLlm = speakerPreparation.segments || segmentsForFinal;
  const speakerFrontmatter = speakerPreparation.frontmatter || null;
  if (segmentsForLlm !== segmentsForFinal) writeSession = Object.assign({}, writeSession, { segments: segmentsForLlm });
  port.setProgress(session, { stage: "finalize-start", label: textImportSession ? t("Text read complete") : t("Preparing AI organizing"), percent: 12, detail: textImportSession ? t("ASR skipped; preparing structured organizing") : t("Transcription finished; organizing the context") });
  port.requestOutlineRefresh();
  new obsidian.Notice(textImportSession ? t("Text read; AI structuring in progress…") : t("All segments processed; AI merging and polishing in progress…"));
  let polished = "";
  let mergeError: unknown = null;
  let nonRetryableMergeError = false;
  let commitError = false;
  let taskMeter: unknown = null;
  let finalSessionMeta: SessionMetaForMerge | null = null;
  try {
    const llmConfigIssue = port.getLlmConfigIssue();
    if (llmConfigIssue) {
      const configurationError = new Error(llmConfigIssue);
      (configurationError as Error & { nonRetryable?: boolean }).nonRetryable = true;
      throw configurationError;
    }
    port.setProgress(session, { stage: "workbench", label: t("Organize context"), percent: 22, detail: t("Merging meeting entries, attachments, and context") });
    await port.processMeetingWorkbench(session, { force: true });
    if (!textImportSession) {
      port.setProgress(session, { stage: "outline", label: t("Generate outline"), percent: 36, detail: t("Completing the live outline for reference by the final minutes") });
      await port.ensureRealtimeOutline(session);
    }
    const lastSeg = segmentsForFinal[segmentsForFinal.length - 1];
    const textImport = textImportSession;
    const sessionMeta: SessionMetaForMerge = {
      startedAt: session.startedAt,
      duration: textImport ? "" : (lastSeg ? formatElapsed(lastSeg.endOffsetMs || 0) : ""),
      source: session.source || "",
      sourceMeta: session.sourceMeta || null,
      meetingWorkbench: normalizeMeetingWorkbench(session.meetingWorkbench),
      _utteranceProjections: speakerPreparation.utteranceProjections || [],
    };
    const noteFile = port.getVault().getAbstractFileByPath(session.mdPath);
    if (noteFile instanceof obsidian.TFile) sessionMeta._previousKnowledge = readSessionKnowledge(await port.getVault().read(noteFile));
    finalSessionMeta = sessionMeta;
    port.setProgress(session, { stage: "llm-merge", label: t("AI organizing"), percent: 62, detail: textImport ? t("Sending the imported text to the AI model for structured organizing") : t("Merging the segmented transcriptions into the final minutes") });
    taskMeter = port.beginTaskMeter();
    sessionMeta._taskMeter = taskMeter;
    session._finalizeTaskMeter = taskMeter;
    polished = session.continuation ? "" : await port.mergeAndPolish(segmentsForLlm.map(segment => ({ ...segment })), session.mode, sessionMeta, speakerFrontmatter);
    session._briefingCheckpointId = sessionMeta._briefingCheckpointId || "";
    port.setProgress(session, { stage: "write-note", label: t("Write to Minutes"), percent: 88, detail: t("AI output received; writing to the Obsidian note") });
  } catch (error) { mergeError = error; console.error(error); }
  session.finalizing = false;
  if (mergeError) {
    if (taskMeter) {
      port.endTaskMeter(taskMeter);
      taskMeter = null;
      session._finalizeTaskMeter = null;
    }
    nonRetryableMergeError = isLlmNonRetryableError(mergeError);
    await port.logDiagnostic("error", "llm.merge_failed", t("LLM merging and organizing failed"), {
      mode: session.mode, segmentCount: segmentsForFinal.length,
      duration: isTextImportSession(session) ? "" : (segmentsForFinal.length ? formatElapsed(segmentsForFinal[segmentsForFinal.length - 1].endOffsetMs || 0) : ""),
      llmEndpoint: port.getSettings().llmEndpoint, llmModel: port.getSettings().llmModel,
      nonRetryable: nonRetryableMergeError, error: diagnosticError(mergeError),
    });
    const lastSeg = segmentsForFinal[segmentsForFinal.length - 1];
    const retrySessionMeta = Object.assign({}, finalSessionMeta || {
      startedAt: session.startedAt, duration: isTextImportSession(session) ? "" : (lastSeg ? formatElapsed(lastSeg.endOffsetMs || 0) : ""),
      source: session.source || "", sourceMeta: session.sourceMeta || null, meetingWorkbench: normalizeMeetingWorkbench(session.meetingWorkbench),
    });
    delete retrySessionMeta._previousKnowledge;
    const errorMessage = (mergeError as { message?: string }).message || (mergeError as { toString(): string }).toString();
    await port.addQueueTask({
      type: "merge", sessionId: session.id, mdPath: session.mdPath, mode: session.mode,
      status: nonRetryableMergeError ? "blocked" : "pending", segments: segmentsForLlm.map(segment => ({ ...segment })),
      source: session.source || "", sourceMeta: session.sourceMeta || null, externalAudioSource: session.externalAudioSource || null,
      textImportSources: session.textImportSources || [], speakerFrontmatter, sessionMeta: retrySessionMeta, lastError: errorMessage,
    });
    if (!nonRetryableMergeError) port.requestTaskQueueRetry(1500, mergeError instanceof BriefingPipelineIncompleteError ? "briefing-partial" : "briefing-finalization-failure");
    session.finalizationError = getErrorMessage(mergeError);
    const partialBriefing = mergeError instanceof BriefingPipelineIncompleteError;
    port.setProgress(session, {
      stage: nonRetryableMergeError ? "merge-failed" : "merge-retrying",
      label: nonRetryableMergeError ? t("AI organizing failed") : partialBriefing ? t("Minutes partially completed") : t("AI organizing waiting to retry"), percent: null,
      detail: nonRetryableMergeError ? t("The original transcript has been kept; fix the model configuration and re-organize.")
        : partialBriefing ? t("{0}; the completed portion and the original transcript have both been saved").replace("{0}", (mergeError as { message?: string }).message || "")
          : t("The original transcript has been kept; the background queue will retry with backoff"),
    });
  }
  if (!mergeError) {
    if (session.continuationSourcePath && !session.continuation) {
      try {
        const targetFile = port.getVault().getAbstractFileByPath(session.mdPath);
        if (targetFile instanceof obsidian.TFile) {
          const priorContent = await port.getVault().read(targetFile);
          await port.saveVersion(targetFile, priorContent, session.continuationBaseSegments || segmentsForFinal, {
            kind: "pre-append", label: t("Before append") + " " + port.formatNow("YYYY-MM-DD HH:mm"), mode: session.mode,
            idLabel: "pre-append-" + port.formatNow("YYYYMMDD-HHmmss"), body: priorContent, activate: false,
          });
        }
      } catch (archiveError) {
        console.warn("[QnALog] pre-append version archive failed", archiveError);
        try { await port.logDiagnostic("warn", "session.pre_append_archive_failed", t("Archiving the previous draft before the append failed; the append itself is unaffected"), { mdPath: session.mdPath, error: diagnosticError(archiveError) }); }
        catch { /* intentionally empty */ }
      }
    }
    try {
      if (shouldRewriteConsolidatedNote(port.getSettings(), writeSession)) await port.rewriteConsolidated(writeSession, polished);
      else await port.appendPolishBlock(writeSession, polished, null, false);
    } catch (writeError) {
      commitError = true;
      mergeError = writeError;
      session.finalizationError = getErrorMessage(writeError);
      await port.logDiagnostic("error", "briefing.commit_failed", t("The minutes body was generated, but writing the Markdown failed"), {
        mode: session.mode, mdPath: session.mdPath, checkpointId: finalSessionMeta && finalSessionMeta._briefingCheckpointId || "", error: diagnosticError(writeError),
      });
      await port.addQueueTask({
        type: "merge", sessionId: session.id, mdPath: session.mdPath, mode: session.mode,
        segments: segmentsForLlm.map(segment => ({ ...segment })), source: session.source || "", sourceMeta: session.sourceMeta || null,
        externalAudioSource: session.externalAudioSource || null, textImportSources: session.textImportSources || [], speakerFrontmatter,
        sessionMeta: finalSessionMeta, lastError: t("Failed to write the minutes: {0}").replace("{0}", getErrorMessage(writeError)),
      });
      port.requestTaskQueueRetry(1500, "briefing-write-failure");
      port.setProgress(session, { stage: "write-retrying", label: t("Minutes write waiting to retry"), percent: null, detail: t("The AI result was saved; the model will not be called again and only the write will be retried later") });
    }
  } else {
    await port.appendPolishBlock(writeSession, polished, mergeError, nonRetryableMergeError);
  }
  if (!mergeError && finalSessionMeta && finalSessionMeta._briefingCheckpointId) {
    await port.clearCommittedBriefingCheckpoint(finalSessionMeta);
    session._briefingCheckpointId = "";
  }
  if (!mergeError) port.setProgress(session, { stage: "done", label: t("Processing complete"), percent: 100, detail: t("Minutes written; finishing up") });
  if (!mergeError && polished && !session.continuationSourcePath) {
    const beforeRenamePath = session.mdPath;
    const renamed = await port.renameWithGeneratedTitle(session.mdPath, polished, session.mode);
    if (renamed instanceof obsidian.TFile) { session.mdPath = renamed.path; writeSession.mdPath = renamed.path; }
    const renamedByPolished = renamed instanceof obsidian.TFile && obsidian.normalizePath(renamed.path) !== obsidian.normalizePath(beforeRenamePath);
    if ((session.source === "import" || session.source === "text-import") && !renamedByPolished) {
      const rawTitleSource = port.buildTitleSource(segmentsForFinal);
      if (rawTitleSource) {
        const fallbackRenamed = await port.renameWithGeneratedTitle(session.mdPath, rawTitleSource, session.mode);
        if (fallbackRenamed instanceof obsidian.TFile) { session.mdPath = fallbackRenamed.path; writeSession.mdPath = fallbackRenamed.path; }
      }
    }
  }
  if (!mergeError && polished) await port.refreshNoteIndex(writeSession.mdPath, { meetingDate: session.startedAt, reason: "finalize" });
  if (!mergeError) {
    if (!session.continuation) await port.cleanupSuccessfulSegmentAudio(session);
    const completedTaskMeter = taskMeter ? port.endTaskMeter(taskMeter) : null;
    taskMeter = null;
    session._finalizeTaskMeter = null;
    if (!session.continuation) {
      try {
        const doneLabel = isTextImportSession(session) ? t("Text organization completed") : session.source === "import" ? t("Imported audio organization completed") : t("Recording minutes completed");
        port.logCompletedWork(doneLabel, session.mdPath || "", completedTaskMeter);
      } catch { /* intentionally empty */ }
      if (port.getSettings().sedimentAutoExtract) void port.autoExtractSediment(session.mdPath);
    }
  }
  new obsidian.Notice(mergeError
    ? (nonRetryableMergeError ? t("AI organizing failed: {0}").replace("{0}", formatLlmFailureIssue((mergeError as { message?: string }).message || mergeError))
      : commitError ? t("The minutes body has been generated but writing failed; queued for retry.")
        : mergeError instanceof BriefingPipelineIncompleteError ? t("{0}, queued for precise retry").replace("{0}", (mergeError as { message?: string }).message || "")
          : t("AI organizing did not finish; queued for retry."))
    : (session.continuation ? t("Continuation recording saved separately; it will be merged into \"{0}\" after its current processing finishes.").replace("{0}", session.continuation.targetPath.split("/").pop()?.replace(/\\.md$/i, "") || session.continuation.targetPath)
      : session.continuationSourcePath ? t("Append session completed: {0} segments this time, {1} segments after merging (the previous draft was saved to the version cache).").replace("{0}", String(session.segments.length)).replace("{1}", String(segmentsForFinal.length))
        : t("QnALog processing completed")));
  if (port.getSettings().autoOpenNoteAfterFinish) {
    const file = port.getVault().getAbstractFileByPath(session.mdPath);
    if (file instanceof obsidian.TFile) {
      try { await port.openFile(file); } catch { /* intentionally empty */ }
    }
  }
  port.requestDeferredAsrRetry(session);
  port.endSession(session);
  port.requestOutlineRefresh();
}
