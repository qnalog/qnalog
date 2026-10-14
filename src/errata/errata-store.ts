import * as obsidian from "obsidian";
import { NS_ERRATA_FOLDER } from "../shared/namespace";
import { parseErrata } from "./errata-parser";
import { isErrataPath } from "./errata-path";

export { isErrataPath } from "./errata-path";

export interface ErrataLink { link: string }

export interface ErrataStorePort {
  read(file: obsidian.TFile): Promise<string>;
  listErrataFiles(): obsidian.TFile[];
  getByPath(path: string): obsidian.TAbstractFile | null;
  getLinks(file: obsidian.TFile): readonly ErrataLink[];
  resolveLink(link: string, sourcePath: string): obsidian.TAbstractFile | null;
  ensureFolder(path: string): Promise<void>;
  create(path: string, content: string): Promise<obsidian.TFile>;
  process(file: obsidian.TFile, transform: (current: string) => string): Promise<void>;
}

export interface ErrataDocument {
  file: obsidian.TFile;
  markdown: string;
  parsed: ReturnType<typeof parseErrata>;
}

function normalizePath(path: string): string {
  return obsidian.normalizePath(String(path || "")).replace(/^\/+|\/+$/g, "");
}

function linkToPath(link: string): string { return link.split("#")[0].split("|")[0].trim(); }

export class ErrataStore {
  private readonly port: ErrataStorePort;
  private readonly noteToErrata = new Map<string, string>();
  private readonly errataToNote = new Map<string, string>();

  constructor(port: ErrataStorePort) { this.port = port; }

  rebuildIndex(): void {
    this.noteToErrata.clear();
    this.errataToNote.clear();
    for (const file of this.port.listErrataFiles()) {
      if (!isErrataPath(file.path)) continue;
      const first = this.port.getLinks(file)[0];
      if (!first) continue;
      const target = this.port.resolveLink(linkToPath(first.link), file.path);
      if (!(target instanceof obsidian.TFile) || isErrataPath(target.path)) continue;
      const notePath = normalizePath(target.path);
      const errataPath = normalizePath(file.path);
      this.noteToErrata.set(notePath, errataPath);
      this.errataToNote.set(errataPath, notePath);
    }
  }

  refreshForVaultEvent(path: string, oldPath = ""): void {
    if (isErrataPath(path) || (oldPath && isErrataPath(oldPath))) this.rebuildIndex();
  }

  async find(notePath: string): Promise<obsidian.TFile | null> {
    const key = normalizePath(notePath);
    const indexed = this.noteToErrata.get(key);
    if (indexed) {
      const file = this.port.getByPath(indexed);
      if (file instanceof obsidian.TFile) return file;
    }
    this.rebuildIndex();
    const path = this.noteToErrata.get(key);
    const file = path ? this.port.getByPath(path) : null;
    return file instanceof obsidian.TFile ? file : null;
  }

  async load(notePath: string): Promise<ErrataDocument | null> {
    const file = await this.find(notePath);
    if (!file) return null;
    const markdown = await this.port.read(file);
    return { file, markdown, parsed: parseErrata(markdown) };
  }

  async create(notePath: string): Promise<obsidian.TFile> {
    const source = this.port.getByPath(normalizePath(notePath));
    if (!(source instanceof obsidian.TFile)) throw new Error("The source note could not be found.");
    const current = await this.find(source.path);
    if (current) return current;
    await this.port.ensureFolder(NS_ERRATA_FOLDER);
    const targetPath = normalizePath(`${NS_ERRATA_FOLDER}/${source.basename} · 勘误.md`);
    const existing = this.port.getByPath(targetPath);
    if (existing instanceof obsidian.TFile) {
      const first = this.port.getLinks(existing)[0];
      const linked = first && this.port.resolveLink(linkToPath(first.link), existing.path);
      if (linked instanceof obsidian.TFile && normalizePath(linked.path) === normalizePath(source.path)) return existing;
      throw new Error("A different errata note already uses this file name.");
    }
    const sourceLink = normalizePath(source.path).replace(/\.md$/i, "");
    const content = `笔记：[[${sourceLink}]]\n\n## 替换\n\n## 噪音\n\n## 说明\n`;
    try {
      const created = await this.port.create(targetPath, content);
      this.rebuildIndex();
      return created;
    } catch (error) {
      const raced = this.port.getByPath(targetPath);
      if (raced instanceof obsidian.TFile) {
        const first = this.port.getLinks(raced)[0];
        const linked = first && this.port.resolveLink(linkToPath(first.link), raced.path);
        if (linked instanceof obsidian.TFile && normalizePath(linked.path) === normalizePath(source.path)) return raced;
      }
      throw error;
    }
  }

  appendReplacement(notePath: string, from: string, to: string): Promise<obsidian.TFile> {
    return this.append(notePath, "替换", `${from} => ${to}`);
  }

  appendNoise(notePath: string, text: string): Promise<obsidian.TFile> {
    const quoted = String(text || "").trim().split(/\r?\n/).map((line) => `> ${line}`).join("\n");
    return this.append(notePath, "噪音", quoted);
  }

  private async append(notePath: string, heading: "替换" | "噪音", entry: string): Promise<obsidian.TFile> {
    const file = await this.find(notePath) || await this.create(notePath);
    await this.port.process(file, (current) => {
      const parsed = parseErrata(current);
      if (heading === "替换") {
        const [from, to] = entry.split(/\s*=>\s*/);
        if (parsed.replacements.some((rule) => rule.from === from && rule.to === to)) return current;
      } else if (parsed.noise.some((noise) => noise.replace(/\s+/g, " ").trim() === entry.replace(/^> /gm, "").replace(/\s+/g, " ").trim())) {
        return current;
      }
      const headingPattern = new RegExp(`(^|\\n)## ${heading}\\s*(?:\\n|$)`);
      const match = headingPattern.exec(current);
      if (!match) return `${current.trimEnd()}\n\n## ${heading}\n${entry}\n`;
      const insertAt = (match.index || 0) + match[0].length;
      return `${current.slice(0, insertAt)}${entry}\n${current.slice(insertAt)}`;
    });
    this.rebuildIndex();
    return file;
  }
}
