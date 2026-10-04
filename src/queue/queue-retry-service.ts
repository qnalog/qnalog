/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：队列任务的失败恢复：转写重试、合并重试、提示词任务、改名与删除后的任务迁移

import * as obsidian from "obsidian";
import type { LiveAsrPipelineService } from "../asr/live-asr-pipeline-service";
import { QnALogSettingTab } from "../ui/settings-tab";
import { isKnownPolishMode, getModeMeta, getEffectivePolishMode } from "../shared/mode-meta";
import { decodeAudioBlob, renderAudioBufferSliceToWav, transcribeAudio } from "../asr/transcribe";
import { getLlmConfigIssue, formatLlmConfigIssue } from "../llm/core";
import { isLlmServiceBlockedError } from "../llm/failure-policy";
import type { MergeQueueTaskPayload, PluginSettings, QueueTaskDeferred, RecordingSession, RealtimeOutlineSourceCoverage, Segment } from "../shared/types";
import type { SessionStore } from "../session/session-store";
import { AUDIO_EXT } from "../shared/catalog-import";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { genId, formatElapsed, escapeRegExp } from "../shared/util-common";
import { mimeFromExt, isAsrTransportError } from "../shared/util-audio";
import { LIVE_ASR_TASK_STATUS } from "../asr/live-segment-policy";
import { diagnosticError } from "../shared/util-key-diag";
import { MAX_SPEAKER_CHANNELS, initialAudioChannelRuntimeMode, normalizeAudioChannelMode } from "../audio/channel-speakers";
import { renderMultichannelAudioBufferSliceToWav, transcribeAudioByChannels } from "../asr/channel-transcription";
import { transcribeImportedAudio } from "../asr/long-audio-transcription";
import { shouldRewriteConsolidatedNote } from "../briefing/note-layout-policy";
import { clearCommittedBriefingCheckpoint } from "../prompts/briefing-prompts";
import { collectAudioRefs, getAudioTimeLink, getSegmentsDurationMs } from "../notes/audio-refs";
import { extractDetailsBody } from "../notes/detail-blocks";
import { readCurrentOutlineBlock } from "../notes/outline-storage";
import { validateRealtimeOutlineSourceCoverage, createRealtimeOutlineSourceCoverage } from "../notes/outline-coverage";
import { stableHash } from "../shared/stable-hash";
import { ensureTranscriptBlocks, extractTranscriptSegments, getSourceIdFromMarkdown, inferNoteStartedAtIso, mergeLeadingFrontmatterIntoDocument, normalizeSegmentsForMergedNote } from "../notes/note-markdown";
import { getQueueTasksForMarkdown } from "../recent/recent-notes";
import { RecorderService } from "../audio/recorder-service";
import { TaskQueue } from "../queue/task-queue";
import { mergeAndPolish } from "../briefing/merge-pipeline";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { NoteIndexService } from "../notes/note-index-service";
import { VocabularyService } from "../vocabulary/vocabulary-service";
import { NoteWriter } from "../notes/note-writer";
import { findNoteMarkerOffset } from "../notes/note-document";
import { NS_AUDIO_ALT, NS_CONTINUATION_COMMITTED_MARKER, nsMarker, nsRe } from "../shared/namespace";

import { t } from "../shared/i18n";
import { readSessionKnowledge } from "../briefing/session-knowledge";
import type { AsrTranscriptResult } from "../asr/transcript-result";
import { attachTranscriptResult, getCurrentTranscript } from "../transcript/session-transcript";
import { readTranscriptBlocks, replaceTranscriptBlock, serializeTranscriptBlock } from "../transcript/transcript-markdown";
import { labelPattern, labelText } from "../shared/note-labels";
import { extractPriorOutline, getContinuationTargetIdentity, type ContinuationService } from "../session/continuation-service";
import type { RealtimeOutlineService } from "../notes/realtime-outline-service";
import { VersionStore } from "../versions/version-store";
import type { TaskActivityService } from "../tasks/task-activity-service";
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
  declare _taskQueueRetryTimer;
  declare _taskQueueRetryAt;

  constructor(host: QueueRetryHost) {
    this.host = host;
    this._taskQueueRetryTimer = null;
    this._taskQueueRetryAt = 0;
  }

  /** 卸载时取消已排定的队列重试；由插件在 onunload 中调用。 */
  dispose() {
    try { if (this._taskQueueRetryTimer) window.clearTimeout(this._taskQueueRetryTimer); } catch { /* intentionally empty */ }
    this._taskQueueRetryTimer = null;
    this._taskQueueRetryAt = 0;
  }

  scheduleTaskQueueRetry(delayMs = 1500, reason = "scheduled") {
    const delay = Math.max(1000, Number(delayMs) || 0);
    const runAt = Date.now() + delay;
    if (this._taskQueueRetryTimer && Number(this._taskQueueRetryAt) <= runAt) return;
    if (this._taskQueueRetryTimer) window.clearTimeout(this._taskQueueRetryTimer);
    this._taskQueueRetryAt = runAt;
    this._taskQueueRetryTimer = window.setTimeout(() => {
      this._taskQueueRetryTimer = null;
      this._taskQueueRetryAt = 0;
      const session = this.host.sessionStore.get();
      const recorderBusy = this.host.recorder && this.host.recorder.state !== "idle";
      const segmentBusy = session && Number(session.activeSegmentJobs || 0) > 0;
      const queueBusy = this.host.queue && this.host.queue.running;
      if (recorderBusy || segmentBusy || queueBusy) {
        this.scheduleTaskQueueRetry(30 * 1000, "activity-still-busy");
        return;
      }
      void this.host.diagnostics.logDiagnostic("info", "queue.scheduled_retry_started", t("Starting the scheduled background retry"), {
        reason,
        taskCount: this.host.queue && Array.isArray(this.host.queue.tasks) ? this.host.queue.tasks.length : 0,
      });
      void this.host.queue.processAll().catch((e) => console.error("[QnALog] scheduled queue retry failed", e));
    }, delay);
  }
  scheduleDeferredAsrRetry(session) {
    if (!session || !session.hasDeferredAsrJobs) return;
    const serviceCircuit = this.host.asrPipeline.getAsrServiceCircuitState();
    const openUntilMs = Math.max(
      0,
      Number(session.asrCircuitState && session.asrCircuitState.openUntilMs) || 0,
      Number(serviceCircuit && serviceCircuit.openUntilMs) || 0,
    );
    const delayMs = Math.max(1500, openUntilMs > Date.now() ? openUntilMs - Date.now() + 1000 : 0);
    this.scheduleTaskQueueRetry(delayMs, "session-deferred-asr");
  }
  async retryQueue() {
    if (!this.host.queue.tasks.length) {
      new obsidian.Notice(this.host.queue.recoveryEntries().length
        ? t("Recovery is paused. The original queue data and its material references are kept. Update QnALog for an unsupported task type; for damaged task data, keep a backup and use View log to share a diagnostic report with the maintainer. Related tasks stay paused until recovery data is repaired.")
        : t("Queue is empty"));
      return;
    }
    const blockedMergeTasks = this.host.queue.tasks.filter((task) => task && task.type === "merge" && task.status === "blocked");
    if (blockedMergeTasks.length) {
      const llmIssue = getLlmConfigIssue(this.host.settings);
      if (llmIssue) {
        new obsidian.Notice(`${t("There are ")}${blockedMergeTasks.length}${t(" organizing tasks need configuration: ")}${formatLlmConfigIssue(llmIssue)}`, 9000);
      } else {
        const serviceBlocked = blockedMergeTasks.find((task) => isLlmServiceBlockedError(task.lastError || ""));
        for (const task of blockedMergeTasks) {
          task.status = "pending";
          task.lastError = "";
          task.updatedAt = new Date().toISOString();
        }
        await this.host.saveAll();
        new obsidian.Notice(serviceBlocked
          ? t("Restored {0} paused organizing tasks; retrying the LLM service").replace("{0}", String(blockedMergeTasks.length))
          : t("Restored {0} organizing tasks that need configuration").replace("{0}", String(blockedMergeTasks.length)));
      }
    }
    // 与 processAll 的实际可处理集对齐（排除 running/missing/blocked 和已达重试上限），避免"重试 N…剩余 N"误导。
    // missing 任务(临时切片丢失)不在自动批量里，仍可在队列面板逐条重试触发切片恢复。
    const maxR = this.host.settings.maxRetries || 3;
    const runnable = this.host.queue.tasks.filter((task) => task
      && task.status !== "blocked" && task.status !== "missing" && task.status !== "running" && task.status !== LIVE_ASR_TASK_STATUS
      && ((Number(task.retries) || 0) < maxR || (task.type === "transcribe" && isAsrTransportError(task.lastError || ""))));
    if (!runnable.length) {
      const missingN = this.host.queue.tasks.filter((t) => t && t.status === "missing").length;
      const exhaustedN = this.host.queue.tasks.filter((t) => t && t.status === "failed" && (Number(t.retries) || 0) >= maxR).length;
      const hints = [];
      if (missingN) hints.push(t("{0} temporary clips missing").replace("{0}", String(missingN)));
      if (exhaustedN) hints.push(t("{0} have reached the retry limit — if the configuration is fixed (e.g. API key added or transcription service switched), right-click the note and choose \"Retry failed transcription\", or retry them one by one in the queue panel").replace("{0}", String(exhaustedN)));
      new obsidian.Notice(hints.length ? t("No tasks can be retried automatically ({0})").replace("{0}", hints.join(t(";"))) : t("No tasks can be retried automatically"), hints.length ? 9000 : 4000);
      return;
    }
    if (runnable.some((task) => task.type === "transcribe")) {
      this.host.asrPipeline.resetAsrServiceCircuitForManualRetry("retry-all");
      for (const task of runnable) {
        if (task.type === "transcribe") task.nextRetryAt = undefined;
      }
      await this.host.saveAll();
    }
    new obsidian.Notice(`${t("Retry ")}${runnable.length}${t(" tasks...")}`);
    await this.host.queue.processAll();
    new obsidian.Notice(`${t("Remaining ")}${this.host.queue.tasks.length}${t(" tasks")}`);
  }
  async retryTranscribeTasksForMarkdown(file) {
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") return;
    const tasks = getQueueTasksForMarkdown(this.host, file, { types: ["transcribe"] })
      .filter((task) => ["failed", "missing", "pending"].includes(task.status || "pending") && !!task.lastError);
    if (!tasks.length) {
      new obsidian.Notice(t("This note currently has no transcription tasks to retry."), 5000);
      return;
    }
    new obsidian.Notice(`${t("QnALog: retrying ")}${tasks.length}${t(" transcript segments...")}`);
    let ok = 0;
    let failed = 0;
    let paused = false;
    const batch = tasks.slice();
    // 批量游标喂状态栏：重新转写逐段 done/total 实时可见（之前直接 for 循环没设游标 → 状态栏黑盒）。
    this.host.queue._batchTotal = batch.length;
    this.host.queue._batchDone = 0;
    this.host.notifyTaskBusyChanged();
    this.host.asrPipeline.resetAsrServiceCircuitForManualRetry("note-retry");
    try {
      for (const task of batch) {
        if (this.host.asrPipeline.isAsrServiceCircuitOpen()) break;
        try {
          await this.host.queue.processOne(task);
          ok++;
        } catch (e) {
          failed++;
          console.error("[QnALog] retry transcribe task from note list failed", e);
          if (isAsrTransportError(e)) {
            this.scheduleTaskQueueRetry(this.host.asrPipeline.getAsrServiceRetryDelayMs(), "note-retry-transport-failure");
            paused = true;
          }
        }
        this.host.queue._batchDone++;
        this.host.notifyTaskBusyChanged();
        if (paused) break;
      }
    } finally {
      this.host.queue._batchTotal = 0;
      this.host.queue._batchDone = 0;
      this.host.notifyTaskBusyChanged();
    }
    await this.host.saveAll();
    this.host.requestOutlineRefresh();
    new obsidian.Notice(paused
      ? t("Transcription service is still unavailable: {0} succeeded and {1} failed this round; the remaining segments are kept and will continue later").replace("{0}", String(ok)).replace("{1}", String(failed))
      : failed
        ? t("Transcription retry finished: {0} succeeded, {1} failed").replace("{0}", String(ok)).replace("{1}", String(failed))
        : t("Transcription retry finished: {0} succeeded").replace("{0}", String(ok)), 8000);
  }
  async readTranscribeTaskAudioBlob(task) {
    const direct = await this.readVaultAudioBlob(task.audioPath, task.audioName);
    if (direct) return direct;

    const recovered = await this.recoverTranscribeTaskAudioBlob(task);
    if (recovered) {
      await this.host.diagnostics.logDiagnostic("warn", "queue.transcribe_audio_recovered", t("Transcription retry recovered a temporary clip from the full recording"), {
        audioName: task.audioName || "",
        sourceAudioName: recovered.sourceName || "",
        startOffsetMs: task.startOffsetMs,
        endOffsetMs: task.endOffsetMs,
      });
      return recovered;
    }

    throw new Error(t("Audio missing: {0}").replace("{0}", String(task.audioPath || task.audioName || t("Unknown audio"))));
  }
  async readVaultAudioBlob(path, fallbackName) {
    const norm = obsidian.normalizePath(String(path || ""));
    if (!norm) return null;
    const file = this.host.app.vault.getAbstractFileByPath(norm);
    let ab = null;
    let sourceName = String(fallbackName || norm.split("/").pop() || "");
    let sourcePath = norm;
    let ext = String(sourceName.split(".").pop() || "").toLowerCase();
    if (file instanceof obsidian.TFile) {
      ab = await this.host.app.vault.readBinary(file);
      sourceName = file.name;
      sourcePath = file.path;
      ext = (file.extension || ext).toLowerCase();
    } else {
      // .cache 等点目录可能不会进入 Vault 的 TFile 索引，但 adapter 仍可稳定读写。
      const adapter = this.host.app.vault.adapter;
      if (!adapter || !(await adapter.exists(norm))) return null;
      ab = await adapter.readBinary(norm);
    }
    return {
      blob: new Blob([ab], { type: mimeFromExt(ext) }),
      sourcePath,
      sourceName,
      recovered: false,
    };
  }
  resolveTranscribeRetrySourceFile(task) {
    const candidates = [];
    const push = (path) => {
      const norm = obsidian.normalizePath(String(path || "").trim());
      if (norm && !candidates.includes(norm)) candidates.push(norm);
    };

    push(task.sourceAudioPath);
    push(task.masterAudioPath);

    const audioName = String(task.audioName || (task.audioPath || "").split("/").pop() || "");
    const match = audioName.match(new RegExp(`^(${NS_AUDIO_ALT}-\\d{8}-\\d{6})-seg\\d+\\.(\\w+)$`, "i"));
    if (match) {
      const folder = obsidian.normalizePath(this.host.settings.audioFolder || DEFAULT_SETTINGS.audioFolder || "");
      const stem = match[1];
      const ext = match[2] || "m4a";
      for (const candidateExt of Array.from(new Set([ext, "m4a", "mp4", "webm", "wav"]))) {
        push(folder ? `${folder}/${stem}.${candidateExt}` : `${stem}.${candidateExt}`);
      }
    }

    for (const path of candidates) {
      const file = this.host.app.vault.getAbstractFileByPath(path);
      if (file instanceof obsidian.TFile && AUDIO_EXT.has(String(file.extension || "").toLowerCase())) return file;
    }

    if (match) {
      const stem = match[1];
      const folder = obsidian.normalizePath(this.host.settings.audioFolder || DEFAULT_SETTINGS.audioFolder || "");
      const files = this.host.app.vault.getFiles ? this.host.app.vault.getFiles() : [];
      return files.find(file => file instanceof obsidian.TFile
        && AUDIO_EXT.has(String(file.extension || "").toLowerCase())
        && file.basename === stem
        && (!folder || obsidian.normalizePath(file.path).startsWith(folder + "/"))) || null;
    }

    return null;
  }
  async recoverTranscribeTaskAudioBlob(task) {
    const start = Number.isFinite(Number(task.audioStartOffsetMs)) ? Number(task.audioStartOffsetMs) : Number(task.startOffsetMs);
    const end = Number.isFinite(Number(task.audioEndOffsetMs)) ? Number(task.audioEndOffsetMs) : Number(task.endOffsetMs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

    const sourceFile = this.resolveTranscribeRetrySourceFile(task);
    if (!(sourceFile instanceof obsidian.TFile)) return null;

    const source = await this.readVaultAudioBlob(sourceFile.path, sourceFile.name);
    if (!source || !source.blob) return null;
    try {
      const audioBuffer = await decodeAudioBlob(source.blob);
      const reportedChannelCount = Math.max(1, Number(task.audioChannelCount) || 1);
      const channelMode = normalizeAudioChannelMode(task.audioChannelMode || this.host.settings.audioChannelMode);
      const runtimeChannelMode = task.audioChannelRuntimeMode
        || initialAudioChannelRuntimeMode(channelMode, reportedChannelCount);
      const inspectRecordedChannels = task.captureMode === "mic" && runtimeChannelMode !== "mono";
      const requestedChannelCount = inspectRecordedChannels ? MAX_SPEAKER_CHANNELS : 1;
      const sliceBlob = requestedChannelCount > 1
        ? renderMultichannelAudioBufferSliceToWav(audioBuffer, start, end, requestedChannelCount)
        : await renderAudioBufferSliceToWav(audioBuffer, start, end);
      return {
        blob: sliceBlob,
        sourcePath: sourceFile.path,
        sourceName: sourceFile.name,
        recovered: true,
      };
    } catch (e) {
      throw new Error(t("Temporary clip missing; the full recording was found but cannot be re-sliced: {0}").replace("{0}", String((e && e.message) || e)));
    }
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
    const audio = await this.readTranscribeTaskAudioBlob(task);
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
    const oldNorm = obsidian.normalizePath(String(oldPath || ""));
    const newNorm = obsidian.normalizePath(String(newPath || ""));
    if (!oldNorm || !newNorm || oldNorm === newNorm) return;
    let migrated = 0;
    for (const task of this.host.queue.tasks) {
      if (!task) continue;
      if (task.mdPath && obsidian.normalizePath(task.mdPath) === oldNorm) {
        task.mdPath = newNorm;
        migrated++;
      }
      const temporarySourcePath = task.type === "generate-prompt" ? "" : task.temporarySourcePath;
      if ((task.type === "merge" || task.type === "transcribe")
        && temporarySourcePath && obsidian.normalizePath(temporarySourcePath) === oldNorm) {
        task.temporarySourcePath = newNorm;
        migrated++;
      }
      if (task.type === "merge" && task.continuation
        && obsidian.normalizePath(task.continuation.targetPath) === oldNorm) {
        task.continuation.targetPath = newNorm;
        migrated++;
      }
      if ("sourceMdPath" in task && typeof task.sourceMdPath === "string" && obsidian.normalizePath(task.sourceMdPath) === oldNorm) {
        task.sourceMdPath = newNorm;
      }
    }
    if (migrated > 0) {
      try { void (this.host.saveAll || this.host.saveSettings).call(this.host); } catch (e) {
        console.warn("[QnALog] queue migrate save failed", e);
      }
    }
  }
  // 笔记被删时，从队列移除所有指向它的任务，避免孤儿 merge 任务反复白烧 LLM 再失败、永久卡 failed。
  removeQueueTasksForDeletedMarkdown(path) {
    if (!this.host.queue || !Array.isArray(this.host.queue.tasks)) return;
    const norm = obsidian.normalizePath(String(path || ""));
    if (!norm) return;
    const before = this.host.queue.tasks.length;
    let preservedContinuation = false;
    this.host.queue.tasks = this.host.queue.tasks.filter((task) => {
      if (!task) return false;
      const continuation = task.type === "merge" ? task.continuation : undefined;
      const temporarySourcePath = task.type === "generate-prompt" ? "" : task.temporarySourcePath;
      const referencesPath = (task.mdPath && obsidian.normalizePath(task.mdPath) === norm)
        || (temporarySourcePath && obsidian.normalizePath(temporarySourcePath) === norm)
        || (continuation && obsidian.normalizePath(continuation.targetPath) === norm);
      const continuationTask = task.type === "merge" && !!continuation;
      if (continuationTask && referencesPath) {
        task.status = "missing";
        task.lastError = t("The target or separate recording file was deleted; the remaining recovery material was kept.");
        preservedContinuation = true;
        return true;
      }
      return !referencesPath;
    });
    const removed = before - this.host.queue.tasks.length;
    if (removed > 0 || preservedContinuation) {
      try { void (this.host.saveAll || this.host.saveSettings).call(this.host); } catch (e) {
        console.warn("[QnALog] queue delete cleanup save failed", e);
      }
      try { this.host.requestOutlineRefresh(); } catch { /* intentionally empty */ }
    }
  }
  async runAppendTask(task: MergeQueueTaskPayload & { id: string; status: string; dependsOnSessionIds?: string[]; temporarySourcePath?: string }) {
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
      if (this.host.continuations.isSessionTracked(task.sessionId)) {
        return { deferred: true, reason: t("Recording saved; waiting to merge into the target note.") } satisfies QueueTaskDeferred;
      }
      const stagePath = String(task.temporarySourcePath || task.mdPath || "");
      const normalizedStagePath = obsidian.normalizePath(stagePath);
      if (!normalizedStagePath || normalizedStagePath === obsidian.normalizePath(context.targetPath)) return cleanupBlocked();
      const stageFile = this.host.app.vault.getAbstractFileByPath(stagePath);
      if (stageFile instanceof obsidian.TFolder) return cleanupBlocked();
      if (stageFile instanceof obsidian.TFile) {
        await this.host.asrPipeline.discardShortRecordingNote({ id: task.sessionId, mdPath: stageFile.path });
      }
      return;
    }
    const target = this.host.app.vault.getAbstractFileByPath(context.targetPath);
    if (!(target instanceof obsidian.TFile)) {
      return { deferred: true, status: "missing", reason: t("The target note is missing; the separately recorded audio was kept.") } satisfies QueueTaskDeferred;
    }
    if (this.host.continuations.isSessionTracked(task.sessionId)) {
      return { deferred: true, reason: t("Recording saved; waiting to merge into the target note.") } satisfies QueueTaskDeferred;
    }
    const retained = this.host.queue?.recoveryEntries() || [];
    const activeDependencies = (task.dependsOnSessionIds || []).filter(id =>
      this.host.continuations.isSessionTracked(id)
      || this.host.queue?.tasks.some(candidate => candidate.type !== "generate-prompt" && candidate.sessionId === id)
      || retained.some(entry => entry.taskType !== "generate-prompt" && entry.sessionId === id),
    );
    if (activeDependencies.length) {
      return { deferred: true, reason: t("Recording saved; waiting to merge into the target note.") } satisfies QueueTaskDeferred;
    }
    if (this.host.queue?.tasks.some(candidate => candidate.type === "transcribe" && candidate.sessionId === task.sessionId)
      || retained.some(entry => entry.taskType !== "generate-prompt" && entry.sessionId === task.sessionId)) {
      return { deferred: true, reason: t("Recording saved; waiting to merge into the target note.") } satisfies QueueTaskDeferred;
    }
    return this.host.continuations.runOnTarget(target, async () => {
      const reloadedTarget = this.host.app.vault.getAbstractFileByPath(target.path);
      if (!(reloadedTarget instanceof obsidian.TFile)) {
        return { deferred: true, status: "missing", reason: t("The target note is missing; the separately recorded audio was kept.") } satisfies QueueTaskDeferred;
      }
      if (this.host.continuations.hasActiveSessions(target)) {
        return { deferred: true, reason: t("Recording saved; waiting to merge into the target note.") } satisfies QueueTaskDeferred;
      }
      const targetMarkdown = await this.host.app.vault.read(reloadedTarget);
      if (getContinuationTargetIdentity(targetMarkdown, reloadedTarget) !== context.targetSourceId) {
        return { deferred: true, status: "blocked", reason: t("The target note identity changed; the separately recorded audio was kept.") } satisfies QueueTaskDeferred;
      }
      const committedMarker = nsMarker(NS_CONTINUATION_COMMITTED_MARKER, task.sessionId);
      if (targetMarkdown.includes(committedMarker)) {
        const committedSegments = Array.isArray(task.segments) ? task.segments : [];
        if (!committedSegments.length) {
          return { deferred: true, status: "blocked", reason: t("A committed continuation has no saved transcript ledger; recovery material was kept.") } satisfies QueueTaskDeferred;
        }
        this.host.tasks.patchTaskActivity(this.host.tasks.queueTaskActivityId(task), {
          status: "running",
          stage: "write-note",
          stageLabel: t("Write to Minutes"),
          progress: 88,
          detail: t("Writing the organized result to Obsidian"),
          error: "",
          completedAt: 0,
        });
        await this.host.noteWriter.commitContinuation({
          id: task.sessionId,
          sessionStamp: window.moment(context.recordedAt).format("YYYYMMDD-HHmmss"),
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
          await clearCommittedBriefingCheckpoint(this.host, recoveryMeta);
        }
        await this.host.noteIndex.refreshNoteIndexSafely(reloadedTarget, {
          meetingDate: context.recordedAt,
          reason: "continuation-merge-recovery",
        });
        await this.host.asrPipeline.cleanupSuccessfulSegmentAudio({
          id: task.sessionId,
          segments: committedSegments,
          masterAudioPath: context.masterAudioPath || "",
          masterAudioName: context.masterAudioName || "",
        });
        const committedStage = this.host.app.vault.getAbstractFileByPath(String(task.temporarySourcePath || task.mdPath || ""));
        if (committedStage instanceof obsidian.TFile) await this.host.app.fileManager.trashFile(committedStage);
        return;
      }
      const stagePath = String(task.temporarySourcePath || task.mdPath || "");
      const stageFile = this.host.app.vault.getAbstractFileByPath(stagePath);
      if (!(stageFile instanceof obsidian.TFile)) {
        return { deferred: true, status: "missing", reason: t("The separate recording file is missing; the target was not changed.") } satisfies QueueTaskDeferred;
      }
      const stageMarkdown = await this.host.app.vault.read(stageFile);
      const fresh = extractTranscriptSegments(stageMarkdown);
      if (!fresh.length) {
        return { deferred: true, status: "missing", reason: t("The separate recording has no complete transcript yet; its audio was kept.") } satisfies QueueTaskDeferred;
      }
      if (fresh.some(segment => !segment.transcript || segment.transcript.sourceId !== task.sessionId)) {
        return { deferred: true, status: "blocked", reason: t("The separate recording transcript identity is invalid; its audio was kept.") } satisfies QueueTaskDeferred;
      }
      const targetSegments = extractTranscriptSegments(targetMarkdown);
      const freshIds = new Set(fresh.map(segment => segment.transcript?.sourceId).filter(Boolean));
      const freshBlockIds = new Set(fresh.map(segment => segment.transcript?.id).filter(Boolean));
      const existingFresh = targetSegments.filter(segment => freshBlockIds.has(segment.transcript?.id || ""));
      for (const segment of fresh) {
        const existing = existingFresh.filter(candidate => candidate.transcript?.id === segment.transcript?.id);
        const incomingRevision = segment.transcript ? getCurrentTranscript(segment.transcript) : null;
        const existingRevision = existing[0]?.transcript ? getCurrentTranscript(existing[0].transcript) : null;
        if (existing.length > 1 || (existing.length === 1
          && (!incomingRevision || !existingRevision
            || existing[0].transcript?.sourceId !== segment.transcript?.sourceId
            || existingRevision.revision !== incomingRevision.revision
            || existingRevision.normalizationRevision !== incomingRevision.normalizationRevision))) {
          return { deferred: true, status: "blocked", reason: t("A transcript source conflicts with the target note; the separate recording was kept.") } satisfies QueueTaskDeferred;
        }
      }
      const base = targetSegments.filter(segment => !freshIds.has(segment.transcript?.sourceId || ""));
      const durationMs = getSegmentsDurationMs(base);
      const normalizedBatch = normalizeSegmentsForMergedNote(fresh, durationMs, base.length, stageFile);
      const normalizedFresh = fresh.map((segment, index) => {
        const existing = existingFresh.find(candidate => candidate.transcript?.id === segment.transcript?.id);
        const normalized = existing || normalizedBatch[index];
        return { ...normalized, index: base.length + index };
      });
      const mergedSegments = [...base, ...normalizedFresh];
      let outlineText = "";
      let outlineCoverage: RealtimeOutlineSourceCoverage | undefined;
      let outlineCommittedCount = 0;
      if (validateRealtimeOutlineSourceCoverage(context.realtimeOutlineSourceCoverage, context.realtimeOutline || "", mergedSegments)) {
        outlineText = context.realtimeOutline || "";
        outlineCoverage = context.realtimeOutlineSourceCoverage;
        outlineCommittedCount = context.realtimeOutlineSegmentCount || 0;
      } else {
        const currentOutline = readCurrentOutlineBlock(targetMarkdown);
        const targetOutline = extractPriorOutline(targetMarkdown);
        const targetProof = currentOutline?.sourceCoverage;
        if (targetProof && validateRealtimeOutlineSourceCoverage(targetProof, targetOutline, base)) {
          const baseCommittedCount = targetProof.committedSegmentCount;
          const freshProofValid = validateRealtimeOutlineSourceCoverage(
            context.realtimeOutlineSourceCoverage,
            context.realtimeOutline || "",
            fresh,
          );
          const freshIsComplete = freshProofValid
            && context.realtimeOutlineSegmentCount === fresh.length
            && stableHash(targetOutline) === context.priorOutlineHash;
          if (baseCommittedCount === base.length && freshIsComplete && context.realtimeOutline) {
            outlineText = this.host.outline.mergeContinuationOutlineText(targetOutline, context.realtimeOutline);
            outlineCommittedCount = mergedSegments.length;
            outlineCoverage = createRealtimeOutlineSourceCoverage(outlineText, mergedSegments, outlineCommittedCount);
          } else {
            outlineText = targetOutline;
            outlineCommittedCount = baseCommittedCount;
            outlineCoverage = createRealtimeOutlineSourceCoverage(outlineText, mergedSegments, outlineCommittedCount);
          }
        }
      }
      const outlineEnabled = !!this.host.settings.enableRealtimeOutline;
      if (outlineEnabled && this.host.queue) {
        context.realtimeOutline = outlineText;
        context.realtimeOutlineSegmentCount = outlineCommittedCount;
        context.realtimeOutlineSourceCoverage = outlineCoverage;
        await this.host.queue.update(task.id, { continuation: context, segments: normalizedFresh });
      }
      const completedOutline = await this.host.outline.completeRealtimeOutlineForMergedSegments(
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
          if (this.host.queue) await this.host.queue.update(task.id, { continuation: context, segments: normalizedFresh });
        },
      );
      if (completedOutline) {
        outlineText = completedOutline.outline;
        outlineCoverage = completedOutline.sourceCoverage;
        outlineCommittedCount = outlineCoverage.committedSegmentCount;
        context.realtimeOutline = outlineText;
        context.realtimeOutlineSegmentCount = outlineCommittedCount;
        context.realtimeOutlineSourceCoverage = outlineCoverage;
        if (this.host.queue) await this.host.queue.update(task.id, { continuation: context, segments: normalizedFresh });
      }
      task.segments = normalizedFresh;
      if (this.host.queue) await this.host.queue.update(task.id, { segments: normalizedFresh });
      const metadata = this.host.app.metadataCache.getFileCache(reloadedTarget);
      const startedAt = inferNoteStartedAtIso(reloadedTarget, metadata?.frontmatter || {});
      const savedSessionMeta = task.sessionMeta && typeof task.sessionMeta === "object" && !Array.isArray(task.sessionMeta)
        ? task.sessionMeta as Record<string, unknown>
        : {};
      const sessionMeta: Record<string, unknown> = Object.assign({}, savedSessionMeta, {
        startedAt,
        duration: formatElapsed(getSegmentsDurationMs(mergedSegments)),
        _previousKnowledge: readSessionKnowledge(targetMarkdown),
      });
      const writeSession: RecordingSession = {
        id: task.sessionId,
        sessionStamp: window.moment(context.recordedAt).format("YYYYMMDD-HHmmss"),
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
        continuationPriorOutline: extractPriorOutline(targetMarkdown),
        continuationPriorAudioNames: collectAudioRefs(targetMarkdown),
        continuationPriorRecordingInfo: extractDetailsBody(targetMarkdown, labelPattern("recordingInfo")),
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
      sessionMeta._taskActivityId = this.host.tasks.queueTaskActivityId(task);
      let polished: string;
      try {
        polished = await mergeAndPolish(this.host, mergedSegments, task.mode, sessionMeta, task.speakerFrontmatter || null);
      } catch (error) {
        task.sessionMeta = persistedSessionMeta();
        if (this.host.queue) await this.host.queue.update(task.id, { sessionMeta: task.sessionMeta });
        throw error;
      }
      if (!polished) throw new Error(t("Merge returned an empty result"));
      task.sessionMeta = persistedSessionMeta();
      if (this.host.queue) await this.host.queue.update(task.id, { sessionMeta: task.sessionMeta });
      try {
        await this.host.versions.saveVersion(reloadedTarget, targetMarkdown, base, {
          kind: "pre-append", label: t("Before append") + " " + window.moment().format("YYYY-MM-DD HH:mm"),
          mode: task.mode, idLabel: `pre-append-${window.moment().format("YYYYMMDD-HHmmss")}`,
          body: targetMarkdown, activate: false,
        });
      } catch (error) {
        console.warn("[QnALog] pre-append version archive failed", error);
      }
      this.host.tasks.patchTaskActivity(this.host.tasks.queueTaskActivityId(task), {
        status: "running",
        stage: "write-note",
        stageLabel: t("Write to Minutes"),
        progress: 88,
        detail: t("Writing the organized result to Obsidian"),
        error: "",
        completedAt: 0,
      });
      await this.host.noteWriter.commitContinuation(writeSession, polished, []);
      if (sessionMeta._briefingCheckpointId) await clearCommittedBriefingCheckpoint(this.host, sessionMeta);
      await this.host.noteIndex.refreshNoteIndexSafely(reloadedTarget, { meetingDate: startedAt, reason: "continuation-merge" });
      await this.host.asrPipeline.cleanupSuccessfulSegmentAudio(writeSession);
      await this.host.app.fileManager.trashFile(stageFile);
      return;
    });
  }
  async retryMergeTask(task) {
    if (task.continuation) return this.runAppendTask(task);
    const target = this.host.app.vault.getAbstractFileByPath(task.mdPath);
    if (!(target instanceof obsidian.TFile)) throw new Error(t("Note not found: {0}").replace("{0}", String(task.mdPath)));
    return this.host.continuations.runOnTarget(target, () => this.retryMergeTaskImpl(task));
  }
  private async retryMergeTaskImpl(task) {
    const file = this.host.app.vault.getAbstractFileByPath(task.mdPath);
    if (!(file instanceof obsidian.TFile)) throw new Error(t("Note not found: {0}").replace("{0}", String(task.mdPath)));
    const currentMarkdown = await this.host.app.vault.read(file);
    const sessionMeta = Object.assign({}, task.sessionMeta || {}, {
      _previousKnowledge: readSessionKnowledge(currentMarkdown),
    });
    const polished = await mergeAndPolish(
      this.host,
      task.segments || [],
      task.mode,
      sessionMeta,
      task.speakerFrontmatter || null,
    );
    if (!polished) throw new Error(t("Merge returned an empty result"));
    const retryStartedAt = (sessionMeta && sessionMeta.startedAt) || task.createdAt || new Date().toISOString();
    const retrySession = {
      id: task.sessionId || genId(),
      sessionStamp: window.moment(retryStartedAt).format("YYYYMMDD-HHmmss"),
      mdPath: file.path,
      mode: task.mode,
      startedAt: retryStartedAt,
      finalized: true,
      source: task.source || "",
      sourceMeta: task.sourceMeta || null,
      externalAudioSource: task.externalAudioSource || null,
      textImportSources: task.textImportSources || [],
      meetingWorkbench: sessionMeta && sessionMeta.meetingWorkbench || null,
      segments: Array.isArray(task.segments) ? task.segments : [],
      multiSourceAudio: task.source === "merged-notes",
    };
    if (shouldRewriteConsolidatedNote(this.host.settings, retrySession)) {
      await this.host.noteWriter.rewriteConsolidated(retrySession, polished);
    } else {
      const cur = await this.host.app.vault.read(file);
      const failMark = new RegExp(`_\\[(?:${labelPattern("mergeFailedQueued").source})[^\\]]*\\]_`);
      const merged = mergeLeadingFrontmatterIntoDocument(cur, polished);
      let next;
      if (failMark.test(cur)) {
        next = merged.content.replace(failMark, merged.body);
      } else {
        const meta = getModeMeta(this.host.settings, task.mode);
        const block = `\n\n## ${labelText("mergedVersionAt", `${labelText("supplementaryRecording")} · ${meta.prefix}`)}\n\n${merged.body}\n\n---\n`;
        next = merged.content + block;
      }
      await this.host.app.vault.modify(file, next);
    }
    await clearCommittedBriefingCheckpoint(this.host, task.sessionMeta);
    let targetFile = file;
    const renamed = await this.host.noteWriter.renameMarkdownWithGeneratedTitle(file, polished, task.mode);
    if (renamed instanceof obsidian.TFile) targetFile = renamed;
    await this.host.noteIndex.refreshNoteIndexSafely(targetFile, {
      meetingDate: (task.sessionMeta && task.sessionMeta.startedAt) || task.createdAt || "",
      reason: "merge-retry",
    });
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
