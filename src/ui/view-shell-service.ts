/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：视图外壳：侧边栏与看板的打开、气泡显隐联动、会议日程问答入口

import * as obsidian from "obsidian";
import { getSemanticCanvasPath } from "../canvas/semantic-outline-canvas";
import { VIEW_TYPE_MINUTES_KANBAN } from "../ui/minutes-kanban-view";
import { BubbleWidget } from "../ui/modals";
import { getModeMeta } from "../shared/mode-meta";
import { isMobileRuntime } from "../shared/util-platform";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { PluginSettings, RecordingSession } from "../shared/types";
import { MODE_META } from "../shared/catalog-modes";
import { sanitizeFilename } from "../shared/util-common";
import { VIEW_TYPE_OUTLINE } from "../notes/realtime-outline";
import { getRecentNotes } from "../recent/recent-notes";
import { TaskActivityService } from "../tasks/task-activity-service";
import { ensureVaultFolder, findAvailableVaultPath, findAvailableMarkdownPath } from "../shared/util-vault";

/** ViewShellService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface ViewShellHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  bubble: BubbleWidget | null;
  /** 录音功能区图标；气泡挂载在它旁边。 */
  ribbonEl: HTMLElement | null;
  session: RecordingSession | null;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
  tasks: TaskActivityService;
}

export class ViewShellService {
  declare host: ViewShellHost;
  constructor(host) {
    this.host = host;
  }

  async openOutlineView() {
    const existing = this.host.app.workspace.getLeavesOfType(VIEW_TYPE_OUTLINE);
    if (existing.length) {
      void this.host.app.workspace.revealLeaf(existing[0]);
      this.syncBubbleVisibility();
      return;
    }
    const leaf = isMobileRuntime()
      ? this.host.app.workspace.getLeaf(true)
      : (this.host.app.workspace.getRightLeaf(false) || this.host.app.workspace.getLeaf(true));
    await leaf.setViewState({ type: VIEW_TYPE_OUTLINE, active: true });
    void this.host.app.workspace.revealLeaf(leaf);
    this.syncBubbleVisibility();
  }

  refreshOutlineView() {
    try { this.host.tasks.updateBusyStatus(); } catch { /* intentionally empty */ }
    const leaves = this.host.app.workspace.getLeavesOfType(VIEW_TYPE_OUTLINE);
    for (const leaf of leaves) {
      const v = leaf.view as obsidian.View & { scheduleUpdate?: () => void; render?: () => void };
      if (!v) continue;
      // 优先走节流通道；旧实例兜底直调 render
      if (typeof v.scheduleUpdate === "function") v.scheduleUpdate();
      else if (typeof v.render === "function") v.render();
    }
  }

  // 判断实时纪要面板是否真正在 viewport 中可见
  // 三种"不可见"情况都要识别：
  //   1. leaf 不存在
  //   2. leaf 存在但所在侧边栏被折叠 (rightSplit.collapsed)
  //   3. leaf 存在且侧边栏展开，但用户切到了同侧边栏的其他 tab（leaf 未激活）
  isOutlineVisible() {
    const leaves = this.host.app.workspace.getLeavesOfType(VIEW_TYPE_OUTLINE);
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
    if (!this.host.bubble) return;
    const visible = !!this.host.settings.showFloatingBall;
    if (visible && !this.host.bubble.wrapEl) {
      this.host.bubble.mount(this.host.ribbonEl);
    } else if (!visible && this.host.bubble.wrapEl) {
      this.host.bubble.unmount();
    } else if (visible && this.host.bubble.wrapEl) {
      this.host.bubble.show();
      this.host.bubble.keepInViewport();
      this.host.bubble.updateDockTail();
    }
  }

  async openMinutesKanban() {
    const existing = this.host.app.workspace.getLeavesOfType(VIEW_TYPE_MINUTES_KANBAN);
    if (existing.length) {
      await this.host.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.host.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_MINUTES_KANBAN, active: true });
    await this.host.app.workspace.revealLeaf(leaf);
  }

  getMinutesKanbanItems() {
    const canvasFiles = this.host.app.vault.getFiles().filter((file) => file.extension === "canvas");
    const root = obsidian.normalizePath(this.host.settings.mdFolder || DEFAULT_SETTINGS.mdFolder);
    return getRecentNotes(this.host, Number.MAX_SAFE_INTEGER).filter((item) => {
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
      const meta = getModeMeta(this.host.settings, item.mode) || MODE_META.off;
      return {
        file: item.file,
        title: item.title || item.file.basename,
        mode: item.mode,
        modeLabel: meta.prefix || "纪要",
        icon: meta.icon || "file-text",
        folderPath: item.folderPath || obsidian.normalizePath(this.host.settings.mdFolder || DEFAULT_SETTINGS.mdFolder),
        timeLabel: item.displayTime || "",
        durationLabel: item.durationLabel || "",
        canvasFiles: associatedCanvases,
      };
    });
  }

  async createMinutesKanbanFolder(rawName) {
    const name = sanitizeFilename(String(rawName || "").replace(/[\\/]+/g, " ")).trim();
    if (!name) throw new Error("请输入有效的文件夹名称");
    const root = obsidian.normalizePath(this.host.settings.mdFolder || DEFAULT_SETTINGS.mdFolder);
    const path = obsidian.normalizePath(`${root}/${name}`);
    const existing = this.host.app.vault.getAbstractFileByPath(path);
    if (existing && !(existing instanceof obsidian.TFolder)) throw new Error("同名文件已存在");
    if (!existing) await ensureVaultFolder(this.host.app, path);
    return path;
  }

  async moveMinutesKanbanItem(item, rawFolderPath) {
    const file = item && item.file;
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") throw new Error("纪要文件不存在");
    const root = obsidian.normalizePath(this.host.settings.mdFolder || DEFAULT_SETTINGS.mdFolder);
    const folderPath = obsidian.normalizePath(rawFolderPath || root);
    if (!(folderPath === root || folderPath.startsWith(`${root}/`))) throw new Error("目标分组不在纪要目录内");
    await ensureVaultFolder(this.host.app, folderPath);
    const currentFolder = file.parent ? obsidian.normalizePath(file.parent.path) : "";
    if (currentFolder === folderPath) return;

    const oldNotePath = obsidian.normalizePath(file.path);
    const oldBase = file.basename;
    const canvasSnapshots = [];
    for (const canvasFile of Array.isArray(item.canvasFiles) ? item.canvasFiles : []) {
      if (!(canvasFile instanceof obsidian.TFile) || canvasFile.extension !== "canvas") continue;
      let content = "";
      try { content = await this.host.app.vault.cachedRead(canvasFile); } catch { /* keep moving the note */ }
      canvasSnapshots.push({ file: canvasFile, content });
    }

    const noteTarget = findAvailableMarkdownPath(this.host.app, `${folderPath}/${file.name}`, oldNotePath);
    if (!noteTarget) throw new Error("无法生成可用的目标文件名");
    await this.host.app.fileManager.renameFile(file, noteTarget);
    const movedNote = this.host.app.vault.getAbstractFileByPath(noteTarget);
    const newBase = movedNote instanceof obsidian.TFile
      ? movedNote.basename
      : String(noteTarget.split("/").pop() || oldBase).replace(/\.md$/i, "");

    for (const snapshot of canvasSnapshots) {
      const suffix = snapshot.file.basename.startsWith(oldBase)
        ? snapshot.file.basename.slice(oldBase.length)
        : " · 语义图";
      const canvasTarget = findAvailableVaultPath(this.host.app, `${folderPath}/${newBase}${suffix}.canvas`);
      if (!canvasTarget) continue;
      try {
        await this.host.app.fileManager.renameFile(snapshot.file, canvasTarget);
        const movedCanvas = this.host.app.vault.getAbstractFileByPath(canvasTarget);
        if (!(movedCanvas instanceof obsidian.TFile) || !snapshot.content) continue;
        const document = JSON.parse(snapshot.content);
        if (document && typeof document === "object" && document.lexvoiceSemantic && typeof document.lexvoiceSemantic === "object") {
          document.lexvoiceSemantic.sourcePath = noteTarget;
          await this.host.app.vault.modify(movedCanvas, JSON.stringify(document, null, 2));
        }
      } catch (error) {
        console.warn("[QnALog] move associated semantic canvas failed", error);
      }
    }
  }

  async openSessionNote() {
    const mdPath = this.host.session && this.host.session.mdPath;
    if (!mdPath) { await this.openRecentNote(); return; }
    const file = this.host.app.vault.getAbstractFileByPath(mdPath);
    if (!(file instanceof obsidian.TFile)) { new obsidian.Notice("当前录音笔记尚未生成"); return; }
    const leaf = this.host.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    try {
      const view = leaf.view as obsidian.View & { editor?: obsidian.Editor };
      const editor = view && view.editor;
      if (editor) {
        const content = editor.getValue();
        const marker = this.host.session && this.host.session.id ? `<!-- lexvoice-segments-end:${this.host.session.id} -->` : "<!-- lexvoice-segments-end -->";
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
    const recent = getRecentNotes(this.host, 1);
    if (!recent.length || !(recent[0].file instanceof obsidian.TFile)) {
      new obsidian.Notice("最近没有录音笔记");
      return;
    }
    await this.host.app.workspace.getLeaf(false).openFile(recent[0].file);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
