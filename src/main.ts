/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// @ts-nocheck
import * as obsidian from "obsidian";

import { LexVoiceSettingTab } from "./ui/settings-tab";

import { MinutesKanbanView, VIEW_TYPE_MINUTES_KANBAN } from "./ui/minutes-kanban-view";

import {QueueModal, ImportTextModal, ImportAudioModal, BubbleWidget } from "./ui/modals";

import {getModeMeta, getVisibleModeEntries } from "./shared/mode-meta";

import { UpdateService } from "./update-service";




import {DEFAULT_SETTINGS } from "./shared/defaults";

// 设置序列化层已抽到独立模块（src/shared/settings-io.ts）并由 round-trip 测试覆盖（tests/settings-io.test.ts）。
// 这里 import 回来，保持原有调用点用裸名引用不变。
import {SETTINGS_SCHEMA_VERSION, normalizeLexVoiceSettings, serializeLexVoiceSettings, extractLexVoiceJobItems } from "./shared/settings-io";

import { buildSettingsMigrationReport } from "./shared/settings-migration-report";

import type {LexVoiceSettings } from "./shared/types";
import { describeBuildSource, normalizePluginBuildInfo, resolveDisplayVersion, type PluginBuildInfo } from "./shared/build-info";

import {AUDIO_EXT } from "./shared/catalog-import";

import {isRecord, pickDefined } from "./shared/util-common";

import {obfuscateApiKey, deobfuscateApiKey } from "./shared/util-key-diag";

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

// 以下 1 个声明已抽到 ./ui/outline-view（纯搬迁、零行为改动），这里 import 回来保持裸名调用点不变。
import { OutlineView } from "./ui/outline-view";

import { DiagnosticsService } from "./diagnostics/diagnostics-service";
import { TaskActivityService } from "./tasks/task-activity-service";
import { DeliveryService } from "./delivery/delivery-service";
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
import { ImportService } from "./imports/import-service";
import { ExternalInboxService } from "./audio/external-inbox-service";
import { RepolishService } from "./notes/repolish-service";
import { InboxWatcherService } from "./imports/inbox-watcher-service";
import { KnowledgeExtractionService } from "./indexing/knowledge-extraction-service";
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

    this.addCommand({ id: "scan-inbox", name: "扫描监听文件夹", callback: () => this.inbox.scanInboxFolder() });
    this.externalInbox.externalInboxScanner = new ExternalInboxScanner();
    this.registerInterval(window.setInterval(() => {
      if (!this.settings.inboxAutoImport || !isAbsoluteExternalInboxPath(this.settings.inboxFolder)) return;
      void this.externalInbox.scanExternalInboxFolder({ manual: false, source: "poll" });
    }, EXTERNAL_INBOX_SCAN_INTERVAL_MS));

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
        void this.repolish.repolishMarkdownFile(file, mode);
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
            .onClick(() => this.imports.openAudioImportOptions([file.path]));
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
              .onClick(() => this.imports.openAudioImportOptions(paths, m));
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

export default LexVoicePlugin;
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
