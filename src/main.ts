/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
import * as obsidian from "obsidian";

import { QnALogSettingTab } from "./ui/settings-tab";

import { MinutesKanbanView, VIEW_TYPE_MINUTES_KANBAN } from "./ui/minutes-kanban-view";

import {QueueModal, ImportTextModal, ImportAudioModal, BubbleWidget, TextCorrectionModal } from "./ui/modals";

import {getModeDisplayName, getModeMeta, getVisibleModeEntries } from "./shared/mode-meta";

import { UpdateService } from "./update-service";




import {DEFAULT_SETTINGS } from "./shared/defaults";

// 设置序列化层已抽到独立模块（src/shared/settings-io.ts）并由 round-trip 测试覆盖（tests/settings-io.test.ts）。
// 这里 import 回来，保持原有调用点用裸名引用不变。
import {SETTINGS_SCHEMA_VERSION, normalizePluginSettings, serializePluginSettings, extractJobItems } from "./shared/settings-io";
import { resolveUiLanguage, setActiveUiLanguage, t } from "./shared/i18n";
import { classifySettingsSchema, hasStoredSettings, migrateSettingsForward, readSavedSchemaVersion, type SettingsSchemaState } from "./shared/settings-schema";

import type {PluginSettings, RecordingSession } from "./shared/types";
import { describeBuildSource, normalizePluginBuildInfo, resolveDisplayVersion, type PluginBuildInfo } from "./shared/build-info";

import {AUDIO_EXT } from "./shared/catalog-import";


import {obfuscateApiKey, deobfuscateApiKey } from "./shared/util-key-diag";
import { getDesktopModule } from "./shared/desktop-runtime";

import {RealtimeOutlineCoordinator } from "./outline-coordinator";

import {ExternalInboxScanner, isAbsoluteExternalInboxPath } from "./audio/external-inbox";

// 以下 8 个声明已抽到 ./shared/limits（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {EXTERNAL_INBOX_SCAN_INTERVAL_MS } from "./shared/limits";

// 以下 9 个声明已抽到 ./notes/recording-issues（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {transformApiKeyFieldsDeep } from "./notes/recording-issues";

// 以下 39 个声明已抽到 ./notes/realtime-outline（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import {VIEW_TYPE_OUTLINE } from "./notes/realtime-outline";

// 以下 1 个声明已抽到 ./audio/recorder-service（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { RecorderService } from "./audio/recorder-service";

// 以下 1 个声明已抽到 ./queue/task-queue（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { TaskQueue } from "./queue/task-queue";
import { summarizeLiveAsrJobs } from "./asr/live-segment-policy";

// 以下 1 个声明已抽到 ./ui/outline-view（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { OutlineView } from "./ui/outline-view";

import { DiagnosticsService } from "./diagnostics/diagnostics-service";
import type { DiagnosticsSnapshot } from "./diagnostics/diagnostics-service";
import { TaskActivityService } from "./tasks/task-activity-service";
import { DeliveryService } from "./delivery/delivery-service";
import { NoteWriter } from "./notes/note-writer";
import { QueueRetryService } from "./queue/queue-retry-service";
import { VersionStore } from "./versions/version-store";
import { PeopleDirectoryService } from "./people/people-directory-service";
import { TranscribeProfileService } from "./asr/transcribe-profile-service";
import { VocabularyService } from "./vocabulary/vocabulary-service";
import { CleanupService } from "./vault/cleanup-service";
import { RealtimeOutlineService } from "./notes/realtime-outline-service";
import { MeetingWorkbenchService } from "./notes/meeting-workbench-service";
import { AudioTimeLinkService } from "./notes/audio-time-link-service";
import { NoteIndexService } from "./notes/note-index-service";
import { LibraryViewService } from "./views/library-view-service";
import { ViewShellService } from "./ui/view-shell-service";
import { RecordingService } from "./audio/recording-service";
import { SessionFinalizeService } from "./notes/session-finalize-service";
import { ImportService } from "./imports/import-service";
import { ExternalInboxService } from "./audio/external-inbox-service";
import { RepolishService } from "./notes/repolish-service";
import { InboxWatcherService } from "./imports/inbox-watcher-service";
import { KnowledgeExtractionService } from "./indexing/knowledge-extraction-service";
import { SemanticCanvasService } from "./canvas/semantic-canvas-service";
/**
 * 按设置与 Obsidian 的界面语言，决定插件当前使用的语言并记录到 i18n 模块。
 *
 * 语言状态放在 i18n 模块而不是插件实例上：读取方遍布近百个模块，
 * 逐个穿参会污染所有中间层。写入点只有两处——插件加载、用户在「关于」里改语言。
 */
export function applyUiLanguage(settings: { uiLanguage?: string } | null | undefined): void {
  const configured = settings && typeof settings === "object" ? settings.uiLanguage : "";
  setActiveUiLanguage(resolveUiLanguage(configured, obsidian.getLanguage()));
}

class QnALogPlugin extends obsidian.Plugin {
  declare settings: PluginSettings;
  // 域服务字段在 onload 里赋值。TypeScript 不推断「仅赋值」的属性，
  // 因此跨模块读取 plugin.<域> 的调用方（如 TaskQueue）需要这里的显式声明。
  declare diagnostics: DiagnosticsService;
  declare delivery: DeliveryService;
  declare noteWriter: NoteWriter;
  declare tasks: TaskActivityService;
  declare queueRetry: QueueRetryService;
  declare versions: VersionStore;
  declare people: PeopleDirectoryService;
  declare knowledgeExtraction: KnowledgeExtractionService;
  declare inbox: InboxWatcherService;
  declare repolish: RepolishService;
  declare externalInbox: ExternalInboxService;
  declare imports: ImportService;
  declare sessionFinalize: SessionFinalizeService;
  declare recording: RecordingService;
  /** 装配别名：队列重试的熔断与切片缓存视图绑定到录音服务（QueueRetryHost.asrCircuit）。 */
  declare asrCircuit: RecordingService;
  /** 装配别名：会话收尾的实时转写管线视图绑定到录音服务（SessionFinalizeHost.liveAsr）。 */
  declare liveAsr: RecordingService;
  /** 装配别名：录音服务的收尾管线视图绑定到会话收尾服务（RecordingHost.sessionPipeline）。 */
  declare sessionPipeline: SessionFinalizeService;
  declare shell: ViewShellService;
  declare library: LibraryViewService;
  declare noteIndex: NoteIndexService;
  declare audioLinks: AudioTimeLinkService;
  declare meetingWorkbench: MeetingWorkbenchService;
  declare outline: RealtimeOutlineService;
  declare cleanup: CleanupService;
  /** 本次加载时磁盘设置的版本判定；future 时禁止写盘。 */
  settingsSchemaState: SettingsSchemaState = "current";
  declare vocabulary: VocabularyService;
  declare profiles: TranscribeProfileService;
  declare semanticCanvas: SemanticCanvasService;
  declare recorder: RecorderService;
  declare queue: TaskQueue;
  /** 当前录音会话；未在录音时为 null。 */
  declare session: RecordingSession | null;
  /** 当前会话的实时大纲协调器。 */
  declare outlineCoordinator: RealtimeOutlineCoordinator;
  /** 悬浮气泡；未挂载时为 null。 */
  declare bubble: BubbleWidget | null;
  /** 版本检查与提示服务；onload 里装配。 */
  declare updateService: UpdateService;
  /** 设置页实例；openSettings 需要它切到指定标签页。 */
  declare settingTab: QnALogSettingTab | null;
  /** 功能区图标元素；气泡挂载在它旁边。 */
  declare ribbonEl: HTMLElement | null;
  /** 从 data.json 读回的待恢复队列（loadAll 时交给 TaskQueue）。 */
  declare persistedQueue: unknown[];
  /** saveAll 的串行尾：保证并发保存按调用顺序落盘。 */
  declare _saveAllTail: Promise<unknown> | null;
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
    // 域服务在加载设置之前装配：loadAll 的设置迁移与迁移报告要经 migration / diagnostics 两个服务；
    // 状态栏与录音器晚于 loadAll 建立，所以 tasks.start()/startStatusBar() 仍留在原位调用。
    this.diagnostics = new DiagnosticsService(this);
    this.delivery = new DeliveryService(this);
    this.noteWriter = new NoteWriter(this);
    this.tasks = new TaskActivityService(this);
    this.queueRetry = new QueueRetryService(this);
    this.versions = new VersionStore(this);
    this.people = new PeopleDirectoryService(this);
    this.knowledgeExtraction = new KnowledgeExtractionService(this);
    this.inbox = new InboxWatcherService(this);
    this.repolish = new RepolishService(this);
    this.externalInbox = new ExternalInboxService(this);
    this.imports = new ImportService(this);
    this.sessionFinalize = new SessionFinalizeService(this);
    this.sessionPipeline = this.sessionFinalize;
    this.recording = new RecordingService(this);
    this.liveAsr = this.recording;
    this.asrCircuit = this.recording;
    this.shell = new ViewShellService(this);
    this.library = new LibraryViewService(this);
    this.noteIndex = new NoteIndexService(this);
    this.audioLinks = new AudioTimeLinkService(this);
    this.meetingWorkbench = new MeetingWorkbenchService(this);
    this.outline = new RealtimeOutlineService(this);
    this.cleanup = new CleanupService(this);
    this.vocabulary = new VocabularyService(this);
    this.profiles = new TranscribeProfileService(this);
    this.semanticCanvas = new SemanticCanvasService(this);
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
    this.tasks.start();
    this.recorder = new RecorderService(this);
    this.queue = new TaskQueue(this);
    this.queue.load(this.persistedQueue);
    this.session = null;
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

    this.ribbonEl = this.addRibbonIcon("mic", t("QnALog: click to start/stop; hover to expand the controls"), () => this.recording.toggleRecording());
    this.recorder.on(() => this.shell.refreshOutlineView());

    this.registerView(VIEW_TYPE_OUTLINE, (leaf) => new OutlineView(leaf, this));
    this.registerView(VIEW_TYPE_MINUTES_KANBAN, (leaf) => new MinutesKanbanView(leaf, {
      getRootPath: () => obsidian.normalizePath(this.settings.mdFolder || DEFAULT_SETTINGS.mdFolder),
      listItems: () => this.shell.getMinutesKanbanItems(),
      getModeOptions: () => getVisibleModeEntries(this.settings, false).map(([value]) => ({ value, label: getModeDisplayName(this.settings, value) })),
      moveItem: (item, folderPath) => this.shell.moveMinutesKanbanItem(item, folderPath),
      createFolder: (name) => this.shell.createMinutesKanbanFolder(name),
    }));
    this.addRibbonIcon("list-tree", t("QnALog live minutes panel"), () => this.shell.openOutlineView());
    this.registerMarkdownPostProcessor((el, ctx) => this.audioLinks.enhanceAudioTimeLinks(el, ctx));

    this.bubble = new BubbleWidget(this);

    // 浮窗显隐与侧边栏（实时纪要面板）联动
    this.registerEvent(this.app.workspace.on("layout-change", () => this.shell.syncBubbleVisibility()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.shell.syncBubbleVisibility()));
    this.registerEvent(this.app.workspace.on("resize", () => this.shell.syncBubbleVisibility()));
    this.app.workspace.onLayoutReady(() => this.shell.syncBubbleVisibility());

    this.addCommand({ id: "toggle-recording", name: t("Start/Stop Recording"), callback: () => this.recording.toggleRecording() });
    this.addCommand({ id: "pause-resume-recording", name: t("Pause/Resume Recording"), callback: () => {
      const s = this.recorder.state;
      if (s === "recording") this.recorder.pause(); else if (s === "paused") this.recorder.resume();
    }});
    this.addCommand({ id: "polish-selection-or-note", name: t("AI: Polish Current Selection or Entire Note"), editorCallback: (editor) => this.noteWriter.polishEditor(editor) });
    this.addCommand({ id: "toggle-floating-ball", name: t("Show/Hide Floating Bubble (Master Switch)"), callback: () => {
      this.settings.showFloatingBall = !this.settings.showFloatingBall;
      void this.saveSettings();
      this.shell.syncBubbleVisibility();
      new obsidian.Notice(this.settings.showFloatingBall ? "浮窗已启用（常驻显示，可拖动）" : "浮窗已关闭");
    }});
    this.addCommand({ id: "open-queue", name: t("Open Pending Queue"), callback: () => new QueueModal(this.app, this).open() });
    this.addCommand({ id: "retry-queue-all", name: t("Retry All Failed Tasks"), callback: () => this.queueRetry.retryQueue() });
    this.addCommand({ id: "copy-diagnostic-report", name: t("Copy Diagnostic Report"), callback: () => this.diagnostics.copyDiagnosticReport() });
    this.addCommand({ id: "suggest-people-directory-updates", name: t("AI: Scan Minutes Library for People Suggestions"), callback: () => { void this.people.suggestPeopleDirectoryFromLibrary(); } });
    this.addCommand({ id: "open-todo-wall", name: t("Open To-do Wall"), callback: () => { void this.library.openTodoWall(); } });
    this.addCommand({ id: "import-audio", name: t("Import Existing Audio File: Transcribe + Polish"), callback: () => new ImportAudioModal(this.app, this).open() });
    this.addCommand({
      id: "generate-html-report",
      name: t("AI: Generate HTML Report for This Note"),
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
      name: t("AI: Generate PDF Report for This Note (Full Page, No Truncation)"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const isMd = file instanceof obsidian.TFile && file.extension === "md";
        if (!isMd) return false;
        if (checking) return true;
        void this.delivery.generatePdfReportForMarkdownFile(file);
        return true;
      },
    });
    this.addCommand({ id: "check-updates", name: t("Check for Updates"), callback: () => this.checkForUpdates({ silent: false }) });
    this.addCommand({ id: "open-outline", name: t("Open Live Minutes Panel"), callback: () => this.shell.openOutlineView() });
    this.addCommand({ id: "open-minutes-kanban", name: t("Open Minutes Board"), callback: () => this.shell.openMinutesKanban() });
    this.addCommand({ id: "record-mic-only", name: t("Start Recording · Microphone only"), callback: () => { this.recording._oneShotCaptureMode = "mic"; void this.recording.startRecording(); } });
    this.addCommand({ id: "record-mic-virtual", name: t("Start Recording · Microphone + Computer Audio"), callback: () => { this.recording._oneShotCaptureMode = "mix-virtual"; void this.recording.startRecording(); } });
    this.addCommand({ id: "record-virtual-only", name: t("Start Recording · Computer Audio only"), callback: () => { this.recording._oneShotCaptureMode = "virtualCable"; void this.recording.startRecording(); } });
    this.addCommand({ id: "import-text", name: t("Import Existing Text / MD: Structure and Organize"), callback: () => new ImportTextModal(this.app, this).open() });

    this.settingTab = new QnALogSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.registerEvent(this.app.vault.on("create", (file) => {
      this.inbox.handleInboxFile(file).catch(e => console.error("[QnALog] inbox handler error", e));
    }));
    // Nutstore Sync / Obsidian Sync may first create a placeholder and then fill it through modify events.
    // Listen to both so a zero-byte placeholder never becomes the only chance to auto-import the file.
    this.registerEvent(this.app.vault.on("modify", (file) => {
      this.inbox.handleInboxFile(file).catch(e => console.error("[QnALog] inbox modify handler error", e));
    }));

    // 文件重命名时同步迁移队列里所有指向旧路径的任务，
    // 防止 merge 任务跑完后文件被改名 → 重试时找不到旧路径报"笔记不存在"
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof obsidian.TFile) {
        this.queueRetry.migrateQueueTasksAfterRename(oldPath, file.path);
        this.inbox.handleInboxFile(file).catch(e => console.error("[QnALog] inbox rename handler error", e));
      }
    }));

    // 笔记被删（在 Obsidian 里直接删，非插件 UI）→ 清理指向它的队列任务，
    // 否则 merge 任务每次重试都先白烧一次 LLM 再报"笔记不存在"，永久卡 failed 清不掉。
    this.registerEvent(this.app.vault.on("delete", (file) => {
      const path = file && file.path ? file.path : "";
      if (path) this.queueRetry.removeQueueTasksForDeletedMarkdown(path);
    }));

    this.addCommand({ id: "scan-inbox", name: t("Scan Watched Folder"), callback: () => this.inbox.scanInboxFolder() });
    this.externalInbox.externalInboxScanner = new ExternalInboxScanner();
    this.registerInterval(window.setInterval(() => {
      if (!this.settings.inboxAutoImport || !isAbsoluteExternalInboxPath(this.settings.inboxFolder)) return;
      void this.externalInbox.scanExternalInboxFolder({ manual: false, source: "poll" });
    }, EXTERNAL_INBOX_SCAN_INTERVAL_MS));

    this.addCommand({ id: "cleanup-empty-short-recordings", name: t("Clean Up Blank Short Recordings"), callback: () => this.cleanup.cleanupEmptyShortRecordings() });
    this.addCommand({ id: "cleanup-expired-segment-cache", name: t("Clean Up Expired Segmented Audio Cache"), callback: async () => {
      const result = await this.recording.cleanupExpiredSegmentCacheFiles();
      new obsidian.Notice(
        `${t("Segment cache cleanup complete: deleted ")}${result.deleted}${t(", skipped ")}${result.skipped}${result.failed ? t(", failed {0}").replace("{0}", String(result.failed)) : ""}`,
        8000,
      );
    } });

    this.addCommand({
      id: "regenerate-briefing-from-frontmatter",
      name: t("Reorganize This Note (Using Speaker Names)"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const isMd = file instanceof obsidian.TFile && file.extension === "md";
        const mode = isMd ? this.noteWriter.detectModeFromMarkdown(file) : null;
        if (!isMd || !mode) return false;
        if (checking) return true;
        void this.repolish.repolishMarkdownFile(file, mode);
        return true;
      },
    });

    // 续录当前笔记：对正在浏览的纪要追加一段录音，停止后与原纪要重新合并整理。
    // 目标笔记没有可合并的原始转写分段时，startRecording 会给出具体原因提示。
    this.addCommand({
      id: "append-recording-to-active",
      name: t("Continue Recording into the Current Note"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const isMd = file instanceof obsidian.TFile && file.extension === "md";
        if (!isMd || !this.noteWriter.detectModeFromMarkdown(file)) return false;
        if (checking) return this.recorder.state === "idle";
        if (this.recorder.state !== "idle") {
          new obsidian.Notice(t("A recording is already in progress. Please stop it before continuing to record."), 5000);
          return true;
        }
        void this.recording.startRecording({ appendToFile: file });
        return true;
      },
    });

    // 选中文字 → 右键 → 更正误识别词。只改当前笔记，不写词表。
    // 入口放在编辑器菜单而不是文件菜单：用户看到错词时正在正文里，
    // 让「选中即更正」一步可达，不必开弹窗再手打一遍错词。
    //
    // 菜单标题用 `QnALog`（标识符写法）而不是书面名 `Q&A Log`：
    // macOS 原生菜单把 `&` 当快捷键标记。Obsidian 只在 `&` 两侧都是非单词字符时
    // 才转义（正则 /\B&\B/），而 `Q&A` 的 `&` 两侧是 Q 与 A，转义不命中，
    // Electron 便吃掉 `&A`，显示成 `QA Log`。用 DocumentFragment 传标题也无效——
    // 丢失发生在菜单渲染层，不是文本构建层。
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) => {
      const file = info && info.file;
      if (!(file instanceof obsidian.TFile)) return;
      const isMinutes = this.noteWriter.detectModeFromMarkdown(file);
      const selection = String(editor.getSelection() || "").trim();
      const hasCorrection = !!selection && !selection.includes("\n") && selection.length <= 80;
      // 本插件的菜单项归入同一组：只在最前面加一条分隔线（与系统项隔开），
      // 「继续录音」与「更正误识别词」之间不再分割——两条中间夹分隔线会把
      // 同一插件的功能切成两组，视觉上像两家来源。
      if (!isMinutes && !hasCorrection) return;
      menu.addSeparator();
      if (isMinutes) {
        // 正文右键（无论是否选中文字）：当前笔记是自家纪要时给「继续录音到这篇纪要」，
        // 与文件列表右键同一条路径。用户正在阅读纪要正文时想补充一段，不必回文件列表。
        menu.addItem((item) => {
          item.setTitle(t("QnALog: Continue recording into this note"))
            .setIcon("mic")
            .onClick(() => { void this.recording.startRecording({ appendToFile: file }); });
        });
      }
      if (!hasCorrection) return;
      // 只处理单行内的短片段：多行或过长通常是整段，不是「误识别词」
      menu.addItem((item) => {
        item.setTitle(t("QnALog: Correct misrecognized text…"))
          .setIcon("replace")
          .onClick(() => new TextCorrectionModal(this.app, file, selection).open());
      });
    }));

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof obsidian.TFile)) return;
      const ext = (file.extension || "").toLowerCase();
      if (AUDIO_EXT.has(ext)) {
        menu.addSeparator();
        menu.addItem((item) => {
          item.setTitle(t("QnALog: Transcribe and organize"))
            .setIcon("mic")
            .onClick(() => this.imports.openAudioImportOptions([file.path]));
        });
        return;
      }
      // 纪要文件的续录入口：右键一篇已生成的转写纪要，追加一段录音。
      // 只对自家纪要显示：续录建纪要时统一写 mode frontmatter
      // （postProcessBriefingOutput），读回检测用 detectModeFromMarkdown。
      // 录音进行中点击会被 startRecording 拒绝并提示，菜单不做状态轮询。
      if (!this.noteWriter.detectModeFromMarkdown(file)) return;
      menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle(t("QnALog: Continue recording into this note"))
          .setIcon("mic")
          .onClick(() => { void this.recording.startRecording({ appendToFile: file }); });
      });
    }));

    this.registerEvent(this.app.workspace.on("files-menu", (menu, files) => {
      const audios = (files || []).filter((f) => f instanceof obsidian.TFile && AUDIO_EXT.has((f.extension || "").toLowerCase()));
      if (audios.length === 0) return;
      const paths = audios.map((f) => f.path);
      menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle(`${t("QnALog: Merge ")}${audios.length}${t(" audio files…")}`).setIcon("mic");
        const sub = (item as obsidian.MenuItem & { setSubmenu(): obsidian.Menu }).setSubmenu();
        const modes = getVisibleModeEntries(this.settings, false);
        for (const [m] of modes) {
          sub.addItem((sub_i) => {
            sub_i.setTitle(`${t("Organize as ")}${getModeDisplayName(this.settings, m)}`)
              .setIcon("mic")
              .onClick(() => this.imports.openAudioImportOptions(paths, m));
          });
        }
      });
    }));

    if (this.queue.tasks.length > 0) {
      new obsidian.Notice(`${t("Q&A Log: found ")}${this.queue.tasks.length}${t(" pending tasks; retrying in the background...")}`);
      window.setTimeout(() => { void this.queueRetry.retryQueue(); }, 2500);
    }
    this.app.workspace.onLayoutReady(() => {
      this.warnIfBuildManifestSkew();
      this.checkForUpdatesOnStartup();
      this.externalInbox.refreshExternalInboxWatcher();
      const inboxTimer = window.setTimeout(() => {
        if (this.settings.inboxAutoImport && isAbsoluteExternalInboxPath(this.settings.inboxFolder)) {
          void this.externalInbox.scanExternalInboxFolder({ manual: false, source: "startup" });
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
    this.externalInbox.closeExternalInboxWatcher();
    try { if (this.queueRetry) this.queueRetry.dispose(); } catch { /* intentionally empty */ }
    void (async () => {
      try { if (this.recorder && this.recorder.state !== "idle") await this.recorder.stop(); } catch { /* intentionally empty */ }
    })();
    if (this.bubble) this.bubble.unmount();
  }

  /**
   * 按当前设置与 Obsidian 的界面语言，对齐插件生效语言。
   *
   * 只改本模块记录的语言，不写盘：调用方（设置项 onChange）负责保存。
   */
  applyUiLanguageNow() {
    applyUiLanguage(this.settings);
  }

  async loadAll() {
    const saved: unknown = (await this.loadData()) || {};
    // 还原密钥：data.json 里的密钥是混淆态，读入内存前先解混淆（旧明文数据会原样通过，下次保存自动转混淆）
    try { transformApiKeyFieldsDeep(saved, deobfuscateApiKey); } catch (e) { console.warn("[QnALog] key deobfuscate failed", e); }
    // 设置结构版本政策（见 shared/settings-schema.ts）：
    //   current → 直接读回；migrate → 向前迁移，保留用户配置；
    //   future  → 用户回退了插件版本，**不写盘**，避免把新版字段洗掉；
    //   foreign → 别的项目/损坏的数据，丢弃前先留档。
    const schemaState: SettingsSchemaState = classifySettingsSchema(saved);
    this.settingsSchemaState = schemaState;
    const migration = migrateSettingsForward(saved);
    let schemaNotice = "";
    let shouldPersistSchema = false;

    if (schemaState === "current") {
      this.settings = normalizePluginSettings(saved);
      this.persistedQueue = extractJobItems(saved);
    } else if (schemaState === "migrate" && migration.settings) {
      // 保留用户数据，只改写结构。队列一并保留：任务里的路径仍是用户自己的笔记。
      this.settings = normalizePluginSettings({ settings: migration.settings });
      this.persistedQueue = extractJobItems(saved);
      shouldPersistSchema = true;
      schemaNotice = `Q&A Log 设置已从版本 ${readSavedSchemaVersion(saved)} 升级到 ${SETTINGS_SCHEMA_VERSION}，你的服务配置与密钥都已保留。`;
    } else if (schemaState === "future") {
      // 高于当前版本：只读回认识的键，但绝不写盘（shouldPersistSchema 保持 false）。
      this.settings = normalizePluginSettings(saved);
      this.persistedQueue = extractJobItems(saved);
      schemaNotice = `磁盘上的设置来自更新的 Q&A Log（版本 ${readSavedSchemaVersion(saved)}，当前 ${SETTINGS_SCHEMA_VERSION}）。`
        + "为避免覆盖较新版本写入的字段，本版本不会保存设置改动。请升级插件后再修改设置。";
      console.warn(`[QnALog] 设置结构版本高于当前版本（${readSavedSchemaVersion(saved)} > ${SETTINGS_SCHEMA_VERSION}），本次不写盘`);
    } else {
      // foreign：别的项目、pre-1.0 遗留或损坏。先留档再丢弃。
      const stored = hasStoredSettings(saved);
      this.settings = normalizePluginSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION });
      this.persistedQueue = [];
      shouldPersistSchema = true;
      if (stored) {
        const backup = await this.backupForeignSettings(saved);
        schemaNotice = backup
          ? `Q&A Log 未识别磁盘上的设置（不是本插件 ${SETTINGS_SCHEMA_VERSION} 版写的），已改用默认设置。原文件已留档到：${backup}`
          : "Q&A Log 未识别磁盘上的设置（不是本插件当前版本写的），已改用默认设置。请在「设置 → Q&A Log」重新配置保存路径与访问密钥。";
        console.warn("[QnALog] 设置无法识别来源，已丢弃并改用默认值");
      }
    }

    // installedUpdateVersion 既记录内置更新器刚写入的待生效版本，也应在插件真正加载后
    // 与 manifest 对齐。否则通过 Obsidian 社区目录更新时，这个字段会永久停留在旧版本。
    // future 状态下不写盘，此处也不能触发保存。
    const runningVersion = String(this.manifest && this.manifest.version || "").trim();
    if (runningVersion && this.settings.installedUpdateVersion !== runningVersion && schemaState !== "future") {
      this.settings.installedUpdateVersion = runningVersion;
      shouldPersistSchema = true;
    }
    if (shouldPersistSchema) {
      try { await this.saveAll(); } catch (e) { console.warn("[QnALog] schema save failed", e); }
    }
    // 界面语言在设置读回后立刻生效：之后所有渲染（设置页、侧边栏、对话框）
    // 都按当前语言取词条。空串表示跟随 Obsidian 自己的界面语言。
    applyUiLanguage(this.settings);

    if (schemaNotice) {
      try {
        void this.diagnostics.logDiagnostic(
          schemaState === "migrate" ? "info" : "warn",
          `settings.schema_${schemaState}`,
          schemaNotice,
          { savedVersion: readSavedSchemaVersion(saved), currentVersion: SETTINGS_SCHEMA_VERSION, migrated: migration.path },
        );
        new obsidian.Notice(schemaNotice, 20000);
      } catch (e) {
        console.warn("[QnALog] schema notice failed", e);
      }
    }
  }

  /**
   * 丢弃无法识别的设置前，先把 data.json 复制一份到插件目录下。
   *
   * 正式用户也可能因为同步冲突或手工编辑拿到一份坏文件；直接覆盖等于永久丢失。
   * 只做文件复制，不改动原文件内容。移动端没有 fs 模块时返回空串，调用方退回通用提示。
   */
  async backupForeignSettings(saved: unknown): Promise<string> {
    const fsModule = getDesktopModule<{
      promises?: { mkdir?: (p: string, o?: unknown) => Promise<unknown>; writeFile?: (p: string, d: string) => Promise<unknown>; copyFile?: (a: string, b: string) => Promise<unknown> };
    }>("fs");
    const pathModule = getDesktopModule<{ join?: (...parts: string[]) => string }>("path");
    const promises = fsModule && fsModule.promises;
    if (!promises || typeof promises.writeFile !== "function" || !pathModule || typeof pathModule.join !== "function") {
      return "";
    }
    try {
      const pluginDir = String(this.manifest && this.manifest.dir
        ? this.manifest.dir
        : `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
      const dir = pathModule.join(pluginDir, "settings-backups");
      if (typeof promises.mkdir === "function") await promises.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const target = pathModule.join(dir, `data-unrecognized-${stamp}.json`);
      await promises.writeFile(target, JSON.stringify(saved ?? {}, null, 2));
      return target;
    } catch (e) {
      console.warn("[QnALog] settings backup failed", e);
      return "";
    }
  }
  /** 装配层转发：队列失败重试排期（熔断冷却、任务中心传输失败等）。 */
  requestTaskQueueRetry(delayMs: number, reason: string): void {
    this.queueRetry.scheduleTaskQueueRetry(delayMs, reason);
  }
  /** 装配层转发：转写熔断后的延迟重试排期。 */
  requestDeferredAsrRetry(session: RecordingSession): void {
    this.queueRetry.scheduleDeferredAsrRetry(session);
  }
  /** 装配层转发：读取知识库里的音频缓存（含 .cache 目录）。 */
  readVaultAudioBlob(path: string, fallbackName: string): Promise<{ blob: Blob; sourcePath: string; sourceName: string; recovered: boolean } | null> {
    return this.queueRetry.readVaultAudioBlob(path, fallbackName);
  }
  /** 装配层转发：队列批量重试节奏变化后刷新任务状态栏。 */
  notifyTaskBusyChanged(): void {
    this.tasks.updateBusyStatus();
  }
  /** 装配层转发：补转写成功后的说话人姓名确认；返回值在调用点不使用。 */
  confirmSpeakerNames(session: { id: string; mdPath: string; source: string; importTranscribeProviderId?: string }, segments: { text: string }[]): Promise<unknown> {
    return this.sessionFinalize.confirmSpeakerNamesBeforeFinal(session, segments);
  }
  /** 装配层转发：诊断报告生成时一次性采集运行时快照。报告只拿纯数据，不持有服务对象。 */
  getDiagnosticsSnapshot(session: RecordingSession | null): DiagnosticsSnapshot {
    return {
      liveAsrBacklog: session ? this.recording.getLiveAsrBacklogSummary(session) : summarizeLiveAsrJobs([]),
      recorderBuffer: this.recording.getRecorderBufferSummary(),
      recorderState: (this.recorder && this.recorder.state) || "idle",
      queueTasks: this.queue && Array.isArray(this.queue.tasks) ? this.queue.tasks : [],
    };
  }
  /** 装配层转发：域服务请求刷新侧边栏。域服务只拿这个方法，不持有 ViewShellService。 */
  requestOutlineRefresh(): void {
    this.shell.refreshOutlineView();
  }
  /** 装配层转发：录音流程结束后自动打开侧边栏。 */
  requestOpenOutlineView(): Promise<void> {
    return this.shell.openOutlineView();
  }
  async saveAll() {
    // 磁盘设置的版本高于本版本时，用户是回退了插件：此时写盘会把新版字段洗掉。
    // 这里拦下所有写入路径（设置页、队列、诊断），而不只是 loadAll 那一刻。
    if (this.settingsSchemaState === "future") {
      console.warn("[QnALog] 磁盘设置来自更新的版本，已跳过本次保存以免覆盖较新字段");
      return;
    }
    // 设置页、队列状态和后台任务都可能同时触发保存。直接并发 saveData 时，
    // 较早创建的旧快照可能较晚落盘，覆盖刚加入的任务或新设置。
    // 串行执行并在真正轮到写入时再取快照，保证磁盘最终状态与内存最新状态一致。
    const previous = this._saveAllTail != null ? this._saveAllTail : Promise.resolve();
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
      settings: serializePluginSettings(this.settings),
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
    const setting = (this.app as obsidian.App & { setting?: { open(): void; openTabById?(id: string): void } }).setting;
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
  }

  getUpdateRawBase() {
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

}

export default QnALogPlugin;
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
