/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// @ts-nocheck
import * as obsidian from "obsidian";

import { LexVoiceSettingTab } from "./ui/settings-tab";

import { MinutesKanbanView, VIEW_TYPE_MINUTES_KANBAN } from "./ui/minutes-kanban-view";

import { getDesktopModule } from "./shared/desktop-runtime";

import {QueueModal, RecruitContextModal, ImportTextModal, ImportAudioModal, AudioImportOptionsModal, BubbleWidget } from "./ui/modals";

import {isKnownPolishMode, getModeMeta, getEffectivePolishMode, getVisibleModeEntries } from "./shared/mode-meta";

import { isLexVoiceMobileRuntime } from "./shared/util-platform";

import { UpdateService } from "./update-service";

import { normalizeKnowledgeExtractionHistory } from "./shared/util-knowledge";

import { listJDProjects } from "./recruit/jd-projects";

import {getSessionMetaDurationMs } from "./shared/util-text";

import {DEFAULT_RECRUIT_QUALITIES, isRecruitFeatureUnlocked, parseJdProject, renderRecruitCandidateBase, renderRecruitAggregateBase } from "./recruit";

import {registerRecruitBoardView } from "./recruit/bases-view";

import {makeRecordingIssue } from "./asr/transcribe";

import {getLlmConfigIssue, formatLlmConfigIssue, stripModeSuggestionBlocks } from "./llm/core";

import {DEFAULT_SETTINGS } from "./shared/defaults";

// 设置序列化层已抽到独立模块（src/shared/settings-io.ts）并由 round-trip 测试覆盖（tests/settings-io.test.ts）。
// 这里 import 回来，保持原有调用点用裸名引用不变。
import {SETTINGS_SCHEMA_VERSION, normalizeLexVoiceSettings, serializeLexVoiceSettings, extractLexVoiceJobItems } from "./shared/settings-io";

import { buildSettingsMigrationReport } from "./shared/settings-migration-report";

import type {LexVoiceSettings } from "./shared/types";
import { describeBuildSource, normalizePluginBuildInfo, resolveDisplayVersion, type PluginBuildInfo } from "./shared/build-info";

import { getLearnedLlmOutputCeiling } from "./llm/output-budget";

import { AUDIO_EXT, TEXT_IMPORT_EXT } from "./shared/catalog-import";

import {isRecord, pickDefined, genId, sanitizeFilename } from "./shared/util-common";

import {mimeFromExt, getTranscribeSegmentPlaceholder } from "./shared/util-audio";

import {obfuscateApiKey, deobfuscateApiKey, diagnosticError } from "./shared/util-key-diag";

import {RealtimeOutlineCoordinator } from "./outline-coordinator";

import {splitLexVoiceVersionPayload } from "./version-content";

import {audioImportStageFromWorkProgress, upsertActivityRequest } from "./shared/activity-progress";

import {getTaskErrorMessage } from "./shared/task-activity";

import {extractSpeakerIdsFromMarkdown } from "./audio/channel-speakers";

import { isSpeakerDiarizationProvider, normalizeRequestedSpeakerCount } from "./asr/diarization";

import { isDashScopeFileTransProvider, resolveImportTranscribeProvider, transcribeImportedAudio } from "./asr/long-audio-transcription";

import { ExternalInboxScanner, createExternalInboxLedger, isAbsoluteExternalInboxPath, normalizeExternalInboxLedger, pruneExternalInboxLedger, shouldImportExternalInboxFile } from "./audio/external-inbox";

import { verifyTranscriptCheckpoint } from "./imports/transcript-checkpoint";

// 以下 8 个声明已抽到 ./shared/limits（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {EXTERNAL_INBOX_RETRY_DELAYS_MS, EXTERNAL_INBOX_SCAN_INTERVAL_MS } from "./shared/limits";

// 以下 9 个声明已抽到 ./notes/recording-issues（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {isKnowledgeSourceAlreadyScanned, isSyncConflictName, knowledgeExtractionRecordForFile, transformApiKeyFieldsDeep } from "./notes/recording-issues";

// 以下 23 个声明已抽到 ./prompts/briefing-prompts（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { buildEmptyLlmOutputFallback, clearCommittedBriefingCheckpoint } from "./prompts/briefing-prompts";

// 以下 39 个声明已抽到 ./notes/realtime-outline（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {VIEW_TYPE_OUTLINE } from "./notes/realtime-outline";

// 以下 14 个声明已抽到 ./notes/audio-refs（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {getAudioDurationMs, getAudioTimeLink, getLexVoiceSegmentsDurationMs } from "./notes/audio-refs";

// 以下 40 个声明已抽到 ./notes/note-markdown（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {ROLE_MAPPING_FIELDS, applyRoleMappingToSegments, extractLexVoiceTranscriptSegments, extractRoleMappingFromFrontmatter, getLexVoiceSourceIdFromMarkdown, parseRoleMapItem, splitImportedTextIntoNormalSegments, stripImportedTextSource } from "./notes/note-markdown";

// 以下 13 个声明已抽到 ./recent/recent-notes（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {detectRecentNoteMode } from "./recent/recent-notes";

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
import { TranscribeProfileService } from "./asr/transcribe-profile-service";
import { VocabularyService } from "./vocabulary/vocabulary-service";
import { MigrationService } from "./migrations/migration-service";
import { RealtimeOutlineService } from "./notes/realtime-outline-service";
import { MeetingWorkbenchService } from "./notes/meeting-workbench-service";
import { AudioTimeLinkService } from "./notes/audio-time-link-service";
import { NoteIndexService } from "./notes/note-index-service";
import { LibraryViewService } from "./views/library-view-service";
import { ViewShellService } from "./ui/view-shell-service";
import { RecordingService } from "./audio/recording-service";
import { SessionFinalizeService } from "./notes/session-finalize-service";
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
    this.sessionFinalize = new SessionFinalizeService(this);
    this.recording = new RecordingService(this);
    this.shell = new ViewShellService(this);
    this.library = new LibraryViewService(this);
    this.noteIndex = new NoteIndexService(this);
    this.audioLinks = new AudioTimeLinkService(this);
    this.meetingWorkbench = new MeetingWorkbenchService(this);
    this.outline = new RealtimeOutlineService(this);
    this.migrations = new MigrationService(this);
    this.vocabulary = new VocabularyService(this);
    this.profiles = new TranscribeProfileService(this);
    this.tasks.start();
    this.recorder = new RecorderService(this);
    this.queue = new TaskQueue(this);
    this.queue.load(this.persistedQueue);
    this.session = null;
    this.recordingIssue = null;
    this.outlineCoordinator = new RealtimeOutlineCoordinator({
      getActiveSessionId: () => (this.session && this.session.id) || "",
      evaluate: (request) => this.outline.evaluateRealtimeOutlineRequest(request),
      execute: (request) => this.outline.executeRealtimeOutlineRequest(request),
      onFailure: (request, error) => this.outline.getRealtimeOutlineRetryDecision(request, error),
      onStateChange: (state) => {
        this.tasks.syncOutlineTaskActivity(state);
        this.shell.refreshOutlineView();
      },
    });

    this.tasks.startStatusBar();

    this.ribbonEl = this.addRibbonIcon("mic", "QnALog：点击开始/停止，悬停展开控件", () => this.recording.toggleRecording());
    this.recorder.on(() => this.shell.refreshOutlineView());

    this.registerView(VIEW_TYPE_OUTLINE, (leaf) => new OutlineView(leaf, this));
    this.registerView(VIEW_TYPE_MINUTES_KANBAN, (leaf) => new MinutesKanbanView(leaf, {
      getRootPath: () => obsidian.normalizePath(this.settings.mdFolder || DEFAULT_SETTINGS.mdFolder),
      listItems: () => this.shell.getMinutesKanbanItems(),
      getModeOptions: () => getVisibleModeEntries(this.settings, false).map(([value, label]) => ({ value, label })),
      moveItem: (item, folderPath) => this.shell.moveMinutesKanbanItem(item, folderPath),
      createFolder: (name) => this.shell.createMinutesKanbanFolder(name),
    }));
    // 自定义 Bases 视图「招聘看板」（@since 1.10.0；内部自带守卫，老版本/未启用 Bases 时安全跳过）。
    registerRecruitBoardView(this);
    this.addRibbonIcon("list-tree", "QnALog 实时纪要面板", () => this.shell.openOutlineView());
    this.registerMarkdownPostProcessor((el, ctx) => this.audioLinks.enhanceAudioTimeLinks(el, ctx));

    this.bubble = new BubbleWidget(this);
    // 浮窗显隐与侧边栏（实时纪要面板）联动
    this.registerEvent(this.app.workspace.on("layout-change", () => this.shell.syncBubbleVisibility()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.shell.syncBubbleVisibility()));
    this.registerEvent(this.app.workspace.on("resize", () => this.shell.syncBubbleVisibility()));
    this.app.workspace.onLayoutReady(() => this.shell.syncBubbleVisibility());

    this.addCommand({ id: "toggle-recording", name: "开始/停止录音", callback: () => this.recording.toggleRecording() });
    this.addCommand({ id: "pause-resume-recording", name: "暂停/继续录音", callback: () => {
      const s = this.recorder.state;
      if (s === "recording") this.recorder.pause(); else if (s === "paused") this.recorder.resume();
    }});
    this.addCommand({ id: "polish-selection-or-note", name: "AI 润色：当前选区或整篇", editorCallback: (editor) => this.noteWriter.polishEditor(editor) });
    this.addCommand({ id: "toggle-floating-ball", name: "显示/隐藏悬浮气泡（总开关）", callback: () => {
      this.settings.showFloatingBall = !this.settings.showFloatingBall;
      void this.saveSettings();
      this.shell.syncBubbleVisibility();
      new obsidian.Notice(this.settings.showFloatingBall ? "浮窗已启用（常驻显示，可拖动）" : "浮窗已关闭");
    }});
    this.addCommand({ id: "open-queue", name: "打开待处理队列", callback: () => new QueueModal(this.app, this).open() });
    this.addCommand({ id: "retry-queue-all", name: "重试所有失败任务", callback: () => this.queueRetry.retryQueue() });
    this.addCommand({ id: "copy-diagnostic-report", name: "复制诊断报告", callback: () => this.diagnostics.copyDiagnosticReport() });
    this.addCommand({ id: "suggest-people-directory-updates", name: "AI 扫描纪要库提取人员建议", callback: () => { void this.people.suggestPeopleDirectoryFromLibrary(); } });
    this.addCommand({ id: "open-learning-card-wall", name: "打开学习卡片瀑布墙", callback: () => { void this.library.openLearningWall("learning"); } });
    this.addCommand({ id: "open-concept-wall", name: "打开概念墙", callback: () => { void this.library.openLearningWall("concept"); } });
    this.addCommand({ id: "open-todo-wall", name: "打开待办墙", callback: () => { void this.library.openTodoWall(); } });
    this.addCommand({ id: "open-object-wall", name: "打开对象总览", callback: () => { void this.library.openObjectWall(); } });
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
    this.addCommand({ id: "open-outline", name: "打开实时纪要面板", callback: () => this.shell.openOutlineView() });
    this.addCommand({ id: "open-minutes-kanban", name: "打开纪要看板", callback: () => this.shell.openMinutesKanban() });
    this.addCommand({ id: "record-mic-only", name: "开始录音 · 仅麦克风", callback: () => { this.recording._oneShotCaptureMode = "mic"; void this.recording.startRecording(); } });
    this.addCommand({ id: "record-mic-virtual", name: "开始录音 · 麦克风 + 电脑音频", callback: () => { this.recording._oneShotCaptureMode = "mix-virtual"; void this.recording.startRecording(); } });
    this.addCommand({ id: "record-virtual-only", name: "开始录音 · 仅电脑音频", callback: () => { this.recording._oneShotCaptureMode = "virtualCable"; void this.recording.startRecording(); } });
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
    this.addCommand({ id: "cleanup-empty-short-recordings", name: "清理空白短录音", callback: () => this.migrations.cleanupEmptyShortRecordings() });
    this.addCommand({ id: "cleanup-expired-segment-cache", name: "清理过期分段音频缓存", callback: async () => {
      const result = await this.recording.cleanupExpiredSegmentCacheFiles();
      new obsidian.Notice(`分段缓存清理完成：删除 ${result.deleted} 个，跳过 ${result.skipped} 个${result.failed ? `，失败 ${result.failed} 个` : ""}`, 8000);
    } });

    this.addCommand({
      id: "migrate-legacy-notes",
      name: "迁移历史笔记属性",
      callback: () => {
        this.migrations.migrateLegacyNotes()
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
        void this.recording.cleanupExpiredSegmentCacheFiles().catch((e) => console.error("[QnALog] startup segment cache cleanup failed", e));
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
  }  async loadAll() {
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
      if (await this.migrations.migrateDefaultVocabularyFileLocation(saved)) shouldSave = true;
    } catch (e) {
      console.warn("[QnALog] vocabulary location migrate failed", e);
    }
    try {
      if (await this.migrations.migrateDefaultLibraryLayout(savedVersion)) shouldSave = true;
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
  async saveSettings() { await this.saveAll(); }  openSettings(tabId = "home") {
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
    try { this.shell.refreshOutlineView(); } catch { /* intentionally empty */ }
    try { if (this.bubble && this.bubble.scheduleUpdate) this.bubble.scheduleUpdate(); } catch { /* intentionally empty */ }
  }

  clearRecordingIssue(kind) {
    if (!this.recordingIssue) return;
    if (kind && this.recordingIssue.kind !== kind) return;
    this.recordingIssue = null;
    try { this.shell.refreshOutlineView(); } catch { /* intentionally empty */ }
    try { if (this.bubble && this.bubble.scheduleUpdate) this.bubble.scheduleUpdate(); } catch { /* intentionally empty */ }
  }

  getRecordingIssue() {
    const recorderIssue = this.recorder && this.recorder.getInfo ? (this.recorder.getInfo().issue || null) : null;
    if (recorderIssue && recorderIssue.kind === "microphone") return recorderIssue;
    return this.recordingIssue || recorderIssue || null;
  }  getAvailableMarkdownPath(targetPath, currentPath) {
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
        await this.noteIndex.appendDailyMeetingOverviewForMarkdown(dailyFile, dailyContent, polished, mode, segments, sessionMeta);
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
    await this.recording.ensureSegmentCacheFolder();
    const safeStem = sanitizeFilename(String(file.name || "audio").replace(/\.[^.]+$/, "")) || "audio";
    const extension = String(file.extension || "audio").toLowerCase();
    const cacheName = `${file.fingerprint}-${safeStem}.${extension}`;
    const cachePath = obsidian.normalizePath(`${this.recording.getSegmentCacheFolder()}/${cacheName}`);
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
        try { await this.recording.maybeDeleteSegmentCacheFile(cachePath, undefined, true); } catch { /* queue references keep required retry files */ }
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
    const importProfile = this.profiles.getTranscribeProviderProfile(importProvider.id, importProvider);
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
      const externalCache = !!externalSource && this.recording.isSegmentCachePath(audioPath);
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
          await this.recording.maybeDeleteSegmentCacheFile(audioPath, undefined, true);
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
    await this.sessionFinalize.finalizeSession(session);
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
        this.shell.refreshOutlineView();
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
    this.recording.setSessionWorkProgress(session, {
      stage: "text-import",
      label: "读取文本",
      percent: 8,
      detail: `已读取 ${sources.length} 个文本来源，准备进入 AI 整理`,
    });
    this.shell.refreshOutlineView();
    try { await this.shell.openOutlineView(); } catch (e) { console.warn("[QnALog] open outline for text import failed", e); }

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

    this.shell.refreshOutlineView();
    new obsidian.Notice(`开始整理 ${sources.length} 份文本：使用 AI 整理服务，不调用语音转写服务。`);
    await this.sessionFinalize.finalizeSession(session);
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
