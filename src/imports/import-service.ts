/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：导入：音频与文本文件的转写整理流程、导入选项弹窗入口

import * as obsidian from "obsidian";
import { AudioImportOptionsModal } from "../ui/modals";
import { isKnownPolishMode, getModeMeta, getEffectivePolishMode, getModePrefix} from "../shared/mode-meta";
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
import type { PluginSettings, RecordingSession } from "../shared/types";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { TaskActivityService } from "../tasks/task-activity-service";
import { ensureVaultFolder, findAvailableMarkdownPath } from "../shared/util-vault";
import { NoteWriter } from "../notes/note-writer";
import { TranscribeProfileService } from "../asr/transcribe-profile-service";
import { ViewShellService } from "../ui/view-shell-service";
import { SessionFinalizeService } from "../notes/session-finalize-service";
import { nsMarker } from "../shared/namespace";
import { attachTextTranscript, attachTranscriptResult } from "../transcript/session-transcript";
import { serializeTranscriptBlock } from "../transcript/transcript-markdown";

import { t } from "../shared/i18n";
import { labelText } from "../shared/note-labels";
import type { SessionStore } from "../session/session-store";
import type { LiveAsrPipelineService } from "../asr/live-asr-pipeline-service";
/** 导入音频的返回：新建会话的路径、分段数，以及需要重试的转写段数；入参为空或中断时返回 undefined。 */
export interface ImportAudioFilesResult {
  mdPath: string;
  sessionId: string;
  segmentCount: number;
  /** 首轮转写失败的段数；大于 0 表示纪要已建立但转写待重试。 */
  pendingTranscriptionCount: number;
}

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
  /** 独立的实时转写管线：切片缓存与当前会话进度。 */
  asrPipeline: LiveAsrPipelineService;
  sessionStore: SessionStore;
  sessionFinalize: SessionFinalizeService;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
  shell: ViewShellService;
  tasks: TaskActivityService;
}

export class ImportService {
  declare host: ImportHost;
  constructor(host: ImportHost) {
    this.host = host;
  }


  openAudioImportOptions(paths, modeOverride = undefined) {
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

  async importAudioFiles(paths, modeOverride, options: ImportAudioFilesOptions = {}): Promise<ImportAudioFilesResult | undefined> {
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
      ? t(" · Distinguish speakers{0}").replace("{0}", speakerCount > 0
        ? t("(estimated {0} people)").replace("{0}", String(speakerCount))
        : t("(automatic speaker count)"))
      : "";
    const moment = window.moment;
    const startedAt = moment();
    const sessionStamp = startedAt.format("YYYYMMDD-HHmmss");
    const requestedMode = modeOverride && isKnownPolishMode(this.host.settings, modeOverride)
      ? modeOverride
      : (this.host.settings.polishMode || "meeting");
    const mode = getEffectivePolishMode(this.host.settings, requestedMode);
    const meta = getModeMeta(this.host.settings, mode);
    const mdName = `${startedAt.format(this.host.settings.noteFileNameFormatNew)} · ${t("Import")}`;
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
    this.host.asrPipeline.initializeSession(session);

    const header = [
      `# ${startedAt.format("YYYY-MM-DD HH:mm")} · ${getModePrefix(meta)}${labelText("importing")}`,
      "",
      `> [!info] ${labelText("importInfo")}`,
      `> ${labelText("filesLabel")}${paths.length} · ${labelText("modeLabel")}${meta.prefix} · ${labelText("transcriptionLabel")}${labelText("wholeFile")}${speakerModeLabel}`,
      `> ${labelText("modelLabel")}${importProvider.model || importProvider.id} → ${this.host.settings.llmModel}`,
      externalSource && externalSource.name ? `> ${labelText("sourceLabel")}${t("Auto Import")} · ${externalSource.name}` : null,
      "",
      nsMarker("session", session.id),
      nsMarker("segments-start", session.id),
      nsMarker("segments-end", session.id),
      "",
    ].filter((line) => line !== null).join("\n");
    await this.host.noteWriter.appendToNote(mdPath, header);

    new obsidian.Notice(`${t("Starting import of ")}${paths.length}${t(" audio files...")}`);
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
        label: t("Import task created"),
        detail: t("Whole-file transcription · {0}{1}").replace("{0}", importProfile.title || importProvider.id).replace("{1}", speakerModeLabel),
      },
    });

    let cumOffsetMs = 0;
    let processedFiles = 0;
    let successfulTranscriptions = 0;
    for (let i = 0; i < paths.length; i++) {
      const audioPath = paths[i];
      const indexedFile = this.host.app.vault.getAbstractFileByPath(audioPath);
      const externalCache = !!externalSource && this.host.asrPipeline.isSegmentCachePath(audioPath);
      const adapter = this.host.app.vault.adapter;
      const sourceExists = indexedFile instanceof obsidian.TFile
        || (externalCache && await adapter.exists(obsidian.normalizePath(audioPath)));
      if (!sourceExists) {
        new obsidian.Notice(`${t("Skipped: ")}${externalSource && externalSource.name ? externalSource.name : audioPath}${t(" not found")}`);
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
        label: `${t("Preparing audio ")}${i + 1}/${paths.length}`,
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
          new obsidian.Notice(`${t("Skipped: ")}${displayName}${t(" is an empty file (0 bytes). Make sure the download finished, then try again.")}`, 9000);
          await this.host.diagnostics.logDiagnostic("warn", "import.empty_file", t("Imported audio file is empty."), { audioName: displayName, size: 0 });
          continue;
        }
        mime = mimeFromExt(file.extension);
        blob = new Blob([ab], { type: mime });
        durationMs = await getAudioDurationMs(blob);
        if (speakerDiarization && durationMs > 2 * 60 * 60 * 1000 && isDashScopeFileTransProvider(importProvider)) {
          new obsidian.Notice(t("This audio exceeds 2 hours. It will still be submitted as a whole file, but Alibaba Cloud recommends keeping speaker separation files under 2 hours."), 9000);
        }
        if (paths.length === 1 && keepSourceAudio) {
          session.masterAudioName = displayName;
          session.masterAudioPath = audioPath;
        }
      } catch (error) {
        console.error(error);
        new obsidian.Notice(t("Failed to read: {0}").replace("{0}", String(displayName)));
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
          label: `${t("Starting transcription of ")}${displayName}`,
          detail: t("Submitted as a whole file; not split into multiple ASR tasks."),
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
          const mismatchMessage = t("{0} speakers were specified, but the model distinguished {1}").replace("{0}", String(speakerCount)).replace("{1}", String(detectedSpeakerIds.length));
          new obsidian.Notice(
            t("{0} speakers were specified, but the model distinguished {1}. The original transcript is preserved; check it in the speaker editor.")
              .replace("{0}", String(speakerCount))
              .replace("{1}", String(detectedSpeakerIds.length)),
            9000,
          );
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
              detail: t("Speakers' voices may be similar or overlap; review the original transcript."),
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
          await this.host.asrPipeline.maybeDeleteSegmentCacheFile(audioPath, undefined, true);
        }
      } catch (caught) {
        const originalError = caught instanceof Error ? caught : new Error(String(caught));
        const exceedsDiarizationRecommendation = speakerDiarization
          && durationMs > 2 * 60 * 60 * 1000
          && isDashScopeFileTransProvider(importProvider);
        error = exceedsDiarizationRecommendation
          ? new Error(t("{0}. This file exceeds the 2 hours recommended for speaker separation; turn off \"Distinguish speakers\" and retry.").replace("{0}", originalError.message))
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
        await this.host.diagnostics.logDiagnostic("error", "asr.import_whole_file_failed", t("Whole-file transcription of the imported audio failed."), {
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

      const visibleText = error
        ? getTranscribeSegmentPlaceholder(error, { retryable: true })
        : (result?.text || labelText("noContentAudio"));
      const segmentRecord = attachTranscriptResult({
        index: segIndex,
        startOffsetMs,
        endOffsetMs,
        audioName: keepSourceAudio ? displayName : "",
        audioPath: keepSourceAudio ? audioPath : "",
        segmentAudioName: keepSourceAudio || error ? displayName : "",
        segmentAudioPath: keepSourceAudio || error ? audioPath : "",
        text: result ? result.text : "",
        error: error ? error.message : null,
        isFinal,
        source: "import",
        queueTaskId: retryTask ? retryTask.id : undefined,
      }, session.id, error ? null : result, "asr");
      session.segments.push(segmentRecord);

      const audioAnchor = keepSourceAudio ? getAudioTimeLink(displayName, startOffsetMs) : "";
      const heading = `### ${labelText("audio", segIndex + 1)}${audioAnchor ? ` ${audioAnchor}` : ""}${isFinal ? " · 结束" : ""}${retryTask ? `\n\n${nsMarker("transcribe-task", retryTask.id)}` : ""}`;
      const block = `\n${serializeTranscriptBlock(segmentRecord, heading, visibleText)}\n`;
      await this.host.noteWriter.insertBeforeSegmentsEnd(session.mdPath, block, session.id);

      this.host.tasks.updateImportActivity({
        done: i + 1,
        writtenSegments: session.segments.length,
        prepareDone: i + 1,
      });
      cumOffsetMs = endOffsetMs;
    }

    if (processedFiles === 0) {
      const error = new Error(t("There are no audio files to process."));
      this.host.tasks.updateImportActivity({ error: error.message });
      this.host.tasks._importBusy = null;
      this.host.tasks.updateBusyStatus();
      throw error;
    }

    this.host.sessionStore.begin(session);
    const pendingTranscriptionCount = session.segments.filter((segment) => !!segment.error).length;
    if (successfulTranscriptions === 0) {
      const message = pendingTranscriptionCount > 0
        ? t("Speech transcription is incomplete; the audio file is kept, so you can retry from the processing progress.")
        : t("No valid transcript text was obtained for organizing.");
      this.host.tasks.updateImportActivity({
        phase: "transcribe",
        error: message,
        label: t("Speech transcription not completed"),
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
      throw new Error(t("The corresponding note was not found after writing the original transcript; AI organizing stopped."));
    }
    const persistedMarkdown = await this.host.app.vault.read(transcriptFile);
    const transcriptCheckpoint = verifyTranscriptCheckpoint(persistedMarkdown, session.segments);
    if (!transcriptCheckpoint.ok) {
      const checkpointError = new Error(
        t("The original transcript was not fully written to the note ({0}/{1}); AI organizing stopped.")
          .replace("{0}", String(transcriptCheckpoint.persistedSegments))
          .replace("{1}", String(transcriptCheckpoint.expectedSegments)),
      );
      this.host.tasks.updateImportActivity({
        phase: "persist",
        error: checkpointError.message,
        label: t("Original transcript write did not complete"),
      });
      await this.host.diagnostics.logDiagnostic("error", "asr.import_transcript_checkpoint_failed", t("Imported audio transcript checkpoint validation failed."), {
        mdPath: session.mdPath,
        expectedSegments: transcriptCheckpoint.expectedSegments,
        persistedSegments: transcriptCheckpoint.persistedSegments,
        expectedChars: transcriptCheckpoint.expectedChars,
        missingSegmentIndexes: transcriptCheckpoint.missingSegmentIndexes,
      });
      throw checkpointError;
    }
    await this.host.diagnostics.logDiagnostic("info", "asr.import_transcript_persisted", t("Imported audio transcript written; allowing AI organizing to proceed."), {
      mdPath: session.mdPath,
      segmentCount: transcriptCheckpoint.expectedSegments,
      transcriptChars: transcriptCheckpoint.expectedChars,
      provider: importProvider.id,
    });
    this.host.tasks.updateImportActivity({
      phase: "organize",
      organizeLabel: t("Preparing AI organizing"),
      organizeDetail: t("The original transcript has been fully written; generating the body from the current minutes template."),
    });
    await this.host.sessionFinalize.finalizeSession(session);
    const finalizationError = String(session.finalizationError || "").trim()
      || (session.workProgress && session.workProgress.stage === "transcript-empty"
        ? t("No valid transcript text was obtained for organizing.")
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
        writeLabel: t("Processing complete"),
        writeDetail: t("The minutes have been written to Obsidian."),
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
        new obsidian.Notice(`${t("Skipped: ")}${textPath}${t(" is not importable text")}`);
        continue;
      }
      try {
        const raw = await this.host.app.vault.read(file);
        const text = stripImportedTextSource(raw);
        if (!text) {
          new obsidian.Notice(`${t("Skipped empty text: ")}${file.name}`);
          continue;
        }
        sources.push({ file, path: file.path, name: file.name, text });
      } catch (e) {
        console.error("[QnALog] import text read failed", e);
        new obsidian.Notice(t("Failed to read: {0}").replace("{0}", String(file.name)));
      }
    }
    if (!sources.length) {
      new obsidian.Notice(t("No text content to process"));
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
      await this.host.diagnostics.logDiagnostic("warn", "text_import.llm_config_missing", t("LLM configuration is incomplete before text import."), {
        mode,
        llmRoute: "composer.chat-completions",
        llmEndpoint: this.host.settings.llmEndpoint || "",
        llmModel: this.host.settings.llmModel ? "<set>" : "",
        issue: llmIssue,
      });
      new obsidian.Notice(`${t("Importing text requires LLM configuration first: ")}${formatLlmConfigIssue(llmIssue)}`, 9000);
      return;
    }

    await ensureVaultFolder(this.host.app, this.host.settings.mdFolder);
    const mdName = `${startedAt.format(this.host.settings.noteFileNameFormatNew)} · ${t("Text import")}`;
    const mdPath = findAvailableMarkdownPath(this.host.app, obsidian.normalizePath(`${this.host.settings.mdFolder}/${mdName}.md`));
    if (!mdPath) throw new Error(t("Could not generate a path for the text import note."));

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
    this.host.asrPipeline.initializeSession(session);

    const header = [
      `# ${startedAt.format("YYYY-MM-DD HH:mm")} · ${meta.prefix}${labelText("textImporting")}`,
      "",
      `> [!info] ${labelText("textImportInfo")}`,
      `> ${labelText("sourceFilesLabel")}${sources.length} · ${labelText("modeLabel")}${meta.prefix} · ${labelText("modelLabel")}${this.host.settings.llmModel}`,
      "",
      nsMarker("session", session.id),
      nsMarker("segments-start", session.id),
      nsMarker("segments-end", session.id),
      "",
    ].join("\n");
    await this.host.noteWriter.appendToNote(mdPath, header);
    this.host.sessionStore.begin(session);
    this.host.asrPipeline.setSessionWorkProgress(session, {
      stage: "text-import",
      label: t("Read text"),
      percent: 8,
      detail: t("Read {0} text sources, ready for AI organizing.").replace("{0}", String(sources.length)),
    });
    this.host.shell.refreshOutlineView();
    try { await this.host.shell.openOutlineView(); } catch (e) { console.warn("[QnALog] open outline for text import failed", e); }

    session.segments = splitImportedTextIntoNormalSegments(sources)
      .map((segment) => attachTextTranscript(segment, session.id, "text-import"));

    for (const seg of session.segments) {
      const heading = `### ${labelText("textSource", seg.index + 1)}[[${seg.sourcePath}|${seg.sourceName}]]`;
      const visibleText = seg.rawText ?? labelText("emptyTextSource");
      const block = `\n${serializeTranscriptBlock(seg, heading, visibleText)}\n`;
      await this.host.noteWriter.insertBeforeSegmentsEnd(session.mdPath, block, session.id);
    }

    this.host.shell.refreshOutlineView();
    new obsidian.Notice(`${t("Starting organizing of ")}${sources.length}${t(" text items: uses the AI organizing service, not speech transcription.")}`);
    await this.host.sessionFinalize.finalizeSession(session);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
