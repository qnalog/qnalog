/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// @ts-nocheck
import * as obsidian from "obsidian";
// 实时大纲"文本/状态纯函数层"已抽到独立模块并由 vitest 回归测试覆盖（src/outline-text.test.ts）。
// 这里 import 回来，保持原有调用点用裸名引用不变。
import {parseRecruitRealtimeOutlineProtocol, buildRecruitRealtimeOutlineFallback, buildRecruitRealtimeOutlineMemory, advanceRealtimeOutlineCursor, getRealtimeOutlineAnchorTime, parseRealtimeOutlineStateFromMarkdown, selectIncrementalRealtimeOutlineSegments, repairRealtimeOutlineAnchors, mergeStableRealtimeOutlineNodes, normalizeOutlineMarkdownForDisplay, validateRealtimeOutlineMarkdown } from "./outline-text";

import { drainRealtimeOutlineBacklog } from "./outline-finalizer";

import { getSemanticCanvasPath } from "./canvas/semantic-outline-canvas";

import { buildLexVoiceNoteIndex, resolveLexVoiceNoteIndex, upsertLexVoiceNoteIndex } from "./indexing/note-index";

import { LexVoiceSettingTab } from "./ui/settings-tab";

import { MinutesKanbanView, VIEW_TYPE_MINUTES_KANBAN } from "./ui/minutes-kanban-view";

import { getDesktopModule } from "./shared/desktop-runtime";

import {AudioTimeModal, SpeakerNameConfirmModal, QueueModal, RecruitContextModal, ImportTextModal, ImportAudioModal, AudioImportOptionsModal, BubbleWidget } from "./ui/modals";

import { lexvoiceConfirm, trashLexVoiceFile, normalizeAudioInputMode, audioInputModeLabel } from "./ui/helpers";

import { isKnownPolishMode, makeCustomPromptModeId, getCustomPromptModeTemplates, getBuiltInVisiblePolishModeKeys, getModeMeta, getEffectivePolishMode, getVisibleModeEntries, sanitizePromptTemplate } from "./shared/mode-meta";

import { isLexVoiceMobileRuntime } from "./shared/util-platform";

import { UpdateService } from "./update-service";

import { normalizeKnowledgeExtractionHistory } from "./shared/util-knowledge";

import { listJDProjects } from "./recruit/jd-projects";

import { parseElapsedMsToken, buildBriefingLanguageInstruction, getSessionMetaDurationMs, getSegmentsDurationMs } from "./shared/util-text";

import {DEFAULT_RECRUIT_QUALITIES, isRecruitFeatureUnlocked, normalizeRecruitContext, hasRecruitContextContent, parseJdProject, renderRecruitCandidateBase, renderRecruitAggregateBase } from "./recruit";

import { detectPromotionReviewPhase, normalizePromotionReviewContext } from "./promotion";

import {registerRecruitBoardView } from "./recruit/bases-view";

import {resolveTranscribeProvider, makeRecordingIssue, transcribeAudio } from "./asr/transcribe";

import {readFileFrontmatter, ensureTodayDailyNoteFile } from "./shared/util-note";

import {generateSedimentObjects, writeSedimentObjectCards } from "./sediment";

import { parseVocabularyGroups, flattenVocabularyGroups, normalizeVocabularyInput, mergeVocabularyGroups, isStructuredVocabularyMarkdown, loadVocabularyGroups, formatVocabularyMarkdown, applyVocabularyCorrections } from "./vocabulary";

import {getLlmConfigIssue, isLlmNonRetryableError, formatLlmConfigIssue, formatLlmFailureIssue, callLlm, stripModeSuggestionBlocks } from "./llm/core";

import { DEFAULT_LIBRARY_PATHS, DEFAULT_SETTINGS, LEGACY_DEFAULT_LIBRARY_PATHS } from "./shared/defaults";

// 设置序列化层已抽到独立模块（src/shared/settings-io.ts）并由 round-trip 测试覆盖（tests/settings-io.test.ts）。
// 这里 import 回来，保持原有调用点用裸名引用不变。
import { SETTINGS_SCHEMA_VERSION, LEGACY_VOCABULARY_FILE, normalizeLexVoiceSettings, serializeLexVoiceSettings, extractLexVoiceJobItems } from "./shared/settings-io";

import { buildSettingsMigrationReport } from "./shared/settings-migration-report";

import type { LexVoiceSettings, RecordingSession } from "./shared/types";
import { describeBuildSource, normalizePluginBuildInfo, resolveDisplayVersion, type PluginBuildInfo } from "./shared/build-info";

import { getLearnedLlmOutputCeiling } from "./llm/output-budget";

import { PcmStreamEncoder } from "./asr/clients";

import { MODE_META } from "./shared/catalog-modes";

import { AUDIO_EXT, TEXT_IMPORT_EXT } from "./shared/catalog-import";

import { isRecord, primitiveText, getErrorMessage, pickDefined, genId, pad, formatElapsed, sanitizeFilename, escapeRegExp } from "./shared/util-common";

import { mimeFromExt, extFromMime, getTranscribeSegmentPlaceholder, isAsrTransportError, isTransientAsrError } from "./shared/util-audio";

import { LIVE_ASR_TASK_STATUS, classifyLiveAsrBacklog, createLiveAsrCircuitState, isLiveAsrCircuitOpen, recordLiveAsrFailure, recordLiveAsrSuccess, summarizeLiveAsrJobs } from "./asr/live-segment-policy";

import { canOmitServiceApiKey, isLocalLlmEndpoint } from "./shared/util-llm-endpoint";

import {obfuscateApiKey, deobfuscateApiKey, diagnosticError } from "./shared/util-key-diag";

import { INDUSTRY_META_PROMPT } from "./prompts/industry-meta";

import { JOBPORTRAIT_SYSTEM_PROMPT } from "./prompts/recruit-hrbp";

import { RealtimeOutlineCoordinator, runInOutlineSessionTail } from "./outline-coordinator";

import {splitLexVoiceVersionPayload } from "./version-content";

import {audioImportStageFromWorkProgress, upsertActivityRequest } from "./shared/activity-progress";

import {getTaskErrorMessage } from "./shared/task-activity";

import { DEFAULT_SPEAKER_CHANNELS, MAX_SPEAKER_CHANNELS, buildSpeakerMappings, extractSpeakerIdsFromMarkdown, initialAudioChannelRuntimeMode, normalizeAudioChannelMode, normalizeSpeakerMappings, replaceSpeakerDisplayName, resolveAudioChannelRuntimeMode } from "./audio/channel-speakers";

import {transcribeAudioByChannels } from "./asr/channel-transcription";

import { applySpeakerNamesForLlm, buildConfirmedSpeakerMappings, collectSpeakerCandidates } from "./asr/speaker-mapping";

import { isSpeakerDiarizationProvider, normalizeRequestedSpeakerCount } from "./asr/diarization";

import { isDashScopeFileTransProvider, resolveImportTranscribeProvider, transcribeImportedAudio } from "./asr/long-audio-transcription";

import { BriefingPipelineIncompleteError } from "./briefing/pipeline";

import { shouldRewriteConsolidatedNote } from "./briefing/note-layout-policy";

import { ExternalInboxScanner, createExternalInboxLedger, isAbsoluteExternalInboxPath, normalizeExternalInboxLedger, pruneExternalInboxLedger, shouldImportExternalInboxFile } from "./audio/external-inbox";

import { verifyTranscriptCheckpoint } from "./imports/transcript-checkpoint";

// 以下 1 个声明已抽到 ./views/base-definitions（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { LV_BASE_DEFINITIONS } from "./views/base-definitions";

// 以下 11 个声明已抽到 ./views/wall-markdown（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { CONCEPT_WALL_FILE, LEARNING_WALL_FILE, OBJECT_WALL_FILE, TODO_WALL_FILE, formatConceptWallMarkdown, formatLearningWallMarkdown, formatObjectWallMarkdown, formatTodoWallMarkdown, getLexVoiceBasesFolder, getLexVoiceWallPath, insertGeneratedWallMarker } from "./views/wall-markdown";

// 以下 8 个声明已抽到 ./shared/limits（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { EXTERNAL_INBOX_RETRY_DELAYS_MS, EXTERNAL_INBOX_SCAN_INTERVAL_MS, KNOWLEDGE_EXTRACTION_BATCH_LIMIT, QUICK_INTERIM_CUTS_MS, SEGMENT_CACHE_RETENTION_MS, SHORT_RECORDING_FILTER_MS } from "./shared/limits";

// 以下 9 个声明已抽到 ./notes/recording-issues（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { classifyRecordingIssue, createStreamingTranscriptionClient, isKnowledgeSourceAlreadyScanned, isSyncConflictName, knowledgeExtractionRecordForFile, resolveRuntimeAudioInputMode, transformApiKeyFieldsDeep } from "./notes/recording-issues";

// 以下 23 个声明已抽到 ./prompts/briefing-prompts（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { buildEmptyLlmOutputFallback, clearCommittedBriefingCheckpoint } from "./prompts/briefing-prompts";

// 以下 39 个声明已抽到 ./notes/realtime-outline（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {REALTIME_OUTLINE_FINAL_BATCH_MAX_ATTEMPTS, REALTIME_OUTLINE_FINAL_MAX_BATCHES, REALTIME_OUTLINE_FINAL_MAX_TOKENS, REALTIME_OUTLINE_FINAL_TIMEOUT_MS, REALTIME_OUTLINE_LOOKBACK_SEGMENTS, REALTIME_OUTLINE_MANUAL_TIMEOUT_MS, REALTIME_OUTLINE_MAX_MEMORY_CHARS, REALTIME_OUTLINE_MAX_NO_CHANGE_REJECTIONS, REALTIME_OUTLINE_MAX_PREVIOUS_CHARS, REALTIME_OUTLINE_MAX_SEGMENTS, REALTIME_OUTLINE_MAX_TRANSCRIPT_CHARS, REALTIME_OUTLINE_MIN_NEW_SEGMENTS, REALTIME_OUTLINE_MIN_SEMANTIC_DELTA_CHARS, REALTIME_OUTLINE_SILENT_MAX_TOKENS, REALTIME_OUTLINE_SILENT_TIMEOUT_MS, VIEW_TYPE_OUTLINE, buildCoverageScanPrompt, buildOutlinePrompt, buildRealtimeOutlineAnchorSources, buildRealtimeOutlineTranscript, buildRollingOutlineContext, clipRealtimeContextText, getRealtimeOutlineNewSegmentCount, getRealtimeOutlineQueuedDelayMs, getRealtimeOutlineTimeoutMs, hasRealtimeOutlineRunnableBacklog, isRealtimeOutlineBackoffActive, isRealtimeOutlineCurrent, isRealtimeOutlineSilentIntervalActive, markRealtimeOutlineFailure, markRealtimeOutlineSuccess, normalizeRealtimeOutlineState, parseCoverageScanModel, parseRealtimeOutlineResponse, refreshProgramOwnedRecruitOutlineMemory, renderRealtimeOutlineStateMarkdown, shouldRunRealtimeOutline, updateRealtimeOutlineCoverage } from "./notes/realtime-outline";

// 以下 10 个声明已抽到 ./notes/meeting-workbench（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { MEETING_INTERACTION_MEMORY_MAX_CHARS, MEETING_INTERACTION_OUTLINE_MAX_CHARS, MEETING_INTERACTION_TIMEOUT_MS, MEETING_METADATA_KINDS, clipMeetingInteractionSegmentLine, getMeetingInteractionMaxTokens, normalizeMeetingWorkbench } from "./notes/meeting-workbench";

// 以下 13 个声明已抽到 ./notes/detail-blocks（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {renderRecordingInterviewBriefBlock, renderRecordingPromotionReviewBlock } from "./notes/detail-blocks";

// 以下 14 个声明已抽到 ./notes/audio-refs（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {extractAudioSegmentOffsets, getAudioDurationMs, getAudioExtFromLinkPath, getAudioLinkCandidates, getAudioLinkTarget, getAudioTimeLink, getLexVoiceDurationMs, getLexVoiceSegmentsDurationMs, getSessionMasterAudioName, resolveLexVoiceAudioFile } from "./notes/audio-refs";

// 以下 40 个声明已抽到 ./notes/note-markdown（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {ROLE_MAPPING_FIELDS, analyzeLexVoiceEmptyShortNote, applyRoleMappingToSegments, buildTitleSourceFromSegments, extractLexVoiceSessionId, extractLexVoiceTranscriptSegments, extractRoleMappingFromFrontmatter, formatYamlDateTime, getLexVoiceSourceIdFromMarkdown, inferLexVoiceNoteStartedAtIso, inferModeFromLegacyNote, inferTopicFromFilename, isTextImportSession, isTimeLabel, normalizeSegmentsForMergedNote, parseRoleMapItem, splitImportedTextIntoNormalSegments, stripImportedTextSource } from "./notes/note-markdown";

// 以下 13 个声明已抽到 ./recent/recent-notes（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {detectRecentNoteMode, getRecentNotes } from "./recent/recent-notes";

// 以下 5 个声明已抽到 ./notes/ask-panel（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。

// 以下 2 个声明已抽到 ./notes/daily-overview（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { buildDailyMeetingOverviewEntry, upsertDailyMeetingOverview } from "./notes/daily-overview";

// 以下 1 个声明已抽到 ./audio/recorder-service（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { RecorderService } from "./audio/recorder-service";

// 以下 1 个声明已抽到 ./queue/task-queue（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { TaskQueue } from "./queue/task-queue";

// 以下 1 个声明已抽到 ./ui/outline-view（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { OutlineView } from "./ui/outline-view";

// 以下 3 个声明已抽到 ./briefing/merge-pipeline（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {cleanTranscript, mergeAndPolish } from "./briefing/merge-pipeline";

import { DiagnosticsService } from "./diagnostics/diagnostics-service";
import { TaskActivityService } from "./tasks/task-activity-service";
import { ensureVaultFolder, findAvailableVaultPath } from "./shared/util-vault";
import { DeliveryService } from "./delivery/delivery-service";
import { RecruitService } from "./recruit/recruit-service";
import { NoteWriter } from "./notes/note-writer";
import { QueueRetryService } from "./queue/queue-retry-service";
import { VersionStore } from "./versions/version-store";
import { PeopleDirectoryService } from "./people/people-directory-service";
import { VersionStore } from "./versions/version-store";
import { PeopleDirectoryService } from "./people/people-directory-service";
class LexVoicePlugin extends obsidian.Plugin {
  declare settings: LexVoiceSettings;
  /** 安装时写入的构建信息；通过 Obsidian/BRAT 安装的正式发布没有这个文件。 */
  buildInfo: PluginBuildInfo | null = null;

  /** 界面上显示的版本串：开发版用安装时的标识，否则用 manifest 版本。 */
  getDisplayVersion(): string {
    return resolveDisplayVersion(this.buildInfo, this.manifest && this.manifest.version);
  }

  /** 当前构建的来源描述，供设置页与诊断报告使用。 */
  getBuildSourceLabel(): string {
    return this.buildInfo ? describeBuildSource(this.buildInfo) : "";
  }

  // 读插件目录下的 build-info.json。缺失或损坏都按"正式发布"处理，不影响启动。
  async loadBuildInfo(): Promise<void> {
    try {
      const dir = `${String(this.app.vault.configDir || "")}/plugins/${this.manifest.id}`;
      const path = obsidian.normalizePath(`${dir}/build-info.json`);
      if (!(await this.app.vault.adapter.exists(path))) return;
      const raw = await this.app.vault.adapter.read(path);
      this.buildInfo = normalizePluginBuildInfo(JSON.parse(raw));
    } catch (e) {
      console.warn("[QnALog] build-info read failed", e);
    }
  }

  async onload() {
    // 域服务在加载设置之前装配：loadAll 的设置迁移报告要写诊断日志。
    this.diagnostics = new DiagnosticsService(this);
    this.delivery = new DeliveryService(this);
    this.recruit = new RecruitService(this);
    this.noteWriter = new NoteWriter(this);
    await this.loadAll();
    await this.loadBuildInfo();
    this.updateService = new UpdateService({
      settings: this.settings,
      manifest: this.manifest,
      configDir: String(this.app.vault.configDir || ""),
      adapter: this.app.vault.adapter,
      saveSettings: () => this.saveSettings(),
    }, {
      requestUrl: obsidian.requestUrl
        ? async (options) => {
          const response = await obsidian.requestUrl(options);
          return { status: response.status, text: response.text };
        }
        : undefined,
      notice: (message, duration) => {
        if (duration === undefined) new obsidian.Notice(message);
        else new obsidian.Notice(message, duration);
      },
      warn: (message, error) => {
        if (error === undefined) console.warn(message);
        else console.warn(message, error);
      },
      now: () => Date.now(),
      normalizePath: (path) => obsidian.normalizePath(path),
      setTimeout: (handler, delayMs) => window.setTimeout(handler, delayMs),
      clearTimeout: (handle) => window.clearTimeout(handle),
      buildVersion: this.manifest && this.manifest.version ? this.manifest.version : "",
    });
    this.register(() => this.updateService.dispose());
    this.tasks = new TaskActivityService(this);
    this.queueRetry = new QueueRetryService(this);
    this.versions = new VersionStore(this);
    this.people = new PeopleDirectoryService(this);
    this.tasks.start();
    this.recorder = new RecorderService(this);
    this.asrServiceCircuitKey = "";
    this.asrServiceCircuitState = createLiveAsrCircuitState();
    this.queue = new TaskQueue(this);
    this.queue.load(this.persistedQueue);
    this.session = null;
    this.recordingIssue = null;
    this.outlineCoordinator = new RealtimeOutlineCoordinator({
      getActiveSessionId: () => (this.session && this.session.id) || "",
      evaluate: (request) => this.evaluateRealtimeOutlineRequest(request),
      execute: (request) => this.executeRealtimeOutlineRequest(request),
      onFailure: (request, error) => this.getRealtimeOutlineRetryDecision(request, error),
      onStateChange: (state) => {
        this.tasks.syncOutlineTaskActivity(state);
        this.refreshOutlineView();
      },
    });

    this.tasks.startStatusBar();

    this.ribbonEl = this.addRibbonIcon("mic", "QnALog：点击开始/停止，悬停展开控件", () => this.toggleRecording());
    this.recorder.on(() => this.refreshOutlineView());

    this.registerView(VIEW_TYPE_OUTLINE, (leaf) => new OutlineView(leaf, this));
    this.registerView(VIEW_TYPE_MINUTES_KANBAN, (leaf) => new MinutesKanbanView(leaf, {
      getRootPath: () => obsidian.normalizePath(this.settings.mdFolder || DEFAULT_SETTINGS.mdFolder),
      listItems: () => this.getMinutesKanbanItems(),
      getModeOptions: () => getVisibleModeEntries(this.settings, false).map(([value, label]) => ({ value, label })),
      moveItem: (item, folderPath) => this.moveMinutesKanbanItem(item, folderPath),
      createFolder: (name) => this.createMinutesKanbanFolder(name),
    }));
    // 自定义 Bases 视图「招聘看板」（@since 1.10.0；内部自带守卫，老版本/未启用 Bases 时安全跳过）。
    registerRecruitBoardView(this);
    this.addRibbonIcon("list-tree", "QnALog 实时纪要面板", () => this.openOutlineView());
    this.registerMarkdownPostProcessor((el, ctx) => this.enhanceAudioTimeLinks(el, ctx));

    this.bubble = new BubbleWidget(this);
    // 浮窗显隐与侧边栏（实时纪要面板）联动
    this.registerEvent(this.app.workspace.on("layout-change", () => this.syncBubbleVisibility()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncBubbleVisibility()));
    this.registerEvent(this.app.workspace.on("resize", () => this.syncBubbleVisibility()));
    this.app.workspace.onLayoutReady(() => this.syncBubbleVisibility());

    this.addCommand({ id: "toggle-recording", name: "开始/停止录音", callback: () => this.toggleRecording() });
    this.addCommand({ id: "pause-resume-recording", name: "暂停/继续录音", callback: () => {
      const s = this.recorder.state;
      if (s === "recording") this.recorder.pause(); else if (s === "paused") this.recorder.resume();
    }});
    this.addCommand({ id: "polish-selection-or-note", name: "AI 润色：当前选区或整篇", editorCallback: (editor) => this.noteWriter.polishEditor(editor) });
    this.addCommand({ id: "toggle-floating-ball", name: "显示/隐藏悬浮气泡（总开关）", callback: () => {
      this.settings.showFloatingBall = !this.settings.showFloatingBall;
      void this.saveSettings();
      this.syncBubbleVisibility();
      new obsidian.Notice(this.settings.showFloatingBall ? "浮窗已启用（常驻显示，可拖动）" : "浮窗已关闭");
    }});
    this.addCommand({ id: "open-queue", name: "打开待处理队列", callback: () => new QueueModal(this.app, this).open() });
    this.addCommand({ id: "retry-queue-all", name: "重试所有失败任务", callback: () => this.queueRetry.retryQueue() });
    this.addCommand({ id: "copy-diagnostic-report", name: "复制诊断报告", callback: () => this.diagnostics.copyDiagnosticReport() });
    this.addCommand({ id: "suggest-people-directory-updates", name: "AI 扫描纪要库提取人员建议", callback: () => { void this.people.suggestPeopleDirectoryFromLibrary(); } });
    this.addCommand({ id: "open-learning-card-wall", name: "打开学习卡片瀑布墙", callback: () => { void this.openLearningWall("learning"); } });
    this.addCommand({ id: "open-concept-wall", name: "打开概念墙", callback: () => { void this.openLearningWall("concept"); } });
    this.addCommand({ id: "open-todo-wall", name: "打开待办墙", callback: () => { void this.openTodoWall(); } });
    this.addCommand({ id: "open-object-wall", name: "打开对象总览", callback: () => { void this.openObjectWall(); } });
    this.addCommand({ id: "import-audio", name: "导入已有音频文件转写+润色", callback: () => new ImportAudioModal(this.app, this).open() });
    this.addCommand({
      id: "generate-html-report",
      name: "AI 生成当前纪要 HTML 报告",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const isMd = file instanceof obsidian.TFile && file.extension === "md";
        if (!isMd) return false;
        if (checking) return true;
        void this.delivery.generateHtmlReportForMarkdownFile(file);
        return true;
      },
    });
    this.addCommand({
      id: "generate-pdf-report",
      name: "AI 生成当前纪要 PDF 报告（整页不截断）",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const isMd = file instanceof obsidian.TFile && file.extension === "md";
        if (!isMd) return false;
        if (checking) return true;
        void this.delivery.generatePdfReportForMarkdownFile(file);
        return true;
      },
    });
    this.addCommand({ id: "check-updates", name: "检查更新", callback: () => this.checkForUpdates({ silent: false }) });
    this.addCommand({ id: "open-outline", name: "打开实时纪要面板", callback: () => this.openOutlineView() });
    this.addCommand({ id: "open-minutes-kanban", name: "打开纪要看板", callback: () => this.openMinutesKanban() });
    this.addCommand({ id: "record-mic-only", name: "开始录音 · 仅麦克风", callback: () => { this._oneShotCaptureMode = "mic"; void this.startRecording(); } });
    this.addCommand({ id: "record-mic-virtual", name: "开始录音 · 麦克风 + 电脑音频", callback: () => { this._oneShotCaptureMode = "mix-virtual"; void this.startRecording(); } });
    this.addCommand({ id: "record-virtual-only", name: "开始录音 · 仅电脑音频", callback: () => { this._oneShotCaptureMode = "virtualCable"; void this.startRecording(); } });
    this.addCommand({ id: "import-text", name: "导入已有文本 / MD 结构化整理", callback: () => new ImportTextModal(this.app, this).open() });

    this.settingTab = new LexVoiceSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.registerEvent(this.app.vault.on("create", (file) => {
      this.handleInboxFile(file).catch(e => console.error("[QnALog] inbox handler error", e));
    }));
    // Nutstore Sync / Obsidian Sync may first create a placeholder and then fill it through modify events.
    // Listen to both so a zero-byte placeholder never becomes the only chance to auto-import the file.
    this.registerEvent(this.app.vault.on("modify", (file) => {
      this.handleInboxFile(file).catch(e => console.error("[QnALog] inbox modify handler error", e));
    }));

    // 文件重命名时同步迁移队列里所有指向旧路径的任务，
    // 防止 merge 任务跑完后文件被改名 → 重试时找不到旧路径报"笔记不存在"
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof obsidian.TFile) {
        this.queueRetry.migrateQueueTasksAfterRename(oldPath, file.path);
        this.handleInboxFile(file).catch(e => console.error("[QnALog] inbox rename handler error", e));
      }
    }));

    // 笔记被删（在 Obsidian 里直接删，非插件 UI）→ 清理指向它的队列任务，
    // 否则 merge 任务每次重试都先白烧一次 LLM 再报"笔记不存在"，永久卡 failed 清不掉。
    this.registerEvent(this.app.vault.on("delete", (file) => {
      const path = file && file.path ? file.path : "";
      if (path) this.queueRetry.removeQueueTasksForDeletedMarkdown(path);
    }));

    this.addCommand({ id: "scan-inbox", name: "扫描监听文件夹", callback: () => this.scanInboxFolder() });
    this.externalInboxScanner = new ExternalInboxScanner();
    this.registerInterval(window.setInterval(() => {
      if (!this.settings.inboxAutoImport || !isAbsoluteExternalInboxPath(this.settings.inboxFolder)) return;
      void this.scanExternalInboxFolder({ manual: false, source: "poll" });
    }, EXTERNAL_INBOX_SCAN_INTERVAL_MS));

    // F4.3：招聘项目统计自动重算——JD 库下候选人纪要 create/modify/delete/rename 时，防抖重算其所在项目文件夹。
    // 防自激：consider() 过滤掉 JD 文件本身（basename==父文件夹名），故 recalc 写 JD 触发的 modify 不会再触发重算。
    const recruitFileEvent = (file, oldPath) => {
      try {
        if (!isRecruitFeatureUnlocked(this.settings)) return;
        const root = obsidian.normalizePath(this.settings.recruitJdFolderPath || "JD");
        const underRoot = (p) => { const np = obsidian.normalizePath(p || ""); return np === root || np.startsWith(root + "/"); };
        // 文件夹整体重命名/移动：Obsidian 只发一次 rename(TFolder, oldPath)，不逐子文件发——直接对新旧文件夹路径
        // schedule（recalcRecruitProject 内部"无同名 JD 则早退"，传文件夹路径即可，无需它是 md）。
        if (file instanceof obsidian.TFolder) {
          if (underRoot(file.path)) this.recruit.scheduleRecruitRecalc(obsidian.normalizePath(file.path));
          if (oldPath && underRoot(oldPath)) this.recruit.scheduleRecruitRecalc(obsidian.normalizePath(oldPath));
          return;
        }
        const consider = (p) => {
          if (!p) return;
          const np = obsidian.normalizePath(p);
          if (!underRoot(np)) return;                              // 不在 JD 库下
          if (!/\.md$/i.test(np)) return;                          // 只看 md（.base 不触发）
          const parent = np.replace(/\/[^/]*$/, "");
          const folderName = parent.replace(/^.*\//, "");
          const base = np.replace(/^.*\//, "").replace(/\.md$/i, "");
          if (base === folderName) return;                         // JD 文件本身，跳过（防自激）
          this.recruit.scheduleRecruitRecalc(parent);
        };
        consider(file && file.path);
        if (oldPath) consider(oldPath);                            // rename：源/目标父文件夹都重算（计数才能此消彼长）
      } catch (e) { console.error("[QnALog] recruit file event", e); }
    };
    this.registerEvent(this.app.vault.on("create", (f) => recruitFileEvent(f)));
    this.registerEvent(this.app.vault.on("modify", (f) => recruitFileEvent(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => recruitFileEvent(f)));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => recruitFileEvent(f, oldPath)));

    this.addCommand({ id: "refresh-recruit-project", name: "刷新当前招聘项目统计", callback: () => {
      const file = this.app.workspace.getActiveFile();
      if (!(file instanceof obsidian.TFile) || !file.parent) { new obsidian.Notice("请先打开招聘项目内的任意文件"); return; }
      this.recruit.recalcRecruitProject(file.parent.path)
        .then(ok => new obsidian.Notice(ok ? "已刷新当前招聘项目统计" : "当前文件不在招聘项目文件夹内（需与同名 JD 同目录）"))
        .catch(e => { console.error(e); new obsidian.Notice("刷新失败，请稍后重试"); });
    } });
    this.addCommand({ id: "refresh-all-recruit-projects", name: "刷新全部招聘项目统计", callback: async () => {
      const projects = listJDProjects(this.app, this.settings.recruitJdFolderPath);
      let n = 0;
      for (const p of projects) { if (p.hasJd) { try { await this.recruit.recalcRecruitProject(p.folderPath); n++; } catch (e) { console.error(e); } } }
      new obsidian.Notice(`已刷新 ${n} 个招聘项目统计`);
    } });

    // F6：重建 JD 库根的聚合看板（招聘项目总览）。
    this.addCommand({ id: "rebuild-recruit-aggregate-base", name: "重建招聘项目总览看板", callback: async () => {
      try {
        const root = obsidian.normalizePath(this.settings.recruitJdFolderPath || "JD");
        if (!(this.app.vault.getAbstractFileByPath(root) instanceof obsidian.TFolder)) await this.app.vault.createFolder(root);
        const basePath = obsidian.normalizePath(`${root}/招聘项目.base`);
        const existing = this.app.vault.getAbstractFileByPath(basePath);
        if (existing instanceof obsidian.TFile) await this.app.vault.modify(existing, renderRecruitAggregateBase());
        else await this.app.vault.create(basePath, renderRecruitAggregateBase());
        const bf = this.app.vault.getAbstractFileByPath(basePath);
        if (bf instanceof obsidian.TFile) await this.app.workspace.getLeaf(false).openFile(bf);
        new obsidian.Notice("招聘项目总览看板已重建");
      } catch (e) { console.error(e); new obsidian.Notice("重建失败，请稍后重试"); }
    } });

    // F5：右键 JD 项目文件夹 → 打开 / 重建项目看板（解锁后才出现）。
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      try {
        if (!isRecruitFeatureUnlocked(this.settings)) return;
        if (!(file instanceof obsidian.TFolder)) return;
        const jdFile = (file.children || []).find(f => f instanceof obsidian.TFile && f.extension === "md" && f.basename === file.name);
        if (!jdFile) return;  // 不是招聘项目文件夹（无同名 JD）
        const basePath = obsidian.normalizePath(`${file.path}/${file.name}.base`);
        const baseExists = this.app.vault.getAbstractFileByPath(basePath) instanceof obsidian.TFile;
        const buildBase = async (open) => {
          const parsed = await parseJdProject(this.app, jdFile.path);
          const names = (parsed.综合素质 || []).map(q => q.素质).filter(Boolean);
          const content = renderRecruitCandidateBase(names.length ? names : DEFAULT_RECRUIT_QUALITIES.map(q => q.素质));
          const ex = this.app.vault.getAbstractFileByPath(basePath);
          if (ex instanceof obsidian.TFile) await this.app.vault.modify(ex, content);
          else await this.app.vault.create(basePath, content);
          if (open) { const bf = this.app.vault.getAbstractFileByPath(basePath); if (bf instanceof obsidian.TFile) await this.app.workspace.getLeaf(false).openFile(bf); }
        };
        menu.addItem(item => item.setTitle(baseExists ? "打开项目看板" : "重建项目看板").setIcon("layout-dashboard").onClick(async () => {
          try {
            if (!baseExists) { await buildBase(true); return; }
            const bf = this.app.vault.getAbstractFileByPath(basePath);
            if (bf instanceof obsidian.TFile) await this.app.workspace.getLeaf(false).openFile(bf);
          } catch (e) { console.error(e); new obsidian.Notice("打开项目看板失败"); }
        }));
        if (baseExists) {
          menu.addItem(item => item.setTitle("重建项目看板（刷新素质列）").setIcon("refresh-cw").onClick(async () => {
            try { await buildBase(true); new obsidian.Notice("项目看板已按当前综合素质重建"); }
            catch (e) { console.error(e); new obsidian.Notice("重建失败"); }
          }));
        }
      } catch (e) { console.error("[QnALog] recruit folder menu", e); }
    }));

    // F7：招聘主页 4 个 code block 渲染器（实时计算零落盘，外层 try/catch 降级重试）+ 重建主页命令。
    this.recruit.mountHrBlock("lexvoice-hr-actions", (source, el, ctx) => this.recruit.renderHrActions(source, el, ctx));
    this.recruit.mountHrBlock("lexvoice-hr-stats", (source, el, ctx) => this.recruit.renderHrStats(source, el, ctx));
    this.recruit.mountHrBlock("lexvoice-hr-links", (source, el, ctx) => this.recruit.renderHrLinks(source, el, ctx));
    this.recruit.mountHrBlock("lexvoice-hr-candidates", (source, el, ctx) => this.recruit.renderHrCandidates(source, el, ctx));
    this.recruit.mountHrBlock("lexvoice-hr-recent", (source, el, ctx) => this.recruit.renderHrRecent(source, el, ctx));
    this.recruit.mountHrBlock("lexvoice-hr-latest-notes", (source, el, ctx) => this.recruit.renderHrLatest(source, el, ctx));
    this.addCommand({ id: "rebuild-recruit-homepage", name: "新建 / 重建招聘主页", callback: () => this.recruit.rebuildRecruitHomepage() });
    this.addCommand({ id: "cleanup-empty-short-recordings", name: "清理空白短录音", callback: () => this.cleanupEmptyShortRecordings() });
    this.addCommand({ id: "cleanup-expired-segment-cache", name: "清理过期分段音频缓存", callback: async () => {
      const result = await this.cleanupExpiredSegmentCacheFiles();
      new obsidian.Notice(`分段缓存清理完成：删除 ${result.deleted} 个，跳过 ${result.skipped} 个${result.failed ? `，失败 ${result.failed} 个` : ""}`, 8000);
    } });

    this.addCommand({
      id: "migrate-legacy-notes",
      name: "迁移历史笔记属性",
      callback: () => {
        this.migrateLegacyNotes()
          .then(r => new obsidian.Notice(`迁移：补全 ${r.migrated} / 跳过 ${r.skipped} / 无法识别 ${r.noMode} / 失败 ${r.failed}`, 8000))
          .catch(e => new obsidian.Notice(`迁移失败：${e.message || e}`, 8000));
      },
    });

    this.addCommand({
      id: "regenerate-briefing-from-frontmatter",
      name: "重新整理当前纪要（使用说话人姓名）",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const isMd = file instanceof obsidian.TFile && file.extension === "md";
        const mode = isMd ? this.noteWriter.detectModeFromMarkdown(file) : null;
        if (!isMd || !mode) return false;
        if (checking) return true;
        void this.repolishMarkdownFile(file, mode);
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof obsidian.TFile)) return;
      const ext = (file.extension || "").toLowerCase();
      if (AUDIO_EXT.has(ext)) {
        menu.addSeparator();
        menu.addItem((item) => {
          item.setTitle("QnALog：转写并整理")
            .setIcon("mic")
            .onClick(() => this.openAudioImportOptions([file.path]));
        });
      }
    }));

    this.registerEvent(this.app.workspace.on("files-menu", (menu, files) => {
      const audios = (files || []).filter((f) => f instanceof obsidian.TFile && AUDIO_EXT.has((f.extension || "").toLowerCase()));
      if (audios.length === 0) return;
      const paths = audios.map((f) => f.path);
      menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle(`QnALog：整合 ${audios.length} 段音频…`).setIcon("mic");
        const sub = item.setSubmenu();
        const modes = getVisibleModeEntries(this.settings, false);
        for (const [m, label] of modes) {
          const meta = getModeMeta(this.settings, m);
          sub.addItem((sub_i) => {
            sub_i.setTitle(`整合为${label}（${meta.prefix}模式）`)
              .setIcon("mic")
              .onClick(() => this.openAudioImportOptions(paths, m));
          });
        }
      });
    }));

    if (this.queue.tasks.length > 0) {
      new obsidian.Notice(`QnALog：发现 ${this.queue.tasks.length} 个待处理任务，后台重试中…`);
      window.setTimeout(() => { void this.queueRetry.retryQueue(); }, 2500);
    }
    this.app.workspace.onLayoutReady(() => {
      this.warnIfBuildManifestSkew();
      this.checkForUpdatesOnStartup();
      this.refreshExternalInboxWatcher();
      const inboxTimer = window.setTimeout(() => {
        if (this.settings.inboxAutoImport && isAbsoluteExternalInboxPath(this.settings.inboxFolder)) {
          void this.scanExternalInboxFolder({ manual: false, source: "startup" });
        }
      }, 4000);
      this.register(() => window.clearTimeout(inboxTimer));
      const cleanupTimer = window.setTimeout(() => {
        void this.cleanupExpiredSegmentCacheFiles().catch((e) => console.error("[QnALog] startup segment cache cleanup failed", e));
      }, 6000);
      this.register(() => window.clearTimeout(cleanupTimer));
    });
  }

  onunload() {
    try { if (this.outlineCoordinator) this.outlineCoordinator.dispose(); } catch { /* intentionally empty */ }
    this.closeExternalInboxWatcher();
    try { if (this.queueRetry) this.queueRetry.dispose(); } catch { /* intentionally empty */ }
    void (async () => {
      try { if (this.recorder && this.recorder.state !== "idle") await this.recorder.stop(); } catch { /* intentionally empty */ }
    })();
    if (this.bubble) this.bubble.unmount();
    // 清理招聘项目重算 Debouncer，避免卸载后 pending timer 触发已 detach 的实例
    try { if (this.recruit) this.recruit.dispose(); } catch { /* intentionally empty */ }
  }

  enhanceAudioTimeLinks(el, ctx) {
    const links = Array.from(el.querySelectorAll("a.internal-link"));
    for (const link of links) {
      const label = (link.textContent || "").trim();
      const linkPath = link.getAttribute("data-href") || link.getAttribute("href") || "";
      if (!isTimeLabel(label) || !getAudioExtFromLinkPath(linkPath)) continue;
      link.classList.add("lexvoice-time-link");
      link.setAttribute("aria-label", `QnALog 回听 ${label}`);
      const anyLink = link;
      if (anyLink.__lexvoiceTimeHandler) {
        link.removeEventListener("click", anyLink.__lexvoiceTimeHandler, true);
      }
      const handler = (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (typeof evt.stopImmediatePropagation === "function") evt.stopImmediatePropagation();
        this.openAudioTimeLink(linkPath, label, ctx && ctx.sourcePath, ctx).catch((e) => {
          console.error("[QnALog] open audio time link failed", e);
          new obsidian.Notice(`QnALog 回听失败：${(e && e.message) || e}`);
        });
      };
      anyLink.__lexvoiceTimeHandler = handler;
      link.addEventListener("click", handler, true);
    }
  }

  resolveAudioLinkFile(linkPath, sourcePath) {
    const candidates = getAudioLinkCandidates(linkPath);
    if (!candidates.length) return null;
    const isAudioFile = (file) => file instanceof obsidian.TFile && AUDIO_EXT.has((file.extension || "").toLowerCase());
    for (const target of candidates) {
      const direct = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath || "");
      if (isAudioFile(direct)) return direct;
      const exact = this.app.vault.getAbstractFileByPath(obsidian.normalizePath(target));
      if (isAudioFile(exact)) return exact;
      const scoped = this.app.vault.getAbstractFileByPath(obsidian.normalizePath(`${this.settings.audioFolder}/${target.split("/").pop() || target}`));
      if (isAudioFile(scoped)) return scoped;
    }
    const names = candidates.map((target) => (target.split("/").pop() || target).trim()).filter(Boolean);
    const lowerNames = names.map((name) => name.toLowerCase());
    const stems = names
      .map((name) => name.replace(/\.[^.]+$/i, "").toLowerCase())
      .filter(Boolean);
    return this.app.vault.getFiles().find((f) => {
      if (!AUDIO_EXT.has((f.extension || "").toLowerCase())) return false;
      const fname = (f.name || "").toLowerCase();
      const fbase = (f.basename || "").toLowerCase();
      if (lowerNames.includes(fname)) return true;
      return stems.some((stem) => fbase === stem || fbase.startsWith(stem + "-"));
    }) || null;
  }

  async resolveAudioTimeLinkContext(linkPath, label, sourcePath) {
    const file = this.resolveAudioLinkFile(linkPath, sourcePath);
    if (!(file instanceof obsidian.TFile)) {
      return null;
    }
    const globalMs = parseElapsedMsToken(label);
    let localMs = globalMs;
    if (sourcePath) {
      const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
      if (sourceFile instanceof obsidian.TFile) {
        try {
          const content = await this.app.vault.cachedRead(sourceFile);
          const offsets = extractAudioSegmentOffsets(content);
          const target = getAudioLinkTarget(linkPath);
          const name = (target.split("/").pop() || target).trim();
          const offset = offsets.get(file.path) ?? offsets.get(obsidian.normalizePath(target)) ?? offsets.get(name) ?? offsets.get(file.name);
          if (Number.isFinite(offset)) localMs = Math.max(0, globalMs - offset);
        } catch (e) {
          console.warn("[QnALog] read source note for audio offset failed", e);
        }
      }
    }
    return { file, globalMs, localMs, label, linkPath, sourcePath };
  }

  async openAudioTimeLink(linkPath, label, sourcePath, opts) {
    const payload = await this.resolveAudioTimeLinkContext(linkPath, label, sourcePath);
    if (!payload) {
      const globalMs = parseElapsedMsToken(label);
      const fallbackPayload = { file: null, globalMs, localMs: globalMs, label, linkPath, sourcePath };
      if (opts && typeof opts.onTimeLink === "function") {
        try {
          if (opts.onTimeLink(fallbackPayload) === true) return;
        } catch (e) {
          console.warn("[QnALog] inline time link fallback failed", e);
        }
      }
      if (this.seekOutlineInlineAudio(fallbackPayload)) return;
      new obsidian.Notice("QnALog：找不到对应音频文件，可能已被移动或删除。", 6000);
      return;
    }
    if (opts && typeof opts.onTimeLink === "function") {
      try {
        if (opts.onTimeLink(payload) === true) return;
      } catch (e) {
        console.warn("[QnALog] inline time link handler failed", e);
      }
    }
    if (this.seekOutlineInlineAudio(payload)) return;
    new AudioTimeModal(this.app, payload.file, payload.localMs, label).open();
  }

  seekOutlineInlineAudio(payload) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OUTLINE);
    for (const leaf of leaves) {
      const view = leaf && leaf.view;
      if (view && typeof view.seekInlineAudio === "function") {
        try {
          if (view.seekInlineAudio(payload) === true) return true;
        } catch (e) {
          console.warn("[QnALog] outline inline seek failed", e);
        }
      }
    }
    return false;
  }

  async loadAll() {
    const saved: unknown = (await this.loadData()) || {};
    // 还原密钥：data.json 里的密钥是混淆态，读入内存前先解混淆（旧明文数据会原样通过，下次保存自动转混淆）
    try { transformApiKeyFieldsDeep(saved, deobfuscateApiKey); } catch (e) { console.warn("[QnALog] key deobfuscate failed", e); }
    this.settings = normalizeLexVoiceSettings(saved);
    this.persistedQueue = extractLexVoiceJobItems(saved);
    // schema 升级：data.json 不带 schemaVersion 或低于当前版本时，
    // 立即写回新格式，避免长期保留旧平铺字段。
    const savedRecord = isRecord(saved) ? saved : {};
    const savedSettingsRecord = isRecord(savedRecord.settings) ? savedRecord.settings : {};
    const savedVersionValue = pickDefined(savedSettingsRecord.schemaVersion, savedRecord.schemaVersion, 0);
    const savedVersion = Number.isFinite(Number(savedVersionValue)) ? Number(savedVersionValue) : 0;
    let shouldSave = savedVersion !== SETTINGS_SCHEMA_VERSION;
    // installedUpdateVersion 既记录内置更新器刚写入的待生效版本，也应在插件真正加载后
    // 与 manifest 对齐。否则通过 Obsidian 社区目录更新时，这个字段会永久停留在旧版本。
    const runningVersion = String(this.manifest && this.manifest.version || "").trim();
    if (runningVersion && this.settings.installedUpdateVersion !== runningVersion) {
      this.settings.installedUpdateVersion = runningVersion;
      shouldSave = true;
    }
    try {
      if (await this.migrateDefaultVocabularyFileLocation(saved)) shouldSave = true;
    } catch (e) {
      console.warn("[QnALog] vocabulary location migrate failed", e);
    }
    try {
      if (await this.migrateDefaultLibraryLayout(savedVersion)) shouldSave = true;
    } catch (e) {
      console.warn("[QnALog] default library layout migrate failed", e);
    }
    if (shouldSave) {
      try { await this.saveAll(); } catch (e) { console.warn("[QnALog] schema migrate failed", e); }
      // 迁移结果自检：只在迁移真正发生时输出，正常加载零开销。
      try {
        const report = buildSettingsMigrationReport(savedSettingsRecord, serializeLexVoiceSettings(this.settings), {
          savedVersion,
          currentVersion: SETTINGS_SCHEMA_VERSION,
        });
        if (report) {
          void this.diagnostics.logDiagnostic(
            report.direction === "downgrade" ? "warn" : "info",
            "settings.migration_report",
            report.summary,
            { details: report.details, droppedGroups: report.droppedGroups, actions: report.actions },
          );
          console.warn(`[QnALog] settings migration report\n${report.details}`);
          new obsidian.Notice(`${report.summary}\n\n${report.actions.join("\n")}`, report.actions.length ? 20000 : 12000);
        }
      } catch (e) {
        console.warn("[QnALog] migration report failed", e);
      }
    }
  }
  async saveAll() {
    // 设置页、队列状态和后台任务都可能同时触发保存。直接并发 saveData 时，
    // 较早创建的旧快照可能较晚落盘，覆盖刚加入的任务或新设置。
    // 串行执行并在真正轮到写入时再取快照，保证磁盘最终状态与内存最新状态一致。
    const previous = this._saveAllTail || Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this._saveAllSnapshot());
    this._saveAllTail = current;
    try {
      return await current;
    } finally {
      if (this._saveAllTail === current) this._saveAllTail = null;
    }
  }

  async _saveAllSnapshot() {
    const payload = {
      settings: serializeLexVoiceSettings(this.settings),
      backgroundJobs: {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        items: this.queue ? this.queue.snapshot() : (this.persistedQueue || []),
      },
    };
    // 落盘前深拷贝再混淆密钥：serialize 里有的字段（如 transcribeProviders）是对内存的引用，
    // 直接混淆会污染内存里的明文密钥导致后续 API 调用失败。深拷贝隔离后只混淆磁盘副本。
    let safe;
    try {
      safe = JSON.parse(JSON.stringify(payload));
      transformApiKeyFieldsDeep(safe.settings, obfuscateApiKey);
    } catch (e) {
      console.warn("[QnALog] key obfuscate failed, fallback to plain", e);
      safe = payload;
    }
    await this.saveData(safe);
  }
  async saveSettings() { await this.saveAll(); }  async migrateDefaultVocabularyFileLocation(savedData) {
    const saved = isRecord(savedData) ? savedData : {};
    const raw = isRecord(saved.settings) ? saved.settings : saved;
    const vocabulary = raw.vocabulary || {};
    const savedPath = pickDefined(vocabulary.notePath, raw.vocabularyFile, "");
    const normSaved = obsidian.normalizePath(savedPath || "");
    const usesLegacyDefault = !normSaved || normSaved.toLowerCase() === LEGACY_VOCABULARY_FILE.toLowerCase();
    if (!usesLegacyDefault) return false;

    const oldPath = obsidian.normalizePath(LEGACY_VOCABULARY_FILE);
    const newPath = obsidian.normalizePath(DEFAULT_SETTINGS.vocabularyFile);
    let changed = this.settings.vocabularyFile !== newPath;
    this.settings.vocabularyFile = newPath;

    const oldFile = this.app.vault.getAbstractFileByPath(oldPath);
    const newFile = this.app.vault.getAbstractFileByPath(newPath);
    if (oldFile instanceof obsidian.TFile && !(newFile instanceof obsidian.TFile)) {
      const folderPath = newPath.includes("/") ? newPath.slice(0, newPath.lastIndexOf("/")) : "";
      if (folderPath) await ensureVaultFolder(this.app, folderPath);
      await this.app.fileManager.renameFile(oldFile, newPath);
      changed = true;
    }
    const targetFile = this.app.vault.getAbstractFileByPath(newPath);
    if (targetFile instanceof obsidian.TFile) {
      const content = await this.app.vault.cachedRead(targetFile);
      if (!isStructuredVocabularyMarkdown(content)) {
        await this.app.vault.modify(targetFile, formatVocabularyMarkdown(parseVocabularyGroups(content), this.settings.industryProfile));
        changed = true;
      }
    }
    return changed;
  }

  async migrateDefaultLibraryLayout(savedVersion) {
    if (Number(savedVersion) >= 4) return false;
    let changed = false;
    const migrations = [
      ["peopleDirectoryFolder", LEGACY_DEFAULT_LIBRARY_PATHS.peopleDirectoryFolder, DEFAULT_LIBRARY_PATHS.peopleDirectoryFolder],
      ["learningCardsFolder", LEGACY_DEFAULT_LIBRARY_PATHS.learningCardsFolder, DEFAULT_LIBRARY_PATHS.learningCardsFolder],
      ["todoCardsFolder", LEGACY_DEFAULT_LIBRARY_PATHS.todoCardsFolder, DEFAULT_LIBRARY_PATHS.todoCardsFolder],
      ["lexVoiceBasesFolder", LEGACY_DEFAULT_LIBRARY_PATHS.lexVoiceBasesFolder, DEFAULT_LIBRARY_PATHS.lexVoiceBasesFolder],
      ["peopleBaseFile", LEGACY_DEFAULT_LIBRARY_PATHS.peopleBaseFile, DEFAULT_LIBRARY_PATHS.peopleBaseFile],
      ["vocabularyFile", LEGACY_DEFAULT_LIBRARY_PATHS.vocabularyFile, DEFAULT_LIBRARY_PATHS.vocabularyFile],
      ["diagnosticsLogFolder", LEGACY_DEFAULT_LIBRARY_PATHS.diagnosticsLogFolder, DEFAULT_LIBRARY_PATHS.diagnosticsLogFolder],
    ];
    for (const [settingKey, legacyValue, nextValue] of migrations) {
      const current = obsidian.normalizePath(String(this.settings[settingKey] || ""));
      const legacyPath = obsidian.normalizePath(legacyValue);
      const nextPath = obsidian.normalizePath(nextValue);
      if (current.toLowerCase() !== legacyPath.toLowerCase()) continue;
      const legacyEntry = this.app.vault.getAbstractFileByPath(legacyPath);
      const nextEntry = this.app.vault.getAbstractFileByPath(nextPath);
      if (legacyEntry && nextEntry) {
        console.warn(`[QnALog] default library migration skipped because both paths exist: ${legacyPath} -> ${nextPath}`);
        continue;
      }
      if (legacyEntry && !nextEntry) {
        const parentPath = nextPath.includes("/") ? nextPath.slice(0, nextPath.lastIndexOf("/")) : "";
        if (parentPath) await ensureVaultFolder(this.app, parentPath);
        await this.app.fileManager.renameFile(legacyEntry, nextPath);
      }
      this.settings[settingKey] = nextPath;
      changed = true;
    }

    const legacyArchiveFolder = obsidian.normalizePath(LEGACY_DEFAULT_LIBRARY_PATHS.archiveFolder);
    const nextArchiveFolder = obsidian.normalizePath(DEFAULT_LIBRARY_PATHS.archiveFolder);
    const legacyArchiveFolderEntry = this.app.vault.getAbstractFileByPath(legacyArchiveFolder);
    const nextArchiveFolderEntry = this.app.vault.getAbstractFileByPath(nextArchiveFolder);
    if (legacyArchiveFolderEntry && !nextArchiveFolderEntry) {
      const parentPath = nextArchiveFolder.slice(0, nextArchiveFolder.lastIndexOf("/"));
      await ensureVaultFolder(this.app, parentPath);
      await this.app.fileManager.renameFile(legacyArchiveFolderEntry, nextArchiveFolder);
      changed = true;
    } else {
      const legacyArchive = obsidian.normalizePath(LEGACY_DEFAULT_LIBRARY_PATHS.duplicatePeopleArchiveFolder);
      const nextArchive = obsidian.normalizePath(DEFAULT_LIBRARY_PATHS.duplicatePeopleArchiveFolder);
      const legacyArchiveEntry = this.app.vault.getAbstractFileByPath(legacyArchive);
      const nextArchiveEntry = this.app.vault.getAbstractFileByPath(nextArchive);
      if (legacyArchiveEntry && !nextArchiveEntry) {
        await ensureVaultFolder(this.app, nextArchiveFolder);
        await this.app.fileManager.renameFile(legacyArchiveEntry, nextArchive);
        changed = true;
      }
    }
    return changed;
  }

  getTranscribeProviderProfile(id, provider) {
    const profiles = {
      siliconflow: {
        title: "硅基流动",
        badge: "云端转写",
        transcribeMode: "segmented",
        requiresKey: true,
        endpointPlaceholder: "https://api.siliconflow.cn/v1/audio/transcriptions",
        modelPlaceholder: "FunAudioLLM/SenseVoiceSmall",
        languagePlaceholder: "auto",
        endpointHelp: "硅基流动的音频转写服务地址。通常保持默认即可。",
        keyHelp: "从硅基流动控制台复制访问密钥。密钥以混淆（非加密）形式保存在本库的插件设置文件中，不会上传；请勿把整个库文件夹同步或分享给不信任的对象。",
        modelHelp: "推荐 FunAudioLLM/SenseVoiceSmall。延迟低，支持 50+ 语种，中文和粤语识别表现较好。",
        description: "OpenAI 兼容的音频转写接口。QnALog 会按设定的分段间隔切段上传。",
        priceHint: "FunAudioLLM/SenseVoiceSmall 目前在硅基流动免费且不限用量；平台规则可能调整，以硅基流动控制台为准。",
        steps: ["注册或登录硅基流动账号", "在控制台创建访问密钥", "确认服务地址和模型名称后运行连通性测试"],
        links: [
          ["访问密钥", "https://cloud.siliconflow.cn/account/ak"],
          ["转写文档", "https://docs.siliconflow.cn/cn/api-reference/audio/create-audio-transcriptions"],
        ],
      },
      openai: {
        title: "OpenAI（切片转写）",
        badge: "云端转写",
        transcribeMode: "segmented",
        requiresKey: true,
        endpointPlaceholder: "https://api.openai.com/v1/audio/transcriptions",
        modelPlaceholder: "gpt-4o-transcribe",
        languagePlaceholder: "",
        endpointHelp: "OpenAI 的音频转写服务地址。需要可访问 OpenAI API 的网络环境。",
        keyHelp: "填写 OpenAI 项目的访问密钥。",
        modelHelp: "推荐 gpt-4o-transcribe（HTTP 切片）。需要边说边出字幕时，可改用「OpenAI Realtime · 语音转写」。",
        description: "OpenAI 兼容的音频转写接口。QnALog 会按设定的分段间隔切段上传。",
        priceHint: "按音频用量计费（官方价 $6/百万音频 token），以 OpenAI 定价页为准。",
        steps: ["确认 OpenAI API 账户可用", "填写访问密钥", "运行连通性测试"],
        links: [["OpenAI 密钥", "https://platform.openai.com/api-keys"]],
      },
      "openai-diarize": {
        title: "OpenAI · 说话人分离",
        badge: "说话人分离",
        transcribeMode: "segmented",
        speakerDiarization: true,
        speakerLabelScope: "session",
        requiresWholeSession: true,
        requiresKey: true,
        endpointPlaceholder: "https://api.openai.com/v1/audio/transcriptions",
        modelPlaceholder: "gpt-4o-transcribe-diarize",
        languagePlaceholder: "",
        endpointHelp: "OpenAI 的音频转写服务地址。需要可访问 OpenAI API 的网络环境。",
        keyHelp: "填写 OpenAI 项目的访问密钥。",
        modelHelp: "使用 gpt-4o-transcribe-diarize。该模型会返回带时间和说话人标签的分段结果。",
        description: "停止录音后统一识别整场音频，以保持说话人编号在本场录音内一致。识别完成后可确认每个编号对应的姓名，再进入 AI 整理。",
        priceHint: "按音频用量计费，以 OpenAI 定价页为准。",
        steps: ["确认 OpenAI API 账户可用", "填写访问密钥", "运行连通性测试", "停止录音后确认说话人姓名"],
        links: [
          ["OpenAI 密钥", "https://platform.openai.com/api-keys"],
          ["说话人分离文档", "https://platform.openai.com/docs/api-reference/audio/createTranscription"],
        ],
        note: "为避免不同切片中的说话人编号重置，录音过程中不会分段上传；停止后才统一转写。原始逐字稿保留说话人编号，姓名映射用于 AI 整理。",
      },
      "dashscope-filetrans": {
        title: "阿里云百炼 Fun-ASR",
        badge: "长音频 · 说话人分离",
        transcribeMode: "whole-file",
        speakerDiarization: true,
        speakerLabelScope: "session",
        requiresWholeSession: true,
        requiresKey: true,
        endpointPlaceholder: "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
        modelPlaceholder: "fun-asr",
        languagePlaceholder: "zh",
        endpointHelp: "阿里云百炼录音文件识别接口，通常保持默认即可。",
        keyHelp: "填写阿里云百炼 API Key。音频会临时上传到阿里云并异步识别。",
        modelHelp: "推荐 fun-asr。支持整文件转写和说话人分离。",
        description: "导入音频专用。QnALog 直接提交整段音频，不在本地切成多个 ASR 任务。",
        priceHint: "普通录音文件识别最长支持 12 小时；启用说话人分离时，官方建议单文件不超过 2 小时。",
        steps: ["在百炼控制台创建 API Key", "保持默认服务地址和模型名", "运行连接测试", "在导入音频后确认说话人姓名"],
        links: [
          ["访问密钥", "https://help.aliyun.com/zh/model-studio/developer-reference/get-api-key"],
          ["录音文件识别文档", "https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide"],
        ],
        note: "整文件转写不会生成实时大纲。超过 2 小时仍可提交，但说话人分离的准确度可能下降。",
      },
      apimimo: {
        title: "APIMiMo V2.5 ASR",
        badge: "云端转写",
        transcribeMode: "segmented",
        requiresKey: true,
        endpointPlaceholder: "https://api.xiaomimimo.com/v1/chat/completions",
        modelPlaceholder: "mimo-v2.5-asr",
        languagePlaceholder: "auto / zh / en",
        languageHelp: "留空或 auto 自动检测；明确语种时填 zh（中文，含粤语、吴语、闽南话、四川话等方言）或 en（英文）可提升准确率。其它值会按 auto 处理。",
        endpointHelp: "小米 MiMo 的服务地址，保持默认即可。QnALog 会按 MiMo 要求的专用格式发送音频，与其他转写服务不同，无需手动调整。",
        keyHelp: "填写小米 MiMo 平台的访问密钥（API Key）。密钥以混淆（非加密）形式保存在本库的插件设置文件中，不会上传。",
        modelHelp: "固定使用 mimo-v2.5-asr。该服务只接受 wav/mp3、单段约 7.5MB 以内的音频；其他格式或更长的录音会由 QnALog 自动转换、切段后上传，无需手动处理。",
        description: "APIMiMo-V2.5-ASR 通过 OpenAI 兼容 Chat Completions 的 input_audio 识别音频。服务端只收 wav/mp3：选用本服务时 QnALog 会以 WebM/Opus 录音并在本机转成 WAV 分块上传；wav/mp3 文件未超限则直接发送。",
        priceHint: "按 MiMo 平台计费。大小限制由 QnALog 自动处理：超限录音会按约 3 分钟自动切块上传，无需手动干预。",
        steps: ["在小米 MiMo 平台创建 API Key", "保持默认服务地址和模型名", "运行连通性测试"],
        links: [["MiMo ASR 文档", "https://platform.xiaomimimo.com/docs/zh-CN/api/audio/Speech-Recognition"]],
        note: "此服务不支持热词参数；QnALog 会在转写结果返回后做本地热词纠错。在上方「识别语言」填 zh 或 en 可提升准确率。注意：此前用其他服务录制的 m4a/mp4 录音无法用本服务重新转写（仅影响重转写，新录音不受影响），如需重转写请临时切回原服务。",
      },
      "openai-realtime": {
        title: "OpenAI Realtime · 语音转写",
        badge: "流式实时",
        transcribeMode: "streaming",
        streamProtocol: "openai-realtime-transcription",
        requiresKey: true,
        endpointPlaceholder: "wss://api.openai.com/v1/realtime",
        modelPlaceholder: "gpt-realtime-whisper",
        languagePlaceholder: "（可留空，自动检测）",
        endpointHelp: "OpenAI Realtime 的 WebSocket 地址。保持默认即可。",
        keyHelp: "OpenAI 项目的访问密钥（与切片转写共用同一把 Key）。",
        modelHelp: "推荐 gpt-realtime-whisper（流式 ASR，专为实时字幕/会议记录设计）。",
        description: "流式转写，边说边出文字。QnALog 跳过分段切片，整场录音与服务保持一条实时连线，延迟约半秒以内。",
        priceHint: "gpt-realtime-whisper ≈ $0.017 / 分钟 ≈ ¥7.2 / 小时。",
        steps: ["确认 OpenAI API 账户可用且能访问 Realtime API", "填写访问密钥", "保持模型名 gpt-realtime-whisper", "选「仅麦克风」捕获模式开始录音"],
        links: [
          ["OpenAI 密钥", "https://platform.openai.com/api-keys"],
          ["Realtime 文档", "https://developers.openai.com/api/docs/guides/realtime-transcription"],
        ],
        note: "流式模式下「分段间隔」「即时分段」设置不生效；笔记会在录音过程中实时追加文字。",
      },
      "openai-realtime-translate": {
        title: "OpenAI Realtime · 语音翻译",
        badge: "流式翻译",
        transcribeMode: "streaming",
        streamProtocol: "openai-realtime-translation",
        requiresKey: true,
        endpointPlaceholder: "wss://api.openai.com/v1/realtime/translations",
        modelPlaceholder: "gpt-realtime-translate",
        languagePlaceholder: "",
        endpointHelp: "OpenAI Realtime Translations 的 WebSocket 基础地址。模型名会自动追加为查询参数。",
        keyHelp: "OpenAI 项目的访问密钥。",
        modelHelp: "推荐 gpt-realtime-translate（70+ 语言输入 → 13 语言输出，由专业口译员录音训练）。",
        description: "流式语音翻译。自动检测说话者语言，实时输出译文+原文双轨笔记。模型同时返回译音流（QnALog 自动丢弃，仅保留文字）。",
        priceHint: "gpt-realtime-translate ≈ $0.034 / 分钟 ≈ ¥14.4 / 小时。",
        steps: [
          "确认 OpenAI API 账户可用且能访问 Realtime API",
          "填写访问密钥",
          "在「目标语言」中选择需要的输出语言",
          "选「仅麦克风」捕获模式开始录音",
        ],
        links: [
          ["OpenAI 密钥", "https://platform.openai.com/api-keys"],
          ["Realtime 翻译文档", "https://developers.openai.com/api/docs/guides/realtime-translation"],
        ],
        note: "支持的目标语言：英语 (en)、中文 (zh)、日语 (ja)、韩语 (ko)、法语 (fr)、西班牙语 (es)、德语 (de)、意大利语 (it)、葡萄牙语 (pt)、俄语 (ru)、阿拉伯语 (ar)、印地语 (hi)、土耳其语 (tr)。",
        showTargetLanguage: true,
      },
      dashscope: {
        title: "阿里云百炼 Paraformer Realtime",
        badge: "流式实时",
        transcribeMode: "streaming",
        streamProtocol: "dashscope-ws",
        requiresKey: true,
        endpointPlaceholder: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
        modelPlaceholder: "paraformer-realtime-v2",
        languagePlaceholder: "",
        endpointHelp: "Paraformer Realtime 的 WebSocket 地址。保持默认即可。",
        keyHelp: "填写百炼控制台创建的访问密钥（API Key）。密钥以混淆（非加密）形式保存在本库的插件设置文件中，不会上传。",
        modelHelp: "推荐 paraformer-realtime-v2（中英混合）；电话场景可用 paraformer-realtime-8k-v2。",
        description: "流式转写，边说边出文字。QnALog 跳过分段切片，整场录音与服务保持一条实时连线，延迟约半秒以内。无需中转。",
        priceHint: "Paraformer Realtime ≈ ¥3.6 / 小时（国内最便宜）。",
        steps: ["在百炼控制台创建 API Key", "保持默认服务地址和模型名", "选「仅麦克风」捕获模式，开始录音即可"],
        links: [
          ["访问密钥", "https://help.aliyun.com/zh/model-studio/developer-reference/get-api-key"],
          ["Paraformer Realtime 文档", "https://help.aliyun.com/zh/model-studio/paraformer-realtime-api"],
        ],
        note: "流式模式下「分段间隔」「即时分段」设置不生效；笔记会在录音过程中实时追加文字。",
      },
      local: {
        title: "本地转写服务",
        badge: "本地服务",
        transcribeMode: "segmented",
        requiresKey: false,
        endpointPlaceholder: "http://127.0.0.1:8000/v1/audio/transcriptions",
        modelPlaceholder: "whisper-large-v3",
        languagePlaceholder: "zh",
        endpointHelp: "填写本地转写服务的 HTTP 地址。服务需要接收音频文件上传，并返回 text。",
        keyHelp: "多数本地服务可留空；如果服务要求鉴权，再填约定的密钥或令牌。",
        modelHelp: "模型名称由本地服务决定，例如 whisper-large-v3、whisper-large-v3-turbo、SenseVoiceSmall。",
        description: "适合隐私优先或离线工作流。QnALog 不负责下载模型或启动服务，只负责把音频发送到已启动的本地转写服务。",
        priceHint: "免费（消耗本机 GPU/CPU）。",
        steps: ["安装并启动本地转写服务", "确认服务能接收音频上传并返回 text", "填写服务地址、模型名称后运行连通性测试"],
        links: [
          ["Xinference 文档", "https://inference.readthedocs.io/en/latest/models/model_abilities/audio.html"],
          ["whisper.cpp", "https://github.com/ggml-org/whisper.cpp"],
        ],
      },
      whisperx: {
        title: "WhisperX · 说话人分离",
        badge: "本地分离",
        transcribeMode: "segmented",
        speakerDiarization: true,
        speakerLabelScope: "session",
        requiresWholeSession: true,
        requiresKey: false,
        endpointPlaceholder: "http://127.0.0.1:8000/v1/audio/transcriptions",
        modelPlaceholder: "whisper-large-v3",
        languagePlaceholder: "zh",
        endpointHelp: "填写已启动的 WhisperX 或兼容说话人分离服务地址。",
        keyHelp: "本地服务通常可以留空；如果你的网关要求鉴权，再填写访问密钥。",
        modelHelp: "模型名称由本地服务决定。响应需要包含 segments[].speaker，或在 text 中内联 SPEAKER_00 等标签。",
        description: "停止录音后由本地服务统一识别整场音频，并把说话人标签写入逐字稿。",
        priceHint: "免费（消耗本机 GPU/CPU）。",
        steps: ["安装并启动带 diarization 的 WhisperX 服务", "确认响应包含 speaker 字段", "运行连通性测试"],
        links: [["WhisperX", "https://github.com/m-bain/whisperX"]],
        note: "QnALog 只负责调用已启动的服务，不负责安装模型。为保持说话人编号一致，录音停止后统一转写。",
      },
      custom: {
        title: "其他转写服务",
        badge: "高级",
        transcribeMode: "segmented",
        requiresKey: false,
        endpointPlaceholder: "https://your-domain.example/v1/audio/transcriptions",
        modelPlaceholder: "your-transcribe-model",
        languagePlaceholder: "",
        endpointHelp: "填写第三方或自建转写服务地址。服务需要接收音频文件上传，并返回 text。",
        keyHelp: "按服务要求填写；不需要鉴权时可留空。",
        modelHelp: "按服务支持的模型名称填写。",
        description: "适合企业内部网关、自建转写服务或其他第三方转写服务。",
        priceHint: "",
        steps: ["确认服务能接收音频文件上传", "确认响应中包含 text 字段", "保存后运行连通性测试"],
        links: [],
      },
    };
    const base = profiles[id] || profiles.custom;
    const title = id === "custom" && provider && provider.name ? provider.name : base.title;
    return Object.assign({}, base, { title });
  }

  getActiveTranscribeProfile() {
    const id = this.settings.activeTranscribeProvider || "siliconflow";
    const provider = (this.settings.transcribeProviders || {})[id] || {};
    return this.getTranscribeProviderProfile(id, provider);
  }

  makeStreamingNoteUpdater(session) {
    let scheduled = false;
    let lastWritten = "";
    const flush = async () => {
      scheduled = false;
      if (!session || session.finalized) return;
      const text = session.streamingFullText || "";
      if (text === lastWritten) return;
      lastWritten = text;
      try {
        await this.upsertLiveTranscriptBlock(session.mdPath, session.id, text);
      } catch (e) { console.error("[QnALog] live update failed", e); }
    };
    return () => {
      if (scheduled) return;
      scheduled = true;
      window.setTimeout(() => { void flush(); }, 1500);
    };
  }

  async upsertLiveTranscriptBlock(mdPath, sessionId, text) {
    const file = this.app.vault.getAbstractFileByPath(mdPath);
    if (!(file instanceof obsidian.TFile)) return;
    const startMarker = `<!-- lv-live-start:${sessionId} -->`;
    const endMarker = `<!-- lv-live-end:${sessionId} -->`;
    const safe = (text || "").trim().split("\n").map(l => "> " + l).join("\n");
    const body = safe || "> _（等待说话…）_";
    const block = `${startMarker}\n> [!quote]+ 实时转写中…\n${body}\n${endMarker}`;
    const cur = await this.app.vault.read(file);
    const startIdx = cur.indexOf(startMarker);
    const endIdx = cur.indexOf(endMarker);
    if (startIdx >= 0 && endIdx > startIdx) {
      const next = cur.slice(0, startIdx) + block + cur.slice(endIdx + endMarker.length);
      if (next !== cur) await this.app.vault.modify(file, next);
      return;
    }
    const segEnd = `<!-- lexvoice-segments-end:${sessionId} -->`;
    const segIdx = cur.indexOf(segEnd);
    if (segIdx >= 0) {
      const next = cur.slice(0, segIdx) + block + "\n" + cur.slice(segIdx);
      await this.app.vault.modify(file, next);
    }
  }

  async removeLiveTranscriptBlock(mdPath, sessionId) {
    const file = this.app.vault.getAbstractFileByPath(mdPath);
    if (!(file instanceof obsidian.TFile)) return;
    const startMarker = `<!-- lv-live-start:${sessionId} -->`;
    const endMarker = `<!-- lv-live-end:${sessionId} -->`;
    const cur = await this.app.vault.read(file);
    const startIdx = cur.indexOf(startMarker);
    const endIdx = cur.indexOf(endMarker);
    if (startIdx < 0 || endIdx < 0) return;
    const next = cur.slice(0, startIdx).replace(/\n+$/, "") + cur.slice(endIdx + endMarker.length).replace(/^\n+/, "\n");
    await this.app.vault.modify(file, next);
  }

  openSettings(tabId = "home") {
    if (this.settingTab) this.settingTab.activeTab = tabId;
    const setting = this.app.setting;
    if (!setting) return;
    setting.open();
    if (typeof setting.openTabById === "function") {
      setting.openTabById(this.manifest.id);
    }
    if (this.settingTab) {
      window.setTimeout(() => {
        this.settingTab.activeTab = tabId;
        this.settingTab.display();
      }, 0);
    }
  }  getUpdateRawBase() {
    return this.updateService.getUpdateRawBase();
  }

  getUpdateRawBases() {
    return this.updateService.getUpdateRawBases();
  }

  checkForUpdatesOnStartup() {
    return this.updateService.checkForUpdatesOnStartup();
  }

  async checkForUpdates(options = {}) {
    return this.updateService.checkForUpdates(options);
  }

  warnIfBuildManifestSkew() {
    return this.updateService.warnIfBuildManifestSkew();
  }

  setRecordingIssue(kind, patch) {
    const current = this.recordingIssue || {};
    this.recordingIssue = makeRecordingIssue(kind || current.kind || "service", Object.assign({}, current, patch || {}, {
      kind: kind || current.kind || "service",
      at: patch && patch.at ? patch.at : (current.at || Date.now()),
    }));
    try { this.refreshOutlineView(); } catch { /* intentionally empty */ }
    try { if (this.bubble && this.bubble.scheduleUpdate) this.bubble.scheduleUpdate(); } catch { /* intentionally empty */ }
  }

  clearRecordingIssue(kind) {
    if (!this.recordingIssue) return;
    if (kind && this.recordingIssue.kind !== kind) return;
    this.recordingIssue = null;
    try { this.refreshOutlineView(); } catch { /* intentionally empty */ }
    try { if (this.bubble && this.bubble.scheduleUpdate) this.bubble.scheduleUpdate(); } catch { /* intentionally empty */ }
  }

  getRecordingIssue() {
    const recorderIssue = this.recorder && this.recorder.getInfo ? (this.recorder.getInfo().issue || null) : null;
    if (recorderIssue && recorderIssue.kind === "microphone") return recorderIssue;
    return this.recordingIssue || recorderIssue || null;
  }

  refreshOutlineView() {
    try { this.tasks.updateBusyStatus(); } catch { /* intentionally empty */ }
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OUTLINE);
    for (const leaf of leaves) {
      const v = leaf.view;
      if (!v) continue;
      // 优先走节流通道；旧实例兜底直调 render
      if (typeof v.scheduleUpdate === "function") v.scheduleUpdate();
      else if (typeof v.render === "function") v.render();
    }
  }  // 转写完成后的自动沉淀（仅 settings.sedimentAutoExtract 开启时触发）：扫描纪要 → 学习卡片/待办自动入库。
  // 后台跑、try/catch 静默——绝不影响主流程；沉淀扫描已走续写拼接（callLlmWithContinuation），不会被输出上限截断。
  async autoExtractSedimentAfterFinalize(mdPath) {
    try {
      const file = this.app.vault.getAbstractFileByPath(obsidian.normalizePath(mdPath || ""));
      if (!(file instanceof obsidian.TFile)) return;
      const markdown = await this.app.vault.cachedRead(file);
      const objects = await generateSedimentObjects(this, file, markdown);
      await writeSedimentObjectCards(this, file, { learningCards: objects.learningCards || [], todos: objects.todos || [] });
    } catch (e) { console.error("[QnALog] autoExtractSedimentAfterFinalize", e); }
  }  scheduleRealtimeOutline(opts = {}) {
    const session = this.session;
    if (!session || !session.id) return;
    const requestedDelay = Number(opts && opts.delayMs);
    const delay = Number.isFinite(requestedDelay) && requestedDelay >= 0
      ? Math.max(250, Math.round(requestedDelay))
      : Math.max(2500, this.settings.realtimeOutlineDebounceMs || 1500);
    this.outlineCoordinator.schedule({
      sessionId: session.id,
      silent: true,
      reason: (opts && opts.reason) || "segment",
      delayMs: delay,
      local: isLocalLlmEndpoint(this.settings.llmEndpoint),
    });
  }

  ensureRealtimeOutlineProgress(session = this.session, reason = "progress-check") {
    if (!session || session !== this.session || !session.id) return false;
    if (!this.settings.enableRealtimeOutline && session.mode !== "recruit-needs") return false;
    if (!hasRealtimeOutlineRunnableBacklog(session)) return false;
    const local = isLocalLlmEndpoint(this.settings.llmEndpoint);
    this.scheduleRealtimeOutline({
      delayMs: getRealtimeOutlineQueuedDelayMs(session, { local }),
      reason,
    });
    return true;
  }

  async refreshRealtimeOutlineInBackground(opts = {}) {
    const session = this.session;
    if (!session || !session.id || !session.segments || !session.segments.length) return "";
    const local = isLocalLlmEndpoint(this.settings.llmEndpoint);
    return await this.outlineCoordinator.request({
      sessionId: session.id,
      silent: !!opts.silent,
      force: !!opts.force,
      final: !!opts.final,
      reason: opts.reason || (opts.force ? "manual-refresh" : "background"),
      timeoutMs: opts.timeoutMs,
      maxTokens: opts.maxTokens,
      local,
    });
  }

  getRealtimeOutlineCoordinatorState() {
    return this.outlineCoordinator
      ? this.outlineCoordinator.getState()
      : { phase: "idle", sessionId: "", runId: 0, queued: 0, reason: "", startedAt: 0, nextRunAt: 0, lastError: "" };
  }

  isRealtimeOutlineRunning(session = this.session) {
    const state = this.getRealtimeOutlineCoordinatorState();
    return !!(session && state.phase === "running" && state.sessionId === session.id);
  }

  cancelRealtimeOutline(sessionId) {
    if (this.outlineCoordinator) this.outlineCoordinator.cancel(sessionId);
  }

  evaluateRealtimeOutlineRequest(request) {
    const session = this.session;
    if (!session || session.id !== request.sessionId) {
      return { ready: false, retry: false, reason: "stale-session" };
    }
    if (!this.settings.enableRealtimeOutline && session.mode !== "recruit-needs") {
      return { ready: false, retry: false, reason: "disabled" };
    }
    const local = !!request.local || isLocalLlmEndpoint(this.settings.llmEndpoint);
    if (shouldRunRealtimeOutline(session, {
      silent: !!request.silent,
      force: !!request.force,
      final: !!request.final,
      local,
    })) {
      return { ready: true };
    }
    if (!request.silent || !hasRealtimeOutlineRunnableBacklog(session)) {
      return { ready: false, retry: false, reason: "no-runnable-backlog" };
    }
    let reason = "waiting";
    if (Number(session.activeSegmentJobs || 0) > 0) reason = "asr-busy";
    else if (isRealtimeOutlineBackoffActive(session)) reason = "failure-backoff";
    else if (isRealtimeOutlineSilentIntervalActive(session, { local })) reason = "minimum-interval";
    return {
      ready: false,
      retry: true,
      delayMs: getRealtimeOutlineQueuedDelayMs(session, { local }),
      reason,
    };
  }

  getRealtimeOutlineRetryDecision(request) {
    const session = this.session;
    if (!request.silent || !session || session.id !== request.sessionId) {
      return { retry: false, reason: "failed" };
    }
    if (!hasRealtimeOutlineRunnableBacklog(session)) {
      return { retry: false, reason: "no-runnable-backlog" };
    }
    const local = !!request.local || isLocalLlmEndpoint(this.settings.llmEndpoint);
    return {
      retry: true,
      delayMs: getRealtimeOutlineQueuedDelayMs(session, { local }),
      reason: "failure-backoff",
    };
  }

  async executeRealtimeOutlineRequest(request) {
    const session = this.session;
    if (!session || session.id !== request.sessionId) return "";
    const local = !!request.local || isLocalLlmEndpoint(this.settings.llmEndpoint);
    const explicitTimeout = Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : 0;
    const baseTimeout = request.silent ? REALTIME_OUTLINE_SILENT_TIMEOUT_MS : REALTIME_OUTLINE_MANUAL_TIMEOUT_MS;
    const effectiveTimeout = explicitTimeout || baseTimeout;
    try {
      const result = await this.generateRealtimeOutlineForSession(session, {
        timeoutMs: local ? effectiveTimeout * 2 : effectiveTimeout,
        silent: !!request.silent,
        force: !!request.force,
        final: !!request.final,
        maxTokens: request.maxTokens || REALTIME_OUTLINE_SILENT_MAX_TOKENS,
        local,
        signal: request.signal,
      });
      markRealtimeOutlineSuccess(session);
      this.clearRecordingIssue("network");
      this.clearRecordingIssue("service");
      await this.diagnostics.logDiagnostic("info", "outline.generate_succeeded", "实时大纲生成完成", {
        silent: !!request.silent,
        force: !!request.force,
        reason: request.reason || "",
        segmentCount: session.segments.length,
        committedSegmentCount: session.realtimeOutlineSegmentCount || 0,
        remainingSegmentCount: getRealtimeOutlineNewSegmentCount(session),
        outputChars: String(session.realtimeOutline || "").length,
        window: session.realtimeOutlineWindow || null,
        mode: session.mode,
      });
      this.refreshOutlineView();
      if (request.silent && hasRealtimeOutlineRunnableBacklog(session)) {
        this.scheduleRealtimeOutline({
          delayMs: getRealtimeOutlineQueuedDelayMs(session, { local }),
          reason: "backlog",
        });
      }
      return result;
    } catch (e) {
      if (request.signal && request.signal.aborted) throw e;
      console.error("[QnALog] realtime outline failed", e);
      markRealtimeOutlineFailure(session);
      const retryInMs = request.silent && hasRealtimeOutlineRunnableBacklog(session)
        ? getRealtimeOutlineQueuedDelayMs(session, { local })
        : 0;
      await this.diagnostics.logDiagnostic("error", "outline.generate_failed", "实时大纲生成失败", {
        silent: !!request.silent,
        force: !!request.force,
        reason: request.reason || "",
        local,
        errorCount: session.realtimeOutlineFailureCount || 0,
        segmentCount: session.segments.length,
        lastOutlineSegmentCount: session.realtimeOutlineSegmentCount || 0,
        memoryChars: String(session.realtimeOutlineMemory || "").length,
        window: session.realtimeOutlineWindow || null,
        mode: session.mode,
        captureMode: session.captureMode,
        retryInMs,
        error: diagnosticError(e),
      });
      if (!request.silent) {
        this.setRecordingIssue(classifyRecordingIssue(e), {
          source: "outline",
          message: getErrorMessage(e),
          startedAtMs: getSegmentsDurationMs(session.segments),
        });
        new obsidian.Notice(`大纲生成失败：${(e && e.message) || e}`);
      } else if (Number(session.realtimeOutlineFailureCount || 0) === 1) {
        new obsidian.Notice("实时大纲暂时未更新，转写仍在继续，稍后会自动重试。", 7000);
      }
      throw e;
    }
  }

  updateMeetingWorkbenchEntry(session, entryId, updater) {
    if (!session || !entryId || typeof updater !== "function") return false;
    const current = normalizeMeetingWorkbench(session.meetingWorkbench);
    let changed = false;
    const entries = current.entries.map((item) => {
      if (item.id !== entryId) return item;
      changed = true;
      return Object.assign({}, item, updater(Object.assign({}, item)) || {});
    });
    if (!changed) return false;
    session.meetingWorkbench = normalizeMeetingWorkbench(Object.assign({}, current, { entries }));
    this.refreshOutlineView();
    return true;
  }

  buildMeetingWorkbenchInteractionContext(session, entry) {
    const atMs = Number(entry && entry.atMs) || 0;
    const before = [];
    const after = [];
    for (const s of (Array.isArray(session && session.segments) ? session.segments : [])) {
      if (!s || !s.text) continue;
      const start = Number(s.startOffsetMs) || 0;
      const end = Number(s.endOffsetMs ?? s.startOffsetMs) || start;
      const line = clipMeetingInteractionSegmentLine(`[${formatElapsed(start)}-${formatElapsed(end)}] ${String(s.text || "").trim()}`);
      if (end <= atMs) before.push(line);
      else if (start >= atMs) after.push(line);
    }
    return [
      session && session.realtimeOutline ? `【当前实时大纲】\n${clipRealtimeContextText(String(session.realtimeOutline).trim(), MEETING_INTERACTION_OUTLINE_MAX_CHARS)}` : "",
      session && session.realtimeOutlineMemory ? `【主题记忆】\n${clipRealtimeContextText(String(session.realtimeOutlineMemory).trim(), MEETING_INTERACTION_MEMORY_MAX_CHARS)}` : "",
      before.length ? `【该记录前的转写片段】\n${before.slice(-3).join("\n")}` : "",
      after.length ? `【该记录后的转写片段】\n${after.slice(0, 1).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
  }

  hasActiveRecordingOrTranscription(session) {
    if (session && Number(session.activeSegmentJobs || 0) > 0) return true;
    return false;
  }

  canRunMeetingWorkbenchInteraction(session, opts = {}) {
    if (!session) return false;
    if (opts.force) return true;
    if (this.hasActiveRecordingOrTranscription(session)) return false;
    const outlineState = this.getRealtimeOutlineCoordinatorState();
    if (
      outlineState.sessionId === session.id
      && (outlineState.phase === "running" || outlineState.phase === "scheduled")
      && hasRealtimeOutlineRunnableBacklog(session)
    ) return false;
    const rec = this.recorder;
    if (rec && rec.state === "recording") {
      const info = rec.getInfo ? rec.getInfo() : {};
      const nextCutAt = Number(rec.nextCutAtElapsed);
      if (Number.isFinite(nextCutAt)) {
        const timeToNextCut = nextCutAt - (Number(info.elapsed) || 0);
        if (timeToNextCut > 0 && timeToNextCut < 8000) return false;
      }
    }
    return true;
  }

  scheduleMeetingWorkbenchInteraction(session, entryId) {
    if (!session || !entryId) return;
    const queue = Array.isArray(session.pendingMeetingWorkbenchInteractions)
      ? session.pendingMeetingWorkbenchInteractions
      : [];
    if (!queue.includes(entryId)) queue.push(entryId);
    session.pendingMeetingWorkbenchInteractions = queue;
    if (!this.canRunMeetingWorkbenchInteraction(session)) {
      this.refreshOutlineView();
      if (this._meetingWorkbenchInteractionTimer) window.clearTimeout(this._meetingWorkbenchInteractionTimer);
      this._meetingWorkbenchInteractionTimer = window.setTimeout(() => {
        this._meetingWorkbenchInteractionTimer = 0;
        this.processPendingMeetingWorkbenchInteractions(session).catch(e => console.error("[QnALog] meeting workbench queue retry failed", e));
      }, 3000);
      return;
    }
    if (this._meetingWorkbenchInteractionTimer) window.clearTimeout(this._meetingWorkbenchInteractionTimer);
    this._meetingWorkbenchInteractionTimer = window.setTimeout(() => {
      this._meetingWorkbenchInteractionTimer = 0;
      this.processPendingMeetingWorkbenchInteractions(session).catch(e => console.error("[QnALog] meeting workbench queue failed", e));
    }, 1000);
  }

  async processPendingMeetingWorkbenchInteractions(session, opts = {}) {
    if (!session) return;
    if (!this.canRunMeetingWorkbenchInteraction(session, opts)) {
      if (!opts.force) this.scheduleMeetingWorkbenchInteraction(session, (session.pendingMeetingWorkbenchInteractions || [])[0]);
      return;
    }
    if (this._meetingWorkbenchInteractionRunning) return;
    this._meetingWorkbenchInteractionRunning = true;
    try {
      const workbench = normalizeMeetingWorkbench(session.meetingWorkbench);
      const queued = Array.isArray(session.pendingMeetingWorkbenchInteractions)
        ? session.pendingMeetingWorkbenchInteractions.slice()
        : [];
      const ids = queued.length
        ? queued
        : workbench.entries
            .filter(entry => entry.interaction && entry.interaction.kind && (!entry.interaction.status || entry.interaction.status === "pending" || entry.interaction.status === "error"))
            .map(entry => entry.id);
      session.pendingMeetingWorkbenchInteractions = [];
      for (const entryId of ids) {
        if (!opts.force && !this.canRunMeetingWorkbenchInteraction(session)) {
          const rest = ids.slice(ids.indexOf(entryId));
          session.pendingMeetingWorkbenchInteractions = Array.from(new Set([...(session.pendingMeetingWorkbenchInteractions || []), ...rest]));
          this.scheduleMeetingWorkbenchInteraction(session, entryId);
          break;
        }
        await this.processMeetingWorkbenchInteraction(session, entryId);
      }
    } finally {
      this._meetingWorkbenchInteractionRunning = false;
      // User annotations and instant answers have their own state. Whether they
      // succeed or fail, they cannot own or strand the outline cursor.
      this.ensureRealtimeOutlineProgress(session, "workbench-finished");
    }
  }

  async processMeetingWorkbenchInteraction(session, entryId) {
    if (!session || !entryId) return;
    const workbench = normalizeMeetingWorkbench(session.meetingWorkbench);
    const entry = workbench.entries.find(item => item.id === entryId);
    if (!entry || !entry.interaction || !entry.interaction.kind) return;
    // 元数据 kinds（assignee / todo）不走 AI 助理
    if (MEETING_METADATA_KINDS.has(entry.interaction.kind)) return;
    if (entry.interaction.status === "running" || entry.interaction.status === "done") return;
    this.updateMeetingWorkbenchEntry(session, entryId, (item) => ({
      interaction: Object.assign({}, item.interaction, { status: "running", error: "", updatedAt: new Date().toISOString() }),
    }));
    try {
      const latest = normalizeMeetingWorkbench(session.meetingWorkbench).entries.find(item => item.id === entryId) || entry;
      const context = this.buildMeetingWorkbenchInteractionContext(session, latest);
      const kind = latest.interaction.kind;
      const label = kind === "concept" ? "概念解释" : (kind === "question" ? "问题回答" : "重点处理");
      const system = "你是 QnALog 的会中即时助理。只回答用户这条会中记录，不改写实时大纲，不生成完整纪要。回答要短、具体、可直接挂在这条记录下面。";
      const user = [
        `会中记录时间：${formatElapsed(latest.atMs || 0)}`,
        `触发类型：${label}`,
        `用户原文：${latest.text || latest.interaction.query}`,
        "",
        context || "当前还没有足够转写上下文，请主要根据用户问题本身作答。",
        "",
        "回答规则：",
        "- #概念：给出定义、怎么使用、上下位概念、在当前语境里的意义；最多 5 条短句。",
        "- ?问题：直接回答问题，并结合当前大纲/转写上下文；最多 5 条短句。",
        "- !重点：说明这条重点为什么要保留、最终纪要应如何处理；最多 4 条短句。",
        "- 不要写“未提及”“待确认”这类空字段；信息不足时直接说“现有上下文不足以判断”。",
        "- 不要声称做了声纹识别，不要编造人物责任。",
      ].join("\n");
      const raw = await callLlm(this, system, user, {
        timeoutMs: MEETING_INTERACTION_TIMEOUT_MS,
        payload: { max_tokens: getMeetingInteractionMaxTokens(kind) },
        priority: "user",
        noRetry: true,
      });
      const response = String(raw || "").trim();
      this.updateMeetingWorkbenchEntry(session, entryId, (item) => ({
        interaction: Object.assign({}, item.interaction, {
          status: "done",
          response: response || "现有上下文不足以判断。",
          error: "",
          updatedAt: new Date().toISOString(),
        }),
      }));
    } catch (e) {
      console.error("[QnALog] meeting workbench interaction failed", e);
      this.updateMeetingWorkbenchEntry(session, entryId, (item) => ({
        interaction: Object.assign({}, item.interaction, {
          status: "error",
          error: (e && e.message) || String(e),
          updatedAt: new Date().toISOString(),
        }),
      }));
      await this.diagnostics.logDiagnostic("warn", "meeting_workbench.interaction_failed", "会中记录 AI 互动失败", {
        entryId,
        mode: session.mode,
        error: diagnosticError(e),
      });
    }
  }

  async generateRealtimeOutlineForSession(session, opts = {}) {
    if (!session) return "";
    // Strict per-session promise tail. Never bypass or reset this tail: allowing a second
    // read-modify-write after an arbitrary lock timeout can overwrite a newer outline.
    return await runInOutlineSessionTail(session, async () => {
        if (opts.signal && opts.signal.aborted) {
          const error = new Error("实时大纲生成已取消");
          error.name = "AbortError";
          throw error;
        }
        return await this._genOutlineInner(session, opts);
      });
  }
  async _genOutlineInner(session, opts = {}) {
    if (!session || !session.segments || !session.segments.length) return "";
    // 招聘需求挖掘：会中走"画像字段树覆盖扫描"，早 return，绝不进入下方 time-based 后处理
    // （parse / normalize / validate / 冻结合并对 14 维 JSON 全程有害；其它 5 个模式公共路径零改动）。
    if (session.mode === "recruit-needs") return await this.generateRecruitNeedsCoverageForSession(session, opts);
    // 招聘长期记忆只由已经提交的大纲派生。旧会话里由模型写入的 memory
    // 会在下一轮请求前被确定性重建，避免脏状态继续回喂。
    refreshProgramOwnedRecruitOutlineMemory(session);
    const processedSegmentCount = session.segments.length;
    const committedSegmentCount = Math.min(
      processedSegmentCount,
      Math.max(0, Number(session.realtimeOutlineSegmentCount) || 0)
    );
    // 只处理最早一批尚未提交的转写，并带一段只读回看保持语义连续。
    // 关键不是“从尾部截最近 N 段”，而是按顺序消费 backlog；否则窗口封顶时会直接跳过中间内容。
    const windowed = selectIncrementalRealtimeOutlineSegments(session.segments, {
      sinceCount: committedSegmentCount,
      lookbackSegments: committedSegmentCount > 0 ? REALTIME_OUTLINE_LOOKBACK_SEGMENTS : 0,
      maxSegments: REALTIME_OUTLINE_MAX_SEGMENTS,
      maxChars: REALTIME_OUTLINE_MAX_TRANSCRIPT_CHARS,
    });
    const attemptedSegmentCount = windowed.commitThroughCount;
    session.realtimeOutlineAttemptedSegmentCount = attemptedSegmentCount;
    session.realtimeOutlineAttemptedAt = new Date().toISOString();
    updateRealtimeOutlineCoverage(session, "processing", {
      attemptedSegmentCount,
      rejectedReason: "",
    });
    const workbenchSignature = "";
    const transcript = buildRealtimeOutlineTranscript(windowed.segments);
    if (windowed.newUsedCount === 0 || !transcript.trim()) {
      // 没有未提交正文时绝不调用 LLM。回看段只负责给真正的新段落补上下文，不能单独触发重复计费。
      // 失败/静音段不改变大纲，但可以安全确认，避免同一批空段反复触发。
      session.realtimeOutlineSegmentCount = advanceRealtimeOutlineCursor(
        committedSegmentCount,
        attemptedSegmentCount,
        processedSegmentCount
      );
      session.realtimeOutlineWindow = {
        usedCount: windowed.usedCount,
        newUsedCount: 0,
        omittedBeforeCount: windowed.omittedBeforeCount || 0,
        totalTextCount: windowed.totalTextCount || 0,
        approxChars: windowed.approxChars || 0,
        memoryChars: String(session.realtimeOutlineMemory || "").length,
        committedSegmentCount: attemptedSegmentCount,
        attemptedSegmentCount,
        totalSegmentCount: processedSegmentCount,
        workbenchChars: 0,
        acknowledgedWithoutLlm: true,
      };
      updateRealtimeOutlineCoverage(session, "processing", {
        attemptedSegmentCount,
        acknowledgedWithoutLlm: true,
      });
      return session.realtimeOutline || "";
    }
    const promotionQa = session.mode === "promotion-review"
      && detectPromotionReviewPhase(session.promotionReviewPhase, windowed.newSegments) === "qa";
    if (session.mode === "promotion-review") {
      session.promotionReviewPhase = promotionQa ? "qa" : "presentation";
    }
    const meta = getModeMeta(this.settings, session.mode);
    const sys = "你是结构化思考助手。任务不是复述，而是把零散的发言归并到共同的上一级概念之下。层级深度由材料决定，不预设。克制——不堆砌符号、不强加分析维度、不过度抽象。";
    const local = !!opts.local || isLocalLlmEndpoint(this.settings && this.settings.llmEndpoint);
    // 每轮只把“旧大纲 + 最早未提交转写批次”交给模型，输出仍走冻结合并。
    // 这保留了富子要点，同时不再重复付费处理整段近期窗口。
    const rollingContext = buildRollingOutlineContext(
      session.realtimeOutlineMemory,
      session.realtimeOutline,
      windowed,
      { programOwnedMemory: session.mode === "recruit" }
    );
    // 前缀缓存优化：语种指令前置进稳定块（不再追加到转写之后），转写严格放最后。
    const langInstruction = buildBriefingLanguageInstruction(this.settings);
    let user = buildOutlinePrompt(
      meta.prefix,
      session.mode,
      rollingContext + transcript,
      session.captureMode,
      langInstruction,
      { incremental: windowed.isIncremental, promotionQa }
    );
    if (opts.formatRetry) {
      user += (session.mode === "recruit" || promotionQa)
        ? [
            "",
            "【格式修复重试】",
            "上一次同一批内容因输出结构不合格被程序拒绝。请重新整理本批内容；不要解释原因。",
            promotionQa
              ? "只输出“主题 / 问题 / 回答”逐行协议，不要输出评价、追问、记忆、XML、Markdown 或编号。"
              : "只输出“主题 / 问题 / 回答 / 评价 / 追问”逐行协议，不要输出记忆、XML、Markdown 或编号。",
          ].join("\n")
        : [
            "",
            "【格式修复重试】",
            "上一次同一批内容因输出结构不合格被程序拒绝。请重新整理本批内容；不要解释原因。",
            "必须保留 <lexvoice-memory> 与 <lexvoice-outline> 两个完整标签。",
            "<lexvoice-outline> 内每个一级条目必须以 `- ` 开头，每个子要点必须以两个空格加 `- ` 开头。",
          ].join("\n");
    }
    const inputMetrics = {
      fullTranscript: false,
      systemChars: sys.length,
      userChars: user.length,
      totalChars: sys.length + user.length,
      rollingContextChars: rollingContext.length,
      transcriptChars: transcript.length,
      previousOutlineChars: clipRealtimeContextText(session.realtimeOutline, REALTIME_OUTLINE_MAX_PREVIOUS_CHARS).length,
      memoryChars: clipRealtimeContextText(session.realtimeOutlineMemory, REALTIME_OUTLINE_MAX_MEMORY_CHARS).length,
      maxTranscriptChars: REALTIME_OUTLINE_MAX_TRANSCRIPT_CHARS,
    };
    session.realtimeOutlineInput = inputMetrics;
    session.realtimeOutlineWindow = {
      usedCount: windowed.usedCount,
      newUsedCount: windowed.newUsedCount,
      omittedBeforeCount: windowed.omittedBeforeCount,
      totalTextCount: windowed.totalTextCount,
      approxChars: windowed.approxChars,
      committedSegmentCount,
      attemptedSegmentCount,
      totalSegmentCount: processedSegmentCount,
      input: inputMetrics,
      preflight: true,
    };
    // 本地档：未传 timeoutMs 时由 getRealtimeOutlineTimeoutMs 内部 ×2；
    // opts.local 由上层调用方根据 isLocalLlmEndpoint(settings.llmEndpoint) 透传进来
    const timeoutMs = Number(opts.timeoutMs) > 0
      ? Math.round(Number(opts.timeoutMs))
      : getRealtimeOutlineTimeoutMs(windowed, { local });
    const maxTokens = Math.max(600, Math.round(Number(opts.maxTokens) || (opts.final ? REALTIME_OUTLINE_FINAL_MAX_TOKENS : REALTIME_OUTLINE_SILENT_MAX_TOKENS)));
    let raw = "";
    let recruitTransportFallbackError = null;
    try {
      raw = await callLlm(this, sys, user, {
        timeoutMs,
        payload: { max_tokens: maxTokens },
        priority: opts.final ? "normal" : "background",
        noRetry: !opts.final,
        signal: opts.signal,
        // 实时大纲是"快速结构化抽取"，强制关思维链（无视全局思考档）：更快、更省，且避免推理内容/前言污染输出踩软失败。
        thinkingMode: "fast",
      });
    } catch (error) {
      if ((opts.signal && opts.signal.aborted) || (error && error.name === "AbortError") || session.mode !== "recruit") {
        throw error;
      }
      // Recruitment must keep moving even when the model endpoint times out.
      // The deterministic fallback below uses only this batch's source
      // transcript, so it is honest, reviewable, and cannot block later audio.
      recruitTransportFallbackError = error;
      try {
        await this.diagnostics.logDiagnostic("warn", "outline.recruit_transport_fallback", "招聘大纲调用失败，已改用本批原始转写继续推进", {
          segmentCount: session.segments.length,
          committedSegmentCount,
          attemptedSegmentCount,
          newUsedCount: windowed.newUsedCount,
          error: diagnosticError(error),
        });
      } catch { /* diagnostics must not block the source-transcript fallback */ }
    }
    if (opts.signal && opts.signal.aborted) {
      const error = new Error("实时大纲生成已取消");
      error.name = "AbortError";
      throw error;
    }
    const parsed = parseRealtimeOutlineResponse(raw, session.realtimeOutline, session.realtimeOutlineMemory);
    let recruitFormatRecovered = false;
    if (session.mode === "recruit" || promotionQa) {
      const recruitProtocol = parseRecruitRealtimeOutlineProtocol(raw);
      const recoveredOutline = recruitProtocol.outline;
      const parsedNodeCount = parseRealtimeOutlineStateFromMarkdown(parsed.outline).length;
      if (recoveredOutline) {
        recruitFormatRecovered = !recruitProtocol.protocolMatched
          && (parsed.outlineWasFallback || parsedNodeCount === 0);
        parsed.outline = recoveredOutline;
        parsed.outlineWasFallback = false;
      }
    }
    let repaired = repairRealtimeOutlineAnchors(parsed.outline, {
      previousOutline: session.realtimeOutline,
      anchorSources: buildRealtimeOutlineAnchorSources(windowed.newSegments),
    });
    // 时间是程序拥有的近似导航元数据，不是 LLM 输出协议。若某轮没有可用音频锚点，
    // 仍保留无时间的顶层结构，不能因时间缺失把话题降级或整轮判废。
    let result = normalizeOutlineMarkdownForDisplay(repaired.outline, { preserveUntimedTopLevel: true });
    let validation;
    if (parsed.outlineWasFallback && windowed.newUsedCount > 0) {
      validation = { ok: false, reason: "fallback_outline_only" };
    } else if (!result.trim() && windowed.newUsedCount > 0) {
      validation = { ok: false, reason: "empty_generated_outline" };
    } else {
      validation = validateRealtimeOutlineMarkdown(result, {
        previousOutline: session.realtimeOutline,
        allowUntimedTopLevel: true,
        deltaOnly: windowed.isIncremental,
        maxNewTopLevel: windowed.isIncremental ? 6 : 8,
      });
    }
    let recruitFallbackUsed = false;
    let recruitFallbackReason = "";
    if (!validation.ok && session.mode === "recruit" && windowed.newUsedCount > 0) {
      const fallbackOutline = buildRecruitRealtimeOutlineFallback(windowed.newSegments);
      const fallbackRepaired = repairRealtimeOutlineAnchors(fallbackOutline, {
        previousOutline: session.realtimeOutline,
        anchorSources: buildRealtimeOutlineAnchorSources(windowed.newSegments),
      });
      const fallbackResult = normalizeOutlineMarkdownForDisplay(
        fallbackRepaired.outline,
        { preserveUntimedTopLevel: true }
      );
      const fallbackValidation = validateRealtimeOutlineMarkdown(fallbackResult, {
        previousOutline: session.realtimeOutline,
        allowUntimedTopLevel: true,
        deltaOnly: windowed.isIncremental,
        maxNewTopLevel: windowed.isIncremental ? 6 : 8,
      });
      if (fallbackValidation.ok && fallbackResult.trim()) {
        recruitFallbackUsed = true;
        recruitFallbackReason = recruitTransportFallbackError
          ? "llm_transport_failure"
          : validation.reason;
        repaired = fallbackRepaired;
        result = fallbackResult;
        validation = fallbackValidation;
      }
    }
    if (recruitFormatRecovered || recruitFallbackUsed) {
      try {
        await this.diagnostics.logDiagnostic(
          recruitFallbackUsed ? "warn" : "info",
          recruitFallbackUsed ? "outline.recruit_fallback_committed" : "outline.recruit_format_recovered",
          recruitFallbackUsed
            ? "招聘大纲格式异常，已用本批原始转写生成待复核节点并继续处理"
            : "招聘大纲已从非标准问答结构恢复",
          {
            segmentCount: session.segments.length,
            committedSegmentCount,
            attemptedSegmentCount,
            newUsedCount: windowed.newUsedCount,
            fallbackReason: recruitFallbackReason,
          }
        );
      } catch { /* intentionally empty */ }
    }
    const existingOutlineState = normalizeRealtimeOutlineState(
      session.realtimeOutlineState,
      session.realtimeOutline,
      session.realtimeOutlineMemory
    );
    let freshOutlineNodes = parseRealtimeOutlineStateFromMarkdown(result);
    let mergedOutlineNodes = mergeStableRealtimeOutlineNodes(existingOutlineState.nodes, freshOutlineNodes);
    const existingRenderedOutline = normalizeOutlineMarkdownForDisplay(
      renderRealtimeOutlineStateMarkdown(existingOutlineState)
    );
    let mergedRenderedOutline = normalizeOutlineMarkdownForDisplay(
      renderRealtimeOutlineStateMarkdown({ version: 1, nodes: mergedOutlineNodes })
    );
    const newTranscriptChars = (Array.isArray(windowed.newSegments) ? windowed.newSegments : [])
      .reduce((sum, segment) => sum + primitiveText(segment && segment.text).trim().length, 0);
    let semanticChanged = existingRenderedOutline !== mergedRenderedOutline;
    if (
      validation.ok
      && session.mode === "recruit"
      && windowed.newUsedCount > 0
      && !semanticChanged
      && !recruitFallbackUsed
    ) {
      // A syntactically valid model response can still repeat only old topics.
      // Do not retry and later acknowledge the batch invisibly: append a
      // source-only review node so every substantive interview batch remains
      // visible and the ordered cursor can progress.
      const fallbackOutline = buildRecruitRealtimeOutlineFallback(windowed.newSegments);
      const fallbackRepaired = repairRealtimeOutlineAnchors(fallbackOutline, {
        previousOutline: session.realtimeOutline,
        anchorSources: buildRealtimeOutlineAnchorSources(windowed.newSegments),
      });
      const fallbackResult = normalizeOutlineMarkdownForDisplay(
        fallbackRepaired.outline,
        { preserveUntimedTopLevel: true }
      );
      const fallbackValidation = validateRealtimeOutlineMarkdown(fallbackResult, {
        previousOutline: session.realtimeOutline,
        allowUntimedTopLevel: true,
        deltaOnly: windowed.isIncremental,
        maxNewTopLevel: windowed.isIncremental ? 6 : 8,
      });
      if (fallbackValidation.ok && fallbackResult.trim()) {
        const fallbackNodes = parseRealtimeOutlineStateFromMarkdown(fallbackResult);
        const fallbackMergedNodes = mergeStableRealtimeOutlineNodes(existingOutlineState.nodes, fallbackNodes);
        const fallbackMergedRendered = normalizeOutlineMarkdownForDisplay(
          renderRealtimeOutlineStateMarkdown({ version: 1, nodes: fallbackMergedNodes })
        );
        if (fallbackMergedRendered !== existingRenderedOutline) {
          recruitFallbackUsed = true;
          recruitFallbackReason = "no_incremental_outline_change";
          repaired = fallbackRepaired;
          result = fallbackResult;
          validation = fallbackValidation;
          freshOutlineNodes = fallbackNodes;
          mergedOutlineNodes = fallbackMergedNodes;
          mergedRenderedOutline = fallbackMergedRendered;
          semanticChanged = true;
          try {
            await this.diagnostics.logDiagnostic("warn", "outline.recruit_no_change_fallback", "招聘大纲未体现本批新内容，已追加原始转写待复核节点", {
              segmentCount: session.segments.length,
              committedSegmentCount,
              attemptedSegmentCount,
              newUsedCount: windowed.newUsedCount,
            });
          } catch { /* diagnostics must not block the fallback commit */ }
        }
      }
    }
    const requiresSemanticDelta = !recruitFallbackUsed
      && !opts.final
      && !opts.force
      && !!windowed.isIncremental
      && windowed.newUsedCount >= REALTIME_OUTLINE_MIN_NEW_SEGMENTS
      && newTranscriptChars >= REALTIME_OUTLINE_MIN_SEMANTIC_DELTA_CHARS;
    let noChangeRetryCount = 0;
    let noChangeAcknowledged = false;
    if (validation.ok && requiresSemanticDelta && !semanticChanged) {
      const sameCommittedCursor = Number(session.realtimeOutlineNoChangeCommittedCount) === committedSegmentCount;
      noChangeRetryCount = sameCommittedCursor
        ? Math.max(0, Number(session.realtimeOutlineNoChangeRetryCount) || 0) + 1
        : 1;
      session.realtimeOutlineNoChangeCommittedCount = committedSegmentCount;
      session.realtimeOutlineNoChangeRetryCount = noChangeRetryCount;
      if (noChangeRetryCount <= REALTIME_OUTLINE_MAX_NO_CHANGE_REJECTIONS) {
        validation = { ok: false, reason: "no_incremental_outline_change" };
      } else {
        // One strict retry is enough. A genuinely repetitive discussion can
        // produce no new structure; after that retry, acknowledge the batch so
        // the ordered backlog cannot be blocked forever by this guard.
        noChangeAcknowledged = true;
      }
    } else if (semanticChanged) {
      session.realtimeOutlineNoChangeCommittedCount = -1;
      session.realtimeOutlineNoChangeRetryCount = 0;
    }
    if (!validation.ok) {
      session.realtimeOutlineWindow = {
        usedCount: windowed.usedCount,
        newUsedCount: windowed.newUsedCount,
        omittedBeforeCount: windowed.omittedBeforeCount,
        totalTextCount: windowed.totalTextCount,
        approxChars: windowed.approxChars,
        memoryChars: String(session.realtimeOutlineMemory || "").length,
        committedSegmentCount,
        attemptedSegmentCount,
        totalSegmentCount: processedSegmentCount,
        workbenchChars: workbenchSignature.length,
        rejectedReason: validation.reason,
        repairedAnchorCount: repaired.repairedCount,
        replacedModelAnchorCount: repaired.replacedCount,
        unresolvedAnchorCount: repaired.unresolvedCount,
        freshNodeCount: freshOutlineNodes.length,
        mergedNodeCount: mergedOutlineNodes.length,
        newTranscriptChars,
        semanticChanged,
        noChangeRetryCount,
        recruitFormatRecovered,
        recruitFallbackUsed,
        recruitFallbackReason,
        input: inputMetrics,
      };
      try {
        await this.diagnostics.logDiagnostic("warn", "outline.soft_rejected", "实时大纲本轮判废", {
          reason: validation.reason,
          force: !!opts.force,
          mode: session.mode,
          segmentCount: session.segments.length,
          committedSegmentCount,
          attemptedSegmentCount,
          newUsedCount: windowed.newUsedCount,
          repairedAnchorCount: repaired.repairedCount,
          replacedModelAnchorCount: repaired.replacedCount,
          unresolvedAnchorCount: repaired.unresolvedCount,
          freshNodeCount: freshOutlineNodes.length,
          mergedNodeCount: mergedOutlineNodes.length,
          newTranscriptChars,
          semanticChanged,
          noChangeRetryCount,
          hasOld: !!(session.realtimeOutline && String(session.realtimeOutline).trim()),
        });
      } catch { /* intentionally empty */ }
      updateRealtimeOutlineCoverage(session, "partial", {
        attemptedSegmentCount,
        rejectedReason: validation.reason,
      });
      // 判废只记录“尝试到哪里”，绝不推进已提交游标，也不污染主题记忆。
      // 外层统一进入退避重试；手动刷新也不能把不合格结果强行写进时间轴。
      throw new Error(`实时大纲输出格式不合格：${validation.reason}`);
    }
    // 冻结合并：本轮通过验证的增量节点并入已有状态——历史话题冻结、
    // 只给同名历史话题补充子要点，并追加真正的新话题。大纲因此全部内容稳定存在、单调增量生长；
    // 单轮模型抽风（连排 / 漏拆 / 改写）最多影响末尾，碰不到已定稿的历史。
    const mergedOutlineState = normalizeRealtimeOutlineState({
      version: 1,
      nodes: mergedOutlineNodes,
      memory: session.mode === "recruit"
        ? buildRecruitRealtimeOutlineMemory(mergedOutlineNodes, {
            maxChars: REALTIME_OUTLINE_MAX_MEMORY_CHARS,
          })
        : parsed.memory || existingOutlineState.memory || "",
    });
    session.realtimeOutline = normalizeOutlineMarkdownForDisplay(renderRealtimeOutlineStateMarkdown(mergedOutlineState));
    session.realtimeOutlineMemory = mergedOutlineState.memory;
    session.realtimeOutlineState = mergedOutlineState;
    session.realtimeOutlineSegmentCount = advanceRealtimeOutlineCursor(
      committedSegmentCount,
      attemptedSegmentCount,
      processedSegmentCount
    );
    session.realtimeOutlineAttemptedSegmentCount = attemptedSegmentCount;
    session.realtimeOutlineWorkbenchSignature = workbenchSignature;
    session.realtimeOutlineUpdatedAt = new Date().toISOString();
    updateRealtimeOutlineCoverage(session, "processing", {
      attemptedSegmentCount,
      rejectedReason: "",
      degradedBatchCount: Math.max(0, Number(session.realtimeOutlineDegradedBatchCount) || 0)
        + (recruitFallbackUsed ? 1 : 0),
    });
    if (recruitFallbackUsed) {
      session.realtimeOutlineDegradedBatchCount = Math.max(
        0,
        Number(session.realtimeOutlineDegradedBatchCount) || 0
      ) + 1;
    }
    session.realtimeOutlineWindow = {
      usedCount: windowed.usedCount,
      newUsedCount: windowed.newUsedCount,
      omittedBeforeCount: windowed.omittedBeforeCount,
      totalTextCount: windowed.totalTextCount,
      approxChars: windowed.approxChars,
      memoryChars: String(session.realtimeOutlineMemory || "").length,
      committedSegmentCount: attemptedSegmentCount,
      attemptedSegmentCount,
      totalSegmentCount: processedSegmentCount,
      hasRemainingText: windowed.hasRemainingText,
      repairedAnchorCount: repaired.repairedCount,
      replacedModelAnchorCount: repaired.replacedCount,
      restoredAnchorCount: repaired.restoredCount,
      unresolvedAnchorCount: repaired.unresolvedCount,
      freshNodeCount: freshOutlineNodes.length,
      mergedNodeCount: mergedOutlineNodes.length,
      newTranscriptChars,
      semanticChanged,
      noChangeAcknowledged,
      noChangeRetryCount,
      recruitFormatRecovered,
      recruitFallbackUsed,
      recruitFallbackReason,
      workbenchChars: workbenchSignature.length,
      input: inputMetrics,
    };
    if (noChangeAcknowledged) {
      try {
        await this.diagnostics.logDiagnostic("warn", "outline.no_change_acknowledged", "实时大纲增量连续无结构变化，已确认该批次以避免队列停滞", {
          mode: session.mode,
          committedSegmentCount,
          attemptedSegmentCount,
          newUsedCount: windowed.newUsedCount,
          newTranscriptChars,
          noChangeRetryCount,
        });
      } catch { /* intentionally empty */ }
    }
    session.realtimeOutlineNoChangeCommittedCount = -1;
    session.realtimeOutlineNoChangeRetryCount = 0;
    return session.realtimeOutline || result;
  }

  // 招聘需求挖掘 · 会中"画像字段树覆盖扫描"。每轮整场转写 → 14 维 covered/partial/missing。
  // 与 time-based 大纲物理隔离：只读/写 session.jobPortraitCoverage，绝不碰 realtimeOutline 内容。
  async generateRecruitNeedsCoverageForSession(session, opts = {}) {
    if (!session || !session.segments || !session.segments.length) return "";
    // 会后画像由 generateJobPortrait 负责。但覆盖字段树面板要消费 jobPortraitCoverage——
    // 若会中一次都没扫成（短会/录一段就停），或扫过但游标没追平最新段落（中等会扫一轮就被节流），
    // finalize 这轮是唯一兜底，必须补扫，否则字段树永久空白/停滞。仅在"已扫过且游标追平"时才省这次 LLM。
    if (opts.final
      && session.jobPortraitCoverage && session.jobPortraitCoverage.updatedAt
      && Number(session.realtimeOutlineSegmentCount || 0) >= session.segments.length) {
      return "";
    }
    // 覆盖扫描是"截至目前是否谈到过某维"的累积判断，必须看整场转写——绝不能用滑动窗口：
    // 窗口会让早段谈过的维度滑出视野、本轮被模型误判 missing → 字段树覆盖数随窗口滑动而闪回（忽有忽无）。
    // 整场转写靠前缀缓存摊薄成本（稳定指令在前、转写在后且只增不改，每轮主要增量是新段落）。
    const transcript = buildRealtimeOutlineTranscript(session.segments);
    // 即使空转写也推进节流游标，避免 shouldRunRealtimeOutline 读旧值反复触发。
    const advanceThrottleCursors = () => {
      session.realtimeOutlineSegmentCount = advanceRealtimeOutlineCursor(
        session.realtimeOutlineSegmentCount,
        session.segments.length,
        session.segments.length
      );
      session.realtimeOutlineUpdatedAt = new Date().toISOString();
    };
    if (!transcript.trim()) { advanceThrottleCursors(); return ""; }
    const local = !!opts.local || isLocalLlmEndpoint(this.settings && this.settings.llmEndpoint);
    const timeoutMs = Number(opts.timeoutMs) > 0
      ? Math.round(Number(opts.timeoutMs))
      : getRealtimeOutlineTimeoutMs({ approxChars: transcript.length }, { local });
    // 扩 schema 后每维多了 followup_question(≤30字) + vague_hits 数组，14 维累计输出更长；
    // 兜到 2000 防尾部维度被截断（REALTIME_OUTLINE_SILENT_MAX_TOKENS 现为 1600）。
    const maxTokens = Math.max(2000, REALTIME_OUTLINE_SILENT_MAX_TOKENS);
    const user = buildCoverageScanPrompt(transcript, buildBriefingLanguageInstruction(this.settings));
    const inputMetrics = {
      fullTranscript: true,
      systemChars: JOBPORTRAIT_SYSTEM_PROMPT.length,
      userChars: user.length,
      totalChars: JOBPORTRAIT_SYSTEM_PROMPT.length + user.length,
      transcriptChars: transcript.length,
      totalSegmentCount: session.segments.length,
    };
    session.realtimeOutlineInput = inputMetrics;
    session.realtimeOutlineWindow = {
      kind: "recruit-needs-full-coverage",
      usedCount: session.segments.length,
      newUsedCount: Math.max(0, session.segments.length - Math.max(0, Number(session.realtimeOutlineSegmentCount) || 0)),
      totalSegmentCount: session.segments.length,
      approxChars: transcript.length,
      input: inputMetrics,
      preflight: true,
    };
    const raw = await callLlm(this, JOBPORTRAIT_SYSTEM_PROMPT, user, {
      timeoutMs,
      payload: { max_tokens: maxTokens },
      priority: "background",
      noRetry: true,
      signal: opts.signal,
    });
    // 早期轮(转写还短、模型最易误判 covered)不冻结，让误判可自我纠正；积累够了再启用单调累积防闪回。
    // 闪回的真凶(滑动窗口)已改为喂整场，所以早期放开纠正不会让闪回回归。
    const allowFreeze = (transcript.length >= 1500) || ((session.segments && session.segments.length) || 0) >= 5;
    const coverage = parseCoverageScanModel(raw, session.jobPortraitCoverage, allowFreeze);
    coverage.segmentCount = session.segments.length;
    session.jobPortraitCoverage = coverage;
    // 复用 time-based 的节流游标（shouldRunRealtimeOutline 读这俩判 30s 间隔/新增段落）；
    // 这俩字段对 recruit-needs 渲染无影响（渲染读 jobPortraitCoverage），写了无副作用。
    advanceThrottleCursors();
    return "";
  }

  async ensureRealtimeOutlineForFinalNote(session) {
    // recruit-needs 的覆盖字段树是该模式的核心交付，不受面向其它 5 个模式的"实时大纲"全局开关连坐。
    if (!this.settings.enableRealtimeOutline && (!session || session.mode !== "recruit-needs")) return;
    if (!session || !session.segments || !session.segments.length) return;
    const hasTranscript = session.segments.some(s => s && s.text && String(s.text).trim());
    if (!hasTranscript) return;
    if (isRealtimeOutlineCurrent(session)) {
      updateRealtimeOutlineCoverage(session, "complete");
      return;
    }

    // 招聘需求挖掘使用独立的整场 coverage 扫描，不参与普通时间轴的分批追赶。
    if (session.mode === "recruit-needs") {
      try {
        await this.generateRealtimeOutlineForSession(session, {
          timeoutMs: REALTIME_OUTLINE_FINAL_TIMEOUT_MS,
          force: true,
          final: true,
          maxTokens: REALTIME_OUTLINE_FINAL_MAX_TOKENS,
        });
        markRealtimeOutlineSuccess(session);
      } catch (error) {
        markRealtimeOutlineFailure(session);
        console.error("[QnALog] final recruit-needs coverage failed", error);
        await this.diagnostics.logDiagnostic("warn", "outline.final_generate_failed", "最终纪要写入前生成岗位画像覆盖失败", {
          segmentCount: session.segments.length,
          mode: session.mode,
          captureMode: session.captureMode,
          error: diagnosticError(error),
        });
      }
      return;
    }

    const totalSegmentCount = session.segments.length;
    const initialCommittedCount = Math.max(0, Number(session.realtimeOutlineSegmentCount) || 0);
    const remainingSegmentCount = Math.max(0, totalSegmentCount - initialCommittedCount);
    // 正常一批最多消费 9 个新分段（另留 1 个回看段）。按每批至少 4
    // 个新分段保守估算，再加两批余量；同时硬封顶 16，避免异常模型放大费用。
    const maxBatches = Math.min(
      REALTIME_OUTLINE_FINAL_MAX_BATCHES,
      Math.max(1, Math.ceil(remainingSegmentCount / 4) + 2)
    );
    updateRealtimeOutlineCoverage(session, "processing");

    const drainResult = await drainRealtimeOutlineBacklog({
      totalSegmentCount,
      getCommittedCount: () => Math.max(0, Number(session.realtimeOutlineSegmentCount) || 0),
      isComplete: () => isRealtimeOutlineCurrent(session),
      maxAttemptsPerBatch: REALTIME_OUTLINE_FINAL_BATCH_MAX_ATTEMPTS,
      maxBatches,
      shouldRetryAttempt: ({ error }) => /实时大纲输出格式不合格/.test(
        String(error && error.message ? error.message : error || "")
      ),
      runBatch: async ({ attemptIndex }) => {
        await this.generateRealtimeOutlineForSession(session, {
          timeoutMs: REALTIME_OUTLINE_FINAL_TIMEOUT_MS,
          force: true,
          final: true,
          formatRetry: attemptIndex > 0,
          maxTokens: REALTIME_OUTLINE_FINAL_MAX_TOKENS,
        });
      },
      onAttemptFailed: async ({ batchIndex, attemptIndex, beforeCommittedCount, error }) => {
        try {
          await this.diagnostics.logDiagnostic("warn", "outline.final_batch_retry", "最终大纲批次失败", {
            batchIndex,
            attempt: attemptIndex + 1,
            maxAttempts: REALTIME_OUTLINE_FINAL_BATCH_MAX_ATTEMPTS,
            segmentCount: totalSegmentCount,
            committedSegmentCount: beforeCommittedCount,
            willRetry: attemptIndex + 1 < REALTIME_OUTLINE_FINAL_BATCH_MAX_ATTEMPTS
              && /实时大纲输出格式不合格/.test(String(error && error.message ? error.message : error || "")),
            mode: session.mode,
            error: diagnosticError(error),
          });
        } catch { /* diagnostics must never interrupt finalization */ }
      },
      onBatchCompleted: async ({ committedSegmentCount }) => {
        const coveragePercent = totalSegmentCount
          ? Math.round((committedSegmentCount / totalSegmentCount) * 100)
          : 0;
        updateRealtimeOutlineCoverage(session, "processing");
        this.setSessionWorkProgress(session, {
          stage: "outline",
          label: `补齐大纲 ${committedSegmentCount}/${totalSegmentCount} 段`,
          percent: Math.min(58, 32 + Math.round(coveragePercent * 0.26)),
          detail: `已覆盖 ${coveragePercent}% 的转写内容`,
        });
        this.refreshOutlineView();
      },
    });

    if (drainResult.complete) {
      markRealtimeOutlineSuccess(session);
      updateRealtimeOutlineCoverage(session, "complete", {
        completedBatches: drainResult.completedBatches,
        retryCount: drainResult.retryCount,
      });
      await this.diagnostics.logDiagnostic("info", "outline.final_completed", "最终大纲已覆盖全部转写", {
        segmentCount: totalSegmentCount,
        committedSegmentCount: drainResult.committedSegmentCount,
        completedBatches: drainResult.completedBatches,
        attemptCount: drainResult.attemptCount,
        retryCount: drainResult.retryCount,
        mode: session.mode,
      });
      return drainResult;
    }

    markRealtimeOutlineFailure(session);
    updateRealtimeOutlineCoverage(session, "partial", {
      stopReason: drainResult.reason,
      completedBatches: drainResult.completedBatches,
      retryCount: drainResult.retryCount,
      error: drainResult.lastError ? diagnosticError(drainResult.lastError) : null,
    });
    this.setSessionWorkProgress(session, {
      stage: "outline",
      label: "大纲未完全补齐",
      percent: 58,
      detail: `已覆盖 ${drainResult.committedSegmentCount}/${totalSegmentCount} 段；最终纪要仍会使用全部转写`,
    });
    new obsidian.Notice(
      `大纲仅覆盖 ${drainResult.committedSegmentCount}/${totalSegmentCount} 段，最终纪要将继续基于完整转写生成。`
    );
    console.error("[QnALog] final realtime outline incomplete", drainResult.lastError);
    await this.diagnostics.logDiagnostic("warn", "outline.final_incomplete", "最终大纲未覆盖全部转写", {
      segmentCount: totalSegmentCount,
      committedSegmentCount: drainResult.committedSegmentCount,
      mode: session.mode,
      captureMode: session.captureMode,
      stopReason: drainResult.reason,
      completedBatches: drainResult.completedBatches,
      attemptCount: drainResult.attemptCount,
      retryCount: drainResult.retryCount,
      error: drainResult.lastError ? diagnosticError(drainResult.lastError) : null,
    });
    return drainResult;
  }

  async openOutlineView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_OUTLINE);
    if (existing.length) {
      void this.app.workspace.revealLeaf(existing[0]);
      this.syncBubbleVisibility();
      return;
    }
    const leaf = isLexVoiceMobileRuntime()
      ? this.app.workspace.getLeaf(true)
      : (this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true));
    await leaf.setViewState({ type: VIEW_TYPE_OUTLINE, active: true });
    void this.app.workspace.revealLeaf(leaf);
    this.syncBubbleVisibility();
  }

  getMinutesKanbanItems() {
    const canvasFiles = this.app.vault.getFiles().filter((file) => file.extension === "canvas");
    const root = obsidian.normalizePath(this.settings.mdFolder || DEFAULT_SETTINGS.mdFolder);
    return getRecentNotes(this, Number.MAX_SAFE_INTEGER).filter((item) => {
      const path = obsidian.normalizePath(item.file.path);
      return path === root || path.startsWith(`${root}/`);
    }).map((item) => {
      const notePath = obsidian.normalizePath(item.file.path);
      const expected = obsidian.normalizePath(getSemanticCanvasPath(notePath));
      const prefix = `${item.file.basename} · 语义图`;
      const associatedCanvases = canvasFiles.filter((file) => (
        obsidian.normalizePath(file.path) === expected
        || (file.parent && item.file.parent
          && obsidian.normalizePath(file.parent.path) === obsidian.normalizePath(item.file.parent.path)
          && file.basename.startsWith(prefix))
      ));
      const meta = getModeMeta(this.settings, item.mode) || MODE_META.off;
      return {
        file: item.file,
        title: item.title || item.file.basename,
        mode: item.mode,
        modeLabel: meta.prefix || "纪要",
        icon: meta.icon || "file-text",
        folderPath: item.folderPath || obsidian.normalizePath(this.settings.mdFolder || DEFAULT_SETTINGS.mdFolder),
        timeLabel: item.displayTime || "",
        durationLabel: item.durationLabel || "",
        canvasFiles: associatedCanvases,
      };
    });
  }

  async createMinutesKanbanFolder(rawName) {
    const name = sanitizeFilename(String(rawName || "").replace(/[\\/]+/g, " ")).trim();
    if (!name) throw new Error("请输入有效的文件夹名称");
    const root = obsidian.normalizePath(this.settings.mdFolder || DEFAULT_SETTINGS.mdFolder);
    const path = obsidian.normalizePath(`${root}/${name}`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && !(existing instanceof obsidian.TFolder)) throw new Error("同名文件已存在");
    if (!existing) await ensureVaultFolder(this.app, path);
    return path;
  }

  async moveMinutesKanbanItem(item, rawFolderPath) {
    const file = item && item.file;
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") throw new Error("纪要文件不存在");
    const root = obsidian.normalizePath(this.settings.mdFolder || DEFAULT_SETTINGS.mdFolder);
    const folderPath = obsidian.normalizePath(rawFolderPath || root);
    if (!(folderPath === root || folderPath.startsWith(`${root}/`))) throw new Error("目标分组不在纪要目录内");
    await ensureVaultFolder(this.app, folderPath);
    const currentFolder = file.parent ? obsidian.normalizePath(file.parent.path) : "";
    if (currentFolder === folderPath) return;

    const oldNotePath = obsidian.normalizePath(file.path);
    const oldBase = file.basename;
    const canvasSnapshots = [];
    for (const canvasFile of Array.isArray(item.canvasFiles) ? item.canvasFiles : []) {
      if (!(canvasFile instanceof obsidian.TFile) || canvasFile.extension !== "canvas") continue;
      let content = "";
      try { content = await this.app.vault.cachedRead(canvasFile); } catch { /* keep moving the note */ }
      canvasSnapshots.push({ file: canvasFile, content });
    }

    const noteTarget = this.getAvailableMarkdownPath(`${folderPath}/${file.name}`, oldNotePath);
    if (!noteTarget) throw new Error("无法生成可用的目标文件名");
    await this.app.fileManager.renameFile(file, noteTarget);
    const movedNote = this.app.vault.getAbstractFileByPath(noteTarget);
    const newBase = movedNote instanceof obsidian.TFile
      ? movedNote.basename
      : String(noteTarget.split("/").pop() || oldBase).replace(/\.md$/i, "");

    for (const snapshot of canvasSnapshots) {
      const suffix = snapshot.file.basename.startsWith(oldBase)
        ? snapshot.file.basename.slice(oldBase.length)
        : " · 语义图";
      const canvasTarget = findAvailableVaultPath(this.app, `${folderPath}/${newBase}${suffix}.canvas`);
      if (!canvasTarget) continue;
      try {
        await this.app.fileManager.renameFile(snapshot.file, canvasTarget);
        const movedCanvas = this.app.vault.getAbstractFileByPath(canvasTarget);
        if (!(movedCanvas instanceof obsidian.TFile) || !snapshot.content) continue;
        const document = JSON.parse(snapshot.content);
        if (document && typeof document === "object" && document.lexvoiceSemantic && typeof document.lexvoiceSemantic === "object") {
          document.lexvoiceSemantic.sourcePath = noteTarget;
          await this.app.vault.modify(movedCanvas, JSON.stringify(document, null, 2));
        }
      } catch (error) {
        console.warn("[QnALog] move associated semantic canvas failed", error);
      }
    }
  }

  async openMinutesKanban() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_MINUTES_KANBAN);
    if (existing.length) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_MINUTES_KANBAN, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async openPromotionReviewContextInline() {
    if (!isRecruitFeatureUnlocked(this.settings)) {
      new obsidian.Notice("晋升评审功能未解锁");
      return;
    }
    await this.openOutlineView();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OUTLINE);
    const view = leaves.length ? leaves[0].view : null;
    if (view && typeof view.render === "function") { view._promotionReviewEditing = true; view.render(); }
  }

  // 打开大纲面板并进招聘上下文「内联编辑」视图（替掉原来的 flow:"settings" 弹窗）。
  async openRecruitContextInline() {
    if (!isRecruitFeatureUnlocked(this.settings)) { new obsidian.Notice("招聘评估功能未解锁"); return; }
    await this.openOutlineView();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OUTLINE);
    const view = leaves.length ? leaves[0].view : null;
    if (view && typeof view.render === "function") { view._recruitEditing = true; view.render(); }
  }

  // 判断实时纪要面板是否真正在 viewport 中可见
  // 三种"不可见"情况都要识别：
  //   1. leaf 不存在
  //   2. leaf 存在但所在侧边栏被折叠 (rightSplit.collapsed)
  //   3. leaf 存在且侧边栏展开，但用户切到了同侧边栏的其他 tab（leaf 未激活）
  isOutlineVisible() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OUTLINE);
    if (!leaves.length) return false;
    for (const leaf of leaves) {
      const view = leaf.view;
      if (!view) continue;
      const el = view.containerEl;
      if (!el) continue;
      // 真正的可见性判断：元素被渲染且占有空间
      // 任何情况下被隐藏（display:none / 0 高度 / 0 宽度）都返回 0
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  }

  // 停靠式悬浮窗：只受总开关控制，不再依赖实时面板或侧边栏是否可见。
  syncBubbleVisibility() {
    if (!this.bubble) return;
    const visible = !!this.settings.showFloatingBall;
    if (visible && !this.bubble.wrapEl) {
      this.bubble.mount(this.ribbonEl);
    } else if (!visible && this.bubble.wrapEl) {
      this.bubble.unmount();
    } else if (visible && this.bubble.wrapEl) {
      this.bubble.show();
      this.bubble.keepInViewport();
      this.bubble.updateDockTail();
    }
  }

  async toggleRecording() {
    if (this.recorder.state === "idle") await this.startRecording();
    else await this.stopRecording();
  }

  async getContinuationTargetInfo(file) {
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") {
      throw new Error("目标不是 Markdown 纪要");
    }
    const content = await this.app.vault.read(file);
    const segments = extractLexVoiceTranscriptSegments(content);
    if (!segments.length) {
      throw new Error("这篇纪要里没有可续录合并的原始转写分段");
    }
    const frontmatter = ((this.app.metadataCache.getFileCache(file) || {}).frontmatter) || {};
    const mode = this.noteWriter.detectModeFromMarkdown(file) || getEffectivePolishMode(this.settings, this.settings.polishMode);
    const normalized = normalizeSegmentsForMergedNote(segments, 0, 0, file);
    const durationMs = getLexVoiceSegmentsDurationMs(normalized) || getLexVoiceDurationMs(content);
    return {
      file,
      content,
      mode,
      segments: normalized,
      durationMs,
      startedAt: inferLexVoiceNoteStartedAtIso(file, frontmatter),
      frontmatter,
    };
  }

  async startRecording(options = {}) {
    if (this.recorder.state !== "idle") {
      new obsidian.Notice("当前已有录音进行中，请先停止后再继续录音。", 5000);
      return;
    }
    const appendTargetFile = options && options.appendToFile instanceof obsidian.TFile ? options.appendToFile : null;
    let continuationInfo = null;
    if (appendTargetFile) {
      try {
        continuationInfo = await this.getContinuationTargetInfo(appendTargetFile);
      } catch (e) {
        console.error("[QnALog] prepare continuation target failed", e);
        new obsidian.Notice(`无法继续录到这篇纪要：${(e && e.message) || e}`, 8000);
        return;
      }
    }
    // 招聘面试模式：先弹 RecruitContextModal 让用户注入 JD/简历，再开始录音
    const mode = continuationInfo && continuationInfo.mode
      ? continuationInfo.mode
      : getEffectivePolishMode(this.settings, this._oneShotPolishMode || this.settings.polishMode);
    if (mode === "promotion-review") {
      const savedContext = normalizePromotionReviewContext(this.settings.promotionReviewContext || {});
      if (!savedContext.requirements || !savedContext.nominationMaterial || !savedContext.preReview) {
        new obsidian.Notice("请先填写任职要求和晋升提名材料，并生成晋升初审。", 6000);
        await this.openPromotionReviewContextInline();
        return;
      }
      this._currentPromotionReviewContext = savedContext;
    }
    if (mode === "recruit") {
      // 录音前不再弹窗：直接用已存的招聘上下文开录。要改上下文（尤其每场现导当场候选人简历），
      // 事先点对象卡片的铅笔进内联编辑即可——录音入口不再打断。
      const savedCtx = normalizeRecruitContext(this.settings.recruitContext);
      this._currentRecruitContext = hasRecruitContextContent(savedCtx) ? savedCtx : null;
    }
    try {
      this.clearRecordingIssue();
      await ensureVaultFolder(this.app, this.settings.audioFolder);
      await ensureVaultFolder(this.app, this.settings.mdFolder);
      const moment = window.moment;
      const startedAt = moment();
      const sessionStamp = startedAt.format("YYYYMMDD-HHmmss");
      const mdName = startedAt.format(this.settings.noteFileNameFormatNew);
      const mdPath = continuationInfo
        ? obsidian.normalizePath(continuationInfo.file.path)
        : obsidian.normalizePath(`${this.settings.mdFolder}/${mdName}.md`);

      const meta = getModeMeta(this.settings, mode);
      let recordingInterviewBrief = "";
      if (!continuationInfo && mode === "recruit" && this._currentRecruitContext && (this._currentRecruitContext.jd || this._currentRecruitContext.resume)) {
        recordingInterviewBrief = String(this._currentRecruitContext.interviewBrief || "").trim();
      }
      const oneShotMode = this._oneShotCaptureMode;
      const requestedCaptureMode = oneShotMode || this.settings.captureMode || "mic";
      const captureMode = resolveRuntimeAudioInputMode(requestedCaptureMode);
      const forcedMobileMic = isLexVoiceMobileRuntime() && normalizeAudioInputMode(requestedCaptureMode) !== "mic";
      this.session = {
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
        realtimeOutline: "",
        realtimeOutlineState: { version: 1, nodes: [], memory: "" },
        realtimeOutlineMemory: "",
        realtimeOutlineSegmentCount: 0,
        realtimeOutlineAttemptedSegmentCount: 0,
        realtimeOutlineAttemptedAt: "",
        realtimeOutlineWorkbenchSignature: "",
        realtimeOutlineFailureCount: 0,
        realtimeOutlineNextAllowedAt: 0,
        realtimeOutlineNoChangeCommittedCount: -1,
        realtimeOutlineNoChangeRetryCount: 0,
        interviewBrief: recordingInterviewBrief,
        promotionReviewContext: this._currentPromotionReviewContext || null,
        promotionReviewPhase: "presentation",
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
        recruitContext: this._currentRecruitContext || null,
        captureMode,
        audioChannelCount: 1,
        audioChannelMaxCount: 1,
        audioChannelLabel: "",
        audioChannelMode: normalizeAudioChannelMode(this.settings.audioChannelMode),
        audioChannelRuntimeMode: "mono",
        speakerChannels: {},
        channelSeparationMode: "single",
        meetingWorkbench: { notes: "", draft: "", materials: [], entries: [] },
      };
      this.setSessionWorkProgress(this.session, {
        stage: "recording",
        label: "录音中",
        percent: null,
        detail: "正在采集音频，分段后会自动转写",
      });
      this._currentRecruitContext = null;
      this._currentPromotionReviewContext = null;

      const activeProviderId = this.settings.activeTranscribeProvider || "siliconflow";
      const activeProvider = (this.settings.transcribeProviders || {})[activeProviderId] || {};
      const activeProfile = this.getActiveTranscribeProfile();
      const isStreaming = activeProfile && activeProfile.transcribeMode === "streaming";
      const titleLine = continuationInfo
        ? `## 续录 ${startedAt.format("YYYY-MM-DD HH:mm")} · ${meta.prefix}（录音中…）`
        : `# ${startedAt.format("YYYY-MM-DD HH:mm")} · ${meta.prefix}（录音中…）`;
      const interviewBriefBlock = (!continuationInfo && recordingInterviewBrief)
        ? renderRecordingInterviewBriefBlock(this.session.id, recordingInterviewBrief).trimEnd()
        : null;
      const promotionPreReviewBlock = (!continuationInfo && mode === "promotion-review" && this.session.promotionReviewContext && this.session.promotionReviewContext.preReview)
        ? renderRecordingPromotionReviewBlock(this.session.id, this.session.promotionReviewContext.preReview).trimEnd()
        : null;
      const header = [
        continuationInfo ? "" : null,
        titleLine,
        "",
        `<!-- lexvoice-session:${this.session.id} -->`,
        promotionPreReviewBlock,
        interviewBriefBlock,
        `<!-- lexvoice-segments-start:${this.session.id} -->`,
        `<!-- lexvoice-segments-end:${this.session.id} -->`,
        "",
      ].filter(v => v !== null).join("\n");
      await this.noteWriter.appendToNote(mdPath, header);
      if (!continuationInfo && mode === "recruit" && this.session && this.session.recruitContext && !recordingInterviewBrief && (this.session.recruitContext.jd || this.session.recruitContext.resume)) {
        this.recruit.scheduleRecruitInterviewBriefBackground(this.session);
      }

      const requiresWholeSession = !!(activeProfile && activeProfile.requiresWholeSession)
        || isSpeakerDiarizationProvider(activeProvider);
      const segmentDurationMs = isStreaming || requiresWholeSession
        ? 0
        : (this.settings.enableInterimOutput
          ? Math.max(30, Math.floor(this.settings.segmentIntervalMinutes * 60)) * 1000
          : 0);

      const sessionRef = this.session;
      sessionRef.captureMode = captureMode;
      this._oneShotCaptureMode = null;
      if (!oneShotMode && this.settings.captureMode !== captureMode) {
        this.settings.captureMode = captureMode;
        await this.saveSettings();
      }

      let onStreamReady = null;
      if (isStreaming && isLexVoiceMobileRuntime()) {
        // 移动端无 Node WebSocket（设不了鉴权头），流式必败：不建流式客户端，提前明示。
        // 录音照常进行，停止时走既有的「流式连接未建立」兜底（音频保留）。
        new obsidian.Notice("移动端暂不支持流式转写；本次录音会保留音频，请在桌面端使用流式，或切换到分段转写服务。", 9000);
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
              new obsidian.Notice(`流式转写错误：${(e && e.message) || e}`);
            },
            onClosed: (info) => {
              if (info && info.translatedText) sessionRef.streamingTranslatedText = info.translatedText;
              if (info && info.sourceText) sessionRef.streamingSourceText = info.sourceText;
            },
          });
          sessionRef.streamingClient = client;
          sessionRef.scheduleStreamingNoteUpdate = this.makeStreamingNoteUpdater(sessionRef);
          try {
            await client.connect();
          } catch (e) {
            console.error("[QnALog] streaming connect failed", e);
            this.setRecordingIssue(classifyRecordingIssue(e), {
              source: "streaming-asr",
              message: getErrorMessage(e),
            });
            new obsidian.Notice(`流式转写连接失败：${(e && e.message) || e}`);
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
        sessionRef.audioChannelMode = normalizeAudioChannelMode(channelInfo && channelInfo.channelMode || this.settings.audioChannelMode);
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
          new obsidian.Notice("实时转写暂不区分说话人；如需区分，请在导入音频时启用说话人识别。", 9000);
        }
        if (providerStreamReady) await providerStreamReady(mediaStream);
      };

      await this.recorder.start({
        segmentDurationMs,
        quickCutMarksMs: segmentDurationMs > 0 ? QUICK_INTERIM_CUTS_MS : [],
        captureMode,
        onSegment: (seg) => this.handleSegment(sessionRef, seg),
        onStreamReady,
      });
      if (this.settings.autoOpenOutlineOnRecord) {
        try { await this.openOutlineView(); } catch (e) { console.error("[QnALog] auto-open outline failed", e); }
      }
      const modeLabel = audioInputModeLabel(captureMode);
      const noticeText = isStreaming
        ? `录音中（${modeLabel}），${activeProfile.title || "流式服务"} 实时转写中`
        : requiresWholeSession
          ? `录音中（${modeLabel}），停止后统一转写并确认说话人`
        : (this.settings.enableInterimOutput
          ? `录音中（${modeLabel}），启动期快速出片，之后每 ${this.settings.segmentIntervalMinutes} 分钟即时转写`
          : `录音中（${modeLabel}），停止时统一处理`);
      new obsidian.Notice(noticeText);
      if (continuationInfo) {
        new obsidian.Notice(`已开始续录到「${continuationInfo.file.basename}」；停止后会与原纪要重新合并。`, 8000);
      }
      if (forcedMobileMic) {
        new obsidian.Notice("移动端暂只支持麦克风录音；电脑音频/虚拟声卡请在桌面端使用。", 8000);
      }
      if (isLexVoiceMobileRuntime()) {
        new obsidian.Notice("手机端录音时请保持 Obsidian 在前台，锁屏或切后台可能中断录音。", 8000);
      }
    } catch (e) {
      console.error(e);
      await this.diagnostics.logDiagnostic("error", "recording.start_failed", "无法开始录音", {
        captureMode: this.settings.captureMode,
        requestedMode: this._oneShotCaptureMode || "",
        error: diagnosticError(e),
      });
      new obsidian.Notice(`无法开始录音：${(e && e.message) || e}`);
      // 清理半初始化状态：acquireStream 抛错(OverconstrainedError 等)后 this.session 已赋值、"（录音中…）"
      // 占位笔记已写，若不清理会残留僵尸会话、笔记永远卡在"录音中…"。
      try { if (this.recorder && this.recorder.state !== "idle") await this.recorder.stop(); } catch { /* intentionally empty */ }
      try { if (this.recorder && typeof this.recorder.releaseStream === "function") this.recorder.releaseStream(); } catch { /* intentionally empty */ }
      const failedSession = this.session;
      this.session = null;
      this._oneShotCaptureMode = null;
      try { if (failedSession) await this.noteWriter.removeEmptySessionBlock(failedSession); } catch { /* intentionally empty */ }
      try { this.refreshOutlineView(); } catch { /* intentionally empty */ }
    }
  }

  async stopRecording() {
    if (this.recorder.state === "idle") return;
    new obsidian.Notice("⏹ 已请求停止，处理最后一段…");
    await this.recorder.stop();
    this.clearRecordingIssue();
  }

  shouldFilterShortRecording(session, seg) {
    if (!session || !seg || !seg.isFinal) return false;
    if (this.settings.filterShortRecordings === false) return false;
    if (session.segments && session.segments.length) return false;
    const totalMs = Math.max(0, Number(seg.endOffsetMs) || 0);
    return totalMs < SHORT_RECORDING_FILTER_MS;
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
    try { await this.removeLiveTranscriptBlock(session.mdPath, session.id); } catch { /* intentionally empty */ }
  }

  async discardFilteredShortSession(session) {
    await this.closeStreamingForDiscard(session);
    const file = this.app.vault.getAbstractFileByPath(session.mdPath);
    if (!(file instanceof obsidian.TFile)) return;
    const cur = await this.app.vault.read(file);
    const sessMarker = `<!-- lexvoice-session:${session.id} -->`;
    const endMarker = `<!-- lexvoice-segments-end:${session.id} -->`;
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
    if (!next.trim()) await this.app.fileManager.trashFile(file);
    else if (next !== cur) await this.app.vault.modify(file, next);
  }

  setSessionWorkProgress(session, patch) {
    if (!session) return;
    session.workProgress = Object.assign({}, session.workProgress || {}, patch || {}, {
      updatedAt: new Date().toISOString(),
    });
    if (this.tasks._importBusy
      && this.tasks._importBusy.workflow === "audio-import"
      && String(this.tasks._importBusy.sessionId || "") === String(session.id || "")) {
      const stage = audioImportStageFromWorkProgress(session.workProgress.stage);
      this.tasks.updateImportActivity({
        phase: stage,
        organizeLabel: stage === "organize" ? String(session.workProgress.label || "AI 整理") : this.tasks._importBusy.organizeLabel,
        organizeDetail: stage === "organize" ? String(session.workProgress.detail || "") : this.tasks._importBusy.organizeDetail,
        organizePercent: stage === "organize" ? Number(session.workProgress.percent) || 0 : this.tasks._importBusy.organizePercent,
        writeLabel: stage === "write" ? String(session.workProgress.label || "写入纪要") : this.tasks._importBusy.writeLabel,
        writeDetail: stage === "write" ? String(session.workProgress.detail || "") : this.tasks._importBusy.writeDetail,
        writePercent: stage === "write" ? Number(session.workProgress.percent) || 0 : this.tasks._importBusy.writePercent,
      });
    }
    try { this.refreshOutlineView(); } catch { /* intentionally empty */ }
  }

  clearSessionWorkProgress(session) {
    if (!session) return;
    delete session.workProgress;
    try { this.refreshOutlineView(); } catch { /* intentionally empty */ }
  }  getLiveAsrJobs(session) {
    if (!session) return new Map();
    if (!(session.liveAsrJobs instanceof Map)) session.liveAsrJobs = new Map();
    return session.liveAsrJobs;
  }

  getRecorderBufferSummary() {
    const sumBytes = (items) => (Array.isArray(items) ? items : []).reduce((total, item) => total + Math.max(0, Number(item && item.size) || 0), 0);
    const masterChunks = this.recorder && Array.isArray(this.recorder.masterChunks) ? this.recorder.masterChunks : [];
    const segmentChunks = this.recorder && Array.isArray(this.recorder.chunks) ? this.recorder.chunks : [];
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
      void this.diagnostics.logDiagnostic(nextLevel === "normal" ? "info" : "warn", "asr.live_backlog_changed", "实时转写积压状态变化", {
        reason,
        previousLevel,
        nextLevel,
        ...summary,
        ...recorderBuffer,
      });
      if (nextLevel === "warning" && !session._asrBacklogWarningNotified) {
        session._asrBacklogWarningNotified = true;
        new obsidian.Notice("转写速度暂时慢于录音，音频分段已安全写入缓存，QnALog 会继续处理。", 8000);
      }
      if (nextLevel === "critical" && !session._asrBacklogCriticalNotified) {
        session._asrBacklogCriticalNotified = true;
        new obsidian.Notice("转写积压较多，后续分段已转入后台队列；录音不会中断。", 10000);
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
    const segmentAudioName = `lex-${session.sessionStamp}-seg${pad(segNumber)}.${ext}`;
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
      audioChannelMode: normalizeAudioChannelMode(session.audioChannelMode || this.settings.audioChannelMode),
      audioChannelCount: session.captureMode === "mic" ? Math.max(1, Number(session.audioChannelCount) || 1) : 1,
      audioChannelRuntimeMode: session.audioChannelRuntimeMode || initialAudioChannelRuntimeMode(
        session.audioChannelMode || this.settings.audioChannelMode,
        session.audioChannelCount,
      ),
      lastError: "",
    }, patch || {});
  }

  async registerLiveSegmentQueueTask(session, descriptor) {
    const task = await this.queue.add(this.buildLiveSegmentQueueTask(session, descriptor));
    descriptor.queueTaskId = task.id;
    return task;
  }

  async keepLiveSegmentQueueTaskForRetry(session, descriptor, error) {
    const message = getErrorMessage(error);
    const task = await this.queue.add(this.buildLiveSegmentQueueTask(session, descriptor, {
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
    const task = this.queue.tasks.find((item) => item && item.id === taskId);
    if (!task || task.status !== LIVE_ASR_TASK_STATUS) return;
    await this.queue.update(taskId, { status: "running", lastError: "" });
  }

  async removeLiveSegmentQueueTask(descriptor) {
    const taskId = descriptor && descriptor.queueTaskId;
    if (!taskId || !this.queue.tasks.some((task) => task && task.id === taskId)) return;
    await this.queue.remove(taskId);
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
    void this.diagnostics.logDiagnostic("info", "asr.live_segment_enqueued", "录音分段已进入磁盘转写队列", {
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
        await this.app.vault.adapter.writeBinary(descriptor.segmentAudioPath, ab);
      } catch (e) {
        const job = jobs.get(descriptor.jobId);
        if (job) job.state = "queued";
        this.updateLiveAsrBacklogPolicy(session, "persist-failed");
        await this.diagnostics.logDiagnostic("error", "asr.segment_cache_write_failed", "录音分段写入缓存失败，将临时保留该段内存兜底", {
          segmentIndex: descriptor.segmentIndex,
          durationMs: descriptor.durationMs,
          sizeBytes: descriptor.blobSize,
          error: diagnosticError(e),
        });
        if (!session._segmentCacheWriteFailureNotified) {
          session._segmentCacheWriteFailureNotified = true;
          new obsidian.Notice("录音分段缓存写入失败，本段将临时保留在内存中继续处理。请检查知识库磁盘空间。", 10000);
        }
        return { persisted: false, fallbackBlob: blob, error: e };
      }
      let queueTask = null;
      try {
        // 音频一旦安全落盘，就立即登记任务。即使 Obsidian 此后崩溃，重启时也能从路径恢复。
        queueTask = await this.registerLiveSegmentQueueTask(session, descriptor);
      } catch (e) {
        await this.diagnostics.logDiagnostic("error", "asr.segment_task_persist_failed", "录音分段已落盘，但持久任务登记失败", {
          segmentIndex: descriptor.segmentIndex,
          audioPath: descriptor.segmentAudioPath,
          error: diagnosticError(e),
        });
        if (!session._segmentTaskPersistFailureNotified) {
          session._segmentTaskPersistFailureNotified = true;
          new obsidian.Notice("录音分段已保存，但恢复任务登记失败；本场仍会继续转写，请不要强制关闭 Obsidian。", 10000);
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
      const provider = resolveTranscribeProvider(this);
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
      void this.diagnostics.logDiagnostic("info", "asr.service_circuit_recovered", "转写服务连接已恢复", { previousFailures });
    }
  }

  resetAsrServiceCircuitForManualRetry(source = "manual") {
    const previousFailures = Math.max(0, Number(this.getAsrServiceCircuitState().consecutiveFailures) || 0);
    this.asrServiceCircuitState = recordLiveAsrSuccess();
    if (previousFailures > 0) {
      void this.diagnostics.logDiagnostic("info", "asr.service_circuit_manual_probe", "用户发起转写重试，已允许一次立即探测", {
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
      void this.diagnostics.logDiagnostic("info", "asr.live_circuit_recovered", "实时转写服务已恢复", { previousFailures });
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
      void this.diagnostics.logDiagnostic("warn", "asr.live_circuit_opened", "连续转写故障，实时请求已暂时熔断", {
        segmentIndex: descriptor && descriptor.segmentIndex,
        consecutiveFailures: session.asrCircuitState.consecutiveFailures,
        openUntilMs: session.asrCircuitState.openUntilMs,
        error: diagnosticError(error),
      });
      if (!session._asrCircuitOpenNotified) {
        session._asrCircuitOpenNotified = true;
        new obsidian.Notice("转写服务连续失败，后续分段会先安全排队，稍后自动重试；录音不受影响。", 10000);
      }
    }
  }

  handleSegment(session: RecordingSession, seg: unknown) {
    if (!session) return;
    const filteredShort = this.shouldFilterShortRecording(session, seg);
    const masterAudioSavePromise = filteredShort ? Promise.resolve() : this.startMasterAudioSave(session, seg);
    let preparedSeg;
    if (seg && seg.masterOnly) {
      preparedSeg = {
        isFinal: !!seg.isFinal,
        masterOnly: true,
        endOffsetMs: Math.max(0, Number(seg.endOffsetMs) || 0),
        masterAudioSavePromise,
      };
      session.activeSegmentJobs = (Number(session.activeSegmentJobs) || 0) + 1;
    } else if (filteredShort) {
      preparedSeg = {
        isFinal: !!seg.isFinal,
        endOffsetMs: Math.max(0, Number(seg.endOffsetMs) || 0),
        filteredShort: true,
        masterAudioSavePromise,
      };
      session.activeSegmentJobs = (Number(session.activeSegmentJobs) || 0) + 1;
    } else {
      const descriptor = this.prepareLiveSegmentDescriptor(session, seg);
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
        await this.processSegment(session, preparedSeg);
      } catch (e) {
        // 本段异常不能毒化后续写入链；processSegment 已尽力保留缓存并加入后台重试。
        console.error("[QnALog] processSegment failed (swallowed to protect write chain)", e);
        try {
          const task = preparedSeg.queueTaskId && this.queue.tasks.find((item) => item && item.id === preparedSeg.queueTaskId);
          if (preparedSeg.segmentAudioPath && (!task || task.status === LIVE_ASR_TASK_STATUS || task.status === "running")) {
            await this.keepLiveSegmentQueueTaskForRetry(session, preparedSeg, e);
            session.hasDeferredAsrJobs = true;
          }
        } catch (queueError) {
          console.error("[QnALog] preserve live segment task after processing failure failed", queueError);
        }
        try { await this.diagnostics.logDiagnostic("error", "segment.process_failed", "分段处理异常（已吞，避免毒化写入链）", { mode: session.mode, isFinal: !!preparedSeg.isFinal, error: diagnosticError(e) }); } catch { /* intentionally empty */ }
      } finally {
        if (preparedSeg.jobId) this.getLiveAsrJobs(session).delete(preparedSeg.jobId);
        session.activeSegmentJobs = Math.max(0, (Number(session.activeSegmentJobs) || 1) - 1);
        this.updateLiveAsrBacklogPolicy(session, "completed");
        if (!preparedSeg.isFinal && session.pendingMeetingWorkbenchInteractions && session.pendingMeetingWorkbenchInteractions.length) {
          this.scheduleMeetingWorkbenchInteraction(session, session.pendingMeetingWorkbenchInteractions[0]);
        }
      }
    });
    if (preparedSeg.isFinal) {
      // 双分支：无论前序链 fulfilled 还是 rejected，finalizeSession 都必须跑。
      session.writeQueue = session.writeQueue.then(
        () => this.finalizeSession(session),
        (e) => { console.error("[QnALog] write chain rejected before finalize", e); return this.finalizeSession(session); }
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

  getSegmentCacheFolder() {
    return obsidian.normalizePath(this.settings.segmentCacheFolder || DEFAULT_SETTINGS.segmentCacheFolder);
  }

  async ensureSegmentCacheFolder() {
    const folderPath = this.getSegmentCacheFolder();
    const adapter = this.app.vault.adapter;
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

  async saveMasterAudio(session, seg) {
    if (!session || session.masterAudioPath || !seg || !seg.masterBlob) return;
    try {
      const ext = seg.masterExt || extFromMime(seg.masterMime || seg.masterBlob.type || "") || seg.ext || "webm";
      await ensureVaultFolder(this.app, this.settings.audioFolder);
      const target = findAvailableVaultPath(this.app, obsidian.normalizePath(`${this.settings.audioFolder}/lex-${session.sessionStamp}.${ext}`));
      if (!target) throw new Error("无法生成完整录音文件路径");
      const ab = await seg.masterBlob.arrayBuffer();
      await this.app.vault.createBinary(target, ab);
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
      new obsidian.Notice(`完整录音写入失败：${(e && e.message) || e}`, 8000);
    }
  }

  isQueuedTranscribeAudioReferenced(path, excludeTaskId) {
    const norm = obsidian.normalizePath(String(path || ""));
    if (!norm || !this.queue || typeof this.queue.snapshot !== "function") return false;
    return this.queue.snapshot().some(t => t && t.type === "transcribe"
      && t.id !== excludeTaskId
      && obsidian.normalizePath(String(t.audioPath || "")) === norm);
  }

  async maybeDeleteSegmentCacheFile(path, excludeTaskId, force = false) {
    if (!force && this.settings.keepSegmentAudioFiles === true) return;
    if (!this.isSegmentCachePath(path)) return;
    if (this.isQueuedTranscribeAudioReferenced(path, excludeTaskId)) return;
    const file = this.app.vault.getAbstractFileByPath(obsidian.normalizePath(path));
    if (file instanceof obsidian.TFile) {
      try { await this.app.fileManager.trashFile(file); }
      catch (e) { console.error("[QnALog] segment cache cleanup failed", path, e); }
      return;
    }
    // 点目录缓存可能不进入 TFile 索引；它属于可再生临时文件，直接通过 adapter 删除。
    try {
      const adapter = this.app.vault.adapter;
      const norm = obsidian.normalizePath(path);
      if (adapter && await adapter.exists(norm)) await adapter.remove(norm);
    } catch (e) {
      console.error("[QnALog] segment cache adapter cleanup failed", path, e);
    }
  }

  async cleanupSuccessfulSegmentAudio(session) {
    if (!session || this.settings.keepSegmentAudioFiles === true) return;
    if (this.settings.consolidatedLayout === false) return;
    if (!getSessionMasterAudioName(session)) return;
    for (const s of session.segments || []) {
      if (!s || s.error) continue;
      await this.maybeDeleteSegmentCacheFile(s.segmentAudioPath || s.audioPath);
    }
  }

  async cleanupExpiredSegmentCacheFiles(maxAgeMs = SEGMENT_CACHE_RETENTION_MS) {
    if (this.settings.keepSegmentAudioFiles === true) return { deleted: 0, skipped: 0, failed: 0 };
    const folderPath = this.getSegmentCacheFolder();
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
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
      const adapter = this.app.vault.adapter;
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
      await this.diagnostics.logDiagnostic("info", "segment_cache.cleanup", "已清理过期转写分段", { folderPath, deleted, skipped, failed });
    }
    return { deleted, skipped, failed };
  }

  async processSegment(session: RecordingSession, seg: unknown) {
    if (!session) return;
    if (seg && seg.isFinal && seg.masterOnly) {
      // 分段 recorder 已失效但独立 masterRecorder 仍拿到了完整录音。
      // 这里只保存母带并推进最终整理，不能把整场母带再次当作最后一段转写，
      // 否则前面已转写的内容会重复、并额外产生一次整场 ASR 费用。
      if (seg.masterAudioSavePromise) await seg.masterAudioSavePromise;
      else await this.saveMasterAudio(session, seg);
      this.setSessionWorkProgress(session, {
        stage: "transcribe-finalized",
        label: "转写收尾",
        percent: null,
        detail: "分段录音已停止，完整录音已保留，正在整理已有转写",
      });
      try {
        await this.diagnostics.logDiagnostic("warn", "recording.master_only_finalize", "最后分段不可用，已用完整录音完成保存并整理已有转写", {
          mode: session.mode,
          segmentCount: Array.isArray(session.segments) ? session.segments.length : 0,
          endOffsetMs: Number(seg.endOffsetMs) || 0,
        });
      } catch { /* intentionally empty */ }
      this.refreshOutlineView();
      return;
    }
    if (seg && (seg.filteredShort || this.shouldFilterShortRecording(session, seg))) {
      session.filteredShortRecording = true;
      session.filteredDurationMs = Math.max(0, Number(seg.endOffsetMs) || 0);
      await this.closeStreamingForDiscard(session);
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
    const segmentAudioName = seg.segmentAudioName || `lex-${session.sessionStamp}-seg${pad(segNumber)}.${seg.ext}`;
    const segmentAudioPath = seg.segmentAudioPath || obsidian.normalizePath(`${this.getSegmentCacheFolder()}/${segmentAudioName}`);
    const segmentDurationMs = Math.max(0, displayEndOffsetMs - displayStartOffsetMs);

    let spoolResult = null;
    if (seg.spoolPromise) {
      spoolResult = await seg.spoolPromise;
    } else if (seg.blob) {
      try {
        await this.ensureSegmentCacheFolder();
        await this.app.vault.adapter.writeBinary(segmentAudioPath, await seg.blob.arrayBuffer());
        spoolResult = { persisted: true, fallbackBlob: null, error: null };
      } catch (e) {
        spoolResult = { persisted: false, fallbackBlob: seg.blob, error: e };
        console.error(e);
        new obsidian.Notice(`段${segNumber} 音频写入失败：${(e && e.message) || e}`);
      }
    }
    if (spoolResult && spoolResult.queueTaskId) seg.queueTaskId = spoolResult.queueTaskId;
    await this.markLiveSegmentQueueTaskRunning(seg);
    const liveJob = seg.jobId ? this.getLiveAsrJobs(session).get(seg.jobId) : null;
    if (liveJob) liveJob.state = "transcribing";
    this.updateLiveAsrBacklogPolicy(session, "transcribing");
    if (seg.masterAudioSavePromise) await seg.masterAudioSavePromise;
    else if (seg.isFinal) await this.saveMasterAudio(session, seg);

    let text = ""; let err = null;
    let transcribeBlob = null;
    let channelTranscription = null;
    let batchAsrAttempted = false;
    let batchAsrFailureRecorded = false;
    const activeProfile = this.getActiveTranscribeProfile();
    const isStreamingProvider = activeProfile && activeProfile.transcribeMode === "streaming";
    this.setSessionWorkProgress(session, {
      stage: "transcribing",
      label: `转写第 ${segNumber} 段`,
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
      try { text = applyVocabularyCorrections(text, await loadVocabularyGroups(this)); } catch { /* intentionally empty */ }
      try { await this.removeLiveTranscriptBlock(session.mdPath, session.id); } catch { /* intentionally empty */ }
      session.streamingClient = null;
    } else if (isStreamingProvider) {
      // 流式服务但客户端连接失败：保留音频但不做 HTTP 切片转写（端点是 wss://，HTTP 必失败）
      err = new Error("流式转写连接未建立，请检查 API Key 与网络后重新录音。");
      console.error("[QnALog]", err.message);
    } else {
      const circuitOpen = isLiveAsrCircuitOpen(session.asrCircuitState || createLiveAsrCircuitState())
        || this.isAsrServiceCircuitOpen();
      if (session.asrDeferredMode || circuitOpen) {
        err = new Error(session.asrDeferredMode
          ? "实时转写积压超过保护阈值，已转入后台队列"
          : "转写服务处于短暂冷却期，已转入后台队列");
        err.asrDeferred = true;
        err.deferReason = session.asrDeferredMode ? "backlog-critical" : "circuit-open";
      } else {
        transcribeBlob = spoolResult && spoolResult.fallbackBlob ? spoolResult.fallbackBlob : null;
        if (!transcribeBlob && spoolResult && spoolResult.persisted) {
          const cachedAudio = await this.queueRetry.readVaultAudioBlob(segmentAudioPath, segmentAudioName);
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
            const channelMode = normalizeAudioChannelMode(session.audioChannelMode || this.settings.audioChannelMode);
            const runtimeChannelMode = session.audioChannelRuntimeMode
              || initialAudioChannelRuntimeMode(channelMode, reportedChannelCount);
            const inspectRecordedChannels = session.captureMode === "mic" && runtimeChannelMode !== "mono";
            // Only probe an auto-mode device until independent channel content is
            // confirmed. Once resolved, the session stays on one stable path.
            const expectedChannels = inspectRecordedChannels ? MAX_SPEAKER_CHANNELS : 1;
            if (inspectRecordedChannels) {
              channelTranscription = await transcribeAudioByChannels(
                this,
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
                await this.diagnostics.logDiagnostic("info", "asr.channel_crosstalk_deduplicated", "已去除跨声道重复转写", {
                  segmentIndex,
                  removedParts: channelTranscription.deduplicatedParts,
                  totalRemovedParts: session.channelCrosstalkDeduplicated,
                });
              }
              if (channelMode === "multichannel"
                && channelTranscription.separation === "duplicated"
                && !session._channelDuplicatedNotified) {
                session._channelDuplicatedNotified = true;
                new obsidian.Notice("各声道内容相同，已按单声道转写。请在接收器上把输出改为「Stereo（立体声）」后重试。", 10000);
                await this.diagnostics.logDiagnostic("warn", "asr.channel_content_duplicated", "录音多声道内容重复，已回退为单声道转写", {
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
                await this.diagnostics.logDiagnostic("warn", "asr.channel_encoder_downmix", "录音编码保留的声道少于设备输入声道", {
                  expectedChannelCount: expectedHardwareChannels,
                  actualChannelCount: actual,
                  inputLabel: session.audioChannelLabel || "",
                });
              }
              if (channelTranscription.errors.length) {
                await this.diagnostics.logDiagnostic("warn", "asr.channel_partial_failure", "部分声道转写失败，已保留其他声道的内容", {
                  segmentIndex,
                  channelCount: channelTranscription.actualChannelCount,
                  errors: channelTranscription.errors,
                });
              }
            } else {
              text = await transcribeAudio(this, transcribeBlob, transcribeMime);
            }
          } catch (e) {
            err = e;
            batchAsrFailureRecorded = true;
            this.recordLiveAsrAttemptFailure(session, e, seg);
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
        this.recordLiveAsrAttemptFailure(session, err, seg);
      }
      try {
        await this.diagnostics.logDiagnostic("warn", "asr.segment_empty", "录音分段转写返回空结果，已按软失败保留并排队", {
          segmentIndex,
          startOffsetMs: displayStartOffsetMs,
          endOffsetMs: displayEndOffsetMs,
          durationMs: segmentDurationMs,
          mode: session.mode,
        });
      } catch { /* intentionally empty */ }
    }
    if (!err && batchAsrAttempted) this.recordLiveAsrAttemptSuccess(session);
    if (err) {
      if (err.asrDeferred) {
        await this.diagnostics.logDiagnostic("warn", "asr.segment_deferred", "录音分段已跳过实时请求并转入后台队列", {
          segmentIndex,
          startOffsetMs: displayStartOffsetMs,
          endOffsetMs: displayEndOffsetMs,
          durationMs: segmentDurationMs,
          reason: err.deferReason || "deferred",
          pendingDurationMs: this.getLiveAsrBacklogSummary(session).totalDurationMs,
        });
      } else {
        const issueKind = classifyRecordingIssue(err);
        this.setRecordingIssue(issueKind, {
          source: "asr",
          message: getErrorMessage(err),
          startedAtMs: displayStartOffsetMs,
        });
        await this.diagnostics.logDiagnostic("error", "asr.segment_failed", "录音分段转写失败", {
          provider: this.settings.activeTranscribeProvider,
          model: this.getActiveTranscribeProfile() && this.getActiveTranscribeProfile().model,
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
      this.clearRecordingIssue("network");
      this.clearRecordingIssue("service");
      // 防误报：只在"本场此前从未产生过任何非空转写"时提示。
      // 否则会议中途的合理静默段（开头/中场没人说话）会骚扰正在正常录音的用户。
      const hadAnyText = Array.isArray(session.segments) && session.segments.some((s) => s && s.text && String(s.text).trim());
      await this.diagnostics.logDiagnostic("warn", "asr.empty_result", "本段无转写内容", {
        segmentIndex, mode: session.mode, hadAnyText,
      });
      if (!hadAnyText && !session._emptyAsrNotified) {
        session._emptyAsrNotified = true;
        new obsidian.Notice("本段没有检测到语音。请到「设置 → 常规 → 音频输入」测试所选设备。", 9000);
      }
    } else {
      this.clearRecordingIssue("network");
      this.clearRecordingIssue("service");
    }

    const playbackAudioName = session.masterAudioName || segmentAudioName;
    const playbackAudioPath = session.masterAudioPath || segmentAudioPath;
    const segmentRecord = {
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
      const retryTask = await this.keepLiveSegmentQueueTaskForRetry(session, Object.assign({}, seg, {
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
      segmentRecord.queueTaskId ? `<!-- lexvoice-transcribe-task:${segmentRecord.queueTaskId} -->` : "",
      err ? getTranscribeSegmentPlaceholder(err, {
        streaming: isStreamingProvider,
        deferred: !!err.asrDeferred,
        retryable: !isStreamingProvider && (err.asrDeferred || isTransientAsrError(err)),
      }) : (text ? text : "_[此段无内容]_"),
      "",
    ].join("\n");
    await this.noteWriter.insertBeforeSegmentsEnd(session.mdPath, block, session.id);
    if (!err || isStreamingProvider) await this.removeLiveSegmentQueueTask(seg);

    this.refreshOutlineView();
    this.setSessionWorkProgress(session, {
      stage: seg.isFinal ? "transcribe-finalized" : "transcribed",
      label: seg.isFinal ? "转写收尾" : (err && err.asrDeferred ? `已缓存 ${session.segments.length} 段` : `已转写 ${session.segments.length} 段`),
      percent: null,
      detail: seg.isFinal ? "正在进入 AI 整理" : (err && err.asrDeferred ? "音频已落盘，等待后台补转写" : "分段转写已写入纪要"),
    });

    if (!seg.isFinal && text && String(text).trim()) new obsidian.Notice(`段 ${segNumber} 已转写`);

    if ((this.settings.enableRealtimeOutline || (this.session && this.session.mode === "recruit-needs")) && text && !err) {
      this.scheduleRealtimeOutline();
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
          this.tasks.endTaskMeter(session._finalizeTaskMeter);
          session._finalizeTaskMeter = null;
        }
        try {
          this.setSessionWorkProgress(session, {
            stage: "finalize-failed",
            label: "纪要收尾失败",
            percent: null,
            detail: "原始转写和录音已保留，可打开笔记后重新整理",
          });
        } catch { /* intentionally empty */ }
        console.error("[QnALog] finalize session failed", e);
        try {
          await this.diagnostics.logDiagnostic("error", "session.finalize_failed", "纪要最终收尾异常，原始材料已保留", {
            mode: session.mode,
            mdPath: session.mdPath,
            segmentCount: Array.isArray(session.segments) ? session.segments.length : 0,
            error: diagnosticError(e),
          });
        } catch { /* intentionally empty */ }
        new obsidian.Notice("纪要收尾失败；原始转写和录音已保留，可在笔记中使用「重新整理」。", 10000);
        if (this.session === session) this.session = null;
        this.refreshOutlineView();
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

    const file = this.app.vault.getAbstractFileByPath(session.mdPath);
    if (!(file instanceof obsidian.TFile)) return { segments, frontmatter: null };
    const frontmatter = await readFileFrontmatter(this, file) || {};
    const ids = candidates.map(candidate => candidate.id);
    const initialMappings = normalizeSpeakerMappings(
      Object.assign({}, session.speakerChannels || {}, frontmatter.lexvoice_speakers || {}),
      ids,
    );
    const alreadyConfirmed = candidates.every(candidate => String(initialMappings[candidate.id] && initialMappings[candidate.id].personName || "").trim());
    let mappings = initialMappings;

    if (!alreadyConfirmed && !session._speakerNameConfirmationSkipped) {
      this.setSessionWorkProgress(session, {
        stage: "speaker-confirm",
        label: "确认说话人",
        percent: 52,
        detail: `识别到 ${candidates.length} 位说话人，等待确认姓名后继续整理`,
      });
      this.refreshOutlineView();
      const providerId = session.importTranscribeProviderId
        || this.settings.activeTranscribeProvider
        || "siliconflow";
      const activeProvider = (this.settings.transcribeProviders || {})[providerId] || {};
      const profile = this.getTranscribeProviderProfile(providerId, activeProvider);
      const hardwareSeparated = Object.keys(session.speakerChannels || {}).length >= 2;
      const stableAcrossSession = hardwareSeparated
        || !!(profile && profile.speakerLabelScope === "session" && profile.requiresWholeSession)
        || isSpeakerDiarizationProvider(activeProvider);
      const names = await new Promise((resolve) => {
        const modal = new SpeakerNameConfirmModal(
          this.app,
          this,
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
      await this.app.fileManager.processFrontMatter(file, (nextFrontmatter) => {
        nextFrontmatter.lexvoice_speakers = mappings;
      });
      session.speakerChannels = mappings;
      let persistedReplacements = 0;
      let namesPersisted = false;
      try {
        let markdown = await this.app.vault.read(file);
        for (const [speakerId, mapping] of Object.entries(mappings)) {
          const personName = String(mapping && mapping.personName || "").trim();
          if (!personName) continue;
          const updated = replaceSpeakerDisplayName(markdown, speakerId, personName);
          markdown = updated.markdown;
          persistedReplacements += updated.replacements;
        }
        if (persistedReplacements > 0) {
          await this.app.vault.modify(file, markdown);
          this.notePanelCacheKey = "";
          this.notePanelCacheData = undefined;
          this.notePanelLoading = false;
        }
        namesPersisted = true;
      } catch (error) {
        try {
          await this.diagnostics.logDiagnostic("warn", "speaker.names_persist_failed", "说话人姓名已保存到属性，但正文更新失败", {
            mdPath: file.path,
            error: diagnosticError(error),
          });
        } catch { /* diagnostics must not change finalization behavior */ }
        new obsidian.Notice("说话人姓名已保存，但原始转写中的显示名未能更新；可在大纲中再次保存。", 8000);
      }
      if (namesPersisted) {
        try {
          await this.diagnostics.logDiagnostic("info", "speaker.names_persisted", "说话人姓名已写入原始转写", {
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
      frontmatter: hasConfirmedName ? Object.assign({}, frontmatter, { lexvoice_speakers: mappings }) : null,
    };
  }

  async _finalizeSessionImpl(session) {

    // 静音统计快照：此刻录音刚结束、recorder 计数尚未被下一场 start() 重置，同步读取避免异步窗口被污染。
    const _silVoiced = this.recorder ? (this.recorder._voicedTicks || 0) : 0;
    const _silSilent = this.recorder ? (this.recorder._silentTicks || 0) : 0;

    if (session.filteredShortRecording) {
      await this.discardFilteredShortSession(session);
      new obsidian.Notice("已过滤小于三秒录音");
      if (this.session === session) this.session = null;
      this.refreshOutlineView();
      return;
    }

    if (!session.segments || session.segments.length === 0) {
      await this.noteWriter.removeEmptySessionBlock(session);
      new obsidian.Notice("⏭ 本次录音时长过短或无有效音频，已跳过");
      if (this.session === session) this.session = null;
      this.refreshOutlineView();
      return;
    }

    // 兜底：整场电平几乎为零（≥5s≈30 帧有效采样中，有声占比 < 2%）→ 明确提示用户去查设备。
    // 插件不替用户猜设备，只在"采到的几乎全是静音"这种失败点明确提示。逐场只弹一次。
    const _silTotal = _silVoiced + _silSilent;
    // 仅对真实录音会话判静音：导入/文本导入不经 recorder，会读到上一场录音遗留的计数残值 → 误报。
    if (!session.source && _silTotal >= 30 && (_silVoiced / _silTotal) < 0.02 && !session._silenceNotified) {
      session._silenceNotified = true;
      new obsidian.Notice("整场几乎没检测到声音，请检查所选麦克风 / 电脑音频设备（设置 → 进阶 → 音频设备检测）。", 9000);
    }

    const textImportSession = isTextImportSession(session);
    const segmentsForFinal = this.getSegmentsForFinalSession(session);
    const writeSession = segmentsForFinal === session.segments
      ? session
      : Object.assign({}, session, { segments: segmentsForFinal, multiSourceAudio: true });
    const usableTranscriptSegments = segmentsForFinal.filter(s => s && String(s.text || "").trim());
    if (!usableTranscriptSegments.length) {
      const noTranscriptError = new Error("没有可用于整理的有效转写文本；录音和失败切片已保留");
      this.setSessionWorkProgress(session, {
        stage: "transcript-empty",
        label: "没有获得有效转写",
        percent: null,
        detail: "已保留录音，可检查转写服务后从待处理队列重试",
      });
      try {
        await this.diagnostics.logDiagnostic("error", "session.no_transcript", "整场没有有效转写，已跳过 LLM 整理以避免无效计费", {
          mode: session.mode,
          segmentCount: segmentsForFinal.length,
          failedSegments: segmentsForFinal.filter(s => s && s.error).length,
          mdPath: session.mdPath,
        });
      } catch { /* intentionally empty */ }
      await this.noteWriter.appendPolishBlock(writeSession, "", noTranscriptError, true);
      new obsidian.Notice("没有获得有效转写；录音和失败切片已保留，请检查转写服务后在待处理队列重试。", 10000);
      if (this.settings.autoOpenNoteAfterFinish) {
        const file = this.app.vault.getAbstractFileByPath(session.mdPath);
        if (file instanceof obsidian.TFile) {
          try { await this.app.workspace.getLeaf(false).openFile(file); } catch { /* intentionally empty */ }
        }
      }
      this.queueRetry.scheduleDeferredAsrRetry(session);
      if (this.session === session) this.session = null;
      this.refreshOutlineView();
      return;
    }
    session.finalizing = true;
    let speakerPreparation = { segments: segmentsForFinal, frontmatter: null };
    try {
      speakerPreparation = await this.confirmSpeakerNamesBeforeFinal(session, segmentsForFinal);
    } catch (error) {
      console.warn("[QnALog] speaker confirmation failed; continuing with generic labels", error);
      try {
        await this.diagnostics.logDiagnostic("warn", "speaker.confirmation_failed", "说话人姓名确认未完成，已保留编号继续整理", {
          mdPath: session.mdPath,
          error: diagnosticError(error),
        });
      } catch { /* intentionally empty */ }
    }
    const segmentsForLlm = speakerPreparation.segments || segmentsForFinal;
    const speakerFrontmatter = speakerPreparation.frontmatter || null;
    this.setSessionWorkProgress(session, {
      stage: "finalize-start",
      label: textImportSession ? "读取文本完成" : "准备 AI 整理",
      percent: 12,
      detail: textImportSession ? "已跳过 ASR，正在准备结构化整理" : "转写已结束，正在整理上下文",
    });
    this.refreshOutlineView();
    new obsidian.Notice(textImportSession ? "文本已读取，AI 结构化整理中…" : "所有段已处理，AI 合并润色中…");

    let polished = ""; let mergeError = null; let nonRetryableMergeError = false; let commitError = false;
    let taskMeter = null;
    let finalSessionMeta = null;
    try {
      const llmConfigIssue = getLlmConfigIssue(this.settings);
      if (llmConfigIssue) {
        const configurationError = new Error(llmConfigIssue);
        configurationError.nonRetryable = true;
        throw configurationError;
      }
      this.setSessionWorkProgress(session, {
        stage: "workbench",
        label: "整理上下文",
        percent: 22,
        detail: "正在合并会中记录、附件和上下文",
      });
      await this.processPendingMeetingWorkbenchInteractions(session, { force: true });
      if (!textImportSession) {
        this.setSessionWorkProgress(session, {
          stage: "outline",
          label: "生成大纲",
          percent: 36,
          detail: "正在补齐实时大纲，供最终纪要参考",
        });
        await this.ensureRealtimeOutlineForFinalNote(session);
      }
      const lastSeg = segmentsForFinal[segmentsForFinal.length - 1];
      const textImport = textImportSession;
      const sessionMeta = {
        startedAt: session.startedAt,
        duration: textImport ? "" : (lastSeg ? formatElapsed(lastSeg.endOffsetMs || 0) : ""),
        source: session.source || "",
        sourceMeta: session.sourceMeta || null,
        promotionReviewContext: session.promotionReviewContext || null,
        meetingWorkbench: normalizeMeetingWorkbench(session.meetingWorkbench),
      };
      finalSessionMeta = sessionMeta;
      this.setSessionWorkProgress(session, {
        stage: "llm-merge",
        label: "AI 整理中",
        percent: 62,
        detail: textImport ? "正在把导入文本交给大模型结构化整理" : "正在把分段转写合并成最终纪要",
      });
      if (session.mode === "recruit" && session.recruitContext) {
        session.recruitContext = await this.recruit.resolveRecruitProjectContext(session.recruitContext);
        writeSession.recruitContext = session.recruitContext;
      }
      taskMeter = this.tasks.beginTaskMeter();
      sessionMeta._taskMeter = taskMeter;
      session._finalizeTaskMeter = taskMeter;
      polished = await mergeAndPolish(this, segmentsForLlm.map(s => ({
        index: s.index, startOffsetMs: s.startOffsetMs, endOffsetMs: s.endOffsetMs, text: s.text,
        audioName: s.audioName,
        audioStartOffsetMs: s.audioStartOffsetMs,
        audioEndOffsetMs: s.audioEndOffsetMs,
        sourceName: s.sourceName,
        sourcePath: s.sourcePath,
        sourceUrl: s.sourceUrl,
        rawText: s.rawText,
      })), session.mode, session.recruitContext, sessionMeta, speakerFrontmatter);
      session._briefingCheckpointId = sessionMeta._briefingCheckpointId || "";
      this.setSessionWorkProgress(session, {
        stage: "write-note",
        label: "写入纪要",
        percent: 88,
        detail: "AI 输出已返回，正在写入 Obsidian 笔记",
      });
    } catch (e) { mergeError = e; console.error(e); }
    session.finalizing = false;

    if (mergeError) {
      if (taskMeter) {
        this.tasks.endTaskMeter(taskMeter);
        taskMeter = null;
        session._finalizeTaskMeter = null;
      }
      nonRetryableMergeError = isLlmNonRetryableError(mergeError);
      await this.diagnostics.logDiagnostic("error", "llm.merge_failed", "LLM 合并整理失败", {
        mode: session.mode,
        segmentCount: segmentsForFinal.length,
        duration: isTextImportSession(session) ? "" : (segmentsForFinal.length ? formatElapsed(segmentsForFinal[segmentsForFinal.length - 1].endOffsetMs || 0) : ""),
        llmEndpoint: this.settings.llmEndpoint,
        llmModel: this.settings.llmModel,
        nonRetryable: nonRetryableMergeError,
        error: diagnosticError(mergeError),
      });
      const lastSeg = segmentsForFinal[segmentsForFinal.length - 1];
      await this.queue.add({
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
        recruitContext: session.recruitContext || null,
        speakerFrontmatter,
        sessionMeta: finalSessionMeta || {
          startedAt: session.startedAt,
          duration: isTextImportSession(session) ? "" : (lastSeg ? formatElapsed(lastSeg.endOffsetMs || 0) : ""),
          source: session.source || "",
          sourceMeta: session.sourceMeta || null,
          promotionReviewContext: session.promotionReviewContext || null,
          meetingWorkbench: normalizeMeetingWorkbench(session.meetingWorkbench),
        },
        lastError: mergeError.message || String(mergeError),
      });
      if (!nonRetryableMergeError) {
        this.queueRetry.scheduleTaskQueueRetry(1500, mergeError instanceof BriefingPipelineIncompleteError
          ? "briefing-partial"
          : "briefing-finalization-failure");
      }
      session.finalizationError = getErrorMessage(mergeError);
      const partialBriefing = mergeError instanceof BriefingPipelineIncompleteError;
      this.setSessionWorkProgress(session, {
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
        if (shouldRewriteConsolidatedNote(this.settings, writeSession)) {
          await this.noteWriter.rewriteConsolidated(writeSession, polished);
        } else {
          await this.noteWriter.appendPolishBlock(writeSession, polished, null, false);
        }
      } catch (writeError) {
        commitError = true;
        mergeError = writeError;
        session.finalizationError = getErrorMessage(writeError);
        await this.diagnostics.logDiagnostic("error", "briefing.commit_failed", "纪要正文已生成，但写入 Markdown 失败", {
          mode: session.mode,
          mdPath: session.mdPath,
          checkpointId: finalSessionMeta && finalSessionMeta._briefingCheckpointId || "",
          error: diagnosticError(writeError),
        });
        await this.queue.add({
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
          recruitContext: session.recruitContext || null,
          speakerFrontmatter,
          sessionMeta: finalSessionMeta,
          lastError: `纪要写入失败：${getErrorMessage(writeError)}`,
        });
        this.queueRetry.scheduleTaskQueueRetry(1500, "briefing-write-failure");
        this.setSessionWorkProgress(session, {
          stage: "write-retrying",
          label: "纪要写入等待重试",
          percent: null,
          detail: "AI 整理结果已保存，不会重复调用模型；稍后只重试写入",
        });
      }
    } else {
      await this.noteWriter.appendPolishBlock(writeSession, polished, mergeError, nonRetryableMergeError);
    }
    if (!mergeError && finalSessionMeta && finalSessionMeta._briefingCheckpointId) {
      await clearCommittedBriefingCheckpoint(this, finalSessionMeta);
      session._briefingCheckpointId = "";
    }

    if (!mergeError) {
      this.setSessionWorkProgress(session, {
        stage: "done",
        label: "处理完成",
        percent: 100,
        detail: "纪要已写入，正在收尾",
      });
    }

    if (!mergeError && polished) {
      const beforeRenamePath = session.mdPath;
      const recruitRelocate = session.mode === "recruit" && session.recruitContext && session.recruitContext.jdFile;
      // F4.2：招聘评估且选了 JD 项目 → 移到项目文件夹 + 候选人-轮次-MMDD 命名（替代自动标题改名，保命名干净）
      const renamed = recruitRelocate
        ? await this.recruit.relocateRecruitNote(session, session.recruitContext)
        : await this.noteWriter.renameMarkdownWithGeneratedTitle(session.mdPath, polished, session.mode);
      if (renamed instanceof obsidian.TFile) {
        session.mdPath = renamed.path;
        writeSession.mdPath = renamed.path;
      }
      const renamedByPolished = renamed instanceof obsidian.TFile
        && obsidian.normalizePath(renamed.path) !== obsidian.normalizePath(beforeRenamePath);
      if ((session.source === "import" || session.source === "text-import") && !renamedByPolished && !recruitRelocate) {
        const rawTitleSource = buildTitleSourceFromSegments(segmentsForFinal);
        if (rawTitleSource) {
          const fallbackRenamed = await this.noteWriter.renameMarkdownWithGeneratedTitle(session.mdPath, rawTitleSource, session.mode);
          if (fallbackRenamed instanceof obsidian.TFile) {
            session.mdPath = fallbackRenamed.path;
            writeSession.mdPath = fallbackRenamed.path;
          }
        }
      }
    }

    if (!mergeError && polished) {
      await this.refreshLexVoiceNoteIndexSafely(writeSession.mdPath, {
        meetingDate: session.startedAt,
        reason: "finalize",
      });
      try { await this.appendDailyMeetingOverview(writeSession, polished); }
      catch (e) { console.error("[QnALog] daily overview failed", e); }
    }

    if (!mergeError) {
      await this.cleanupSuccessfulSegmentAudio(session);
      const completedTaskMeter = taskMeter ? this.tasks.endTaskMeter(taskMeter) : null;
      taskMeter = null;
      session._finalizeTaskMeter = null;
      try {
        const doneLabel = isTextImportSession(session) ? "文本整理完成"
          : session.source === "import" ? "导入音频整理完成" : "录音纪要整理完成";
        this.tasks.logCompletedWork(doneLabel, session.mdPath || "", completedTaskMeter);
      } catch { /* intentionally empty */ }
      // 沉淀开关默认关闭：开启后转写完成自动跑沉淀扫描并入库；关闭则照旧手动点「沉淀」。后台执行、失败静默。
      if (this.settings.sedimentAutoExtract) void this.autoExtractSedimentAfterFinalize(session.mdPath);
    }

    new obsidian.Notice(mergeError
      ? (nonRetryableMergeError
        ? `AI 整理失败：${formatLlmFailureIssue(mergeError.message || mergeError)}`
        : commitError
          ? "纪要正文已生成，写入失败，已加入重试队列"
          : mergeError instanceof BriefingPipelineIncompleteError
          ? `${mergeError.message}，已加入精确重试`
          : "AI 整理未完成，已加入重试队列")
      : "QnALog 处理完成");

    if (this.settings.autoOpenNoteAfterFinish) {
      const file = this.app.vault.getAbstractFileByPath(session.mdPath);
      if (file instanceof obsidian.TFile) {
        try { await this.app.workspace.getLeaf(false).openFile(file); } catch { /* intentionally empty */ }
      }
    }
    this.queueRetry.scheduleDeferredAsrRetry(session);
    if (this.session === session) this.session = null;
    this.refreshOutlineView();
  }

  async refreshLexVoiceNoteIndex(fileOrPath, options = {}) {
    const file = typeof fileOrPath === "string"
      ? this.app.vault.getAbstractFileByPath(obsidian.normalizePath(fileOrPath))
      : fileOrPath;
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") return null;
    const current = await this.app.vault.read(file);
    const index = buildLexVoiceNoteIndex(current, {
      noteTitle: file.basename,
      meetingDate: options.meetingDate || "",
    });
    if (!index) return null;
    const next = upsertLexVoiceNoteIndex(current, index);
    if (next !== current) await this.app.vault.modify(file, next);
    const expectedCanvasPath = obsidian.normalizePath(getSemanticCanvasPath(file.path));
    const canvasFile = this.app.vault.getAbstractFileByPath(expectedCanvasPath);
    return resolveLexVoiceNoteIndex(
      index,
      file.path,
      canvasFile instanceof obsidian.TFile ? canvasFile.path : null,
    );
  }

  async refreshLexVoiceNoteIndexSafely(fileOrPath, options = {}) {
    try {
      return await this.refreshLexVoiceNoteIndex(fileOrPath, options);
    } catch (error) {
      const filePath = typeof fileOrPath === "string" ? fileOrPath : (fileOrPath && fileOrPath.path) || "";
      console.warn("[QnALog] note index refresh failed", error);
      try {
        await this.diagnostics.logDiagnostic("warn", "note.index_refresh_failed", "纪要索引更新失败，正文不受影响", {
          filePath,
          reason: options.reason || "",
          error: diagnosticError(error),
        });
      } catch { /* index diagnostics must never affect note delivery */ }
      return null;
    }
  }

  async appendDailyMeetingOverview(session, polished) {
    if (!this.settings.writeDailyMeetingOverview) return;
    if (!session || !polished) return;
    let dailyFile = null;
    try {
      dailyFile = await ensureTodayDailyNoteFile(this.app);
    } catch (e) {
      console.error("[QnALog] daily note ensure failed", e);
    }
    if (!(dailyFile instanceof obsidian.TFile)) return;
    if (obsidian.normalizePath(dailyFile.path) === obsidian.normalizePath(session.mdPath)) return;
    const entry = buildDailyMeetingOverviewEntry(session, polished, this.settings);
    const cur = await this.app.vault.read(dailyFile);
    const next = upsertDailyMeetingOverview(cur, session.id, entry, this.settings);
    if (next !== cur) await this.app.vault.modify(dailyFile, next);
  }

  async appendDailyMeetingOverviewForMarkdown(file, markdown, polished, mode, segments, sessionMeta) {
    if (!(file instanceof obsidian.TFile)) return;
    const startedAt = sessionMeta && sessionMeta.startedAt
      ? sessionMeta.startedAt
      : new Date(file.stat && file.stat.ctime ? file.stat.ctime : Date.now()).toISOString();
    const session = {
      id: extractLexVoiceSessionId(markdown, obsidian.normalizePath(file.path).replace(/[^A-Za-z0-9_-]+/g, "-")),
      mdPath: file.path,
      mode,
      startedAt,
      segments: Array.isArray(segments) ? segments : [],
    };
    await this.appendDailyMeetingOverview(session, polished);
  }

  getAvailableMarkdownPath(targetPath, currentPath) {
    const current = obsidian.normalizePath(currentPath || "");
    let candidate = obsidian.normalizePath(targetPath || "");
    if (!candidate || candidate === current) return candidate;
    const dot = candidate.toLowerCase().endsWith(".md") ? candidate.length - 3 : candidate.length;
    const base = candidate.slice(0, dot);
    const ext = candidate.slice(dot) || ".md";
    let i = 2;
    while (true) {
      const existing = this.app.vault.getAbstractFileByPath(candidate);
      if (!existing || obsidian.normalizePath(existing.path) === current) return candidate;
      candidate = obsidian.normalizePath(`${base}-${i}${ext}`);
      i++;
      if (i > 99) return "";
    }
  }  // 历史笔记迁移：扫描 mdFolder 下所有 .md，给没有 frontmatter 的老纪要补全 mode/日期/主题/tags
  // 已有 mode 字段的跳过；无法识别模式的也跳过；其他都补全（写入最小 frontmatter）
  async migrateLegacyNotes() {
    const folderPath = obsidian.normalizePath(this.settings.mdFolder || "LexVoice/转写纪要");
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof obsidian.TFolder)) {
      throw new Error("笔记文件夹不存在：" + folderPath);
    }
    const files = [];
    const walk = (f) => {
      if (f instanceof obsidian.TFolder) for (const c of f.children) walk(c);
      else if (f instanceof obsidian.TFile && f.extension === "md") files.push(f);
    };
    walk(folder);

    let migrated = 0, skipped = 0, noMode = 0, failed = 0;
    const failedFiles = [];

    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
        if (fmMatch) {
          try {
            const fm = obsidian.parseYaml(fmMatch[1]);
            if (fm && fm.mode) { skipped++; continue; }
          } catch { /* intentionally empty */ }
        }
        const mode = inferModeFromLegacyNote(file.name, content);
        if (!mode) { noMode++; continue; }

        const dateMatch = file.name.match(/^(\d{4}-\d{2}-\d{2})/);
        const date = dateMatch ? dateMatch[1] : "";
        const durationMatch = content.match(/时长\s*[:：]\s*([\d:]+)/);
        const duration = durationMatch ? durationMatch[1] : "";
        const topic = inferTopicFromFilename(file.name);

        const fmObj = { mode };
        // 统一用 time（ISO datetime），不再写 日期；从文件名日期 + ctime 兜底推断，保证非空、跨模式一致。
        const tval = formatYamlDateTime(inferLexVoiceNoteStartedAtIso(file, date ? { "日期": date } : {}));
        if (tval) fmObj.time = tval;
        if (duration) fmObj["时长"] = duration;
        if (topic) fmObj["主题"] = topic; // 统一主键为 主题（含 huddle，不再写 议题）
        fmObj["状态"] = "已整理";
        fmObj["tags"] = ["lexvoice/" + mode, "lexvoice/legacy"];

        let yamlBlock;
        try { yamlBlock = obsidian.stringifyYaml(fmObj); }
        catch {
          yamlBlock = Object.entries(fmObj).map(([k, v]) =>
            Array.isArray(v) ? k + ":\n" + v.map(x => "  - " + x).join("\n") : k + ": " + v
          ).join("\n") + "\n";
        }

        let newContent;
        if (fmMatch) newContent = "---\n" + yamlBlock + "---\n" + content.slice(fmMatch[0].length);
        else newContent = "---\n" + yamlBlock + "---\n\n" + content;

        await this.app.vault.modify(file, newContent);
        migrated++;
      } catch (e) {
        console.error("[QnALog] migrate failed:", file.path, e);
        failedFiles.push(file.path);
        failed++;
      }
    }
    return { migrated, skipped, noMode, failed, failedFiles, total: files.length };
  }

  async cleanupEmptyShortRecordings() {
    const folderPath = obsidian.normalizePath(this.settings.mdFolder || DEFAULT_SETTINGS.mdFolder);
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof obsidian.TFolder)) {
      new obsidian.Notice(`转写纪要文件夹不存在：${folderPath}`, 8000);
      return;
    }

    const files = [];
    const walk = (item) => {
      if (item instanceof obsidian.TFolder) {
        for (const child of item.children) walk(child);
      } else if (item instanceof obsidian.TFile && item.extension === "md") {
        files.push(item);
      }
    };
    walk(folder);

    const currentPath = this.session && this.session.mdPath ? obsidian.normalizePath(this.session.mdPath) : "";
    const candidates = [];
    for (const file of files) {
      if (currentPath && obsidian.normalizePath(file.path) === currentPath) continue;
      try {
        const content = await this.app.vault.read(file);
        const candidate = analyzeLexVoiceEmptyShortNote(file, content, this.settings);
        if (!candidate) continue;
        const audioFiles = [];
        const seenAudio = new Set();
        for (const ref of candidate.audioRefs) {
          const audioFile = resolveLexVoiceAudioFile(this.app, this.settings, ref);
          if (audioFile && !seenAudio.has(audioFile.path)) {
            seenAudio.add(audioFile.path);
            audioFiles.push(audioFile);
          }
        }
        candidate.audioFiles = audioFiles;
        candidates.push(candidate);
      } catch (e) {
        console.error("[QnALog] cleanup scan failed:", file.path, e);
      }
    }

    if (!candidates.length) {
      new obsidian.Notice("没有发现符合条件的空白短录音");
      return;
    }

    const uniqueAudioFiles = [];
    const audioPaths = new Set();
    for (const candidate of candidates) {
      for (const audioFile of candidate.audioFiles) {
        if (!audioPaths.has(audioFile.path)) {
          audioPaths.add(audioFile.path);
          uniqueAudioFiles.push(audioFile);
        }
      }
    }

    const preview = candidates
      .slice(0, 10)
      .map((c) => `- ${c.file.path}（${formatElapsed(c.durationMs)}，录音 ${c.audioFiles.length} 个）`)
      .join("\n");
    const more = candidates.length > 10 ? `\n...另有 ${candidates.length - 10} 条` : "";
    const ok = await lexvoiceConfirm(
      this.app,
      "清理空白短录音",
      `发现 ${candidates.length} 条空白短录音。\n\n条件：时长不超过 10 秒，且没有有效转写文本。\n将移入系统废纸篓：${candidates.length} 篇纪要、${uniqueAudioFiles.length} 个录音文件。\n\n${preview}${more}\n\n继续清理吗？`,
      "清理"
    );
    if (!ok) return;

    let noteDeleted = 0;
    let audioDeleted = 0;
    let failed = 0;
    const deletedNotePaths = new Set();
    const deletedAudioPaths = new Set();

    for (const candidate of candidates) {
      try {
        await trashLexVoiceFile(this.app, candidate.file);
        noteDeleted++;
        deletedNotePaths.add(obsidian.normalizePath(candidate.file.path));
      } catch (e) {
        failed++;
        console.error("[QnALog] cleanup note delete failed:", candidate.file.path, e);
      }
    }

    for (const audioFile of uniqueAudioFiles) {
      const current = this.app.vault.getAbstractFileByPath(audioFile.path);
      if (!(current instanceof obsidian.TFile)) continue;
      try {
        await trashLexVoiceFile(this.app, current);
        audioDeleted++;
        deletedAudioPaths.add(obsidian.normalizePath(audioFile.path));
      } catch (e) {
        failed++;
        console.error("[QnALog] cleanup audio delete failed:", audioFile.path, e);
      }
    }

    const beforeQueue = this.queue.tasks.length;
    this.queue.tasks = this.queue.tasks.filter((task) => {
      const mdPath = task.mdPath ? obsidian.normalizePath(task.mdPath) : "";
      const audioPath = task.audioPath ? obsidian.normalizePath(task.audioPath) : "";
      return !deletedNotePaths.has(mdPath) && !deletedAudioPaths.has(audioPath);
    });
    const queueRemoved = beforeQueue - this.queue.tasks.length;
    if (queueRemoved > 0) await this.saveAll();

    new obsidian.Notice(`清理完成：纪要 ${noteDeleted} 篇，录音 ${audioDeleted} 个，队列移除 ${queueRemoved} 条${failed ? `，失败 ${failed} 项` : ""}`, 10000);
  }

  // 创建 QnALog 视图（.base 文件）—— 9 个：5 按模式 + 4 场景
  // overwrite=false：已存在的文件保留；overwrite=true：强制覆盖（用户重置/升级用）
  async createLexVoiceBases(opts) {
    const overwrite = !!(opts && opts.overwrite);
    const basesFolder = getLexVoiceBasesFolder(this.settings);
    await ensureVaultFolder(this.app, basesFolder);
    await ensureVaultFolder(this.app, basesFolder + "/按模式");
    await ensureVaultFolder(this.app, basesFolder + "/场景");
    let created = 0, updated = 0, skipped = 0;
    for (const def of LV_BASE_DEFINITIONS) {
      if (!isRecruitFeatureUnlocked(this.settings) && /lexvoice\/recruit|招聘/.test(def.relPath + "\n" + def.yaml)) {
        skipped++;
        continue;
      }
      const path = obsidian.normalizePath(basesFolder + "/" + def.relPath);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof obsidian.TFile) {
        if (overwrite) {
          await this.app.vault.modify(existing, def.yaml);
          updated++;
        } else {
          skipped++;
        }
      } else {
        await this.app.vault.create(path, def.yaml);
        created++;
      }
    }
    return { created, updated, skipped };
  }

  async upsertGeneratedMarkdownFile(path, content, opts = {}) {
    const norm = obsidian.normalizePath(path);
    const folder = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
    if (folder) await ensureVaultFolder(this.app, folder);
    let file = this.app.vault.getAbstractFileByPath(norm);
    if (file instanceof obsidian.TFile) {
      const current = await this.app.vault.cachedRead(file);
      const shouldUpdate = opts.overwrite || current.includes("<!-- lexvoice-generated-wall -->") || current.trim() === "";
      if (shouldUpdate && current !== content) await this.app.vault.modify(file, content);
      return file;
    }
    file = await this.app.vault.create(norm, content);
    return file;
  }

  async openGeneratedMarkdown(path, content, opts = {}) {
    const withMarker = insertGeneratedWallMarker(content);
    const file = await this.upsertGeneratedMarkdownFile(path, withMarker, opts);
    if (file instanceof obsidian.TFile) await this.app.workspace.getLeaf(false).openFile(file);
    return file;
  }

  async openLearningWall(scope = "learning") {
    const isConcept = scope === "concept";
    const fileName = isConcept ? CONCEPT_WALL_FILE : LEARNING_WALL_FILE;
    const content = isConcept ? formatConceptWallMarkdown(this.settings) : formatLearningWallMarkdown(this.settings);
    return await this.openGeneratedMarkdown(getLexVoiceWallPath(this.settings, fileName), content, { overwrite: true });
  }

  async openTodoWall() {
    return await this.openGeneratedMarkdown(getLexVoiceWallPath(this.settings, TODO_WALL_FILE), formatTodoWallMarkdown(this.settings), { overwrite: true });
  }

  async openObjectWall() {
    return await this.openGeneratedMarkdown(getLexVoiceWallPath(this.settings, OBJECT_WALL_FILE), formatObjectWallMarkdown(this.settings), { overwrite: true });
  }

  async openPeopleBase() {
    const file = await this.people.ensurePeopleDirectoryFiles({ overwrite: false });
    if (file instanceof obsidian.TFile) await this.app.workspace.getLeaf(false).openFile(file);
    return file;
  }

  async openLexVoiceDetailBase() {
    await this.createLexVoiceBases({ overwrite: false });
    const path = obsidian.normalizePath(getLexVoiceBasesFolder(this.settings) + "/场景/全部纪要总览.base");
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof obsidian.TFile) await this.app.workspace.getLeaf(false).openFile(file);
    else new obsidian.Notice("未找到明细 Base，请先创建视图文件。", 8000);
    return file;
  }  // 单 mode 生成定制 Prompt：调一次 LLM，返回纯文本
  async generateIndustryPromptForMode(mode) {
    const p = this.settings.industryProfile || {};
    if (!p.industry || !p.scenarios) {
      throw new Error("请先在「AI 整理」填写「行业 / 角色」和「主要工作场景」");
    }
    if (!this.settings.llmApiKey) throw new Error("请先在 API 页配置大模型服务");
    if (!isKnownPolishMode(this.settings, mode)) throw new Error("未知的 mode：" + mode);
    const meta = getModeMeta(this.settings, mode);
    const modeLabel = meta && meta.prefix ? meta.prefix : mode;
    const sys = "你是 Prompt 工程师，专门为真实工作和学习场景生成可直接用于录音整理的 Markdown Prompt。输出要克制、清晰、可维护，不要堆砌 callout。";
    const userMsg = INDUSTRY_META_PROMPT
      .replaceAll("{{INDUSTRY}}", p.industry || "（未指定）")
      .replaceAll("{{SCENARIOS}}", p.scenarios || "（未指定）")
      .replaceAll("{{FOCUS}}", p.focus || "（未指定）")
      .replaceAll("{{OUTPUT_PREFERENCE}}", p.outputPreference || "（未指定）")
      .replaceAll("{{MODE}}", `${mode}（${modeLabel}）`);
    const text = await callLlm(this, sys, userMsg);
    let cleaned = text
      .replace(/^```\w*\s*/, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    if (!cleaned.includes("{{TRANSCRIPT}}")) {
      cleaned = cleaned + "\n\n原始转写：\n{{TRANSCRIPT}}";
    }
    return cleaned;
  }

  // 把生成好的 Prompt 保存为新的自定义提示词；不再覆盖内置提示词。
  async createIndustryPromptVariant(mode, promptText, opts) {
    if (!isKnownPolishMode(this.settings, mode)) throw new Error("未知的 mode：" + mode);
    const moment = window.moment;
    const stamp = moment ? moment().format("YYYY-MM-DD HH:mm") : new Date().toISOString().slice(0, 16);
    const profile = this.settings.industryProfile || {};
    const meta = getModeMeta(this.settings, mode);
    const role = (profile.industry || "自定义").trim();
    const firstScenario = String(profile.scenarios || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || (meta.prefix || "场景");
    const name = (opts && opts.name) || (role + " · " + firstScenario);
    const id = makeCustomPromptModeId(name || "scene");
    const tpl = {
      id,
      mode: id,
      name,
      description: "由角色、任务和输出偏好生成。参考提示词：" + (meta.prefix || meta.label || mode) + "。生成时间：" + stamp,
      baseMode: mode,
      prompt: promptText,
      isBuiltin: false,
      customMode: true,
      source: "ai-prompt-generator",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (!this.settings.promptTemplates) this.settings.promptTemplates = {};
    if (!this.settings.activeTemplateByMode) this.settings.activeTemplateByMode = {};
    const clean = sanitizePromptTemplate(tpl, mode);
    this.settings.promptTemplates[clean.id] = clean;
    this.settings.activeTemplateByMode[clean.id] = clean.id;
    if (!opts || opts.activate !== false) this.settings.polishMode = clean.id;
    if (!this.settings.industryProfile) this.settings.industryProfile = {};
    this.settings.industryProfile.generatedAt = new Date().toISOString();
    await this.saveSettings();
    return clean;
  }

  // 一站式入口：生成 + 入库 + 激活，由调用方决定是否走后台 queue
  async generateAndApplyIndustryPrompt(mode, options) {
    const promptText = await this.generateIndustryPromptForMode(mode);
    const tpl = await this.createIndustryPromptVariant(mode, promptText, options);
    return tpl;
  }

  async extractVocabulary(merge) {
    const p = this.settings.industryProfile || {};
    if (!this.settings.llmApiKey && !canOmitServiceApiKey(this.settings.llmEndpoint)) throw new Error("请先在 API 页配置大模型服务");
    const customPromptBrief = getCustomPromptModeTemplates(this.settings)
      .slice(0, 12)
      .map(t => `- ${t.name || t.id}: ${(t.prompt || t.description || "").replace(/\s+/g, " ").slice(0, 180)}`)
      .join("\n") || "（暂无自定义提示词）";
    const currentMode = getEffectivePolishMode(this.settings, this.settings.polishMode, "meeting");
    const currentMeta = getModeMeta(this.settings, currentMode);
    const sys = "你是 ASR 领域词汇提取助手。请根据用户的工作描述、常用提示词和 QnALog 使用场景，抽取最可能在录音中出现、ASR 容易识别错的专有词，并按固定类别输出。";
    const user = `【用户行业 / 角色】${p.industry || "（未指定）"}

【主要工作场景】
${p.scenarios || "（未指定）"}

【关注点】
${p.focus || "（未指定）"}

【当前默认提示词】
${currentMeta.prefix || currentMeta.label || currentMode}

【自定义提示词摘要】
${customPromptBrief}

【任务】
列出 30–80 个可能高频出现、且值得加入 ASR 热词表的专有词。若能推断出常见误写，也可以列出少量「易错写法 => 标准写法」。若用户背景为空，请根据当前默认提示词与自定义提示词推断；不要编造真实人名、真实公司或隐私信息，可以使用类别化占位词。
- 人名：客户、同事、专家、讲师、候选人、常用称呼
- 品牌/机构：公司、学校、客户、供应商、社区、品牌名
- 项目/产品：项目代号、产品名、模型名、系统名、服务名、插件名
- 行业术语：专业概念、业务流程词、缩写、英文混杂词
- 易错写法：只列非常确定的标准写法映射，例如 open router => OpenRouter；不要虚构真实姓名或真实公司
- 其他专有名词：暂时不好归类但 ASR 容易识别错的词

【输出格式】
严格只输出下面的 Markdown 结构；每行一个词，不加解释。某类没有词也保留标题。「易错写法」只允许使用“错误写法 => 标准写法”。

## 人名
- <词>

## 品牌/机构
- <词>

## 项目/产品
- <词>

## 行业术语
- <词>

## 易错写法
- <错误写法> => <标准写法>

## 其他专有名词
- <词>`;
    const result = await callLlm(this, sys, user);
    const cleaned = result
      .replace(/^```\w*\s*/, "")
      .replace(/\s*```\s*$/, "")
      .replace(/^好的[，,].*?\n/, "")
      .trim();
    let newGroups = parseVocabularyGroups(cleaned);
    let newTerms = flattenVocabularyGroups(newGroups);
    if (!newTerms.length) {
      newGroups = normalizeVocabularyInput(cleaned.split(/\r?\n/)
        .map((s) => s.replace(/^[\d\-*.、]+\s*/, "").replace(/^["「『]|["」』]$/g, "").trim())
        .filter(Boolean));
      newTerms = flattenVocabularyGroups(newGroups);
    }

    let finalGroups = newGroups;
    if (merge) {
      const existing = await loadVocabularyGroups(this);
      finalGroups = mergeVocabularyGroups(existing, newGroups);
    }
    await this.writeVocabularyFile(finalGroups);
    return newTerms;
  }

  async extractVocabularyFromMarkdown(file, markdown) {
    if (!this.settings.llmApiKey && !canOmitServiceApiKey(this.settings.llmEndpoint)) throw new Error("请先在 API 页配置大模型服务");
    const source = String(markdown || "")
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/m, "")
      .slice(0, 18000);
    const sys = "你是 ASR 领域词汇提取助手。请只根据用户当前笔记提取可能提升语音转写准确率的词汇，不要编造，不要输出非指定格式。";
    const user = `请从下面这篇 QnALog 笔记中提取适合加入 ASR 热词表的词汇。

文件名：${file && file.basename ? file.basename : "当前笔记"}

提取规则：
- 只提取笔记中真实出现、后续录音里可能反复出现、且 ASR 容易识别错的词。
- 专有名词优先：人名/称呼、品牌/机构、项目/产品、行业术语、英文缩写、中英混合词。
- 人名只提取姓名或常用称呼，不提取身份号码、手机号、住址、邮箱等隐私字段。
- 人员角色、组织关系和长期备注不要塞进 ASR 热词表；这些应进入人员资料。
- 「易错写法」只写非常确定的映射，例如 open router => OpenRouter。
- 不确定就不要提取。

输出格式：
严格只输出下面的 Markdown 结构；每行一个词，不加解释。某类没有词也保留标题。

## 人名
- <词>

## 品牌/机构
- <词>

## 项目/产品
- <词>

## 行业术语
- <词>

## 易错写法
- <错误写法> => <标准写法>

## 其他专有名词
- <词>

笔记正文：
${source}`;
    const result = await callLlm(this, sys, user, { timeoutMs: 60000 });
    const cleaned = result
      .replace(/^```\w*\s*/, "")
      .replace(/\s*```\s*$/, "")
      .replace(/^好的[，,].*?\n/, "")
      .trim();
    let newGroups = parseVocabularyGroups(cleaned);
    let newTerms = flattenVocabularyGroups(newGroups);
    if (!newTerms.length) {
      newGroups = normalizeVocabularyInput(cleaned.split(/\r?\n/)
        .map((s) => s.replace(/^[\d\-*.、]+\s*/, "").replace(/^["「『]|["」』]$/g, "").trim())
        .filter(Boolean));
      newTerms = flattenVocabularyGroups(newGroups);
    }
    if (!newTerms.length) return [];
    const existing = await loadVocabularyGroups(this);
    await this.writeVocabularyFile(mergeVocabularyGroups(existing, newGroups));
    return newTerms;
  }

  async writeVocabularyFile(terms) {
    const groups = normalizeVocabularyInput(terms);
    const path = this.settings.vocabularyFile;
    if (!path) {
      // 不再静默吞进隐藏的 customVocabulary：提示用户补路径，否则热词在设置里"看不见摸不着"
      this.settings.customVocabulary = flattenVocabularyGroups(groups).join("\n");
      await this.saveSettings();
      try { new obsidian.Notice("未配置热词表路径，本次热词已暂存在插件设置中；请在「设置 → 信息对象 → ASR 热词表」填写路径后重新整理。", 9000); } catch { /* intentionally empty */ }
      return null;
    }
    const norm = obsidian.normalizePath(path);
    const folderPath = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
    if (folderPath) await ensureVaultFolder(this.app, folderPath);
    const content = formatVocabularyMarkdown(groups, this.settings.industryProfile);
    let file = this.app.vault.getAbstractFileByPath(norm);
    if (file instanceof obsidian.TFile) {
      await this.app.vault.modify(file, content);
    } else {
      file = await this.app.vault.create(norm, content);
    }
    return file;
  }  getKnowledgeExtractionSourceFiles(kind) {
    const folder = obsidian.normalizePath(this.settings.mdFolder || DEFAULT_SETTINGS.mdFolder);
    const prefix = folder ? folder + "/" : "";
    return this.app.vault.getMarkdownFiles()
      .filter(file => {
        const path = obsidian.normalizePath(file.path || "");
        if (folder && path !== folder && !path.startsWith(prefix)) return false;
        if (path === obsidian.normalizePath(this.settings.vocabularyFile || "")) return false;
        if (this.settings.peopleDirectoryFolder) {
          const peopleFolder = obsidian.normalizePath(this.settings.peopleDirectoryFolder);
          if (path === peopleFolder || path.startsWith(peopleFolder + "/")) return false;
        }
        return !isKnowledgeSourceAlreadyScanned(this.settings, kind, file);
      })
      .sort((a, b) => (b.stat && b.stat.mtime || 0) - (a.stat && a.stat.mtime || 0));
  }

  markKnowledgeExtractionSource(kind, file) {
    if (!(file instanceof obsidian.TFile)) return;
    const safeKind = kind === "people" ? "people" : "vocabulary";
    const history = normalizeKnowledgeExtractionHistory(this.settings.knowledgeExtractionHistory);
    history[safeKind][obsidian.normalizePath(file.path)] = knowledgeExtractionRecordForFile(file);
    this.settings.knowledgeExtractionHistory = history;
  }

  clearKnowledgeExtractionHistory(kind) {
    const history = normalizeKnowledgeExtractionHistory(this.settings.knowledgeExtractionHistory);
    if (kind === "people" || kind === "vocabulary") history[kind] = {};
    else {
      history.people = {};
      history.vocabulary = {};
    }
    this.settings.knowledgeExtractionHistory = history;
  }  async extractVocabularyFromLibrary() {
    if (!this.settings.llmApiKey && !canOmitServiceApiKey(this.settings.llmEndpoint)) {
      new obsidian.Notice("请先配置大模型服务");
      return { processed: 0, added: 0, failed: 0, remaining: 0 };
    }
    const all = this.getKnowledgeExtractionSourceFiles("vocabulary");
    const batch = all.slice(0, KNOWLEDGE_EXTRACTION_BATCH_LIMIT);
    if (!batch.length) {
      new obsidian.Notice("没有需要扫描的新纪要。修改过的纪要会自动重新进入扫描。");
      return { processed: 0, added: 0, failed: 0, remaining: 0 };
    }
    new obsidian.Notice(`QnALog：正在扫描 ${batch.length} 篇纪要提取词汇…`);
    let processed = 0;
    let added = 0;
    let failed = 0;
    for (const file of batch) {
      try {
        const markdown = await this.app.vault.cachedRead(file);
        const terms = await this.extractVocabularyFromMarkdown(file, markdown);
        added += terms.length;
        processed++;
        this.markKnowledgeExtractionSource("vocabulary", file);
      } catch (e) {
        failed++;
        console.error("[QnALog] library vocabulary extraction failed", file && file.path, e);
      }
    }
    await this.saveSettings();
    return { processed, added, failed, remaining: Math.max(0, all.length - batch.length) };
  }  // 旧入口保留：把历史批量生成结果转成新的自定义提示词，避免覆盖内置提示词
  async applyIndustryPrompts(prompts) {
    const created = [];
    const visible = getBuiltInVisiblePolishModeKeys(this.settings);
    for (const mode of visible) {
      const text = prompts && prompts[mode];
      if (!text) continue;
      try {
        const tpl = await this.createIndustryPromptVariant(mode, text);
        created.push(tpl);
      } catch (e) {
        console.error("[QnALog] createIndustryPromptVariant failed", mode, e);
      }
    }
    return created;
  }  async repolishMarkdownFile(file, mode, repolishOptions = null) {
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") return;
    if (["promotion-review", "recruit", "recruit-needs"].includes(mode) && !isRecruitFeatureUnlocked(this.settings)) {
      new obsidian.Notice("该扩展模式尚未启用");
      return;
    }
    const meta = getModeMeta(this.settings, mode);
    let taskMeter = null;
    // 重新整理必须按来源纪要单飞。否则用户连续切换模式/重复点击时，两个
    // LLM 任务会同时写同一个版本缓存文件，Obsidian 会把后到的 create 请求
    // 拒绝为 "File already exists."，并留下一个看起来仍在运行的重复任务。
    let taskId = `repolish:${file.path}`;
    let taskStarted = false;
    let repolishLockAcquired = false;
    try {
      const content = await this.app.vault.read(file);
      const sourceId = getLexVoiceSourceIdFromMarkdown(content, file);
      taskId = `repolish:${sourceId || file.path}`;
      let segments = extractLexVoiceTranscriptSegments(content);
      if (!segments.length) {
        new obsidian.Notice("未找到 QnALog 原始转写。请在包含「分段原始转写」或录音段落的纪要 Markdown 上使用。", 8000);
        return;
      }

      // 从 frontmatter 解析角色映射（"代号 → 真名" 形式的条目）
      const fmCache = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || null;
      const roleMapping = extractRoleMappingFromFrontmatter(fmCache);
      if (roleMapping.length) {
        segments = applyRoleMappingToSegments(segments, roleMapping);
      }

      // 从 frontmatter 取插件已注入的 time，作为 sessionMeta（避免 LLM 重新推断，保持时间不变）
      let sessionMeta = null;
      if (fmCache) {
        const fullTimeStr = fmCache.time || "";
        const durationStr = fmCache["时长"] || fmCache.duration || "";
        if (fullTimeStr) {
          const m = window.moment ? window.moment(fullTimeStr, [window.moment.ISO_8601, "YYYY-MM-DDTHH:mm:ss", "YYYY-MM-DD HH:mm:ss"], true) : null;
          if (m && m.isValid && m.isValid()) {
            sessionMeta = { startedAt: m.toDate().toISOString(), duration: String(durationStr || "").trim() };
          }
        } else {
          // 兼容旧笔记：早期版本可能写入"日期"和"时间"两个字段；重新整理后会迁移为 time。
          const dateStr = fmCache["日期"] || fmCache.date || "";
          const timeStr = fmCache["时间"] || "";
          if (dateStr) {
            const composed = String(dateStr).trim() + (timeStr ? "T" + String(timeStr).trim() : "");
            const m = window.moment ? window.moment(composed, ["YYYY-MM-DDTHH:mm", "YYYY-MM-DD", "YYYY-MM-DDTHH:mm:ss"], true) : null;
            if (m && m.isValid && m.isValid()) {
              sessionMeta = { startedAt: m.toDate().toISOString(), duration: String(durationStr || "").trim() };
            }
          }
        }
      }

      let recruitContext = null;
      if (mode === "recruit") {
        const result = await new Promise((resolve) => {
          const modal = new RecruitContextModal(this.app, this, {
            flow: "repolish",
            onConfirm: (action, ctx) => resolve({ action, ctx }),
          });
          modal.open();
        });
        if (result.action === "cancel") return;
        recruitContext = result.action === "skip" ? null : result.ctx;
      }

      if (!this._repolishInFlight) this._repolishInFlight = new Set();
      if (this._repolishInFlight.has(taskId)) {
        new obsidian.Notice("这篇纪要正在重新整理，请等待当前任务完成。", 5000);
        return;
      }
      this._repolishInFlight.add(taskId);
      repolishLockAcquired = true;

      const preferenceLabel = repolishOptions && repolishOptions.label ? ` · ${repolishOptions.label}` : "";
      const mapNotice = roleMapping.length
        ? `QnALog：应用 ${roleMapping.length} 条角色映射后按${meta.prefix}模式重新整理${preferenceLabel}…`
        : `QnALog：正在按${meta.prefix}模式重新整理${preferenceLabel}…`;
      new obsidian.Notice(mapNotice);
      // 把笔记原 frontmatter 传给 mergeAndPolish，post-process 阶段会作为 base 保留用户改动
      // （包括用户已应用的角色映射变更，仅 system 字段被覆盖、tags 被 merge）
      const originalFmForRegen = fmCache ? Object.assign({}, fmCache) : null;
      // 在 originalFm 里应用角色映射的"压平"，避免 base 里仍然带 → 形式
      if (originalFmForRegen && roleMapping.length) {
        for (const f of ROLE_MAPPING_FIELDS) {
          const v = originalFmForRegen[f];
          if (Array.isArray(v)) {
            originalFmForRegen[f] = v.map(item => {
              const m = parseRoleMapItem(item);
              return m ? m.to : item;
            });
          } else if (typeof v === "string") {
            const m = parseRoleMapItem(v);
            if (m) originalFmForRegen[f] = m.to;
          }
        }
      }
      this.tasks._busyLabel = `重新整理中（${meta.prefix}）…`;
      const sourceMode = detectRecentNoteMode(this, file, fmCache);
      const sourceModeLabel = sourceMode && sourceMode !== "off"
        ? ((getModeMeta(this.settings, sourceMode) || {}).label || sourceMode)
        : "未标注";
      this.tasks._busyContext = {
        kind: "重新整理",
        sourceFile: file.basename,
        sourceFolder: file.parent && file.parent.path ? file.parent.path : "知识库根目录",
        durationMs: getLexVoiceSegmentsDurationMs(segments) || getSessionMetaDurationMs(sessionMeta),
        sourceModeLabel,
        targetModeLabel: [meta.label || meta.prefix, repolishOptions && repolishOptions.label]
          .filter(Boolean)
          .join(" · "),
      };
      taskStarted = true;
      this.tasks.startTaskActivity({
        id: taskId,
        kind: "repolish",
        title: `重新整理 · ${meta.prefix}`,
        subject: file.path,
        status: "running",
        stage: "llm",
        stageLabel: "AI 重新整理",
        detail: preferenceLabel ? `正在准备原始转写 · ${preferenceLabel.replace(/^\s*·\s*/, "")}` : "正在准备原始转写",
        progress: 3,
        actions: [],
      });
      this.tasks.updateBusyStatus();
      taskMeter = this.tasks.beginTaskMeter();
      sessionMeta = Object.assign({}, sessionMeta || {}, { _taskActivityId: taskId, _taskMeter: taskMeter });
      const polished = await mergeAndPolish(this, segments, mode, recruitContext, sessionMeta, originalFmForRegen, repolishOptions);
      this.tasks.patchTaskActivity(taskId, {
        stage: "writing",
        stageLabel: "正在生成新版本",
        detail: "AI 正文已经完成，正在写入 Markdown",
        progress: 94,
        deadlineAt: 0,
      });

      // 重新整理只生成派生纪要，不重命名、不修改母本。角色映射只作为本次
      // LLM 输入使用，原始转写和用户已经保存的 YAML 必须保持可追溯。
      const dailyTargetFile = file;
      const latestSourceContent = await this.app.vault.read(dailyTargetFile);
      const versionLabel = `${meta.prefix}${preferenceLabel}`;
      const versionStyle = repolishOptions && repolishOptions.label ? repolishOptions.label : "";
      const versionBody = stripModeSuggestionBlocks(polished || buildEmptyLlmOutputFallback()).trim();
      const versionParts = splitLexVoiceVersionPayload(versionBody);
      const fallbackVersion = {
        body: versionParts.body.trim() || buildEmptyLlmOutputFallback(),
        frontmatter: versionParts.frontmatter || "",
        meta: {
          sourceId: getLexVoiceSourceIdFromMarkdown(latestSourceContent, dailyTargetFile),
          createdAt: window.moment ? window.moment().format("YYYY-MM-DD HH:mm:ss") : new Date().toISOString(),
        },
      };

      // 可见副本是用户交付物，必须先落盘；版本缓存/manifest 只是索引，
      // 即使索引写入异常，也不能阻断新纪要生成。
      const derivedFile = await this.versions.createLexVoiceDerivedNote(
        dailyTargetFile,
        latestSourceContent,
        fallbackVersion,
        versionLabel,
        mode,
        versionStyle,
      );
      this.tasks.patchTaskActivity(taskId, {
        stage: "postprocess",
        stageLabel: "正在完成文件处理",
        detail: derivedFile instanceof obsidian.TFile ? derivedFile.path : "新版本已经写入",
        progress: 98,
        deadlineAt: 0,
      });
      await clearCommittedBriefingCheckpoint(this, sessionMeta);
      let versionCacheError = "";
      try {
        await this.versions.saveLexVoiceVersion(dailyTargetFile, latestSourceContent, segments, {
          kind: "minutes",
          label: versionLabel,
          mode,
          style: versionStyle,
          idLabel: `${meta.prefix}${versionStyle ? "-" + versionStyle : ""}`,
          body: versionBody,
          activate: false,
        });
      } catch (cacheError) {
        versionCacheError = getTaskErrorMessage(cacheError);
        console.warn("[QnALog] derived note created but version cache update failed", cacheError);
      }
      try {
        const dailyFile = derivedFile instanceof obsidian.TFile ? derivedFile : dailyTargetFile;
        const dailyContent = await this.app.vault.read(dailyFile);
        await this.appendDailyMeetingOverviewForMarkdown(dailyFile, dailyContent, polished, mode, segments, sessionMeta);
      } catch (e) {
        console.error("[QnALog] daily overview after repolish failed", e);
      }
      const outputPath = derivedFile instanceof obsidian.TFile ? derivedFile.path : dailyTargetFile.path;
      new obsidian.Notice(`QnALog：已生成${meta.prefix}派生纪要${preferenceLabel}${roleMapping.length ? `（角色映射 ${roleMapping.length} 条已应用）` : ""}${versionCacheError ? "（版本索引稍后可重建）" : ""}`);
      const completedTaskMeter = taskMeter ? this.tasks.endTaskMeter(taskMeter) : null;
      taskMeter = null;
      try { this.tasks.logCompletedWork(`重新整理完成 · ${meta.prefix}`, (file && file.path) || "", completedTaskMeter); } catch { /* intentionally empty */ }
      this.tasks.completeTaskActivity(taskId, {
        stage: "done",
        stageLabel: "新版本已生成",
        detail: versionCacheError ? `${outputPath} · 版本索引未同步：${versionCacheError}` : outputPath,
        subject: outputPath,
        progress: 100,
        actions: [
          { id: "open-task-note", label: "打开纪要", primary: true },
          { id: "dismiss-task", label: "关闭记录" },
        ],
      });
    } catch (e) {
      console.error("[QnALog] repolish markdown failed", e);
      if (taskStarted) {
        this.tasks.failTaskActivity(taskId, e, {
          stage: "failed",
          stageLabel: "重新整理未完成",
          detail: getTaskErrorMessage(e),
          subject: file.path,
          actions: [
            { id: "open-task-note", label: "打开原始材料", primary: true },
            { id: "dismiss-task", label: "关闭记录" },
          ],
        });
      }
      new obsidian.Notice(`重新整理失败：${(e && e.message) || e}`, 8000);
    } finally {
      if (repolishLockAcquired && this._repolishInFlight) this._repolishInFlight.delete(taskId);
      if (taskMeter) this.tasks.endTaskMeter(taskMeter);
      this.tasks._busyLabel = null;
      this.tasks._busyContext = null;
      this.tasks.updateBusyStatus();
    }
  }  // 生成清稿（派生版本·只读快照）：从母本逐字稿忠实清理成可读稿，写成独立文件、双链回指母本。
  // 永远从母本 raw 读（在派生上触发会先跳回母本）；清稿不含 raw、不参与「重新整理」回写。
  async generateCleanScript(file) {
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") return;
    let taskMeter = null;
    let taskId = `clean:${file.path}`;
    let taskStarted = false;
    try {
      // 在派生文件上触发 → 先跳回母本（派生 contains_raw:false，本身没有 raw 可读）。
      let sourceFile = file;
      let content = await this.app.vault.read(file);
      const fm = ((this.app.metadataCache.getFileCache(file) || {}).frontmatter) || {};
      if (fm["类型"] === "LexVoice派生版本" || fm.contains_raw === false) {
        const srcPath = fm.source_path ? obsidian.normalizePath(String(fm.source_path)) : "";
        const resolved = srcPath ? this.app.vault.getAbstractFileByPath(srcPath) : null;
        if (resolved instanceof obsidian.TFile) {
          sourceFile = resolved;
          content = await this.app.vault.read(resolved);
        } else {
          new obsidian.Notice("这是派生版本，但来源笔记已被改名或移动。请在原始录音笔记中生成清稿。", 8000);
          return;
        }
      }
      const segments = extractLexVoiceTranscriptSegments(content);
      if (!segments.length) {
        new obsidian.Notice("未找到原始转写（逐字稿）。请在含「分段原始转写」的录音母本上生成清稿。", 8000);
        return;
      }
      const baseTitle = sourceFile.basename;
      taskId = `clean:${sourceFile.path}`;
      this.tasks._busyLabel = "清稿生成中…";
      const sourceFm = ((this.app.metadataCache.getFileCache(sourceFile) || {}).frontmatter) || {};
      const sourceMode = detectRecentNoteMode(this, sourceFile, sourceFm);
      this.tasks._busyContext = {
        kind: "生成清稿",
        sourceFile: sourceFile.basename,
        sourceFolder: sourceFile.parent && sourceFile.parent.path ? sourceFile.parent.path : "知识库根目录",
        durationMs: getLexVoiceSegmentsDurationMs(segments),
        sourceModeLabel: sourceMode && sourceMode !== "off"
          ? ((getModeMeta(this.settings, sourceMode) || {}).label || sourceMode)
          : "未标注",
        targetModeLabel: "清稿",
      };
      taskStarted = true;
      this.tasks.startTaskActivity({
        id: taskId,
        kind: "clean-transcript",
        title: "生成清稿",
        subject: sourceFile.path,
        status: "running",
        stage: "llm",
        stageLabel: "整理逐字稿",
        detail: "去除口语赘词并保留原始事实，不覆盖母本",
        progress: null,
        actions: [],
      });
      this.tasks.updateBusyStatus();
      new obsidian.Notice("QnALog：正在从母本逐字稿生成清稿…");
      taskMeter = this.tasks.beginTaskMeter();
      const { text: cleaned, truncated } = await cleanTranscript(this, segments, getLearnedLlmOutputCeiling(this.settings));
      if (!cleaned) throw new Error("模型没有返回可用清稿");
      const warn = truncated
        ? "> [!warning] 清稿可能被截断：部分内容或因模型输出上限未完整。建议换更大输出上限的模型后重新生成。\n\n"
        : "";
      const noteBody = `# [清稿] ${baseTitle}\n\n> [!note] 从母本逐字稿忠实清理的可读稿（非纪要、不摘要）。母本（事实源 / 逐字稿）：[[${baseTitle}]]\n\n${warn}${cleaned}`;
      const version = await this.versions.saveLexVoiceVersion(sourceFile, content, segments, {
        kind: "clean",
        label: "清稿",
        mode: "cleanscript",
        style: "",
        idLabel: "清稿",
        body: noteBody,
      });
      await this.versions.applyLexVoiceVersionToSource(sourceFile, version.meta, version.body, version.frontmatter);
      new obsidian.Notice("QnALog：清稿已生成并设为当前显示版本", 6000);
      const completedTaskMeter = taskMeter ? this.tasks.endTaskMeter(taskMeter) : null;
      taskMeter = null;
      try { this.tasks.logCompletedWork("生成清稿", sourceFile.path || "", completedTaskMeter); } catch { /* intentionally empty */ }
      this.tasks.completeTaskActivity(taskId, {
        stage: "done",
        stageLabel: "清稿已生成",
        detail: sourceFile.path,
        actions: [
          { id: "open-task-note", label: "打开母本", primary: true },
          { id: "dismiss-task", label: "关闭记录" },
        ],
      });
      try { await this.app.workspace.getLeaf(false).openFile(sourceFile); } catch { /* intentionally empty */ }
    } catch (e) {
      console.error("[QnALog] generate clean script failed", e);
      if (taskStarted) {
        this.tasks.failTaskActivity(taskId, e, {
          stage: "failed",
          stageLabel: "清稿未生成",
          detail: getTaskErrorMessage(e),
          actions: [
            { id: "open-task-note", label: "打开母本", primary: true },
            { id: "dismiss-task", label: "关闭记录" },
          ],
        });
      }
      new obsidian.Notice(`清稿生成失败：${(e && e.message) || e}`, 8000);
    } finally {
      if (taskMeter) this.tasks.endTaskMeter(taskMeter);
      this.tasks._busyLabel = null;
      this.tasks._busyContext = null;
      this.tasks.updateBusyStatus();
    }
  }

  getExternalInboxStatePath() {
    const pluginDir = String(this.manifest && this.manifest.dir
      ? this.manifest.dir
      : `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    return obsidian.normalizePath(`${pluginDir}/external-inbox-state.json`);
  }

  getExternalInboxRuntime() {
    const fsModule = getDesktopModule("fs");
    const pathModule = getDesktopModule("path");
    const promises = fsModule && fsModule.promises;
    if (!promises || typeof promises.readdir !== "function" || typeof promises.stat !== "function" || !pathModule) {
      return null;
    }
    return {
      fsModule,
      promises,
      pathModule,
      fileSystem: {
        join: (...parts) => pathModule.join(...parts),
        readdir: async (folderPath) => {
          const entries = await promises.readdir(folderPath, { withFileTypes: true });
          return entries.map((entry) => ({
            name: String(entry && entry.name || ""),
            isFile: !!(entry && typeof entry.isFile === "function" && entry.isFile()),
            isDirectory: !!(entry && typeof entry.isDirectory === "function" && entry.isDirectory()),
          }));
        },
        stat: async (filePath) => {
          const stat = await promises.stat(filePath);
          return {
            size: Math.max(0, Number(stat && stat.size) || 0),
            mtimeMs: Math.max(0, Number(stat && stat.mtimeMs) || 0),
            isFile: !!(stat && typeof stat.isFile === "function" && stat.isFile()),
          };
        },
      },
    };
  }

  async chooseExternalInboxFolder() {
    if (isLexVoiceMobileRuntime()) {
      new obsidian.Notice("电脑文件夹自动导入仅支持桌面端");
      return "";
    }
    let dialog = null;
    const electron = getDesktopModule("electron");
    if (electron && electron.dialog) dialog = electron.dialog;
    if (!dialog && electron && electron.remote && electron.remote.dialog) dialog = electron.remote.dialog;
    if (!dialog) {
      const remote = getDesktopModule("@electron/remote");
      if (remote && remote.dialog) dialog = remote.dialog;
    }
    if (!dialog || typeof dialog.showOpenDialog !== "function") {
      new obsidian.Notice("当前桌面环境无法打开文件夹选择器，请直接粘贴同步文件夹路径");
      return "";
    }
    const result = await dialog.showOpenDialog({
      title: "选择自动导入文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) return "";
    return String(result.filePaths[0]);
  }

  async loadExternalInboxLedger() {
    if (this._externalInboxLedger) return this._externalInboxLedger;
    const adapter = this.app.vault.adapter;
    const statePath = this.getExternalInboxStatePath();
    let ledger = createExternalInboxLedger();
    try {
      if (await adapter.exists(statePath)) {
        ledger = normalizeExternalInboxLedger(JSON.parse(await adapter.read(statePath)));
      }
    } catch (e) {
      console.error("[QnALog] external inbox state read failed", e);
    }
    let recovered = false;
    for (const entry of Object.values(ledger.entries)) {
      if (entry.status !== "processing") continue;
      entry.status = "failed";
      entry.nextRetryAt = 0;
      entry.error = "上次处理在插件关闭前未完成";
      entry.updatedAt = Date.now();
      recovered = true;
    }
    this._externalInboxLedger = ledger;
    if (recovered) await this.saveExternalInboxLedger();
    return ledger;
  }

  async saveExternalInboxLedger() {
    if (!this._externalInboxLedger) return;
    const adapter = this.app.vault.adapter;
    this._externalInboxLedger = pruneExternalInboxLedger(this._externalInboxLedger);
    try {
      await adapter.write(this.getExternalInboxStatePath(), JSON.stringify(this._externalInboxLedger, null, 2));
    } catch (e) {
      console.error("[QnALog] external inbox state write failed", e);
    }
  }

  closeExternalInboxWatcher() {
    try { if (this._externalInboxWatcher) this._externalInboxWatcher.close(); } catch { /* intentionally empty */ }
    this._externalInboxWatcher = null;
    this._externalInboxWatchedPath = "";
    if (this._externalInboxEventTimer) window.clearTimeout(this._externalInboxEventTimer);
    this._externalInboxEventTimer = null;
    if (this._externalInboxStabilityTimer) window.clearTimeout(this._externalInboxStabilityTimer);
    this._externalInboxStabilityTimer = null;
  }

  refreshExternalInboxWatcher() {
    const folder = String(this.settings.inboxFolder || "").trim();
    const enabled = !!this.settings.inboxAutoImport && isAbsoluteExternalInboxPath(folder) && !isLexVoiceMobileRuntime();
    if (!enabled) {
      this.closeExternalInboxWatcher();
      return;
    }
    if (this._externalInboxWatcher && this._externalInboxWatchedPath === folder) return;
    this.closeExternalInboxWatcher();
    const runtime = this.getExternalInboxRuntime();
    if (!runtime || !runtime.fsModule || typeof runtime.fsModule.watch !== "function") return;
    const onChange = () => {
      if (this._externalInboxEventTimer) window.clearTimeout(this._externalInboxEventTimer);
      this._externalInboxEventTimer = window.setTimeout(() => {
        this._externalInboxEventTimer = null;
        void this.scanExternalInboxFolder({ manual: false, source: "event" });
      }, 1200);
    };
    try {
      try {
        this._externalInboxWatcher = runtime.fsModule.watch(folder, { persistent: false, recursive: true }, onChange);
      } catch {
        this._externalInboxWatcher = runtime.fsModule.watch(folder, { persistent: false }, onChange);
      }
      this._externalInboxWatchedPath = folder;
      if (this._externalInboxWatcher && typeof this._externalInboxWatcher.on === "function") {
        this._externalInboxWatcher.on("error", (error) => {
          console.warn("[QnALog] external inbox watcher error", error);
          this.closeExternalInboxWatcher();
        });
      }
    } catch (e) {
      console.warn("[QnALog] external inbox watcher unavailable; polling remains active", e);
    }
  }

  isForegroundAudioWorkActive() {
    const recorderState = this.recorder && this.recorder.state;
    return !!(
      (recorderState && recorderState !== "idle")
      || this.tasks._importBusy
      || (this.session && !this.session.finalized)
    );
  }

  externalInboxActivityId(file) {
    return `external-inbox:${file.fingerprint}`;
  }

  markExternalInboxWaiting(file, detail) {
    const id = this.externalInboxActivityId(file);
    const current = this.tasks.taskActivityStore && this.tasks.taskActivityStore.get(id);
    const patch = {
      id,
      kind: "external-audio-import",
      title: `自动导入 · ${file.name}`,
      subject: file.name,
      status: "waiting",
      stage: "waiting-source",
      stageLabel: "等待导入",
      detail,
      progress: 5,
    };
    if (current) this.tasks.patchTaskActivity(id, patch);
    else this.tasks.startTaskActivity(patch);
  }

  async scanExternalInboxFolder(options = {}) {
    const manual = !!options.manual;
    const folder = String(this.settings.inboxFolder || "").trim();
    if (!isAbsoluteExternalInboxPath(folder)) {
      if (manual) new obsidian.Notice("当前来源不是电脑文件夹");
      return { queued: 0, waiting: 0, skipped: 0 };
    }
    if (isLexVoiceMobileRuntime()) {
      if (manual) new obsidian.Notice("电脑文件夹自动导入仅支持桌面端");
      return { queued: 0, waiting: 0, skipped: 0 };
    }
    if (this._externalInboxScanPromise) return this._externalInboxScanPromise;
    const run = (async () => {
      const runtime = this.getExternalInboxRuntime();
      if (!runtime) throw new Error("当前桌面环境无法读取电脑文件夹");
      if (!this.externalInboxScanner) this.externalInboxScanner = new ExternalInboxScanner();
      const quietMs = Math.max(3000, Number(this.settings.inboxStabilizeDelayMs) || 0);
      const result = await this.externalInboxScanner.scan(runtime.fileSystem, folder, AUDIO_EXT, {
        quietMs,
        maxDepth: 6,
        maxFiles: 2000,
      });
      if (result.waiting.length && !this._externalInboxStabilityTimer) {
        this._externalInboxStabilityTimer = window.setTimeout(() => {
          this._externalInboxStabilityTimer = null;
          void this.scanExternalInboxFolder({ manual: false, source: "stability-check" });
        }, quietMs + 500);
      }
      if (result.errors.length && result.scanned === 0) {
        const first = result.errors[0];
        throw new Error(first && first.message ? first.message : "无法读取自动导入文件夹");
      }
      const ledger = await this.loadExternalInboxLedger();
      const now = Date.now();
      for (const file of result.waiting.slice(0, 20)) {
        this.markExternalInboxWaiting(file, "等待文件同步完成");
        if (!ledger.entries[file.fingerprint]) {
          ledger.entries[file.fingerprint] = {
            fingerprint: file.fingerprint,
            fullPath: file.fullPath,
            name: file.name,
            size: file.size,
            mtimeMs: file.mtimeMs,
            status: "waiting",
            attempts: 0,
            firstSeenAt: now,
            updatedAt: now,
            nextRetryAt: 0,
            notePath: "",
            error: "",
          };
        }
      }
      const scheduled = this._externalInboxScheduled || (this._externalInboxScheduled = new Set());
      const candidates = result.ready.filter((file) =>
        !scheduled.has(file.fingerprint)
        && shouldImportExternalInboxFile(file, ledger, { manual, now, maxAttempts: 3 }));
      if (this.isForegroundAudioWorkActive()) {
        for (const file of candidates.slice(0, 20)) this.markExternalInboxWaiting(file, "当前正在录音，录音结束后自动处理");
        await this.saveExternalInboxLedger();
        if (manual && candidates.length) new obsidian.Notice(`发现 ${candidates.length} 个音频；当前正在录音，稍后自动处理`);
        return { queued: 0, waiting: result.waiting.length + candidates.length, skipped: result.ready.length - candidates.length };
      }
      for (const file of candidates) {
        scheduled.add(file.fingerprint);
        const existing = ledger.entries[file.fingerprint];
        ledger.entries[file.fingerprint] = Object.assign({
          fingerprint: file.fingerprint,
          fullPath: file.fullPath,
          name: file.name,
          size: file.size,
          mtimeMs: file.mtimeMs,
          status: "waiting",
          attempts: 0,
          firstSeenAt: now,
          updatedAt: now,
          nextRetryAt: 0,
          notePath: "",
          error: "",
        }, existing || {}, {
          fullPath: file.fullPath,
          name: file.name,
          size: file.size,
          mtimeMs: file.mtimeMs,
          status: "waiting",
          updatedAt: now,
        });
        this.markExternalInboxWaiting(file, "已发现新音频，等待处理");
        this._externalInboxLock = (this._externalInboxLock || Promise.resolve())
          .then(() => this.processExternalInboxFile(file))
          .catch((error) => console.error("[QnALog] external inbox queue error", error));
      }
      await this.saveExternalInboxLedger();
      if (manual) {
        if (candidates.length) new obsidian.Notice(`发现 ${candidates.length} 个新音频，已加入处理队列`);
        else if (result.waiting.length) new obsidian.Notice(`${result.waiting.length} 个音频仍在同步，稍后自动处理`);
        else new obsidian.Notice("没有新的音频文件");
      }
      if (result.truncated) new obsidian.Notice("自动导入文件夹超过 2000 个音频，本次只扫描前 2000 个", 8000);
      return { queued: candidates.length, waiting: result.waiting.length, skipped: result.ready.length - candidates.length };
    })();
    this._externalInboxScanPromise = run;
    try {
      return await run;
    } catch (e) {
      await this.diagnostics.logDiagnostic("error", "inbox.external_scan_failed", "外部音频文件夹扫描失败", {
        source: options.source || "manual",
        error: diagnosticError(e),
      });
      if (manual) new obsidian.Notice(`扫描失败：${getTaskErrorMessage(e)}`, 8000);
      return { queued: 0, waiting: 0, skipped: 0 };
    } finally {
      if (this._externalInboxScanPromise === run) this._externalInboxScanPromise = null;
    }
  }

  async copyExternalInboxFileToCache(file) {
    const runtime = this.getExternalInboxRuntime();
    if (!runtime) throw new Error("当前桌面环境无法读取电脑文件夹");
    await this.ensureSegmentCacheFolder();
    const safeStem = sanitizeFilename(String(file.name || "audio").replace(/\.[^.]+$/, "")) || "audio";
    const extension = String(file.extension || "audio").toLowerCase();
    const cacheName = `${file.fingerprint}-${safeStem}.${extension}`;
    const cachePath = obsidian.normalizePath(`${this.getSegmentCacheFolder()}/${cacheName}`);
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(cachePath)) await adapter.remove(cachePath);
    const fullCachePath = typeof adapter.getFullPath === "function" ? adapter.getFullPath(cachePath) : "";
    if (fullCachePath && typeof runtime.promises.copyFile === "function") {
      await runtime.promises.copyFile(file.fullPath, fullCachePath);
    } else {
      const bytes = await runtime.promises.readFile(file.fullPath);
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      await adapter.writeBinary(cachePath, arrayBuffer);
    }
    const current = await runtime.fileSystem.stat(file.fullPath);
    if (current.size !== file.size || current.mtimeMs !== file.mtimeMs) {
      try { if (await adapter.exists(cachePath)) await adapter.remove(cachePath); } catch { /* intentionally empty */ }
      const changed = new Error("文件仍在同步，稍后重试");
      changed.code = "EXTERNAL_FILE_CHANGED";
      throw changed;
    }
    const copied = await adapter.stat(cachePath);
    if (!copied || Number(copied.size) !== file.size) {
      try { if (await adapter.exists(cachePath)) await adapter.remove(cachePath); } catch { /* intentionally empty */ }
      throw new Error("临时音频复制不完整，稍后重试");
    }
    return cachePath;
  }

  async processExternalInboxFile(file) {
    const scheduled = this._externalInboxScheduled || (this._externalInboxScheduled = new Set());
    const ledger = await this.loadExternalInboxLedger();
    const activityId = this.externalInboxActivityId(file);
    let cachePath = "";
    try {
      if (this.isForegroundAudioWorkActive()) {
        this.markExternalInboxWaiting(file, "当前正在录音，录音结束后自动处理");
        return;
      }
      const now = Date.now();
      const previous = ledger.entries[file.fingerprint];
      const attempt = Math.max(0, Number(previous && previous.attempts) || 0) + 1;
      ledger.entries[file.fingerprint] = Object.assign({}, previous || {}, {
        fingerprint: file.fingerprint,
        fullPath: file.fullPath,
        name: file.name,
        size: file.size,
        mtimeMs: file.mtimeMs,
        status: "processing",
        attempts: attempt,
        firstSeenAt: Number(previous && previous.firstSeenAt) || now,
        updatedAt: now,
        nextRetryAt: 0,
        error: "",
      });
      await this.saveExternalInboxLedger();
      this.tasks.patchTaskActivity(activityId, {
        status: "running",
        stage: "copying-source",
        stageLabel: "读取音频",
        detail: "正在读取同步文件",
        progress: 10,
        attempt,
        maxAttempts: 3,
      });
      cachePath = await this.copyExternalInboxFileToCache(file);
      this.tasks.patchTaskActivity(activityId, {
        status: "running",
        stage: "transcribing",
        stageLabel: "转写与整理",
        detail: "音频已就绪，正在生成纪要",
        progress: 20,
      });
      await this.diagnostics.logDiagnostic("info", "inbox.external_import_started", "开始自动导入外部音频", {
        audioName: file.name,
        size: file.size,
        fingerprint: file.fingerprint,
      });
      const result = await this.importAudioFiles([cachePath], "synthesis", {
        externalSource: {
          name: file.name,
          fingerprint: file.fingerprint,
        },
      });
      const entry = ledger.entries[file.fingerprint];
      const pendingTranscriptionCount = Math.max(0, Number(result && result.pendingTranscriptionCount) || 0);
      entry.status = "imported";
      entry.updatedAt = Date.now();
      entry.nextRetryAt = 0;
      entry.notePath = result && result.mdPath ? result.mdPath : "";
      entry.error = "";
      await this.saveExternalInboxLedger();
      this.tasks.completeTaskActivity(activityId, {
        stage: "done",
        stageLabel: pendingTranscriptionCount ? "纪要已创建" : "自动导入完成",
        detail: pendingTranscriptionCount
          ? `纪要已创建；${pendingTranscriptionCount} 个片段已保留并等待转写重试`
          : entry.notePath ? `纪要已写入 ${entry.notePath}` : "纪要已写入库中",
        progress: 100,
      });
      await this.diagnostics.logDiagnostic("info", "inbox.external_import_completed", "外部音频自动导入完成", {
        audioName: file.name,
        size: file.size,
        fingerprint: file.fingerprint,
        mdPath: entry.notePath,
      });
    } catch (e) {
      this.tasks._importBusy = null;
      this.tasks.updateBusyStatus();
      const entry = ledger.entries[file.fingerprint] || {
        fingerprint: file.fingerprint,
        fullPath: file.fullPath,
        name: file.name,
        size: file.size,
        mtimeMs: file.mtimeMs,
        attempts: 1,
        firstSeenAt: Date.now(),
      };
      const changedWhileSyncing = e && e.code === "EXTERNAL_FILE_CHANGED";
      const attemptIndex = Math.max(0, Math.min(EXTERNAL_INBOX_RETRY_DELAYS_MS.length - 1, (Number(entry.attempts) || 1) - 1));
      entry.status = changedWhileSyncing ? "waiting" : "failed";
      entry.updatedAt = Date.now();
      entry.nextRetryAt = Date.now() + (changedWhileSyncing ? 30_000 : EXTERNAL_INBOX_RETRY_DELAYS_MS[attemptIndex]);
      entry.notePath = entry.notePath || "";
      entry.error = getTaskErrorMessage(e);
      ledger.entries[file.fingerprint] = entry;
      await this.saveExternalInboxLedger();
      if (changedWhileSyncing) {
        this.markExternalInboxWaiting(file, "文件仍在同步，稍后自动处理");
      } else {
        this.tasks.failTaskActivity(activityId, e, {
          stage: "failed",
          stageLabel: "自动导入未完成",
          detail: entry.error,
          actions: [{ id: "open-settings", label: "检查设置" }],
        });
      }
      await this.diagnostics.logDiagnostic("error", "inbox.external_import_failed", "外部音频自动导入失败", {
        audioName: file.name,
        size: file.size,
        fingerprint: file.fingerprint,
        attempt: entry.attempts,
        retryAt: entry.nextRetryAt,
        error: diagnosticError(e),
      });
    } finally {
      scheduled.delete(file.fingerprint);
      if (cachePath) {
        try { await this.maybeDeleteSegmentCacheFile(cachePath, undefined, true); } catch { /* queue references keep required retry files */ }
      }
    }
  }

  async handleInboxFile(file) {
    if (!(file instanceof obsidian.TFile)) return;
    if (!AUDIO_EXT.has((file.extension || "").toLowerCase())) return;
    const inbox = this.settings.inboxFolder;
    if (!inbox || isAbsoluteExternalInboxPath(inbox)) return;
    const inboxNorm = obsidian.normalizePath(inbox);
    if (!file.path.startsWith(inboxNorm + "/") && file.path !== inboxNorm) return;
    const archiveSub = this.settings.inboxArchiveSubfolder || "";
    if (archiveSub && file.path.startsWith(`${inboxNorm}/${archiveSub}/`)) return;
    // 坚果云 / Dropbox / OneDrive 同步冲突文件检测：跳过自动处理，提醒用户解冲突
    if (isSyncConflictName(file.name)) {
      this._inboxConflictNotified = this._inboxConflictNotified || new Set();
      if (!this._inboxConflictNotified.has(file.path)) {
        this._inboxConflictNotified.add(file.path);
        new obsidian.Notice(`同步冲突文件已跳过：${file.name}\n请手动解决冲突后再处理。`, 8000);
        console.warn("[QnALog] skipped sync conflict file:", file.path);
      }
      return;
    }
    if (!this.settings.inboxAutoImport) return;

    // 显式判断而非 || 3000：让"填 0 = 立即处理"真正生效（0 是合法值，|| 会把它吞成 3000）
    const rawDelay = Number(this.settings.inboxStabilizeDelayMs);
    const delay = Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 3000;
    this._inboxPending = this._inboxPending || new Map();
    const previous = this._inboxPending.get(file.path);
    if (previous && previous.timer) window.clearTimeout(previous.timer);
    const observedSize = Math.max(0, Number(file.stat && file.stat.size) || 0);
    const observedMtime = Math.max(0, Number(file.stat && file.stat.mtime) || 0);
    const timer = window.setTimeout(() => {
      this._inboxPending.delete(file.path);
      const fresh = this.app.vault.getAbstractFileByPath(file.path);
      if (!(fresh instanceof obsidian.TFile)) return;
      const freshSize = Math.max(0, Number(fresh.stat && fresh.stat.size) || 0);
      const freshMtime = Math.max(0, Number(fresh.stat && fresh.stat.mtime) || 0);
      if (freshSize <= 0) return;
      if (freshSize !== observedSize || freshMtime !== observedMtime) {
        void this.handleInboxFile(fresh);
        return;
      }
      this._inboxProcessing = this._inboxProcessing || new Set();
      if (this._inboxProcessing.has(file.path)) return;
      this._inboxProcessing.add(file.path);
      this._inboxLock = (this._inboxLock || Promise.resolve()).then(async () => {
        new obsidian.Notice(`发现新音频：${file.name}，正在生成纪要…`);
        try {
          await this.importAudioFiles([file.path]);
          if (archiveSub) {
            await ensureVaultFolder(this.app, `${inboxNorm}/${archiveSub}`);
            const archivePath = findAvailableVaultPath(this.app, obsidian.normalizePath(`${inboxNorm}/${archiveSub}/${file.name}`));
            const stillExists = this.app.vault.getAbstractFileByPath(file.path);
            if (archivePath && stillExists instanceof obsidian.TFile) {
              try { await this.app.fileManager.renameFile(stillExists, archivePath); }
              catch (e) { console.error("[QnALog] archive rename failed", e); }
            }
          }
        } catch (e) {
          console.error("[QnALog] inbox auto-import failed", e);
          new obsidian.Notice(`自动导入未完成：${e.message || e}`);
        } finally {
          this._inboxProcessing.delete(file.path);
        }
      }).catch((e) => {
        this._inboxProcessing.delete(file.path);
        console.error("[QnALog] inbox queue error", e);
      });
    }, delay);
    this._inboxPending.set(file.path, { timer, size: observedSize, mtime: observedMtime });
  }

  async scanInboxFolder() {
    const inbox = this.settings.inboxFolder;
    if (!inbox) { new obsidian.Notice("未配置监听文件夹"); return; }
    if (isAbsoluteExternalInboxPath(inbox)) {
      return this.scanExternalInboxFolder({ manual: true, source: "command" });
    }
    const inboxNorm = obsidian.normalizePath(inbox);
    const folder = this.app.vault.getAbstractFileByPath(inboxNorm);
    if (!(folder instanceof obsidian.TFolder)) {
      new obsidian.Notice(`监听文件夹不存在：${inboxNorm}`);
      return;
    }
    const archiveSub = this.settings.inboxArchiveSubfolder || "";
    const allChildren = folder.children.filter((f) =>
      f instanceof obsidian.TFile
      && AUDIO_EXT.has((f.extension || "").toLowerCase())
      && (!archiveSub || !f.path.startsWith(`${inboxNorm}/${archiveSub}/`))
    );
    const conflicts = allChildren.filter(f => isSyncConflictName(f.name));
    const candidates = allChildren.filter(f => !isSyncConflictName(f.name));
    if (conflicts.length) new obsidian.Notice(`跳过 ${conflicts.length} 个同步冲突文件，请手动解决`, 8000);
    if (!candidates.length) { new obsidian.Notice("监听文件夹中没有未处理文件"); return; }
    new obsidian.Notice(`发现 ${candidates.length} 个未处理文件，开始排队…`);
    for (const f of candidates) await this.handleInboxFile(f);
  }

  openAudioImportOptions(paths, modeOverride) {
    const selectedPaths = Array.isArray(paths) ? paths.filter(Boolean) : [];
    if (!selectedPaths.length) return;
    const modal = new AudioImportOptionsModal(this.app, this, {
      paths: selectedPaths,
      mode: modeOverride || this.settings.polishMode,
      onConfirm: async (selection) => {
        await this.importAudioFiles(selectedPaths, selection.mode, {
          speakerDiarization: selection.speakerDiarization,
          speakerCount: selection.speakerCount,
        });
      },
    });
    modal.open();
  }
  async importAudioFiles(paths, modeOverride, options = {}) {
    if (!paths || !paths.length) return;
    paths.sort();
    const externalSource = options && options.externalSource
      ? {
        name: String(options.externalSource.name || "").trim(),
        fingerprint: String(options.externalSource.fingerprint || "").trim(),
      }
      : null;
    const importProvider = resolveImportTranscribeProvider(this);
    const importProfile = this.getTranscribeProviderProfile(importProvider.id, importProvider);
    const providerSupportsSpeakerDiarization = !!(importProfile && importProfile.speakerDiarization)
      || isSpeakerDiarizationProvider(importProvider)
      || isDashScopeFileTransProvider(importProvider);
    const requestedSpeakerDiarization = typeof options.speakerDiarization === "boolean"
      ? options.speakerDiarization
      : this.settings.importSpeakerDiarization !== false;
    const speakerDiarization = requestedSpeakerDiarization
      && providerSupportsSpeakerDiarization;
    const requestedSpeakerCount = Object.prototype.hasOwnProperty.call(options, "speakerCount")
      ? options.speakerCount
      : this.settings.importSpeakerCount;
    const speakerCount = speakerDiarization && isDashScopeFileTransProvider(importProvider)
      ? normalizeRequestedSpeakerCount(requestedSpeakerCount)
      : 0;
    const speakerModeLabel = speakerDiarization
      ? ` · 区分说话人${speakerCount > 0 ? `（预计 ${speakerCount} 人）` : "（自动识别人数）"}`
      : "";
    const moment = window.moment;
    const startedAt = moment();
    const sessionStamp = startedAt.format("YYYYMMDD-HHmmss");
    const requestedMode = modeOverride && isKnownPolishMode(this.settings, modeOverride)
      ? modeOverride
      : (this.settings.polishMode || "meeting");
    const mode = getEffectivePolishMode(this.settings, requestedMode);
    const meta = getModeMeta(this.settings, mode);
    const mdName = `${startedAt.format(this.settings.noteFileNameFormatNew)} · 导入`;
    const mdPath = this.getAvailableMarkdownPath(obsidian.normalizePath(`${this.settings.mdFolder}/${mdName}.md`));
    await ensureVaultFolder(this.app, this.settings.mdFolder);

    let recruitContext = null;
    if (mode === "recruit") {
      const result = await new Promise((resolve) => {
        const modal = new RecruitContextModal(this.app, this, {
          flow: "import",
          onConfirm: (action, ctx) => resolve({ action, ctx }),
        });
        modal.open();
      });
      if (result.action === "cancel") {
        new obsidian.Notice("已取消导入");
        return;
      }
      if (result.action !== "skip") recruitContext = result.ctx;
    }

    const session = {
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
      recruitContext,
      externalAudioSource: externalSource,
      importTranscribeProviderId: importProvider.id,
      importSpeakerDiarization: speakerDiarization,
      importSpeakerCount: speakerCount,
    };

    const header = [
      `# ${startedAt.format("YYYY-MM-DD HH:mm")} · ${meta.prefix}（导入处理中…）`,
      "",
      "> [!info] 导入信息",
      `> 文件数：${paths.length} · 模式：${meta.prefix} · 转写：整文件${speakerModeLabel}`,
      `> 模型：${importProvider.model || importProvider.id} → ${this.settings.llmModel}`,
      externalSource && externalSource.name ? `> 来源：自动导入 · ${externalSource.name}` : null,
      "",
      `<!-- lexvoice-session:${session.id} -->`,
      `<!-- lexvoice-segments-start:${session.id} -->`,
      `<!-- lexvoice-segments-end:${session.id} -->`,
      "",
    ].filter((line) => line !== null).join("\n");
    await this.noteWriter.appendToNote(mdPath, header);

    new obsidian.Notice(`开始导入 ${paths.length} 个音频文件…`);
    const importStartedAt = Date.now();
    this.tasks._importBusy = {
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
    this.tasks.updateImportActivity({
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
      const indexedFile = this.app.vault.getAbstractFileByPath(audioPath);
      const externalCache = !!externalSource && this.isSegmentCachePath(audioPath);
      const adapter = this.app.vault.adapter;
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
      this.tasks.updateImportActivity({
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
          ? await this.app.vault.readBinary(indexedFile)
          : await adapter.readBinary(obsidian.normalizePath(audioPath));
        if (!ab || ab.byteLength === 0) {
          new obsidian.Notice(`跳过：${displayName} 是空文件（0 字节）。请确认文件已完整下载后再试。`, 9000);
          await this.diagnostics.logDiagnostic("warn", "import.empty_file", "导入音频为空文件", { audioName: displayName, size: 0 });
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
      this.tasks.updateImportActivity({
        phase: "transcribe",
        activeSegments: 1,
        requests: upsertActivityRequest(
          Array.isArray(this.tasks._importBusy && this.tasks._importBusy.requests) ? this.tasks._importBusy.requests : [],
          {
            key: requestKey,
            chunkIndex: i,
            chunkCount: paths.length,
            status: "requesting",
            attempt: 1,
            maxAttempts: Math.max(1, Number(this.settings.maxRetries) || 3),
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
        result = await transcribeImportedAudio(this, blob, mime, {
          providerId: importProvider.id,
          diarization: speakerDiarization,
          speakerCount,
          fileName: displayName,
          audioDurationMs: durationMs,
          onProgress: (progress) => {
            const phaseChanged = progress.phase !== lastImportProgressPhase;
            lastImportProgressPhase = progress.phase;
            const requests = upsertActivityRequest(
              Array.isArray(this.tasks._importBusy && this.tasks._importBusy.requests) ? this.tasks._importBusy.requests : [],
              {
                key: requestKey,
                chunkIndex: i,
                chunkCount: paths.length,
                status: "requesting",
                updatedAt: Date.now(),
              },
              400,
            );
            this.tasks.updateImportActivity({
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
          await this.diagnostics.logDiagnostic("warn", "asr.import_speaker_count_mismatch", mismatchMessage, {
            provider: importProvider.id,
            model: importProvider.model || "",
            audioName: displayName,
            requestedSpeakerCount: speakerCount,
            detectedSpeakerCount: detectedSpeakerIds.length,
            detectedSpeakerIds,
          });
          this.tasks.updateImportActivity({
            event: {
              stageId: "transcribe",
              type: "speaker-count-mismatch",
              label: mismatchMessage,
              detail: "不同说话人的声音可能较接近或存在较多重叠，建议核对原始转写。",
            },
          });
        }
        successfulTranscriptions++;
        this.tasks.updateImportRequest({
          key: requestKey,
          chunkIndex: i,
          chunkCount: paths.length,
          status: "done",
          updatedAt: Date.now(),
          deadlineAt: 0,
          receivedChars: String(result.text || "").length,
          error: "",
        });
        this.tasks.updateImportActivity({
          activeSegments: 0,
          segmentDone: Math.max(0, Number(this.tasks._importBusy && this.tasks._importBusy.segmentDone) || 0) + 1,
        });
        if (externalSource) {
          await this.maybeDeleteSegmentCacheFile(audioPath, undefined, true);
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
        this.tasks.updateImportRequest({
          key: requestKey,
          chunkIndex: i,
          chunkCount: paths.length,
          status: "failed",
          updatedAt: Date.now(),
          deadlineAt: 0,
          error: error.message,
        });
        this.tasks.updateImportActivity({
          activeSegments: 0,
          failedSegments: Math.max(0, Number(this.tasks._importBusy && this.tasks._importBusy.failedSegments) || 0) + 1,
        });
        await this.diagnostics.logDiagnostic("error", "asr.import_whole_file_failed", "导入音频整文件转写失败", {
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
        retryTask = await this.queue.add({
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
      await this.noteWriter.insertBeforeSegmentsEnd(session.mdPath, block, session.id);
      this.tasks.updateImportActivity({
        done: i + 1,
        writtenSegments: session.segments.length,
        prepareDone: i + 1,
      });
      cumOffsetMs = endOffsetMs;
    }

    if (processedFiles === 0) {
      const error = new Error("没有可处理的音频文件");
      this.tasks.updateImportActivity({ error: error.message });
      this.tasks._importBusy = null;
      this.tasks.updateBusyStatus();
      throw error;
    }

    this.session = session;
    const pendingTranscriptionCount = session.segments.filter((segment) => !!segment.error).length;
    if (successfulTranscriptions === 0) {
      const message = pendingTranscriptionCount > 0
        ? "语音转写未完成；音频已保留，可在处理进度中重试"
        : "没有获得可用于整理的有效转写文本";
      this.tasks.updateImportActivity({
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
    const transcriptFile = this.app.vault.getAbstractFileByPath(session.mdPath);
    if (!(transcriptFile instanceof obsidian.TFile)) {
      throw new Error("原始转写写入后未找到对应笔记，已停止 AI 整理");
    }
    const persistedMarkdown = await this.app.vault.read(transcriptFile);
    const transcriptCheckpoint = verifyTranscriptCheckpoint(persistedMarkdown, session.segments);
    if (!transcriptCheckpoint.ok) {
      const checkpointError = new Error(
        `原始转写尚未完整写入笔记（${transcriptCheckpoint.persistedSegments}/${transcriptCheckpoint.expectedSegments}），已停止 AI 整理`,
      );
      this.tasks.updateImportActivity({
        phase: "persist",
        error: checkpointError.message,
        label: "原始转写写入未完成",
      });
      await this.diagnostics.logDiagnostic("error", "asr.import_transcript_checkpoint_failed", "导入音频原始转写检查点未通过", {
        mdPath: session.mdPath,
        expectedSegments: transcriptCheckpoint.expectedSegments,
        persistedSegments: transcriptCheckpoint.persistedSegments,
        expectedChars: transcriptCheckpoint.expectedChars,
        missingSegmentIndexes: transcriptCheckpoint.missingSegmentIndexes,
      });
      throw checkpointError;
    }
    await this.diagnostics.logDiagnostic("info", "asr.import_transcript_persisted", "导入音频原始转写已写入，允许进入 AI 整理", {
      mdPath: session.mdPath,
      segmentCount: transcriptCheckpoint.expectedSegments,
      transcriptChars: transcriptCheckpoint.expectedChars,
      provider: importProvider.id,
    });
    this.tasks.updateImportActivity({
      phase: "organize",
      organizeLabel: "准备 AI 整理",
      organizeDetail: "原始转写已完整写入，正在按当前纪要模板生成正文。",
    });
    await this.finalizeSession(session);
    const finalizationError = String(session.finalizationError || "").trim()
      || (session.workProgress && session.workProgress.stage === "transcript-empty"
        ? "没有获得可用于整理的有效转写文本"
        : "");
    if (finalizationError) {
      this.tasks.updateImportActivity({
        phase: audioImportStageFromWorkProgress(session.workProgress && session.workProgress.stage),
        error: finalizationError,
      });
    } else {
      this.tasks.updateImportActivity({
        phase: "write",
        completed: true,
        writeLabel: "处理完成",
        writeDetail: "纪要已经写入 Obsidian。",
      });
    }
    const completedImportId = session.id;
    window.setTimeout(() => {
      if (this.tasks._importBusy && String(this.tasks._importBusy.sessionId || "") === String(completedImportId)) {
        this.tasks._importBusy = null;
        this.tasks.updateBusyStatus();
        this.refreshOutlineView();
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
      const file = this.app.vault.getAbstractFileByPath(textPath);
      if (!(file instanceof obsidian.TFile) || !TEXT_IMPORT_EXT.has(String(file.extension || "").toLowerCase())) {
        new obsidian.Notice(`跳过：${textPath} 不是可导入文本`);
        continue;
      }
      try {
        const raw = await this.app.vault.read(file);
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
    const requestedMode = modeOverride && isKnownPolishMode(this.settings, modeOverride)
      ? modeOverride
      : (this.settings.polishMode || "meeting");
    const mode = getEffectivePolishMode(this.settings, requestedMode);
    const meta = getModeMeta(this.settings, mode);
    const llmIssue = getLlmConfigIssue(this.settings);
    if (llmIssue) {
      await this.diagnostics.logDiagnostic("warn", "text_import.llm_config_missing", "导入文本前大模型配置不完整", {
        mode,
        llmRoute: "composer.chat-completions",
        llmEndpoint: this.settings.llmEndpoint || "",
        llmModel: this.settings.llmModel ? "<set>" : "",
        issue: llmIssue,
      });
      new obsidian.Notice(`导入文本需要先完成大模型配置：${formatLlmConfigIssue(llmIssue)}`, 9000);
      return;
    }

    let recruitContext = null;
    if (mode === "recruit") {
      const result = await new Promise((resolve) => {
        const modal = new RecruitContextModal(this.app, this, {
          flow: "text-import",
          onConfirm: (action, ctx) => resolve({ action, ctx }),
        });
        modal.open();
      });
      if (result.action === "cancel") {
        new obsidian.Notice("已取消导入文本");
        return;
      }
      if (result.action !== "skip") recruitContext = result.ctx;
    }

    await ensureVaultFolder(this.app, this.settings.mdFolder);
    const mdName = `${startedAt.format(this.settings.noteFileNameFormatNew)} · 文本导入`;
    const mdPath = this.getAvailableMarkdownPath(obsidian.normalizePath(`${this.settings.mdFolder}/${mdName}.md`));
    if (!mdPath) throw new Error("无法生成文本导入笔记路径");

    const session = {
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
      recruitContext,
      textImportSources: sources.map(s => ({ path: s.path, name: s.name, chars: s.text.length })),
    };

    const header = [
      `# ${startedAt.format("YYYY-MM-DD HH:mm")} · ${meta.prefix}（文本导入处理中…）`,
      "",
      `> [!info] 文本导入信息`,
      `> 来源文件：${sources.length} · 模式：${meta.prefix} · 模型：${this.settings.llmModel}`,
      "",
      `<!-- lexvoice-session:${session.id} -->`,
      `<!-- lexvoice-segments-start:${session.id} -->`,
      `<!-- lexvoice-segments-end:${session.id} -->`,
      "",
    ].join("\n");
    await this.noteWriter.appendToNote(mdPath, header);
    this.session = session;
    this.setSessionWorkProgress(session, {
      stage: "text-import",
      label: "读取文本",
      percent: 8,
      detail: `已读取 ${sources.length} 个文本来源，准备进入 AI 整理`,
    });
    this.refreshOutlineView();
    try { await this.openOutlineView(); } catch (e) { console.warn("[QnALog] open outline for text import failed", e); }

    session.segments = splitImportedTextIntoNormalSegments(sources);

    for (const seg of session.segments) {
      const block = [
        "",
        `### 文本来源 ${seg.index + 1}：[[${seg.sourcePath}|${seg.sourceName}]]`,
        "",
        seg.rawText || "_[此文本来源为空]_",
        "",
      ].join("\n");
      await this.noteWriter.insertBeforeSegmentsEnd(session.mdPath, block, session.id);
    }

    this.refreshOutlineView();
    new obsidian.Notice(`开始整理 ${sources.length} 份文本：使用 AI 整理服务，不调用语音转写服务。`);
    await this.finalizeSession(session);
  }

  async openSessionNote() {
    const mdPath = this.session && this.session.mdPath;
    if (!mdPath) { await this.openRecentNote(); return; }
    const file = this.app.vault.getAbstractFileByPath(mdPath);
    if (!(file instanceof obsidian.TFile)) { new obsidian.Notice("当前录音笔记尚未生成"); return; }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    try {
      const view = leaf.view;
      const editor = view && view.editor;
      if (editor) {
        const content = editor.getValue();
        const marker = this.session && this.session.id ? `<!-- lexvoice-segments-end:${this.session.id} -->` : "<!-- lexvoice-segments-end -->";
        const idx = content.lastIndexOf(marker);
        if (idx >= 0) {
          const line = content.slice(0, idx).split("\n").length - 1;
          editor.setCursor({ line: Math.max(0, line - 1), ch: 0 });
          editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
        } else {
          const lastLine = editor.lastLine();
          editor.setCursor({ line: lastLine, ch: 0 });
          editor.scrollIntoView({ from: { line: lastLine, ch: 0 }, to: { line: lastLine, ch: 0 } }, true);
        }
      }
    } catch { /* intentionally empty */ }
  }

  async openRecentNote() {
    const recent = getRecentNotes(this, 1);
    if (!recent.length || !(recent[0].file instanceof obsidian.TFile)) {
      new obsidian.Notice("最近没有录音笔记");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(recent[0].file);
  }}

// 电脑音频捕获安装/配置向导 Modal —— 分平台引导

// ====== 招聘项目化（F2）：JD 项目库扫描 / JD 文档解析 / PDF 文本尽力提取 / 三件套创建 ======

// JD 文件判据：md 且 文件名（去扩展名）== 父文件夹名。不依赖额外字段，重命名免维护。

// 扫 JD 库根下每个子文件夹 = 一个招聘项目；取同名 .md 作 JD 文件，读 frontmatter 状态/职位名/序列。

// 解析单个 JD 文件：岗位描述 / 综合素质（frontmatter 对象数组）/ 统一面试提纲。
// 综合素质格式异常但有数据 → qualitiesError=true（调用方提示"按未配置处理"），不抛错、不阻断。

// 尽力从 PDF 提取文本（手动粘贴为主 + 尽力提取）：用 Obsidian 内置 pdf.js（window.pdfjsLib）。
// 不可用 / 扫描件 / 失败一律返回 ""，调用方提示手动粘贴。不引入任何打包依赖。

// 列出简历库里的 PDF 文件（递归，按修改时间倒序），供 Modal 简历下拉。

// 招聘项目 JD 文件模板（PRD F2.1 + 「类型: 招聘项目」键供聚合 Base 筛选）。jdBody = 粘贴的 JD 正文。
// 新建招聘项目时 JD 预置的默认综合素质（单一来源：JD 模板的 综合素质 段 + 候选人看板的 素质_* 列都用它）。

// 候选人看板 Base 模板（F5）。qualities = 素质名数组（动态追加 素质_<名> 列）。语法均为库内已验证写法：
// file.folder==this.file.folder + jd!=null 限定本项目候选人纪要；视图级 filters 叠加分页；displayName 把
// 真实字段 轮次/time/时长 显示成 面试轮次/面试时间/面试时长（不重命名 frontmatter，零迁移）；or 枚举录用建议（库内已验证）。

// 聚合看板 Base 模板（F6）：靠 JD frontmatter 的「类型: 招聘项目」过滤，天然只命中各项目的 JD 文件、排除候选人纪要。

// 在 JD 库根确保有一个聚合看板（首次建项目时按需创建，不覆盖用户改动）。

// 三件套创建：项目文件夹 + 同名 JD.md + 同名候选人看板.base；并确保 JD 库根有聚合看板。同名项目已存在则报错不覆盖。

// ====== F7 招聘主页：MD 模板 + 候选人纪要聚合 + 录用建议配色（4 个 code block 渲染器实时计算、零落盘）======

// 招聘主页 MD 模板：4 个自定义 code block + 嵌入聚合看板的「招聘中」视图。

// 聚合全库候选人面试纪要（判据：mode===recruit 或带 lexvoice/recruit 标签；排除 JD 文件/主页）。按 time 倒序。

// 录用建议 → 颜色（Obsidian 主题色变量，暗色可读）。startsWith 先长后短，吞掉「（条件性）」后缀。

// 招聘面试模式上下文 Modal —— 按录音、导入、重新整理等流程注入 JD/简历/候选人信息

// 提示词库 Modal

export default LexVoicePlugin;
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
