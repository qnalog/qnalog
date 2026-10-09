/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：重新整理：按说话人姓名重排当前纪要、生成清稿

import * as obsidian from "obsidian";
import { getModeDisplayName, getModeMeta, getModePrefix } from "../shared/mode-meta";
import type { PluginSettings } from "../shared/types";
import { getLearnedLlmOutputCeiling } from "../llm/output-budget";
import { clearCommittedBriefingCheckpoint } from "../prompts/briefing-prompts";
import { detectRecentNoteMode } from "../recent/recent-notes";
import { cleanTranscript, mergeAndPolish } from "../briefing/merge-pipeline";
import { TaskActivityService } from "../tasks/task-activity-service";
import { VersionStore } from "../versions/version-store";
import { NoteIndexService } from "../notes/note-index-service";
import { stripModeSuggestionBlocks } from "../llm/core";
import type { RepolishOptions, RepolishFlowBasePort, RepolishFlowPort } from "./repolish-flow";
import { repolishMarkdownFile as repolishMarkdownFileFlow } from "./repolish-flow";
import type { CleanScriptFlowPort } from "./clean-script-flow";
import { generateCleanScript as generateCleanScriptFlow, findCleanCopy as findCleanCopyFlow } from "./clean-script-flow";
import type { Segment } from "../shared/types";

/** RepolishService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface RepolishHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  noteIndex: NoteIndexService;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
  tasks: TaskActivityService;
  versions: VersionStore;
  /** 生成新派生纪要后刷新最近纪要列表。 */
  requestOutlineRefresh(): void;
}

export class RepolishService {
  declare host: RepolishHost;
  /** 同一篇笔记的重新整理串行化标记。 */
  declare _repolishInFlight: Set<string> | null;
  /** 同一来源的清稿任务单飞，避免重复请求同时写同一份版本文件。 */
  declare _cleanInFlight: Set<string>;
  constructor(host: RepolishHost) {
    this.host = host;
    this._repolishInFlight = null;
    this._cleanInFlight = new Set();
  }

  async repolishMarkdownFile(file: unknown, mode: string, repolishOptions: RepolishOptions = null): Promise<void> {
    return repolishMarkdownFileFlow(this.repolishPort(), file, mode, repolishOptions);
  }

  async findCleanCopy(sourceFile: obsidian.TFile): Promise<obsidian.TFile | null> {
    return findCleanCopyFlow(this.cleanScriptPort(), sourceFile);
  }

  async generateCleanScript(
    file: obsidian.TFile, options: { regenerateExisting?: boolean } = {},
  ): Promise<void> {
    return generateCleanScriptFlow(this.cleanScriptPort(), file, options);
  }

  private repolishBasePort(): RepolishFlowBasePort {
    return {
      getVault: () => this.host.app.vault,
      getCachedFrontmatter: (file) => this.host.app.metadataCache.getFileCache(file)?.frontmatter,
      getModeMeta: (mode) => getModeMeta(this.host.settings, mode),
      detectNoteMode: (file, fm) => detectRecentNoteMode(this.host, file, fm),
      tasks: {
        setBusyLabel: (label) => { this.host.tasks._busyLabel = label; },
        setBusyContext: (context) => { this.host.tasks._busyContext = context; },
        updateBusyStatus: () => this.host.tasks.updateBusyStatus(),
        startTaskActivity: (input) => this.host.tasks.startTaskActivity(input),
        patchTaskActivity: (id, patch) => this.host.tasks.patchTaskActivity(id, patch),
        completeTaskActivity: (id, patch) => this.host.tasks.completeTaskActivity(id, patch),
        failTaskActivity: (id, error, patch) => this.host.tasks.failTaskActivity(id, error, patch),
        beginTaskMeter: () => this.host.tasks.beginTaskMeter(),
        endTaskMeter: (meter) => this.host.tasks.endTaskMeter(meter),
        logCompletedWork: (label, path, meter) => this.host.tasks.logCompletedWork(label, path, meter),
      },
      ensureOriginalVersionForSource: (file) => this.host.versions.ensureOriginalVersionForSource(file),
      createDerivedNote: (file, content, version, label, mode, style) => this.host.versions.createDerivedNote(file, content, version, label, mode, style),
    };
  }

  private repolishPort(): RepolishFlowPort {
    return {
      ...this.repolishBasePort(),
      getModeDisplayName: (mode) => getModeDisplayName(this.host.settings, mode),
      getModePrefix: (meta) => getModePrefix(meta),
      getInFlight: () => {
        if (!this._repolishInFlight) this._repolishInFlight = new Set();
        return this._repolishInFlight;
      },
      mergeAndPolish: (segments, mode, sessionMeta, fm, options) => mergeAndPolish(this.host, segments, mode, sessionMeta, fm, options),
      stripModeSuggestionBlocks: (text) => stripModeSuggestionBlocks(text),
      clearCommittedBriefingCheckpoint: (sessionMeta) => clearCommittedBriefingCheckpoint(this.host, sessionMeta),
      saveVersion: (file, content, segments, input) => this.host.versions.saveVersion(file, content, segments, input),
      requestOutlineRefresh: () => this.host.requestOutlineRefresh(),
    };
  }

  private cleanScriptPort(): CleanScriptFlowPort {
    return {
      ...this.repolishBasePort(),
      getVault: () => this.host.app.vault,
      getCleanInFlight: () => this._cleanInFlight,
      findDerivedNoteForSource: (file, sourceId, kind) => this.host.versions.findDerivedNoteForSource(file, sourceId, kind),
      switchVersion: (file, fallbackSourcePath) => this.host.versions.switchVersion(file, fallbackSourcePath),
      getLearnedOutputCeiling: () => getLearnedLlmOutputCeiling(this.host.settings),
      cleanTranscript: (segments: Segment[], ceiling: number) => cleanTranscript(this.host, segments, ceiling),
    };
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
