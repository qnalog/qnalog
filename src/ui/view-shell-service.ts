/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：视图外壳：侧边栏的打开、气泡显隐联动、会议日程问答入口

import * as obsidian from "obsidian";
import { BubbleWidget } from "../ui/modals";
import { isMobileRuntime } from "../shared/util-platform";
import type { PluginSettings } from "../shared/types";
import type { SessionStore } from "../session/session-store";
import { VIEW_TYPE_OUTLINE } from "../notes/realtime-outline";
import { getRecentNotes } from "../recent/recent-notes";
import { TaskActivityService } from "../tasks/task-activity-service";
import { nsMarker } from "../shared/namespace";

import { t } from "../shared/i18n";
/** ViewShellService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface ViewShellHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  bubble: BubbleWidget | null;
  /** 录音功能区图标；气泡挂载在它旁边。 */
  ribbonEl: HTMLElement | null;
  sessionStore: SessionStore;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
  tasks: TaskActivityService;
}

export class ViewShellService {
  declare host: ViewShellHost;
  constructor(host: ViewShellHost) {
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

  async openSessionNote() {
    const session = this.host.sessionStore.get();
    const mdPath = session && session.mdPath;
    if (!mdPath) { await this.openRecentNote(); return; }
    const file = this.host.app.vault.getAbstractFileByPath(mdPath);
    if (!(file instanceof obsidian.TFile)) { new obsidian.Notice(t("The current recording note has not been generated yet")); return; }
    const leaf = this.host.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    try {
      const view = leaf.view as obsidian.View & { editor?: obsidian.Editor };
      const editor = view && view.editor;
      if (editor) {
        const content = editor.getValue();
        const marker = nsMarker("segments-end", session && session.id ? session.id : undefined);
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
      new obsidian.Notice(t("No recording notes recently"));
      return;
    }
    await this.host.app.workspace.getLeaf(false).openFile(recent[0].file);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
