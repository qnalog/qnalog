/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：会话收尾：分段转写与沉淀、说话人姓名确认、正文与版本落盘

import * as obsidian from "obsidian";
import { SpeakerNameConfirmModal } from "../ui/modals";
import { transcribeAudio } from "../asr/transcribe";
import { readFileFrontmatter } from "../shared/util-note";
import { loadVocabularyGroups, applyVocabularyCorrections } from "../vocabulary";
import { getLlmConfigIssue, isLlmNonRetryableError, formatLlmFailureIssue } from "../llm/core";
import type { PluginSettings, RecordingSession, PreparedLiveSegment, SessionMetaForMerge, Segment } from "../shared/types";
import { RecordingService } from "../audio/recording-service";
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
import { shouldRewriteConsolidatedNote } from "../briefing/note-layout-policy";
import { classifyRecordingIssue } from "../notes/recording-issues";
import { clearCommittedBriefingCheckpoint } from "../prompts/briefing-prompts";
import { normalizeMeetingWorkbench } from "../notes/meeting-workbench";
import { getAudioTimeLink } from "../notes/audio-refs";
import { buildTitleSourceFromSegments, isTextImportSession, normalizeSegmentsForMergedNote } from "../notes/note-markdown";
import { RecorderService } from "../audio/recorder-service";
import { TaskQueue } from "../queue/task-queue";
import { mergeAndPolish } from "../briefing/merge-pipeline";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { TaskActivityService } from "../tasks/task-activity-service";
import { NoteWriter } from "../notes/note-writer";
import { QueueRetryService } from "../queue/queue-retry-service";
import { TranscribeProfileService } from "../asr/transcribe-profile-service";
import { RealtimeOutlineService } from "../notes/realtime-outline-service";
import { MeetingWorkbenchService } from "../notes/meeting-workbench-service";
import { NoteIndexService } from "../notes/note-index-service";
import { ViewShellService } from "../ui/view-shell-service";
import { NS_AUDIO_PREFIX, NS_FM_SPEAKERS, nsMarker } from "../shared/namespace";
import { SHORT_RECORDING_SKIP_NOTE_MS } from "../shared/limits";

import { t } from "../shared/i18n";
/** SessionFinalizeService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface SessionFinalizeHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  diagnostics: DiagnosticsService;
  meetingWorkbench: MeetingWorkbenchService;
  noteIndex: NoteIndexService;
  noteWriter: NoteWriter;
  outline: RealtimeOutlineService;
  profiles: TranscribeProfileService;
  queue: TaskQueue | null;
  queueRetry: QueueRetryService;
  recorder: RecorderService | null;
  /** 录音采集服务：切片缓存与整场音频的落点、录音问题状态。 */
  recording: RecordingService & { setRecordingIssue(kind: string, patch?: unknown): void; clearRecordingIssue(kind: string): void };
  session: RecordingSession | null;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
  shell: ViewShellService;
  tasks: TaskActivityService;
}

export class SessionFinalizeService {
  declare host: SessionFinalizeHost;
  /** 侧边栏成品面板的缓存标记。注意：插件对象上的这三个字段目前只被写、没有人读，
      侧边栏读的是视图自己的同名字段；保留是为了不改变行为，可在单独一次清理里核实后删除。 */
  declare notePanelCacheKey;
  declare notePanelCacheData;
  declare notePanelLoading;

  constructor(host) {
    this.host = host;
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
      else await this.host.recording.saveMasterAudio(session, seg);
      this.host.recording.setSessionWorkProgress(session, {
        stage: "transcribe-finalized",
        label: t("Finalizing transcription"),
        percent: null,
        detail: "分段录音已停止，完整录音已保留，正在整理已有转写",
      });
      try {
        await this.host.diagnostics.logDiagnostic("warn", "recording.master_only_finalize", "最后分段不可用，已用完整录音完成保存并整理已有转写", {
          mode: session.mode,
          segmentCount: Array.isArray(session.segments) ? session.segments.length : 0,
          endOffsetMs: Number(seg.endOffsetMs) || 0,
        });
      } catch { /* intentionally empty */ }
      this.host.shell.refreshOutlineView();
      return;
    }
    if (session.shortRecordingTier) {
      // 短录音：音频（只留音频级别）已由 handleSegment 交给 saveMasterAudio 落盘，
      // 这里只等它结束，后续收尾会按 shortRecordingTier 删掉结尾创建的纪要。
      if (seg && seg.masterAudioSavePromise != null) await seg.masterAudioSavePromise;
      await this.host.recording.closeStreamingForDiscard(session);
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
    const segmentAudioPath = seg.segmentAudioPath || obsidian.normalizePath(`${this.host.recording.getSegmentCacheFolder()}/${segmentAudioName}`);
    const segmentDurationMs = Math.max(0, displayEndOffsetMs - displayStartOffsetMs);

    let spoolResult = null;
    if (seg.spoolPromise != null) {
      spoolResult = await seg.spoolPromise;
    } else if (seg.blob) {
      try {
        await this.host.recording.ensureSegmentCacheFolder();
        await this.host.app.vault.adapter.writeBinary(segmentAudioPath, await seg.blob.arrayBuffer());
        spoolResult = { persisted: true, fallbackBlob: null, error: null };
      } catch (e) {
        spoolResult = { persisted: false, fallbackBlob: seg.blob, error: e };
        console.error(e);
        new obsidian.Notice(`${t(" segments")}${segNumber}${t(" audio write failed: ")}${(e && e.message) || e}`);
      }
    }
    if (spoolResult && spoolResult.queueTaskId) seg.queueTaskId = spoolResult.queueTaskId;
    await this.host.recording.markLiveSegmentQueueTaskRunning(seg);
    const liveJob = seg.jobId ? this.host.recording.getLiveAsrJobs(session).get(seg.jobId) : null;
    if (liveJob) liveJob.state = "transcribing";
    this.host.recording.updateLiveAsrBacklogPolicy(session, "transcribing");
    if (seg.masterAudioSavePromise != null) await seg.masterAudioSavePromise;
    else if (seg.isFinal) await this.host.recording.saveMasterAudio(session, seg);

    let text = ""; let err = null;
    let transcribeBlob = null;
    let channelTranscription = null;
    let batchAsrAttempted = false;
    let batchAsrFailureRecorded = false;
    const activeProfile = this.host.profiles.getActiveTranscribeProfile();
    const isStreamingProvider = activeProfile && activeProfile.transcribeMode === "streaming";
    this.host.recording.setSessionWorkProgress(session, {
      stage: "transcribing",
      label: `${t("Transcript segment ")}${segNumber}${t(" segments")}`,
      percent: null,
      detail: "音频正在发送到转写服务",
    });
    if (session.streamingClient) {
      // 流式转写：跳过 HTTP 切片转写，等流式客户端 finish 后取累计文本
      try {
        if (session.pcmEncoder) { try { session.pcmEncoder.stop(); } catch { /* intentionally empty */ } session.pcmEncoder = null; }
        await session.streamingClient.finish();
        text = session.streamingClient.getFullText() || session.streamingFullText || "";
      } catch (e) {
        err = e;
        console.error("[QnALog] streaming finish failed", e);
        text = session.streamingFullText || "";
      }
      // 提升转写质量：流式整段文本补一遍热词修正（分段批量路径在 transcribeAudio 内部已做，流式此前漏了）
      try { text = applyVocabularyCorrections(text, await loadVocabularyGroups(this.host)); } catch { /* intentionally empty */ }
      try { await this.host.meetingWorkbench.removeLiveTranscriptBlock(session.mdPath, session.id); } catch { /* intentionally empty */ }
      session.streamingClient = null;
    } else if (isStreamingProvider) {
      // 流式服务但客户端连接失败：保留音频但不做 HTTP 切片转写（端点是 wss://，HTTP 必失败）
      err = new Error("流式转写连接未建立，请检查 API Key 与网络后重新录音。");
      console.error("[QnALog]", err.message);
    } else {
      const circuitOpen = isLiveAsrCircuitOpen(session.asrCircuitState || createLiveAsrCircuitState())
        || this.host.recording.isAsrServiceCircuitOpen();
      if (session.asrDeferredMode || circuitOpen) {
        err = new Error(session.asrDeferredMode
          ? "实时转写积压超过保护阈值，已转入后台队列"
          : "转写服务处于短暂冷却期，已转入后台队列");
        err.asrDeferred = true;
        err.deferReason = session.asrDeferredMode ? "backlog-critical" : "circuit-open";
      } else {
        transcribeBlob = spoolResult && spoolResult.fallbackBlob ? spoolResult.fallbackBlob : null;
        if (!transcribeBlob && spoolResult && spoolResult.persisted) {
          const cachedAudio = await this.host.queueRetry.readVaultAudioBlob(segmentAudioPath, segmentAudioName);
          transcribeBlob = cachedAudio && cachedAudio.blob;
        }
        if (!transcribeBlob && seg.blob) transcribeBlob = seg.blob;
        if (!transcribeBlob) {
          err = new Error("录音分段缓存无法读取，已保留后台重试任务");
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
            const inspectRecordedChannels = session.captureMode === "mic" && runtimeChannelMode !== "mono";
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
                  `已按声道区分 ${channelTranscription.processedChannelCount} 位说话人。可在纪要页顶部为他们填写姓名。`,
                  9000,
                );
              }
              if (channelTranscription.deduplicatedParts > 0) {
                session.channelCrosstalkDeduplicated = Math.max(0, Number(session.channelCrosstalkDeduplicated) || 0)
                  + channelTranscription.deduplicatedParts;
                await this.host.diagnostics.logDiagnostic("info", "asr.channel_crosstalk_deduplicated", "已去除跨声道重复转写", {
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
                await this.host.diagnostics.logDiagnostic("warn", "asr.channel_content_duplicated", "录音多声道内容重复，已回退为单声道转写", {
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
                  ? `检测到 ${actual} 个可用声道，将按声道区分说话人。`
                  : "输入设备为多声道，但录音文件只有单声道。本次将按单声道转写。", 9000);
                await this.host.diagnostics.logDiagnostic("warn", "asr.channel_encoder_downmix", "录音编码保留的声道少于设备输入声道", {
                  expectedChannelCount: expectedHardwareChannels,
                  actualChannelCount: actual,
                  inputLabel: session.audioChannelLabel || "",
                });
              }
              if (channelTranscription.errors.length) {
                await this.host.diagnostics.logDiagnostic("warn", "asr.channel_partial_failure", "部分声道转写失败，已保留其他声道的内容", {
                  segmentIndex,
                  channelCount: channelTranscription.actualChannelCount,
                  errors: channelTranscription.errors,
                });
              }
            } else {
              text = await transcribeAudio(this.host, transcribeBlob, transcribeMime);
            }
          } catch (e) {
            err = e;
            batchAsrFailureRecorded = true;
            this.host.recording.recordLiveAsrAttemptFailure(session, e, seg);
            console.error(e);
          }
        }
      }
    }
    if (!err && !String(text || "").trim() && segmentDurationMs >= 30 * 1000) {
      // HTTP 200 + 空正文并不等于成功。对长段按可重试软失败处理并保留切片，
      // 与导入音频路径保持一致，避免服务偶发空结果被静默写成“无内容”。
      err = new Error("转写返回空结果（服务已响应但没有文字）");
      if (batchAsrAttempted && !batchAsrFailureRecorded) {
        batchAsrFailureRecorded = true;
        this.host.recording.recordLiveAsrAttemptFailure(session, err, seg);
      }
      try {
        await this.host.diagnostics.logDiagnostic("warn", "asr.segment_empty", "录音分段转写返回空结果，已按软失败保留并排队", {
          segmentIndex,
          startOffsetMs: displayStartOffsetMs,
          endOffsetMs: displayEndOffsetMs,
          durationMs: segmentDurationMs,
          mode: session.mode,
        });
      } catch { /* intentionally empty */ }
    }
    if (!err && batchAsrAttempted) this.host.recording.recordLiveAsrAttemptSuccess(session);
    if (err) {
      if (err.asrDeferred) {
        await this.host.diagnostics.logDiagnostic("warn", "asr.segment_deferred", "录音分段已跳过实时请求并转入后台队列", {
          segmentIndex,
          startOffsetMs: displayStartOffsetMs,
          endOffsetMs: displayEndOffsetMs,
          durationMs: segmentDurationMs,
          reason: err.deferReason || "deferred",
          pendingDurationMs: this.host.recording.getLiveAsrBacklogSummary(session).totalDurationMs,
        });
      } else {
        const issueKind = classifyRecordingIssue(err);
        this.host.recording.setRecordingIssue(issueKind, {
          source: "asr",
          message: getErrorMessage(err),
          startedAtMs: displayStartOffsetMs,
        });
        await this.host.diagnostics.logDiagnostic("error", "asr.segment_failed", "录音分段转写失败", {
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
          ? `段 ${segNumber} 流式转写失败，无法离线重试；录音仍在本地继续，可整篇结束后用「重新整理」或重录该段。`
          : (!String(text || "").trim()
            ? `段 ${segNumber} 没有返回文字，录音切片已保留并加入重试队列。`
            : `段 ${segNumber} 转写失败，录音仍在本地继续，已加入重试队列。`), 7000);
      }
    } else if (!text || !String(text).trim()) {
      // 转写成功返回，但内容为空 → 可能音频设备没选对 / 没有声音。
      // 请求既然成功返回，网络/服务是通的，清掉遗留横幅。
      this.host.recording.clearRecordingIssue("network");
      this.host.recording.clearRecordingIssue("service");
      // 防误报：只在"本场此前从未产生过任何非空转写"时提示。
      // 否则会议中途的合理静默段（开头/中场没人说话）会骚扰正在正常录音的用户。
      const hadAnyText = Array.isArray(session.segments) && session.segments.some((s) => s && s.text && String(s.text).trim());
      await this.host.diagnostics.logDiagnostic("warn", "asr.empty_result", "本段无转写内容", {
        segmentIndex, mode: session.mode, hadAnyText,
      });
      if (!hadAnyText && !session._emptyAsrNotified) {
        session._emptyAsrNotified = true;
        new obsidian.Notice(t("No speech detected in this segment. Go to \"Settings → General → Audio input\" to test the selected device."), 9000);
      }
    } else {
      this.host.recording.clearRecordingIssue("network");
      this.host.recording.clearRecordingIssue("service");
    }

    const playbackAudioName = session.masterAudioName || segmentAudioName;
    const playbackAudioPath = session.masterAudioPath || segmentAudioPath;
    const segmentRecord: Segment = {
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
    session.segments.push(segmentRecord);

    if (err && !isStreamingProvider) {
      // 流式 provider(endpoint 是 wss://)的失败段不入 transcribe 重试队列——重试走 HTTP 必然再失败、
      // 把任务卡在 failed 永远清不掉。流式无法离线重切重传，留在笔记里标失败即可。
      if (err.asrDeferred || isTransientAsrError(err)) session.hasDeferredAsrJobs = true;
      const retryTask = await this.host.recording.keepLiveSegmentQueueTaskForRetry(session, Object.assign({}, seg, {
        segmentAudioPath,
        segmentAudioName,
        segmentIndex,
        displayStartOffsetMs,
        displayEndOffsetMs,
      }), err);
      segmentRecord.queueTaskId = retryTask.id;
    }

    const segTitle = `### 段落 ${segNumber} (${formatElapsed(displayStartOffsetMs)}–${formatElapsed(displayEndOffsetMs)}) ${getAudioTimeLink(playbackAudioName, Math.max(0, Number(seg.startOffsetMs) || 0))}${seg.isFinal ? " · 结束" : ""}`;
    const block = [
      "",
      segTitle,
      "",
      segmentRecord.queueTaskId ? nsMarker("transcribe-task", segmentRecord.queueTaskId) : "",
      err ? getTranscribeSegmentPlaceholder(err, {
        streaming: isStreamingProvider,
        deferred: !!err.asrDeferred,
        retryable: !isStreamingProvider && (err.asrDeferred || isTransientAsrError(err)),
      }) : (text ? text : t("_[No content in this segment]_")),
      "",
    ].join("\n");
    await this.host.noteWriter.insertBeforeSegmentsEnd(session.mdPath, block, session.id);
    if (!err || isStreamingProvider) await this.host.recording.removeLiveSegmentQueueTask(seg);

    this.host.shell.refreshOutlineView();
    this.host.recording.setSessionWorkProgress(session, {
      stage: seg.isFinal ? "transcribe-finalized" : "transcribed",
      label: seg.isFinal ? "转写收尾" : (err && err.asrDeferred ? `已缓存 ${session.segments.length} 段` : `已转写 ${session.segments.length} 段`),
      percent: null,
      detail: seg.isFinal ? "正在进入 AI 整理" : (err && err.asrDeferred ? "音频已落盘，等待后台补转写" : "分段转写已写入纪要"),
    });

    if (!seg.isFinal && text && String(text).trim()) new obsidian.Notice(`${t(" segments ")}${segNumber}${t(" transcribed")}`);

    if (this.host.settings.enableRealtimeOutline && text && !err) {
      this.host.outline.scheduleRealtimeOutline();
    }
  }

  getSegmentsForFinalSession(session) {
    const base = Array.isArray(session && session.continuationBaseSegments) ? session.continuationBaseSegments : [];
    const fresh = Array.isArray(session && session.segments) ? session.segments : [];
    if (!base.length) return fresh;
    return normalizeSegmentsForMergedNote([...base, ...fresh], 0, 0, null);
  }

  async finalizeSession(session: RecordingSession) {
    if (!session || session.finalized) return;
    if (session.finalizePromise !== null && session.finalizePromise !== undefined) return session.finalizePromise;
    const finalizePromise = (async () => {
      try {
        await this._finalizeSessionImpl(session);
        // 只有完整收尾流程返回后才锁定。此前在函数入口置 true，任何意外写盘异常
        // 都会把半成品会话永久标成已完成，后续无法再收尾。
        session.finalized = true;
        session.finalizationError = "";
      } catch (e) {
        session.finalizing = false;
        session.finalizationError = getErrorMessage(e);
        if (session._finalizeTaskMeter) {
          this.host.tasks.endTaskMeter(session._finalizeTaskMeter);
          session._finalizeTaskMeter = null;
        }
        try {
          this.host.recording.setSessionWorkProgress(session, {
            stage: "finalize-failed",
            label: t("Failed to finalize minutes"),
            percent: null,
            detail: "原始转写和录音已保留，可打开笔记后重新整理",
          });
        } catch { /* intentionally empty */ }
        console.error("[QnALog] finalize session failed", e);
        try {
          await this.host.diagnostics.logDiagnostic("error", "session.finalize_failed", "纪要最终收尾异常，原始材料已保留", {
            mode: session.mode,
            mdPath: session.mdPath,
            segmentCount: Array.isArray(session.segments) ? session.segments.length : 0,
            error: diagnosticError(e),
          });
        } catch { /* intentionally empty */ }
        new obsidian.Notice(t("Failed to finalize minutes; the original transcript and recording have been kept. You can use \"Reorganize\" in the note."), 10000);
        if (this.host.session === session) this.host.session = null;
        this.host.shell.refreshOutlineView();
      }
    })();
    session.finalizePromise = finalizePromise;
    try {
      return await finalizePromise;
    } finally {
      if (session.finalizePromise === finalizePromise) session.finalizePromise = null;
    }
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
      this.host.recording.setSessionWorkProgress(session, {
        stage: "speaker-confirm",
        label: t("Confirm speakers"),
        percent: 52,
        detail: `识别到 ${candidates.length} 位说话人，等待确认姓名后继续整理`,
      });
      this.host.shell.refreshOutlineView();
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
          await this.host.diagnostics.logDiagnostic("warn", "speaker.names_persist_failed", "说话人姓名已保存到属性，但正文更新失败", {
            mdPath: file.path,
            error: diagnosticError(error),
          });
        } catch { /* diagnostics must not change finalization behavior */ }
        new obsidian.Notice(t("Speaker names were saved, but the display names in the original transcript could not be updated; you can save again from the outline."), 8000);
      }
      if (namesPersisted) {
        try {
          await this.host.diagnostics.logDiagnostic("info", "speaker.names_persisted", "说话人姓名已写入原始转写", {
            mdPath: file.path,
            confirmedCount: Object.values(mappings).filter(mapping => String(mapping && mapping.personName || "").trim()).length,
            replacements: persistedReplacements,
          });
        } catch { /* diagnostics must not change finalization behavior */ }
      }
    }
    const llmSegments = hasConfirmedName
      ? segments.map(segment => Object.assign({}, segment, {
          text: applySpeakerNamesForLlm(segment.text, mappings),
          rawText: segment.rawText || segment.text,
        }))
      : segments;
    return {
      segments: llmSegments,
      frontmatter: hasConfirmedName ? Object.assign({}, frontmatter, { [NS_FM_SPEAKERS]: mappings }) : null,
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
    await this.host.recording.discardShortRecordingNote(session);
    const durationMs = Math.max(0, Number(session.shortRecordingDurationMs) || 0);
    const audioName = session.masterAudioName || "";
    if (tier === "discard") {
      new obsidian.Notice(t("Filtered out recordings shorter than three seconds"));
    } else if (audioName) {
      new obsidian.Notice(`${t("Recording under {0} seconds: audio kept in the recording folder, no minutes created and no transcript kept. Import it manually if needed.").replace("{0}", String(limitSeconds))} （${audioName}）`, 8000);
    } else {
      // 母带录音器没产出音频（设备被收回等）→ 没有可留的文件，如实说明。
      new obsidian.Notice(t("Recording under {0} seconds and its audio could not be saved; skipped.").replace("{0}", String(limitSeconds)), 8000);
    }
    try {
      await this.host.diagnostics.logDiagnostic("info", "recording.short_recording_skipped", "短录音未自动转写", {
        tier,
        durationMs,
        audioName,
        mdPath: session.mdPath,
      });
    } catch { /* diagnostics must not change finalization behavior */ }
    if (this.host.session === session) this.host.session = null;
    this.host.shell.refreshOutlineView();
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
      if (this.host.session === session) this.host.session = null;
      this.host.shell.refreshOutlineView();
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
    const segmentsForFinal = this.getSegmentsForFinalSession(session);
    const writeSession = segmentsForFinal === session.segments
      ? session
      : Object.assign({}, session, { segments: segmentsForFinal, multiSourceAudio: true });
    const usableTranscriptSegments = segmentsForFinal.filter(s => s && String(s.text || "").trim());
    if (!usableTranscriptSegments.length) {
      const noTranscriptError = new Error("没有可用于整理的有效转写文本；录音和失败切片已保留");
      this.host.recording.setSessionWorkProgress(session, {
        stage: "transcript-empty",
        label: t("No valid transcript obtained"),
        percent: null,
        detail: "已保留录音，可检查转写服务后从待处理队列重试",
      });
      try {
        await this.host.diagnostics.logDiagnostic("error", "session.no_transcript", "整场没有有效转写，已跳过 LLM 整理以避免无效计费", {
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
      this.host.queueRetry.scheduleDeferredAsrRetry(session);
      if (this.host.session === session) this.host.session = null;
      this.host.shell.refreshOutlineView();
      return;
    }
    session.finalizing = true;
    let speakerPreparation = { segments: segmentsForFinal, frontmatter: null };
    try {
      speakerPreparation = await this.confirmSpeakerNamesBeforeFinal(session, segmentsForFinal);
    } catch (error) {
      console.warn("[QnALog] speaker confirmation failed; continuing with generic labels", error);
      try {
        await this.host.diagnostics.logDiagnostic("warn", "speaker.confirmation_failed", "说话人姓名确认未完成，已保留编号继续整理", {
          mdPath: session.mdPath,
          error: diagnosticError(error),
        });
      } catch { /* intentionally empty */ }
    }
    const segmentsForLlm = speakerPreparation.segments || segmentsForFinal;
    const speakerFrontmatter = speakerPreparation.frontmatter || null;
    this.host.recording.setSessionWorkProgress(session, {
      stage: "finalize-start",
      label: textImportSession ? "读取文本完成" : "准备 AI 整理",
      percent: 12,
      detail: textImportSession ? "已跳过 ASR，正在准备结构化整理" : "转写已结束，正在整理上下文",
    });
    this.host.shell.refreshOutlineView();
    new obsidian.Notice(textImportSession ? "文本已读取，AI 结构化整理中…" : "所有段已处理，AI 合并润色中…");

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
      this.host.recording.setSessionWorkProgress(session, {
        stage: "workbench",
        label: t("Organize context"),
        percent: 22,
        detail: "正在合并会中记录、附件和上下文",
      });
      await this.host.meetingWorkbench.processPendingMeetingWorkbenchInteractions(session, { force: true });
      if (!textImportSession) {
        this.host.recording.setSessionWorkProgress(session, {
          stage: "outline",
          label: t("Generate outline"),
          percent: 36,
          detail: "正在补齐实时大纲，供最终纪要参考",
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
      };
      finalSessionMeta = sessionMeta;
      this.host.recording.setSessionWorkProgress(session, {
        stage: "llm-merge",
        label: t("AI organizing"),
        percent: 62,
        detail: textImport ? "正在把导入文本交给大模型结构化整理" : "正在把分段转写合并成最终纪要",
      });
      taskMeter = this.host.tasks.beginTaskMeter();
      sessionMeta._taskMeter = taskMeter;
      session._finalizeTaskMeter = taskMeter;
      polished = await mergeAndPolish(this.host, segmentsForLlm.map(s => ({
        index: s.index, startOffsetMs: s.startOffsetMs, endOffsetMs: s.endOffsetMs, text: s.text,
        audioName: s.audioName,
        audioStartOffsetMs: s.audioStartOffsetMs,
        audioEndOffsetMs: s.audioEndOffsetMs,
        sourceName: s.sourceName,
        sourcePath: s.sourcePath,
        sourceUrl: s.sourceUrl,
        rawText: s.rawText,
      })), session.mode, sessionMeta, speakerFrontmatter);
      session._briefingCheckpointId = sessionMeta._briefingCheckpointId || "";
      this.host.recording.setSessionWorkProgress(session, {
        stage: "write-note",
        label: t("Write to Minutes"),
        percent: 88,
        detail: "AI 输出已返回，正在写入 Obsidian 笔记",
      });
    } catch (e) { mergeError = e; console.error(e); }
    session.finalizing = false;

    if (mergeError) {
      if (taskMeter) {
        this.host.tasks.endTaskMeter(taskMeter);
        taskMeter = null;
        session._finalizeTaskMeter = null;
      }
      nonRetryableMergeError = isLlmNonRetryableError(mergeError);
      await this.host.diagnostics.logDiagnostic("error", "llm.merge_failed", "LLM 合并整理失败", {
        mode: session.mode,
        segmentCount: segmentsForFinal.length,
        duration: isTextImportSession(session) ? "" : (segmentsForFinal.length ? formatElapsed(segmentsForFinal[segmentsForFinal.length - 1].endOffsetMs || 0) : ""),
        llmEndpoint: this.host.settings.llmEndpoint,
        llmModel: this.host.settings.llmModel,
        nonRetryable: nonRetryableMergeError,
        error: diagnosticError(mergeError),
      });
      const lastSeg = segmentsForFinal[segmentsForFinal.length - 1];
      await this.host.queue.add({
        type: "merge",
        sessionId: session.id,
        mdPath: session.mdPath,
        mode: session.mode,
        status: nonRetryableMergeError ? "blocked" : "pending",
        segments: segmentsForLlm.map(s => ({
          index: s.index, startOffsetMs: s.startOffsetMs, endOffsetMs: s.endOffsetMs, text: s.text,
          audioName: s.audioName,
          audioStartOffsetMs: s.audioStartOffsetMs,
          audioEndOffsetMs: s.audioEndOffsetMs,
          sourceName: s.sourceName,
          sourcePath: s.sourcePath,
          sourceUrl: s.sourceUrl,
          rawText: s.rawText,
        })),
        source: session.source || "",
        sourceMeta: session.sourceMeta || null,
        externalAudioSource: session.externalAudioSource || null,
        textImportSources: session.textImportSources || [],
        speakerFrontmatter,
        sessionMeta: finalSessionMeta || {
          startedAt: session.startedAt,
          duration: isTextImportSession(session) ? "" : (lastSeg ? formatElapsed(lastSeg.endOffsetMs || 0) : ""),
          source: session.source || "",
          sourceMeta: session.sourceMeta || null,
            meetingWorkbench: normalizeMeetingWorkbench(session.meetingWorkbench),
        },
        lastError: mergeError.message || String(mergeError),
      });
      if (!nonRetryableMergeError) {
        this.host.queueRetry.scheduleTaskQueueRetry(1500, mergeError instanceof BriefingPipelineIncompleteError
          ? "briefing-partial"
          : "briefing-finalization-failure");
      }
      session.finalizationError = getErrorMessage(mergeError);
      const partialBriefing = mergeError instanceof BriefingPipelineIncompleteError;
      this.host.recording.setSessionWorkProgress(session, {
        stage: nonRetryableMergeError ? "merge-failed" : "merge-retrying",
        label: nonRetryableMergeError ? "AI 整理失败" : partialBriefing ? "纪要部分完成" : "AI 整理等待重试",
        percent: null,
        detail: nonRetryableMergeError
          ? "原始转写已保留；请修复大模型配置后重新整理"
          : partialBriefing
            ? `${mergeError.message}；已完成部分和原始转写均已保存`
            : "原始转写已保留；后台队列会按退避规则再次尝试",
      });
    }

    if (!mergeError) {
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
        await this.host.diagnostics.logDiagnostic("error", "briefing.commit_failed", "纪要正文已生成，但写入 Markdown 失败", {
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
          segments: segmentsForLlm.map(s => ({
            index: s.index, startOffsetMs: s.startOffsetMs, endOffsetMs: s.endOffsetMs, text: s.text,
            audioName: s.audioName,
            audioStartOffsetMs: s.audioStartOffsetMs,
            audioEndOffsetMs: s.audioEndOffsetMs,
            sourceName: s.sourceName,
            sourcePath: s.sourcePath,
            sourceUrl: s.sourceUrl,
            rawText: s.rawText,
          })),
          source: session.source || "",
          sourceMeta: session.sourceMeta || null,
          externalAudioSource: session.externalAudioSource || null,
          textImportSources: session.textImportSources || [],
          speakerFrontmatter,
          sessionMeta: finalSessionMeta,
          lastError: `纪要写入失败：${getErrorMessage(writeError)}`,
        });
        this.host.queueRetry.scheduleTaskQueueRetry(1500, "briefing-write-failure");
        this.host.recording.setSessionWorkProgress(session, {
          stage: "write-retrying",
          label: t("Minutes write waiting to retry"),
          percent: null,
          detail: "AI 整理结果已保存，不会重复调用模型；稍后只重试写入",
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
      this.host.recording.setSessionWorkProgress(session, {
        stage: "done",
        label: t("Processing complete"),
        percent: 100,
        detail: "纪要已写入，正在收尾",
      });
    }

    if (!mergeError && polished) {
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

    if (!mergeError && polished) {
      await this.host.noteIndex.refreshNoteIndexSafely(writeSession.mdPath, {
        meetingDate: session.startedAt,
        reason: "finalize",
      });
      try { await this.host.noteIndex.appendDailyMeetingOverview(writeSession, polished); }
      catch (e) { console.error("[QnALog] daily overview failed", e); }
    }

    if (!mergeError) {
      await this.host.recording.cleanupSuccessfulSegmentAudio(session);
      const completedTaskMeter = taskMeter ? this.host.tasks.endTaskMeter(taskMeter) : null;
      taskMeter = null;
      session._finalizeTaskMeter = null;
      try {
        const doneLabel = isTextImportSession(session) ? "文本整理完成"
          : session.source === "import" ? "导入音频整理完成" : "录音纪要整理完成";
        this.host.tasks.logCompletedWork(doneLabel, session.mdPath || "", completedTaskMeter);
      } catch { /* intentionally empty */ }
      // 沉淀开关默认关闭：开启后转写完成自动跑沉淀扫描并入库；关闭则照旧手动点「沉淀」。后台执行、失败静默。
      if (this.host.settings.sedimentAutoExtract) void this.host.noteIndex.autoExtractSedimentAfterFinalize(session.mdPath);
    }

    new obsidian.Notice(mergeError
      ? (nonRetryableMergeError
        ? `AI 整理失败：${formatLlmFailureIssue(mergeError.message || mergeError)}`
        : commitError
          ? "纪要正文已生成，写入失败，已加入重试队列"
          : mergeError instanceof BriefingPipelineIncompleteError
          ? `${mergeError.message}，已加入精确重试`
          : "AI 整理未完成，已加入重试队列")
      : "Q&A Log 处理完成");

    if (this.host.settings.autoOpenNoteAfterFinish) {
      const file = this.host.app.vault.getAbstractFileByPath(session.mdPath);
      if (file instanceof obsidian.TFile) {
        try { await this.host.app.workspace.getLeaf(false).openFile(file); } catch { /* intentionally empty */ }
      }
    }
    this.host.queueRetry.scheduleDeferredAsrRetry(session);
    if (this.host.session === session) this.host.session = null;
    this.host.shell.refreshOutlineView();
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
