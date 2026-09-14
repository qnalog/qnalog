/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// @ts-nocheck
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：知识提取的扫描记录：哪些笔记已扫描、按文件指纹判断是否需要重扫

import * as obsidian from "obsidian";
import { normalizeKnowledgeExtractionHistory } from "../shared/util-knowledge";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { LexVoiceSettings } from "../shared/types";
import { isKnowledgeSourceAlreadyScanned, knowledgeExtractionRecordForFile } from "../notes/recording-issues";

/** KnowledgeExtractionService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface KnowledgeExtractionHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: LexVoiceSettings;
}

export class KnowledgeExtractionService {
  declare host: KnowledgeExtractionHost;
  constructor(host) {
    this.host = host;
  }


  getKnowledgeExtractionSourceFiles(kind) {
    const folder = obsidian.normalizePath(this.host.settings.mdFolder || DEFAULT_SETTINGS.mdFolder);
    const prefix = folder ? folder + "/" : "";
    return this.host.app.vault.getMarkdownFiles()
      .filter(file => {
        const path = obsidian.normalizePath(file.path || "");
        if (folder && path !== folder && !path.startsWith(prefix)) return false;
        if (path === obsidian.normalizePath(this.host.settings.vocabularyFile || "")) return false;
        if (this.host.settings.peopleDirectoryFolder) {
          const peopleFolder = obsidian.normalizePath(this.host.settings.peopleDirectoryFolder);
          if (path === peopleFolder || path.startsWith(peopleFolder + "/")) return false;
        }
        return !isKnowledgeSourceAlreadyScanned(this.host.settings, kind, file);
      })
      .sort((a, b) => (b.stat && b.stat.mtime || 0) - (a.stat && a.stat.mtime || 0));
  }

  markKnowledgeExtractionSource(kind, file) {
    if (!(file instanceof obsidian.TFile)) return;
    const safeKind = kind === "people" ? "people" : "vocabulary";
    const history = normalizeKnowledgeExtractionHistory(this.host.settings.knowledgeExtractionHistory);
    history[safeKind][obsidian.normalizePath(file.path)] = knowledgeExtractionRecordForFile(file);
    this.host.settings.knowledgeExtractionHistory = history;
  }

  clearKnowledgeExtractionHistory(kind) {
    const history = normalizeKnowledgeExtractionHistory(this.host.settings.knowledgeExtractionHistory);
    if (kind === "people" || kind === "vocabulary") history[kind] = {};
    else {
      history.people = {};
      history.vocabulary = {};
    }
    this.host.settings.knowledgeExtractionHistory = history;
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
