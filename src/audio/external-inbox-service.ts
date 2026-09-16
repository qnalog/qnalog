/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：外部收件箱：库外文件夹监听、指纹账本、复制与处理

import * as obsidian from "obsidian";
import type { ImportAudioFilesOptions, ImportAudioFilesResult } from "../imports/import-service";
import type { TaskActivityInput } from "../shared/task-activity";
import { getDesktopModule } from "../shared/desktop-runtime";
import { isMobileRuntime } from "../shared/util-platform";
import type { PluginSettings, RecordingSession } from "../shared/types";
import { AUDIO_EXT } from "../shared/catalog-import";
import { sanitizeFilename } from "../shared/util-common";
import { diagnosticError } from "../shared/util-key-diag";
import { getTaskErrorMessage } from "../shared/task-activity";
import { ExternalInboxScanner, createExternalInboxLedger, isAbsoluteExternalInboxPath, normalizeExternalInboxLedger, pruneExternalInboxLedger, shouldImportExternalInboxFile } from "../audio/external-inbox";
import { EXTERNAL_INBOX_RETRY_DELAYS_MS } from "../shared/limits";
import { RecorderService } from "../audio/recorder-service";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { TaskActivityService } from "../tasks/task-activity-service";

import { t } from "../shared/i18n";
/** 扫描电脑文件夹时的选项。 */
export interface ExternalInboxScanOptions {
  /** 用户从命令面板手动触发；手动触发时对不满足条件的来源给出提示。 */
  manual?: boolean;
  /** 扫描来源标记，写入台账。 */
  source?: string;
}

/** 桌面端 require("fs") 取到的模块里用到的成员。 */
type DesktopDirent = { name: string; isFile(): boolean; isDirectory(): boolean };
type DesktopStat = { mtimeMs: number; size: number; isFile(): boolean };
type DesktopFsModule = {
  promises?: {
    readdir(path: string, options: Record<string, unknown>): Promise<DesktopDirent[]>;
    stat(path: string): Promise<DesktopStat>;
    copyFile(source: string, target: string): Promise<void>;
    /** 不传 encoding 时返回 Buffer（Uint8Array 的子类）。 */
    readFile(path: string): Promise<Uint8Array>;
  };
  watch?: (path: string, options: Record<string, unknown>, listener: (event: string, name: string) => void) => unknown;
};

/** 桌面端 require("path") 取到的模块里用到的成员。 */
type DesktopPathModule = { join: (...parts: string[]) => string };

/** 桌面端 require("electron") / require("@electron/remote") 取到的模块里用到的成员。 */
type DesktopElectronModule = {
  dialog?: { showOpenDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePaths: string[] }> };
  remote?: DesktopElectronModule;
};

/** ExternalInboxService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface ExternalInboxHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  diagnostics: DiagnosticsService;
  /** 导入服务：把稳定的文件送进导入流程。 */
  imports: { importAudioFiles(paths: string[], modeOverride?: string, options?: ImportAudioFilesOptions): Promise<ImportAudioFilesResult | undefined> };
  manifest: { version?: string; id: string; dir?: string };
  recorder: RecorderService | null;
  /** 录音采集服务：分段缓存目录与缓存清理。 */
  recording: { ensureSegmentCacheFolder(): Promise<void>; getSegmentCacheFolder(): string; maybeDeleteSegmentCacheFile(path: string, excludeTaskId?: string, force?: boolean): Promise<void> };
  session: RecordingSession | null;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
  tasks: TaskActivityService;
}

export class ExternalInboxService {
  declare host: ExternalInboxHost;
  /** 库外收件箱的指纹账本：去重、重试次数与清理依据。 */
  declare _externalInboxLedger;
  /** 目录监听句柄与监听路径。 */
  declare _externalInboxWatcher;
  declare _externalInboxWatchedPath;
  /** 事件合并与稳定判定的两个定时器。 */
  declare _externalInboxEventTimer;
  declare _externalInboxStabilityTimer;
  /** 扫描串行化的锁、承诺与排队标记。 */
  declare _externalInboxScheduled;
  declare _externalInboxLock;
  declare _externalInboxScanPromise;
  /** 库外目录扫描器：按绝对路径轮询与事件监听。 */
  declare externalInboxScanner;
  constructor(host) {
    this.host = host;
    this._externalInboxLedger = null;
    this._externalInboxWatcher = null;
    this._externalInboxWatchedPath = null;
    this._externalInboxEventTimer = null;
    this._externalInboxStabilityTimer = null;
    this._externalInboxScheduled = null;
    this._externalInboxLock = null;
    this._externalInboxScanPromise = null;
    this.externalInboxScanner = null;
  }


  getExternalInboxStatePath() {
    const pluginDir = String(this.host.manifest && this.host.manifest.dir
      ? this.host.manifest.dir
      : `${this.host.app.vault.configDir}/plugins/${this.host.manifest.id}`);
    return obsidian.normalizePath(`${pluginDir}/external-inbox-state.json`);
  }

  getExternalInboxRuntime() {
    const fsModule = getDesktopModule<DesktopFsModule>("fs");
    const pathModule = getDesktopModule<DesktopPathModule>("path");
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
    if (isMobileRuntime()) {
      new obsidian.Notice(t("Automatic computer folder import is only supported on desktop"));
      return "";
    }
    let dialog = null;
    const electron = getDesktopModule<DesktopElectronModule>("electron");
    if (electron && electron.dialog) dialog = electron.dialog;
    if (!dialog && electron && electron.remote && electron.remote.dialog) dialog = electron.remote.dialog;
    if (!dialog) {
      const remote = getDesktopModule<DesktopElectronModule>("@electron/remote");
      if (remote && remote.dialog) dialog = remote.dialog;
    }
    if (!dialog || typeof dialog.showOpenDialog !== "function") {
      new obsidian.Notice(t("The current desktop environment cannot open a folder picker; paste the synced folder path directly"));
      return "";
    }
    const result = await dialog.showOpenDialog({
      title: t("Choose auto-import folder"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) return "";
    return String(result.filePaths[0]);
  }

  async loadExternalInboxLedger() {
    if (this._externalInboxLedger) return this._externalInboxLedger;
    const adapter = this.host.app.vault.adapter;
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
    const adapter = this.host.app.vault.adapter;
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
    const folder = String(this.host.settings.inboxFolder || "").trim();
    const enabled = !!this.host.settings.inboxAutoImport && isAbsoluteExternalInboxPath(folder) && !isMobileRuntime();
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
    const recorderState = this.host.recorder && this.host.recorder.state;
    return !!(
      (recorderState && recorderState !== "idle")
      || this.host.tasks._importBusy
      || (this.host.session && !this.host.session.finalized)
    );
  }

  externalInboxActivityId(file) {
    return `external-inbox:${file.fingerprint}`;
  }

  markExternalInboxWaiting(file, detail) {
    const id = this.externalInboxActivityId(file);
    const current = this.host.tasks.taskActivityStore && this.host.tasks.taskActivityStore.get(id);
    // 标注类型：否则 status/progress 会被推断成 string/number，无法赋给 Partial<TaskActivity>。
    const patch: TaskActivityInput = {
      id,
      kind: "external-audio-import",
      title: `自动导入 · ${file.name}`,
      subject: file.name,
      status: "waiting",
      stage: "waiting-source",
      stageLabel: t("Waiting to import"),
      detail,
      progress: 5,
    };
    if (current) this.host.tasks.patchTaskActivity(id, patch);
    else this.host.tasks.startTaskActivity(patch);
  }

  async scanExternalInboxFolder(options: ExternalInboxScanOptions = {}) {
    const manual = !!options.manual;
    const folder = String(this.host.settings.inboxFolder || "").trim();
    if (!isAbsoluteExternalInboxPath(folder)) {
      if (manual) new obsidian.Notice(t("The current source is not a computer folder"));
      return { queued: 0, waiting: 0, skipped: 0 };
    }
    if (isMobileRuntime()) {
      if (manual) new obsidian.Notice(t("Automatic computer folder import is only supported on desktop"));
      return { queued: 0, waiting: 0, skipped: 0 };
    }
    if (this._externalInboxScanPromise) return this._externalInboxScanPromise;
    const run = (async () => {
      const runtime = this.getExternalInboxRuntime();
      if (!runtime) throw new Error("当前桌面环境无法读取电脑文件夹");
      if (!this.externalInboxScanner) this.externalInboxScanner = new ExternalInboxScanner();
      const quietMs = Math.max(3000, Number(this.host.settings.inboxStabilizeDelayMs) || 0);
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
        else new obsidian.Notice(t("No new audio files"));
      }
      if (result.truncated) new obsidian.Notice(t("The auto-import folder has more than 2000 audio files; only the first 2000 were scanned this time"), 8000);
      return { queued: candidates.length, waiting: result.waiting.length, skipped: result.ready.length - candidates.length };
    })();
    this._externalInboxScanPromise = run;
    try {
      return await run;
    } catch (e) {
      await this.host.diagnostics.logDiagnostic("error", "inbox.external_scan_failed", "外部音频文件夹扫描失败", {
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
    await this.host.recording.ensureSegmentCacheFolder();
    const safeStem = sanitizeFilename(String(file.name || "audio").replace(/\.[^.]+$/, "")) || "audio";
    const extension = String(file.extension || "audio").toLowerCase();
    const cacheName = `${file.fingerprint}-${safeStem}.${extension}`;
    const cachePath = obsidian.normalizePath(`${this.host.recording.getSegmentCacheFolder()}/${cacheName}`);
    const adapter = this.host.app.vault.adapter;
    if (await adapter.exists(cachePath)) await adapter.remove(cachePath);
    const desktopAdapter = adapter as { getFullPath?: (p: string) => string };
      const fullCachePath = typeof desktopAdapter.getFullPath === "function" ? desktopAdapter.getFullPath(cachePath) : "";
    if (fullCachePath && typeof runtime.promises.copyFile === "function") {
      await runtime.promises.copyFile(file.fullPath, fullCachePath);
    } else {
      const bytes = await runtime.promises.readFile(file.fullPath);
      // Uint8Array 的 buffer 可能是 SharedArrayBuffer；写入二进制需要 ArrayBuffer 视图。
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      await adapter.writeBinary(cachePath, arrayBuffer);
    }
    const current = await runtime.fileSystem.stat(file.fullPath);
    if (current.size !== file.size || current.mtimeMs !== file.mtimeMs) {
      try { if (await adapter.exists(cachePath)) await adapter.remove(cachePath); } catch { /* intentionally empty */ }
      const changed = new Error("文件仍在同步，稍后重试");
      (changed as Error & { code?: string }).code = "EXTERNAL_FILE_CHANGED";
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
      this.host.tasks.patchTaskActivity(activityId, {
        status: "running",
        stage: "copying-source",
        stageLabel: t("Reading audio"),
        detail: "正在读取同步文件",
        progress: 10,
        attempt,
        maxAttempts: 3,
      });
      cachePath = await this.copyExternalInboxFileToCache(file);
      this.host.tasks.patchTaskActivity(activityId, {
        status: "running",
        stage: "transcribing",
        stageLabel: t("Transcription and organization"),
        detail: "音频已就绪，正在生成纪要",
        progress: 20,
      });
      await this.host.diagnostics.logDiagnostic("info", "inbox.external_import_started", "开始自动导入外部音频", {
        audioName: file.name,
        size: file.size,
        fingerprint: file.fingerprint,
      });
      const result = await this.host.imports.importAudioFiles([cachePath], "synthesis", {
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
      this.host.tasks.completeTaskActivity(activityId, {
        stage: "done",
        stageLabel: pendingTranscriptionCount ? "纪要已创建" : "自动导入完成",
        detail: pendingTranscriptionCount
          ? `纪要已创建；${pendingTranscriptionCount} 个片段已保留并等待转写重试`
          : entry.notePath ? `纪要已写入 ${entry.notePath}` : "纪要已写入库中",
        progress: 100,
      });
      await this.host.diagnostics.logDiagnostic("info", "inbox.external_import_completed", "外部音频自动导入完成", {
        audioName: file.name,
        size: file.size,
        fingerprint: file.fingerprint,
        mdPath: entry.notePath,
      });
    } catch (e) {
      this.host.tasks._importBusy = null;
      this.host.tasks.updateBusyStatus();
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
        this.host.tasks.failTaskActivity(activityId, e, {
          stage: "failed",
          stageLabel: t("Auto-import not completed"),
          detail: entry.error,
          actions: [{ id: "open-settings", label: t("Check settings") }],
        });
      }
      await this.host.diagnostics.logDiagnostic("error", "inbox.external_import_failed", "外部音频自动导入失败", {
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
        try { await this.host.recording.maybeDeleteSegmentCacheFile(cachePath, undefined, true); } catch { /* queue references keep required retry files */ }
      }
    }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
