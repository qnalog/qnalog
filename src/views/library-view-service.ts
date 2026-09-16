/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：资料库视图：Base 与卡片墙的生成与打开、生成文件的落盘与打开

import * as obsidian from "obsidian";
import type { PluginSettings } from "../shared/types";
import { PeopleDirectoryService } from "../people/people-directory-service";
import { LV_BASE_DEFINITIONS } from "../views/base-definitions";
import { TODO_WALL_FILE, formatTodoWallMarkdown, getBasesFolder, getWallPath, insertGeneratedWallMarker } from "../views/wall-markdown";
import { ensureVaultFolder } from "../shared/util-vault";
import { NS_WALL_MARKER_RE } from "../shared/namespace";

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

/** 生成文件落盘时的选项。overwrite=true 时无条件覆盖；否则仅覆盖带生成标记或内容为空的文件。 */
export interface UpsertGeneratedMarkdownOptions {
  overwrite?: boolean;
}

export class LibraryViewService {
  declare host: LibraryViewHost;
  constructor(host) {
    this.host = host;
  }

  // 创建 Q&A Log 视图（.base 文件）—— 7 个：4 按模式 + 3 场景
  // overwrite=false：已存在的文件保留；overwrite=true：强制覆盖（用户重置/升级用）
  async createBases(opts) {
    const overwrite = !!(opts && opts.overwrite);
    const basesFolder = getBasesFolder(this.host.settings);
    await ensureVaultFolder(this.host.app, basesFolder);
    await ensureVaultFolder(this.host.app, basesFolder + "/按模式");
    await ensureVaultFolder(this.host.app, basesFolder + "/场景");
    let created = 0, updated = 0, skipped = 0;
    for (const def of LV_BASE_DEFINITIONS) {
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

  async upsertGeneratedMarkdownFile(path, content, opts: UpsertGeneratedMarkdownOptions = {}) {
    const norm = obsidian.normalizePath(path);
    const folder = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
    if (folder) await ensureVaultFolder(this.host.app, folder);
    let file = this.host.app.vault.getAbstractFileByPath(norm);
    if (file instanceof obsidian.TFile) {
      const current = await this.host.app.vault.cachedRead(file);
      const shouldUpdate = opts.overwrite || NS_WALL_MARKER_RE.test(current) || current.trim() === "";
      if (shouldUpdate && current !== content) await this.host.app.vault.modify(file, content);
      return file;
    }
    file = await this.host.app.vault.create(norm, content);
    return file;
  }

  async openGeneratedMarkdown(path, content, opts: UpsertGeneratedMarkdownOptions = {}) {
    const withMarker = insertGeneratedWallMarker(content);
    const file = await this.upsertGeneratedMarkdownFile(path, withMarker, opts);
    if (file instanceof obsidian.TFile) await this.host.app.workspace.getLeaf(false).openFile(file);
    return file;
  }

  async openTodoWall() {
    return await this.openGeneratedMarkdown(getWallPath(this.host.settings, TODO_WALL_FILE), formatTodoWallMarkdown(this.host.settings), { overwrite: true });
  }

  async openPeopleBase() {
    const file = await this.host.people.ensurePeopleDirectoryFiles({ overwrite: false });
    if (file instanceof obsidian.TFile) await this.host.app.workspace.getLeaf(false).openFile(file);
    return file;
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
