/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：库内收件箱：监听文件夹里的文件接入导入流程

import * as obsidian from "obsidian";
import type { LexVoiceSettings } from "../shared/types";
import { AUDIO_EXT } from "../shared/catalog-import";
import { isAbsoluteExternalInboxPath } from "../audio/external-inbox";
import { isSyncConflictName } from "../notes/recording-issues";
import { ensureVaultFolder, findAvailableVaultPath } from "../shared/util-vault";

/** InboxWatcherService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface InboxWatcherHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  /** 外部收件箱服务：扫描库外文件夹。 */
  externalInbox: { scanExternalInboxFolder(options?: unknown): Promise<void> };
  /** 导入服务：把收件箱里的文件送进导入流程。 */
  imports: { importAudioFiles(paths: string[], modeOverride?: string, options?: unknown): Promise<void>; importTextFiles(paths: string[], modeOverride?: string): Promise<void> };
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: LexVoiceSettings;
}

export class InboxWatcherService {
  declare host: InboxWatcherHost;
  /** 收件箱处理的锁、排队标记与同步冲突提示去重。 */
  declare _inboxConflictNotified;
  declare _inboxLock;
  declare _inboxPending;
  declare _inboxProcessing;
  constructor(host) {
    this.host = host;
    this._inboxConflictNotified = null;
    this._inboxLock = null;
    this._inboxPending = null;
    this._inboxProcessing = null;
  }

  async handleInboxFile(file) {
    if (!(file instanceof obsidian.TFile)) return;
    if (!AUDIO_EXT.has((file.extension || "").toLowerCase())) return;
    const inbox = this.host.settings.inboxFolder;
    if (!inbox || isAbsoluteExternalInboxPath(inbox)) return;
    const inboxNorm = obsidian.normalizePath(inbox);
    if (!file.path.startsWith(inboxNorm + "/") && file.path !== inboxNorm) return;
    const archiveSub = this.host.settings.inboxArchiveSubfolder || "";
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
    if (!this.host.settings.inboxAutoImport) return;

    // 显式判断而非 || 3000：让"填 0 = 立即处理"真正生效（0 是合法值，|| 会把它吞成 3000）
    const rawDelay = Number(this.host.settings.inboxStabilizeDelayMs);
    const delay = Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 3000;
    this._inboxPending = this._inboxPending || new Map();
    const previous = this._inboxPending.get(file.path);
    if (previous && previous.timer) window.clearTimeout(previous.timer);
    const observedSize = Math.max(0, Number(file.stat && file.stat.size) || 0);
    const observedMtime = Math.max(0, Number(file.stat && file.stat.mtime) || 0);
    const timer = window.setTimeout(() => {
      this._inboxPending.delete(file.path);
      const fresh = this.host.app.vault.getAbstractFileByPath(file.path);
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
          await this.host.imports.importAudioFiles([file.path]);
          if (archiveSub) {
            await ensureVaultFolder(this.host.app, `${inboxNorm}/${archiveSub}`);
            const archivePath = findAvailableVaultPath(this.host.app, obsidian.normalizePath(`${inboxNorm}/${archiveSub}/${file.name}`));
            const stillExists = this.host.app.vault.getAbstractFileByPath(file.path);
            if (archivePath && stillExists instanceof obsidian.TFile) {
              try { await this.host.app.fileManager.renameFile(stillExists, archivePath); }
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
    const inbox = this.host.settings.inboxFolder;
    if (!inbox) { new obsidian.Notice("未配置监听文件夹"); return; }
    if (isAbsoluteExternalInboxPath(inbox)) {
      return this.host.externalInbox.scanExternalInboxFolder({ manual: true, source: "command" });
    }
    const inboxNorm = obsidian.normalizePath(inbox);
    const folder = this.host.app.vault.getAbstractFileByPath(inboxNorm);
    if (!(folder instanceof obsidian.TFolder)) {
      new obsidian.Notice(`监听文件夹不存在：${inboxNorm}`);
      return;
    }
    const archiveSub = this.host.settings.inboxArchiveSubfolder || "";
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
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
