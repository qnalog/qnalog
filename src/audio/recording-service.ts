// 录音采集服务：开始/停止、录音状态与分段写入顺序。

import * as obsidian from "obsidian";
import { audioInputModeLabel, normalizeAudioInputMode } from "./audio-input";
import { getModeMeta, getModePrefix, getEffectivePolishMode } from "../shared/mode-meta";
import { isMobileRuntime } from "../shared/util-platform";
import type { PluginSettings, RecordingSession, PreparedLiveSegment, RecorderSegmentPayload, AudioInputMode, ContinuationContext, TranscribeProviderSettings } from "../shared/types";
import { getErrorMessage, genId } from "../shared/util-common";
import { diagnosticError } from "../shared/util-key-diag";
import { initialAudioChannelRuntimeMode, normalizeAudioChannelMode } from "../audio/channel-speakers";
import { QUICK_INTERIM_CUTS_MS } from "../shared/limits";
import { isSpeakerDiarizationProvider } from "../asr/diarization";
import { nsMarker } from "../shared/namespace";
import type { RecorderChannelInfo, RecorderService } from "../audio/recorder-service";
import type { NoteWriter } from "../notes/note-writer";
import { handleRecordedSegment, type RecordingSegmentHost } from "./recording-segment-flow";
import { t } from "../shared/i18n";
import type { SessionStore } from "../session/session-store";

interface RecordingContinuationPreparation {
  stageFile: obsidian.TFile;
  taskId: string;
  continuation: ContinuationContext;
  mode: string;
  priorOutline: string;
}

interface RecordingProfile {
  title?: string;
  transcribeMode?: string;
  requiresWholeSession?: boolean;
  sampleRate?: number;
  streamProtocol?: string;
}

interface RecordingStreamingCallbacks {
  onPartial(fullText: string, isFinal: boolean): void;
  onError(error: Error): void;
  onClosed(info: { translatedText?: string; sourceText?: string } | null): void;
}

interface RecordingStreamingClient {
  connect(): Promise<unknown>;
  sendAudioFrame(frame: ArrayBuffer): void;
  finish(): Promise<unknown>;
  getFullText(): string;
  _safeClose?(): void;
}

type RecordingPipelineHost = Pick<RecordingSegmentHost,
  | "startMasterAudioSave"
  | "beginSessionSegmentWork"
  | "prepareLiveSegmentDescriptor"
  | "queueLiveSegmentPersistence"
  | "getQueueTask"
  | "keepLiveSegmentQueueTaskForRetry"
  | "markSessionAsrJobsDeferred"
  | "finishSessionSegmentWork"
> & {
  clearRecordingIssue(kind?: string): void;
  initializeSession(session: RecordingSession): void;
  setSessionWorkProgress(session: RecordingSession, patch: unknown): void;
  setRecordingIssue(kind: string, patch?: unknown): void;
  getRecordingIssue(): unknown;
};
function formatRecordingCaughtError(error: unknown): string {
  return `${((error && (error as { message?: unknown }).message) || error) as string}`;
}

/** 开始录音时的选项：不带参数即新建纪要，带 appendToFile 即续录到该篇。 */
export interface StartRecordingOptions {
  appendToFile?: unknown;
}

/** RecordingService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface RecordingHost {
  /** 知识库能力。 */
  ensureFolder(path: string): Promise<void>;
  getFileByPath(path: string): obsidian.TAbstractFile | null;
  diagnostics: { logDiagnostic: RecordingSegmentHost["logDiagnostic"] };
  meetingWorkbench: {
    makeStreamingNoteUpdater(session: RecordingSession): () => void;
    scheduleMeetingWorkbenchInteraction: RecordingSegmentHost["scheduleMeetingWorkbenchInteraction"];
  };
  noteWriter: Pick<NoteWriter, "appendToNote" | "removeEmptySessionBlock">;
  profiles: { getActiveTranscribeProfile(): RecordingProfile };
  continuations: {
    resolveTarget(file: obsidian.TFile): obsidian.TFile | null;
    prepare(file: obsidian.TFile, sessionId: string, sessionStamp: string, recordedAt: string): Promise<RecordingContinuationPreparation>;
    trackSession(session: RecordingSession, file: obsidian.TFile): void;
    releaseSession(sessionId: string): void;
    cancelPrepared(taskId: string, stageFile: obsidian.TFile): Promise<void>;
  };
  recorder: Pick<RecorderService, "state" | "start" | "stop" | "releaseStream" | "getInfo" | "masterChunks" | "chunks"> | null;
  saveSettings(): Promise<void>;
  sessionStore: Pick<SessionStore, "begin" | "end">;
  asrPipeline: RecordingPipelineHost;
  processRecordedSegment(session: RecordingSession, seg: PreparedLiveSegment): Promise<void>;
  finalizeRecordedSession(session: RecordingSession): Promise<void>;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: Pick<PluginSettings, "polishMode" | "promptTemplates" | "audioFolder" | "mdFolder" | "noteFileNameFormatNew" | "captureMode" | "audioChannelMode" | "activeTranscribeProvider" | "transcribeProviders" | "enableInterimOutput" | "segmentIntervalMinutes" | "autoOpenOutlineOnRecord" | "filterShortRecordings">;
  requestOutlineRefresh(): void;
  requestOpenOutlineView(): Promise<void>;
  resolveRuntimeAudioInputMode(mode: unknown): AudioInputMode;
  normalizeRealtimeOutlineState(value: unknown, fallbackMarkdown?: unknown, fallbackMemory?: unknown): unknown;
  classifyRecordingIssue(error: unknown): "network" | "service";
  createStreamingTranscriptionClient(
    profile: RecordingProfile,
    provider: TranscribeProviderSettings,
    callbacks: RecordingStreamingCallbacks,
  ): RecordingStreamingClient;
  createPcmEncoder(
    stream: MediaStream,
    options: { sampleRate: number; onFrame(frame: ArrayBuffer): void },
  ): { start(): void; stop(): void };
}

export class RecordingService {
  declare host: RecordingHost;
  private readonly segmentHost: RecordingSegmentHost;
  /** 本次一次性录音的采集模式与润色模式（命令入口设置）。 */
  declare _oneShotCaptureMode: AudioInputMode | null;
  declare _oneShotPolishMode: string | null;
  starting = false;
  constructor(host: RecordingHost) {
    this.host = host;
    this.segmentHost = {
      getFilterShortRecordings: () => this.host.settings.filterShortRecordings !== false,
      startMasterAudioSave: (session, seg) => this.host.asrPipeline.startMasterAudioSave(session, seg),
      beginSessionSegmentWork: (session) => this.host.asrPipeline.beginSessionSegmentWork(session),
      prepareLiveSegmentDescriptor: (session, seg) => this.host.asrPipeline.prepareLiveSegmentDescriptor(session, seg),
      queueLiveSegmentPersistence: (session, descriptor, blob) => this.host.asrPipeline.queueLiveSegmentPersistence(session, descriptor, blob),
      getQueueTask: (id) => this.host.asrPipeline.getQueueTask(id),
      keepLiveSegmentQueueTaskForRetry: (session, descriptor, error) => this.host.asrPipeline.keepLiveSegmentQueueTaskForRetry(session, descriptor, error),
      markSessionAsrJobsDeferred: (session) => this.host.asrPipeline.markSessionAsrJobsDeferred(session),
      finishSessionSegmentWork: (session, jobId, reason) => this.host.asrPipeline.finishSessionSegmentWork(session, jobId, reason),
      scheduleMeetingWorkbenchInteraction: (session, interaction) => this.host.meetingWorkbench.scheduleMeetingWorkbenchInteraction(session, interaction),
      logDiagnostic: (level, code, message, data) => this.host.diagnostics.logDiagnostic(level, code, message, data),
      processRecordedSegment: (session, seg) => this.host.processRecordedSegment(session, seg),
      finalizeRecordedSession: (session) => this.host.finalizeRecordedSession(session),
    };
    this._oneShotCaptureMode = null;
    this._oneShotPolishMode = null;
  }

  async toggleRecording(): Promise<void> {
    // The host assembles the recorder before registering these public recording operations.
    if (this.host.recorder!.state === "idle") await this.startRecording();
    else await this.stopRecording();
  }


  async startRecording(options: StartRecordingOptions = {}): Promise<void> {
    if (this.starting) return;
    if (this.host.recorder!.state !== "idle") {
      new obsidian.Notice(t("A recording is already in progress. Please stop it before continuing to record."), 5000);
      return;
    }
    this.starting = true;
    try {
      const requestedTarget = options && options.appendToFile instanceof obsidian.TFile ? options.appendToFile : null;
      let appendTargetFile = requestedTarget;
      let preparation: RecordingContinuationPreparation | null = null;
      const moment = window.moment;
      const startedAt = moment();
      const sessionStamp = startedAt.format("YYYYMMDD-HHmmss");
      const recordedAt = startedAt.toDate().toISOString();
      const sessionId = genId();
      if (requestedTarget) {
        try {
          appendTargetFile = this.host.continuations.resolveTarget(requestedTarget) || requestedTarget;
          preparation = await this.host.continuations.prepare(appendTargetFile, sessionId, sessionStamp, recordedAt);
        } catch (e: unknown) {
          console.error("[QnALog] prepare continuation target failed", e);
          new obsidian.Notice(`${t("Cannot continue recording into this minutes note: ")}${formatRecordingCaughtError(e)}`, 8000);
          return;
        }
      }
      const continuationInfo = preparation;
      const mode = continuationInfo && continuationInfo.mode
        ? continuationInfo.mode
        : getEffectivePolishMode(this.host.settings, this._oneShotPolishMode || this.host.settings.polishMode);
      let createdSession: RecordingSession | null = null;
      try {
        this.host.asrPipeline.clearRecordingIssue();
        await this.host.ensureFolder(this.host.settings.audioFolder);
        if (!continuationInfo) await this.host.ensureFolder(this.host.settings.mdFolder);
        const mdName = startedAt.format(this.host.settings.noteFileNameFormatNew);
        const mdPath = continuationInfo
          ? continuationInfo.stageFile.path
          : obsidian.normalizePath(`${this.host.settings.mdFolder}/${mdName}.md`);

        const meta = getModeMeta(this.host.settings, mode);
        const oneShotMode = this._oneShotCaptureMode;
        const requestedCaptureMode = oneShotMode || this.host.settings.captureMode || "mic";
        const captureMode = this.host.resolveRuntimeAudioInputMode(requestedCaptureMode);
        const forcedMobileMic = isMobileRuntime() && normalizeAudioInputMode(requestedCaptureMode) !== "mic";
        createdSession = {
          id: sessionId,
          sessionStamp,
          startedAt: recordedAt,
          mdPath,
          mode,
          segments: [],
          continuationBaseSegments: [],
          continuationOffsetMs: 0,
          continuationSourcePath: continuationInfo ? (appendTargetFile?.path || "") : "",
          continuationSourceTitle: continuationInfo ? (appendTargetFile?.basename || "") : "",
          continuationRecordedAt: continuationInfo ? recordedAt : "",
          continuationPriorOutline: continuationInfo ? (continuationInfo.priorOutline || "") : "",
          continuationPriorAudioNames: [],
          continuationPriorRecordingInfo: "",
          ...(continuationInfo ? {
            continuation: continuationInfo.continuation,
            continuationTaskId: continuationInfo.taskId,
          } : {}),
          // 旧场次大纲作为实时大纲种子；目标笔记本身只读，实时更新仅写入暂存文件。
          realtimeOutline: continuationInfo ? (continuationInfo.priorOutline || "") : "",
          realtimeOutlineState: continuationInfo && continuationInfo.priorOutline
            ? this.host.normalizeRealtimeOutlineState(undefined, continuationInfo.priorOutline, "")
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
      const titleLine = `# ${startedAt.format("YYYY-MM-DD HH:mm")} · ${getModePrefix(meta)}${t("(recording…)")}`;
      const header = [
        titleLine,
        "",
        nsMarker("session", createdSession.id),
        nsMarker("segments-start", createdSession.id),
        nsMarker("segments-end", createdSession.id),
        "",
      ].join("\n");
      if (!continuationInfo) await this.host.noteWriter.appendToNote(mdPath, header);
      const targetToTrack = continuationInfo
        ? appendTargetFile
        : this.host.getFileByPath(mdPath);
      if (!(targetToTrack instanceof obsidian.TFile)) {
        throw new Error(t("Could not find the note file for this recording"));
      }
      this.host.continuations.trackSession(createdSession, targetToTrack);

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

      let onStreamReady: ((mediaStream: MediaStream, channelInfo?: RecorderChannelInfo) => Promise<void>) | null = null;
      if (isStreaming && isMobileRuntime()) {
        // 移动端无 Node WebSocket（设不了鉴权头），流式必败：不建流式客户端，提前明示。
        // 录音照常进行，停止时走既有的「流式连接未建立」兜底（音频保留）。
        new obsidian.Notice(t("Streaming transcription is not supported on mobile yet; this recording will keep its audio, so use streaming on desktop or switch to a segmented transcription service."), 9000);
      } else if (isStreaming) {
        onStreamReady = async (mediaStream) => {
          const sampleRate = Number(activeProfile.sampleRate) || (activeProfile.streamProtocol && activeProfile.streamProtocol.startsWith("openai-realtime") ? 24000 : 16000);
          const client = this.host.createStreamingTranscriptionClient(activeProfile, activeProvider, {
            onPartial: (fullText: string, isFinal: boolean) => {
              this.host.asrPipeline.clearRecordingIssue("network");
              this.host.asrPipeline.clearRecordingIssue("service");
              sessionRef.streamingFullText = fullText || "";
              if (sessionRef.scheduleStreamingNoteUpdate) sessionRef.scheduleStreamingNoteUpdate();
            },
            onError: (e: Error) => {
              console.error("[QnALog] streaming error", e);
              this.host.asrPipeline.setRecordingIssue(this.host.classifyRecordingIssue(e), {
                source: "streaming-asr",
                message: getErrorMessage(e),
              });
              new obsidian.Notice(`${t("Streaming transcription error: ")}${formatRecordingCaughtError(e)}`);
            },
            onClosed: (info: { translatedText?: string; sourceText?: string } | null) => {
              if (info && info.translatedText) sessionRef.streamingTranslatedText = info.translatedText;
              if (info && info.sourceText) sessionRef.streamingSourceText = info.sourceText;
            },
          });
          sessionRef.streamingClient = client;
          sessionRef.scheduleStreamingNoteUpdate = this.host.meetingWorkbench.makeStreamingNoteUpdater(sessionRef);
          try {
            await client.connect();
          } catch (e: unknown) {
            console.error("[QnALog] streaming connect failed", e);
            this.host.asrPipeline.setRecordingIssue(this.host.classifyRecordingIssue(e), {
              source: "streaming-asr",
              message: getErrorMessage(e),
            });
            new obsidian.Notice(`${t("Streaming transcription connection failed: ")}${formatRecordingCaughtError(e)}`);
            sessionRef.streamingClient = null;
            return;
          }
          const encoder = this.host.createPcmEncoder(mediaStream, {
            sampleRate,
            onFrame: (ab: ArrayBuffer) => client.sendAudioFrame(ab),
          });
          encoder.start();
          sessionRef.pcmEncoder = encoder;
        };
      }

      const providerStreamReady = onStreamReady;
      onStreamReady = async (mediaStream: MediaStream, channelInfo?: RecorderChannelInfo) => {
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

      await this.host.recorder!.start({
        segmentDurationMs,
        quickCutMarksMs: segmentDurationMs > 0 ? QUICK_INTERIM_CUTS_MS : [],
        captureMode,
        onSegment: (seg) => this.handleSegment(sessionRef, seg),
        onStreamReady,
      });
      if (this.host.settings.autoOpenOutlineOnRecord) {
        try { await this.host.requestOpenOutlineView(); } catch (e: unknown) { console.error("[QnALog] auto-open outline failed", e); }
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
        new obsidian.Notice(
          t('Continuation recording saved separately; it will be merged into "{0}" after its current processing finishes.')
            .replace("{0}", appendTargetFile!.basename),
          8000,
        );
      }
      if (forcedMobileMic) {
        new obsidian.Notice(t("Mobile only supports microphone recording for now; use computer audio / virtual audio devices on desktop."), 8000);
      }
      if (isMobileRuntime()) {
        new obsidian.Notice(t("On mobile, keep Obsidian in the foreground while recording; locking the screen or switching to the background may interrupt the recording."), 8000);
      }
    } catch (e: unknown) {
      console.error(e);
      try {
        await this.host.diagnostics.logDiagnostic("error", "recording.start_failed", t("Failed to start recording"), {
          captureMode: this.host.settings.captureMode,
          requestedMode: this._oneShotCaptureMode || "",
          error: diagnosticError(e),
        });
      } catch (diagnosticFailure) {
        console.error("[QnALog] failed to log recording startup failure", diagnosticFailure);
      }
      new obsidian.Notice(`${t("Cannot start recording: ")}${formatRecordingCaughtError(e)}`);
      // 清理半初始化状态：启动异常后只结束本次创建的会话，避免清除随后开始的新会话。
      try { if (this.host.recorder && this.host.recorder.state !== "idle") await this.host.recorder.stop(); } catch { /* intentionally empty */ }
      try { if (this.host.recorder && typeof this.host.recorder.releaseStream === "function") this.host.recorder.releaseStream(); } catch { /* intentionally empty */ }
      if (createdSession) {
        this.host.continuations.releaseSession(createdSession.id);
        this.host.sessionStore.end(createdSession);
        try { await this.host.noteWriter.removeEmptySessionBlock(createdSession); } catch { /* intentionally empty */ }
      }
      if (continuationInfo) {
        try { await this.host.continuations.cancelPrepared(continuationInfo.taskId, continuationInfo.stageFile); } catch (cleanupError) {
          console.error("[QnALog] cancel failed continuation preparation", cleanupError);
        }
      }
      this._oneShotCaptureMode = null;
      try { this.host.requestOutlineRefresh(); } catch { /* intentionally empty */ }
      }
    } finally {
      this.starting = false;
    }
  }

  async stopRecording(): Promise<void> {
    // The host assembles the recorder before registering these public recording operations.
    if (this.host.recorder!.state === "idle") return;
    new obsidian.Notice(t("⏹ Stop requested, processing the final segment..."));
    await this.host.recorder!.stop();
    this.host.asrPipeline.clearRecordingIssue();
  }



  handleSegment(session: RecordingSession, seg: RecorderSegmentPayload): Promise<void> | undefined {
    return handleRecordedSegment(this.segmentHost, session, seg);
  }



  getRecorderBufferSummary(): { masterChunkCount: number; masterChunkBytes: number; currentSegmentChunkCount: number; currentSegmentChunkBytes: number } {
    const sumBytes = (items: Blob[]): number => (Array.isArray(items) ? items : []).reduce((total, item) => total + Math.max(0, Number(item && item.size) || 0), 0);
    const masterChunks = this.host.recorder && Array.isArray(this.host.recorder.masterChunks) ? this.host.recorder.masterChunks : [];
    const segmentChunks = this.host.recorder && Array.isArray(this.host.recorder.chunks) ? this.host.recorder.chunks : [];
    return {
      masterChunkCount: masterChunks.length,
      masterChunkBytes: sumBytes(masterChunks),
      currentSegmentChunkCount: segmentChunks.length,
      currentSegmentChunkBytes: sumBytes(segmentChunks),
    };
  }


  getRecordingIssue(): unknown {
    const recorderIssue = this.host.recorder && this.host.recorder.getInfo ? (this.host.recorder.getInfo().issue || null) : null;
    if (recorderIssue && recorderIssue.kind === "microphone") return recorderIssue;
    return this.host.asrPipeline.getRecordingIssue() || recorderIssue || null;
  }

}

