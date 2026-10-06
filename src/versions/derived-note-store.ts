import * as obsidian from "obsidian";
import { splitLeadingFrontmatter } from "../notes/note-document";
import { NS_FM, NS_TYPE_DERIVED, isDerivedVersionType, readNamespaceFrontmatter, setNamespaceFrontmatter } from "../shared/namespace";
import { t } from "../shared/i18n";

export interface DerivedNoteVersion {
  meta?: { sourceId?: string; kind?: string; createdAt?: string } | null;
  frontmatter?: string;
  body?: string;
}

export interface DerivedNoteHost {
  getAbstractFileByPath(path: string): obsidian.TAbstractFile | null;
  getMarkdownFiles(): obsidian.TFile[];
  getFileFrontmatter(file: obsidian.TFile): Record<string, unknown> | null | undefined;
  getSourceId(content: string, file: obsidian.TFile): string;
  findAvailableMarkdownPath(target: string): string;
  create(path: string, content: string): Promise<obsidian.TFile>;
  modify(file: obsidian.TFile, content: string): Promise<void>;
  refreshDerivedNote(file: obsidian.TFile, frontmatter: Record<string, unknown>): Promise<unknown>;
  buildEmptyBody(): string;
  getCreatedAt(): string;
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

export class DerivedNoteStore {
  constructor(private readonly io: DerivedNoteHost) {}

  findDerivedNoteForSource(
    sourceFile: obsidian.TFile,
    sourceId: string,
    variantKind: string,
  ): obsidian.TFile | null {
    const sourcePath = obsidian.normalizePath(sourceFile.path);
    const sourceDir = obsidian.normalizePath(sourceFile.parent?.path || "");
    const candidates = this.io.getMarkdownFiles().filter((candidate) => {
      if (!(candidate instanceof obsidian.TFile) || candidate.extension !== "md" || candidate.path === sourcePath) return false;
      if (obsidian.normalizePath(candidate.parent?.path || "") !== sourceDir) return false;
      const current = this.io.getAbstractFileByPath(candidate.path);
      if (!(current instanceof obsidian.TFile) || current.path !== candidate.path) return false;
      const frontmatter = this.io.getFileFrontmatter(current) || {};
      const identityMatches = matchesDerivedNote(frontmatter, sourceId, sourcePath, variantKind);
      const canonicalCleanName = variantKind === "clean"
        && current.basename.endsWith(`】${sourceFile.basename}`)
        && isCleanDerivedNote(frontmatter, variantKind);
      return identityMatches || canonicalCleanName;
    });
    candidates.sort((left, right) => (right.stat?.mtime || 0) - (left.stat?.mtime || 0) || left.path.localeCompare(right.path));
    return candidates[0] || null;
  }

  async createDerivedNote(
    sourceFile: obsidian.TFile,
    sourceContent: string,
    version: DerivedNoteVersion | null | undefined,
    label: string,
    mode: string,
    style = "",
  ): Promise<obsidian.TFile | null> {
    if (!(sourceFile instanceof obsidian.TFile)) throw new Error(t("Original minutes note not found"));
    const sourceDir = sourceFile.parent && sourceFile.parent.path ? sourceFile.parent.path : "";
    const sourcePath = obsidian.normalizePath(sourceFile.path);
    const sourceId = String(version && version.meta && version.meta.sourceId || this.io.getSourceId(sourceContent, sourceFile));
    const prefix = String(label || "综合纪要").trim() || "综合纪要";
    const variantKind = String(version && version.meta && version.meta.kind || "minutes");
    const stem = `【${prefix}】${sourceFile.basename}`;
    const stableTarget = obsidian.normalizePath(sourceDir ? `${sourceDir}/${stem}.md` : `${stem}.md`);
    const existingClean = variantKind === "clean"
      ? this.findDerivedNoteForSource(sourceFile, sourceId, variantKind)
      : null;
    const stableExisting = this.io.getAbstractFileByPath(stableTarget);
    const stableIsOwnedClean = variantKind === "clean" && stableExisting instanceof obsidian.TFile
      && matchesDerivedNote(
        this.io.getFileFrontmatter(stableExisting) || {},
        sourceId,
        sourcePath,
        variantKind,
      );
    let target = existingClean?.path
      || (stableExisting instanceof obsidian.TFile && (variantKind !== "clean" || stableIsOwnedClean)
        ? stableTarget
        : this.io.findAvailableMarkdownPath(stableTarget));
    if (!target) throw new Error(t("Failed to generate a path for the derived minutes file"));

    const sourceFm = this.io.getFileFrontmatter(sourceFile) || {};
    let versionFm: unknown = {};
    if (version && version.frontmatter) {
      try {
        const parsed: unknown = obsidian.parseYaml(splitLeadingFrontmatter(version.frontmatter).frontmatter.replace(/^---\n|\n---\n?$/g, ""));
        versionFm = parsed || {};
      } catch {
        versionFm = {};
      }
    }
    const derivedFm = Object.assign({}, sourceFm, versionFm, {
      [NS_FM.type]: NS_TYPE_DERIVED,
      variant_kind: variantKind,
      variant_label: prefix,
      variant_mode: mode || "",
      variant_style: style || "",
      [NS_FM.sourcePath]: sourceFile.path,
      source_id: sourceId,
      [NS_FM.containsRaw]: false,
      created: version && version.meta ? version.meta.createdAt : this.io.getCreatedAt(),
    });
    setNamespaceFrontmatter(derivedFm, "type", NS_TYPE_DERIVED);
    setNamespaceFrontmatter(derivedFm, "sourcePath", sourceFile.path);
    setNamespaceFrontmatter(derivedFm, "containsRaw", false);
    if (variantKind === "clean") setNamespaceFrontmatter(derivedFm, "mode", "cleanscript");
    const yaml = obsidian.stringifyYaml(derivedFm);
    const body = String(version && version.body || this.io.buildEmptyBody()).trim() || this.io.buildEmptyBody();
    const heading = /^#\s/m.test(body) ? "" : `# ${prefix} · ${sourceFile.basename}\n\n`;
    const backlink = variantKind === "clean"
      ? `> [!note] 从母本逐字稿忠实清理 · 母本：[[${sourceFile.basename}]]`
      : `> [!info] 基于原始转写重新生成 · 原始纪要：[[${sourceFile.basename}]]`;
    const content = `---\n${yaml.trimEnd()}\n---\n\n${heading}${backlink}\n\n${body}\n`;
    let existing = this.io.getAbstractFileByPath(target);
    const existingFm = existing instanceof obsidian.TFile
      ? this.io.getFileFrontmatter(existing) || {}
      : {};
    const mayReplace = existing instanceof obsidian.TFile
      && (variantKind !== "clean"
        || existingClean?.path === existing.path
        || matchesDerivedNote(existingFm, sourceId, sourcePath, variantKind));
    if (mayReplace && existing instanceof obsidian.TFile) {
      await this.io.modify(existing, content);
    } else {
      if (existing) {
        target = this.io.findAvailableMarkdownPath(stableTarget);
        if (!target) throw new Error(t("Failed to generate a path for the derived minutes file"));
        existing = this.io.getAbstractFileByPath(target);
      }
      if (!(existing instanceof obsidian.TFile)) {
        try {
          existing = await this.io.create(target, content);
        } catch (error) {
          const raced = this.io.getAbstractFileByPath(target);
          const racedFm = raced instanceof obsidian.TFile
            ? this.io.getFileFrontmatter(raced) || {}
            : {};
          if (raced instanceof obsidian.TFile
            && (variantKind !== "clean" || matchesDerivedNote(racedFm, sourceId, sourcePath, variantKind))) {
            await this.io.modify(raced, content);
            existing = raced;
          } else if (raced) {
            const alternate = this.io.findAvailableMarkdownPath(stableTarget);
            if (!alternate || alternate === target) throw error;
            target = alternate;
            existing = await this.io.create(target, content);
          } else {
            throw error;
          }
        }
      }
    }
    if (existing instanceof obsidian.TFile) {
      await this.io.refreshDerivedNote(existing, derivedFm);
    }
    return existing instanceof obsidian.TFile ? existing : null;
  }
}
