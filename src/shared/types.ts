import type { LiveAsrCircuitState } from "../asr/live-segment-policy";
export type AudioInputMode = "mic" | "mix-virtual" | "virtualCable";
export type AudioChannelMode = "auto" | "mono" | "multichannel";
export type AudioChannelRuntimeMode = "mono" | "probing" | "multichannel";
export type BubbleSize = "large" | "medium" | "small";
export type PeopleContextMode = "privacy" | "hotwords" | "localFull";

export interface TranscribeProviderSettings {
  name?: string;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  language?: string;
  protocol?: string;
  targetLanguage?: string;
  hint?: string;
}

export interface LlmAsrSnapshot {
  providerId: string;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  language?: string;
}

export interface LlmProfile {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  asr?: LlmAsrSnapshot;
}

export interface PromptTemplate {
  id: string;
  mode: string;
  name: string;
  prompt: string;
  description?: string;
  baseMode?: string;
  isBuiltin?: boolean;
  customMode?: boolean;
  source?: string;
  createdAt: string;
  updatedAt: string;
}

/** 最近一次实时大纲请求的输入统计；由 realtime-outline-service 写入 session。 */
export interface RealtimeOutlineInputStats {
  fullTranscript: boolean;
  systemChars: number;
  userChars: number;
  totalChars: number;
  rollingContextChars: number;
  transcriptChars: number;
  previousOutlineChars: number;
  memoryChars: number;
  maxTranscriptChars: number;
}

/** 会话处理进度；阶段取值见 shared/activity-progress.ts 的 AudioImportStageId。 */
export interface SessionWorkProgress {
  stage?: string;
  label?: string;
  percent?: number;
  detail?: string;
  updatedAt?: string;
}

export interface IndustryProfile {
  industry: string;
  scenarios: string;
  focus: string;
  outputPreference: string;
  generatedAt: string | null;
}


export interface KnowledgeExtractionRecord {
  mtime: number;
  size: number;
  scannedAt: string;
}

export interface KnowledgeExtractionHistory {
  vocabulary: Record<string, KnowledgeExtractionRecord>;
  people: Record<string, KnowledgeExtractionRecord>;
}

export interface PeopleSuggestionCache {
  pending: unknown[];
}

export interface FloatingBallPosition {
  left: number;
  top: number;
}

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  rawBaseUrl: string;
  manifestUrl: string;
  checkedAt: string;
}

export interface PluginSettings {
  audioFolder: string;
  mdFolder: string;
  meetingMaterialsFolder: string;
  htmlReportFolder: string;
  reportBrandName: string;
  noteFileNameFormatNew: string;
  transcribeEndpoint: string;
  transcribeApiKey: string;
  transcribeModel: string;
  transcribeLanguage: string;
  activeTranscribeProvider: string;
  importTranscribeProvider: string;
  importSpeakerDiarization: boolean;
  importSpeakerCount: number;
  transcribeProviders: Record<string, TranscribeProviderSettings>;
  llmEndpoint: string;
  llmApiKey: string;
  llmModel: string;
  llmServicePreset: string;
  llmProfiles: LlmProfile[];
  activeLlmProfile: string;
  polishMode: string;
  polishPromptInterview: string;
  polishPromptMeeting: string;
  polishPromptHuddle: string;
  polishPromptSeminar: string;
  polishPromptMonologue: string;
  polishPromptLearning: string;
  promptTemplates: Record<string, PromptTemplate>;
  activeTemplateByMode: Record<string, string>;
  briefingStructureLevel: "loose" | "balanced" | "strict";
  repolishPreferencePromptAddendum: string;
  repolishPreference: string;
  thinkingMode: "auto" | "reasoning" | "fast";
  briefingTranslationMode: string;
  briefingTargetLanguage: string;
  briefingCustomLanguage: string;
  briefingKeepOriginalTerms: boolean;
  briefingLanguageInstruction: string;
  industryProfile: IndustryProfile;
  customVocabulary: string;
  vocabularyFile: string;
  peopleDirectoryFolder: string;
  peopleBaseFile: string;
  todoCardsFolder: string;
  sedimentAutoExtract: boolean;
  lexVoiceBasesFolder: string;
  peopleContextMode: PeopleContextMode;
  peopleHotwordsConsentAt: string;
  peopleSuggestionIgnores: unknown[];
  peopleSuggestionCache: PeopleSuggestionCache;
  knowledgeExtractionHistory: KnowledgeExtractionHistory;
  inboxFolder: string;
  inboxAutoImport: boolean;
  inboxArchiveSubfolder: string;
  inboxStabilizeDelayMs: number;
  enableInterimOutput: boolean;
  segmentIntervalMinutes: number;
  asrConcurrency: number;
  segmentCacheFolder: string;
  keepSegmentAudioFiles: boolean;
  filterShortRecordings: boolean;
  captureMode: AudioInputMode;
  audioChannelMode: AudioChannelMode;
  selectedVirtualDevice: string;
  selectedMicrophoneDevice: string;
  enableRealtimeOutline: boolean;
  realtimeOutlineDebounceMs: number;
  autoOpenOutlineOnRecord: boolean;
  autoRenameWithTitle: boolean;
  consolidatedLayout: boolean;
  maxRetries: number;
  diagnosticsLogEnabled: boolean;
  diagnosticsLogFolder: string;
  showFloatingBall: boolean;
  bubbleSize: BubbleSize;
  floatingBallPos: FloatingBallPosition;
  autoOpenNoteAfterFinish: boolean;
  autoOpenHtmlReportAfterGenerate: boolean;
  writeDailyMeetingOverview: boolean;
  dailyMeetingOverviewHeading: string;
  dailyMeetingOverviewTemplate: string;
  autoCheckUpdates: boolean;
  lastUpdateCheckAt: string | null;
  availableUpdate: AvailableUpdate | null;
  lastUpdateError: string;
  installedUpdateVersion: string;
}

export type LexVoiceSettings = PluginSettings;

export interface PersistedPluginSettings {
  schemaVersion: number;
  storage: Record<string, unknown>;
  noteNaming: Record<string, unknown>;
  capture: Record<string, unknown>;
  speech: Record<string, unknown>;
  composer: Record<string, unknown>;
  presentation: Record<string, unknown>;
  vocabulary: Record<string, unknown>;
  views: Record<string, unknown>;
  liveOutline: Record<string, unknown>;
  dailyNote: Record<string, unknown>;
  retryPolicy: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  ui: Record<string, unknown>;
  updates: Record<string, unknown>;
  promptTemplates: Record<string, PromptTemplate>;
  activeTemplateByMode: Record<string, string>;
}

/** 录音器切片回调的入参：切出一段音频时触发，收尾时再触发一次带 isFinal 的。 */
export interface RecorderSegmentPayload {
  blob: Blob;
  index: number;
  startOffsetMs: number;
  endOffsetMs: number;
  isFinal: boolean;
  ext: string;
  /** 收尾时为 true：本段没有独立音频，回听要用整场录音。 */
  masterOnly?: boolean;
  masterBlob?: Blob | null;
  masterMime?: string;
  masterExt?: string;
}

/**
 * 录音器切片经 recording-service 预处理后交给收尾流程的段落。
 *
 * 与 {@link RecorderSegmentPayload} 的区别：那份是录音器直接投递的原始回调参数，
 * 这一份补上了切片索引、缓存路径、母带保存 promise 与落盘 promise 等收尾阶段要用的字段。
 */
export interface PreparedLiveSegment {
  /** 段落在会话内的序号（含续录偏移）。 */
  segmentIndex?: number;
  /** 面向用户的段落编号（从 1 开始）。 */
  segNumber?: number;
  startOffsetMs?: number;
  endOffsetMs?: number;
  /** 计入续录偏移后的展示时间。 */
  displayStartOffsetMs?: number;
  displayEndOffsetMs?: number;
  durationMs?: number;
  /** 段落音频在缓存目录下的文件名与路径。 */
  segmentAudioName?: string;
  segmentAudioPath?: string;
  ext?: string;
  blobType?: string;
  blobSize?: number;
  isFinal?: boolean;
  /** 收尾时为 true：本段没有独立音频，回听要用整场录音。 */
  masterOnly?: boolean;
  /** 过滤掉过短录音时标记；此段不参与转写。 */
  filteredShort?: boolean;
  /** 音频来源（mic / 电脑音频）。 */
  source?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  sourcePlatform?: string;
  /** 母带保存的 promise；收尾时要等它结束再继续。 */
  masterAudioSavePromise?: Promise<unknown> | null;
  /** 段落音频落盘到缓存目录的 promise。 */
  spoolPromise?: Promise<{ persisted?: boolean; queueTaskId?: string; fallbackBlob?: Blob | null; error?: unknown }> | null;
  /** 落盘后生成的队列任务 id。 */
  queueTaskId?: string;
  /** 流式转写的作业 id。 */
  jobId?: string;
  /** 段落音频本体；仅在未落盘时保留。 */
  blob?: Blob | null;
  /** 由收尾流程写回：本段落对应的转写文本。 */
  text?: string;
  audioStartOffsetMs?: number;
  audioEndOffsetMs?: number;
  audioName?: string;
  audioPath?: string;
  error?: unknown;
}

/**
 * 交给整理流水线的会话元信息。
 * `_taskMeter` 与 `_briefingCheckpointId` 只在进程内传递，不写入笔记。
 */
export interface SessionMetaForMerge {
  startedAt: string;
  duration: string;
  source?: string;
  sourceMeta?: unknown;
  meetingWorkbench?: unknown;
  /** 任务计量句柄；由 session-finalize 取好后传给流水线。 */
  _taskMeter?: unknown;
  /** 整理检查点 id；merge-pipeline 写入，提示词层读它。 */
  _briefingCheckpointId?: string;
}

export interface Segment {
  index: number;
  startOffsetMs: number;
  endOffsetMs: number;
  text: string;
  audioStartOffsetMs?: number;
  audioEndOffsetMs?: number;
  audioName?: string;
  audioPath?: string;
  segmentAudioName?: string;
  segmentAudioPath?: string;
  source?: string;
  sourceName?: string;
  sourcePath?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  sourcePlatform?: string;
  rawText?: string;
  audioChannelCount?: number;
  speakerIds?: string[];
  error?: string | null;
  isFinal?: boolean;
  /** 本段对应的转写队列任务 id；写入笔记作为 `lexvoice-transcribe-task` 注释。 */
  queueTaskId?: string;
}

export type QueueTaskStatus = "pending" | "running" | "processing" | "live" | "failed" | "missing" | "blocked";

export interface QueueTaskLifecycle {
  id: string;
  status: QueueTaskStatus;
  retries: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  startedAt?: string;
  lastEventAt?: string;
  attempt?: number;
  transportFailures?: number;
  nextRetryAt?: string;
}

export interface TranscribeQueueTaskPayload {
  type: "transcribe";
  sessionId: string;
  mdPath: string;
  audioPath: string;
  segmentIndex: number;
  audioName?: string;
  sourceAudioPath?: string;
  sourceAudioName?: string;
  masterAudioPath?: string;
  masterAudioName?: string;
  temporarySourcePath?: string;
  startOffsetMs?: number;
  endOffsetMs?: number;
  audioStartOffsetMs?: number;
  audioEndOffsetMs?: number;
  mode?: string;
  isFinal?: boolean;
  liveSegment?: boolean;
  deferredReason?: string;
  source?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  sourcePlatform?: string;
  captureMode?: string;
  audioChannelMode?: AudioChannelMode;
  audioChannelCount?: number;
  audioChannelRuntimeMode?: AudioChannelRuntimeMode;
  providerId?: string;
  wholeFileImport?: boolean;
  speakerDiarization?: boolean;
  speakerCount?: number;
}

export interface MergeQueueTaskPayload {
  type: "merge";
  sessionId: string;
  mdPath: string;
  mode: string;
  segments: Segment[];
  source?: string;
  sourceMeta?: unknown;
  externalAudioSource?: unknown;
  textImportSources?: unknown[];
  sessionMeta?: unknown;
  speakerFrontmatter?: Record<string, unknown> | null;
  temporarySourcePath?: string;
}

export interface GeneratePromptQueueTaskPayload {
  type: "generate-prompt";
  mode: string;
  activate?: boolean;
  mdPath?: string;
}

export type QueueTaskPayload = TranscribeQueueTaskPayload | MergeQueueTaskPayload | GeneratePromptQueueTaskPayload;
export type QueueTask = QueueTaskPayload & QueueTaskLifecycle;

export interface RecordingSession {
  id: string;
  sessionStamp: string;
  startedAt: string;
  mdPath: string;
  mode: string;
  segments: Segment[];
  finalized: boolean;
  source?: string;
  sourceMeta?: unknown;
  externalAudioSource?: unknown;
  captureMode?: string;
  audioChannelCount?: number;
  audioChannelMaxCount?: number;
  audioChannelLabel?: string;
  audioChannelMode?: AudioChannelMode;
  audioChannelRuntimeMode?: AudioChannelRuntimeMode;
  speakerChannels?: Record<string, unknown>;
  channelSeparationMode?: "single" | "pending" | "device-channels" | "duplicated-input" | "encoder-downmix";
  _channelDownmixNotified?: boolean;
  masterAudioPath?: string;
  masterAudioName?: string;
  multiSourceAudio?: boolean;
  temporarySourcePaths?: string[];
  textImportSources?: unknown[];
  mergedSources?: unknown[];
  continuationBaseSegments?: Segment[];
  continuationOffsetMs?: number;
  continuationSourcePath?: string;
  continuationSourceTitle?: string;
  continuationRecordedAt?: string;
  meetingWorkbench?: unknown;
  pendingMeetingWorkbenchInteractions?: unknown[];
  /** 会话处理进度的用户可见文案；由 recording-service 的 setSessionWorkProgress 逐字段合并写入。 */
  workProgress?: SessionWorkProgress;
  importActivitySnapshot?: unknown;
  processingStartedAt?: string;
  realtimeOutline?: string;
  realtimeOutlineState?: unknown;
  realtimeOutlineMemory?: string;
  realtimeOutlineCoverage?: unknown;
  /** 导入音频时实际使用的转写服务 id；重新整理时要沿用同一个服务。 */
  importTranscribeProviderId?: string;
  /** 最近一次实时大纲请求的输入统计，由 realtime-outline-service 写入。 */
  realtimeOutlineInput?: RealtimeOutlineInputStats;
  realtimeOutlineWindow?: unknown;
  realtimeOutlineSegmentCount?: number;
  realtimeOutlineAttemptedSegmentCount?: number;
  realtimeOutlineAttemptedAt?: string;
  realtimeOutlineWorkbenchSignature?: string;
  realtimeOutlineUpdatedAt?: string;
  realtimeOutlineFailureCount?: number;
  realtimeOutlineNextAllowedAt?: number;
  realtimeOutlineNoChangeCommittedCount?: number;
  realtimeOutlineNoChangeRetryCount?: number;
  writeQueue?: Promise<void>;
  segmentPersistQueue?: Promise<void>;
  finalizePromise?: Promise<void> | null;
  liveAsrJobs?: Map<string, unknown>;
  /** 实时转写熔断状态；由 recording-service 在每次成功/失败后写入。 */
  asrCircuitState?: LiveAsrCircuitState;
  asrBacklogLevel?: string;
  asrDeferredMode?: boolean;
  hasDeferredAsrJobs?: boolean;
  activeSegmentJobs?: number;
  /** 流式转写客户端；不同 provider 的实现各异，这里只声明收尾阶段会用到的成员。 */
  streamingClient?: { finish(): Promise<unknown>; getFullText(): string; _safeClose?(): void } | null;
  /** 流式转写的累计正文；由 recording-service 写入，会中工作台与收尾阶段读它。 */
  streamingFullText?: string;
  /** 多声道模式下是否已提示过「已按说话人分离」；避免每次收尾重复提示。 */
  _channelSpeakersNotified?: boolean;
  /** 双声道串音去重累计去掉的片段数；写入纪要用。 */
  channelCrosstalkDeduplicated?: number;
  /** 是否已提示过「检测到重复声道」。 */
  _channelDuplicatedNotified?: boolean;
  /** 本次会话对应的整理检查点 id；由 merge-pipeline 写入，提示词层读它。 */
  _briefingCheckpointId?: string;
  /** 任务计量句柄；仅进程内使用，不落盘。 */
  _taskMeter?: unknown;
  /** 流式翻译/原文缓存；录音过程中逐次覆盖。 */
  streamingTranslatedText?: string;
  streamingSourceText?: string;
  /** 写回「实时转写中」代码块的节流函数；由 meeting-workbench-service 生成并挂到会话上。 */
  scheduleStreamingNoteUpdate?: () => void;
  /** 实时 PCM 编码器；收尾时停止并释放。 */
  pcmEncoder?: { stop(): void } | null;
  finalizing?: boolean;
  finalizationError?: string;
  filteredShortRecording?: boolean;
  filteredDurationMs?: number;
  _nextLiveSegmentIndex?: number;
  _interviewBriefBackgroundRunning?: boolean;
  _asrBacklogWarningNotified?: boolean;
  _asrBacklogCriticalNotified?: boolean;
  _asrCircuitOpenNotified?: boolean;
  _segmentCacheWriteFailureNotified?: boolean;
  _segmentTaskPersistFailureNotified?: boolean;
  _emptyAsrNotified?: boolean;
  _silenceNotified?: boolean;
  _finalizeTaskMeter?: unknown;
}
