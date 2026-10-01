/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：笔记版本块：清单读写、版本文件落盘、派生笔记、版本切换

import * as obsidian from "obsidian";
import type { PluginSettings } from "../shared/types";
import { NoteIndexService } from "../notes/note-index-service";
import { sanitizeFilename } from "../shared/util-common";
import { extractAllRawBlocksFromText, replaceLeadingFrontmatter, splitLeadingFrontmatter } from "../notes/note-document";
import { applyVersionTitle, buildVersionPayload, foldRawTranscriptSection, normalizeTitleDatetime, splitVersionPayload, stripVersionBookkeepingFrontmatter, sanitizeActiveVersionBody } from "./version-content";
import { getModeDisplayName, getModeMeta, getModePrefix, isKnownPolishMode } from "../shared/mode-meta";
import { buildEmptyLlmOutputFallback } from "../prompts/briefing-prompts";
import { getSegmentsHash } from "../notes/audio-refs";
import { buildSegmentStatusList, getSourceIdFromMarkdown, getVersionStoreFolder, normalizeModeFromLabel, normalizeVersionId, replaceActiveVersionBlock } from "../notes/note-markdown";
import { findAvailableMarkdownPath } from "../shared/util-vault";
import { NS_ACTIVE_VERSION_BODY_RE, NS_FM, NS_TYPE_DERIVED, NS_TYPE_VERSION_CACHE, isDerivedVersionType, readNamespaceFrontmatter, setNamespaceFrontmatter } from "../shared/namespace";

import { labelPattern } from "../shared/note-labels";

import { t } from "../shared/i18n";

type OriginalSnapshot = { path: string; mode: string; label: string };

function parseFrontmatterObject(frontmatter: string): Record<string, unknown> | null {
  const yaml = String(frontmatter || "").replace(/^---\s*\n?/, "").replace(/\n?---\s*$/, "").trim();
  if (!yaml) return {};
  try {
    const parsed: unknown = obsidian.parseYaml(yaml);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

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

/** VersionStore 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface VersionStoreHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  /** 笔记索引与当日概要服务。 */
  noteIndex: NoteIndexService;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
}

export class VersionStore {
  declare host: VersionStoreHost;
  declare _originalSnapshotInFlight: Map<string, Promise<string | null>>;
  declare _manifestTails: Map<string, Promise<void>>;
  constructor(host: VersionStoreHost) {
    this.host = host;
    this._originalSnapshotInFlight = new Map();
    this._manifestTails = new Map();
  }
  private async withManifestLock<T>(sourceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this._manifestTails.get(sourceId);
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous?.then(() => current) ?? current;
    this._manifestTails.set(sourceId, tail);
    if (previous !== undefined) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this._manifestTails.get(sourceId) === tail) this._manifestTails.delete(sourceId);
    }
  }
  private async ensureVersionFolder(folder: string): Promise<void> {
    const adapter = this.host.app.vault.adapter;
    let current = "";
    for (const part of obsidian.normalizePath(folder).split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
  }
  private async readStrictVersionManifest(folder: string, sourceId: string): Promise<Record<string, unknown>> {
    const manifestPath = obsidian.normalizePath(`${folder}/manifest.json`);
    if (!(await this.host.app.vault.adapter.exists(manifestPath))) {
      return { version: 1, activeVersionId: "", versions: [], sourceId };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.host.app.vault.adapter.read(manifestPath));
    } catch {
      throw new Error(t("Could not read version metadata"));
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(t("Could not read version metadata"));
    const manifest = parsed as Record<string, unknown>;
    if ((manifest.sourceId !== undefined && manifest.sourceId !== sourceId)
      || !Array.isArray(manifest.versions)
      || manifest.versions.some((record) => !record || typeof record !== "object" || Array.isArray(record)
        || typeof record.id !== "string" || typeof record.fileName !== "string" || typeof record.kind !== "string")
      || (manifest.activeVersionId !== undefined && typeof manifest.activeVersionId !== "string")) {
      throw new Error(t("Could not read version metadata"));
    }
    return manifest;
  }
  private async resolveOriginalSnapshot(folder: string, sourceId: string, sourcePath: string, manifest: Record<string, unknown>): Promise<OriginalSnapshot | null> {
    const records = (manifest.versions as Record<string, unknown>[])
      .filter((item) => item && (item.kind === "source-original" || item.kind === "pre-clean"))
      .sort((left, right) => Number(right.kind === "source-original") - Number(left.kind === "source-original"));
    for (const record of records) {
      const fileName = typeof record.fileName === "string" ? record.fileName : "";
      if (!fileName || obsidian.normalizePath(fileName) !== fileName || fileName.includes("/") || fileName.includes("\\") || !fileName.endsWith(".md")) return null;
      const path = obsidian.normalizePath(`${folder}/${fileName}`);
      if (!(await this.host.app.vault.adapter.exists(path))) return null;
      const parts = splitLeadingFrontmatter(await this.host.app.vault.adapter.read(path));
      const fileFm = parseFrontmatterObject(parts.frontmatter);
      const versionParts = splitVersionPayload(parts.body);
      const storedSourcePath = fileFm ? readNamespaceFrontmatter(fileFm, "sourcePath") : "";
      if (!fileFm
        || fileFm.version_id !== record.id
        || fileFm.variant_kind !== record.kind
        || fileFm.source_id !== sourceId
        || typeof storedSourcePath !== "string"
        || obsidian.normalizePath(storedSourcePath) !== obsidian.normalizePath(sourcePath)
        || readNamespaceFrontmatter(fileFm, "type") !== NS_TYPE_VERSION_CACHE
        || !versionParts.body.trim()) return null;
      const mode = typeof record.mode === "string" ? record.mode : "";
      const label = mode && isKnownPolishMode(this.host.settings, mode)
        ? getModeDisplayName(this.host.settings, mode)
        : (typeof record.label === "string" && record.kind === "source-original" ? record.label : t("Original minutes"));
      return { path, mode, label };
    }
    return null;
  }
  async findOriginalVersionForSource(sourceFile: obsidian.TFile): Promise<OriginalSnapshot | null> {
    if (!(sourceFile instanceof obsidian.TFile) || sourceFile.extension !== "md") return null;
    try {
      const sourceContent = await this.host.app.vault.read(sourceFile);
      const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
      const folder = getVersionStoreFolder(this.host.settings, sourceId);
      const manifest = await this.readStrictVersionManifest(folder, sourceId);
      return await this.resolveOriginalSnapshot(folder, sourceId, sourceFile.path, manifest);
    } catch (error) {
      console.warn("[QnALog] original version lookup failed", error);
      return null;
    }
  }
  async ensureOriginalVersionForSource(sourceFile: obsidian.TFile): Promise<string | null> {
    if (!(sourceFile instanceof obsidian.TFile) || sourceFile.extension !== "md") return null;
    const sourceId = getSourceIdFromMarkdown(await this.host.app.vault.read(sourceFile), sourceFile);
    const pending = this._originalSnapshotInFlight.get(sourceId);
    if (pending !== undefined) return pending;
    const task = this.ensureOriginalVersion(sourceFile, sourceId);
    this._originalSnapshotInFlight.set(sourceId, task);
    try {
      return await task;
    } catch (error) {
      new obsidian.Notice(t("Could not save the original version; no version was switched. Check version storage. If an older version has already been overwritten, recover its original text from Obsidian file history."), 10000);
      throw error;
    } finally {
      this._originalSnapshotInFlight.delete(sourceId);
    }
  }
  private async ensureOriginalVersion(sourceFile: obsidian.TFile, sourceId: string): Promise<string | null> {
    const folder = getVersionStoreFolder(this.host.settings, sourceId);
    const manifest = await this.readStrictVersionManifest(folder, sourceId);
    const existing = await this.resolveOriginalSnapshot(folder, sourceId, sourceFile.path, manifest);
    if (existing) return existing.path;
    const records = manifest.versions as Record<string, unknown>[];
    if (records.some((item) => item && (item.kind === "source-original" || item.kind === "pre-clean"))) {
      throw new Error(t("Could not read version metadata"));
    }
    const content = await this.host.app.vault.read(sourceFile);
    if (NS_ACTIVE_VERSION_BODY_RE.test(content)) {
      throw new Error(t("Could not read version metadata"));
    }
    const parts = splitLeadingFrontmatter(content);
    const fm = parseFrontmatterObject(parts.frontmatter);
    if (parts.frontmatter && !fm) throw new Error(t("Could not read version metadata"));
    const extracted = extractAllRawBlocksFromText(content);
    const sourceParts = splitLeadingFrontmatter(extracted.withoutRaw);
    const originalBody = sourceParts.body
      .replace(/^#\s+[^\n]*(?:\n+|$)/, "")
      .replace(/^\s*---+\s*$/gm, "")
      .replace(new RegExp(`^#{1,6}\\s+.*${labelPattern("originalMaterial").source}.*$`, "gim"), "")
      .trim();
    if (!originalBody) return null;
    const rawMode = fm ? readNamespaceFrontmatter(fm, "mode") : "";
    const mode = typeof rawMode === "string" ? normalizeModeFromLabel(this.host.settings, rawMode) : "";
    const validMode = mode && mode !== "off" && isKnownPolishMode(this.host.settings, mode) ? mode : "";
    const label = validMode ? getModeDisplayName(this.host.settings, validMode) : t("Original minutes");
    const saved = await this.saveVersion(sourceFile, content, [], {
      kind: "source-original",
      label,
      mode: validMode,
      body: buildVersionPayload(sourceParts.frontmatter, sanitizeActiveVersionBody(originalBody)),
      activate: false,
    });
    const verifiedManifest = await this.readStrictVersionManifest(folder, sourceId);
    const verified = await this.resolveOriginalSnapshot(folder, sourceId, sourceFile.path, verifiedManifest);
    const savedPath = obsidian.normalizePath(`${folder}/${saved.meta.fileName}`);
    if (!verified || verified.path !== savedPath) {
      throw new Error(t("Could not verify version metadata"));
    }
    return verified.path;
  }
  findDerivedNoteForSource(
    sourceFile: obsidian.TFile,
    sourceId: string,
    variantKind: string,
  ): obsidian.TFile | null {
    const sourcePath = obsidian.normalizePath(sourceFile.path);
    const sourceDir = obsidian.normalizePath(sourceFile.parent?.path || "");
    const candidates = this.host.app.vault.getMarkdownFiles().filter((candidate) => {
      if (!(candidate instanceof obsidian.TFile) || candidate.extension !== "md" || candidate.path === sourcePath) return false;
      if (obsidian.normalizePath(candidate.parent?.path || "") !== sourceDir) return false;
      const current = this.host.app.vault.getAbstractFileByPath(candidate.path);
      if (!(current instanceof obsidian.TFile) || current.path !== candidate.path) return false;
      const frontmatter = this.host.app.metadataCache.getFileCache(current)?.frontmatter || {};
      const identityMatches = matchesDerivedNote(frontmatter, sourceId, sourcePath, variantKind);
      const canonicalCleanName = variantKind === "clean"
        && current.basename.endsWith(`】${sourceFile.basename}`)
        && isCleanDerivedNote(frontmatter, variantKind);
      return identityMatches || canonicalCleanName;
    });
    candidates.sort((left, right) => (right.stat?.mtime || 0) - (left.stat?.mtime || 0) || left.path.localeCompare(right.path));
    return candidates[0] || null;
  }



  async writeVersionManifest(folder, manifest) {
    await this.ensureVersionFolder(folder);
    const adapter = this.host.app.vault.adapter;
    const manifestPath = obsidian.normalizePath(`${folder}/manifest.json`);
    const payload = JSON.stringify(Object.assign({ version: 1 }, manifest || {}), null, 2);
    await adapter.write(manifestPath, payload);
    if (await adapter.read(manifestPath) !== payload) throw new Error(t("Could not verify version metadata"));
  }

  async writeVersionFile(folder, fileName, content) {
    await this.ensureVersionFolder(folder);
    const path = obsidian.normalizePath(`${folder}/${fileName}`);
    if (await this.host.app.vault.adapter.exists(path)) {
      throw new Error(t("Version cache file already exists"));
    }
    let file;
    try {
      file = await this.host.app.vault.create(path, content);
    } catch (error) {
      if (await this.host.app.vault.adapter.exists(path)) {
        throw new Error(t("Version cache file already exists"));
      }
      throw error;
    }
    if (await this.host.app.vault.adapter.read(path) !== content) throw new Error(t("Could not verify version metadata"));
    return file;
  }

  async saveVersion(sourceFile, sourceContent, segments, versionInput) {
    const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
    const sourceHash = getSegmentsHash(segments);
    const folder = getVersionStoreFolder(this.host.settings, sourceId);
    return this.withManifestLock(sourceId, async () => {
      const manifest = await this.readStrictVersionManifest(folder, sourceId);
      const createdAt = window.moment ? window.moment().format("YYYY-MM-DD HH:mm:ss") : new Date().toISOString();
      const baseId = normalizeVersionId(versionInput.idLabel || versionInput.label || versionInput.kind || "version");
      const versions = manifest.versions as Record<string, unknown>[];
      let id = baseId;
      let fileName = `${sanitizeFilename(id) || id}.md`;
      let suffix = 2;
      while (versions.some((record) => record && (record.id === id || record.fileName === fileName))
        || await this.host.app.vault.adapter.exists(obsidian.normalizePath(`${folder}/${fileName}`))) {
        id = `${baseId}-${suffix}`;
        fileName = `${sanitizeFilename(id) || id}.md`;
        suffix++;
      }
      const versionParts = splitVersionPayload(versionInput.body);
      const body = versionParts.body.trim() || buildEmptyLlmOutputFallback();
      const frontmatter = versionParts.frontmatter;
      const meta = {
        id,
        kind: versionInput.kind || "",
        label: versionInput.label || versionInput.kind || "版本",
        mode: versionInput.mode || "",
        style: versionInput.style || "",
        sourcePath: sourceFile.path,
        sourceId,
        sourceHash,
        fileName,
        createdAt,
        containsRaw: false,
        containsFrontmatter: Boolean(frontmatter),
      };
      const payload = buildVersionPayload(frontmatter, body);
      const versionFileBody = [
        "---",
        `${NS_FM.type}: ${NS_TYPE_VERSION_CACHE}`,
        "payload_format: 2",
        `version_id: "${id}"`,
        `variant_kind: "${meta.kind}"`,
        `variant_label: "${meta.label}"`,
        meta.mode ? `variant_mode: "${meta.mode}"` : "",
        meta.style ? `variant_style: "${meta.style}"` : "",
        `${NS_FM.sourcePath}: "${sourceFile.path}"`,
        `source_id: "${sourceId}"`,
        `source_segments_hash: "${sourceHash}"`,
        `${NS_FM.containsRaw}: false`,
        `contains_frontmatter: ${frontmatter ? "true" : "false"}`,
        `created: ${createdAt}`,
        "---",
        "",
        payload,
        "",
      ].filter(v => v !== "").join("\n");
      await this.writeVersionFile(folder, fileName, versionFileBody);
      Object.assign(manifest, {
        version: 1,
        sourcePath: sourceFile.path,
        sourceId,
        sourceHash,
        segments: buildSegmentStatusList(segments),
        // 派生文件不改变母本当前显示版本；清稿/历史版本仍可显式激活。
        activeVersionId: versionInput.activate === false ? (manifest.activeVersionId || "") : id,
        updatedAt: createdAt,
        versions: [...versions, meta],
      });
      await this.writeVersionManifest(folder, manifest);
      const savedManifest = await this.readStrictVersionManifest(folder, sourceId);
      const savedRecord = (savedManifest.versions as Record<string, unknown>[])
        .find((record) => record && record.id === id && record.fileName === fileName);
      const expectedActiveId = versionInput.activate === false ? (manifest.activeVersionId || "") : id;
      if (!savedRecord || savedManifest.activeVersionId !== expectedActiveId) {
        throw new Error(t("Could not verify version metadata"));
      }
      return { folder, manifest: savedManifest, meta, body, frontmatter };
    });
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
    const stableExisting = this.host.app.vault.getAbstractFileByPath(stableTarget);
    const stableIsOwnedClean = variantKind === "clean" && stableExisting instanceof obsidian.TFile
      && matchesDerivedNote(
        this.host.app.metadataCache.getFileCache(stableExisting)?.frontmatter || {},
        sourceId,
        sourcePath,
        variantKind,
      );
    let target = existingClean?.path
      || (stableExisting instanceof obsidian.TFile && (variantKind !== "clean" || stableIsOwnedClean)
        ? stableTarget
        : findAvailableMarkdownPath(this.host.app, stableTarget));
    if (!target) throw new Error(t("Failed to generate a path for the derived minutes file"));

    const sourceFm = ((this.host.app.metadataCache.getFileCache(sourceFile) || {}).frontmatter) || {};
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
    let existing = this.host.app.vault.getAbstractFileByPath(target);
    const existingFm = existing instanceof obsidian.TFile
      ? this.host.app.metadataCache.getFileCache(existing)?.frontmatter || {}
      : {};
    const mayReplace = existing instanceof obsidian.TFile
      && (variantKind !== "clean"
        || existingClean?.path === existing.path
        || matchesDerivedNote(existingFm, sourceId, sourcePath, variantKind));
    if (mayReplace && existing instanceof obsidian.TFile) {
      await this.host.app.vault.modify(existing, content);
    } else {
      if (existing) {
        target = findAvailableMarkdownPath(this.host.app, stableTarget);
        if (!target) throw new Error(t("Failed to generate a path for the derived minutes file"));
        existing = this.host.app.vault.getAbstractFileByPath(target);
      }
      if (!(existing instanceof obsidian.TFile)) {
        try {
          existing = await this.host.app.vault.create(target, content);
        } catch (error) {
          const raced = this.host.app.vault.getAbstractFileByPath(target);
          const racedFm = raced instanceof obsidian.TFile
            ? this.host.app.metadataCache.getFileCache(raced)?.frontmatter || {}
            : {};
          if (raced instanceof obsidian.TFile
            && (variantKind !== "clean" || matchesDerivedNote(racedFm, sourceId, sourcePath, variantKind))) {
            await this.host.app.vault.modify(raced, content);
            existing = raced;
          } else if (raced) {
            const alternate = findAvailableMarkdownPath(this.host.app, stableTarget);
            if (!alternate || alternate === target) throw error;
            target = alternate;
            existing = await this.host.app.vault.create(target, content);
          } else {
            throw error;
          }
        }
      }
    }
    if (existing instanceof obsidian.TFile) {
      await this.host.noteIndex.refreshNoteIndexSafely(existing, {
        meetingDate: readNamespaceFrontmatter(derivedFm, "time") || derivedFm["日期"] || derivedFm.date || "",
        reason: "derived-note",
      });
    }
    return existing instanceof obsidian.TFile ? existing : null;
  }

  async applyVersionToSource(sourceFile, versionMeta, body, frontmatter = "") {
    const cur = await this.host.app.vault.read(sourceFile);
    const sourceOriginal = versionMeta?.kind === "source-original" || versionMeta?.kind === "pre-clean";
    const withFrontmatter = replaceLeadingFrontmatter(cur, frontmatter, sourceOriginal);
    // 标题跟随当前显示版本；回退日期优先取本次内容的 time，再取版本创建时间。
    const fmTime = (String(frontmatter || "").match(/^time:\s*(.+)$/m) || [])[1] || "";
    const fallbackDatetime = normalizeTitleDatetime(fmTime) || normalizeTitleDatetime(String(versionMeta && versionMeta.createdAt || ""));
    // 标题模式段与改名文件名同源（getModePrefix，随界面语言）；清稿等未知模式回退到版本标签。
    const modeKey = String((versionMeta && versionMeta.mode) || "");
    const labelFallback = String((versionMeta && (versionMeta.label || versionMeta.kind)) || "当前版本").split(" · ")[0].trim() || "当前版本";
    const titleSuffix = isKnownPolishMode(this.host.settings, modeKey)
      ? getModePrefix(getModeMeta(this.host.settings, modeKey))
      : labelFallback;
    const withTitle = applyVersionTitle(withFrontmatter, titleSuffix, fallbackDatetime);
    // 原始转写区规范化：未收尾的母本首次激活时把裸露分段折叠并补「原始材料」标题。
    const next = foldRawTranscriptSection(replaceActiveVersionBlock(withTitle, versionMeta, body));
    if (next !== cur) await this.host.app.vault.modify(sourceFile, next);
    await this.host.noteIndex.refreshNoteIndexSafely(sourceFile, { reason: "version-switch" });
  }


  async switchVersion(versionFile: obsidian.TFile | string, fallbackSourcePath?: string) {
    const indexedFile = versionFile instanceof obsidian.TFile ? versionFile : null;
    const versionPath = typeof versionFile === "string" ? obsidian.normalizePath(versionFile) : versionFile.path;
    if (!versionPath) return;
    const content = indexedFile
      ? await this.host.app.vault.read(indexedFile)
      : await this.host.app.vault.adapter.read(versionPath);
    const parts = splitLeadingFrontmatter(content);
    const cachedFm = indexedFile ? this.host.app.metadataCache.getFileCache(indexedFile)?.frontmatter : null;
    const parsedFm = parseFrontmatterObject(parts.frontmatter);
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
    let sourceFile = normalizedStoredPath ? this.host.app.vault.getAbstractFileByPath(normalizedStoredPath) : null;
    if (!(sourceFile instanceof obsidian.TFile) && fallbackSourcePath) {
      const fallback = this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(fallbackSourcePath));
      if (fallback instanceof obsidian.TFile) sourceFile = fallback;
    }
    if (!(sourceFile instanceof obsidian.TFile)) {
      new obsidian.Notice(t("Master copy not found; cannot switch versions."), 6000);
      throw new Error(t("Master copy not found; cannot switch versions."));
    }
    const sourceContentForId = await this.host.app.vault.read(sourceFile);
    const sourceId = getSourceIdFromMarkdown(sourceContentForId, sourceFile);
    const folder = getVersionStoreFolder(this.host.settings, sourceId);
    if (!indexedFile) {
      const versionId = typeof fm.version_id === "string" ? fm.version_id : "";
      const kind = typeof fm.variant_kind === "string" ? fm.variant_kind : "";
      const versionName = versionPath.slice(versionPath.lastIndexOf("/") + 1);
      const manifest = await this.readStrictVersionManifest(folder, sourceId);
      const record = (manifest.versions as Record<string, unknown>[])
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
    const meta = {
      id: String(fm.version_id || versionPath.slice(versionPath.lastIndexOf("/") + 1).replace(/\.md$/i, "")),
      kind: String(fm.variant_kind || ""),
      label: String(fm.variant_label || fm.variant_kind || "版本"),
      mode: String(fm.variant_mode || ""),
      style: String(fm.variant_style || ""),
      sourceHash: String(fm.source_segments_hash || ""),
      createdAt: String(fm.created || ""),
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
      const originalYaml = parseFrontmatterObject(contentFrontmatter);
      if (contentFrontmatter && !originalYaml) {
        new obsidian.Notice(t("Could not read version metadata"), 6000);
        throw new Error(t("Could not read version metadata"));
      }
    }
    if (meta.kind === "clean") {
      const currentSource = await this.host.app.vault.read(sourceFile);
      const currentParts = splitLeadingFrontmatter(currentSource);
      const currentYaml = parseFrontmatterObject(currentParts.frontmatter);
      const versionYaml = parseFrontmatterObject(contentFrontmatter);
      if (contentFrontmatter && !versionYaml) {
        new obsidian.Notice(t("Could not read version metadata"), 6000);
        throw new Error(t("Could not read version metadata"));
      }
      const cleanFm = versionYaml || currentYaml || {};
      setNamespaceFrontmatter(cleanFm, "mode", "cleanscript");
      contentFrontmatter = `---\n${obsidian.stringifyYaml(cleanFm).trimEnd()}\n---\n`;
    }
    await this.ensureOriginalVersionForSource(sourceFile);
    await this.withManifestLock(sourceId, async () => {
      const manifest = await this.readStrictVersionManifest(folder, sourceId);
      await this.applyVersionToSource(sourceFile, meta, body, contentFrontmatter);
      manifest.activeVersionId = meta.id;
      manifest.updatedAt = window.moment ? window.moment().format("YYYY-MM-DD HH:mm:ss") : new Date().toISOString();
      await this.writeVersionManifest(folder, manifest);
      const verifiedManifest = await this.readStrictVersionManifest(folder, sourceId);
      if (verifiedManifest.activeVersionId !== meta.id) {
        throw new Error(t("Could not verify version metadata"));
      }
    });
    await this.host.app.workspace.getLeaf(false).openFile(sourceFile);
    new obsidian.Notice(`${t("Switched to version: ")}${meta.label}`, 3000);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
