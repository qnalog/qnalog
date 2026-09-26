/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：录音采集：开始/停止、切片与整场音频落盘、分段缓存、实时 ASR 积压与熔断、片段入队

import * as obsidian from "obsidian";
import { getRealtimeOutlineAnchorTime } from "../outline-text";
import { normalizeAudioInputMode, audioInputModeLabel } from "../ui/helpers";
import { getModeMeta, getModePrefix, getEffectivePolishMode } from "../shared/mode-meta";
import { isMobileRuntime } from "../shared/util-platform";
import { resolveTranscribeProvider } from "../asr/transcribe";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { PluginSettings, RecordingSession } from "../shared/types";
import type { RecorderSegmentPayload } from "../shared/types";
import { PcmStreamEncoder } from "../asr/clients";
import { AUDIO_EXT } from "../shared/catalog-import";
import { getErrorMessage, genId, pad, escapeRegExp } from "../shared/util-common";
import { extFromMime, isAsrTransportError, isTransientAsrError } from "../shared/util-audio";
import { LIVE_ASR_TASK_STATUS, classifyLiveAsrBacklog, createLiveAsrCircuitState, isLiveAsrCircuitOpen, recordLiveAsrFailure, recordLiveAsrSuccess, summarizeLiveAsrJobs } from "../asr/live-segment-policy";
import type { LiveAsrCircuitState } from "../asr/live-segment-policy";
import { diagnosticError } from "../shared/util-key-diag";
import { audioImportStageFromWorkProgress } from "../shared/activity-progress";
import { initialAudioChannelRuntimeMode, normalizeAudioChannelMode } from "../audio/channel-speakers";
import { isSpeakerDiarizationProvider } from "../asr/diarization";
import { QUICK_INTERIM_CUTS_MS, SEGMENT_CACHE_RETENTION_MS } from "../shared/limits";
import { classifyShortRecording } from "./short-recording-policy";
import { classifyRecordingIssue, createStreamingTranscriptionClient, resolveRuntimeAudioInputMode } from "../notes/recording-issues";
import { normalizeRealtimeOutlineState, stripArchivedOutlineSections } from "../notes/realtime-outline";
import { getDurationMs, getSegmentsDurationMs, getSessionMasterAudioName, collectAudioRefs } from "../notes/audio-refs";
import { extractDetailsBody } from "../notes/detail-blocks";
import { extractTranscriptSegments, inferNoteStartedAtIso, normalizeSegmentsForMergedNote } from "../notes/note-markdown";
import { RecorderService } from "../audio/recorder-service";
import { TaskQueue } from "../queue/task-queue";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { makeRecordingIssue } from "../asr/transcribe";
import { TaskActivityService } from "../tasks/task-activity-service";
import { ensureVaultFolder, findAvailableVaultPath } from "../shared/util-vault";
import { NoteWriter } from "../notes/note-writer";
import { TranscribeProfileService } from "../asr/transcribe-profile-service";
import { MeetingWorkbenchService } from "../notes/meeting-workbench-service";
import { NS_AUDIO_PREFIX, nsMarker } from "../shared/namespace";
import type { LiveAsrPipeline } from "../shared/live-asr-pipeline";

import { t } from "../shared/i18n";

/**
 * 从既有纪要正文读回「录音中实时大纲（草稿）」details 的内容，
 * 剥掉引导行（"> 基于录音过程中…"）。剥掉归档段（"> 以下为追加录音前场次…" 及历史副本）后返回；没有该块或内容为空时返回空串。
 * 续录重写时旧大纲按场次保留，不因整篇重建丢失。
 */
export function extractPriorOutline(markdown) {
  const raw = extractDetailsBody(markdown, /录音中实时大纲/);
  // 归档段（"> 以下为追加录音前场次…" 及其历史副本）不随读回进入种子与附录——
  // 两者共用这一处读回，单点剥干净后新场次的 live 大纲与 appendix 都不再自引用。
  return stripArchivedOutlineSections(
    String(raw || "")
      .replace(/^>\s*基于录音过程中已完成的分段自动生成[^\n]*\n?/m, "")
      .trim()
  );
}

/** 开始录音时的选项：不带参数即新建纪要，带 appendToFile 即续录到该篇。 */
export interface StartRecordingOptions {
  appendToFile?: unknown;
}

/** RecordingService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface RecordingHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  /** 悬浮气泡：录音问题变化时请求刷新。 */
  bubble: { scheduleUpdate?: () => void } | null;
  diagnostics: DiagnosticsService;
  meetingWorkbench: MeetingWorkbenchService;
  noteWriter: NoteWriter;
  profiles: TranscribeProfileService;
  queue: TaskQueue | null;
  recorder: RecorderService | null;
  saveSettings(): Promise<void>;
  session: RecordingSession | null;
  /** 会话收尾服务：切片转写与停止后的收尾（装配层绑定，见 sessionPipeline 注释）。 */
  sessionPipeline: { finalizeSession(session: RecordingSession): Promise<void>; processSegment(session: RecordingSession, seg: unknown): Promise<void>; confirmSpeakerNamesBeforeFinal(session: RecordingSession, segments: unknown[]): Promise<boolean> };
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
  /** 装配层转发：请求刷新侧边栏（调用 ViewShellService.refreshOutlineView）。 */
  requestOutlineRefresh(): void;
  /** 装配层转发：请求打开侧边栏（调用 ViewShellService.openOutlineView），仅录音流程自动打开使用。 */
  requestOpenOutlineView(): Promise<void>;
  tasks: TaskActivityService;
}

export class RecordingService implements LiveAsrPipeline {
  declare host: RecordingHost;
  /** 本次一次性录音的采集模式与润色模式（命令入口设置）。 */
  declare _oneShotCaptureMode;
  declare _oneShotPolishMode;
  /** 转写服务的熔断状态：按服务键区分，连续瞬时失败后暂停批量转写。 */
  declare asrServiceCircuitKey;
  /** 实时转写熔断状态；随转写服务配置变化重建。 */
  declare asrServiceCircuitState: LiveAsrCircuitState | null;
  /** 当前录音问题（设备/服务/切片），无问题时为空。 */
  declare recordingIssue;

  constructor(host) {
    this.host = host;
    this._oneShotCaptureMode = null;
    this.recordingIssue = null;
    this.asrServiceCircuitKey = "";
    this.asrServiceCircuitState = createLiveAsrCircuitState();
    this._oneShotPolishMode = null;
    this.asrServiceCircuitKey = null;
    this.asrServiceCircuitState = null;
  }

  async toggleRecording() {
    if (this.host.recorder.state === "idle") await this.startRecording();
    else await this.stopRecording();
  }

  async getContinuationTargetInfo(file) {
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") {
      throw new Error("目标不是 Markdown 纪要");
    }
    const content = await this.host.app.vault.read(file);
    const segments = extractTranscriptSegments(content);
    if (!segments.length) {
      throw new Error("这篇纪要里没有可续录合并的原始转写分段");
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
      priorRecordingInfo: extractDetailsBody(content, /录音信息/),
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
    try {
      this.clearRecordingIssue();
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
      this.host.session = {
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
        segmentPersistQueue: Promise.resolve(),
        liveAsrJobs: new Map(),
        asrCircuitState: createLiveAsrCircuitState(),
        asrBacklogLevel: "normal",
        asrDeferredMode: false,
        hasDeferredAsrJobs: false,
        activeSegmentJobs: 0,
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
      this.setSessionWorkProgress(this.host.session, {
        stage: "recording",
        label: t("Recording"),
        percent: null,
        detail: "正在采集音频，分段后会自动转写",
      });

      const activeProviderId = this.host.settings.activeTranscribeProvider || "siliconflow";
      const activeProvider = (this.host.settings.transcribeProviders || {})[activeProviderId] || {};
      const activeProfile = this.host.profiles.getActiveTranscribeProfile();
      const isStreaming = activeProfile && activeProfile.transcribeMode === "streaming";
      const titleLine = continuationInfo
        ? `## ${t("Append to {0}").replace("{0}", getModePrefix(meta))}（${startedAt.format("YYYY-MM-DD HH:mm")}）`
        : `# ${startedAt.format("YYYY-MM-DD HH:mm")} · ${getModePrefix(meta)}${t("(recording…)")}`;
      const header = [
        continuationInfo ? "" : null,
        titleLine,
        "",
        nsMarker("session", this.host.session.id),
        nsMarker("segments-start", this.host.session.id),
        nsMarker("segments-end", this.host.session.id),
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

      const sessionRef = this.host.session;
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
              this.clearRecordingIssue("network");
              this.clearRecordingIssue("service");
              sessionRef.streamingFullText = fullText || "";
              if (sessionRef.scheduleStreamingNoteUpdate) sessionRef.scheduleStreamingNoteUpdate();
            },
            onError: (e) => {
              console.error("[QnALog] streaming error", e);
              this.setRecordingIssue(classifyRecordingIssue(e), {
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
            this.setRecordingIssue(classifyRecordingIssue(e), {
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
        ? `录音中（${modeLabel}），${activeProfile.title || "流式服务"} 实时转写中`
        : requiresWholeSession
          ? `录音中（${modeLabel}），停止后统一转写并确认说话人`
        : (this.host.settings.enableInterimOutput
          ? `录音中（${modeLabel}），启动期快速出片，之后每 ${this.host.settings.segmentIntervalMinutes} 分钟即时转写`
          : `录音中（${modeLabel}），停止时统一处理`);
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
      await this.host.diagnostics.logDiagnostic("error", "recording.start_failed", "无法开始录音", {
        captureMode: this.host.settings.captureMode,
        requestedMode: this._oneShotCaptureMode || "",
        error: diagnosticError(e),
      });
      new obsidian.Notice(`${t("Cannot start recording: ")}${(e && e.message) || e}`);
      // 清理半初始化状态：acquireStream 抛错(OverconstrainedError 等)后 this.host.session 已赋值、"（录音中…）"
      // 占位笔记已写，若不清理会残留僵尸会话、笔记永远卡在"录音中…"。
      try { if (this.host.recorder && this.host.recorder.state !== "idle") await this.host.recorder.stop(); } catch { /* intentionally empty */ }
      try { if (this.host.recorder && typeof this.host.recorder.releaseStream === "function") this.host.recorder.releaseStream(); } catch { /* intentionally empty */ }
      const failedSession = this.host.session;
      this.host.session = null;
      this._oneShotCaptureMode = null;
      try { if (failedSession) await this.host.noteWriter.removeEmptySessionBlock(failedSession); } catch { /* intentionally empty */ }
      try { this.host.requestOutlineRefresh(); } catch { /* intentionally empty */ }
    }
  }

  async stopRecording() {
    if (this.host.recorder.state === "idle") return;
    new obsidian.Notice(t("⏹ Stop requested, processing the final segment..."));
    await this.host.recorder.stop();
    this.clearRecordingIssue();
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

  async closeStreamingForDiscard(session) {
    if (!session) return;
    if (session.pcmEncoder) {
      try { session.pcmEncoder.stop(); } catch { /* intentionally empty */ }
      session.pcmEncoder = null;
    }
    if (session.streamingClient) {
      try {
        if (typeof session.streamingClient._safeClose === "function") session.streamingClient._safeClose();
        else if (typeof session.streamingClient.finish === "function") await session.streamingClient.finish();
      } catch (e) {
        console.warn("[QnALog] close streaming client for discard failed", e);
      }
      session.streamingClient = null;
    }
    try { await this.host.meetingWorkbench.removeLiveTranscriptBlock(session.mdPath, session.id); } catch { /* intentionally empty */ }
  }

  /**
   * 删掉本次短录音在结尾创建的纪要（只保留它自己的段落块）。
   *
   * 两种短录音级别共用：时长 < 3 秒丢弃音频，3–10 秒保留音频。纪要文件只有这一段内容时
   * 移到废纸篓，否则只摘掉这一段（续录目标笔记本来就存在，不会走到这里）。
   */
  async discardShortRecordingNote(session) {
    await this.closeStreamingForDiscard(session);
    const file = this.host.app.vault.getAbstractFileByPath(session.mdPath);
    if (!(file instanceof obsidian.TFile)) return;
    const cur = await this.host.app.vault.read(file);
    const sessMarker = nsMarker("session", session.id);
    const endMarker = nsMarker("segments-end", session.id);
    const sessIdx = cur.indexOf(sessMarker);
    const endIdx = cur.indexOf(endMarker);
    if (sessIdx < 0 || endIdx < sessIdx) return;
    const headerLineIdx = cur.lastIndexOf("\n## ", sessIdx);
    const h1LineIdx = cur.lastIndexOf("\n# ", sessIdx);
    const startIdx = Math.max(headerLineIdx, h1LineIdx);
    const blockStart = startIdx >= 0 ? startIdx + 1 : 0;
    const blockEnd = endIdx + endMarker.length;
    const before = cur.slice(0, blockStart).replace(/\n+$/, "\n");
    const after = cur.slice(blockEnd).replace(/^\n+/, "");
    const next = before + (after ? "\n" + after : "");
    if (!next.trim()) await this.host.app.fileManager.trashFile(file);
    else if (next !== cur) await this.host.app.vault.modify(file, next);
  }

  setSessionWorkProgress(session, patch) {
    if (!session) return;
    session.workProgress = Object.assign({}, session.workProgress || {}, patch || {}, {
      updatedAt: new Date().toISOString(),
    });
    if (this.host.tasks._importBusy
      && this.host.tasks._importBusy.workflow === "audio-import"
      && String(this.host.tasks._importBusy.sessionId || "") === String(session.id || "")) {
      const stage = audioImportStageFromWorkProgress(session.workProgress.stage);
      this.host.tasks.updateImportActivity({
        phase: stage,
        organizeLabel: stage === "organize" ? String(session.workProgress.label || "AI 整理") : this.host.tasks._importBusy.organizeLabel,
        organizeDetail: stage === "organize" ? String(session.workProgress.detail || "") : this.host.tasks._importBusy.organizeDetail,
        organizePercent: stage === "organize" ? Number(session.workProgress.percent) || 0 : this.host.tasks._importBusy.organizePercent,
        writeLabel: stage === "write" ? String(session.workProgress.label || "写入纪要") : this.host.tasks._importBusy.writeLabel,
        writeDetail: stage === "write" ? String(session.workProgress.detail || "") : this.host.tasks._importBusy.writeDetail,
        writePercent: stage === "write" ? Number(session.workProgress.percent) || 0 : this.host.tasks._importBusy.writePercent,
      });
    }
    try { this.host.requestOutlineRefresh(); } catch { /* intentionally empty */ }
  }

  clearSessionWorkProgress(session) {
    if (!session) return;
    delete session.workProgress;
    try { this.host.requestOutlineRefresh(); } catch { /* intentionally empty */ }
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
        masterAudioSavePromise: tier === "discard" ? Promise.resolve() : this.startMasterAudioSave(session, seg),
      };
      session.activeSegmentJobs = (Number(session.activeSegmentJobs) || 0) + 1;
    } else if (seg && seg.masterOnly) {
      const masterAudioSavePromise = this.startMasterAudioSave(session, seg);
      preparedSeg = {
        isFinal: !!seg.isFinal,
        masterOnly: true,
        endOffsetMs: Math.max(0, Number(seg.endOffsetMs) || 0),
        masterAudioSavePromise,
      };
      session.activeSegmentJobs = (Number(session.activeSegmentJobs) || 0) + 1;
    } else {
      const descriptor = this.prepareLiveSegmentDescriptor(session, seg);
      const masterAudioSavePromise = this.startMasterAudioSave(session, seg);
      preparedSeg = {
        ...descriptor,
        masterAudioSavePromise,
        spoolPromise: this.queueLiveSegmentPersistence(session, descriptor, seg.blob),
      };
    }

    session.writeQueue = Promise.resolve(session.writeQueue).catch((e) => {
      console.error("[QnALog] recovered rejected write chain before next segment", e);
    }).then(async () => {
      try {
        await this.host.sessionPipeline.processSegment(session, preparedSeg);
      } catch (e) {
        // 本段异常不能毒化后续写入链；processSegment 已尽力保留缓存并加入后台重试。
        console.error("[QnALog] processSegment failed (swallowed to protect write chain)", e);
        try {
          const task = preparedSeg.queueTaskId && this.host.queue.tasks.find((item) => item && item.id === preparedSeg.queueTaskId);
          if (preparedSeg.segmentAudioPath && (!task || task.status === LIVE_ASR_TASK_STATUS || task.status === "running")) {
            await this.keepLiveSegmentQueueTaskForRetry(session, preparedSeg, e);
            session.hasDeferredAsrJobs = true;
          }
        } catch (queueError) {
          console.error("[QnALog] preserve live segment task after processing failure failed", queueError);
        }
        try { await this.host.diagnostics.logDiagnostic("error", "segment.process_failed", "分段处理异常（已吞，避免毒化写入链）", { mode: session.mode, isFinal: !!preparedSeg.isFinal, error: diagnosticError(e) }); } catch { /* intentionally empty */ }
      } finally {
        if (preparedSeg.jobId) this.getLiveAsrJobs(session).delete(preparedSeg.jobId);
        session.activeSegmentJobs = Math.max(0, (Number(session.activeSegmentJobs) || 1) - 1);
        this.updateLiveAsrBacklogPolicy(session, "completed");
        if (!preparedSeg.isFinal && session.pendingMeetingWorkbenchInteractions && session.pendingMeetingWorkbenchInteractions.length) {
          this.host.meetingWorkbench.scheduleMeetingWorkbenchInteraction(session, session.pendingMeetingWorkbenchInteractions[0]);
        }
      }
    });
    if (preparedSeg.isFinal) {
      // 双分支：无论前序链 fulfilled 还是 rejected，finalizeSession 都必须跑。
      session.writeQueue = session.writeQueue.then(
        () => this.host.sessionPipeline.finalizeSession(session),
        (e) => { console.error("[QnALog] write chain rejected before finalize", e); return this.host.sessionPipeline.finalizeSession(session); }
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

  async saveMasterAudio(session, seg) {
    if (!session || session.masterAudioPath || !seg || !seg.masterBlob) return;
    try {
      const ext = seg.masterExt || extFromMime(seg.masterMime || seg.masterBlob.type || "") || seg.ext || "webm";
      await ensureVaultFolder(this.host.app, this.host.settings.audioFolder);
      const target = findAvailableVaultPath(this.host.app, obsidian.normalizePath(`${this.host.settings.audioFolder}/${NS_AUDIO_PREFIX}-${session.sessionStamp}.${ext}`));
      if (!target) throw new Error("无法生成完整录音文件路径");
      const ab = await seg.masterBlob.arrayBuffer();
      await this.host.app.vault.createBinary(target, ab);
      session.masterAudioPath = target;
      session.masterAudioName = target.split("/").pop() || target;
      const oldNames = new Set();
      for (const item of session.segments || []) {
        if (item.audioName) oldNames.add(item.audioName);
        if (item.segmentAudioName) oldNames.add(item.segmentAudioName);
        item.audioName = session.masterAudioName;
        item.audioPath = session.masterAudioPath;
      }
      if (session.realtimeOutline && oldNames.size) {
        let outline = String(session.realtimeOutline);
        for (const oldName of oldNames) {
          if (oldName && oldName !== session.masterAudioName) {
            outline = outline.replace(new RegExp("\\[\\[" + escapeRegExp(oldName) + "\\|", "g"), "[[" + session.masterAudioName + "|");
          }
        }
        session.realtimeOutline = outline;
      }
      if (session.realtimeOutlineState && oldNames.size) {
        const state = normalizeRealtimeOutlineState(session.realtimeOutlineState, session.realtimeOutline, session.realtimeOutlineMemory);
        for (const node of state.nodes || []) {
          let anchor = String(node.anchor || "");
          for (const oldName of oldNames) {
            if (oldName && oldName !== session.masterAudioName) {
              anchor = anchor.replace(new RegExp("\\[\\[" + escapeRegExp(oldName) + "\\|", "g"), "[[" + session.masterAudioName + "|");
            }
          }
          node.anchor = anchor;
          node.time = getRealtimeOutlineAnchorTime(anchor);
        }
        session.realtimeOutlineState = state;
      }
      if (session.realtimeOutlineMemory && oldNames.size) {
        let memory = String(session.realtimeOutlineMemory);
        for (const oldName of oldNames) {
          if (oldName && oldName !== session.masterAudioName) {
            memory = memory.replace(new RegExp("\\[\\[" + escapeRegExp(oldName) + "\\|", "g"), "[[" + session.masterAudioName + "|");
          }
        }
        session.realtimeOutlineMemory = memory;
      }
    } catch (e) {
      console.error("[QnALog] master audio write failed", e);
      new obsidian.Notice(`${t("Failed to write the full recording: ")}${(e && e.message) || e}`, 8000);
    }
  }

  getSegmentCacheFolder() {
    return obsidian.normalizePath(this.host.settings.segmentCacheFolder || DEFAULT_SETTINGS.segmentCacheFolder);
  }

  async ensureSegmentCacheFolder() {
    const folderPath = this.getSegmentCacheFolder();
    const adapter = this.host.app.vault.adapter;
    const parts = folderPath.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
    return folderPath;
  }

  isSegmentCachePath(path) {
    const norm = obsidian.normalizePath(path || "");
    const folder = this.getSegmentCacheFolder();
    return !!norm && (norm === folder || norm.startsWith(folder + "/"));
  }

  isQueuedTranscribeAudioReferenced(path, excludeTaskId = undefined) {
    const norm = obsidian.normalizePath(String(path || ""));
    if (!norm || !this.host.queue || typeof this.host.queue.snapshot !== "function") return false;
    return this.host.queue.snapshot().some(t => t && t.type === "transcribe"
      && t.id !== excludeTaskId
      && obsidian.normalizePath(String(t.audioPath || "")) === norm);
  }

  async maybeDeleteSegmentCacheFile(path, excludeTaskId = undefined, force = false) {
    if (!force && this.host.settings.keepSegmentAudioFiles === true) return;
    if (!this.isSegmentCachePath(path)) return;
    if (this.isQueuedTranscribeAudioReferenced(path, excludeTaskId)) return;
    const file = this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(path));
    if (file instanceof obsidian.TFile) {
      try { await this.host.app.fileManager.trashFile(file); }
      catch (e) { console.error("[QnALog] segment cache cleanup failed", path, e); }
      return;
    }
    // 点目录缓存可能不进入 TFile 索引；它属于可再生临时文件，直接通过 adapter 删除。
    try {
      const adapter = this.host.app.vault.adapter;
      const norm = obsidian.normalizePath(path);
      if (adapter && await adapter.exists(norm)) await adapter.remove(norm);
    } catch (e) {
      console.error("[QnALog] segment cache adapter cleanup failed", path, e);
    }
  }

  async cleanupSuccessfulSegmentAudio(session) {
    if (!session || this.host.settings.keepSegmentAudioFiles === true) return;
    if (this.host.settings.consolidatedLayout === false) return;
    if (!getSessionMasterAudioName(session)) return;
    for (const s of session.segments || []) {
      if (!s || s.error) continue;
      await this.maybeDeleteSegmentCacheFile(s.segmentAudioPath || s.audioPath);
    }
  }

  async cleanupExpiredSegmentCacheFiles(maxAgeMs = SEGMENT_CACHE_RETENTION_MS) {
    if (this.host.settings.keepSegmentAudioFiles === true) return { deleted: 0, skipped: 0, failed: 0 };
    const folderPath = this.getSegmentCacheFolder();
    const folder = this.host.app.vault.getAbstractFileByPath(folderPath);
    const cutoff = Date.now() - Math.max(60 * 60 * 1000, Number(maxAgeMs) || SEGMENT_CACHE_RETENTION_MS);
    const files = [];
    if (folder instanceof obsidian.TFolder) {
      const walk = (node) => {
        if (node instanceof obsidian.TFile) {
          files.push({ path: node.path, mtime: Number(node.stat && node.stat.mtime) || 0 });
          return;
        }
        if (node instanceof obsidian.TFolder) {
          for (const child of node.children || []) walk(child);
        }
      };
      walk(folder);
    } else {
      // 默认缓存位于 .cache；点目录不会始终进入 Vault 文件索引，改用 adapter 递归盘点。
      const adapter = this.host.app.vault.adapter;
      if (!adapter || !(await adapter.exists(folderPath))) return { deleted: 0, skipped: 0, failed: 0 };
      const walkAdapter = async (dir) => {
        const listing = await adapter.list(dir);
        for (const filePath of listing.files || []) {
          const stat = await adapter.stat(filePath);
          files.push({ path: filePath, mtime: Number(stat && stat.mtime) || 0 });
        }
        for (const childDir of listing.folders || []) await walkAdapter(childDir);
      };
      await walkAdapter(folderPath);
    }
    let deleted = 0, skipped = 0, failed = 0;
    for (const file of files) {
      const path = obsidian.normalizePath(file.path || "");
      const ext = String(path.split(".").pop() || "").toLowerCase();
      if (!this.isSegmentCachePath(path) || (ext && !AUDIO_EXT.has(ext))) { skipped++; continue; }
      const mtime = Number(file.mtime) || 0;
      if (mtime > cutoff) { skipped++; continue; }
      if (this.isQueuedTranscribeAudioReferenced(path)) { skipped++; continue; }
      try {
        await this.maybeDeleteSegmentCacheFile(path);
        deleted++;
      } catch (e) {
        failed++;
        console.error("[QnALog] expired segment cache cleanup failed", path, e);
      }
    }
    if (deleted || failed) {
      await this.host.diagnostics.logDiagnostic("info", "segment_cache.cleanup", "已清理过期转写分段", { folderPath, deleted, skipped, failed });
    }
    return { deleted, skipped, failed };
  }
  getLiveAsrJobs(session) {
    if (!session) return new Map();
    if (!(session.liveAsrJobs instanceof Map)) session.liveAsrJobs = new Map();
    return session.liveAsrJobs;
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

  getLiveAsrBacklogSummary(session) {
    return summarizeLiveAsrJobs(this.getLiveAsrJobs(session).values());
  }

  updateLiveAsrBacklogPolicy(session, reason = "update") {
    if (!session) return null;
    const summary = this.getLiveAsrBacklogSummary(session);
    const nextLevel = classifyLiveAsrBacklog(summary);
    const previousLevel = session.asrBacklogLevel || "normal";
    session.asrBacklogLevel = nextLevel;
    if (nextLevel === "critical") {
      session.asrDeferredMode = true;
      session.hasDeferredAsrJobs = true;
    }
    if (nextLevel !== previousLevel) {
      const recorderBuffer = this.getRecorderBufferSummary();
      void this.host.diagnostics.logDiagnostic(nextLevel === "normal" ? "info" : "warn", "asr.live_backlog_changed", "实时转写积压状态变化", {
        reason,
        previousLevel,
        nextLevel,
        ...summary,
        ...recorderBuffer,
      });
      if (nextLevel === "warning" && !session._asrBacklogWarningNotified) {
        session._asrBacklogWarningNotified = true;
        new obsidian.Notice(t("Transcription is temporarily slower than recording; audio segments have been safely written to cache and Q&A Log will keep processing."), 8000);
      }
      if (nextLevel === "critical" && !session._asrBacklogCriticalNotified) {
        session._asrBacklogCriticalNotified = true;
        new obsidian.Notice(t("There is a large transcription backlog; later segments have been moved to a background queue. Recording will not be interrupted."), 10000);
      }
    }
    return summary;
  }

  prepareLiveSegmentDescriptor(session, seg) {
    const continuationOffsetMs = Math.max(0, Number(session && session.continuationOffsetMs) || 0);
    const baseSegmentCount = Array.isArray(session && session.continuationBaseSegments) ? session.continuationBaseSegments.length : 0;
    const rawLocalIndex = Number(seg && seg.index);
    const localIndex = Number.isFinite(rawLocalIndex)
      ? Math.max(0, Math.floor(rawLocalIndex))
      : Math.max(0, Number(session && session._nextLiveSegmentIndex) || 0);
    session._nextLiveSegmentIndex = Math.max(Number(session._nextLiveSegmentIndex) || 0, localIndex + 1);
    const segmentIndex = baseSegmentCount + localIndex;
    const segNumber = segmentIndex + 1;
    const startOffsetMs = Math.max(0, Number(seg && seg.startOffsetMs) || 0);
    const endOffsetMs = Math.max(startOffsetMs, Number(seg && seg.endOffsetMs) || 0);
    const displayStartOffsetMs = startOffsetMs + continuationOffsetMs;
    const displayEndOffsetMs = endOffsetMs + continuationOffsetMs;
    const blobType = String(seg && seg.blob && seg.blob.type || "");
    const ext = String(seg && seg.ext || extFromMime(blobType) || "webm");
    const segmentAudioName = `${NS_AUDIO_PREFIX}-${session.sessionStamp}-seg${pad(segNumber)}.${ext}`;
    const segmentAudioPath = obsidian.normalizePath(`${this.getSegmentCacheFolder()}/${segmentAudioName}`);
    return {
      jobId: `${session.id}:${segmentIndex}`,
      queueTaskId: genId(),
      segmentIndex,
      segNumber,
      startOffsetMs,
      endOffsetMs,
      displayStartOffsetMs,
      displayEndOffsetMs,
      durationMs: Math.max(0, displayEndOffsetMs - displayStartOffsetMs),
      segmentAudioName,
      segmentAudioPath,
      ext,
      blobType,
      blobSize: Math.max(0, Number(seg && seg.blob && seg.blob.size) || 0),
      isFinal: !!(seg && seg.isFinal),
      source: (seg && seg.source) || session.captureMode || "mic",
      sourceUrl: String((seg && seg.sourceUrl) || (session && session.sourceMeta && session.sourceMeta.url) || ""),
      sourceTitle: String((seg && seg.sourceTitle) || (session && session.sourceMeta && session.sourceMeta.title) || ""),
      sourcePlatform: String((seg && seg.sourcePlatform) || (session && session.sourceMeta && session.sourceMeta.platform) || ""),
    };
  }

  buildLiveSegmentQueueTask(session, descriptor, patch = {}) {
    return Object.assign({
      id: descriptor.queueTaskId || genId(),
      type: "transcribe",
      status: LIVE_ASR_TASK_STATUS,
      retries: 0,
      sessionId: session.id,
      mdPath: session.mdPath,
      audioPath: descriptor.segmentAudioPath,
      audioName: descriptor.segmentAudioName,
      segmentIndex: descriptor.segmentIndex,
      sourceAudioPath: session.masterAudioPath || "",
      sourceAudioName: session.masterAudioName || "",
      masterAudioPath: session.masterAudioPath || "",
      masterAudioName: session.masterAudioName || "",
      startOffsetMs: descriptor.displayStartOffsetMs,
      endOffsetMs: descriptor.displayEndOffsetMs,
      audioStartOffsetMs: descriptor.startOffsetMs,
      audioEndOffsetMs: descriptor.endOffsetMs,
      mode: session.mode,
      isFinal: !!descriptor.isFinal,
      liveSegment: true,
      source: descriptor.source || "",
      sourceUrl: descriptor.sourceUrl || "",
      sourceTitle: descriptor.sourceTitle || "",
      sourcePlatform: descriptor.sourcePlatform || "",
      captureMode: session.captureMode || "",
      audioChannelMode: normalizeAudioChannelMode(session.audioChannelMode || this.host.settings.audioChannelMode),
      audioChannelCount: session.captureMode === "mic" ? Math.max(1, Number(session.audioChannelCount) || 1) : 1,
      audioChannelRuntimeMode: session.audioChannelRuntimeMode || initialAudioChannelRuntimeMode(
        session.audioChannelMode || this.host.settings.audioChannelMode,
        session.audioChannelCount,
      ),
      lastError: "",
    }, patch || {});
  }

  async registerLiveSegmentQueueTask(session, descriptor) {
    const task = await this.host.queue.add(this.buildLiveSegmentQueueTask(session, descriptor));
    descriptor.queueTaskId = task.id;
    return task;
  }

  async keepLiveSegmentQueueTaskForRetry(session, descriptor, error) {
    const message = getErrorMessage(error);
    const task = await this.host.queue.add(this.buildLiveSegmentQueueTask(session, descriptor, {
      status: "pending",
      sourceAudioPath: session.masterAudioPath || "",
      sourceAudioName: session.masterAudioName || "",
      masterAudioPath: session.masterAudioPath || "",
      masterAudioName: session.masterAudioName || "",
      deferredReason: error && error.deferReason || "",
      lastError: message,
    }));
    descriptor.queueTaskId = task.id;
    return task;
  }

  async markLiveSegmentQueueTaskRunning(descriptor) {
    const taskId = descriptor && descriptor.queueTaskId;
    if (!taskId) return;
    const task = this.host.queue.tasks.find((item) => item && item.id === taskId);
    if (!task || task.status !== LIVE_ASR_TASK_STATUS) return;
    await this.host.queue.update(taskId, { status: "running", lastError: "" });
  }

  async removeLiveSegmentQueueTask(descriptor) {
    const taskId = descriptor && descriptor.queueTaskId;
    if (!taskId || !this.host.queue.tasks.some((task) => task && task.id === taskId)) return;
    await this.host.queue.remove(taskId);
  }

  queueLiveSegmentPersistence(session, descriptor, blob) {
    const jobs = this.getLiveAsrJobs(session);
    jobs.set(descriptor.jobId, {
      id: descriptor.jobId,
      queuedAtMs: Date.now(),
      sizeBytes: descriptor.blobSize,
      durationMs: descriptor.durationMs,
      state: "spooling",
    });
    session.activeSegmentJobs = (Number(session.activeSegmentJobs) || 0) + 1;
    const summary = this.updateLiveAsrBacklogPolicy(session, "enqueue");
    void this.host.diagnostics.logDiagnostic("info", "asr.live_segment_enqueued", "录音分段已进入磁盘转写队列", {
      segmentIndex: descriptor.segmentIndex,
      durationMs: descriptor.durationMs,
      sizeBytes: descriptor.blobSize,
      pendingCount: summary && summary.count,
      pendingDurationMs: summary && summary.totalDurationMs,
      ...this.getRecorderBufferSummary(),
    });

    const previousPersist = session.segmentPersistQueue || Promise.resolve();
    const persistTask = Promise.resolve(previousPersist).catch(() => undefined).then(async () => {
      try {
        await this.ensureSegmentCacheFolder();
        const ab = await blob.arrayBuffer();
        await this.host.app.vault.adapter.writeBinary(descriptor.segmentAudioPath, ab);
      } catch (e) {
        const job = jobs.get(descriptor.jobId);
        if (job) job.state = "queued";
        this.updateLiveAsrBacklogPolicy(session, "persist-failed");
        await this.host.diagnostics.logDiagnostic("error", "asr.segment_cache_write_failed", "录音分段写入缓存失败，将临时保留该段内存兜底", {
          segmentIndex: descriptor.segmentIndex,
          durationMs: descriptor.durationMs,
          sizeBytes: descriptor.blobSize,
          error: diagnosticError(e),
        });
        if (!session._segmentCacheWriteFailureNotified) {
          session._segmentCacheWriteFailureNotified = true;
          new obsidian.Notice(t("Failed to write the recording segment cache; this segment will be kept in memory temporarily and processing will continue. Please check the vault disk space."), 10000);
        }
        return { persisted: false, fallbackBlob: blob, error: e };
      }
      let queueTask = null;
      try {
        // 音频一旦安全落盘，就立即登记任务。即使 Obsidian 此后崩溃，重启时也能从路径恢复。
        queueTask = await this.registerLiveSegmentQueueTask(session, descriptor);
      } catch (e) {
        await this.host.diagnostics.logDiagnostic("error", "asr.segment_task_persist_failed", "录音分段已落盘，但持久任务登记失败", {
          segmentIndex: descriptor.segmentIndex,
          audioPath: descriptor.segmentAudioPath,
          error: diagnosticError(e),
        });
        if (!session._segmentTaskPersistFailureNotified) {
          session._segmentTaskPersistFailureNotified = true;
          new obsidian.Notice(t("The recording segment was saved, but registering the recovery task failed; transcription will continue for this session, so please do not force-quit Obsidian."), 10000);
        }
      }
      const job = jobs.get(descriptor.jobId);
      if (job) job.state = "queued";
      this.updateLiveAsrBacklogPolicy(session, "persisted");
      return { persisted: true, fallbackBlob: null, error: null, queueTaskId: queueTask && queueTask.id || "" };
    });
    session.segmentPersistQueue = persistTask.then(() => undefined, () => undefined);
    return persistTask;
  }

  startMasterAudioSave(session, seg) {
    if (!session || !seg || !seg.masterBlob) return Promise.resolve();
    const masterInput = {
      masterBlob: seg.masterBlob,
      masterMime: seg.masterMime,
      masterExt: seg.masterExt,
      ext: seg.ext,
    };
    return this.saveMasterAudio(session, masterInput).finally(() => { masterInput.masterBlob = null; });
  }

  getAsrServiceCircuitKey() {
    try {
      const provider = resolveTranscribeProvider(this.host);
      const endpoint = String(provider && provider.endpoint || "").trim();
      let host = endpoint;
      try { host = new URL(endpoint).host || endpoint; } catch { /* keep normalized raw endpoint */ }
      return [provider && provider.id || "", host, provider && provider.model || ""].join("|");
    } catch {
      return "unknown";
    }
  }

  getAsrServiceCircuitState() {
    const key = this.getAsrServiceCircuitKey();
    if (this.asrServiceCircuitKey !== key) {
      this.asrServiceCircuitKey = key;
      this.asrServiceCircuitState = createLiveAsrCircuitState();
    }
    if (!this.asrServiceCircuitState) this.asrServiceCircuitState = createLiveAsrCircuitState();
    return this.asrServiceCircuitState;
  }

  isAsrServiceCircuitOpen() {
    return isLiveAsrCircuitOpen(this.getAsrServiceCircuitState());
  }

  getAsrServiceRetryDelayMs() {
    const state = this.getAsrServiceCircuitState();
    const openDelayMs = Math.max(0, Number(state.openUntilMs) || 0) - Date.now() + 1000;
    if (openDelayMs > 1000) return openDelayMs;
    const failures = Math.max(0, Number(state.consecutiveFailures) || 0);
    if (failures > 0) return Math.min(2 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, failures - 1)));
    return 1500;
  }

  recordAsrServiceAttemptFailure(error) {
    if (!isAsrTransportError(error)) return this.getAsrServiceCircuitState();
    this.asrServiceCircuitState = recordLiveAsrFailure(
      this.getAsrServiceCircuitState(),
      getErrorMessage(error),
      true,
    );
    return this.asrServiceCircuitState;
  }

  recordAsrServiceAttemptSuccess() {
    const previousFailures = Math.max(0, Number(this.getAsrServiceCircuitState().consecutiveFailures) || 0);
    this.asrServiceCircuitState = recordLiveAsrSuccess();
    if (previousFailures > 0) {
      void this.host.diagnostics.logDiagnostic("info", "asr.service_circuit_recovered", "转写服务连接已恢复", { previousFailures });
    }
  }

  resetAsrServiceCircuitForManualRetry(source = "manual") {
    const previousFailures = Math.max(0, Number(this.getAsrServiceCircuitState().consecutiveFailures) || 0);
    this.asrServiceCircuitState = recordLiveAsrSuccess();
    if (previousFailures > 0) {
      void this.host.diagnostics.logDiagnostic("info", "asr.service_circuit_manual_probe", "用户发起转写重试，已允许一次立即探测", {
        source,
        previousFailures,
      });
    }
  }

  recordLiveAsrAttemptSuccess(session) {
    if (!session) return;
    const previousFailures = Math.max(0, Number(session.asrCircuitState && session.asrCircuitState.consecutiveFailures) || 0);
    session.asrCircuitState = recordLiveAsrSuccess();
    this.recordAsrServiceAttemptSuccess();
    if (previousFailures > 0) {
      void this.host.diagnostics.logDiagnostic("info", "asr.live_circuit_recovered", "实时转写服务已恢复", { previousFailures });
    }
  }

  recordLiveAsrAttemptFailure(session, error, descriptor) {
    if (!session || !isTransientAsrError(error)) return;
    const beforeOpen = isLiveAsrCircuitOpen(session.asrCircuitState || createLiveAsrCircuitState());
    session.asrCircuitState = recordLiveAsrFailure(
      session.asrCircuitState || createLiveAsrCircuitState(),
      getErrorMessage(error),
      true,
    );
    if (isAsrTransportError(error)) this.recordAsrServiceAttemptFailure(error);
    const afterOpen = isLiveAsrCircuitOpen(session.asrCircuitState);
    if (!beforeOpen && afterOpen) {
      session.hasDeferredAsrJobs = true;
      void this.host.diagnostics.logDiagnostic("warn", "asr.live_circuit_opened", "连续转写故障，实时请求已暂时熔断", {
        segmentIndex: descriptor && descriptor.segmentIndex,
        consecutiveFailures: session.asrCircuitState.consecutiveFailures,
        openUntilMs: session.asrCircuitState.openUntilMs,
        error: diagnosticError(error),
      });
      if (!session._asrCircuitOpenNotified) {
        session._asrCircuitOpenNotified = true;
        new obsidian.Notice(t("The transcription service failed repeatedly; later segments will be safely queued first and retried automatically later. Recording is not affected."), 10000);
      }
    }
  }

  /** 录音问题状态：set/clear/get 三个入口，读的是当前问题的快照。 */
  setRecordingIssue(kind, patch) {
    const current = this.recordingIssue || {};
    this.recordingIssue = makeRecordingIssue(kind || current.kind || "service", Object.assign({}, current, patch || {}, {
      kind: kind || current.kind || "service",
      at: patch && patch.at ? patch.at : (current.at || Date.now()),
    }));
    try { this.host.requestOutlineRefresh(); } catch { /* intentionally empty */ }
    try { if (this.host.bubble && this.host.bubble.scheduleUpdate) this.host.bubble.scheduleUpdate(); } catch { /* intentionally empty */ }
  }
  clearRecordingIssue(kind = undefined) {
    if (!this.recordingIssue) return;
    if (kind && this.recordingIssue.kind !== kind) return;
    this.recordingIssue = null;
    try { this.host.requestOutlineRefresh(); } catch { /* intentionally empty */ }
    try { if (this.host.bubble && this.host.bubble.scheduleUpdate) this.host.bubble.scheduleUpdate(); } catch { /* intentionally empty */ }
  }
  getRecordingIssue() {
    // this.recorder 是 P1 搬迁时从插件类带过来的残留写法，RecordingService 上没有该字段，
    // 恒为 undefined，因此录音器上报的麦克风问题读不到。录音器挂载在 host 上。
    const recorderIssue = this.host.recorder && this.host.recorder.getInfo ? (this.host.recorder.getInfo().issue || null) : null;
    if (recorderIssue && recorderIssue.kind === "microphone") return recorderIssue;
    return this.recordingIssue || recorderIssue || null;
  }

}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
