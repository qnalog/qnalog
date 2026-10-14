import * as obsidian from "obsidian";
import { isDerivedVersionType, readNamespaceFrontmatter } from "../shared/namespace";
import { t } from "../shared/i18n";
import { buildErrataPrompt } from "./errata-prompt";
import { ErrataStore } from "./errata-store";
import type { ErrataRules } from "./errata-apply";

export interface ErrataSourcePort {
  getFrontmatter(file: obsidian.TFile): Record<string, unknown> | null | undefined;
  getByPath(path: string): obsidian.TAbstractFile | null;
}

export interface ErrataServicePort extends ErrataSourcePort {
  logDiagnostic(level: "warn", code: string, message: string, data: Record<string, unknown>): Promise<unknown>;
  notify(message: string): void;
}

export interface ErrataSourceResolution {
  sourceFile: obsidian.TFile | null;
  isDerived: boolean;
}

export function resolveErrataSource(file: obsidian.TFile, port: ErrataSourcePort): ErrataSourceResolution {
  const frontmatter = port.getFrontmatter(file) || {};
  const isDerived = isDerivedVersionType(readNamespaceFrontmatter(frontmatter, "type"))
    || readNamespaceFrontmatter(frontmatter, "containsRaw") === false;
  if (!isDerived) return { sourceFile: file, isDerived: false };
  const sourcePath = readNamespaceFrontmatter(frontmatter, "sourcePath");
  const target = typeof sourcePath === "string" && sourcePath.trim()
    ? port.getByPath(obsidian.normalizePath(sourcePath))
    : null;
  return { sourceFile: target instanceof obsidian.TFile ? target : null, isDerived: true };
}

export type LoadedErrata = ErrataRules & { prompt: string; usedCount: number; truncated: boolean };

export class ErrataService {
  private readonly store: ErrataStore;
  private readonly port: ErrataServicePort;

  constructor(store: ErrataStore, port: ErrataServicePort) {
    this.store = store;
    this.port = port;
    this.store.rebuildIndex();
  }

  refreshForVaultEvent(path: string, oldPath = ""): void { this.store.refreshForVaultEvent(path, oldPath); }

  async loadForFile(file: obsidian.TFile): Promise<LoadedErrata | null> {
    const resolution = resolveErrataSource(file, this.port);
    if (!resolution.sourceFile) {
      const rawSourcePath = readNamespaceFrontmatter(this.port.getFrontmatter(file) || {}, "sourcePath");
      await this.port.logDiagnostic("warn", "errata.source_missing", t("The original note for this derived version could not be found; no errata were applied"), {
        filePath: file.path,
        sourcePath: typeof rawSourcePath === "string" ? rawSourcePath : "",
      });
      return null;
    }
    const loaded = await this.store.load(resolution.sourceFile.path);
    if (!loaded) return null;
    const prompt = buildErrataPrompt(loaded.parsed);
    if (prompt.truncated) {
      this.port.notify(t("The errata note is too long; only the first {0} entries were used.").replace("{0}", String(prompt.usedCount)));
    }
    return { prompt: prompt.text, usedCount: prompt.usedCount, truncated: prompt.truncated,
      replacements: loaded.parsed.replacements, noise: loaded.parsed.noise };
  }

  async createForFile(file: obsidian.TFile): Promise<obsidian.TFile> {
    const resolution = resolveErrataSource(file, this.port);
    if (!resolution.sourceFile) throw new Error(t("The original note for this derived version could not be found."));
    return this.store.create(resolution.sourceFile.path);
  }

  async appendReplacement(file: obsidian.TFile, from: string, to: string): Promise<obsidian.TFile> {
    const resolution = resolveErrataSource(file, this.port);
    if (!resolution.sourceFile) throw new Error(t("The original note for this derived version could not be found."));
    return this.store.appendReplacement(resolution.sourceFile.path, from, to);
  }

  async appendNoise(file: obsidian.TFile, text: string): Promise<obsidian.TFile> {
    const resolution = resolveErrataSource(file, this.port);
    if (!resolution.sourceFile) throw new Error(t("The original note for this derived version could not be found."));
    return this.store.appendNoise(resolution.sourceFile.path, text);
  }
}
