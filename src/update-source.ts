import { normalizePath } from "obsidian";

// 更新源指向本分支所在的仓库：上游 main 自带 2.2.0 及之后的专有构建物，
// 若继续指向上游，插件内的「检查更新」会把专有版本覆盖到本分支上。
export const LEXVOICE_UPDATE_REPO_URL = "https://github.com/qnalog/qnalog";
export const LEXVOICE_UPDATE_BRANCH = "main";
export const LEXVOICE_UPDATE_PLUGIN_DIR = "";
export const LEXVOICE_UPDATE_RAW_BASE_URL = "";

export interface GithubRepository {
  owner: string;
  repo: string;
}

export interface PluginPathHost {
  app: {
    vault: {
      configDir: string;
    };
  };
  manifest: {
    id: string;
    dir?: string;
  };
}

export interface PluginBasePathInput {
  configDir: string;
  manifest: {
    id: string;
    dir?: string;
  };
}

export function parseGithubRepoUrl(url: string): GithubRepository | null {
  const text = url.trim();
  const match = text.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)(?:[/#?].*)?$/i)
    ?? text.match(/^git@github\.com:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, "") };
}

export function trimSlashes(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function addUniqueBase(out: string[], url: string): void {
  const clean = url.trim().replace(/\/+$/g, "");
  if (clean && !out.includes(clean)) out.push(clean);
}

// The argument is intentionally accepted for compatibility with the former UI helper.
// Update sources are official constants; persisted settings have never overridden them.
export function resolveUpdateRawBase(_settings?: unknown): string {
  const rawBase = LEXVOICE_UPDATE_RAW_BASE_URL.trim().replace(/\/+$/g, "");
  if (rawBase) return rawBase;
  const repo = parseGithubRepoUrl(LEXVOICE_UPDATE_REPO_URL);
  if (!repo) return "";
  const branch = LEXVOICE_UPDATE_BRANCH.trim() || "main";
  const subdir = trimSlashes(LEXVOICE_UPDATE_PLUGIN_DIR);
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${branch}${subdir ? `/${subdir}` : ""}`;
}

export function resolveUpdateRawBases(settings?: unknown): string[] {
  const out: string[] = [];
  addUniqueBase(out, resolveUpdateRawBase(settings));
  if (LEXVOICE_UPDATE_RAW_BASE_URL.trim()) return out;

  const repo = parseGithubRepoUrl(LEXVOICE_UPDATE_REPO_URL);
  if (!repo) return out;
  const branch = LEXVOICE_UPDATE_BRANCH.trim() || "main";
  const subdir = trimSlashes(LEXVOICE_UPDATE_PLUGIN_DIR);
  const suffix = `${repo.owner}/${repo.repo}@${branch}${subdir ? `/${subdir}` : ""}`;
  addUniqueBase(out, `https://fastly.jsdelivr.net/gh/${suffix}`);
  addUniqueBase(out, `https://cdn.jsdelivr.net/gh/${suffix}`);
  return out;
}

// 更新地址是否来自本仓库。用于丢弃历史遗留的更新信息：从上游版本迁移过来时，
// data.json 里可能残留指向上游仓库的 availableUpdate，设置页会把它显示成"可用版本"，
// 「安装更新」也会据此去取产物。升级/迁移后这类残留必须失效。
//
// 判定同时校验主机（只接受已知的 raw / jsDelivr / GitHub / ghproxy 镜像）
// 与路径中的 owner/repo，避免仅靠字符串包含被无关地址命中。
const TRUSTED_UPDATE_HOSTS = [
  "raw.githubusercontent.com",
  "fastly.jsdelivr.net",
  "cdn.jsdelivr.net",
  "github.com",
  "mirror.ghproxy.com",
  "ghproxy.net",
];

export function isTrustedUpdateSourceUrl(url: string, repoUrl: string = LEXVOICE_UPDATE_REPO_URL): boolean {
  const text = String(url || "").trim();
  if (!text) return false;
  const repo = parseGithubRepoUrl(repoUrl);
  if (!repo) return false;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return false;
  }
  if (!TRUSTED_UPDATE_HOSTS.includes(parsed.hostname.toLowerCase())) return false;
  const needle = `${repo.owner}/${repo.repo}`.toLowerCase();
  return decodeURIComponent(parsed.pathname).toLowerCase().includes(needle);
}

export function resolvePluginBasePath(input: PluginBasePathInput): string {
  const configDir = input.configDir;
  const dir = input.manifest.dir ? input.manifest.dir : input.manifest.id;
  const normalizedDir = normalizePath(dir);
  const pluginRoot = configDir ? normalizePath(`${configDir}/plugins`) : "";
  if (pluginRoot && normalizedDir.startsWith(`${pluginRoot}/`)) return normalizedDir;
  if (!pluginRoot) return normalizedDir;
  return normalizePath(`${pluginRoot}/${normalizedDir}`);
}

export function pluginBasePath(plugin: PluginPathHost): string {
  return resolvePluginBasePath({
    configDir: plugin.app.vault.configDir,
    manifest: plugin.manifest,
  });
}
