import type * as obsidian from "obsidian";
import { normalizePath } from "obsidian";
import type { Segment } from "../shared/types";
import { NS_FM, NS_TYPE_VERSION_CACHE } from "../shared/namespace";
import { sanitizeFilename } from "../shared/util-common";
import { t } from "../shared/i18n";
import { buildVersionPayload, splitVersionPayload } from "./version-content";
import type { VersionManifest, VersionManifestRecord, VersionManifestStore } from "./version-manifest-store";

export interface VersionSaveInput {
  kind?: string;
  label?: string;
  mode?: string;
  style?: string;
  idLabel?: string;
  body: string;
  activate?: boolean;
}

export interface SavedVersionMeta extends VersionManifestRecord {
  label: string;
  mode: string;
  style: string;
  sourcePath: string;
  sourceId: string;
  sourceHash: string;
  createdAt: string;
  containsRaw: false;
  containsFrontmatter: boolean;
}

export interface SavedVersion {
  folder: string;
  manifest: VersionManifest;
  meta: SavedVersionMeta;
  body: string;
  frontmatter: string;
}

export interface VersionSegmentStatus {
  id: string;
  index: number;
  startOffsetMs: number;
  endOffsetMs: number;
  status: string;
  textHash: string;
}

export interface VersionSaveHost {
  exists(path: string): Promise<boolean>;
  readCache(path: string): Promise<string>;
  createCache(path: string, content: string): Promise<obsidian.TFile>;
  getSourceId(content: string, file: obsidian.TFile): string;
  getSourceHash(segments: readonly Segment[]): string;
  getFolder(sourceId: string): string;
  getCreatedAt(): string;
  normalizeId(label: string): string;
  buildSegmentStatusList(segments: readonly Segment[]): VersionSegmentStatus[];
  buildEmptyBody(): string;
}

export class VersionSaveStore {
  constructor(
    private readonly io: VersionSaveHost,
    private readonly manifests: VersionManifestStore,
  ) {}

  private async writeVersionFile(folder: string, fileName: string, content: string): Promise<obsidian.TFile> {
    await this.manifests.ensureFolder(folder);
    const path = normalizePath(`${folder}/${fileName}`);
    if (await this.io.exists(path)) throw new Error(t("Version cache file already exists"));
    let file: obsidian.TFile;
    try {
      file = await this.io.createCache(path, content);
    } catch (error) {
      if (await this.io.exists(path)) throw new Error(t("Version cache file already exists"));
      throw error;
    }
    if (await this.io.readCache(path) !== content) throw new Error(t("Could not verify version metadata"));
    return file;
  }

  async save(
    sourceFile: obsidian.TFile,
    sourceContent: string,
    segments: readonly Segment[],
    versionInput: VersionSaveInput,
  ): Promise<SavedVersion> {
    const sourceId = this.io.getSourceId(sourceContent, sourceFile);
    const sourceHash = this.io.getSourceHash(segments);
    const folder = this.io.getFolder(sourceId);
    return this.manifests.withLock(sourceId, async () => {
      const manifest = await this.manifests.read(folder, sourceId);
      const createdAt = this.io.getCreatedAt();
      const baseId = this.io.normalizeId(versionInput.idLabel || versionInput.label || versionInput.kind || "version");
      const versions = manifest.versions;
      let id = baseId;
      let fileName = `${sanitizeFilename(id) || id}.md`;
      let suffix = 2;
      while (versions.some((record) => record && (record.id === id || record.fileName === fileName))
        || await this.io.exists(normalizePath(`${folder}/${fileName}`))) {
        id = `${baseId}-${suffix}`;
        fileName = `${sanitizeFilename(id) || id}.md`;
        suffix++;
      }
      const versionParts = splitVersionPayload(versionInput.body);
      const body = versionParts.body.trim() || this.io.buildEmptyBody();
      const frontmatter = versionParts.frontmatter;
      const meta: SavedVersionMeta = {
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
      ].filter((value) => value !== "").join("\n");
      await this.writeVersionFile(folder, fileName, versionFileBody);
      Object.assign(manifest, {
        version: 1,
        sourcePath: sourceFile.path,
        sourceId,
        sourceHash,
        segments: this.io.buildSegmentStatusList(segments),
        // 派生文件不改变母本当前显示版本；清稿/历史版本仍可显式激活。
        activeVersionId: versionInput.activate === false ? (manifest.activeVersionId || "") : id,
        updatedAt: createdAt,
        versions: [...versions, meta],
      });
      await this.manifests.write(folder, manifest);
      const savedManifest = await this.manifests.read(folder, sourceId);
      const savedRecord = savedManifest.versions.find((record) => record.id === id && record.fileName === fileName);
      const expectedActiveId = versionInput.activate === false ? (manifest.activeVersionId || "") : id;
      if (!savedRecord || savedManifest.activeVersionId !== expectedActiveId) {
        throw new Error(t("Could not verify version metadata"));
      }
      return { folder, manifest: savedManifest, meta, body, frontmatter };
    });
  }
}
