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
