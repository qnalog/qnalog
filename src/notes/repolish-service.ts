/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：重新整理：按说话人姓名重排当前纪要、生成清稿

import * as obsidian from "obsidian";
import { getEffectivePolishMode, getModeDisplayName, getModeMeta, getModePrefix, getVisibleModeEntries } from "../shared/mode-meta";
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
import { reorganizeNoteInPlace as reorganizeNoteInPlaceFlow } from "./reorganize-in-place-flow";
import type { ReorganizeInPlaceOptions, ReorganizeInPlacePort } from "./reorganize-in-place-flow";
import type { CleanScriptFlowPort } from "./clean-script-flow";
import { generateCleanScript as generateCleanScriptFlow, findCleanCopy as findCleanCopyFlow } from "./clean-script-flow";
import type { Segment } from "../shared/types";
import type { ErrataService } from "../errata/errata-service";
import { transcribeImportedAudio } from "../asr/long-audio-transcription";
import { defaultFolderPaths } from "../shared/defaults";
import { ensureVaultFolder, findAvailableMarkdownPath } from "../shared/util-vault";
import { t } from "../shared/i18n";
import { recoverOriginalTranscript } from "./transcript-recovery-flow";
import type { TranscriptRecoveryPort } from "./transcript-recovery-flow";

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
  errata: Pick<ErrataService, "loadForFile">;
}

/** 需要界面交互的能力，由装配入口注入，避免业务层依赖界面实现。 */
export interface RepolishInteraction {
  confirm(title: string, body: string, ctaText: string): Promise<boolean>;
  pickAudioFile(files: obsidian.TFile[]): Promise<obsidian.TFile | null>;
}

/** 按整理正文生成标题并改名（由装配入口注入笔记写入器的同名能力）。 */
export type RepolishTitleRename = (file: obsidian.TFile, polished: string, mode: string) => Promise<unknown>;

export class RepolishService {
  declare interaction: RepolishInteraction;
  declare renameWithGeneratedTitle: RepolishTitleRename;
  declare host: RepolishHost;
  /** 同一篇笔记的重新整理串行化标记。 */
  declare _repolishInFlight: Set<string> | null;
  /** 同一来源的清稿任务单飞，避免重复请求同时写同一份版本文件。 */
  declare _cleanInFlight: Set<string>;
  constructor(host: RepolishHost, interaction: RepolishInteraction, renameWithGeneratedTitle: RepolishTitleRename) {
    this.host = host;
    this.interaction = interaction;
    this.renameWithGeneratedTitle = renameWithGeneratedTitle;
    this._repolishInFlight = null;
    this._cleanInFlight = new Set();
  }

  async repolishMarkdownFile(file: unknown, mode: string, repolishOptions: RepolishOptions = null): Promise<boolean> {
    return repolishMarkdownFileFlow(this.repolishPort(), file, mode, repolishOptions);
  }

  async reorganizeNoteInPlace(file: unknown, options: ReorganizeInPlaceOptions = {}): Promise<boolean> {
    return reorganizeNoteInPlaceFlow(this.reorganizeInPlacePort(), file, options);
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
      loadErrata: (file) => this.host.errata.loadForFile(file),
    };
  }

  private transcriptRecoveryPort(): TranscriptRecoveryPort {
    const app = this.host.app;
    return {
      getVault: () => app.vault,
      getCachedFrontmatter: (file) => app.metadataCache.getFileCache(file)?.frontmatter,
      getAudioFiles: () => app.vault.getFiles(),
      pickAudioFile: (files) => this.interaction.pickAudioFile(files),
      confirm: (title, body, ctaText) => this.interaction.confirm(title, body, ctaText),
      readAudio: async (file) => new Blob([await app.vault.readBinary(file)]),
      transcribeWhole: (blob, mime, options) => transcribeImportedAudio(this.host, blob, mime, options),
      queueRetryTask: (task) => {
        const queue = this.host.tasks.host.queue;
        if (!queue) throw new Error(t("The transcription retry queue is unavailable."));
        return queue.add(task);
      },
      refreshNoteIndex: (file, options) => this.host.noteIndex.refreshNoteIndexSafely(file, options),
      getBackupFolder: () => `${defaultFolderPaths().archiveFolder}/${t("Original transcript backups")}`,
      createBackupFile: async (path, content) => {
        const dir = path.slice(0, path.lastIndexOf("/"));
        await ensureVaultFolder(app, dir);
        return app.vault.create(findAvailableMarkdownPath(app, path), content);
      },
    };
  }

  private async recoverTranscript(file: obsidian.TFile): Promise<boolean> {
    return recoverOriginalTranscript(this.transcriptRecoveryPort(), file);
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
      recoverOriginalTranscript: (file) => this.recoverTranscript(file),
    };
  }

  private reorganizeInPlacePort(): ReorganizeInPlacePort {
    return {
      getVault: () => this.host.app.vault,
      getCachedFrontmatter: (file) => this.host.app.metadataCache.getFileCache(file)?.frontmatter,
      loadErrata: (file) => this.host.errata.loadForFile(file),
      getDefaultMode: () => getEffectivePolishMode(this.host.settings, this.host.settings.polishMode, "general"),
      getModeDisplayName: (mode) => getModeDisplayName(this.host.settings, mode),
      getInFlight: () => {
        if (!this._repolishInFlight) this._repolishInFlight = new Set();
        return this._repolishInFlight;
      },
      mergeAndPolish: (segments, mode, sessionMeta, frontmatter) => mergeAndPolish(this.host, segments, mode, sessionMeta, frontmatter, null),
      clearCommittedBriefingCheckpoint: (sessionMeta) => clearCommittedBriefingCheckpoint(this.host, sessionMeta),
      recoverOriginalTranscript: (file) => this.recoverTranscript(file),
      getModeOptions: () => getVisibleModeEntries(this.host.settings, false)
        .map(([value]) => ({ value, label: getModeDisplayName(this.host.settings, value) })),
      resolveLinkPath: (link, sourcePath) => this.host.app.metadataCache.getFirstLinkpathDest(link, sourcePath)?.path ?? null,
      getAutoRenameWithTitle: () => this.host.settings.autoRenameWithTitle,
      renameWithGeneratedTitle: (file, polished, mode) => this.renameWithGeneratedTitle(file, polished, mode),
      stripModeSuggestionBlocks,
      validateOriginalVersionForReorganization: (file) => this.host.versions.validateOriginalVersionForReorganization(file),
      replaceOriginalVersionBody: (file, payload) => this.host.versions.replaceOriginalVersionBody(file, payload),
      restoreOriginalVersionBody: (file, update) => this.host.versions.restoreOriginalVersionBody(file, update),
      switchVersion: (path, sourcePath) => this.host.versions.switchVersion(path, sourcePath),
      refreshNoteIndex: (file, options) => this.host.noteIndex.refreshNoteIndexSafely(file, options),
      tasks: {
        startTaskActivity: (input) => this.host.tasks.startTaskActivity(input),
        patchTaskActivity: (id, patch) => this.host.tasks.patchTaskActivity(id, patch),
        completeTaskActivity: (id, patch) => this.host.tasks.completeTaskActivity(id, patch),
        failTaskActivity: (id, error, patch) => this.host.tasks.failTaskActivity(id, error, patch),
      },
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
      cleanTranscript: (segments: Segment[], ceiling: number, errataPrompt?: string) => cleanTranscript(this.host, segments, ceiling, errataPrompt),
      loadErrata: (file) => this.host.errata.loadForFile(file),
    };
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
