import type { AvailableUpdate, PluginSettings } from "./shared/types";
import { compareVersions } from "./shared/version";
import { resolveUpdateRawBase, resolveUpdateRawBases } from "./update-source";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_STARTUP_DELAY_MS = 4000;
export type UpdateSettings = Pick<
  PluginSettings,
  | "autoCheckUpdates"
  | "lastUpdateCheckAt"
  | "availableUpdate"
  | "lastUpdateError"
  | "installedUpdateVersion"
>;

export interface UpdateManifest {
  id: string;
  version: string;
  dir?: string;
}

// 只保留读取能力：本插件不得写入自身文件（Obsidian 开发者政策 Not allowed：
// "Install or update themselves or their dependencies"）。安装交给 Obsidian 或 BRAT。
export interface UpdateAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
}

export interface UpdateServiceHost {
  settings: UpdateSettings;
  manifest: UpdateManifest;
  configDir: string;
  adapter: UpdateAdapter;
  saveSettings(): Promise<void>;
}

export interface UpdateRequestOptions {
  url: string;
  method: "GET";
  headers: Readonly<Record<string, string>>;
}

export interface UpdateResponse {
  status: number;
  text: string;
}

export interface UpdateRuntime {
  requestUrl?(options: UpdateRequestOptions): Promise<UpdateResponse>;
  notice(message: string, duration?: number): void;
  warn(message: string, error?: unknown): void;
  now(): number;
  normalizePath(path: string): string;
  setTimeout(handler: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
  buildVersion: string;
}

export interface CheckForUpdatesOptions {
  silent?: boolean;
}

interface FetchedUpdateText {
  text: string;
  rawBaseUrl: string;
  url: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message) return message;
  }
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") return String(error);
  return "未知错误";
}

function parseRemoteManifest(text: string): { id: string; version: string } {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || !("id" in parsed) || typeof parsed.id !== "string") {
    return { id: "", version: "0.0.0" };
  }
  const version = "version" in parsed && typeof parsed.version === "string" && parsed.version
    ? parsed.version
    : "0.0.0";
  return { id: parsed.id, version };
}

function joinUpdateUrl(rawBase: string, fileName: string): string {
  return `${rawBase.replace(/\/+$/g, "")}/${fileName.replace(/^\/+/, "")}`;
}

export class UpdateService {
  private startupTimer: number | null = null;
  private disposed = false;

  constructor(
    private readonly host: UpdateServiceHost,
    private readonly runtime: UpdateRuntime,
  ) {}

  getUpdateRawBase(): string {
    return resolveUpdateRawBase(this.host.settings);
  }

  getUpdateRawBases(): string[] {
    return resolveUpdateRawBases(this.host.settings);
  }

  checkForUpdatesOnStartup(): void {
    if (this.disposed) return;
    if (!this.host.settings.autoCheckUpdates) return;
    if (!this.getUpdateRawBase()) return;
    const last = Date.parse(this.host.settings.lastUpdateCheckAt || "");
    if (last && this.runtime.now() - last < UPDATE_CHECK_INTERVAL_MS) return;
    if (this.startupTimer !== null) return;

    this.startupTimer = this.runtime.setTimeout(() => {
      this.startupTimer = null;
      void this.checkForUpdates({ silent: true })
        .catch(error => this.runtime.warn("[QnALog] update check failed", error));
    }, UPDATE_STARTUP_DELAY_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.startupTimer === null) return;
    this.runtime.clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  async checkForUpdates(options: CheckForUpdatesOptions = {}): Promise<AvailableUpdate | null> {
    const silent = !!options.silent;
    const rawBases = this.getUpdateRawBases();
    if (!rawBases.length) {
      if (!silent) this.runtime.notice("QnALog 更新源未解析成功，请确认插件文件完整。", 8000);
      return null;
    }

    try {
      const manifestFetch = await this.fetchTextFromSources(rawBases, "manifest.json");
      const remoteManifest = parseRemoteManifest(manifestFetch.text);
      if (remoteManifest.id !== this.host.manifest.id) {
        throw new Error("远端 manifest id 与当前插件不一致，已停止更新。");
      }
      const currentVersion = this.host.manifest.version || "0.0.0";
      const remoteVersion = remoteManifest.version || "0.0.0";
      const info: AvailableUpdate = {
        version: remoteVersion,
        currentVersion,
        rawBaseUrl: manifestFetch.rawBaseUrl,
        manifestUrl: manifestFetch.url,
        checkedAt: new Date(this.runtime.now()).toISOString(),
      };
      this.host.settings.lastUpdateCheckAt = info.checkedAt;
      this.host.settings.lastUpdateError = "";

      if (compareVersions(remoteVersion, currentVersion) > 0) {
        this.host.settings.availableUpdate = info;
        await this.host.saveSettings();
        this.runtime.notice(
          `QnALog：发现新版本 ${remoteVersion}（当前 ${currentVersion}）。请在设置 > 更新 中查看发布页链接，从 GitHub Release 安装。`,
          silent ? 12000 : 8000,
        );
        return info;
      }

      this.host.settings.availableUpdate = null;
      await this.host.saveSettings();
      if (!silent) this.runtime.notice(`QnALog 已是最新版本（${currentVersion}）。`);
      return null;
    } catch (error) {
      const message = errorMessage(error);
      this.host.settings.lastUpdateCheckAt = new Date(this.runtime.now()).toISOString();
      this.host.settings.lastUpdateError = message;
      await this.host.saveSettings();
      if (!silent) this.runtime.notice(`QnALog 更新检查失败：${message}`, 10000);
      else this.runtime.warn("[QnALog] update check failed", error);
      return null;
    }
  }

  warnIfBuildManifestSkew(): void {
    try {
      const built = this.runtime.buildVersion;
      const declared = this.host.manifest.version || "";
      if (built && declared && built !== declared) {
        this.runtime.warn(`[QnALog] build/manifest 版本错位：main.js=${built} manifest=${declared}`);
        this.runtime.notice(
          `QnALog 版本错位：实际运行的 main.js 是 ${built}，但 manifest 标的是 ${declared}`
          + "。请从 GitHub Release 重新安装该版本后重启 Obsidian。",
          0,
        );
      }
    } catch (error) {
      this.runtime.warn("[QnALog] skew check failed", error);
    }
  }

  private async fetchText(url: string): Promise<string> {
    const errors: string[] = [];
    if (this.runtime.requestUrl) {
      try {
        const response = await this.runtime.requestUrl({
          url,
          method: "GET",
          headers: { "Cache-Control": "no-cache" },
        });
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`HTTP ${response.status} · ${url}`);
        }
        return response.text;
      } catch (error) {
        errors.push(`requestUrl: ${errorMessage(error)}`);
      }
    }
    errors.push("requestUrl unavailable");
    throw new Error(errors.join("；"));
  }

  private async fetchTextFromSources(rawBases: readonly string[], fileName: string): Promise<FetchedUpdateText> {
    const errors: string[] = [];
    for (const rawBase of rawBases) {
      const url = `${joinUpdateUrl(rawBase, fileName)}?t=${this.runtime.now()}`;
      try {
        const text = await this.fetchText(url);
        return { text, rawBaseUrl: rawBase, url };
      } catch (error) {
        errors.push(`${rawBase} -> ${errorMessage(error)}`);
      }
    }
    throw new Error(`所有更新源都不可用：${errors.join(" | ")}`);
  }

}
