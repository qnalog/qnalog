import * as obsidian from "obsidian";
import { splitLeadingFrontmatter, replaceLeadingFrontmatter } from "../notes/note-document";
import {
  applyVersionTitle,
  foldRawTranscriptSection,
  normalizeTitleDatetime,
  parseVersionFrontmatter,
  sanitizeActiveVersionBody,
  splitVersionPayload,
  stripVersionBookkeepingFrontmatter,
} from "./version-content";
import {
  NS_TYPE_VERSION_CACHE,
  readNamespaceFrontmatter,
  setNamespaceFrontmatter,
} from "../shared/namespace";
import { t } from "../shared/i18n";
import type { VersionManifestStore } from "./version-manifest-store";

export interface VersionActivationMeta {
  id: string;
  kind: string;
  label: string;
  mode: string;
  style: string;
  sourceHash: string;
  createdAt: string;
}

export interface VersionActivationHost {
  readSource(file: obsidian.TFile): Promise<string>;
  readCache(path: string): Promise<string>;
  getAbstractFileByPath(path: string): obsidian.TAbstractFile | null;
  getFileFrontmatter(file: obsidian.TFile): Record<string, unknown> | null | undefined;
  getSourceId(content: string, file: obsidian.TFile): string;
  getFolder(sourceId: string): string;
  ensureOriginalVersionForSource(file: obsidian.TFile): Promise<string | null>;
  getTitleSuffix(modeKey: string, labelFallback: string): string;
  replaceActiveVersionBlock(markdown: string, meta: VersionActivationMeta, body: string): string;
  modifySource(file: obsidian.TFile, content: string): Promise<void>;
  refreshNoteIndexSafely(file: obsidian.TFile, options: { reason: "version-switch" }): Promise<unknown>;
  getUpdatedAt(): string;
  openSourceFile(file: obsidian.TFile): Promise<void>;
}

export class VersionActivationStore {
  constructor(
    private readonly io: VersionActivationHost,
    private readonly manifests: VersionManifestStore,
  ) {}

  private async applyToSource(
    sourceFile: obsidian.TFile,
    versionMeta: VersionActivationMeta,
    body: string,
    frontmatter = "",
  ): Promise<void> {
    const cur = await this.io.readSource(sourceFile);
    const sourceOriginal = versionMeta.kind === "source-original" || versionMeta.kind === "pre-clean";
    const withFrontmatter = replaceLeadingFrontmatter(cur, frontmatter, sourceOriginal);
    const fmTime = (String(frontmatter || "").match(/^time:\s*(.+)$/m) || [])[1] || "";
    const fallbackDatetime = normalizeTitleDatetime(fmTime) || normalizeTitleDatetime(versionMeta.createdAt);
    const modeKey = String(versionMeta.mode || "");
    const labelFallback = String((versionMeta.label || versionMeta.kind) || "当前版本")
      .split(" · ")[0].trim() || "当前版本";
    const titleSuffix = this.io.getTitleSuffix(modeKey, labelFallback);
    const withTitle = applyVersionTitle(withFrontmatter, titleSuffix, fallbackDatetime);
    const next = foldRawTranscriptSection(this.io.replaceActiveVersionBlock(withTitle, versionMeta, body));
    if (next !== cur) await this.io.modifySource(sourceFile, next);
    await this.io.refreshNoteIndexSafely(sourceFile, { reason: "version-switch" });
  }

  async switchVersion(versionFile: obsidian.TFile | string, fallbackSourcePath?: string): Promise<void> {
    const indexedFile = versionFile instanceof obsidian.TFile ? versionFile : null;
    const versionPath = typeof versionFile === "string" ? obsidian.normalizePath(versionFile) : versionFile.path;
    if (!versionPath) return;
    const content = indexedFile
      ? await this.io.readSource(indexedFile)
      : await this.io.readCache(versionPath);
    const parts = splitLeadingFrontmatter(content);
    const cachedFm = indexedFile ? this.io.getFileFrontmatter(indexedFile) : null;
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
    let sourceFile = normalizedStoredPath ? this.io.getAbstractFileByPath(normalizedStoredPath) : null;
    if (!(sourceFile instanceof obsidian.TFile) && fallbackSourcePath) {
      const fallback = this.io.getAbstractFileByPath(obsidian.normalizePath(fallbackSourcePath));
      if (fallback instanceof obsidian.TFile) sourceFile = fallback;
    }
    if (!(sourceFile instanceof obsidian.TFile)) {
      new obsidian.Notice(t("Master copy not found; cannot switch versions."), 6000);
      throw new Error(t("Master copy not found; cannot switch versions."));
    }
    const sourceContentForId = await this.io.readSource(sourceFile);
    const sourceId = this.io.getSourceId(sourceContentForId, sourceFile);
    const folder = this.io.getFolder(sourceId);
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
    const meta: VersionActivationMeta = {
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
        : Object.prototype.toString.call(fm.created) === "[object Date]" ? String(Date.prototype.toString.call(fm.created)) : "",
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
      const currentSource = await this.io.readSource(sourceFile);
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
    await this.io.ensureOriginalVersionForSource(sourceFile);
    await this.manifests.withLock(sourceId, async () => {
      const manifest = await this.manifests.read(folder, sourceId);
      await this.applyToSource(sourceFile, meta, body, contentFrontmatter);
      manifest.activeVersionId = meta.id;
      manifest.updatedAt = this.io.getUpdatedAt();
      await this.manifests.write(folder, manifest);
      const verifiedManifest = await this.manifests.read(folder, sourceId);
      if (verifiedManifest.activeVersionId !== meta.id) {
        throw new Error(t("Could not verify version metadata"));
      }
    });
    await this.io.openSourceFile(sourceFile);
    new obsidian.Notice(`${t("Switched to version: ")}${meta.label}`, 3000);
  }
}
