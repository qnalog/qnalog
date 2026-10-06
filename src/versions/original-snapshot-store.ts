import * as obsidian from "obsidian";
import { extractAllRawBlocksFromText, findActiveVersionBlock, splitLeadingFrontmatter } from "../notes/note-document";
import { NS_TYPE_VERSION_CACHE, readNamespaceFrontmatter } from "../shared/namespace";
import { labelPattern } from "../shared/note-labels";
import { t } from "../shared/i18n";
import { buildVersionPayload, parseVersionFrontmatter, sanitizeActiveVersionBody, splitVersionPayload } from "./version-content";
import type { VersionManifest } from "./version-manifest-store";

export interface OriginalSnapshot {
  path: string;
  mode: string;
  label: string;
}

export interface OriginalVersionInput {
  kind: "source-original";
  label: string;
  mode: string;
  body: string;
  activate: false;
}

export interface OriginalSnapshotHost {
  readSource(file: obsidian.TFile): Promise<string>;
  getSourceId(content: string, file: obsidian.TFile): string;
  getFolder(sourceId: string): string;
  exists(path: string): Promise<boolean>;
  readCache(path: string): Promise<string>;
  readManifest(folder: string, sourceId: string): Promise<VersionManifest>;
  saveVersion(file: obsidian.TFile, content: string, input: OriginalVersionInput): Promise<{ meta: { fileName: string } }>;
  normalizeMode(label: string): string;
  isKnownMode(mode: string): boolean;
  getModeDisplayName(mode: string): string;
}

export class OriginalSnapshotStore {
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(private readonly io: OriginalSnapshotHost) {}

  private async resolveOriginalSnapshot(
    folder: string,
    sourceId: string,
    sourcePath: string,
    manifest: VersionManifest,
  ): Promise<OriginalSnapshot | null> {
    const records = manifest.versions
      .filter((item) => item && (item.kind === "source-original" || item.kind === "pre-clean"))
      .sort((left, right) => Number(right.kind === "source-original") - Number(left.kind === "source-original"));
    for (const record of records) {
      const fileName = typeof record.fileName === "string" ? record.fileName : "";
      if (!fileName || obsidian.normalizePath(fileName) !== fileName || fileName.includes("/") || fileName.includes("\\") || !fileName.endsWith(".md")) return null;
      const path = obsidian.normalizePath(`${folder}/${fileName}`);
      if (!(await this.io.exists(path))) return null;
      const parts = splitLeadingFrontmatter(await this.io.readCache(path));
      const fileFm = parseVersionFrontmatter(parts.frontmatter, obsidian.parseYaml);
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
      const label = mode && this.io.isKnownMode(mode)
        ? this.io.getModeDisplayName(mode)
        : (typeof record.label === "string" && record.kind === "source-original" ? record.label : t("Original minutes"));
      return { path, mode, label };
    }
    return null;
  }

  async findForSource(sourceFile: obsidian.TFile): Promise<OriginalSnapshot | null> {
    if (!(sourceFile instanceof obsidian.TFile) || sourceFile.extension !== "md") return null;
    try {
      const sourceContent = await this.io.readSource(sourceFile);
      const sourceId = this.io.getSourceId(sourceContent, sourceFile);
      const folder = this.io.getFolder(sourceId);
      const manifest = await this.io.readManifest(folder, sourceId);
      return await this.resolveOriginalSnapshot(folder, sourceId, sourceFile.path, manifest);
    } catch (error) {
      console.warn("[QnALog] original version lookup failed", error);
      return null;
    }
  }

  async ensureForSource(sourceFile: obsidian.TFile): Promise<string | null> {
    if (!(sourceFile instanceof obsidian.TFile) || sourceFile.extension !== "md") return null;
    const sourceId = this.io.getSourceId(await this.io.readSource(sourceFile), sourceFile);
    const pending = this.inFlight.get(sourceId);
    if (pending !== undefined) return pending;
    const task = this.ensureOriginalVersion(sourceFile, sourceId);
    this.inFlight.set(sourceId, task);
    try {
      return await task;
    } catch (error) {
      new obsidian.Notice(t("Could not save the original version; no version was switched. Check version storage. If an older version has already been overwritten, recover its original text from Obsidian file history."), 10000);
      throw error;
    } finally {
      this.inFlight.delete(sourceId);
    }
  }

  private async ensureOriginalVersion(sourceFile: obsidian.TFile, sourceId: string): Promise<string | null> {
    const folder = this.io.getFolder(sourceId);
    const manifest = await this.io.readManifest(folder, sourceId);
    const existing = await this.resolveOriginalSnapshot(folder, sourceId, sourceFile.path, manifest);
    if (existing) return existing.path;
    const records = manifest.versions;
    if (records.some((item) => item && (item.kind === "source-original" || item.kind === "pre-clean"))) {
      throw new Error(t("Could not read version metadata"));
    }
    const content = await this.io.readSource(sourceFile);
    if (findActiveVersionBlock(content)) throw new Error(t("Could not read version metadata"));
    const parts = splitLeadingFrontmatter(content);
    const fm = parseVersionFrontmatter(parts.frontmatter, obsidian.parseYaml);
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
    const mode = typeof rawMode === "string" ? this.io.normalizeMode(rawMode) : "";
    const validMode = mode && mode !== "off" && this.io.isKnownMode(mode) ? mode : "";
    const label = validMode ? this.io.getModeDisplayName(validMode) : t("Original minutes");
    const saved = await this.io.saveVersion(sourceFile, content, {
      kind: "source-original",
      label,
      mode: validMode,
      body: buildVersionPayload(sourceParts.frontmatter, sanitizeActiveVersionBody(originalBody)),
      activate: false,
    });
    const verifiedManifest = await this.io.readManifest(folder, sourceId);
    const verified = await this.resolveOriginalSnapshot(folder, sourceId, sourceFile.path, verifiedManifest);
    const savedPath = obsidian.normalizePath(`${folder}/${saved.meta.fileName}`);
    if (!verified || verified.path !== savedPath) throw new Error(t("Could not verify version metadata"));
    return verified.path;
  }
}
