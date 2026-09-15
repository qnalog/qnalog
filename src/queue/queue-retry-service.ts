/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：队列任务的失败恢复：转写重试、合并重试、提示词任务、改名与删除后的任务迁移

import * as obsidian from "obsidian";
import type { LiveAsrCircuitState } from "../asr/live-segment-policy";
import { QnALogSettingTab } from "../ui/settings-tab";
import { isKnownPolishMode, getModeMeta, getEffectivePolishMode } from "../shared/mode-meta";
import { decodeAudioBlob, renderAudioBufferSliceToWav, transcribeAudio } from "../asr/transcribe";
import { getLlmConfigIssue, isLlmServiceBlockedError, formatLlmConfigIssue } from "../llm/core";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { PluginSettings, RecordingSession } from "../shared/types";
import { AUDIO_EXT } from "../shared/catalog-import";
import { genId, formatElapsed, escapeRegExp } from "../shared/util-common";
import { mimeFromExt, isAsrTransportError } from "../shared/util-audio";
import { LIVE_ASR_TASK_STATUS } from "../asr/live-segment-policy";
import { diagnosticError } from "../shared/util-key-diag";
import { MAX_SPEAKER_CHANNELS, initialAudioChannelRuntimeMode, normalizeAudioChannelMode } from "../audio/channel-speakers";
import { renderMultichannelAudioBufferSliceToWav, transcribeAudioByChannels } from "../asr/channel-transcription";
import { transcribeImportedAudio } from "../asr/long-audio-transcription";
import { shouldRewriteConsolidatedNote } from "../briefing/note-layout-policy";
import { clearCommittedBriefingCheckpoint } from "../prompts/briefing-prompts";
import { getAudioTimeLink } from "../notes/audio-refs";
import { extractSessionId, mergeLeadingFrontmatterIntoDocument } from "../notes/note-markdown";
import { getQueueTasksForMarkdown } from "../recent/recent-notes";
import { RecorderService } from "../audio/recorder-service";
import { TaskQueue } from "../queue/task-queue";
import { mergeAndPolish } from "../briefing/merge-pipeline";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { NoteIndexService } from "../notes/note-index-service";
import { SessionFinalizeService } from "../notes/session-finalize-service";
import { VocabularyService } from "../vocabulary/vocabulary-service";
import { TaskActivityService } from "../tasks/task-activity-service";
import { NoteWriter } from "../notes/note-writer";
import { NS_AUDIO_ALT, nsMarker } from "../shared/namespace";

/** QueueRetryService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface QueueRetryHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;

  diagnostics: DiagnosticsService;




  noteWriter: NoteWriter;
  queue: TaskQueue | null;
  recorder: RecorderService | null;
  /** 视图外壳服务：队列状态变化后刷新侧边栏。 */
  shell: { refreshOutlineView(): void };

  saveAll(): Promise<void>;
  saveSettings(): Promise<void>;
  session: RecordingSession | null;
  settingTab: QnALogSettingTab | null;
  /** 笔记索引与当日概要服务。 */
  noteIndex: NoteIndexService;
  /** 录音采集服务：切片缓存清理与熔断状态。 */
  recording: { getAsrServiceCircuitState(): LiveAsrCircuitState; isAsrServiceCircuitOpen(): boolean; getAsrServiceRetryDelayMs(): number; resetAsrServiceCircuitForManualRetry(source?: string): unknown; maybeDeleteSegmentCacheFile(path: string, excludeTaskId?: string, force?: boolean): Promise<void> };
  /** 会话收尾服务：转写补齐后的说话人确认与收尾。 */
  sessionFinalize: SessionFinalizeService;
  /** 词汇表与行业提示词服务。 */
  vocabulary: VocabularyService;
  /** 重新整理服务：导入转写完成后按说话人姓名重排纪要。 */
  repolish: { repolishMarkdownFile(file: obsidian.TFile, mode: string, repolishOptions?: unknown): Promise<void> };
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
  tasks: TaskActivityService;
}

export class QueueRetryService {
  declare host: QueueRetryHost;
  declare _taskQueueRetryTimer;
  declare _taskQueueRetryAt;

  constructor(host) {
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
      const recorderBusy = this.host.recorder && this.host.recorder.state !== "idle";
      const segmentBusy = this.host.session && Number(this.host.session.activeSegmentJobs || 0) > 0;
      const queueBusy = this.host.queue && this.host.queue.running;
      if (recorderBusy || segmentBusy || queueBusy) {
        this.scheduleTaskQueueRetry(30 * 1000, "activity-still-busy");
        return;
      }
      void this.host.diagnostics.logDiagnostic("info", "queue.scheduled_retry_started", "开始执行计划中的后台重试", {
        reason,
        taskCount: this.host.queue && Array.isArray(this.host.queue.tasks) ? this.host.queue.tasks.length : 0,
      });
      void this.host.queue.processAll().catch((e) => console.error("[QnALog] scheduled queue retry failed", e));
    }, delay);
  }
  scheduleDeferredAsrRetry(session) {
    if (!session || !session.hasDeferredAsrJobs) return;
    const serviceCircuit = this.host.recording.getAsrServiceCircuitState();
    const openUntilMs = Math.max(
      0,
      Number(session.asrCircuitState && session.asrCircuitState.openUntilMs) || 0,
      Number(serviceCircuit && serviceCircuit.openUntilMs) || 0,
    );
    const delayMs = Math.max(1500, openUntilMs > Date.now() ? openUntilMs - Date.now() + 1000 : 0);
    this.scheduleTaskQueueRetry(delayMs, "session-deferred-asr");
  }
  async retryQueue() {
    if (!this.host.queue.tasks.length) { new obsidian.Notice("队列为空"); return; }
    const blockedMergeTasks = this.host.queue.tasks.filter((task) => task && task.type === "merge" && task.status === "blocked");
    if (blockedMergeTasks.length) {
      const llmIssue = getLlmConfigIssue(this.host.settings);
      if (llmIssue) {
        new obsidian.Notice(`有 ${blockedMergeTasks.length} 个整理任务待配置：${formatLlmConfigIssue(llmIssue)}`, 9000);
      } else {
        const serviceBlocked = blockedMergeTasks.find((task) => isLlmServiceBlockedError(task.lastError || ""));
        for (const task of blockedMergeTasks) {
          task.status = "pending";
          task.lastError = "";
          task.updatedAt = new Date().toISOString();
        }
        await this.host.saveAll();
        new obsidian.Notice(serviceBlocked
          ? `已恢复 ${blockedMergeTasks.length} 个暂停整理任务，正在重新尝试大模型服务`
          : `已恢复 ${blockedMergeTasks.length} 个待配置整理任务`);
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
      if (missingN) hints.push(`${missingN} 个临时切片丢失`);
      if (exhaustedN) hints.push(`${exhaustedN} 个已达重试上限——若已修正配置（如补好密钥/换转写服务），可在笔记右键「重试失败转写」或队列面板逐条重试`);
      new obsidian.Notice(hints.length ? `没有可自动重试的任务（${hints.join("；")}）` : "没有可自动重试的任务", hints.length ? 9000 : 4000);
      return;
    }
    if (runnable.some((task) => task.type === "transcribe")) {
      this.host.recording.resetAsrServiceCircuitForManualRetry("retry-all");
      for (const task of runnable) {
        if (task.type === "transcribe") task.nextRetryAt = undefined;
      }
      await this.host.saveAll();
    }
    new obsidian.Notice(`重试 ${runnable.length} 个任务…`);
    await this.host.queue.processAll();
    new obsidian.Notice(`剩余 ${this.host.queue.tasks.length} 个任务`);
  }
  async retryTranscribeTasksForMarkdown(file) {
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") return;
    const tasks = getQueueTasksForMarkdown(this.host, file, { types: ["transcribe"] })
      .filter((task) => ["failed", "missing", "pending"].includes(task.status || "pending") && !!task.lastError);
    if (!tasks.length) {
      new obsidian.Notice("这篇纪要当前没有可重试的转写任务。", 5000);
      return;
    }
    new obsidian.Notice(`Q&A Log：正在重试 ${tasks.length} 个转写片段…`);
    let ok = 0;
    let failed = 0;
    let paused = false;
    const batch = tasks.slice();
    // 批量游标喂状态栏：重新转写逐段 done/total 实时可见（之前直接 for 循环没设游标 → 状态栏黑盒）。
    this.host.queue._batchTotal = batch.length;
    this.host.queue._batchDone = 0;
    this.host.tasks.updateBusyStatus();
    this.host.recording.resetAsrServiceCircuitForManualRetry("note-retry");
    try {
      for (const task of batch) {
        if (this.host.recording.isAsrServiceCircuitOpen()) break;
        try {
          await this.host.queue.processOne(task);
          ok++;
        } catch (e) {
          failed++;
          console.error("[QnALog] retry transcribe task from note list failed", e);
          if (isAsrTransportError(e)) {
            this.scheduleTaskQueueRetry(this.host.recording.getAsrServiceRetryDelayMs(), "note-retry-transport-failure");
            paused = true;
          }
        }
        this.host.queue._batchDone++;
        this.host.tasks.updateBusyStatus();
        if (paused) break;
      }
    } finally {
      this.host.queue._batchTotal = 0;
      this.host.queue._batchDone = 0;
      this.host.tasks.updateBusyStatus();
    }
    await this.host.saveAll();
    this.host.shell.refreshOutlineView();
    new obsidian.Notice(paused
      ? `转写服务仍不可用：本次成功 ${ok} 个，失败 ${failed} 个；其余片段已保留，稍后继续`
      : `转写重试完成：成功 ${ok} 个${failed ? `，失败 ${failed} 个` : ""}`, 8000);
  }
  async readTranscribeTaskAudioBlob(task) {
    const direct = await this.readVaultAudioBlob(task.audioPath, task.audioName);
    if (direct) return direct;

    const recovered = await this.recoverTranscribeTaskAudioBlob(task);
    if (recovered) {
      await this.host.diagnostics.logDiagnostic("warn", "queue.transcribe_audio_recovered", "转写重试已从完整录音恢复临时切片", {
        audioName: task.audioName || "",
        sourceAudioName: recovered.sourceName || "",
        startOffsetMs: task.startOffsetMs,
        endOffsetMs: task.endOffsetMs,
      });
      return recovered;
    }

    throw new Error(`音频不存在：${task.audioPath || task.audioName || "未知音频"}`);
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
      throw new Error(`临时切片不存在，已找到完整录音但无法重新切片：${(e && e.message) || e}`);
    }
  }
  async retryTranscribeTask(task) {
    const mdFile = this.host.app.vault.getAbstractFileByPath(task.mdPath);
    const failMark = /_\[(?:等待后台转写，音频已保留|此段尚未完成转写，音频已保留)\]_|_\[等待后台转写：[^\]]*\]_|_\[转写失败（空结果，已进入重试队列）\]_|_\[转写失败(?:（已进入重试队列）)?：[^\]]*\]_/;
    const taskMarker = task.id ? nsMarker("transcribe-task", task.id) : "";
    const taskPattern = taskMarker
      ? new RegExp(`${escapeRegExp(taskMarker)}\\s*(?:${failMark.source})`)
      : null;
    const segmentNumber = Math.max(0, Number(task.segmentIndex) || 0) + 1;
    const segmentStart = formatElapsed(Math.max(0, Number(task.startOffsetMs) || 0));
    const segmentEnd = formatElapsed(Math.max(Number(task.startOffsetMs) || 0, Number(task.endOffsetMs) || 0));
    const legacySegmentPattern = new RegExp(
      `((?:^|\\n)###\\s+段落\\s+${segmentNumber}\\s+\\(${escapeRegExp(segmentStart)}[–-]${escapeRegExp(segmentEnd)}\\)[^\\n]*\\n(?:\\s*\\n)?(?:<!--\\s*qnalog-transcribe-task:[^>]+-->\\s*)?)(?:${failMark.source})`,
    );
    let currentMarkdown = "";
    if (mdFile instanceof obsidian.TFile && taskMarker) {
      currentMarkdown = await this.host.app.vault.read(mdFile);
      if (currentMarkdown.includes(taskMarker) && !(taskPattern && taskPattern.test(currentMarkdown))) {
        // 正文已经写入，只是上次删除持久任务时中断。幂等收尾，不能再次调用 ASR 或重复插段。
        await this.host.recording.maybeDeleteSegmentCacheFile(task.audioPath, task.id);
        return;
      }
    }
    const audio = await this.readTranscribeTaskAudioBlob(task);
    let text = "";
    if (task.wholeFileImport) {
      const result = await transcribeImportedAudio(this.host, audio.blob, audio.blob.type || "audio/wav", {
        providerId: task.providerId,
        diarization: task.speakerDiarization !== false,
        speakerCount: task.speakerCount,
        fileName: task.sourceAudioName || task.audioName || "import-audio",
      });
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
      text = channelTranscription
        ? channelTranscription.text
        : await transcribeAudio(this.host, audio.blob, audio.blob.type || "audio/wav");
    }
    if (!String(text || "").trim()) {
      // 重试仍为空 = 失败（不再替换成"暂无有效转写"并删缓存了事）：
      // 抛错让队列按失败记录 + 计重试次数，缓存音频保留，后续还能继续重试。
      await this.host.diagnostics.logDiagnostic("warn", "queue.transcribe_empty_result", "转写重试返回空文本，视作失败继续排队", {
        mdPath: task.mdPath || "",
        audioName: task.audioName || "",
        startOffsetMs: task.startOffsetMs,
        endOffsetMs: task.endOffsetMs,
      });
      throw new Error("转写重试返回空结果（服务 HTTP 200 但无文字）");
    }
    let replaced = false;
    if (mdFile instanceof obsidian.TFile) {
      const cur = currentMarkdown || await this.host.app.vault.read(mdFile);
      const next = taskPattern && taskPattern.test(cur)
        ? cur.replace(taskPattern, `${taskMarker}\n${text}`)
        : legacySegmentPattern.test(cur)
          ? cur.replace(legacySegmentPattern, `$1${taskMarker}\n${text}`)
          : cur.replace(failMark, text);
      if (next !== cur) {
        await this.host.app.vault.modify(mdFile, next);
        replaced = true;
      }
    }
    if (!replaced) {
      // 崩溃可能发生在“切片和任务已落盘、占位段尚未写入纪要”之间。
      // 重启补转成功时主动恢复该段，而不是静默删掉任务和音频。
      const segNumber = Math.max(0, Number(task.segmentIndex) || 0) + 1;
      const startOffsetMs = Math.max(0, Number(task.startOffsetMs) || 0);
      const endOffsetMs = Math.max(startOffsetMs, Number(task.endOffsetMs) || startOffsetMs);
      const sourceAudioName = String(task.sourceAudioName || task.masterAudioName || task.audioName || "");
      const linkOffsetMs = (task.sourceAudioName || task.masterAudioName)
        ? Math.max(0, Number(task.audioStartOffsetMs) || 0)
        : 0;
      const recoveredBlock = [
        "",
        `### 段落 ${segNumber} (${formatElapsed(startOffsetMs)}–${formatElapsed(endOffsetMs)}) ${getAudioTimeLink(sourceAudioName, linkOffsetMs)}`,
        "",
        taskMarker,
        text,
        "",
      ].join("\n");
      await this.host.noteWriter.insertBeforeSegmentsEnd(task.mdPath, recoveredBlock, task.sessionId);
      replaced = true;
    }
    if (!audio.recovered && (!task.wholeFileImport || task.ephemeralAudio)) {
      await this.host.recording.maybeDeleteSegmentCacheFile(task.audioPath, task.id, !!task.ephemeralAudio);
    }
    if (replaced && task.wholeFileImport && task.speakerDiarization !== false) {
      await this.host.sessionFinalize.confirmSpeakerNamesBeforeFinal({
        id: task.sessionId,
        mdPath: task.mdPath,
        source: "import",
        importTranscribeProviderId: task.providerId,
      }, [{ text }]);
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
    new obsidian.Notice(`「${mdFile.basename}」全部失败段已补转写，正在重新整理正文…`, 8000);
    const mode = this.host.noteWriter.detectModeFromMarkdown(mdFile) || getEffectivePolishMode(this.host.settings, this.host.settings.polishMode);
    // fire-and-forget：不阻塞队列循环
    void (async () => {
      try {
        await this.host.repolish.repolishMarkdownFile(mdFile, mode, null);
      } catch (e) {
        try {
          await this.host.diagnostics.logDiagnostic("error", "queue.auto_repolish_failed", "补转写后自动重新整理失败", {
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
      // 顺便把 task 里其他指向同一 md 的引用字段也迁移
      // sourceMdPath 只出现在旧版持久化的队列数据里，当前 QueueTask 类型不含该字段；按遗留数据处理。
      const legacySourceMdPath = (task as { sourceMdPath?: string }).sourceMdPath;
      if (legacySourceMdPath && obsidian.normalizePath(legacySourceMdPath) === oldNorm) {
        (task as { sourceMdPath?: string }).sourceMdPath = newNorm;
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
    this.host.queue.tasks = this.host.queue.tasks.filter((task) =>
      !(task && task.mdPath && obsidian.normalizePath(task.mdPath) === norm)
    );
    const removed = before - this.host.queue.tasks.length;
    if (removed > 0) {
      try { void (this.host.saveAll || this.host.saveSettings).call(this.host); } catch (e) {
        console.warn("[QnALog] queue delete cleanup save failed", e);
      }
      try { this.host.shell.refreshOutlineView(); } catch { /* intentionally empty */ }
    }
  }
  async retryMergeTask(task) {
    const polished = await mergeAndPolish(
          this.host,
      task.segments || [],
      task.mode,
      task.sessionMeta || null,
      task.speakerFrontmatter || null,
    );
    if (!polished) throw new Error("合并返回为空");
    const file = this.host.app.vault.getAbstractFileByPath(task.mdPath);
    if (!(file instanceof obsidian.TFile)) throw new Error(`笔记不存在：${task.mdPath}`);
    const retrySession = {
      id: task.sessionId || genId(),
      mdPath: file.path,
      mode: task.mode,
      startedAt: (task.sessionMeta && task.sessionMeta.startedAt) || task.createdAt || new Date().toISOString(),
      source: task.source || "",
      sourceMeta: task.sourceMeta || null,
      externalAudioSource: task.externalAudioSource || null,
      textImportSources: task.textImportSources || [],
      meetingWorkbench: task.sessionMeta && task.sessionMeta.meetingWorkbench || null,
      segments: Array.isArray(task.segments) ? task.segments : [],
      multiSourceAudio: task.source === "merged-notes",
    };
    if (shouldRewriteConsolidatedNote(this.host.settings, retrySession)) {
      await this.host.noteWriter.rewriteConsolidated(retrySession, polished);
    } else {
      const cur = await this.host.app.vault.read(file);
      const failMark = /_\[合并润色失败（已加入重试队列）：[^\]]*\]_/;
      const merged = mergeLeadingFrontmatterIntoDocument(cur, polished);
      let next;
      if (failMark.test(cur)) {
        next = merged.content.replace(failMark, merged.body);
      } else {
        const meta = getModeMeta(this.host.settings, task.mode);
        const block = `\n\n## 整合版（补录 · ${meta.prefix}）\n\n${merged.body}\n\n---\n`;
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
    try {
      const latestContent = await this.host.app.vault.read(targetFile);
      const session = {
        id: task.sessionId || extractSessionId(latestContent, obsidian.normalizePath(targetFile.path).replace(/[^A-Za-z0-9_-]+/g, "-")),
        mdPath: targetFile.path,
        mode: task.mode,
        startedAt: (task.sessionMeta && task.sessionMeta.startedAt) || task.createdAt || new Date().toISOString(),
        segments: Array.isArray(task.segments) ? task.segments : [],
      };
      await this.host.noteIndex.appendDailyMeetingOverview(session, polished);
    } catch (e) {
      console.error("[QnALog] daily overview after merge retry failed", e);
    }
  }
  async runGeneratePromptTask(task) {
    const mode = task.mode;
    if (!mode) throw new Error("缺少 mode");
    const tpl = await this.host.vocabulary.generateAndApplyIndustryPrompt(mode, { activate: task.activate !== false });
    const activated = task.activate !== false;
    new obsidian.Notice("已创建自定义提示词「" + tpl.name + "」" + (activated ? "，并设为当前默认。" : "。"), 7000);
    if (this.host.settingTab) {
      try { this.host.settingTab.display(); } catch { /* intentionally empty */ }
    }
  }
  // 把"生成 Prompt"作为后台任务入队。立刻返回，UI 切走也不影响。
  async enqueueGeneratePromptTask(mode, options) {
    if (!isKnownPolishMode(this.host.settings, mode)) throw new Error("未知的 mode：" + mode);
    const p = this.host.settings.industryProfile;
    if (!p || !p.industry || !p.scenarios) throw new Error("请先在 AI 整理填写「行业 / 角色」和「主要工作场景」");
    if (!this.host.settings.llmApiKey) throw new Error("请先在 API 页配置大模型服务");
    const existing = this.host.queue.findActiveGeneratePromptTask(mode);
    if (existing) {
      const meta = getModeMeta(this.host.settings, mode);
      new obsidian.Notice("已存在生成任务：参考「" + (meta.prefix || mode) + "」的自定义提示词正在队列中", 5000);
      return existing;
    }
    const task = await this.host.queue.add({
      type: "generate-prompt",
      mode,
      activate: !options || options.activate !== false,
    });
    const meta = getModeMeta(this.host.settings, mode);
    new obsidian.Notice("已加入后台队列：参考「" + (meta.prefix || mode) + "」生成自定义提示词（切换页面不会中断）", 5000);
    try { this.host.recorder.emit(); } catch { /* intentionally empty */ }
    // 立刻拉起队列处理（不 await，让调用方立刻返回）
    this.host.queue.processAll()
      .catch((e) => console.error("[QnALog] queue processAll", e))
      .finally(() => { try { this.host.recorder.emit(); } catch { /* intentionally empty */ } });
    return task;
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
