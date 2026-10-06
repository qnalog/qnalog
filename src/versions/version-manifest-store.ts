import { normalizePath } from "obsidian";
import { t } from "../shared/i18n";

export interface VersionManifestRecord extends Record<string, unknown> {
  id: string;
  fileName: string;
  kind: string;
}

export interface VersionManifest extends Record<string, unknown> {
  versions: VersionManifestRecord[];
  activeVersionId?: string;
  sourceId?: string;
}

export interface VersionManifestHost {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

function isVersionRecord(value: unknown): value is VersionManifestRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "id" in value && typeof value.id === "string"
    && "fileName" in value && typeof value.fileName === "string"
    && "kind" in value && typeof value.kind === "string";
}

function isVersionManifest(value: unknown, sourceId: string): value is VersionManifest {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "versions" in value && Array.isArray(value.versions)
    && value.versions.every(isVersionRecord)
    && (!("sourceId" in value) || value.sourceId === undefined || value.sourceId === sourceId)
    && (!("activeVersionId" in value) || value.activeVersionId === undefined || typeof value.activeVersionId === "string");
}


export class VersionManifestStore {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly adapter: VersionManifestHost) {}

  async withLock<T>(sourceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sourceId);
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous?.then(() => current) ?? current;
    this.tails.set(sourceId, tail);
    if (previous !== undefined) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(sourceId) === tail) this.tails.delete(sourceId);
    }
  }

  async ensureFolder(folder: string): Promise<void> {
    let current = "";
    for (const part of normalizePath(folder).split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.adapter.exists(current))) await this.adapter.mkdir(current);
    }
  }

  async read(folder: string, sourceId: string): Promise<VersionManifest> {
    const manifestPath = normalizePath(`${folder}/manifest.json`);
    if (!(await this.adapter.exists(manifestPath))) {
      return { version: 1, activeVersionId: "", versions: [], sourceId };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.adapter.read(manifestPath));
    } catch {
      throw new Error(t("Could not read version metadata"));
    }
    if (!isVersionManifest(parsed, sourceId)) throw new Error(t("Could not read version metadata"));
    return parsed;
  }

  async write(folder: string, manifest: VersionManifest): Promise<void> {
    await this.ensureFolder(folder);
    const manifestPath = normalizePath(`${folder}/manifest.json`);
    const payload = JSON.stringify(Object.assign({ version: 1 }, manifest || {}), null, 2);
    await this.adapter.write(manifestPath, payload);
    if (await this.adapter.read(manifestPath) !== payload) throw new Error(t("Could not verify version metadata"));
  }
}
