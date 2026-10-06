/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：笔记版本块：清单读写、版本文件落盘、派生笔记、版本切换

import * as obsidian from "obsidian";
import type { PluginSettings, Segment } from "../shared/types";
import { replaceLeadingFrontmatter, splitLeadingFrontmatter } from "../notes/note-document";
import { applyVersionTitle, foldRawTranscriptSection, normalizeTitleDatetime, splitVersionPayload, stripVersionBookkeepingFrontmatter, sanitizeActiveVersionBody, parseVersionFrontmatter } from "./version-content";
import { getModeDisplayName, getModeMeta, getModePrefix, isKnownPolishMode } from "../shared/mode-meta";
import { buildEmptyLlmOutputFallback } from "../prompts/briefing-prompts";
import { getSegmentsHash } from "../notes/audio-refs";
import { buildSegmentStatusList, getSourceIdFromMarkdown, getVersionStoreFolder, normalizeModeFromLabel, normalizeVersionId, replaceActiveVersionBlock } from "../notes/note-markdown";
import { findAvailableMarkdownPath } from "../shared/util-vault";
import { NS_FM, NS_TYPE_DERIVED, NS_TYPE_VERSION_CACHE, isDerivedVersionType, readNamespaceFrontmatter, setNamespaceFrontmatter } from "../shared/namespace";


import { t } from "../shared/i18n";
import { VersionManifestStore } from "./version-manifest-store";
import { OriginalSnapshotStore, type OriginalSnapshot } from "./original-snapshot-store";
import { VersionSaveStore, type SavedVersion, type VersionSaveInput } from "./version-save-store";


function isCleanDerivedNote(frontmatter: Record<string, unknown>, variantKind: string): boolean {
  if (typeof frontmatter.variant_kind !== "string" || frontmatter.variant_kind !== variantKind) return false;
  const type = readNamespaceFrontmatter(frontmatter, "type");
  return isDerivedVersionType(type) || readNamespaceFrontmatter(frontmatter, "containsRaw") === false;
}

function matchesDerivedNote(
  frontmatter: Record<string, unknown>,
  sourceId: string,
  sourcePath: string,
  variantKind: string,
): boolean {
  if (!isCleanDerivedNote(frontmatter, variantKind)) return false;
  const storedId = frontmatter.source_id;
  if (typeof storedId === "string" && storedId === sourceId) return true;
  const storedPath = readNamespaceFrontmatter(frontmatter, "sourcePath");
  return typeof storedPath === "string" && obsidian.normalizePath(storedPath) === sourcePath;
}

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
  constructor(host: VersionStoreHost) {
    this.host = host;
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
    const sourcePath = obsidian.normalizePath(sourceFile.path);
    const sourceDir = obsidian.normalizePath(sourceFile.parent?.path || "");
    const candidates = this.host.vault.getMarkdownFiles().filter((candidate) => {
      if (!(candidate instanceof obsidian.TFile) || candidate.extension !== "md" || candidate.path === sourcePath) return false;
      if (obsidian.normalizePath(candidate.parent?.path || "") !== sourceDir) return false;
      const current = this.host.vault.getAbstractFileByPath(candidate.path);
      if (!(current instanceof obsidian.TFile) || current.path !== candidate.path) return false;
      const frontmatter = this.host.getFileFrontmatter(current) || {};
      const identityMatches = matchesDerivedNote(frontmatter, sourceId, sourcePath, variantKind);
      const canonicalCleanName = variantKind === "clean"
        && current.basename.endsWith(`】${sourceFile.basename}`)
        && isCleanDerivedNote(frontmatter, variantKind);
      return identityMatches || canonicalCleanName;
    });
    candidates.sort((left, right) => (right.stat?.mtime || 0) - (left.stat?.mtime || 0) || left.path.localeCompare(right.path));
    return candidates[0] || null;
  }




  async saveVersion(
    sourceFile: obsidian.TFile,
    sourceContent: string,
    segments: readonly Segment[],
    versionInput: VersionSaveInput,
  ): Promise<SavedVersion> {
    return this.saves.save(sourceFile, sourceContent, segments, versionInput);
  }

  async createDerivedNote(sourceFile, sourceContent, version, label, mode, style = "") {
    if (!(sourceFile instanceof obsidian.TFile)) throw new Error(t("Original minutes note not found"));
    const sourceDir = sourceFile.parent && sourceFile.parent.path ? sourceFile.parent.path : "";
    const sourcePath = obsidian.normalizePath(sourceFile.path);
    const sourceId = String(version && version.meta && version.meta.sourceId || getSourceIdFromMarkdown(sourceContent, sourceFile));
    const prefix = String(label || "综合纪要").trim() || "综合纪要";
    const variantKind = String(version && version.meta && version.meta.kind || "minutes");
    const stem = `【${prefix}】${sourceFile.basename}`;
    const stableTarget = obsidian.normalizePath(sourceDir ? `${sourceDir}/${stem}.md` : `${stem}.md`);
    const existingClean = variantKind === "clean"
      ? this.findDerivedNoteForSource(sourceFile, sourceId, variantKind)
      : null;
    const stableExisting = this.host.vault.getAbstractFileByPath(stableTarget);
    const stableIsOwnedClean = variantKind === "clean" && stableExisting instanceof obsidian.TFile
      && matchesDerivedNote(
        this.host.getFileFrontmatter(stableExisting) || {},
        sourceId,
        sourcePath,
        variantKind,
      );
    let target = existingClean?.path
      || (stableExisting instanceof obsidian.TFile && (variantKind !== "clean" || stableIsOwnedClean)
        ? stableTarget
        : findAvailableMarkdownPath(this.host, stableTarget));
    if (!target) throw new Error(t("Failed to generate a path for the derived minutes file"));

    const sourceFm = this.host.getFileFrontmatter(sourceFile) || {};
    const versionFm = version && version.frontmatter
      ? (() => { try { return obsidian.parseYaml(splitLeadingFrontmatter(version.frontmatter).frontmatter.replace(/^---\n|\n---\n?$/g, "")) || {}; } catch { return {}; } })()
      : {};
    const derivedFm = Object.assign({}, sourceFm, versionFm, {
      [NS_FM.type]: NS_TYPE_DERIVED,
      variant_kind: variantKind,
      variant_label: prefix,
      variant_mode: mode || "",
      variant_style: style || "",
      [NS_FM.sourcePath]: sourceFile.path,
      source_id: sourceId,
      [NS_FM.containsRaw]: false,
      created: version && version.meta ? version.meta.createdAt : new Date().toISOString(),
    });
    setNamespaceFrontmatter(derivedFm, "type", NS_TYPE_DERIVED);
    setNamespaceFrontmatter(derivedFm, "sourcePath", sourceFile.path);
    setNamespaceFrontmatter(derivedFm, "containsRaw", false);
    if (variantKind === "clean") setNamespaceFrontmatter(derivedFm, "mode", "cleanscript");
    const yaml = obsidian.stringifyYaml(derivedFm);
    const body = String(version && version.body || buildEmptyLlmOutputFallback()).trim() || buildEmptyLlmOutputFallback();
    const heading = /^#\s/m.test(body) ? "" : `# ${prefix} · ${sourceFile.basename}\n\n`;
    const backlink = variantKind === "clean"
      ? `> [!note] 从母本逐字稿忠实清理 · 母本：[[${sourceFile.basename}]]`
      : `> [!info] 基于原始转写重新生成 · 原始纪要：[[${sourceFile.basename}]]`;
    const content = `---\n${yaml.trimEnd()}\n---\n\n${heading}${backlink}\n\n${body}\n`;
    let existing = this.host.vault.getAbstractFileByPath(target);
    const existingFm = existing instanceof obsidian.TFile
      ? this.host.getFileFrontmatter(existing) || {}
      : {};
    const mayReplace = existing instanceof obsidian.TFile
      && (variantKind !== "clean"
        || existingClean?.path === existing.path
        || matchesDerivedNote(existingFm, sourceId, sourcePath, variantKind));
    if (mayReplace && existing instanceof obsidian.TFile) {
      await this.host.vault.modify(existing, content);
    } else {
      if (existing) {
        target = findAvailableMarkdownPath(this.host, stableTarget);
        if (!target) throw new Error(t("Failed to generate a path for the derived minutes file"));
        existing = this.host.vault.getAbstractFileByPath(target);
      }
      if (!(existing instanceof obsidian.TFile)) {
        try {
          existing = await this.host.vault.create(target, content);
        } catch (error) {
          const raced = this.host.vault.getAbstractFileByPath(target);
          const racedFm = raced instanceof obsidian.TFile
            ? this.host.getFileFrontmatter(raced) || {}
            : {};
          if (raced instanceof obsidian.TFile
            && (variantKind !== "clean" || matchesDerivedNote(racedFm, sourceId, sourcePath, variantKind))) {
            await this.host.vault.modify(raced, content);
            existing = raced;
          } else if (raced) {
            const alternate = findAvailableMarkdownPath(this.host, stableTarget);
            if (!alternate || alternate === target) throw error;
            target = alternate;
            existing = await this.host.vault.create(target, content);
          } else {
            throw error;
          }
        }
      }
    }
    if (existing instanceof obsidian.TFile) {
      await this.host.refreshNoteIndexSafely(existing, {
        meetingDate: readNamespaceFrontmatter(derivedFm, "time") || derivedFm["日期"] || derivedFm.date || "",
        reason: "derived-note",
      });
    }
    return existing instanceof obsidian.TFile ? existing : null;
  }

  async applyVersionToSource(sourceFile, versionMeta, body, frontmatter = "") {
    const cur = await this.host.vault.read(sourceFile);
    const sourceOriginal = versionMeta?.kind === "source-original" || versionMeta?.kind === "pre-clean";
    const withFrontmatter = replaceLeadingFrontmatter(cur, frontmatter, sourceOriginal);
    // 标题跟随当前显示版本；回退日期优先取本次内容的 time，再取版本创建时间。
    const fmTime = (String(frontmatter || "").match(/^time:\s*(.+)$/m) || [])[1] || "";
    const fallbackDatetime = normalizeTitleDatetime(fmTime) || normalizeTitleDatetime(String(versionMeta && versionMeta.createdAt || ""));
    // 标题模式段与改名文件名同源（getModePrefix，随界面语言）；清稿等未知模式回退到版本标签。
    const modeKey = String((versionMeta && versionMeta.mode) || "");
    const labelFallback = String((versionMeta && (versionMeta.label || versionMeta.kind)) || "当前版本").split(" · ")[0].trim() || "当前版本";
    const settings = this.host.getSettings();
    const titleSuffix = isKnownPolishMode(settings, modeKey)
      ? getModePrefix(getModeMeta(settings, modeKey))
      : labelFallback;
    const withTitle = applyVersionTitle(withFrontmatter, titleSuffix, fallbackDatetime);
    // 原始转写区规范化：未收尾的母本首次激活时把裸露分段折叠并补「原始材料」标题。
    const next = foldRawTranscriptSection(replaceActiveVersionBlock(withTitle, versionMeta, body));
    if (next !== cur) await this.host.vault.modify(sourceFile, next);
    await this.host.refreshNoteIndexSafely(sourceFile, { reason: "version-switch" });
  }


  async switchVersion(versionFile: obsidian.TFile | string, fallbackSourcePath?: string) {
    const indexedFile = versionFile instanceof obsidian.TFile ? versionFile : null;
    const versionPath = typeof versionFile === "string" ? obsidian.normalizePath(versionFile) : versionFile.path;
    if (!versionPath) return;
    const content = indexedFile
      ? await this.host.vault.read(indexedFile)
      : await this.host.vault.adapter.read(versionPath);
    const parts = splitLeadingFrontmatter(content);
    const cachedFm = indexedFile ? this.host.getFileFrontmatter(indexedFile) : null;
    const parsedFm = parseVersionFrontmatter(parts.frontmatter, obsidian.parseYaml);
    if (parts.frontmatter && !parsedFm) {
      new obsidian.Notice(t("Could not read version metadata"), 6000);
      throw new Error(t("Could not read version metadata"));
    }
    const fm = indexedFile && !parsedFm
      ? cachedFm
      : Object.assign({}, indexedFile ? cachedFm || {} : {}, parsedFm || {});
    if (!fm || !Object.keys(fm).length) {
      new obsidian.Notice(t("Could not read version metadata"), 6000);
      throw new Error(t("Could not read version metadata"));
    }
    const storedSourcePath = readNamespaceFrontmatter(fm, "sourcePath");
    const normalizedStoredPath = typeof storedSourcePath === "string" ? obsidian.normalizePath(storedSourcePath) : "";
    let sourceFile = normalizedStoredPath ? this.host.vault.getAbstractFileByPath(normalizedStoredPath) : null;
    if (!(sourceFile instanceof obsidian.TFile) && fallbackSourcePath) {
      const fallback = this.host.vault.getAbstractFileByPath(obsidian.normalizePath(fallbackSourcePath));
      if (fallback instanceof obsidian.TFile) sourceFile = fallback;
    }
    if (!(sourceFile instanceof obsidian.TFile)) {
      new obsidian.Notice(t("Master copy not found; cannot switch versions."), 6000);
      throw new Error(t("Master copy not found; cannot switch versions."));
    }
    const sourceContentForId = await this.host.vault.read(sourceFile);
    const sourceId = getSourceIdFromMarkdown(sourceContentForId, sourceFile);
    const folder = getVersionStoreFolder(this.host.getSettings(), sourceId);
    if (!indexedFile) {
      const versionId = typeof fm.version_id === "string" ? fm.version_id : "";
      const kind = typeof fm.variant_kind === "string" ? fm.variant_kind : "";
      const versionName = versionPath.slice(versionPath.lastIndexOf("/") + 1);
      const manifest = await this.manifests.read(folder, sourceId);
      const record = manifest.versions
        .find((item) => item.id === versionId && item.fileName === versionName && item.kind === kind);
      if (obsidian.normalizePath(versionPath) !== obsidian.normalizePath(`${folder}/${versionName}`)
        || !record
        || fm.source_id !== sourceId
        || !normalizedStoredPath
        || normalizedStoredPath !== obsidian.normalizePath(sourceFile.path)
        || readNamespaceFrontmatter(fm, "type") !== NS_TYPE_VERSION_CACHE) {
        new obsidian.Notice(t("Could not read version metadata"), 6000);
        throw new Error(t("Could not read version metadata"));
      }
    }
    const versionParts = splitVersionPayload(parts.body);
    const body = sanitizeActiveVersionBody(versionParts.body);
    const versionId = fm.version_id;
    const versionKind = fm.variant_kind;
    const meta = {
      id: typeof versionId === "string" && versionId
        ? versionId
        : versionPath.slice(versionPath.lastIndexOf("/") + 1).replace(/\.md$/i, ""),
      kind: typeof versionKind === "string" ? versionKind : "",
      label: typeof fm.variant_label === "string" && fm.variant_label
        ? fm.variant_label
        : typeof versionKind === "string" && versionKind ? versionKind : "版本",
      mode: typeof fm.variant_mode === "string" ? fm.variant_mode : "",
      style: typeof fm.variant_style === "string" ? fm.variant_style : "",
      sourceHash: typeof fm.source_segments_hash === "string" ? fm.source_segments_hash : "",
      createdAt: typeof fm.created === "string"
        ? fm.created
        : Object.prototype.toString.call(fm.created) === "[object Date]" ? Date.prototype.toString.call(fm.created) : "",
    };
    if (!meta.kind.trim()) {
      new obsidian.Notice(t("Could not read version metadata"), 6000);
      throw new Error(t("Could not read version metadata"));
    }
    let contentFrontmatter = versionParts.frontmatter
      || (meta.kind === "source-original" || meta.kind === "pre-clean"
        ? ""
        : stripVersionBookkeepingFrontmatter(parts.frontmatter));
    if (meta.kind === "source-original" || meta.kind === "pre-clean") {
      const originalYaml = parseVersionFrontmatter(contentFrontmatter, obsidian.parseYaml);
      if (contentFrontmatter && !originalYaml) {
        new obsidian.Notice(t("Could not read version metadata"), 6000);
        throw new Error(t("Could not read version metadata"));
      }
    }
    if (meta.kind === "clean") {
      const currentSource = await this.host.vault.read(sourceFile);
      const currentParts = splitLeadingFrontmatter(currentSource);
      const currentYaml = parseVersionFrontmatter(currentParts.frontmatter, obsidian.parseYaml);
      const versionYaml = parseVersionFrontmatter(contentFrontmatter, obsidian.parseYaml);
      if (contentFrontmatter && !versionYaml) {
        new obsidian.Notice(t("Could not read version metadata"), 6000);
        throw new Error(t("Could not read version metadata"));
      }
      const cleanFm = versionYaml || currentYaml || {};
      setNamespaceFrontmatter(cleanFm, "mode", "cleanscript");
      contentFrontmatter = `---\n${obsidian.stringifyYaml(cleanFm).trimEnd()}\n---\n`;
    }
    await this.ensureOriginalVersionForSource(sourceFile);
    await this.manifests.withLock(sourceId, async () => {
      const manifest = await this.manifests.read(folder, sourceId);
      await this.applyVersionToSource(sourceFile, meta, body, contentFrontmatter);
      manifest.activeVersionId = meta.id;
      manifest.updatedAt = window.moment ? window.moment().format("YYYY-MM-DD HH:mm:ss") : new Date().toISOString();
      await this.manifests.write(folder, manifest);
      const verifiedManifest = await this.manifests.read(folder, sourceId);
      if (verifiedManifest.activeVersionId !== meta.id) {
        throw new Error(t("Could not verify version metadata"));
      }
    });
    await this.host.openSourceFile(sourceFile);
    new obsidian.Notice(`${t("Switched to version: ")}${meta.label}`, 3000);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
