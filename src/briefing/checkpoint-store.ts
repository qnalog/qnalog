import type { DataAdapter } from "obsidian";
import type { BriefingCheckpoint } from "./pipeline";

function normalizeAdapterPath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
}

function safeFileStem(value: string): string {
  return String(value || "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "briefing";
}

export class BriefingCheckpointStore {
  private readonly adapter: DataAdapter;
  private readonly folder: string;

  constructor(adapter: DataAdapter, configDir: string, pluginId: string) {
    this.adapter = adapter;
    this.folder = normalizeAdapterPath(`${configDir}/plugins/${safeFileStem(pluginId)}/briefing-checkpoints`);
  }

  private pathFor(id: string): string {
    return normalizeAdapterPath(`${this.folder}/${safeFileStem(id)}.json`);
  }

  private async ensureFolder(): Promise<void> {
    if (!(await this.adapter.exists(this.folder))) await this.adapter.mkdir(this.folder);
  }

  async load(id: string): Promise<BriefingCheckpoint | null> {
    const path = this.pathFor(id);
    for (const candidate of [path, `${path}.tmp`]) {
      if (!(await this.adapter.exists(candidate))) continue;
      try {
        const parsed: unknown = JSON.parse(await this.adapter.read(candidate));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const checkpoint = parsed as Partial<BriefingCheckpoint>;
        if (checkpoint.id !== id || !Array.isArray(checkpoint.parts)) continue;
        return checkpoint as BriefingCheckpoint;
      } catch {
        continue;
      }
    }
    return null;
  }

  async save(checkpoint: BriefingCheckpoint): Promise<void> {
    await this.ensureFolder();
    checkpoint.updatedAt = new Date().toISOString();
    const path = this.pathFor(checkpoint.id);
    const temporary = `${path}.tmp`;
    await this.adapter.write(temporary, JSON.stringify(checkpoint));
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
    await this.adapter.rename(temporary, path);
  }

  async remove(id: string): Promise<void> {
    const path = this.pathFor(id);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
    if (await this.adapter.exists(`${path}.tmp`)) await this.adapter.remove(`${path}.tmp`);
  }
}
