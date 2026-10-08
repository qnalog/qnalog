/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：会话收尾：分段转写与沉淀、说话人姓名确认、正文与版本落盘

import * as obsidian from "obsidian";
import { SpeakerNameConfirmModal } from "../ui/modals";
import { transcribeAudio } from "../asr/transcribe";
import { readFileFrontmatter } from "../shared/util-note";
import { loadVocabularyGroups, applyVocabularyCorrections } from "../vocabulary";
import { getLlmConfigIssue, formatLlmFailureIssue } from "../llm/core";
import { isLlmNonRetryableError } from "../llm/failure-policy";
import type { PluginSettings, RecordingSession, PreparedLiveSegment, SessionMetaForMerge, Segment } from "../shared/types";
import type { LiveAsrPipelineService } from "../asr/live-asr-pipeline-service";
import { getErrorMessage, pad, formatElapsed } from "../shared/util-common";
import { mimeFromExt, getTranscribeSegmentPlaceholder, isTransientAsrError } from "../shared/util-audio";
import { createLiveAsrCircuitState, isLiveAsrCircuitOpen } from "../asr/live-segment-policy";
import { diagnosticError } from "../shared/util-key-diag";
import { DEFAULT_SPEAKER_CHANNELS, MAX_SPEAKER_CHANNELS, buildSpeakerMappings, initialAudioChannelRuntimeMode, normalizeAudioChannelMode, normalizeSpeakerMappings, readSpeakerMappings, replaceSpeakerDisplayName, resolveAudioChannelRuntimeMode } from "../audio/channel-speakers";
import type { SpeakerId } from "../audio/channel-speakers";
import { transcribeAudioByChannels } from "../asr/channel-transcription";
import { applySpeakerNamesForLlm, buildConfirmedSpeakerMappings, collectSpeakerCandidates } from "../asr/speaker-mapping";
import { isSpeakerDiarizationProvider } from "../asr/diarization";
import { BriefingPipelineIncompleteError } from "../briefing/pipeline";
import { isTextImportSession, shouldRewriteConsolidatedNote } from "../briefing/note-layout-policy";
import { classifyRecordingIssue } from "../notes/recording-issues";
import { clearCommittedBriefingCheckpoint } from "../prompts/briefing-prompts";
import { normalizeMeetingWorkbench } from "../notes/meeting-workbench";
import { getAudioTimeLink, getSegmentsDurationMs } from "../notes/audio-refs";
import { buildTitleSourceFromSegments, normalizeSegmentsForMergedNote } from "../notes/note-markdown";
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
import { NS_AUDIO_PREFIX, NS_FM_SPEAKERS, nsMarker } from "../shared/namespace";
import { SHORT_RECORDING_SKIP_NOTE_MS } from "../shared/limits";

import { t } from "../shared/i18n";
import type { AsrTranscriptResult, AsrTranscriptUnit } from "../asr/transcript-result";
import { attachTranscriptResult, getCurrentTranscript, splitTranscriptTextUnits } from "../transcript/session-transcript";
import { readSessionKnowledge } from "../briefing/session-knowledge";
import { serializeTranscriptBlock } from "../transcript/transcript-markdown";
import { bindTranscriptSegmentToAudio } from "../transcript/audio-binding";
import { readTranscriptBlocks, replaceTranscriptBlock } from "../transcript/transcript-markdown";
import { labelText } from "../shared/note-labels";
import type { ContinuationService } from "../session/continuation-service";
import type { SessionStore } from "../session/session-store";
import type { SessionFinalizeFlowHost } from "./session-finalize-flow";
import { finalizeSessionFlow } from "./session-finalize-flow";
/** SessionFinalizeService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
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

  async processSegment(session: RecordingSession, seg: PreparedLiveSegment) {
    if (!session) return;
    if (seg && seg.isFinal && seg.masterOnly && !session.shortRecordingTier) {
      // 分段 recorder 已失效但独立 masterRecorder 仍拿到了完整录音。
      // 这里只保存母带并推进最终整理，不能把整场母带再次当作最后一段转写，
      // 否则前面已转写的内容会重复、并额外产生一次整场 ASR 费用。
      if (seg.masterAudioSavePromise != null) await seg.masterAudioSavePromise;
      else await this.host.asrPipeline.saveMasterAudio(session, seg);
      this.host.asrPipeline.setSessionWorkProgress(session, {
        stage: "transcribe-finalized",
        label: t("Finalizing transcription"),
        percent: null,
        detail: t("Segmented recording has stopped; the full recording has been kept; organizing the transcription collected so far"),
      });
      try {
        await this.host.diagnostics.logDiagnostic("warn", "recording.master_only_finalize", t("The last segment was unavailable; the full recording was saved and the transcription collected so far is being organized"), {
          mode: session.mode,
          segmentCount: Array.isArray(session.segments) ? session.segments.length : 0,
          endOffsetMs: Number(seg.endOffsetMs) || 0,
        });
      } catch { /* intentionally empty */ }
      this.host.requestOutlineRefresh();
      return;
    }
    if (session.shortRecordingTier) {
      // 短录音：音频（只留音频级别）已由 handleSegment 交给 saveMasterAudio 落盘，
      // 这里只等它结束，后续收尾会按 shortRecordingTier 删掉结尾创建的纪要。
      if (seg && seg.masterAudioSavePromise != null) await seg.masterAudioSavePromise;
      await this.host.asrPipeline.closeStreamingForDiscard(session);
      return;
    }
    const continuationOffsetMs = Math.max(0, Number(session.continuationOffsetMs) || 0);
    const baseSegmentCount = Array.isArray(session.continuationBaseSegments) ? session.continuationBaseSegments.length : 0;
    const segmentIndex = Number.isFinite(Number(seg.segmentIndex))
      ? Number(seg.segmentIndex)
      : baseSegmentCount + (Array.isArray(session.segments) ? session.segments.length : 0);
    const segNumber = Number.isFinite(Number(seg.segNumber)) ? Number(seg.segNumber) : segmentIndex + 1;
    const displayStartOffsetMs = Number.isFinite(Number(seg.displayStartOffsetMs))
      ? Number(seg.displayStartOffsetMs)
      : Math.max(0, Number(seg.startOffsetMs) || 0) + continuationOffsetMs;
    const displayEndOffsetMs = Number.isFinite(Number(seg.displayEndOffsetMs))
      ? Number(seg.displayEndOffsetMs)
      : Math.max(displayStartOffsetMs, (Number(seg.endOffsetMs) || 0) + continuationOffsetMs);
    const segmentAudioName = seg.segmentAudioName || `${NS_AUDIO_PREFIX}-${session.sessionStamp}-seg${pad(segNumber)}.${seg.ext}`;
    const segmentAudioPath = seg.segmentAudioPath || obsidian.normalizePath(`${this.host.asrPipeline.getSegmentCacheFolder()}/${segmentAudioName}`);
    const segmentDurationMs = Math.max(0, displayEndOffsetMs - displayStartOffsetMs);

    let spoolResult = null;
    if (seg.spoolPromise != null) {
      spoolResult = await seg.spoolPromise;
    } else if (seg.blob) {
      try {
        await this.host.asrPipeline.ensureSegmentCacheFolder();
        await this.host.app.vault.adapter.writeBinary(segmentAudioPath, await seg.blob.arrayBuffer());
        spoolResult = { persisted: true, fallbackBlob: null, error: null };
      } catch (e) {
        spoolResult = { persisted: false, fallbackBlob: seg.blob, error: e };
        console.error(e);
        new obsidian.Notice(`${t(" segments")}${segNumber}${t(" audio write failed: ")}${(e && e.message) || e}`);
      }
    }
    if (spoolResult && spoolResult.queueTaskId) seg.queueTaskId = spoolResult.queueTaskId;
    await this.host.asrPipeline.markLiveSegmentQueueTaskRunning(seg);
    const liveJob = seg.jobId ? this.host.asrPipeline.getLiveAsrJobs(session).get(seg.jobId) : null;
    if (liveJob) liveJob.state = "transcribing";
    this.host.asrPipeline.updateLiveAsrBacklogPolicy(session, "transcribing");
    if (seg.masterAudioSavePromise != null) await seg.masterAudioSavePromise;
    else if (seg.isFinal) await this.host.asrPipeline.saveMasterAudio(session, seg);

    let text = ""; let err = null;
    let transcribeBlob = null;
    let channelTranscription = null;
    let asrResult: AsrTranscriptResult | null = null;
    let streamingRawText = "";
    let batchAsrAttempted = false;
    let batchAsrFailureRecorded = false;
    const activeProfile = this.host.profiles.getActiveTranscribeProfile();
    const isStreamingProvider = activeProfile && activeProfile.transcribeMode === "streaming";
    this.host.asrPipeline.setSessionWorkProgress(session, {
      stage: "transcribing",
      label: `${t("Transcript segment ")}${segNumber}${t(" segments")}`,
      percent: null,
      detail: t("Audio is being sent to the transcription service"),
    });
    if (session.streamingClient) {
      // 流式转写：跳过 HTTP 切片转写，等流式客户端 finish 后取累计文本
      try {
        if (session.pcmEncoder) { try { session.pcmEncoder.stop(); } catch { /* intentionally empty */ } session.pcmEncoder = null; }
        await session.streamingClient.finish();
        streamingRawText = session.streamingClient.getFullText() || session.streamingFullText || "";
        text = streamingRawText;
      } catch (e) {
        err = e;
        console.error("[QnALog] streaming finish failed", e);
        streamingRawText = session.streamingFullText || "";
        text = streamingRawText;
      }
      let vocabularyGroups = null;
      try {
        vocabularyGroups = await loadVocabularyGroups(this.host);
        text = applyVocabularyCorrections(text, vocabularyGroups);
      } catch { /* keep the service text when vocabulary storage is unavailable */ }
      if (!err) {
        const rawStreamText = streamingRawText;
        const units: AsrTranscriptUnit[] = splitTranscriptTextUnits(rawStreamText).map((rawText) => ({
          rawText,
          normalizedText: vocabularyGroups ? applyVocabularyCorrections(rawText, vocabularyGroups) : rawText,
          speakerId: null,
          speakerName: null,
          startMs: null,
          endMs: null,
          timing: "unknown",
        }));
        asrResult = {
          text,
          rawText: rawStreamText,
          providerId: String(activeProfile && activeProfile.id || session.importTranscribeProviderId || this.host.settings.activeTranscribeProvider || ""),
          units,
        };
      }
      try { await this.host.meetingWorkbench.removeLiveTranscriptBlock(session.mdPath, session.id); } catch { /* intentionally empty */ }
      session.streamingClient = null;
    } else if (isStreamingProvider) {
      // 流式服务但客户端连接失败：保留音频但不做 HTTP 切片转写（端点是 wss://，HTTP 必失败）
      err = new Error(t("The streaming transcription connection could not be established. Check your API key and network, then record again."));
      console.error("[QnALog]", err.message);
    } else {
      const circuitOpen = isLiveAsrCircuitOpen(session.asrCircuitState || createLiveAsrCircuitState())
        || this.host.asrPipeline.isAsrServiceCircuitOpen();
      if (session.asrDeferredMode || circuitOpen) {
        err = new Error(session.asrDeferredMode
          ? t("Realtime transcription backlog exceeded the safety threshold and has moved to the background queue")
          : t("The transcription service is in a brief cooldown; work has moved to the background queue"));
        err.asrDeferred = true;
        err.deferReason = session.asrDeferredMode ? "backlog-critical" : "circuit-open";
      } else {
        transcribeBlob = spoolResult && spoolResult.fallbackBlob ? spoolResult.fallbackBlob : null;
        if (!transcribeBlob && spoolResult && spoolResult.persisted) {
          const cachedAudio = await this.host.readVaultAudioBlob(segmentAudioPath, segmentAudioName);
          transcribeBlob = cachedAudio && cachedAudio.blob;
        }
        if (!transcribeBlob && seg.blob) transcribeBlob = seg.blob;
        if (!transcribeBlob) {
          err = new Error(t("The recorded segment cache could not be read; the background retry task has been kept"));
        } else {
          batchAsrAttempted = true;
          try {
            const transcribeMime = transcribeBlob.type || seg.blobType || mimeFromExt(seg.ext);
            const reportedChannelCount = session.captureMode === "mic"
              ? Math.max(1, Number(session.audioChannelCount) || 1)
              : 1;
            const channelMode = normalizeAudioChannelMode(session.audioChannelMode || this.host.settings.audioChannelMode);
            const runtimeChannelMode = session.audioChannelRuntimeMode
              || initialAudioChannelRuntimeMode(channelMode, reportedChannelCount);
            const inspectRecordedChannels = session.captureMode === "mic"
              && runtimeChannelMode !== "mono"
              && activeProfile?.transcribeMode !== "whole-file";
            // Only probe an auto-mode device until independent channel content is
            // confirmed. Once resolved, the session stays on one stable path.
            const expectedChannels = inspectRecordedChannels ? MAX_SPEAKER_CHANNELS : 1;
            if (inspectRecordedChannels) {
              channelTranscription = await transcribeAudioByChannels(
                this.host,
                transcribeBlob,
                transcribeMime,
                expectedChannels,
                { requireSeparatedChannels: channelMode === "auto" && runtimeChannelMode === "probing" },
              );
              text = channelTranscription.text;
              asrResult = channelTranscription;
              session.audioChannelCount = channelTranscription.actualChannelCount;
              session.audioChannelRuntimeMode = resolveAudioChannelRuntimeMode({
                channelMode,
                current: runtimeChannelMode,
                separation: channelTranscription.separation,
                usedMultichannel: channelTranscription.usedMultichannel,
              });
              session.channelSeparationMode = channelTranscription.usedMultichannel
                ? "device-channels"
                : session.audioChannelRuntimeMode === "probing"
                  ? "pending"
                  : channelTranscription.separation === "duplicated"
                    ? "duplicated-input"
                    : channelTranscription.actualChannelCount <= 1
                      ? "single"
                      : "encoder-downmix";
              session.speakerChannels = channelTranscription.usedMultichannel
                ? buildSpeakerMappings(channelTranscription.processedChannelCount, session.speakerChannels)
                : {};
              // 说话人确认要在转写完成时就让用户看见，否则改名入口只是静静挂在纪要页上没人发现。
              if (channelTranscription.usedMultichannel && !session._channelSpeakersNotified) {
                session._channelSpeakersNotified = true;
                new obsidian.Notice(
                  t("Separated {0} speakers by channel. You can enter their names at the top of the note.").replace("{0}", String(channelTranscription.processedChannelCount)),
                  9000,
                );
              }
              if (channelTranscription.deduplicatedParts > 0) {
                session.channelCrosstalkDeduplicated = Math.max(0, Number(session.channelCrosstalkDeduplicated) || 0)
                  + channelTranscription.deduplicatedParts;
                await this.host.diagnostics.logDiagnostic("info", "asr.channel_crosstalk_deduplicated", t("Cross-channel duplicate transcription removed"), {
                  segmentIndex,
                  removedParts: channelTranscription.deduplicatedParts,
                  totalRemovedParts: session.channelCrosstalkDeduplicated,
                });
              }
              if (channelMode === "multichannel"
                && channelTranscription.separation === "duplicated"
                && !session._channelDuplicatedNotified) {
                session._channelDuplicatedNotified = true;
                new obsidian.Notice(t("All channels have identical content; transcribed as mono. Please change the receiver output to \"Stereo\" and try again."), 10000);
                await this.host.diagnostics.logDiagnostic("warn", "asr.channel_content_duplicated", t("Recording channels had duplicate content; fell back to mono transcription"), {
                  actualChannelCount: channelTranscription.actualChannelCount,
                  inputLabel: session.audioChannelLabel || "",
                });
              }
              // 降混告警的「应有声道数」取设备实际协商值；用户选了多声道时至少期望 2，
              // 避免用处理上限（4）去比对双发设备而误报。
              const expectedHardwareChannels = channelMode === "multichannel"
                ? Math.max(reportedChannelCount, DEFAULT_SPEAKER_CHANNELS)
                : reportedChannelCount;
              if (channelMode === "multichannel"
                && expectedHardwareChannels > 1
                && channelTranscription.actualChannelCount < expectedHardwareChannels
                && !session._channelDownmixNotified) {
                session._channelDownmixNotified = true;
                const actual = channelTranscription.actualChannelCount;
                new obsidian.Notice(actual > 1
                  ? t("Detected {0} available channel(s); speakers will be separated by channel.").replace("{0}", String(actual))
                  : t("The input device has multiple channels, but the recording file is mono; transcription will proceed in mono."), 9000);
                await this.host.diagnostics.logDiagnostic("warn", "asr.channel_encoder_downmix", t("The recording encoding kept fewer channels than the device input"), {
                  expectedChannelCount: expectedHardwareChannels,
                  actualChannelCount: actual,
                  inputLabel: session.audioChannelLabel || "",
                });
              }
              if (channelTranscription.errors.length) {
                await this.host.diagnostics.logDiagnostic("warn", "asr.channel_partial_failure", t("Some channels failed to transcribe; content from the other channels was kept"), {
                  segmentIndex,
                  channelCount: channelTranscription.actualChannelCount,
                  errors: channelTranscription.errors,
                });
              }
            } else {
              asrResult = await transcribeAudio(this.host, transcribeBlob, transcribeMime);
              text = asrResult.text;
            }
          } catch (e) {
            err = e;
            batchAsrFailureRecorded = true;
            this.host.asrPipeline.recordLiveAsrAttemptFailure(session, e, seg);
            console.error(e);
          }
        }
      }
    }
    if (!err && !String(text || "").trim() && segmentDurationMs >= 30 * 1000) {
      // HTTP 200 + 空正文并不等于成功。对长段按可重试软失败处理并保留切片，
      // 与导入音频路径保持一致，避免服务偶发空结果被静默写成“无内容”。
      err = new Error(t("Transcription returned an empty result (the service responded but returned no text)"));
      asrResult = null;
      if (batchAsrAttempted && !batchAsrFailureRecorded) {
        batchAsrFailureRecorded = true;
        this.host.asrPipeline.recordLiveAsrAttemptFailure(session, err, seg);
      }
      try {
        await this.host.diagnostics.logDiagnostic("warn", "asr.segment_empty", t("A recorded segment returned an empty transcription; it was kept as a soft failure and queued"), {
          segmentIndex,
          startOffsetMs: displayStartOffsetMs,
          endOffsetMs: displayEndOffsetMs,
          durationMs: segmentDurationMs,
          mode: session.mode,
        });
      } catch { /* intentionally empty */ }
    }
    if (!err && batchAsrAttempted) this.host.asrPipeline.recordLiveAsrAttemptSuccess(session);
    if (err) {
      if (err.asrDeferred) {
        await this.host.diagnostics.logDiagnostic("warn", "asr.segment_deferred", t("The recorded segment skipped the realtime request and moved to the background queue"), {
          segmentIndex,
          startOffsetMs: displayStartOffsetMs,
          endOffsetMs: displayEndOffsetMs,
          durationMs: segmentDurationMs,
          reason: err.deferReason || "deferred",
          pendingDurationMs: this.host.asrPipeline.getLiveAsrBacklogSummary(session).totalDurationMs,
        });
      } else {
        const issueKind = classifyRecordingIssue(err);
        this.host.asrPipeline.setRecordingIssue(issueKind, {
          source: "asr",
          message: getErrorMessage(err),
          startedAtMs: displayStartOffsetMs,
        });
        await this.host.diagnostics.logDiagnostic("error", "asr.segment_failed", t("Transcription failed for a recorded segment"), {
          provider: this.host.settings.activeTranscribeProvider,
          model: this.host.profiles.getActiveTranscribeProfile() && this.host.profiles.getActiveTranscribeProfile().model,
          mime: (transcribeBlob && transcribeBlob.type) || seg.blobType || "",
          size: (transcribeBlob && transcribeBlob.size) || seg.blobSize || 0,
          segmentIndex,
          startOffsetMs: displayStartOffsetMs,
          endOffsetMs: displayEndOffsetMs,
          mode: session.mode,
          error: diagnosticError(err),
        });
        new obsidian.Notice(isStreamingProvider
          ? t("Segment {0} failed to transcribe in streaming mode and cannot be retried offline; recording continues locally. Use \"Re-organize\" when the whole recording finishes, or record that segment again.").replace("{0}", String(segNumber))
          : (!String(text || "").trim()
            ? t("Segment {0} returned no text; the audio slice has been kept and queued for retry.").replace("{0}", String(segNumber))
            : t("Segment {0} failed to transcribe; recording continues locally and it has been queued for retry.").replace("{0}", String(segNumber))), 7000);
      }
    } else if (!text || !String(text).trim()) {
      // 转写成功返回，但内容为空 → 可能音频设备没选对 / 没有声音。
      // 请求既然成功返回，网络/服务是通的，清掉遗留横幅。
      this.host.asrPipeline.clearRecordingIssue("network");
      this.host.asrPipeline.clearRecordingIssue("service");
      // 防误报：只在"本场此前从未产生过任何非空转写"时提示。
      // 否则会议中途的合理静默段（开头/中场没人说话）会骚扰正在正常录音的用户。
      const hadAnyText = Array.isArray(session.segments) && session.segments.some((s) => s && s.text && String(s.text).trim());
      await this.host.diagnostics.logDiagnostic("warn", "asr.empty_result", t("This segment has no transcription"), {
        segmentIndex, mode: session.mode, hadAnyText,
      });
      if (!hadAnyText && !session._emptyAsrNotified) {
        session._emptyAsrNotified = true;
        new obsidian.Notice(t("No speech detected in this segment. Go to \"Settings → General → Audio input\" to test the selected device."), 9000);
      }
    } else {
      this.host.asrPipeline.clearRecordingIssue("network");
      this.host.asrPipeline.clearRecordingIssue("service");
    }

    const playbackAudioName = session.masterAudioName || segmentAudioName;
    const playbackAudioPath = session.masterAudioPath || segmentAudioPath;
    let segmentRecord: Segment = {
      index: segmentIndex,
      startOffsetMs: displayStartOffsetMs,
      endOffsetMs: displayEndOffsetMs,
      audioStartOffsetMs: Math.max(0, Number(seg.startOffsetMs) || 0),
      audioEndOffsetMs: Math.max(0, Number(seg.endOffsetMs) || 0),
      audioName: playbackAudioName,
      audioPath: playbackAudioPath,
      segmentAudioName,
      segmentAudioPath,
      text,
      error: err ? (err.message || String(err)) : null,
      isFinal: !!seg.isFinal,
      // 音源标记（HR 模式 / 角色识别基础）：
      //   mic           = 麦克风端
      //   virtualCable  = 电脑音频端（线上面试场景下通常是对面候选人）
      //   mix-virtual   = 当前是混合录音，分不清；后续提交里会改成双 stream 分别打标
      // seg.source 优先（来自 RecordSession 未来的双流路径），fallback 到 session.captureMode
      source: (seg && seg.source) || session.captureMode || "mic",
    };
    const segmentArrayIndex = session.segments.length;
    session.segments.push(segmentRecord);

    if (err && !isStreamingProvider) {
      // 流式 provider(endpoint 是 wss://)的失败段不入 transcribe 重试队列——重试走 HTTP 必然再失败、
      // 把任务卡在 failed 永远清不掉。流式无法离线重切重传，留在笔记里标失败即可。
      if (err.asrDeferred || isTransientAsrError(err)) this.host.asrPipeline.markSessionAsrJobsDeferred(session);
      const retryTask = await this.host.asrPipeline.keepLiveSegmentQueueTaskForRetry(session, Object.assign({}, seg, {
        segmentAudioPath,
        segmentAudioName,
        segmentIndex,
        displayStartOffsetMs,
        displayEndOffsetMs,
      }), err);
      segmentRecord.queueTaskId = retryTask.id;
    }
    const visibleText = err ? getTranscribeSegmentPlaceholder(err, {
      streaming: isStreamingProvider,
      deferred: !!err.asrDeferred,
      retryable: !isStreamingProvider && (err.asrDeferred || isTransientAsrError(err)),
    }) : (text ? text : labelText("noContentSegment"));
    segmentRecord = attachTranscriptResult(
      segmentRecord,
      session.id,
      err ? null : asrResult,
      isStreamingProvider ? "streaming-transcript" : "asr",
    );
    session.segments[segmentArrayIndex] = segmentRecord;

    const segTitle = `### ${labelText("segment", segNumber)} (${formatElapsed(displayStartOffsetMs)}–${formatElapsed(displayEndOffsetMs)}) ${getAudioTimeLink(playbackAudioName, Math.max(0, Number(seg.startOffsetMs) || 0))}${seg.isFinal ? " · 结束" : ""}`;
    const heading = [segTitle, segmentRecord.queueTaskId ? nsMarker("transcribe-task", segmentRecord.queueTaskId) : ""]
      .filter(Boolean)
      .join("\n\n");
    const block = `\n${serializeTranscriptBlock(segmentRecord, heading, visibleText)}\n`;
    await this.host.noteWriter.insertBeforeSegmentsEnd(session.mdPath, block, session.id);
    if (!err || isStreamingProvider) await this.host.asrPipeline.removeLiveSegmentQueueTask(seg);

    this.host.requestOutlineRefresh();
    this.host.asrPipeline.setSessionWorkProgress(session, {
      stage: seg.isFinal ? "transcribe-finalized" : "transcribed",
      label: seg.isFinal ? t("Finalizing transcription") : (err && err.asrDeferred ? t("Cached {0} segments").replace("{0}", String(session.segments.length)) : t("Transcribed {0} segments").replace("{0}", String(session.segments.length))),
      percent: null,
      detail: seg.isFinal ? t("Starting AI organizing") : (err && err.asrDeferred ? t("Audio saved to disk; waiting for background transcription retry") : t("Segment transcriptions have been written to the note")),
    });

    if (!seg.isFinal && text && String(text).trim()) new obsidian.Notice(`${t(" segments ")}${segNumber}${t(" transcribed")}`);

    if (this.host.settings.enableRealtimeOutline && text && !err) {
      this.host.outline.scheduleRealtimeOutline();
    }
  }

  async syncTranscriptAudioSource(session: RecordingSession): Promise<void> {
    const masterPath = String(session && session.masterAudioPath || "");
    if (!masterPath) return;
    const segments = Array.isArray(session.segments) ? session.segments : [];
    const updated = segments.map((segment) => bindTranscriptSegmentToAudio(segment, masterPath, String(session.masterAudioName || masterPath.split("/").pop() || "")));
    const changed = updated.filter((segment, index) => segment !== segments[index] && segment.transcript);
    if (!changed.length) return;
    const file = this.host.app.vault.getAbstractFileByPath(session.mdPath);
    if (!(file instanceof obsidian.TFile)) throw new Error("Cannot bind transcript sources without the session note");
    const markdown = await this.host.app.vault.read(file);
    const blocks = readTranscriptBlocks(markdown);
    const replacements = changed.map((segment) => {
      const id = segment.transcript.id;
      const matches = blocks.filter((block) => block.segment.transcript?.id === id);
      if (matches.length !== 1) throw new Error(`Expected one transcript block for source ${id}; found ${matches.length}`);
      if (matches[0].drifted) throw new Error(`Transcript block ${id} was edited before final audio binding`);
      return { block: matches[0], segment };
    }).sort((left, right) => right.block.start - left.block.start);
    let next = markdown;
    for (const replacement of replacements) {
      next = replaceTranscriptBlock(next, replacement.block, replacement.segment, replacement.block.visibleBlock);
    }
    if (next !== markdown) await this.host.app.vault.modify(file, next);
    session.segments = updated;
  }

  getSegmentsForFinalSession(session) {
    const base = Array.isArray(session && session.continuationBaseSegments) ? session.continuationBaseSegments : [];
    const fresh = Array.isArray(session && session.segments) ? session.segments : [];
    if (!base.length) return fresh;
    return normalizeSegmentsForMergedNote([...base, ...fresh], 0, 0, null);
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

  async confirmSpeakerNamesBeforeFinal(session, segments) {
    const joined = (segments || []).map(segment => String(segment && segment.text || "")).join("\n");
    const candidates = collectSpeakerCandidates(joined);
    if (candidates.length < 2) return { segments, frontmatter: null };

    const file = this.host.app.vault.getAbstractFileByPath(session.mdPath);
    if (!(file instanceof obsidian.TFile)) return { segments, frontmatter: null };
    const frontmatter = await readFileFrontmatter(this.host, file) || {};
    const ids = candidates.map(candidate => candidate.id);
    const initialMappings = normalizeSpeakerMappings(
      Object.assign({}, session.speakerChannels || {}, readSpeakerMappings(frontmatter) || {}),
      ids,
    );
    const alreadyConfirmed = candidates.every(candidate => String(initialMappings[candidate.id] && initialMappings[candidate.id].personName || "").trim());
    let mappings = initialMappings;

    if (!alreadyConfirmed && !session._speakerNameConfirmationSkipped) {
      this.host.asrPipeline.setSessionWorkProgress(session, {
        stage: "speaker-confirm",
        label: t("Confirm speakers"),
        percent: 52,
        detail: t("Detected {0} speakers; waiting for name confirmation before continuing").replace("{0}", String(candidates.length)),
      });
      this.host.requestOutlineRefresh();
      const providerId = session.importTranscribeProviderId
        || this.host.settings.activeTranscribeProvider
        || "siliconflow";
      const activeProvider = (this.host.settings.transcribeProviders || {})[providerId] || {};
      const profile = this.host.profiles.getTranscribeProviderProfile(providerId, activeProvider);
      const hardwareSeparated = Object.keys(session.speakerChannels || {}).length >= 2;
      const stableAcrossSession = hardwareSeparated
        || !!(profile && profile.speakerLabelScope === "session" && profile.requiresWholeSession)
        || isSpeakerDiarizationProvider(activeProvider);
      // resolve 收到的确认结果是「说话人标签到姓名」的映射表；用户取消时 resolve(null)。
      const names = await new Promise<Record<string, string> | null>((resolve) => {
        const modal = new SpeakerNameConfirmModal(
          this.host.app,
          this.host,
          candidates,
          initialMappings,
          { unstableAcrossSegments: !stableAcrossSession },
          resolve,
        );
        modal.open();
      });
      if (names) {
        mappings = buildConfirmedSpeakerMappings(candidates, names, initialMappings);
      } else {
        session._speakerNameConfirmationSkipped = true;
      }
    }

    const hasConfirmedName = Object.values(mappings).some(mapping => String(mapping && mapping.personName || "").trim());
    if (hasConfirmedName) {
      await this.host.app.fileManager.processFrontMatter(file, (nextFrontmatter) => {
        nextFrontmatter[NS_FM_SPEAKERS] = mappings;
      });
      session.speakerChannels = mappings;
      let persistedReplacements = 0;
      let namesPersisted = false;
      try {
        let markdown = await this.host.app.vault.read(file);
        for (const [speakerId, mapping] of Object.entries(mappings) as [SpeakerId, { personName?: string }][]) {
          const personName = String(mapping && mapping.personName || "").trim();
          if (!personName) continue;
          const updated = replaceSpeakerDisplayName(markdown, speakerId, personName);
          markdown = updated.markdown;
          persistedReplacements += updated.replacements;
        }
        if (persistedReplacements > 0) {
          await this.host.app.vault.modify(file, markdown);
          this.notePanelCacheKey = "";
          this.notePanelCacheData = undefined;
          this.notePanelLoading = false;
        }
        namesPersisted = true;
      } catch (error) {
        try {
          await this.host.diagnostics.logDiagnostic("warn", "speaker.names_persist_failed", t("Speaker names were saved to properties, but updating the note body failed"), {
            mdPath: file.path,
            error: diagnosticError(error),
          });
        } catch { /* diagnostics must not change finalization behavior */ }
        new obsidian.Notice(t("Speaker names were saved, but the display names in the original transcript could not be updated; you can save again from the outline."), 8000);
      }
      if (namesPersisted) {
        try {
          await this.host.diagnostics.logDiagnostic("info", "speaker.names_persisted", t("Speaker names have been written into the original transcript"), {
            mdPath: file.path,
            confirmedCount: Object.values(mappings).filter(mapping => String(mapping && mapping.personName || "").trim()).length,
            replacements: persistedReplacements,
          });
        } catch { /* diagnostics must not change finalization behavior */ }
      }
    }
    const llmSegments = hasConfirmedName
      ? segments.map((segment) => ({ ...segment, text: applySpeakerNamesForLlm(segment.text, mappings) }))
      : segments;
    const utteranceProjections = hasConfirmedName
      ? segments.flatMap((segment) => {
        if (!segment.transcript) return [];
        return getCurrentTranscript(segment.transcript).utterances.flatMap((utterance) => {
          const normalizedText = applySpeakerNamesForLlm(utterance.normalizedText, mappings);
          const channel = Number(utterance.speakerId?.match(/(?:channel|speaker|spk)[:-]?(\d+)$/)?.[1]) || 0;
          const speakerName = String(mappings[`spk-${channel}`]?.personName || utterance.speakerName || "").trim() || null;
          return normalizedText !== utterance.normalizedText || speakerName !== utterance.speakerName
            ? [{ utteranceId: utterance.id, normalizedText, speakerName }]
            : [];
        });
      })
      : [];
    return {
      segments: llmSegments,
      frontmatter: hasConfirmedName ? Object.assign({}, frontmatter, { [NS_FM_SPEAKERS]: mappings }) : null,
      utteranceProjections,
    };
  }

  /**
   * 短录音的收尾：删掉结尾创建的纪要，只保留音频（丢弃级别连音频也不留）。
   *
   * 录音开始时无法预知总时长，纪要头是那一刻就写进磁盘的，因此这里负责把它摘掉。
   * `discard` 级别在 `handleSegment` 里就没保存音频；`keep-audio` 级别的音频已经写进
   * 录音目录，用户之后可以用「导入已有音频文件」手动转写。
   */
  async finishShortRecording(session) {
    const tier = session.shortRecordingTier;
    const limitSeconds = Math.round(SHORT_RECORDING_SKIP_NOTE_MS / 1000);
    const durationMs = Math.max(0, Number(session.shortRecordingDurationMs) || 0);
    const discardedContinuation = tier === "discard"
      && !!session.continuation
      && !!session.continuationTaskId
      && this.host.queue;
    if (discardedContinuation) {
      await this.host.queue.update(session.continuationTaskId, {
        status: "live",
        mdPath: session.mdPath,
        temporarySourcePath: session.mdPath,
        continuation: session.continuation,
        segments: [],
        continuationDisposition: "discard",
        lastError: "",
      });
    }
    await this.host.asrPipeline.discardShortRecordingNote(session);
    if (discardedContinuation) await this.host.queue.remove(session.continuationTaskId);
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
      await this.host.diagnostics.logDiagnostic("info", "recording.short_recording_skipped", t("Short recording was not transcribed automatically"), {
        tier,
        durationMs,
        audioName,
        mdPath: session.mdPath,
      });
    } catch { /* diagnostics must not change finalization behavior */ }
    this.host.sessionStore.end(session);
    this.host.requestOutlineRefresh();
  }

  async _finalizeSessionImpl(session) {

    // 静音统计快照：此刻录音刚结束、recorder 计数尚未被下一场 start() 重置，同步读取避免异步窗口被污染。
    const _silVoiced = this.host.recorder ? (this.host.recorder._voicedTicks || 0) : 0;
    const _silSilent = this.host.recorder ? (this.host.recorder._silentTicks || 0) : 0;

    if (session.shortRecordingTier) {
      await this.finishShortRecording(session);
      return;
    }

    if (!session.segments || session.segments.length === 0) {
      await this.host.noteWriter.removeEmptySessionBlock(session);
      new obsidian.Notice(t("⏭ This recording was too short or had no valid audio; skipped"));
      this.host.sessionStore.end(session);
      this.host.requestOutlineRefresh();
      return;
    }

    // 兜底：整场电平几乎为零（≥5s≈30 帧有效采样中，有声占比 < 2%）→ 明确提示用户去查设备。
    // 插件不替用户猜设备，只在"采到的几乎全是静音"这种失败点明确提示。逐场只弹一次。
    const _silTotal = _silVoiced + _silSilent;
    // 仅对真实录音会话判静音：导入/文本导入不经 recorder，会读到上一场录音遗留的计数残值 → 误报。
    if (!session.source && _silTotal >= 30 && (_silVoiced / _silTotal) < 0.02 && !session._silenceNotified) {
      session._silenceNotified = true;
      new obsidian.Notice(t("Almost no sound was detected in the whole session; please check the selected microphone / computer audio device (Settings → Advanced → Audio device check)."), 9000);
    }

    const textImportSession = isTextImportSession(session);
    await this.syncTranscriptAudioSource(session);
    const segmentsForFinal = this.getSegmentsForFinalSession(session);
    let writeSession = segmentsForFinal === session.segments
      ? session
      : Object.assign({}, session, { segments: segmentsForFinal, multiSourceAudio: true });
    const usableTranscriptSegments = segmentsForFinal.filter(s => s && String(s.text || "").trim());
    if (!usableTranscriptSegments.length) {
      const noTranscriptError = new Error(t("No usable transcript text for organizing; the recording and failed slices were kept"));
      this.host.asrPipeline.setSessionWorkProgress(session, {
        stage: "transcript-empty",
        label: t("No valid transcript obtained"),
        percent: null,
        detail: t("The recording was kept; check the transcription service and retry from the pending queue"),
      });
      try {
        await this.host.diagnostics.logDiagnostic("error", "session.no_transcript", t("No valid transcript for the whole session; AI organizing was skipped to avoid wasted charges"), {
          mode: session.mode,
          segmentCount: segmentsForFinal.length,
          failedSegments: segmentsForFinal.filter(s => s && s.error).length,
          mdPath: session.mdPath,
        });
      } catch { /* intentionally empty */ }
      await this.host.noteWriter.appendPolishBlock(writeSession, "", noTranscriptError, true);
      new obsidian.Notice(t("No valid transcript obtained; the recording and failed slices have been kept. Please check the transcription service and retry from the pending queue."), 10000);
      if (this.host.settings.autoOpenNoteAfterFinish) {
        const file = this.host.app.vault.getAbstractFileByPath(session.mdPath);
        if (file instanceof obsidian.TFile) {
          try { await this.host.app.workspace.getLeaf(false).openFile(file); } catch { /* intentionally empty */ }
        }
      }
      this.host.requestDeferredAsrRetry(session);
      this.host.sessionStore.end(session);
      this.host.requestOutlineRefresh();
      return;
    }
    let speakerPreparation: {
      segments: Segment[];
      frontmatter: Record<string, unknown> | null;
      utteranceProjections?: Array<{ utteranceId: string; normalizedText: string; speakerName: string | null }>;
    } = { segments: segmentsForFinal, frontmatter: null, utteranceProjections: [] };
    try {
      speakerPreparation = await this.confirmSpeakerNamesBeforeFinal(session, segmentsForFinal);
    } catch (error) {
      console.warn("[QnALog] speaker confirmation failed; continuing with generic labels", error);
      try {
        await this.host.diagnostics.logDiagnostic("warn", "speaker.confirmation_failed", t("Speaker name confirmation did not finish; numbers were kept and organizing continued"), {
          mdPath: session.mdPath,
          error: diagnosticError(error),
        });
      } catch { /* intentionally empty */ }
    }
    const segmentsForLlm = speakerPreparation.segments || segmentsForFinal;
    const speakerFrontmatter = speakerPreparation.frontmatter || null;
    if (segmentsForLlm !== segmentsForFinal) {
      writeSession = Object.assign({}, writeSession, { segments: segmentsForLlm });
    }
    this.host.asrPipeline.setSessionWorkProgress(session, {
      stage: "finalize-start",
      label: textImportSession ? t("Text read complete") : t("Preparing AI organizing"),
      percent: 12,
      detail: textImportSession ? t("ASR skipped; preparing structured organizing") : t("Transcription finished; organizing the context"),
    });
    this.host.requestOutlineRefresh();
    new obsidian.Notice(textImportSession ? t("Text read; AI structuring in progress…") : t("All segments processed; AI merging and polishing in progress…"));

    let polished = ""; let mergeError = null; let nonRetryableMergeError = false; let commitError = false;
    let taskMeter = null;
    let finalSessionMeta = null;
    try {
      const llmConfigIssue = getLlmConfigIssue(this.host.settings);
      if (llmConfigIssue) {
        const configurationError = new Error(llmConfigIssue);
        (configurationError as Error & { nonRetryable?: boolean }).nonRetryable = true;
        throw configurationError;
      }
      this.host.asrPipeline.setSessionWorkProgress(session, {
        stage: "workbench",
        label: t("Organize context"),
        percent: 22,
        detail: t("Merging meeting entries, attachments, and context"),
      });
      await this.host.meetingWorkbench.processPendingMeetingWorkbenchInteractions(session, { force: true });
      if (!textImportSession) {
        this.host.asrPipeline.setSessionWorkProgress(session, {
          stage: "outline",
          label: t("Generate outline"),
          percent: 36,
          detail: t("Completing the live outline for reference by the final minutes"),
        });
        await this.host.outline.ensureRealtimeOutlineForFinalNote(session);
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
      const noteFile = this.host.app.vault.getAbstractFileByPath(session.mdPath);
      if (noteFile instanceof obsidian.TFile) {
        sessionMeta._previousKnowledge = readSessionKnowledge(await this.host.app.vault.read(noteFile));
      }
      finalSessionMeta = sessionMeta;
      this.host.asrPipeline.setSessionWorkProgress(session, {
        stage: "llm-merge",
        label: t("AI organizing"),
        percent: 62,
        detail: textImport ? t("Sending the imported text to the AI model for structured organizing") : t("Merging the segmented transcriptions into the final minutes"),
      });
      taskMeter = this.host.taskMeters.beginTaskMeter();
      sessionMeta._taskMeter = taskMeter;
      session._finalizeTaskMeter = taskMeter;
      polished = session.continuation
        ? ""
        : await mergeAndPolish(this.host, segmentsForLlm.map((segment) => ({ ...segment })), session.mode, sessionMeta, speakerFrontmatter);
      session._briefingCheckpointId = sessionMeta._briefingCheckpointId || "";
      this.host.asrPipeline.setSessionWorkProgress(session, {
        stage: "write-note",
        label: t("Write to Minutes"),
        percent: 88,
        detail: t("AI output received; writing to the Obsidian note"),
      });
    } catch (e) { mergeError = e; console.error(e); }
    session.finalizing = false;

    if (mergeError) {
      if (taskMeter) {
        this.host.taskMeters.endTaskMeter(taskMeter);
        taskMeter = null;
        session._finalizeTaskMeter = null;
      }
      nonRetryableMergeError = isLlmNonRetryableError(mergeError);
      await this.host.diagnostics.logDiagnostic("error", "llm.merge_failed", t("LLM merging and organizing failed"), {
        mode: session.mode,
        segmentCount: segmentsForFinal.length,
        duration: isTextImportSession(session) ? "" : (segmentsForFinal.length ? formatElapsed(segmentsForFinal[segmentsForFinal.length - 1].endOffsetMs || 0) : ""),
        llmEndpoint: this.host.settings.llmEndpoint,
        llmModel: this.host.settings.llmModel,
        nonRetryable: nonRetryableMergeError,
        error: diagnosticError(mergeError),
      });
      const lastSeg = segmentsForFinal[segmentsForFinal.length - 1];
      const retrySessionMeta = Object.assign({}, finalSessionMeta || {
        startedAt: session.startedAt,
        duration: isTextImportSession(session) ? "" : (lastSeg ? formatElapsed(lastSeg.endOffsetMs || 0) : ""),
        source: session.source || "",
        sourceMeta: session.sourceMeta || null,
        meetingWorkbench: normalizeMeetingWorkbench(session.meetingWorkbench),
      });
      delete retrySessionMeta._previousKnowledge;
      await this.host.queue.add({
        type: "merge",
        sessionId: session.id,
        mdPath: session.mdPath,
        mode: session.mode,
        status: nonRetryableMergeError ? "blocked" : "pending",
        segments: segmentsForLlm.map((segment) => ({ ...segment })),
        source: session.source || "",
        sourceMeta: session.sourceMeta || null,
        externalAudioSource: session.externalAudioSource || null,
        textImportSources: session.textImportSources || [],
        speakerFrontmatter,
        sessionMeta: retrySessionMeta,
        lastError: mergeError.message || String(mergeError),
      });
      if (!nonRetryableMergeError) {
        this.host.requestTaskQueueRetry(1500, mergeError instanceof BriefingPipelineIncompleteError
          ? "briefing-partial"
          : "briefing-finalization-failure");
      }
      session.finalizationError = getErrorMessage(mergeError);
      const partialBriefing = mergeError instanceof BriefingPipelineIncompleteError;
      this.host.asrPipeline.setSessionWorkProgress(session, {
        stage: nonRetryableMergeError ? "merge-failed" : "merge-retrying",
        label: nonRetryableMergeError ? t("AI organizing failed") : partialBriefing ? t("Minutes partially completed") : t("AI organizing waiting to retry"),
        percent: null,
        detail: nonRetryableMergeError
          ? t("The original transcript has been kept; fix the model configuration and re-organize.")
          : partialBriefing
            ? t("{0}; the completed portion and the original transcript have both been saved").replace("{0}", mergeError.message)
            : t("The original transcript has been kept; the background queue will retry with backoff"),
      });
    }

    if (!mergeError) {
      // 续录覆盖前留档：把当前笔记（旧场次的整理稿）存进版本缓存。
      // 版本条目不切换当前显示（activate:false），需要回看旧稿时用版本切换恢复。
      // 失败不阻断续录收尾——留档是保险，不是闸门，诊断里记一条即可。
      if (session.continuationSourcePath && !session.continuation) {
        try {
          const targetFile = this.host.app.vault.getAbstractFileByPath(session.mdPath);
          if (targetFile instanceof obsidian.TFile) {
            const priorContent = await this.host.app.vault.read(targetFile);
            await this.host.versions.saveVersion(targetFile, priorContent, session.continuationBaseSegments || segmentsForFinal, {
              kind: "pre-append",
              label: t("Before append") + " " + window.moment().format("YYYY-MM-DD HH:mm"),
              mode: session.mode,
              idLabel: "pre-append-" + window.moment().format("YYYYMMDD-HHmmss"),
              body: priorContent,
              activate: false,
            });
          }
        } catch (archiveError) {
          console.warn("[QnALog] pre-append version archive failed", archiveError);
          try {
            await this.host.diagnostics.logDiagnostic("warn", "session.pre_append_archive_failed", t("Archiving the previous draft before the append failed; the append itself is unaffected"), {
              mdPath: session.mdPath,
              error: diagnosticError(archiveError),
            });
          } catch { /* intentionally empty */ }
        }
      }
      try {
        if (shouldRewriteConsolidatedNote(this.host.settings, writeSession)) {
          await this.host.noteWriter.rewriteConsolidated(writeSession, polished);
        } else {
          await this.host.noteWriter.appendPolishBlock(writeSession, polished, null, false);
        }
      } catch (writeError) {
        commitError = true;
        mergeError = writeError;
        session.finalizationError = getErrorMessage(writeError);
        await this.host.diagnostics.logDiagnostic("error", "briefing.commit_failed", t("The minutes body was generated, but writing the Markdown failed"), {
          mode: session.mode,
          mdPath: session.mdPath,
          checkpointId: finalSessionMeta && finalSessionMeta._briefingCheckpointId || "",
          error: diagnosticError(writeError),
        });
        await this.host.queue.add({
          type: "merge",
          sessionId: session.id,
          mdPath: session.mdPath,
          mode: session.mode,
          segments: segmentsForLlm.map((segment) => ({ ...segment })),
          source: session.source || "",
          sourceMeta: session.sourceMeta || null,
          externalAudioSource: session.externalAudioSource || null,
          textImportSources: session.textImportSources || [],
          speakerFrontmatter,
          sessionMeta: finalSessionMeta,
          lastError: t("Failed to write the minutes: {0}").replace("{0}", getErrorMessage(writeError)),
        });
        this.host.requestTaskQueueRetry(1500, "briefing-write-failure");
        this.host.asrPipeline.setSessionWorkProgress(session, {
          stage: "write-retrying",
          label: t("Minutes write waiting to retry"),
          percent: null,
          detail: t("The AI result was saved; the model will not be called again and only the write will be retried later"),
        });
      }
    } else {
      await this.host.noteWriter.appendPolishBlock(writeSession, polished, mergeError, nonRetryableMergeError);
    }
    if (!mergeError && finalSessionMeta && finalSessionMeta._briefingCheckpointId) {
      await clearCommittedBriefingCheckpoint(this.host, finalSessionMeta);
      session._briefingCheckpointId = "";
    }

    if (!mergeError) {
      this.host.asrPipeline.setSessionWorkProgress(session, {
        stage: "done",
        label: t("Processing complete"),
        percent: 100,
        detail: t("Minutes written; finishing up"),
      });
    }

    if (!mergeError && polished) {
      // 续录会话跳过自动改名：用户心智是「同一篇笔记持续完善」，
      // 文件名随新内容跳变会破坏指向这篇笔记的链接与习惯。
      if (!session.continuationSourcePath) {
        const beforeRenamePath = session.mdPath;
        const renamed = await this.host.noteWriter.renameMarkdownWithGeneratedTitle(session.mdPath, polished, session.mode);
        if (renamed instanceof obsidian.TFile) {
          session.mdPath = renamed.path;
          writeSession.mdPath = renamed.path;
        }
        const renamedByPolished = renamed instanceof obsidian.TFile
          && obsidian.normalizePath(renamed.path) !== obsidian.normalizePath(beforeRenamePath);
        if ((session.source === "import" || session.source === "text-import") && !renamedByPolished) {
          const rawTitleSource = buildTitleSourceFromSegments(segmentsForFinal);
          if (rawTitleSource) {
            const fallbackRenamed = await this.host.noteWriter.renameMarkdownWithGeneratedTitle(session.mdPath, rawTitleSource, session.mode);
            if (fallbackRenamed instanceof obsidian.TFile) {
              session.mdPath = fallbackRenamed.path;
              writeSession.mdPath = fallbackRenamed.path;
            }
          }
        }
      }
    }

    if (!mergeError && polished) {
      await this.host.noteIndex.refreshNoteIndexSafely(writeSession.mdPath, {
        meetingDate: session.startedAt,
        reason: "finalize",
      });
    }

    if (!mergeError) {
      if (!session.continuation) await this.host.asrPipeline.cleanupSuccessfulSegmentAudio(session);
      const completedTaskMeter = taskMeter ? this.host.taskMeters.endTaskMeter(taskMeter) : null;
      taskMeter = null;
      session._finalizeTaskMeter = null;
      if (!session.continuation) {
        try {
          const doneLabel = isTextImportSession(session) ? t("Text organization completed")
            : session.source === "import" ? t("Imported audio organization completed") : t("Recording minutes completed");
          this.host.taskMeters.logCompletedWork(doneLabel, session.mdPath || "", completedTaskMeter);
        } catch { /* intentionally empty */ }
        if (this.host.settings.sedimentAutoExtract) void this.host.noteIndex.autoExtractSedimentAfterFinalize(session.mdPath);
      }
    }

    new obsidian.Notice(mergeError
      ? (nonRetryableMergeError
        ? t("AI organizing failed: {0}").replace("{0}", formatLlmFailureIssue(mergeError.message || mergeError))
        : commitError
          ? t("The minutes body has been generated but writing failed; queued for retry.")
          : mergeError instanceof BriefingPipelineIncompleteError
          ? t("{0}, queued for precise retry").replace("{0}", mergeError.message)
          : t("AI organizing did not finish; queued for retry."))
      : (session.continuation
        ? t("Continuation recording saved separately; it will be merged into \"{0}\" after its current processing finishes.")
          .replace("{0}", session.continuation.targetPath.split("/").pop()?.replace(/\.md$/i, "") || session.continuation.targetPath)
        : session.continuationSourcePath
          ? t("Append session completed: {0} segments this time, {1} segments after merging (the previous draft was saved to the version cache).")
            .replace("{0}", String(session.segments.length))
            .replace("{1}", String(segmentsForFinal.length))
          : t("QnALog processing completed")));

    if (this.host.settings.autoOpenNoteAfterFinish) {
      const file = this.host.app.vault.getAbstractFileByPath(session.mdPath);
      if (file instanceof obsidian.TFile) {
        try { await this.host.app.workspace.getLeaf(false).openFile(file); } catch { /* intentionally empty */ }
      }
    }
    this.host.requestDeferredAsrRetry(session);
    this.host.sessionStore.end(session);
    this.host.requestOutlineRefresh();
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
