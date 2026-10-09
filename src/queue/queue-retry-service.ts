/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：队列任务的失败恢复：转写重试、合并重试、提示词任务、改名与删除后的任务迁移

import * as obsidian from "obsidian";
import type { LiveAsrPipelineService } from "../asr/live-asr-pipeline-service";
import { QnALogSettingTab } from "../ui/settings-tab";
import { getModeMeta, getEffectivePolishMode } from "../shared/mode-meta";
import { decodeAudioBlob, renderAudioBufferSliceToWav, transcribeAudio } from "../asr/transcribe";
import { getLlmConfigIssue } from "../llm/core";
import type { PluginSettings } from "../shared/types";
import type { SessionStore } from "../session/session-store";
import { genId } from "../shared/util-common";
import { renderMultichannelAudioBufferSliceToWav, transcribeAudioByChannels } from "../asr/channel-transcription";
import { transcribeImportedAudio } from "../asr/long-audio-transcription";
import { shouldRewriteConsolidatedNote } from "../briefing/note-layout-policy";
import { clearCommittedBriefingCheckpoint } from "../prompts/briefing-prompts";
import { collectAudioRefs, getSegmentsDurationMs } from "../notes/audio-refs";
import { extractDetailsBody } from "../notes/detail-blocks";
import { readCurrentOutlineBlock } from "../notes/outline-storage";
import { createRealtimeOutlineSourceCoverage, validateRealtimeOutlineSourceCoverage } from "../notes/outline-coverage";
import { extractTranscriptSegments } from "../notes/note-transcript-ledger";
import { inferNoteStartedAtIso, normalizeSegmentsForMergedNote } from "../notes/note-source-metadata";
import { getCurrentTranscript } from "../transcript/session-transcript";
import { extractPriorOutline, getContinuationTargetIdentity } from "../session/continuation-service";
import type { ContinuationService } from "../session/continuation-service";
import { readSessionKnowledge } from "../briefing/session-knowledge";
  
import { mergeLeadingFrontmatterIntoDocument } from "../notes/note-briefing-output";
import { getQueueTasksForMarkdown } from "../recent/recent-notes";
import { RecorderService } from "../audio/recorder-service";
import { TaskQueue } from "../queue/task-queue";
import { mergeAndPolish } from "../briefing/merge-pipeline";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { NoteIndexService } from "../notes/note-index-service";
import { VocabularyService } from "../vocabulary/vocabulary-service";
import { NoteWriter } from "../notes/note-writer";

import { t } from "../shared/i18n";
import type { RealtimeOutlineService } from "../notes/realtime-outline-service";
import { VersionStore } from "../versions/version-store";
import type { TaskActivityService } from "../tasks/task-activity-service";
import {
  readTaskAudioBlob,
  readVaultAudioBlob as readVaultAudioBlobFromPort,
  type TranscribeAudioSourcePort,
} from "./transcribe-audio-source";
import { migrateQueueTasksAfterRename as migrateQueueTasksAfterRenameFlow, removeQueueTasksForDeletedMarkdown as removeQueueTasksForDeletedMarkdownFlow, type QueueTaskPathPort } from "./queue-task-paths";
import { QueueRetryControl } from "./queue-retry-control";
import { runAppendTask as runAppendTaskFlow, type AppendTask, type QueueAppendTaskPort } from "./queue-append-task-flow";
import { retryTranscribeTask as retryTranscribeTaskFlow, type QueueTranscribeRetryPort } from "./queue-transcribe-retry-flow";
import { retryMergeTask as retryMergeTaskFlow, type QueueMergeRetryPort } from "./queue-merge-retry-flow";
import { runGeneratePromptTask as runGeneratePromptTaskFlow, type QueuePromptTaskPort } from "./queue-prompt-task-flow";
/** QueueRetryService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface QueueRetryHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;

  diagnostics: DiagnosticsService;




  noteWriter: NoteWriter;
  queue: TaskQueue | null;
  recorder: RecorderService | null;
  /** 装配层转发：队列状态变化后请求刷新侧边栏（调用 ViewShellService.refreshOutlineView）。 */
  requestOutlineRefresh(): void;

  saveAll(): Promise<void>;
  saveSettings(): Promise<void>;
  sessionStore: SessionStore;
  settingTab: QnALogSettingTab | null;
  /** 笔记索引与当日概要服务。 */
  noteIndex: NoteIndexService;
  outline: Pick<RealtimeOutlineService, "completeRealtimeOutlineForMergedSegments" | "mergeContinuationOutlineText">;
  /** ASR 与录音 stage 清理。 */
  asrPipeline: Pick<LiveAsrPipelineService, "getAsrServiceCircuitState" | "isAsrServiceCircuitOpen" | "getAsrServiceRetryDelayMs" | "resetAsrServiceCircuitForManualRetry" | "maybeDeleteSegmentCacheFile" | "cleanupSuccessfulSegmentAudio" | "discardShortRecordingNote">;
  /** 装配层转发：补转写成功后请求说话人姓名确认（调用 SessionFinalizeService.confirmSpeakerNamesBeforeFinal），返回值在调用点不使用。 */
  confirmSpeakerNames(session: { id: string; mdPath: string; source: string; importTranscribeProviderId?: string }, segments: { text: string }[]): Promise<unknown>;
  /** 词汇表与行业提示词服务。 */
  vocabulary: VocabularyService;
  /** 重新整理服务：导入转写完成后按说话人姓名重排纪要。 */
  repolish: { repolishMarkdownFile(file: obsidian.TFile, mode: string, repolishOptions?: unknown): Promise<void> };
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
  continuations: Pick<ContinuationService, "runOnTarget" | "hasActiveSessions" | "isSessionTracked">;
  /** 版本快照持久化。 */
  versions: Pick<VersionStore, "saveVersion">;
  tasks: Pick<TaskActivityService, "queueTaskActivityId" | "patchTaskActivity">;
  /** 装配层转发：批量重试节奏变化后刷新任务状态栏（调用 TaskActivityService.updateBusyStatus）。 */
  notifyTaskBusyChanged(): void;
}

export class QueueRetryService {
  declare host: QueueRetryHost;
  declare control: QueueRetryControl;

  constructor(host: QueueRetryHost) {
    this.host = host;
    this.control = new QueueRetryControl({
      getQueue: () => this.host.queue,
      getRecorderState: () => this.host.recorder ? this.host.recorder.state : null,
      getSession: () => this.host.sessionStore.get(),
      getMaxRetries: () => this.host.settings.maxRetries,
      getLlmConfigIssue: () => getLlmConfigIssue(this.host.settings),
      getTranscribeTasksForMarkdown: (file) => getQueueTasksForMarkdown(this.host, file, { types: ["transcribe"] }),
      logDiagnostic: (level, code, message, data) => this.host.diagnostics.logDiagnostic(level, code, message, data),
      saveAll: () => this.host.saveAll(),
      requestOutlineRefresh: () => this.host.requestOutlineRefresh(),
      notifyTaskBusyChanged: () => this.host.notifyTaskBusyChanged(),
      asr: {
        getCircuitState: () => this.host.asrPipeline.getAsrServiceCircuitState(),
        isCircuitOpen: () => this.host.asrPipeline.isAsrServiceCircuitOpen(),
        getRetryDelayMs: () => this.host.asrPipeline.getAsrServiceRetryDelayMs(),
        resetForManualRetry: (source) => this.host.asrPipeline.resetAsrServiceCircuitForManualRetry(source),
      },
    });
  }

  dispose() { this.control.dispose(); }

  scheduleTaskQueueRetry(delayMs = 1500, reason = "scheduled") { this.control.schedule(delayMs, reason); }

  scheduleDeferredAsrRetry(session) { this.control.scheduleDeferredAsr(session); }

  retryQueue() { return this.control.retryAll(); }

  retryTranscribeTasksForMarkdown(file) { return this.control.retryTranscribeForMarkdown(file); }
  private audioSourcePort(): TranscribeAudioSourcePort {
    return {
      getVault: () => this.host.app.vault,
      getAudioFolder: () => this.host.settings.audioFolder,
      getAudioChannelMode: () => this.host.settings.audioChannelMode,
      decodeAudioBlob,
      renderMonoSlice: renderAudioBufferSliceToWav,
      renderMultichannelSlice: renderMultichannelAudioBufferSliceToWav,
      logDiagnostic: (level, code, message, data) => this.host.diagnostics.logDiagnostic(level, code, message, data),
    };
  }

  async readVaultAudioBlob(path, fallbackName) {
    return readVaultAudioBlobFromPort(this.audioSourcePort(), path, fallbackName);
  }
  retryTranscribeTask(task) {
    return retryTranscribeTaskFlow(this.transcribeRetryPort(), task);
  }
  private transcribeRetryPort(): QueueTranscribeRetryPort {
    return {
      getVault: () => this.host.app.vault,
      runOnTarget: (target, operation) => this.host.continuations.runOnTarget(target, operation),
      readTaskAudio: (task) => readTaskAudioBlob(this.audioSourcePort(), task),
      describeSegmentRetryUnavailable: () => describeSegmentRetryUnavailable(this.host),
      getAudioChannelMode: () => this.host.settings.audioChannelMode,
      transcribeSegment: (blob, mime) => transcribeAudio(this.host, blob, mime),
      transcribeChannels: (blob, mime, expectedChannelCount, options) => transcribeAudioByChannels(this.host, blob, mime, expectedChannelCount, options),
      transcribeWhole: (blob, mime, options) => transcribeImportedAudio(this.host, blob, mime, options),
      logDiagnostic: (level, code, message, data) => this.host.diagnostics.logDiagnostic(level, code, message, data),
      refreshNoteIndex: (file, options) => this.host.noteIndex.refreshNoteIndexSafely(file, options),
      deleteSegmentCache: (audioPath, taskId, ephemeral) => ephemeral === undefined
        ? this.host.asrPipeline.maybeDeleteSegmentCacheFile(audioPath, taskId)
        : this.host.asrPipeline.maybeDeleteSegmentCacheFile(audioPath, taskId, ephemeral),
      insertBeforeSegmentsEnd: (mdPath, block, sessionId) => this.host.noteWriter.insertBeforeSegmentsEnd(mdPath, block, sessionId),
      confirmSpeakerNames: (session, segments) => this.host.confirmSpeakerNames(session, segments),
      getQueueTasks: () => {
        const queue = this.host.queue;
        return queue && typeof queue.snapshot === "function" ? queue.snapshot() : ((queue && queue.tasks) || []);
      },
      detectMode: (file) => this.host.noteWriter.detectModeFromMarkdown(file),
      getDefaultPolishMode: () => getEffectivePolishMode(this.host.settings, this.host.settings.polishMode),
      repolish: (file, mode) => this.host.repolish.repolishMarkdownFile(file, mode, null),
    };
  }
  migrateQueueTasksAfterRename(oldPath, newPath) {
    migrateQueueTasksAfterRenameFlow(this.taskPathPort(), oldPath, newPath);
  }
  removeQueueTasksForDeletedMarkdown(path) {
    removeQueueTasksForDeletedMarkdownFlow(this.taskPathPort(), path);
  }
  private taskPathPort(): QueueTaskPathPort {
    return {
      getQueue: () => this.host.queue,
      save: () => (this.host.saveAll || this.host.saveSettings).call(this.host),
      requestOutlineRefresh: () => this.host.requestOutlineRefresh(),
    };
  }
  async runAppendTask(task: AppendTask) {
    return runAppendTaskFlow(this.appendTaskPort(), task);
  }
  private appendTaskPort(): QueueAppendTaskPort {
    return {
      getVault: () => this.host.app.vault,
      trashFile: (file) => this.host.app.fileManager.trashFile(file),
      getFileCache: (file) => this.host.app.metadataCache.getFileCache(file),
      getQueue: () => this.host.queue,
      isRealtimeOutlineEnabled: () => !!this.host.settings.enableRealtimeOutline,
      isSessionTracked: (id) => this.host.continuations.isSessionTracked(id),
      hasActiveSessions: (target) => this.host.continuations.hasActiveSessions(target),
      runOnTarget: (target, operation) => this.host.continuations.runOnTarget(target, operation),
      discardShortRecordingNote: (session) => this.host.asrPipeline.discardShortRecordingNote(session),
      cleanupSuccessfulSegmentAudio: (session) => this.host.asrPipeline.cleanupSuccessfulSegmentAudio(session),
      patchTaskActivity: (id, patch) => this.host.tasks.patchTaskActivity(id, patch),
      queueTaskActivityId: (appendTask) => this.host.tasks.queueTaskActivityId(appendTask),
      commitContinuation: (session, polished, ids) => this.host.noteWriter.commitContinuation(session, polished, ids),
      mergeAndPolish: (segments, mode, sessionMeta, speakerFrontmatter) => mergeAndPolish(this.host, segments, mode, sessionMeta, speakerFrontmatter),
      clearCommittedBriefingCheckpoint: (meta) => clearCommittedBriefingCheckpoint(this.host, meta),
      refreshNoteIndex: (file, options) => this.host.noteIndex.refreshNoteIndexSafely(file, {
        meetingDate: options.meetingDate as string,
        reason: options.reason,
      }),
      completeRealtimeOutline: (segments, resume, mode, onProgress) =>
        this.host.outline.completeRealtimeOutlineForMergedSegments(segments, resume, mode, onProgress),
      mergeContinuationOutlineText: (base, fresh) => this.host.outline.mergeContinuationOutlineText(base, fresh),
      extractPriorOutline,
      getContinuationTargetIdentity,
      getTranscriptSegments: extractTranscriptSegments,
      getTranscriptRevision: getCurrentTranscript,
      getOutlineBlock: readCurrentOutlineBlock,
      isOutlineCoverageValid: validateRealtimeOutlineSourceCoverage,
      createOutlineCoverage: createRealtimeOutlineSourceCoverage,
      normalizeMergedSegments: normalizeSegmentsForMergedNote,
      inferStartedAt: inferNoteStartedAtIso,
      getAudioReferences: collectAudioRefs,
      getDurationMs: getSegmentsDurationMs,
      getDetailsBody: extractDetailsBody,
      getSessionKnowledge: readSessionKnowledge,
      saveVersion: (file, content, base, input) =>
        this.host.versions.saveVersion(file, content, base, input as Parameters<VersionStore["saveVersion"]>[3]),
      formatMoment: (format, input) => input === undefined ? window.moment().format(format) : window.moment(input).format(format),
    };
  }
  private mergeRetryPort(): QueueMergeRetryPort {
    return {
      getVault: () => this.host.app.vault,
      runOnTarget: (target, operation) => this.host.continuations.runOnTarget(target, operation),
      runContinuationAppend: (task) => this.runAppendTask(task as Parameters<QueueRetryService["runAppendTask"]>[0]),
      mergeAndPolish: (segments, mode, sessionMeta, speakerFrontmatter) => mergeAndPolish(this.host, segments, mode, sessionMeta, speakerFrontmatter),
      shouldRewriteConsolidated: (session) => shouldRewriteConsolidatedNote(this.host.settings, session),
      rewriteConsolidated: (session, polished) => this.host.noteWriter.rewriteConsolidated(session, polished),
      mergeLeadingFrontmatter: mergeLeadingFrontmatterIntoDocument,
      getModePrefix: (mode) => getModeMeta(this.host.settings, mode).prefix,
      clearCommittedBriefingCheckpoint: (sessionMeta) => clearCommittedBriefingCheckpoint(this.host, sessionMeta),
      renameWithGeneratedTitle: (file, polished, mode) => this.host.noteWriter.renameMarkdownWithGeneratedTitle(file, polished, mode),
      refreshNoteIndex: (file, options) => this.host.noteIndex.refreshNoteIndexSafely(file, {
        // Value remains unchanged, matching the pre-migration call.
        meetingDate: options.meetingDate as string,
        reason: options.reason,
      }),
      formatSessionStamp: (startedAt) => window.moment(startedAt).format("YYYYMMDD-HHmmss"),
      createSessionId: () => genId(),
    };
  }
  retryMergeTask(task) {
    return retryMergeTaskFlow(this.mergeRetryPort(), task);
  }
  runGeneratePromptTask(task) {
    return runGeneratePromptTaskFlow(this.promptTaskPort(), task);
  }
  private promptTaskPort(): QueuePromptTaskPort {
    return {
      generateAndApplyIndustryPrompt: (mode, options) => this.host.vocabulary.generateAndApplyIndustryPrompt(mode, options),
      getSettingTab: () => this.host.settingTab,
    };
  }
}


/**
 * 分段重试是否不可用；不可用时返回原因，可用时返回空串。
 *
 * 流式服务（dashscope 实时、OpenAI Realtime）的端点是 wss://，只能在建连时逐帧推流，
 * 不能用 HTTP 把一段音频 POST 上去。分段任务因此只对 HTTP 上传型服务有意义。
 */
export function describeSegmentRetryUnavailable(host) {
  try {
    const profile = host && host.profiles && host.profiles.getActiveTranscribeProfile
      ? host.profiles.getActiveTranscribeProfile()
      : null;
    if (profile && profile.transcribeMode === "streaming") {
      return t("The current transcription service is a streaming service ({0}), so segment-by-segment retry is unavailable — streaming services only push in real time while recording and cannot upload already-recorded segments for transcription. Switch to a segment-based or whole-file transcription service on the \"API\" page, or re-transcribe the whole recording from the session note.")
        .replace("{0}", String(profile.title || t("Live transcription")));
    }
    return "";
  } catch {
    return "";
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
