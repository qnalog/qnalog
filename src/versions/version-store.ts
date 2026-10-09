/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：笔记版本块：清单读写、版本文件落盘、派生笔记、版本切换

import * as obsidian from "obsidian";
import type { PluginSettings, Segment } from "../shared/types";
import { VersionActivationStore } from "./version-activation-store";
import { getModeDisplayName, getModeMeta, getModePrefix, isKnownPolishMode } from "../shared/mode-meta";
import { buildEmptyLlmOutputFallback } from "../prompts/briefing-prompts";
import { getSegmentsHash } from "../notes/audio-refs";
import { buildSegmentStatusList, getSourceIdFromMarkdown, getVersionStoreFolder, normalizeVersionId, replaceActiveVersionBlock } from "../notes/note-markdown";
import { normalizeModeFromLabel } from "../shared/mode-label";
import { findAvailableMarkdownPath } from "../shared/util-vault";
import { readNamespaceFrontmatter } from "../shared/namespace";
import { VersionManifestStore } from "./version-manifest-store";
import { OriginalSnapshotStore, type OriginalSnapshot } from "./original-snapshot-store";
import { VersionSaveStore, type SavedVersion, type VersionSaveInput } from "./version-save-store";
import { DerivedNoteStore, type DerivedNoteVersion } from "./derived-note-store";

/** VersionStore 需要的最小宿主能力；由 src/main.ts 在调用时绑定动态成员。 */
export interface VersionStoreHost {
  vault: {
    adapter: {
      exists(path: string): Promise<boolean>;
      read(path: string): Promise<string>;
      write(path: string, content: string): Promise<void>;
      mkdir(path: string): Promise<void>;
    };
    getAbstractFileByPath(path: string): obsidian.TAbstractFile | null;
    getMarkdownFiles(): obsidian.TFile[];
    read(file: obsidian.TFile): Promise<string>;
    create(path: string, content: string): Promise<obsidian.TFile>;
    modify(file: obsidian.TFile, content: string): Promise<void>;
  };
  getSettings(): Pick<PluginSettings, "mdFolder" | "promptTemplates">;
  getFileFrontmatter(file: obsidian.TFile): Record<string, unknown> | null | undefined;
  refreshNoteIndexSafely(file: obsidian.TFile, options: { meetingDate?: string; reason?: string }): Promise<unknown>;
  openSourceFile(file: obsidian.TFile): Promise<void>;
}

export class VersionStore {
  declare host: VersionStoreHost;
  declare manifests: VersionManifestStore;
  declare saves: VersionSaveStore;
  declare originals: OriginalSnapshotStore;
  declare activation: VersionActivationStore;
  declare derived: DerivedNoteStore;
  constructor(host: VersionStoreHost) {
    this.host = host;
    this.derived = new DerivedNoteStore({
      getAbstractFileByPath: (path) => this.host.vault.getAbstractFileByPath(path),
      getMarkdownFiles: () => this.host.vault.getMarkdownFiles(),
      getFileFrontmatter: (file) => this.host.getFileFrontmatter(file),
      getSourceId: (content, file) => getSourceIdFromMarkdown(content, file),
      findAvailableMarkdownPath: (target) => findAvailableMarkdownPath(this.host, target),
      create: (path, content) => this.host.vault.create(path, content),
      modify: (file, content) => this.host.vault.modify(file, content),
      refreshDerivedNote: (file, fm) => this.host.refreshNoteIndexSafely(file, {
        meetingDate: readNamespaceFrontmatter(fm, "time") || fm["日期"] || fm.date || "",
        reason: "derived-note",
      } as Parameters<VersionStoreHost["refreshNoteIndexSafely"]>[1]),
      buildEmptyBody: () => buildEmptyLlmOutputFallback(),
      getCreatedAt: () => new Date().toISOString(),
    });
    this.manifests = new VersionManifestStore({
      exists: (path) => this.host.vault.adapter.exists(path),
      read: (path) => this.host.vault.adapter.read(path),
      write: (path, content) => this.host.vault.adapter.write(path, content),
      mkdir: (path) => this.host.vault.adapter.mkdir(path),
    });
    this.saves = new VersionSaveStore({
      exists: (path) => this.host.vault.adapter.exists(path),
      readCache: (path) => this.host.vault.adapter.read(path),
      createCache: (path, content) => this.host.vault.create(path, content),
      getSourceId: (content, file) => getSourceIdFromMarkdown(content, file),
      getSourceHash: (segments) => getSegmentsHash(segments),
      getFolder: (sourceId) => getVersionStoreFolder(this.host.getSettings(), sourceId),
      getCreatedAt: () => window.moment
        ? window.moment().format("YYYY-MM-DD HH:mm:ss")
        : new Date().toISOString(),
      normalizeId: (label) => normalizeVersionId(label),
      buildSegmentStatusList: (segments) => buildSegmentStatusList(segments),
      buildEmptyBody: () => buildEmptyLlmOutputFallback(),
    }, this.manifests);
    this.originals = new OriginalSnapshotStore({
      readSource: (file) => this.host.vault.read(file),
      getSourceId: (content, file) => getSourceIdFromMarkdown(content, file),
      getFolder: (sourceId) => getVersionStoreFolder(this.host.getSettings(), sourceId),
      exists: (path) => this.host.vault.adapter.exists(path),
      readCache: (path) => this.host.vault.adapter.read(path),
      readManifest: (folder, sourceId) => this.manifests.read(folder, sourceId),
      saveVersion: (file, content, input) => this.saveVersion(file, content, [], input),
      normalizeMode: (label) => normalizeModeFromLabel(this.host.getSettings(), label),
      isKnownMode: (mode) => isKnownPolishMode(this.host.getSettings(), mode),
      getModeDisplayName: (mode) => getModeDisplayName(this.host.getSettings(), mode),
    });
    this.activation = new VersionActivationStore({
      readSource: (file) => this.host.vault.read(file),
      readCache: (path) => this.host.vault.adapter.read(path),
      getAbstractFileByPath: (path) => this.host.vault.getAbstractFileByPath(path),
      getFileFrontmatter: (file) => this.host.getFileFrontmatter(file),
      getSourceId: (content, file) => getSourceIdFromMarkdown(content, file),
      getFolder: (sourceId) => getVersionStoreFolder(this.host.getSettings(), sourceId),
      ensureOriginalVersionForSource: (file) => this.ensureOriginalVersionForSource(file),
      getTitleSuffix: (modeKey, labelFallback) => {
        const settings = this.host.getSettings();
        return isKnownPolishMode(settings, modeKey)
          ? getModePrefix(getModeMeta(settings, modeKey))
          : labelFallback;
      },
      replaceActiveVersionBlock: (markdown, meta, body) =>
        replaceActiveVersionBlock(markdown, meta, body),
      modifySource: (file, content) => this.host.vault.modify(file, content),
      refreshNoteIndexSafely: (file, options) =>
        this.host.refreshNoteIndexSafely(file, options),
      getUpdatedAt: () => window.moment
        ? window.moment().format("YYYY-MM-DD HH:mm:ss")
        : new Date().toISOString(),
      openSourceFile: (file) => this.host.openSourceFile(file),
    }, this.manifests);
  }
  async findOriginalVersionForSource(sourceFile: obsidian.TFile): Promise<OriginalSnapshot | null> {
    return this.originals.findForSource(sourceFile);
  }
  async ensureOriginalVersionForSource(sourceFile: obsidian.TFile): Promise<string | null> {
    return this.originals.ensureForSource(sourceFile);
  }
  findDerivedNoteForSource(
    sourceFile: obsidian.TFile,
    sourceId: string,
    variantKind: string,
  ): obsidian.TFile | null {
    return this.derived.findDerivedNoteForSource(sourceFile, sourceId, variantKind);
  }




  async saveVersion(
    sourceFile: obsidian.TFile,
    sourceContent: string,
    segments: readonly Segment[],
    versionInput: VersionSaveInput,
  ): Promise<SavedVersion> {
    return this.saves.save(sourceFile, sourceContent, segments, versionInput);
  }

  async createDerivedNote(
    sourceFile: obsidian.TFile,
    sourceContent: string,
    version: DerivedNoteVersion | null | undefined,
    label: string,
    mode: string,
    style = "",
  ): Promise<obsidian.TFile | null> {
    return this.derived.createDerivedNote(sourceFile, sourceContent, version, label, mode, style);
  }

  async switchVersion(versionFile: obsidian.TFile | string, fallbackSourcePath?: string): Promise<void> {
    return this.activation.switchVersion(versionFile, fallbackSourcePath);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
