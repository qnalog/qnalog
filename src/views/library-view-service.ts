/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：资料库视图：Base 视图的生成与打开

import * as obsidian from "obsidian";
import type { PluginSettings } from "../shared/types";
import { PeopleDirectoryService } from "../people/people-directory-service";
import { QNALOG_BASE_DEFINITIONS } from "../views/base-definitions";
import { ensureVaultFolder } from "../shared/util-vault";
import { DEFAULT_LIBRARY_PATHS, DEFAULT_SETTINGS } from "../shared/defaults";

import { t } from "../shared/i18n";
/** LibraryViewService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface LibraryViewHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  /** 人员库服务：解析人员 Base 的落点。 */
  people: PeopleDirectoryService;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
}

function getBasesFolder(settings: Pick<PluginSettings, "basesFolder">): string {
  return obsidian.normalizePath((settings && settings.basesFolder) || DEFAULT_SETTINGS.basesFolder || DEFAULT_LIBRARY_PATHS.basesFolder);
}

/** styles.css 里 Bases 卡片样式的作用范围：只有带这个类的视图（打开的是 QnALog 生成的 Base 文件）才套用。 */
export const QNALOG_BASE_VIEW_CLASS = "qnalog-base-view";

/** path 是否是 QnALog 生成的 Base 文件：人员库 Base，或视图文件夹下的 .base 文件。 */
export function isQnalogBasePath(
  path: string,
  settings: Pick<PluginSettings, "basesFolder" | "peopleBaseFile">,
): boolean {
  if (!path || !path.toLowerCase().endsWith(".base")) return false;
  const normalized = obsidian.normalizePath(path);
  const peopleBase = obsidian.normalizePath(settings.peopleBaseFile || DEFAULT_SETTINGS.peopleBaseFile);
  if (normalized === peopleBase) return true;
  return normalized.startsWith(getBasesFolder(settings) + "/");
}

export class LibraryViewService {
  declare host: LibraryViewHost;
  constructor(host: LibraryViewHost) {
    this.host = host;
  }

  // 创建 QnALog 视图（.base 文件）—— 7 个：4 按模式 + 3 场景
  // overwrite=false：已存在的文件保留；overwrite=true：强制覆盖（用户重置/升级用）
  async createBases(opts) {
    const overwrite = !!(opts && opts.overwrite);
    const basesFolder = getBasesFolder(this.host.settings);
    await ensureVaultFolder(this.host.app, basesFolder);
    await ensureVaultFolder(this.host.app, basesFolder + "/按模式");
    await ensureVaultFolder(this.host.app, basesFolder + "/场景");
    let created = 0, updated = 0, skipped = 0;
    for (const def of QNALOG_BASE_DEFINITIONS) {
      const path = obsidian.normalizePath(basesFolder + "/" + def.relPath);
      const existing = this.host.app.vault.getAbstractFileByPath(path);
      if (existing instanceof obsidian.TFile) {
        if (overwrite) {
          await this.host.app.vault.modify(existing, def.yaml);
          updated++;
        } else {
          skipped++;
        }
      } else {
        await this.host.app.vault.create(path, def.yaml);
        created++;
      }
    }
    return { created, updated, skipped };
  }

  async openPeopleBase() {
    const file = await this.host.people.ensurePeopleDirectoryFiles({ overwrite: false });
    if (file instanceof obsidian.TFile) await this.host.app.workspace.getLeaf(false).openFile(file);
    return file;
  }

  /**
   * 给打开 QnALog Base 文件的标签页加 QNALOG_BASE_VIEW_CLASS，其它 Base 视图去掉它。
   * 由装配入口在布局变化、切换标签页和打开文件时调用；插件卸载时调用 clearBaseViewScope。
   */
  syncBaseViewScope(): void {
    this.host.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as obsidian.View & { file?: obsidian.TFile | null };
      if (!view || !view.containerEl) return;
      const path = view.file ? view.file.path : "";
      view.containerEl.toggleClass(QNALOG_BASE_VIEW_CLASS, isQnalogBasePath(path, this.host.settings));
    });
  }

  clearBaseViewScope(): void {
    this.host.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view && leaf.view.containerEl) leaf.view.containerEl.removeClass(QNALOG_BASE_VIEW_CLASS);
    });
  }

  async openDetailBase() {
    await this.createBases({ overwrite: false });
    const path = obsidian.normalizePath(getBasesFolder(this.host.settings) + "/场景/全部纪要总览.base");
    const file = this.host.app.vault.getAbstractFileByPath(path);
    if (file instanceof obsidian.TFile) await this.host.app.workspace.getLeaf(false).openFile(file);
    else new obsidian.Notice(t("Detail Base not found. Please create the view file first."), 8000);
    return file;
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
