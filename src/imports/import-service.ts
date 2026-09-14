/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：导入：音频与文本文件的转写整理流程、导入选项弹窗入口

import * as obsidian from "obsidian";
import { AudioImportOptionsModal } from "../ui/modals";
import { isKnownPolishMode, getModeMeta, getEffectivePolishMode } from "../shared/mode-meta";
import { getLlmConfigIssue, formatLlmConfigIssue } from "../llm/core";
import { TEXT_IMPORT_EXT } from "../shared/catalog-import";
import { genId } from "../shared/util-common";
import { mimeFromExt, getTranscribeSegmentPlaceholder } from "../shared/util-audio";
import { diagnosticError } from "../shared/util-key-diag";
import { audioImportStageFromWorkProgress, upsertActivityRequest } from "../shared/activity-progress";
import { extractSpeakerIdsFromMarkdown } from "../audio/channel-speakers";
import { isSpeakerDiarizationProvider, normalizeRequestedSpeakerCount } from "../asr/diarization";
import { isDashScopeFileTransProvider, resolveImportTranscribeProvider, transcribeImportedAudio } from "../asr/long-audio-transcription";
import { verifyTranscriptCheckpoint } from "../imports/transcript-checkpoint";
import { getAudioDurationMs, getAudioTimeLink } from "../notes/audio-refs";
import { splitImportedTextIntoNormalSegments, stripImportedTextSource } from "../notes/note-markdown";
import { TaskQueue } from "../queue/task-queue";
import type { LexVoiceSettings, RecordingSession } from "../shared/types";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { RecordingService } from "../audio/recording-service";
import { TaskActivityService } from "../tasks/task-activity-service";
import { ensureVaultFolder, findAvailableMarkdownPath } from "../shared/util-vault";
import { NoteWriter } from "../notes/note-writer";
import { TranscribeProfileService } from "../asr/transcribe-profile-service";
import { ViewShellService } from "../ui/view-shell-service";
import { SessionFinalizeService } from "../notes/session-finalize-service";

/** 导入音频时的可选参数；三项都缺省，缺省时取设置里的默认值。 */
export interface ImportAudioFilesOptions {
  /** 外部收件箱来源；自动导入时用于记录来源与去重指纹。 */
  externalSource?: { name?: string; fingerprint?: string };
  /** 是否启用说话人分离；缺省时读设置 importSpeakerDiarization。 */
  speakerDiarization?: boolean;
  /** 期望的说话人数；缺省时读设置 importSpeakerCount。 */
  speakerCount?: number;
}

/** ImportService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface ImportHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  diagnostics: DiagnosticsService;
  noteWriter: NoteWriter;
  profiles: TranscribeProfileService;
  queue: TaskQueue | null;
  /** 录音采集服务：切片缓存与整场音频的落点。 */
  recording: RecordingService;
  session: RecordingSession | null;
  sessionFinalize: SessionFinalizeService;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: LexVoiceSettings;
  shell: ViewShellService;
  tasks: TaskActivityService;
}

export class ImportService {
  declare host: ImportHost;
  constructor(host) {
    this.host = host;
  }


  openAudioImportOptions(paths, modeOverride) {
    const selectedPaths = Array.isArray(paths) ? paths.filter(Boolean) : [];
    if (!selectedPaths.length) return;
    const modal = new AudioImportOptionsModal(this.host.app, this.host, {
      paths: selectedPaths,
      mode: modeOverride || this.host.settings.polishMode,
      onConfirm: async (selection) => {
        await this.importAudioFiles(selectedPaths, selection.mode, {
          speakerDiarization: selection.speakerDiarization,
          speakerCount: selection.speakerCount,
        });
      },
    });
    modal.open();
  }

  async importAudioFiles(paths, modeOverride, options: ImportAudioFilesOptions = {}) {
    if (!paths || !paths.length) return;
    paths.sort();
    const externalSource = options && options.externalSource
      ? {
        name: String(options.externalSource.name || "").trim(),
        fingerprint: String(options.externalSource.fingerprint || "").trim(),
      }
      : null;
    const importProvider = resolveImportTranscribeProvider(this.host);
    const importProfile = this.host.profiles.getTranscribeProviderProfile(importProvider.id, importProvider);
    const providerSupportsSpeakerDiarization = !!(importProfile && importProfile.speakerDiarization)
      || isSpeakerDiarizationProvider(importProvider)
      || isDashScopeFileTransProvider(importProvider);
    const requestedSpeakerDiarization = typeof options.speakerDiarization === "boolean"
      ? options.speakerDiarization
      : this.host.settings.importSpeakerDiarization !== false;
    const speakerDiarization = requestedSpeakerDiarization
      && providerSupportsSpeakerDiarization;
    const requestedSpeakerCount = Object.prototype.hasOwnProperty.call(options, "speakerCount")
      ? options.speakerCount
      : this.host.settings.importSpeakerCount;
    const speakerCount = speakerDiarization && isDashScopeFileTransProvider(importProvider)
      ? normalizeRequestedSpeakerCount(requestedSpeakerCount)
      : 0;
    const speakerModeLabel = speakerDiarization
      ? ` · 区分说话人${speakerCount > 0 ? `（预计 ${speakerCount} 人）` : "（自动识别人数）"}`
      : "";
    const moment = window.moment;
    const startedAt = moment();
    const sessionStamp = startedAt.format("YYYYMMDD-HHmmss");
    const requestedMode = modeOverride && isKnownPolishMode(this.host.settings, modeOverride)
      ? modeOverride
      : (this.host.settings.polishMode || "meeting");
    const mode = getEffectivePolishMode(this.host.settings, requestedMode);
    const meta = getModeMeta(this.host.settings, mode);
    const mdName = `${startedAt.format(this.host.settings.noteFileNameFormatNew)} · 导入`;
    const mdPath = findAvailableMarkdownPath(this.host.app, obsidian.normalizePath(`${this.host.settings.mdFolder}/${mdName}.md`));
    await ensureVaultFolder(this.host.app, this.host.settings.mdFolder);

    const session: RecordingSession = {
      id: genId(),
      sessionStamp,
      startedAt: startedAt.toDate().toISOString(),
      mdPath,
      mode,
      source: "import",
      segments: [],
      realtimeOutline: "",
      realtimeOutlineState: { version: 1, nodes: [], memory: "" },
      realtimeOutlineMemory: "",
      realtimeOutlineSegmentCount: 0,
      realtimeOutlineAttemptedSegmentCount: 0,
      realtimeOutlineAttemptedAt: "",
      realtimeOutlineWorkbenchSignature: "",
      finalized: false,
      externalAudioSource: externalSource,
      importTranscribeProviderId: importProvider.id,
    };

    const header = [
      `# ${startedAt.format("YYYY-MM-DD HH:mm")} · ${meta.prefix}（导入处理中…）`,
      "",
      "> [!info] 导入信息",
      `> 文件数：${paths.length} · 模式：${meta.prefix} · 转写：整文件${speakerModeLabel}`,
      `> 模型：${importProvider.model || importProvider.id} → ${this.host.settings.llmModel}`,
      externalSource && externalSource.name ? `> 来源：自动导入 · ${externalSource.name}` : null,
      "",
      `<!-- lexvoice-session:${session.id} -->`,
      `<!-- lexvoice-segments-start:${session.id} -->`,
      `<!-- lexvoice-segments-end:${session.id} -->`,
      "",
    ].filter((line) => line !== null).join("\n");
    await this.host.noteWriter.appendToNote(mdPath, header);

    new obsidian.Notice(`开始导入 ${paths.length} 个音频文件…`);
    const importStartedAt = Date.now();
    this.host.tasks._importBusy = {
      workflow: "audio-import",
      sessionId: session.id,
      mdPath: session.mdPath,
      done: 0,
      total: paths.length,
      mode,
      phase: "prepare",
      phaseStartedAt: importStartedAt,
      startedAt: importStartedAt,
      updatedAt: importStartedAt,
      prepareDone: 0,
      prepareTotal: paths.length,
      segmentDone: 0,
      segmentTotal: paths.length,
      activeSegments: 0,
      failedSegments: 0,
      writtenSegments: 0,
      requests: [],
      events: [],
      stageState: {},
      asrConcurrency: 1,
    };
    this.host.tasks.updateImportActivity({
      event: {
        stageId: "prepare",
        type: "created",
        label: "导入任务已建立",
        detail: `整文件转写 · ${importProfile.title || importProvider.id}${speakerModeLabel}`,
      },
    });

    let cumOffsetMs = 0;
    let processedFiles = 0;
    let successfulTranscriptions = 0;
    for (let i = 0; i < paths.length; i++) {
      const audioPath = paths[i];
      const indexedFile = this.host.app.vault.getAbstractFileByPath(audioPath);
      const externalCache = !!externalSource && this.host.recording.isSegmentCachePath(audioPath);
      const adapter = this.host.app.vault.adapter;
      const sourceExists = indexedFile instanceof obsidian.TFile
        || (externalCache && await adapter.exists(obsidian.normalizePath(audioPath)));
      if (!sourceExists) {
        new obsidian.Notice(`跳过：${externalSource && externalSource.name ? externalSource.name : audioPath} 不存在`);
        continue;
      }

      const fallbackName = String(externalSource && externalSource.name || audioPath.split("/").pop() || "audio");
      const extension = (fallbackName.includes(".") ? fallbackName.split(".").pop() : "") || "audio";
      const file = indexedFile instanceof obsidian.TFile ? indexedFile : {
        path: obsidian.normalizePath(audioPath),
        name: fallbackName,
        basename: fallbackName.replace(/\.[^.]+$/, ""),
        extension: extension.toLowerCase(),
      };
      const displayName = externalSource && externalSource.name ? externalSource.name : file.name;
      const keepSourceAudio = !externalSource;
      const requestKey = `${session.id}:${i}`;
      this.host.tasks.updateImportActivity({
        phase: "prepare",
        done: i,
        total: paths.length,
        label: `准备音频 ${i + 1}/${paths.length}`,
        mode,
        file: displayName,
      });

      let blob;
      let mime;
      let durationMs = 0;
      try {
        const ab = indexedFile instanceof obsidian.TFile
          ? await this.host.app.vault.readBinary(indexedFile)
          : await adapter.readBinary(obsidian.normalizePath(audioPath));
        if (!ab || ab.byteLength === 0) {
          new obsidian.Notice(`跳过：${displayName} 是空文件（0 字节）。请确认文件已完整下载后再试。`, 9000);
          await this.host.diagnostics.logDiagnostic("warn", "import.empty_file", "导入音频为空文件", { audioName: displayName, size: 0 });
          continue;
        }
        mime = mimeFromExt(file.extension);
        blob = new Blob([ab], { type: mime });
        durationMs = await getAudioDurationMs(blob);
        if (speakerDiarization && durationMs > 2 * 60 * 60 * 1000 && isDashScopeFileTransProvider(importProvider)) {
          new obsidian.Notice("该音频超过 2 小时。仍会整文件提交，但阿里云建议说话人分离单文件不超过 2 小时。", 9000);
        }
        if (paths.length === 1 && keepSourceAudio) {
          session.masterAudioName = displayName;
          session.masterAudioPath = audioPath;
        }
      } catch (error) {
        console.error(error);
        new obsidian.Notice(`读取失败：${displayName}`);
        continue;
      }

      processedFiles++;
      this.host.tasks.updateImportActivity({
        phase: "transcribe",
        activeSegments: 1,
        requests: upsertActivityRequest(
          Array.isArray(this.host.tasks._importBusy && this.host.tasks._importBusy.requests) ? this.host.tasks._importBusy.requests : [],
          {
            key: requestKey,
            chunkIndex: i,
            chunkCount: paths.length,
            status: "requesting",
            attempt: 1,
            maxAttempts: Math.max(1, Number(this.host.settings.maxRetries) || 3),
            startedAt: Date.now(),
            updatedAt: Date.now(),
            deadlineAt: 0,
            retryAt: 0,
            receivedChars: 0,
            error: "",
          },
          400,
        ),
        event: {
          stageId: "transcribe",
          type: "started",
          label: `开始转写 ${displayName}`,
          detail: "整文件提交，不切分为多个 ASR 任务",
        },
      });

      let result = null;
      let error = null;
      let lastImportProgressPhase = "";
      try {
        result = await transcribeImportedAudio(this.host, blob, mime, {
          providerId: importProvider.id,
          diarization: speakerDiarization,
          speakerCount,
          fileName: displayName,
          audioDurationMs: durationMs,
          onProgress: (progress) => {
            const phaseChanged = progress.phase !== lastImportProgressPhase;
            lastImportProgressPhase = progress.phase;
            const requests = upsertActivityRequest(
              Array.isArray(this.host.tasks._importBusy && this.host.tasks._importBusy.requests) ? this.host.tasks._importBusy.requests : [],
              {
                key: requestKey,
                chunkIndex: i,
                chunkCount: paths.length,
                status: "requesting",
                updatedAt: Date.now(),
              },
              400,
            );
            this.host.tasks.updateImportActivity({
              phase: "transcribe",
              requests,
              transcribeLabel: progress.label,
              transcribeDetail: progress.detail || displayName,
              event: phaseChanged ? {
                stageId: "transcribe",
                type: progress.phase,
                label: progress.label,
                detail: progress.detail || displayName,
              } : null,
            });
          },
        });
        const detectedSpeakerIds = speakerDiarization
          ? extractSpeakerIdsFromMarkdown(String(result.text || ""))
          : [];
        if (speakerCount >= 2 && String(result.text || "").trim() && detectedSpeakerIds.length < speakerCount) {
          const mismatchMessage = `已指定 ${speakerCount} 位说话人，模型实际区分出 ${detectedSpeakerIds.length} 位`;
          new obsidian.Notice(`${mismatchMessage}。原始转写已保留，可在说话人编辑中核对。`, 9000);
          await this.host.diagnostics.logDiagnostic("warn", "asr.import_speaker_count_mismatch", mismatchMessage, {
            provider: importProvider.id,
            model: importProvider.model || "",
            audioName: displayName,
            requestedSpeakerCount: speakerCount,
            detectedSpeakerCount: detectedSpeakerIds.length,
            detectedSpeakerIds,
          });
          this.host.tasks.updateImportActivity({
            event: {
              stageId: "transcribe",
              type: "speaker-count-mismatch",
              label: mismatchMessage,
              detail: "不同说话人的声音可能较接近或存在较多重叠，建议核对原始转写。",
            },
          });
        }
        successfulTranscriptions++;
        this.host.tasks.updateImportRequest({
          key: requestKey,
          chunkIndex: i,
          chunkCount: paths.length,
          status: "done",
          updatedAt: Date.now(),
          deadlineAt: 0,
          receivedChars: String(result.text || "").length,
          error: "",
        });
        this.host.tasks.updateImportActivity({
          activeSegments: 0,
          segmentDone: Math.max(0, Number(this.host.tasks._importBusy && this.host.tasks._importBusy.segmentDone) || 0) + 1,
        });
        if (externalSource) {
          await this.host.recording.maybeDeleteSegmentCacheFile(audioPath, undefined, true);
        }
      } catch (caught) {
        const originalError = caught instanceof Error ? caught : new Error(String(caught));
        const exceedsDiarizationRecommendation = speakerDiarization
          && durationMs > 2 * 60 * 60 * 1000
          && isDashScopeFileTransProvider(importProvider);
        error = exceedsDiarizationRecommendation
          ? new Error(`${originalError.message}。本文件超过说话人分离建议的 2 小时，可关闭“区分说话人”后重试`)
          : originalError;
        console.error(error);
        this.host.tasks.updateImportRequest({
          key: requestKey,
          chunkIndex: i,
          chunkCount: paths.length,
          status: "failed",
          updatedAt: Date.now(),
          deadlineAt: 0,
          error: error.message,
        });
        this.host.tasks.updateImportActivity({
          activeSegments: 0,
          failedSegments: Math.max(0, Number(this.host.tasks._importBusy && this.host.tasks._importBusy.failedSegments) || 0) + 1,
        });
        await this.host.diagnostics.logDiagnostic("error", "asr.import_whole_file_failed", "导入音频整文件转写失败", {
          provider: importProvider.id,
          model: importProvider.model || "",
          audioName: displayName,
          mime,
          size: blob && blob.size,
          durationMs,
          speakerDiarization,
          speakerCount,
          error: diagnosticError(error),
        });
      }

      const segIndex = session.segments.length;
      const effectiveDurationMs = Math.max(0, Number(result && result.durationMs) || Number(durationMs) || 0);
      const startOffsetMs = cumOffsetMs;
      const endOffsetMs = cumOffsetMs + effectiveDurationMs;
      const isFinal = i === paths.length - 1;
      let retryTask = null;
      if (error) {
        retryTask = await this.host.queue.add({
          type: "transcribe",
          sessionId: session.id,
          mdPath: session.mdPath,
          audioPath,
          segmentIndex: segIndex,
          sourceAudioPath: keepSourceAudio ? audioPath : "",
          sourceAudioName: keepSourceAudio ? displayName : "",
          masterAudioPath: keepSourceAudio ? audioPath : "",
          masterAudioName: keepSourceAudio ? displayName : "",
          ephemeralAudio: !!externalSource,
          startOffsetMs,
          endOffsetMs,
          audioName: keepSourceAudio ? displayName : "",
          mode: session.mode,
          isFinal,
          source: "import",
          providerId: importProvider.id,
          wholeFileImport: true,
          speakerDiarization,
          speakerCount,
          lastError: error.message,
        });
      }

      const segmentRecord = {
        index: segIndex,
        startOffsetMs,
        endOffsetMs,
        audioName: keepSourceAudio ? displayName : "",
        audioPath: keepSourceAudio ? audioPath : "",
        segmentAudioName: displayName,
        segmentAudioPath: audioPath,
        text: result ? result.text : "",
        error: error ? error.message : null,
        isFinal,
        source: "import",
        queueTaskId: retryTask ? retryTask.id : undefined,
      };
      session.segments.push(segmentRecord);

      const audioAnchor = keepSourceAudio ? getAudioTimeLink(displayName, startOffsetMs) : "";
      const block = [
        "",
        `### 音频 ${segIndex + 1}${audioAnchor ? ` ${audioAnchor}` : ""}${isFinal ? " · 结束" : ""}`,
        "",
        retryTask ? `<!-- lexvoice-transcribe-task:${retryTask.id} -->` : "",
        error
          ? getTranscribeSegmentPlaceholder(error, { retryable: true })
          : (result.text || "_[此音频无内容]_"),
        "",
      ].join("\n");
      await this.host.noteWriter.insertBeforeSegmentsEnd(session.mdPath, block, session.id);
      this.host.tasks.updateImportActivity({
        done: i + 1,
        writtenSegments: session.segments.length,
        prepareDone: i + 1,
      });
      cumOffsetMs = endOffsetMs;
    }

    if (processedFiles === 0) {
      const error = new Error("没有可处理的音频文件");
      this.host.tasks.updateImportActivity({ error: error.message });
      this.host.tasks._importBusy = null;
      this.host.tasks.updateBusyStatus();
      throw error;
    }

    this.host.session = session;
    const pendingTranscriptionCount = session.segments.filter((segment) => !!segment.error).length;
    if (successfulTranscriptions === 0) {
      const message = pendingTranscriptionCount > 0
        ? "语音转写未完成；音频已保留，可在处理进度中重试"
        : "没有获得可用于整理的有效转写文本";
      this.host.tasks.updateImportActivity({
        phase: "transcribe",
        error: message,
        label: "语音转写未完成",
      });
      new obsidian.Notice(message, 9000);
      return {
        mdPath: session.mdPath,
        sessionId: session.id,
        segmentCount: session.segments.length,
        pendingTranscriptionCount,
      };
    }
    const transcriptFile = this.host.app.vault.getAbstractFileByPath(session.mdPath);
    if (!(transcriptFile instanceof obsidian.TFile)) {
      throw new Error("原始转写写入后未找到对应笔记，已停止 AI 整理");
    }
    const persistedMarkdown = await this.host.app.vault.read(transcriptFile);
    const transcriptCheckpoint = verifyTranscriptCheckpoint(persistedMarkdown, session.segments);
    if (!transcriptCheckpoint.ok) {
      const checkpointError = new Error(
        `原始转写尚未完整写入笔记（${transcriptCheckpoint.persistedSegments}/${transcriptCheckpoint.expectedSegments}），已停止 AI 整理`,
      );
      this.host.tasks.updateImportActivity({
        phase: "persist",
        error: checkpointError.message,
        label: "原始转写写入未完成",
      });
      await this.host.diagnostics.logDiagnostic("error", "asr.import_transcript_checkpoint_failed", "导入音频原始转写检查点未通过", {
        mdPath: session.mdPath,
        expectedSegments: transcriptCheckpoint.expectedSegments,
        persistedSegments: transcriptCheckpoint.persistedSegments,
        expectedChars: transcriptCheckpoint.expectedChars,
        missingSegmentIndexes: transcriptCheckpoint.missingSegmentIndexes,
      });
      throw checkpointError;
    }
    await this.host.diagnostics.logDiagnostic("info", "asr.import_transcript_persisted", "导入音频原始转写已写入，允许进入 AI 整理", {
      mdPath: session.mdPath,
      segmentCount: transcriptCheckpoint.expectedSegments,
      transcriptChars: transcriptCheckpoint.expectedChars,
      provider: importProvider.id,
    });
    this.host.tasks.updateImportActivity({
      phase: "organize",
      organizeLabel: "准备 AI 整理",
      organizeDetail: "原始转写已完整写入，正在按当前纪要模板生成正文。",
    });
    await this.host.sessionFinalize.finalizeSession(session);
    const finalizationError = String(session.finalizationError || "").trim()
      || (session.workProgress && session.workProgress.stage === "transcript-empty"
        ? "没有获得可用于整理的有效转写文本"
        : "");
    if (finalizationError) {
      this.host.tasks.updateImportActivity({
        phase: audioImportStageFromWorkProgress(session.workProgress && session.workProgress.stage),
        error: finalizationError,
      });
    } else {
      this.host.tasks.updateImportActivity({
        phase: "write",
        completed: true,
        writeLabel: "处理完成",
        writeDetail: "纪要已经写入 Obsidian。",
      });
    }
    const completedImportId = session.id;
    window.setTimeout(() => {
      if (this.host.tasks._importBusy && String(this.host.tasks._importBusy.sessionId || "") === String(completedImportId)) {
        this.host.tasks._importBusy = null;
        this.host.tasks.updateBusyStatus();
        this.host.shell.refreshOutlineView();
      }
    }, finalizationError ? 0 : 1800);
    return {
      mdPath: session.mdPath,
      sessionId: session.id,
      segmentCount: session.segments.length,
      pendingTranscriptionCount,
    };
  }

  async importTextFiles(paths, modeOverride) {
    if (!paths || !paths.length) return;
    const uniquePathSet = new Set<string>();
    for (const pathValue of paths) {
      if (typeof pathValue !== "string") continue;
      const normalizedPath = obsidian.normalizePath(pathValue);
      if (normalizedPath) uniquePathSet.add(normalizedPath);
    }
    const uniquePaths = Array.from(uniquePathSet).sort();
    const sources = [];
    for (const textPath of uniquePaths) {
      const file = this.host.app.vault.getAbstractFileByPath(textPath);
      if (!(file instanceof obsidian.TFile) || !TEXT_IMPORT_EXT.has(String(file.extension || "").toLowerCase())) {
        new obsidian.Notice(`跳过：${textPath} 不是可导入文本`);
        continue;
      }
      try {
        const raw = await this.host.app.vault.read(file);
        const text = stripImportedTextSource(raw);
        if (!text) {
          new obsidian.Notice(`跳过空文本：${file.name}`);
          continue;
        }
        sources.push({ file, path: file.path, name: file.name, text });
      } catch (e) {
        console.error("[QnALog] import text read failed", e);
        new obsidian.Notice(`读取失败：${file.name}`);
      }
    }
    if (!sources.length) {
      new obsidian.Notice("没有可处理的文本内容");
      return;
    }

    const moment = window.moment;
    const startedAt = moment();
    const sessionStamp = startedAt.format("YYYYMMDD-HHmmss");
    const requestedMode = modeOverride && isKnownPolishMode(this.host.settings, modeOverride)
      ? modeOverride
      : (this.host.settings.polishMode || "meeting");
    const mode = getEffectivePolishMode(this.host.settings, requestedMode);
    const meta = getModeMeta(this.host.settings, mode);
    const llmIssue = getLlmConfigIssue(this.host.settings);
    if (llmIssue) {
      await this.host.diagnostics.logDiagnostic("warn", "text_import.llm_config_missing", "导入文本前大模型配置不完整", {
        mode,
        llmRoute: "composer.chat-completions",
        llmEndpoint: this.host.settings.llmEndpoint || "",
        llmModel: this.host.settings.llmModel ? "<set>" : "",
        issue: llmIssue,
      });
      new obsidian.Notice(`导入文本需要先完成大模型配置：${formatLlmConfigIssue(llmIssue)}`, 9000);
      return;
    }

    await ensureVaultFolder(this.host.app, this.host.settings.mdFolder);
    const mdName = `${startedAt.format(this.host.settings.noteFileNameFormatNew)} · 文本导入`;
    const mdPath = findAvailableMarkdownPath(this.host.app, obsidian.normalizePath(`${this.host.settings.mdFolder}/${mdName}.md`));
    if (!mdPath) throw new Error("无法生成文本导入笔记路径");

    const session: RecordingSession = {
      id: genId(),
      sessionStamp,
      startedAt: startedAt.toDate().toISOString(),
      mdPath,
      mode,
      source: "text-import",
      segments: [],
      realtimeOutline: "",
      realtimeOutlineState: { version: 1, nodes: [], memory: "" },
      realtimeOutlineMemory: "",
      realtimeOutlineSegmentCount: 0,
      realtimeOutlineAttemptedSegmentCount: 0,
      realtimeOutlineAttemptedAt: "",
      realtimeOutlineWorkbenchSignature: "",
      finalized: false,
      textImportSources: sources.map(s => ({ path: s.path, name: s.name, chars: s.text.length })),
    };

    const header = [
      `# ${startedAt.format("YYYY-MM-DD HH:mm")} · ${meta.prefix}（文本导入处理中…）`,
      "",
      `> [!info] 文本导入信息`,
      `> 来源文件：${sources.length} · 模式：${meta.prefix} · 模型：${this.host.settings.llmModel}`,
      "",
      `<!-- lexvoice-session:${session.id} -->`,
      `<!-- lexvoice-segments-start:${session.id} -->`,
      `<!-- lexvoice-segments-end:${session.id} -->`,
      "",
    ].join("\n");
    await this.host.noteWriter.appendToNote(mdPath, header);
    this.host.session = session;
    this.host.recording.setSessionWorkProgress(session, {
      stage: "text-import",
      label: "读取文本",
      percent: 8,
      detail: `已读取 ${sources.length} 个文本来源，准备进入 AI 整理`,
    });
    this.host.shell.refreshOutlineView();
    try { await this.host.shell.openOutlineView(); } catch (e) { console.warn("[QnALog] open outline for text import failed", e); }

    session.segments = splitImportedTextIntoNormalSegments(sources);

    for (const seg of session.segments) {
      const block = [
        "",
        `### 文本来源 ${seg.index + 1}：[[${seg.sourcePath}|${seg.sourceName}]]`,
        "",
        seg.rawText || "_[此文本来源为空]_",
        "",
      ].join("\n");
      await this.host.noteWriter.insertBeforeSegmentsEnd(session.mdPath, block, session.id);
    }

    this.host.shell.refreshOutlineView();
    new obsidian.Notice(`开始整理 ${sources.length} 份文本：使用 AI 整理服务，不调用语音转写服务。`);
    await this.host.sessionFinalize.finalizeSession(session);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
