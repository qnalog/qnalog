/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：会话收尾：分段转写与沉淀、说话人姓名确认、正文与版本落盘

import * as obsidian from "obsidian";
import { SpeakerNameConfirmModal } from "../ui/modals";
import { transcribeAudio } from "../asr/transcribe";
import { readFileFrontmatter } from "../shared/util-note";
import { loadVocabularyGroups, applyVocabularyCorrections } from "../vocabulary";
import { getLlmConfigIssue } from "../llm/core";
import type { PluginSettings, RecordingSession, PreparedLiveSegment } from "../shared/types";
import type { LiveAsrPipelineService } from "../asr/live-asr-pipeline-service";
import { formatElapsed } from "../shared/util-common";
import { diagnosticError } from "../shared/util-key-diag";
import { transcribeAudioByChannels } from "../asr/channel-transcription";
import { classifyRecordingIssue } from "../notes/recording-issues";
import { clearCommittedBriefingCheckpoint } from "../prompts/briefing-prompts";
import { normalizeMeetingWorkbench } from "../notes/meeting-workbench-state";
import { getSegmentsDurationMs } from "../notes/audio-refs";
import { buildTitleSourceFromSegments } from "../notes/note-markdown";
import { RecorderService } from "../audio/recorder-service";
import { TaskQueue } from "../queue/task-queue";
import { mergeAndPolish } from "../briefing/merge-pipeline";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { NoteWriter } from "../notes/note-writer";
import { TranscribeProfileService } from "../asr/transcribe-profile-service";
import { RealtimeOutlineService } from "../notes/realtime-outline-service";
import type { MeetingWorkbenchRunOptions } from "../notes/meeting-workbench-service";
import { NoteIndexService } from "../notes/note-index-service";
import { VersionStore } from "../versions/version-store";
import { NS_FM_SPEAKERS } from "../shared/namespace";

import { t } from "../shared/i18n";
import type { ContinuationService } from "../session/continuation-service";
import type { SessionStore } from "../session/session-store";
import type { SessionFinalizeFlowHost } from "./session-finalize-flow";
import { finalizeSessionFlow } from "./session-finalize-flow";
import { bindTranscriptSegmentToAudio } from "../transcript/audio-binding";
import { syncTranscriptAudioSource } from "./session-finalize-sources";
import type { SessionTranscriptSourcePort } from "./session-finalize-sources";
import { finishShortRecordingFlow } from "./session-finalize-run-flow";
import { runSessionFinalization } from "./session-finalize-run-flow";
import type { SessionFinalizeRunPort, SessionShortRecordingPort } from "./session-finalize-run-flow";
import { processLiveSegment } from "./live-segment-flow";
import type { LiveSegmentPort } from "./live-segment-flow";
import { confirmSpeakerNames } from "./speaker-confirmation-flow";
import type { SpeakerConfirmationPort } from "./speaker-confirmation-flow";
export interface SessionFinalizeHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  continuations: ContinuationService;
  diagnostics: DiagnosticsService;
  /** 互动看板服务：实时转写块清理与互动处理（窄面：实际只用这 2 个方法）。 */
  meetingWorkbench: {
    removeLiveTranscriptBlock(mdPath: string, sessionId: string): Promise<void>;
    processPendingMeetingWorkbenchInteractions(session: RecordingSession, opts?: MeetingWorkbenchRunOptions): Promise<void>;
  };
  noteIndex: NoteIndexService;
  noteWriter: NoteWriter;
  outline: RealtimeOutlineService;
  profiles: TranscribeProfileService;
  queue: TaskQueue | null;
  /** 装配层转发：转写熔断后的延迟重试排期（调用 QueueRetryService.scheduleDeferredAsrRetry）。 */
  requestDeferredAsrRetry(session: RecordingSession): void;
  /** 装配层转发：队列失败重试排期（调用 QueueRetryService.scheduleTaskQueueRetry）。 */
  requestTaskQueueRetry(delayMs: number, reason: string): void;
  /** 装配层转发：读取知识库里的音频缓存（调用 QueueRetryService.readVaultAudioBlob）。 */
  readVaultAudioBlob(path: string, fallbackName: string): Promise<{ blob: Blob; sourcePath: string; sourceName: string; recovered: boolean } | null>;
  recorder: RecorderService | null;
  /** 实时转写管线：负责分段持久化、重试任务与转写状态。 */
  asrPipeline: LiveAsrPipelineService;
  sessionStore: SessionStore;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
  /** 装配层转发：请求刷新侧边栏（调用 ViewShellService.refreshOutlineView）。 */
  requestOutlineRefresh(): void;
  /** 任务中心的任务计量窗口：会话收尾的计时、结算与完成记录（窄面：实际只用这 3 个方法）。 */
  taskMeters: {
    beginTaskMeter(): { inChars: number; outChars: number; exactTokens: number; calls: number; hasExact: boolean; startedAt: number };
    endTaskMeter(expectedMeter?: unknown): { tokens: number; exact: boolean; durationMs: number } | null;
    logCompletedWork(title: string, detail: string, meter: { tokens?: number; exact?: boolean; durationMs?: number } | null): void;
  };
  /** 版本块与派生笔记服务：续录覆盖前留档旧整理稿。 */
  versions: VersionStore;
}

export class SessionFinalizeService {
  declare host: SessionFinalizeHost;
  /** 侧边栏成品面板的缓存标记。注意：插件对象上的这三个字段目前只被写、没有人读，
      侧边栏读的是视图自己的同名字段；保留是为了不改变行为，可在单独一次清理里核实后删除。 */
  declare notePanelCacheKey;
  declare notePanelCacheData;
  declare notePanelLoading;
  private readonly finalizeFlowHost: SessionFinalizeFlowHost;

  constructor(host: SessionFinalizeHost) {
    this.host = host;
    this.finalizeFlowHost = {
      runFinalizer: (session) => this.runSessionFinalizer(session),
      reportFailure: (session, error) => this.reportSessionFinalizationFailure(session, error),
      settleContinuation: (session) => this.settleContinuationFinalization(session),
      releaseSession: (sessionId) => this.host.continuations.releaseSession(sessionId),
    };
    this.notePanelCacheKey = null;
    this.notePanelCacheData = null;
    this.notePanelLoading = null;
  }

  processSegment(session: RecordingSession, seg: PreparedLiveSegment): Promise<void> {
    return processLiveSegment(this.liveSegmentPort(), session, seg);
  }

  private liveSegmentPort(): LiveSegmentPort {
    return {
      getSettings: () => this.host.settings,
      getActiveProfile: () => this.host.profiles.getActiveTranscribeProfile(),
      getSegmentCacheFolder: () => this.host.asrPipeline.getSegmentCacheFolder(),
      ensureSegmentCacheFolder: () => this.host.asrPipeline.ensureSegmentCacheFolder(),
      writeSegmentAudio: (path, data) => this.host.app.vault.adapter.writeBinary(path, data),
      saveMasterAudio: (session, seg) => this.host.asrPipeline.saveMasterAudio(session, seg),
      closeStreamingForDiscard: (session) => this.host.asrPipeline.closeStreamingForDiscard(session),
      markSegmentTaskRunning: (seg) => this.host.asrPipeline.markLiveSegmentQueueTaskRunning(seg),
      getLiveAsrJob: (session, jobId) => this.host.asrPipeline.getLiveAsrJobs(session).get(jobId),
      updateBacklogPolicy: (session, reason) => this.host.asrPipeline.updateLiveAsrBacklogPolicy(session, reason),
      isServiceCircuitOpen: () => this.host.asrPipeline.isAsrServiceCircuitOpen(),
      readVaultAudio: async (path, fallbackName) => {
        const audio = await this.host.readVaultAudioBlob(path, fallbackName);
        return audio ? { blob: audio.blob } : null;
      },
      loadVocabulary: () => loadVocabularyGroups(this.host),
      applyVocabulary: (text, groups) => applyVocabularyCorrections(text, groups),
      removeLiveTranscriptBlock: (mdPath, sessionId) => this.host.meetingWorkbench.removeLiveTranscriptBlock(mdPath, sessionId),
      transcribeAudio: (blob, mime) => transcribeAudio(this.host, blob, mime),
      transcribeChannels: (blob, mime, count, options) => transcribeAudioByChannels(this.host, blob, mime, count, options),
      recordAttemptFailure: (session, error, seg) => this.host.asrPipeline.recordLiveAsrAttemptFailure(session, error, seg),
      recordAttemptSuccess: (session) => this.host.asrPipeline.recordLiveAsrAttemptSuccess(session),
      getBacklogDurationMs: (session) => this.host.asrPipeline.getLiveAsrBacklogSummary(session).totalDurationMs,
      classifyIssue: (error) => classifyRecordingIssue(error),
      setRecordingIssue: (kind, patch) => this.host.asrPipeline.setRecordingIssue(kind, patch),
      clearRecordingIssue: (kind) => this.host.asrPipeline.clearRecordingIssue(kind),
      markSessionAsrJobsDeferred: (session) => this.host.asrPipeline.markSessionAsrJobsDeferred(session),
      keepSegmentTaskForRetry: (session, descriptor, error) => this.host.asrPipeline.keepLiveSegmentQueueTaskForRetry(session, descriptor, error),
      removeLiveSegmentTask: (seg) => this.host.asrPipeline.removeLiveSegmentQueueTask(seg),
      insertBeforeSegmentsEnd: (mdPath, block, sessionId) => this.host.noteWriter.insertBeforeSegmentsEnd(mdPath, block, sessionId),
      setProgress: (session, patch) => this.host.asrPipeline.setSessionWorkProgress(session, patch),
      logDiagnostic: (level, code, message, data) => this.host.diagnostics.logDiagnostic(level, code, message, data),
      requestOutlineRefresh: () => this.host.requestOutlineRefresh(),
      scheduleRealtimeOutline: () => this.host.outline.scheduleRealtimeOutline(),
    };
  }


  private transcriptSourcePort(): SessionTranscriptSourcePort {
    return {
      getVault: () => this.host.app.vault,
      bindSegmentToAudio: (segment, path, name) => bindTranscriptSegmentToAudio(segment, path, name),
    };
  }

  finalizeSession(session: RecordingSession): Promise<void> {
    return finalizeSessionFlow(this.finalizeFlowHost, session);
  }

  private async runSessionFinalizer(session: RecordingSession): Promise<void> {
    const targetFile = this.host.app.vault.getAbstractFileByPath(session.mdPath);
    if (targetFile instanceof obsidian.TFile) {
      await this.host.continuations.runOnTarget(targetFile, () => this._finalizeSessionImpl(session));
    } else {
      await this._finalizeSessionImpl(session);
    }
  }

  private async reportSessionFinalizationFailure(session: RecordingSession, error: unknown): Promise<void> {
    if (session._finalizeTaskMeter) {
      this.host.taskMeters.endTaskMeter(session._finalizeTaskMeter);
      session._finalizeTaskMeter = null;
    }
    try {
      this.host.asrPipeline.setSessionWorkProgress(session, {
        stage: "finalize-failed",
        label: t("Failed to finalize minutes"),
        percent: null,
        detail: t("The original transcript and recording were kept; open the note and re-organize"),
      });
    } catch { /* intentionally empty */ }
    console.error("[QnALog] finalize session failed", error);
    try {
      await this.host.diagnostics.logDiagnostic("error", "session.finalize_failed", t("Finalizing the minutes failed unexpectedly; the original material was kept"), {
        mode: session.mode,
        mdPath: session.mdPath,
        segmentCount: Array.isArray(session.segments) ? session.segments.length : 0,
        error: diagnosticError(error),
      });
    } catch { /* intentionally empty */ }
    new obsidian.Notice(t("Failed to finalize minutes; the original transcript and recording have been kept. You can use \"Reorganize\" in the note."), 10000);
    this.host.sessionStore.end(session);
    this.host.requestOutlineRefresh();
  }

  private settleContinuationFinalization(session: RecordingSession): Promise<void> | undefined {
    if (!session.continuationTaskId || !this.host.queue) return undefined;
    const isDiscardedContinuation = session.shortRecordingTier === "discard"
      && !!session.continuation
      && !!session.continuationTaskId;
    if (isDiscardedContinuation) {
      if (!session.finalized) {
        return (async () => {
          try {
            await this.host.queue.update(session.continuationTaskId, {
              status: "failed",
              mdPath: session.mdPath,
              temporarySourcePath: session.mdPath,
              continuation: session.continuation,
              segments: [],
              continuationDisposition: "discard",
              lastError: session.finalizationError || "",
            });
          } catch (error) {
            console.error("[QnALog] discarded continuation recovery task update failed", error);
          }
        })();
      }
      return undefined;
    }
    const continuation = {
      ...session.continuation,
      realtimeOutline: String(session.realtimeOutline || ""),
      realtimeOutlineSegmentCount: Number(session.realtimeOutlineSegmentCount) || 0,
      realtimeOutlineSourceCoverage: session.realtimeOutlineSourceCoverage,
      masterAudioPath: String(session.masterAudioPath || ""),
      masterAudioName: String(session.masterAudioName || ""),
    };
    return (async () => {
      try {
        await this.host.queue.update(session.continuationTaskId, {
          status: "pending",
          mdPath: session.mdPath,
          temporarySourcePath: session.mdPath,
          segments: (session.segments || []).map(segment => ({ ...segment })),
          continuation,
          sessionMeta: {
            startedAt: session.startedAt,
            duration: formatElapsed(getSegmentsDurationMs(session.segments || [])),
            meetingWorkbench: normalizeMeetingWorkbench(session.meetingWorkbench),
            _briefingCheckpointId: session._briefingCheckpointId || "",
          },
          speakerFrontmatter: null,
          lastError: session.finalizationError || "",
        });
      } catch (error) {
        console.error("[QnALog] continuation recovery task update failed", error);
      }
    })();
  }

  confirmSpeakerNamesBeforeFinal(session, segments) {
    return confirmSpeakerNames(this.speakerConfirmationPort(), session, segments);
  }

  private speakerConfirmationPort(): SpeakerConfirmationPort {
    return {
      getVault: () => this.host.app.vault,
      readFrontmatter: (file) => readFileFrontmatter(this.host, file),
      setProgress: (session, patch) => this.host.asrPipeline.setSessionWorkProgress(session, patch),
      requestOutlineRefresh: () => this.host.requestOutlineRefresh(),
      getSettings: () => this.host.settings,
      getProviderProfile: (id, provider) => this.host.profiles.getTranscribeProviderProfile(id, provider),
      promptSpeakerNames: (candidates, initialMappings, options) => {
        const { promise, resolve } = Promise.withResolvers<Record<string, string> | null>();
        const modal = new SpeakerNameConfirmModal(this.host.app, this.host, candidates, initialMappings, options, resolve);
        modal.open();
        return promise;
      },
      writeSpeakerFrontmatter: (file, mappings) => this.host.app.fileManager.processFrontMatter(file, (nextFrontmatter) => {
        nextFrontmatter[NS_FM_SPEAKERS] = mappings;
      }),
      resetNotePanelCache: () => {
        this.notePanelCacheKey = "";
        this.notePanelCacheData = undefined;
        this.notePanelLoading = false;
      },
      logDiagnostic: (level, code, message, data) => this.host.diagnostics.logDiagnostic(level, code, message, data),
    };
  }

  /**
   * 短录音的收尾：删掉结尾创建的纪要，只保留音频（丢弃级别连音频也不留）。
   *
   * 录音开始时无法预知总时长，纪要头是那一刻就写进磁盘的，因此这里负责把它摘掉。
   * `discard` 级别在 `handleSegment` 里就没保存音频；`keep-audio` 级别的音频已经写进
   * 录音目录，用户之后可以用「导入已有音频文件」手动转写。
   */
  async finishShortRecording(session: RecordingSession): Promise<void> {
    return finishShortRecordingFlow(this.shortRecordingPort(), session);
  }

  private shortRecordingPort(): SessionShortRecordingPort {
    return {
      hasQueue: () => !!this.host.queue,
      updateQueueTask: (id, patch) => this.host.queue.update(id, patch),
      removeQueueTask: (id) => this.host.queue.remove(id),
      discardShortRecordingNote: (session) => this.host.asrPipeline.discardShortRecordingNote(session),
      logDiagnostic: (level, code, message, data) => this.host.diagnostics.logDiagnostic(level, code, message, data),
      endSession: (session) => this.host.sessionStore.end(session),
      requestOutlineRefresh: () => this.host.requestOutlineRefresh(),
    };
  }

  async _finalizeSessionImpl(session: RecordingSession): Promise<void> {
    return runSessionFinalization(this.finalizeRunPort(), session);
  }

  private finalizeRunPort(): SessionFinalizeRunPort {
    return {
      ...this.shortRecordingPort(),
      getSettings: () => this.host.settings,
      getLlmConfigIssue: () => getLlmConfigIssue(this.host.settings),
      getVault: () => this.host.app.vault,
      openFile: (file) => this.host.app.workspace.getLeaf(false).openFile(file),
      readSilenceTicks: () => ({
        voiced: this.host.recorder ? (this.host.recorder._voicedTicks || 0) : 0,
        silent: this.host.recorder ? (this.host.recorder._silentTicks || 0) : 0,
      }),
      setProgress: (target, patch) => this.host.asrPipeline.setSessionWorkProgress(target, patch),
      cleanupSuccessfulSegmentAudio: (target) => this.host.asrPipeline.cleanupSuccessfulSegmentAudio(target),
      removeEmptySessionBlock: (target) => this.host.noteWriter.removeEmptySessionBlock(target),
      appendPolishBlock: (target, polished, error, nonRetryable) => this.host.noteWriter.appendPolishBlock(target, polished, error, nonRetryable),
      rewriteConsolidated: (target, polished) => this.host.noteWriter.rewriteConsolidated(target, polished),
      renameWithGeneratedTitle: (path, polished, mode) => this.host.noteWriter.renameMarkdownWithGeneratedTitle(path, polished, mode),
      refreshNoteIndex: (path, options) => this.host.noteIndex.refreshNoteIndexSafely(path, options),
      autoExtractSediment: (path) => this.host.noteIndex.autoExtractSedimentAfterFinalize(path),
      syncTranscriptAudioSource: (target) => syncTranscriptAudioSource(this.transcriptSourcePort(), target),
      confirmSpeakerNames: (target, segments) => this.confirmSpeakerNamesBeforeFinal(target, segments),
      processMeetingWorkbench: (target, options) => this.host.meetingWorkbench.processPendingMeetingWorkbenchInteractions(target, options),
      ensureRealtimeOutline: (target) => this.host.outline.ensureRealtimeOutlineForFinalNote(target),
      mergeAndPolish: (segments, mode, meta, frontmatter) => mergeAndPolish(this.host, segments, mode, meta, frontmatter),
      clearCommittedBriefingCheckpoint: (meta) => clearCommittedBriefingCheckpoint(this.host, meta),
      addQueueTask: (task) => this.host.queue.add(task),
      requestDeferredAsrRetry: (target) => this.host.requestDeferredAsrRetry(target),
      requestTaskQueueRetry: (delay, reason) => this.host.requestTaskQueueRetry(delay, reason),
      beginTaskMeter: () => this.host.taskMeters.beginTaskMeter(),
      endTaskMeter: (meter) => this.host.taskMeters.endTaskMeter(meter),
      logCompletedWork: (title, detail, meter) => this.host.taskMeters.logCompletedWork(title, detail, meter),
      saveVersion: (file, content, segments, input) => this.host.versions.saveVersion(file, content, segments, input),
      formatNow: (format) => window.moment().format(format),
      buildTitleSource: (segments) => buildTitleSourceFromSegments(segments),
    };
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
