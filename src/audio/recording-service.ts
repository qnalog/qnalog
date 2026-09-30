/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 录音采集服务：开始/停止、录音状态与分段写入顺序。

import * as obsidian from "obsidian";
import { normalizeAudioInputMode, audioInputModeLabel } from "../ui/helpers";
import { getModeMeta, getModePrefix, getEffectivePolishMode } from "../shared/mode-meta";
import { isMobileRuntime } from "../shared/util-platform";
import type { PluginSettings, RecordingSession, PreparedLiveSegment, RecorderSegmentPayload } from "../shared/types";
import { PcmStreamEncoder } from "../asr/clients";
import { getErrorMessage, genId } from "../shared/util-common";
import { LIVE_ASR_TASK_STATUS } from "../asr/live-segment-policy";
import { diagnosticError } from "../shared/util-key-diag";
import { initialAudioChannelRuntimeMode, normalizeAudioChannelMode } from "../audio/channel-speakers";
import { QUICK_INTERIM_CUTS_MS } from "../shared/limits";
import { classifyShortRecording } from "./short-recording-policy";
import { isSpeakerDiarizationProvider } from "../asr/diarization";
import { classifyRecordingIssue, createStreamingTranscriptionClient, resolveRuntimeAudioInputMode } from "../notes/recording-issues";
import { normalizeRealtimeOutlineState, stripArchivedOutlineSections } from "../notes/realtime-outline";
import { extractDetailsBody } from "../notes/detail-blocks";
import { ensureTranscriptBlocks, extractTranscriptSegments, getSourceIdFromMarkdown, inferNoteStartedAtIso, normalizeSegmentsForMergedNote } from "../notes/note-markdown";
import { getDurationMs, getSegmentsDurationMs, collectAudioRefs } from "../notes/audio-refs";
import { nsMarker } from "../shared/namespace";
import { RecorderService } from "../audio/recorder-service";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { ensureVaultFolder } from "../shared/util-vault";
import { NoteWriter } from "../notes/note-writer";
import { TranscribeProfileService } from "../asr/transcribe-profile-service";
import type { LiveAsrPipelineService } from "../asr/live-asr-pipeline-service";

import { t } from "../shared/i18n";
import type { SessionStore } from "../session/session-store";
import { labelPattern, labelText } from "../shared/note-labels";

/**
 * 从既有纪要正文读回「录音中实时大纲（草稿）」details 的内容，
 * 剥掉引导行（"> 基于录音过程中…"）。剥掉归档段（"> 以下为追加录音前场次…" 及历史副本）后返回；没有该块或内容为空时返回空串。
 * 续录重写时旧大纲按场次保留，不因整篇重建丢失。
 */
export function extractPriorOutline(markdown) {
  const raw = extractDetailsBody(markdown, labelPattern("liveOutlineDraft"));
  // 归档段（"> 以下为追加录音前场次…" 及其历史副本）不随读回进入种子与附录——
  // 两者共用这一处读回，单点剥干净后新场次的 live 大纲与 appendix 都不再自引用。
  return stripArchivedOutlineSections(
    String(raw || "")
      .replace(OUTLINE_INTRO_LINE_RE, "")
      .trim()
  );
}

/** 大纲 details 的引导行（`> 基于录音过程中…` / `> Outline generated…`）：双语，行锚点剥离。 */
const OUTLINE_INTRO_LINE_RE = new RegExp(`^>\\s*(?:${labelPattern("outlineIntro").source})[^\\n]*\\n?`, "m");

/** 开始录音时的选项：不带参数即新建纪要，带 appendToFile 即续录到该篇。 */
export interface StartRecordingOptions {
  appendToFile?: unknown;
}

/** RecordingService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface RecordingHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  diagnostics: DiagnosticsService;
  /** 互动看板服务：实时互动调度与流式笔记更新。 */
  meetingWorkbench: {
    makeStreamingNoteUpdater(session: RecordingSession): () => void;
    scheduleMeetingWorkbenchInteraction(session: RecordingSession, interaction: unknown): void;
  };
  noteWriter: NoteWriter;
  profiles: TranscribeProfileService;
  recorder: RecorderService | null;
  saveSettings(): Promise<void>;
  sessionStore: SessionStore;
  asrPipeline: LiveAsrPipelineService;
  processRecordedSegment(session: RecordingSession, seg: PreparedLiveSegment): Promise<void>;
  finalizeRecordedSession(session: RecordingSession): Promise<void>;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
  /** 装配层转发：请求刷新侧边栏（调用 ViewShellService.refreshOutlineView）。 */
  requestOutlineRefresh(): void;
  /** 装配层转发：请求打开侧边栏（调用 ViewShellService.openOutlineView），仅录音流程自动打开使用。 */
  requestOpenOutlineView(): Promise<void>;
}

export class RecordingService {
  declare host: RecordingHost;
  /** 本次一次性录音的采集模式与润色模式（命令入口设置）。 */
  declare _oneShotCaptureMode;
  declare _oneShotPolishMode;
  constructor(host: RecordingHost) {
    this.host = host;
    this._oneShotCaptureMode = null;
    this._oneShotPolishMode = null;
  }

  async toggleRecording() {
    if (this.host.recorder.state === "idle") await this.startRecording();
    else await this.stopRecording();
  }

  async getContinuationTargetInfo(file) {
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") {
      throw new Error(t("The target is not a Markdown note"));
    }
    let content = await this.host.app.vault.read(file);
    const sourceId = getSourceIdFromMarkdown(content, file);
    const transcriptReady = ensureTranscriptBlocks(content, sourceId);
    if (transcriptReady !== content) {
      await this.host.app.vault.modify(file, transcriptReady);
      content = transcriptReady;
    }
    const segments = extractTranscriptSegments(content);
    if (!segments.length) {
      throw new Error(t("This note has no original transcript segments to continue recording from"));
    }
    const frontmatter = ((this.host.app.metadataCache.getFileCache(file) || {}).frontmatter) || {};
    const mode = this.host.noteWriter.detectModeFromMarkdown(file) || getEffectivePolishMode(this.host.settings, this.host.settings.polishMode);
    const normalized = normalizeSegmentsForMergedNote(segments, 0, 0, file);
    const durationMs = getSegmentsDurationMs(normalized) || getDurationMs(content);
    return {
      file,
      content,
      mode,
      segments: normalized,
      durationMs,
      startedAt: inferNoteStartedAtIso(file, frontmatter),
      frontmatter,
      // 旧场次的原始材料读回：续录重写笔记时按场次保留，不因重整丢失。
      priorOutline: extractPriorOutline(content),
      priorAudioNames: collectAudioRefs(content),
      priorRecordingInfo: extractDetailsBody(content, labelPattern("recordingInfo")),
      priorRecordedAt: inferNoteStartedAtIso(file, frontmatter),
    };
  }

  async startRecording(options: StartRecordingOptions = {}) {
    if (this.host.recorder.state !== "idle") {
      new obsidian.Notice(t("A recording is already in progress. Please stop it before continuing to record."), 5000);
      return;
    }
    const appendTargetFile = options && options.appendToFile instanceof obsidian.TFile ? options.appendToFile : null;
    let continuationInfo = null;
    if (appendTargetFile) {
      try {
        continuationInfo = await this.getContinuationTargetInfo(appendTargetFile);
      } catch (e) {
        console.error("[QnALog] prepare continuation target failed", e);
        new obsidian.Notice(`${t("Cannot continue recording into this minutes note: ")}${(e && e.message) || e}`, 8000);
        return;
      }
    }
    const mode = continuationInfo && continuationInfo.mode
      ? continuationInfo.mode
      : getEffectivePolishMode(this.host.settings, this._oneShotPolishMode || this.host.settings.polishMode);
    let createdSession: RecordingSession | null = null;
    try {
      this.host.asrPipeline.clearRecordingIssue();
      await ensureVaultFolder(this.host.app, this.host.settings.audioFolder);
      await ensureVaultFolder(this.host.app, this.host.settings.mdFolder);
      const moment = window.moment;
      const startedAt = moment();
      const sessionStamp = startedAt.format("YYYYMMDD-HHmmss");
      const mdName = startedAt.format(this.host.settings.noteFileNameFormatNew);
      const mdPath = continuationInfo
        ? obsidian.normalizePath(continuationInfo.file.path)
        : obsidian.normalizePath(`${this.host.settings.mdFolder}/${mdName}.md`);

      const meta = getModeMeta(this.host.settings, mode);
      const oneShotMode = this._oneShotCaptureMode;
      const requestedCaptureMode = oneShotMode || this.host.settings.captureMode || "mic";
      const captureMode = resolveRuntimeAudioInputMode(requestedCaptureMode);
      const forcedMobileMic = isMobileRuntime() && normalizeAudioInputMode(requestedCaptureMode) !== "mic";
      createdSession = {
        id: genId(),
        sessionStamp,
        startedAt: continuationInfo && continuationInfo.startedAt ? continuationInfo.startedAt : startedAt.toDate().toISOString(),
        mdPath,
        mode,
        segments: [],
        continuationBaseSegments: continuationInfo ? continuationInfo.segments : [],
        continuationOffsetMs: continuationInfo ? continuationInfo.durationMs : 0,
        continuationSourcePath: continuationInfo ? continuationInfo.file.path : "",
        continuationSourceTitle: continuationInfo ? continuationInfo.file.basename : "",
        continuationRecordedAt: continuationInfo ? startedAt.toDate().toISOString() : "",
        continuationPriorOutline: continuationInfo ? (continuationInfo.priorOutline || "") : "",
        continuationPriorAudioNames: continuationInfo ? (continuationInfo.priorAudioNames || []) : [],
        continuationPriorRecordingInfo: continuationInfo ? (continuationInfo.priorRecordingInfo || "") : "",
        // 旧场次大纲作为实时大纲种子：增量管线在新段到来时以它为基础冻结合并生长，
        // 收尾追赶只处理新段；不是种子的话新会话大纲从零开始，笔记里的大纲 details
        // 就只有旧场次内容（rewriteConsolidated 的"无新大纲"兜底分支），永不反映追加内容。
        realtimeOutline: continuationInfo ? (continuationInfo.priorOutline || "") : "",
        realtimeOutlineState: continuationInfo && continuationInfo.priorOutline
          ? normalizeRealtimeOutlineState(undefined, continuationInfo.priorOutline, "")
          : { version: 1, nodes: [], memory: "" },
        realtimeOutlineMemory: "",
        realtimeOutlineSegmentCount: 0,
        realtimeOutlineAttemptedSegmentCount: 0,
        realtimeOutlineAttemptedAt: "",
        realtimeOutlineWorkbenchSignature: "",
        realtimeOutlineFailureCount: 0,
        realtimeOutlineNextAllowedAt: 0,
        realtimeOutlineNoChangeCommittedCount: -1,
        realtimeOutlineNoChangeRetryCount: 0,
        writeQueue: Promise.resolve(),
        pendingMeetingWorkbenchInteractions: [],
        finalized: false,
        captureMode,
        audioChannelCount: 1,
        audioChannelMaxCount: 1,
        audioChannelLabel: "",
        audioChannelMode: normalizeAudioChannelMode(this.host.settings.audioChannelMode),
        audioChannelRuntimeMode: "mono",
        speakerChannels: {},
        channelSeparationMode: "single",
        meetingWorkbench: { notes: "", draft: "", materials: [], entries: [] },
      };
      this.host.asrPipeline.initializeSession(createdSession);
      this.host.sessionStore.begin(createdSession);
      this.host.asrPipeline.setSessionWorkProgress(createdSession, {
        stage: "recording",
        label: t("Recording"),
        percent: null,
        detail: t("Collecting audio; segments are transcribed automatically"),
      });

      const activeProviderId = this.host.settings.activeTranscribeProvider || "siliconflow";
      const activeProvider = (this.host.settings.transcribeProviders || {})[activeProviderId] || {};
      const activeProfile = this.host.profiles.getActiveTranscribeProfile();
      const isStreaming = activeProfile && activeProfile.transcribeMode === "streaming";
      const titleLine = continuationInfo
        ? `## ${labelText("appendToAt", getModePrefix(meta), startedAt.format("YYYY-MM-DD HH:mm"))}`
        : `# ${startedAt.format("YYYY-MM-DD HH:mm")} · ${getModePrefix(meta)}${t("(recording…)")}`;
      const header = [
        continuationInfo ? "" : null,
        titleLine,
        "",
        nsMarker("session", createdSession.id),
        nsMarker("segments-start", createdSession.id),
        nsMarker("segments-end", createdSession.id),
        "",
      ].filter(v => v !== null).join("\n");
      await this.host.noteWriter.appendToNote(mdPath, header);

      const requiresWholeSession = !!(activeProfile && activeProfile.requiresWholeSession)
        || isSpeakerDiarizationProvider(activeProvider);
      const segmentDurationMs = isStreaming || requiresWholeSession
        ? 0
        : (this.host.settings.enableInterimOutput
          ? Math.max(30, Math.floor(this.host.settings.segmentIntervalMinutes * 60)) * 1000
          : 0);

      const sessionRef = createdSession;
      sessionRef.captureMode = captureMode;
      this._oneShotCaptureMode = null;
      if (!oneShotMode && this.host.settings.captureMode !== captureMode) {
        this.host.settings.captureMode = captureMode;
        await this.host.saveSettings();
      }

      let onStreamReady = null;
      if (isStreaming && isMobileRuntime()) {
        // 移动端无 Node WebSocket（设不了鉴权头），流式必败：不建流式客户端，提前明示。
        // 录音照常进行，停止时走既有的「流式连接未建立」兜底（音频保留）。
        new obsidian.Notice(t("Streaming transcription is not supported on mobile yet; this recording will keep its audio, so use streaming on desktop or switch to a segmented transcription service."), 9000);
      } else if (isStreaming) {
        onStreamReady = async (mediaStream) => {
          const sampleRate = activeProfile.streamProtocol && activeProfile.streamProtocol.startsWith("openai-realtime") ? 24000 : 16000;
          const client = createStreamingTranscriptionClient(activeProfile, activeProvider, {
            onPartial: (fullText, isFinal) => {
              this.host.asrPipeline.clearRecordingIssue("network");
              this.host.asrPipeline.clearRecordingIssue("service");
              sessionRef.streamingFullText = fullText || "";
              if (sessionRef.scheduleStreamingNoteUpdate) sessionRef.scheduleStreamingNoteUpdate();
            },
            onError: (e) => {
              console.error("[QnALog] streaming error", e);
              this.host.asrPipeline.setRecordingIssue(classifyRecordingIssue(e), {
                source: "streaming-asr",
                message: getErrorMessage(e),
              });
              new obsidian.Notice(`${t("Streaming transcription error: ")}${(e && e.message) || e}`);
            },
            onClosed: (info) => {
              if (info && info.translatedText) sessionRef.streamingTranslatedText = info.translatedText;
              if (info && info.sourceText) sessionRef.streamingSourceText = info.sourceText;
            },
          });
          sessionRef.streamingClient = client;
          sessionRef.scheduleStreamingNoteUpdate = this.host.meetingWorkbench.makeStreamingNoteUpdater(sessionRef);
          try {
            await client.connect();
          } catch (e) {
            console.error("[QnALog] streaming connect failed", e);
            this.host.asrPipeline.setRecordingIssue(classifyRecordingIssue(e), {
              source: "streaming-asr",
              message: getErrorMessage(e),
            });
            new obsidian.Notice(`${t("Streaming transcription connection failed: ")}${(e && e.message) || e}`);
            sessionRef.streamingClient = null;
            return;
          }
          const encoder = new PcmStreamEncoder(mediaStream, {
            sampleRate,
            onFrame: (ab) => client.sendAudioFrame(ab),
          });
          encoder.start();
          sessionRef.pcmEncoder = encoder;
        };
      }

      const providerStreamReady = onStreamReady;
      onStreamReady = async (mediaStream, channelInfo) => {
        const count = Math.max(1, Math.min(4, Number(channelInfo && channelInfo.channelCount) || 1));
        sessionRef.audioChannelCount = count;
        sessionRef.audioChannelMaxCount = Math.max(count, Number(channelInfo && channelInfo.maxChannelCount) || count);
        sessionRef.audioChannelLabel = String(channelInfo && channelInfo.label || "");
        sessionRef.audioChannelMode = normalizeAudioChannelMode(channelInfo && channelInfo.channelMode || this.host.settings.audioChannelMode);
        sessionRef.audioChannelRuntimeMode = captureMode === "mic"
          ? initialAudioChannelRuntimeMode(sessionRef.audioChannelMode, count)
          : "mono";
        sessionRef.channelSeparationMode = sessionRef.audioChannelRuntimeMode === "mono" ? "single" : "pending";
        // A stereo-looking track is not proof of two speakers. Windows drivers often
        // duplicate one microphone into L/R. Create mappings only after recorded
        // content confirms independent channels.
        sessionRef.speakerChannels = {};
        if (isStreaming && count > 1) {
          sessionRef.channelSeparationMode = "single";
          new obsidian.Notice(t("Live transcription does not separate speakers yet; to separate them, enable speaker identification when importing audio."), 9000);
        }
        if (providerStreamReady) await providerStreamReady(mediaStream);
      };

      await this.host.recorder.start({
        segmentDurationMs,
        quickCutMarksMs: segmentDurationMs > 0 ? QUICK_INTERIM_CUTS_MS : [],
        captureMode,
        onSegment: (seg) => this.handleSegment(sessionRef, seg),
        onStreamReady,
      });
      if (this.host.settings.autoOpenOutlineOnRecord) {
        try { await this.host.requestOpenOutlineView(); } catch (e) { console.error("[QnALog] auto-open outline failed", e); }
      }
      const modeLabel = audioInputModeLabel(captureMode);
      const noticeText = isStreaming
        ? t("Recording in progress ({0}), real-time transcription with {1}.").replace("{0}", modeLabel).replace("{1}", activeProfile.title || t("Streaming service"))
        : requiresWholeSession
          ? t("Recording in progress ({0}); transcription and speaker confirmation run after you stop.").replace("{0}", modeLabel)
        : (this.host.settings.enableInterimOutput
          ? t("Recording in progress ({0}); quick output during startup, then instant transcription every {1} minutes.").replace("{0}", modeLabel).replace("{1}", String(this.host.settings.segmentIntervalMinutes))
          : t("Recording in progress ({0}); everything is processed when you stop.").replace("{0}", modeLabel));
      new obsidian.Notice(noticeText);
      if (continuationInfo) {
        new obsidian.Notice(`${t("Started appending to \"")}${continuationInfo.file.basename}${t("\"; it will be merged back into the original minutes when stopped.")}`, 8000);
      }
      if (forcedMobileMic) {
        new obsidian.Notice(t("Mobile only supports microphone recording for now; use computer audio / virtual audio devices on desktop."), 8000);
      }
      if (isMobileRuntime()) {
        new obsidian.Notice(t("On mobile, keep Obsidian in the foreground while recording; locking the screen or switching to the background may interrupt the recording."), 8000);
      }
    } catch (e) {
      console.error(e);
      await this.host.diagnostics.logDiagnostic("error", "recording.start_failed", t("Failed to start recording"), {
        captureMode: this.host.settings.captureMode,
        requestedMode: this._oneShotCaptureMode || "",
        error: diagnosticError(e),
      });
      new obsidian.Notice(`${t("Cannot start recording: ")}${(e && e.message) || e}`);
      // 清理半初始化状态：启动异常后只结束本次创建的会话，避免清除随后开始的新会话。
      try { if (this.host.recorder && this.host.recorder.state !== "idle") await this.host.recorder.stop(); } catch { /* intentionally empty */ }
      try { if (this.host.recorder && typeof this.host.recorder.releaseStream === "function") this.host.recorder.releaseStream(); } catch { /* intentionally empty */ }
      if (createdSession) {
        this.host.sessionStore.end(createdSession);
        try { await this.host.noteWriter.removeEmptySessionBlock(createdSession); } catch { /* intentionally empty */ }
      }
      this._oneShotCaptureMode = null;
      try { this.host.requestOutlineRefresh(); } catch { /* intentionally empty */ }
    }
  }

  async stopRecording() {
    if (this.host.recorder.state === "idle") return;
    new obsidian.Notice(t("⏹ Stop requested, processing the final segment..."));
    await this.host.recorder.stop();
    this.host.asrPipeline.clearRecordingIssue();
  }

  /**
   * 一场录音的处理级别：丢弃 / 只留音频 / 正常整理。
   *
   * 只对最后一个切片判定，因为在此之前总时长还没有定下来。已有切片（长度已经越过第一个
   * 切点）、导入音频、续录到既有纪要三种情况都按正常流程走：前两种说明录音本身不短或
   * 用户已指定要转写，第三种由用户显式发起且目标笔记已存在。
   */
  resolveShortRecordingTier(session, seg) {
    return classifyShortRecording({
      durationMs: seg && seg.isFinal ? Number(seg.endOffsetMs) || 0 : 0,
      isFinal: !!(seg && seg.isFinal),
      hasSegments: !!(session && session.segments && session.segments.length),
      filterShortRecordings: this.host.settings.filterShortRecordings !== false,
      isImported: !!(session && (session.source === "import" || session.source === "text-import")),
      isContinuation: !!(session && session.continuationSourcePath),
    });
  }


  handleSegment(session: RecordingSession, seg: RecorderSegmentPayload) {
    if (!session) return;
    const tier = this.resolveShortRecordingTier(session, seg);
    let preparedSeg;
    if (tier !== "process") {
      // 短录音不转写。丢弃级别不落盘音频；只留音频级别把整场音频写进录音目录。
      // 分级函数只在最后一个切片上返回短录音级别，所以这里的 isFinal 必为真。
      session.shortRecordingTier = tier;
      session.shortRecordingDurationMs = Math.max(0, Number(seg && seg.endOffsetMs) || 0);
      preparedSeg = {
        isFinal: true,
        endOffsetMs: session.shortRecordingDurationMs,
        masterAudioSavePromise: tier === "discard" ? Promise.resolve() : this.host.asrPipeline.startMasterAudioSave(session, seg),
      };
      this.host.asrPipeline.beginSessionSegmentWork(session);
    } else if (seg && seg.masterOnly) {
      const masterAudioSavePromise = this.host.asrPipeline.startMasterAudioSave(session, seg);
      preparedSeg = {
        isFinal: !!seg.isFinal,
        masterOnly: true,
        endOffsetMs: Math.max(0, Number(seg.endOffsetMs) || 0),
        masterAudioSavePromise,
      };
      this.host.asrPipeline.beginSessionSegmentWork(session);
    } else {
      const descriptor = this.host.asrPipeline.prepareLiveSegmentDescriptor(session, seg);
      const masterAudioSavePromise = this.host.asrPipeline.startMasterAudioSave(session, seg);
      preparedSeg = {
        ...descriptor,
        masterAudioSavePromise,
        spoolPromise: this.host.asrPipeline.queueLiveSegmentPersistence(session, descriptor, seg.blob),
      };
    }

    session.writeQueue = Promise.resolve(session.writeQueue).catch((e) => {
      console.error("[QnALog] recovered rejected write chain before next segment", e);
    }).then(async () => {
      try {
        await this.host.processRecordedSegment(session, preparedSeg);
      } catch (e) {
        // 本段异常不能毒化后续写入链；processSegment 已尽力保留缓存并加入后台重试。
        console.error("[QnALog] processSegment failed (swallowed to protect write chain)", e);
        try {
          const task = preparedSeg.queueTaskId && this.host.asrPipeline.getQueueTask(preparedSeg.queueTaskId);
          if (preparedSeg.segmentAudioPath && (!task || task.status === LIVE_ASR_TASK_STATUS || task.status === "running")) {
            await this.host.asrPipeline.keepLiveSegmentQueueTaskForRetry(session, preparedSeg, e);
            this.host.asrPipeline.markSessionAsrJobsDeferred(session);
          }
        } catch (queueError) {
          console.error("[QnALog] preserve live segment task after processing failure failed", queueError);
        }
        try { await this.host.diagnostics.logDiagnostic("error", "segment.process_failed", t("Segment processing error (swallowed to avoid poisoning the write chain)"), { mode: session.mode, isFinal: !!preparedSeg.isFinal, error: diagnosticError(e) }); } catch { /* intentionally empty */ }
      } finally {
        this.host.asrPipeline.finishSessionSegmentWork(session, preparedSeg.jobId, "completed");
        if (!preparedSeg.isFinal && session.pendingMeetingWorkbenchInteractions && session.pendingMeetingWorkbenchInteractions.length) {
          this.host.meetingWorkbench.scheduleMeetingWorkbenchInteraction(session, session.pendingMeetingWorkbenchInteractions[0]);
        }
      }
    });
    if (preparedSeg.isFinal) {
      // 双分支：无论前序链 fulfilled 还是 rejected，finalizeSession 都必须跑。
      session.writeQueue = session.writeQueue.then(
        () => this.host.finalizeRecordedSession(session),
        (e) => { console.error("[QnALog] write chain rejected before finalize", e); return this.host.finalizeRecordedSession(session); }
      );
    }
    // 录音中的普通切段只等音频安全落盘，不应继续 await 慢速 ASR 链。
    // 否则每个 cutSegment 异步栈都会持有原 Blob，等于从队列外侧把内存积压重新引回来。
    // 最终段仍等待完整收尾，保持“停止录音完成后才允许下一场”的既有会话语义。
    if (preparedSeg.isFinal) return session.writeQueue;
    const releasePromises = [];
    if (preparedSeg.spoolPromise) releasePromises.push(preparedSeg.spoolPromise);
    if (preparedSeg.masterAudioSavePromise) releasePromises.push(preparedSeg.masterAudioSavePromise);
    if (releasePromises.length) return Promise.all(releasePromises).then(() => undefined);
    return session.writeQueue;
  }



  getRecorderBufferSummary() {
    const sumBytes = (items) => (Array.isArray(items) ? items : []).reduce((total, item) => total + Math.max(0, Number(item && item.size) || 0), 0);
    const masterChunks = this.host.recorder && Array.isArray(this.host.recorder.masterChunks) ? this.host.recorder.masterChunks : [];
    const segmentChunks = this.host.recorder && Array.isArray(this.host.recorder.chunks) ? this.host.recorder.chunks : [];
    return {
      masterChunkCount: masterChunks.length,
      masterChunkBytes: sumBytes(masterChunks),
      currentSegmentChunkCount: segmentChunks.length,
      currentSegmentChunkBytes: sumBytes(segmentChunks),
    };
  }


  getRecordingIssue() {
    const recorderIssue = this.host.recorder && this.host.recorder.getInfo ? (this.host.recorder.getInfo().issue || null) : null;
    if (recorderIssue && recorderIssue.kind === "microphone") return recorderIssue;
    return this.host.asrPipeline.getRecordingIssue() || recorderIssue || null;
  }

}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
