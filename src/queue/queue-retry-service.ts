/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：队列任务的失败恢复：转写重试、合并重试、提示词任务、改名与删除后的任务迁移

import * as obsidian from "obsidian";
import type { LiveAsrPipelineService } from "../asr/live-asr-pipeline-service";
import { QnALogSettingTab } from "../ui/settings-tab";
import { isKnownPolishMode, getModeMeta, getEffectivePolishMode } from "../shared/mode-meta";
import { decodeAudioBlob, renderAudioBufferSliceToWav, transcribeAudio } from "../asr/transcribe";
import { getLlmConfigIssue } from "../llm/core";
import type { PluginSettings, Segment } from "../shared/types";
import type { SessionStore } from "../session/session-store";
import { genId, formatElapsed, escapeRegExp } from "../shared/util-common";
import { diagnosticError } from "../shared/util-key-diag";
import { MAX_SPEAKER_CHANNELS, initialAudioChannelRuntimeMode, normalizeAudioChannelMode } from "../audio/channel-speakers";
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
  
import { getAudioTimeLink } from "../notes/audio-reference-text";
import { mergeLeadingFrontmatterIntoDocument } from "../notes/note-markdown";
import { ensureTranscriptBlocks } from "../notes/note-transcript-ledger";
import { getSourceIdFromMarkdown } from "../notes/note-source-metadata";
import { getQueueTasksForMarkdown } from "../recent/recent-notes";
import { RecorderService } from "../audio/recorder-service";
import { TaskQueue } from "../queue/task-queue";
import { mergeAndPolish } from "../briefing/merge-pipeline";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { NoteIndexService } from "../notes/note-index-service";
import { VocabularyService } from "../vocabulary/vocabulary-service";
import { NoteWriter } from "../notes/note-writer";
import { findNoteMarkerOffset } from "../notes/note-document";
import { nsMarker, nsRe } from "../shared/namespace";

import { t } from "../shared/i18n";
import type { AsrTranscriptResult } from "../asr/transcript-result";
import { attachTranscriptResult } from "../transcript/session-transcript";
import { readTranscriptBlocks, replaceTranscriptBlock, serializeTranscriptBlock } from "../transcript/transcript-markdown";
import { labelPattern, labelText } from "../shared/note-labels";
import type { RealtimeOutlineService } from "../notes/realtime-outline-service";
import { VersionStore } from "../versions/version-store";
import type { TaskActivityService } from "../tasks/task-activity-service";
import {
  readTaskAudioBlob,
  readVaultAudioBlob as readVaultAudioBlobFromPort,
  type TranscribeAudioSourcePort,
} from "./transcribe-audio-source";
import { migrateTaskPaths, removeTasksForDeletedPath } from "./queue-task-paths";
import { retryMergeTask as retryMergeTaskFlow, type QueueMergeRetryPort } from "./queue-merge-retry-flow";
import { QueueRetryControl } from "./queue-retry-control";
import { runAppendTask as runAppendTaskFlow, type AppendTask, type QueueAppendTaskPort } from "./queue-append-task-flow";
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
  async retryTranscribeTask(task) {
    const target = this.host.app.vault.getAbstractFileByPath(task.mdPath);
    if (!(target instanceof obsidian.TFile)) return this.retryTranscribeTaskImpl(task);
    return this.host.continuations.runOnTarget(target, () => this.retryTranscribeTaskImpl(task));
  }
  private async retryTranscribeTaskImpl(task) {
    const mdFile = this.host.app.vault.getAbstractFileByPath(task.mdPath);
    // 目录外的历史占位（中文写死、已不再新写）：只放正则字面量，供已落盘旧笔记匹配。
    const legacyFailMark = /_\[等待后台转写：[^\]]*\]_|_\[转写失败（空结果，已进入重试队列）\]_|_\[转写失败(?:（已进入重试队列）)?：[^\]]*\]_/;
    const failMark = new RegExp(
      `${labelPattern("waitingBackground").source}|${labelPattern("notFullyTranscribed").source}|${legacyFailMark.source}`,
    );
    const taskMarker = task.id ? nsMarker("transcribe-task", task.id) : "";
    const taskPattern = taskMarker
      ? new RegExp(`${escapeRegExp(taskMarker)}\\s*(?:${failMark.source})`)
      : null;
    const segmentNumber = Math.max(0, Number(task.segmentIndex) || 0) + 1;
    const segmentStart = formatElapsed(Math.max(0, Number(task.startOffsetMs) || 0));
    const segmentEnd = formatElapsed(Math.max(Number(task.startOffsetMs) || 0, Number(task.endOffsetMs) || 0));
    const legacySegmentPattern = new RegExp(
      `((?:^|\\n)###\\s+(?:段落|Segment)\\s+${segmentNumber}\\s+\\(${escapeRegExp(segmentStart)}[–-]${escapeRegExp(segmentEnd)}\\)[^\\n]*\\n(?:\\s*\\n)?(?:<!--\\s*${nsRe("transcribe-task")}:[^>]+-->\\s*)?)(?:${failMark.source})`,
    );
    const currentMarkdown = mdFile instanceof obsidian.TFile ? await this.host.app.vault.read(mdFile) : "";
    const sourceId = String(task.sessionId || (mdFile instanceof obsidian.TFile ? getSourceIdFromMarkdown(currentMarkdown, mdFile) : task.mdPath || "note"));
    const sourceSegmentIndex = Math.max(0, Number(task.segmentIndex) || 0);
    const parentSegmentId = `seg:${encodeURIComponent(sourceId)}:${sourceSegmentIndex}`;
    const existingTranscriptBlocks = readTranscriptBlocks(currentMarkdown);
    const matchingTranscriptBlocks = existingTranscriptBlocks.filter((block) => block.segment.transcript?.id === parentSegmentId);
    if (matchingTranscriptBlocks.length > 1) throw new Error(`Multiple transcript blocks match source ${parentSegmentId}`);
    const existingTranscriptBlock = matchingTranscriptBlocks[0] || null;
    if (existingTranscriptBlock && !existingTranscriptBlock.segment.error && !failMark.test(existingTranscriptBlock.visibleBlock)) {
      if (mdFile instanceof obsidian.TFile) await this.host.noteIndex.refreshNoteIndexSafely(mdFile, { reason: "transcript-retry-idempotent" });
      await this.host.asrPipeline.maybeDeleteSegmentCacheFile(task.audioPath, task.id);
      return;
    }
    if (!existingTranscriptBlock && taskMarker && currentMarkdown.includes(taskMarker) && !(taskPattern && taskPattern.test(currentMarkdown))) {
      // Upgrade a successful legacy block without repeating its paid ASR request.
      if (mdFile instanceof obsidian.TFile) {
        const migrated = await this.host.app.vault.process(mdFile, (latest) => ensureTranscriptBlocks(latest, sourceId, { reconcileEditedText: false }));
        if (migrated !== currentMarkdown) await this.host.noteIndex.refreshNoteIndexSafely(mdFile, { reason: "transcript-retry-legacy-upgrade" });
      }
      await this.host.asrPipeline.maybeDeleteSegmentCacheFile(task.audioPath, task.id);
      return;
    }
    const audio = await readTaskAudioBlob(this.audioSourcePort(), task);
    let text = "";
    let transcriptionResult: AsrTranscriptResult | null = null;
    if (!task.wholeFileImport) {
      // 分段任务只能交给 HTTP 上传型的转写服务。
      // 若当前激活的是流式服务（端点 wss://），分段上传必然失败——
      // 这类任务只可能来自「切到流式服务之前录下的音频」，或流式连接没建立起来的那次录音。
      // 与其逐段重试、每次都撞「协议不受支持」，不如一次说清：改用整场录音重转。
      const streamingIssue = describeSegmentRetryUnavailable(this.host);
      if (streamingIssue) throw new Error(streamingIssue);
    }
    if (task.wholeFileImport) {
      const result = await transcribeImportedAudio(this.host, audio.blob, audio.blob.type || "audio/wav", {
        providerId: task.providerId,
        diarization: task.speakerDiarization !== false,
        speakerCount: task.speakerCount,
        fileName: task.sourceAudioName || task.audioName || "import-audio",
      });
      transcriptionResult = result;
      text = result.text;
    } else {
      const reportedChannelCount = Math.max(1, Number(task.audioChannelCount) || 1);
      const channelMode = normalizeAudioChannelMode(task.audioChannelMode || this.host.settings.audioChannelMode);
      const runtimeChannelMode = task.audioChannelRuntimeMode
        || initialAudioChannelRuntimeMode(channelMode, reportedChannelCount);
      const inspectRecordedChannels = task.captureMode === "mic" && runtimeChannelMode !== "mono";
      const expectedChannelCount = inspectRecordedChannels
        ? MAX_SPEAKER_CHANNELS
        : reportedChannelCount;
      const channelTranscription = inspectRecordedChannels
        ? await transcribeAudioByChannels(
          this.host,
          audio.blob,
          audio.blob.type || "audio/wav",
          expectedChannelCount,
          { requireSeparatedChannels: channelMode === "auto" && runtimeChannelMode === "probing" },
        )
        : null;
      if (channelTranscription) {
        transcriptionResult = channelTranscription;
        text = channelTranscription.text;
      } else {
        transcriptionResult = await transcribeAudio(this.host, audio.blob, audio.blob.type || "audio/wav");
        text = transcriptionResult.text;
      }
    }
    if (!String(text || "").trim()) {
      // 重试仍为空 = 失败（不再替换成"暂无有效转写"并删缓存了事）：
      // 抛错让队列按失败记录 + 计重试次数，缓存音频保留，后续还能继续重试。
      await this.host.diagnostics.logDiagnostic("warn", "queue.transcribe_empty_result", t("Transcription retry returned empty text; treating it as a failure and re-queuing"), {
        mdPath: task.mdPath || "",
        audioName: task.audioName || "",
        startOffsetMs: task.startOffsetMs,
        endOffsetMs: task.endOffsetMs,
      });
      throw new Error(t("Transcription retry returned an empty result (the service responded HTTP 200 with no text)"));
    }
    if (!transcriptionResult) throw new Error(t("Transcription retry returned no structured result"));
    const segmentIndex = sourceSegmentIndex;
    const startOffsetMs = Math.max(0, Number(task.startOffsetMs) || 0);
    const endOffsetMs = Math.max(startOffsetMs, Number(task.endOffsetMs) || startOffsetMs);
    const sourceAudioName = String(task.masterAudioName || task.sourceAudioName || task.audioName || "");
    const masterAudioPath = String(task.masterAudioPath || task.sourceAudioPath || "");
    const discardClipPath = !!task.ephemeralAudio || !!audio.recovered;
    let replaced = false;
    let alreadyCommitted = false;
    let writtenSegment: Segment | null = null;
    const makeUpdatedSegment = (base: Segment | null): Segment => {
      const retainedBaseAudio = base?.audioPath && base.audioPath !== task.audioPath ? base.audioPath : "";
      const audioPath = masterAudioPath || retainedBaseAudio || (discardClipPath ? "" : base?.audioPath || task.audioPath || "");
      const segmentAudioPath = discardClipPath ? "" : base?.segmentAudioPath || task.audioPath || "";
      const segment = {
        ...(base || {}),
        index: base?.index ?? segmentIndex,
        startOffsetMs,
        endOffsetMs,
        audioStartOffsetMs: base?.audioStartOffsetMs ?? task.audioStartOffsetMs,
        audioEndOffsetMs: base?.audioEndOffsetMs ?? task.audioEndOffsetMs,
        audioName: audioPath ? (base?.audioName || sourceAudioName || task.audioName || "") : "",
        audioPath,
        segmentAudioName: segmentAudioPath ? (base?.segmentAudioName || task.audioName || "") : "",
        segmentAudioPath,
        text,
        error: null,
        isFinal: task.isFinal ?? base?.isFinal,
        source: base?.source || task.source || "recording",
        queueTaskId: task.id || base?.queueTaskId,
      };
      return attachTranscriptResult(segment, sourceId, transcriptionResult, "asr");
    };
    const makeTranscriptBlock = (segment: Segment): string => {
      const linkOffsetMs = masterAudioPath ? Math.max(0, Number(task.audioStartOffsetMs) || 0) : 0;
      const heading = [
        `### ${labelText("segment", segmentNumber)} (${formatElapsed(startOffsetMs)}–${formatElapsed(endOffsetMs)}) ${getAudioTimeLink(sourceAudioName, linkOffsetMs)}`,
        taskMarker,
      ].filter(Boolean).join("\n\n");
      return `\n${serializeTranscriptBlock(segment, heading, text)}\n`;
    };
    const findTarget = (blocks: ReturnType<typeof readTranscriptBlocks>) => {
      const matches = blocks.filter((block) => block.segment.transcript?.id === parentSegmentId
        || (!!task.id && block.segment.queueTaskId === task.id));
      if (matches.length > 1) throw new Error(`Multiple transcript blocks match source ${parentSegmentId}`);
      if (matches.length === 1 && matches[0].segment.transcript?.id !== parentSegmentId) {
        throw new Error(`Transcript task ${task.id} points to a different source ID`);
      }
      return matches[0] || null;
    };
    if (mdFile instanceof obsidian.TFile) {
      await this.host.app.vault.process(mdFile, (latest) => {
        const latestBlocks = readTranscriptBlocks(latest);
        let target = findTarget(latestBlocks);
        if (target && !target.segment.error && !failMark.test(target.visibleBlock)) {
          alreadyCommitted = true;
          return latest;
        }
        let candidate = latest;
        if (!target) {
          if (taskPattern && taskPattern.test(candidate)) {
            candidate = candidate.replace(taskPattern, () => `${taskMarker}\n${text}`);
          } else {
            const legacyMatch = legacySegmentPattern.exec(candidate);
            if (legacyMatch) {
              const prefix = legacyMatch[1];
              const addMarker = taskMarker && !prefix.includes(taskMarker) ? `${taskMarker}\n` : "";
              candidate = candidate.replace(legacySegmentPattern, () => `${prefix}${addMarker}${text}`);
            }
          }
          if (candidate !== latest) {
            candidate = ensureTranscriptBlocks(candidate, sourceId, { reconcileEditedText: false });
            target = findTarget(readTranscriptBlocks(candidate));
          }
        }
        const updated = makeUpdatedSegment(target?.segment || null);
        writtenSegment = updated;
        replaced = true;
        if (target) return replaceTranscriptBlock(candidate, target, updated, text);
        const block = makeTranscriptBlock(updated);
        const endMarker = task.sessionId ? nsMarker("segments-end", task.sessionId) : nsMarker("segments-end");
        const endAt = findNoteMarkerOffset(candidate, endMarker, "last");
        return endAt >= 0
          ? `${candidate.slice(0, endAt)}${block}${candidate.slice(endAt)}`
          : `${candidate.trimEnd()}\n\n${block.trim()}\n`;
      });
    } else {
      const recoveredSegment = makeUpdatedSegment(null);
      writtenSegment = recoveredSegment;
      await this.host.noteWriter.insertBeforeSegmentsEnd(task.mdPath, makeTranscriptBlock(recoveredSegment), task.sessionId);
      replaced = true;
    }
    if (alreadyCommitted) {
      await this.host.asrPipeline.maybeDeleteSegmentCacheFile(task.audioPath, task.id);
      if (mdFile instanceof obsidian.TFile) await this.host.noteIndex.refreshNoteIndexSafely(mdFile, { reason: "transcript-retry-idempotent" });
      return;
    }
    if (replaced && mdFile instanceof obsidian.TFile) {
      await this.host.noteIndex.refreshNoteIndexSafely(mdFile, { reason: "transcript-retry" });
    }
    if (!audio.recovered && (!task.wholeFileImport || task.ephemeralAudio)) {
      await this.host.asrPipeline.maybeDeleteSegmentCacheFile(task.audioPath, task.id, !!task.ephemeralAudio);
    }
    if (replaced && task.wholeFileImport && task.speakerDiarization !== false) {
      await this.host.confirmSpeakerNames({
        id: task.sessionId,
        mdPath: task.mdPath,
        source: "import",
        importTranscribeProviderId: task.providerId,
      }, writtenSegment ? [writtenSegment] : [{ text }]);
    }
    if (replaced) this.maybeAutoRepolishAfterTranscribeRetry(task, mdFile);
  }
  // 补转写成功后自动刷新润色正文：当本次成功的任务是该纪要最后一个待补的 transcribe 任务时，
  // 自动触发一次"重新整理"，让正文吸收补回的文字（否则正文永远停留在缺段版本，用户须手动重整理）。
  maybeAutoRepolishAfterTranscribeRetry(task, mdFile) {
    if (!(mdFile instanceof obsidian.TFile)) return;
    const mdNorm = obsidian.normalizePath(String(task.mdPath || ""));
    if (!mdNorm) return;
    const tasks = this.host.queue && typeof this.host.queue.snapshot === "function"
      ? this.host.queue.snapshot()
      : ((this.host.queue && this.host.queue.tasks) || []);
    // 当前任务成功后才会被 processOne 移除，此刻仍在队列里——按 id 排除自身；
    // 队列顺序执行，只有清掉同一笔记最后一个失败段的那次调用会看到 0 个剩余 → 天然防止重复触发。
    const remaining = tasks.filter(t => t && t.type === "transcribe" && t.id !== task.id
      && obsidian.normalizePath(String(t.mdPath || "")) === mdNorm);
    if (remaining.length) return;
    if (tasks.some(t => t && t.type === "merge" && t.continuation && t.sessionId === task.sessionId)) return;
    new obsidian.Notice(t("\"{0}\" All failed segments are transcribed; re-organizing the body...").replace("{0}", mdFile.basename), 8000);
    const mode = this.host.noteWriter.detectModeFromMarkdown(mdFile) || getEffectivePolishMode(this.host.settings, this.host.settings.polishMode);
    // fire-and-forget：不阻塞队列循环
    void (async () => {
      try {
        await this.host.repolish.repolishMarkdownFile(mdFile, mode, null);
      } catch (e) {
        try {
          await this.host.diagnostics.logDiagnostic("error", "queue.auto_repolish_failed", t("Automatic re-organization after backfilling transcription failed"), {
            mdPath: mdNorm,
            error: diagnosticError(e),
          });
        } catch { /* intentionally empty */ }
      }
    })();
  }
  // 把队列里所有指向 oldPath 的任务迁移到 newPath，并持久化。
  // 触发场景：用户/插件给纪要重命名（包括 renameMarkdownWithGeneratedTitle 自动生成的标题改名）后，
  // transcribe / merge 等待重试的任务还指向旧路径会失败报"笔记不存在"。
  migrateQueueTasksAfterRename(oldPath, newPath) {
    if (!this.host.queue || !Array.isArray(this.host.queue.tasks)) return;
    const migrated = migrateTaskPaths(this.host.queue.tasks, oldPath, newPath);
    if (migrated > 0) {
      try { void (this.host.saveAll || this.host.saveSettings).call(this.host); } catch (e) {
        console.warn("[QnALog] queue migrate save failed", e);
      }
    }
  }
  // 笔记被删时，从队列移除所有指向它的任务，避免孤儿 merge 任务反复白烧 LLM 再失败、永久卡 failed。
  removeQueueTasksForDeletedMarkdown(path) {
    if (!this.host.queue || !Array.isArray(this.host.queue.tasks)) return;
    const result = removeTasksForDeletedPath(this.host.queue.tasks, path);
    if (!result) return;
    this.host.queue.tasks = result.tasks;
    if (result.removed > 0 || result.preservedContinuation) {
      try { void (this.host.saveAll || this.host.saveSettings).call(this.host); } catch (e) {
        console.warn("[QnALog] queue delete cleanup save failed", e);
      }
      try { this.host.requestOutlineRefresh(); } catch { /* intentionally empty */ }
    }
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
  async runGeneratePromptTask(task) {
    const mode = task.mode;
    if (!mode) throw new Error(t("Missing mode"));
    const tpl = await this.host.vocabulary.generateAndApplyIndustryPrompt(mode, { activate: task.activate !== false });
    const activated = task.activate !== false;
    new obsidian.Notice(activated
      ? t("Created custom prompt \"{0}\", and it has been set as the current default.").replace("{0}", tpl.name)
      : t("Created custom prompt \"{0}\".").replace("{0}", tpl.name), 7000);
    if (this.host.settingTab) {
      try { this.host.settingTab.display(); } catch { /* intentionally empty */ }
    }
  }
  // 把"生成 Prompt"作为后台任务入队。立刻返回，UI 切走也不影响。
  async enqueueGeneratePromptTask(mode, options) {
    if (!isKnownPolishMode(this.host.settings, mode)) throw new Error("未知的 mode：" + mode);
    const p = this.host.settings.industryProfile;
    if (!p || !p.industry || !p.scenarios) throw new Error(t("Fill in \"Industry / role\" and \"Main work scenarios\" first in \"AI Organize\""));
    if (!this.host.settings.llmApiKey) throw new Error(t("Please configure an LLM service on the API page first"));
    const existing = this.host.queue.findActiveGeneratePromptTask(mode);
    if (existing) {
      const meta = getModeMeta(this.host.settings, mode);
      new obsidian.Notice(t("A generation task already exists: the custom prompt referencing \"{0}\" is already in the queue").replace("{0}", meta.prefix || mode), 5000);
      return existing;
    }
    const task = await this.host.queue.add({
      type: "generate-prompt",
      mode,
      activate: !options || options.activate !== false,
    });
    const meta = getModeMeta(this.host.settings, mode);
    new obsidian.Notice(t("Added to the background queue: generating the custom prompt that references \"{0}\" (switching pages will not interrupt it)").replace("{0}", meta.prefix || mode), 5000);
    try { this.host.recorder.emit(); } catch { /* intentionally empty */ }
    // 立刻拉起队列处理（不 await，让调用方立刻返回）
    this.host.queue.processAll()
      .catch((e) => console.error("[QnALog] queue processAll", e))
      .finally(() => { try { this.host.recorder.emit(); } catch { /* intentionally empty */ } });
    return task;
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
