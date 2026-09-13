// 插件构建信息：`npm run install:vault` 安装时写在插件目录下的 build-info.json。
//
// 为什么不注入进 main.js：仓库要求 main.js 能由源码逐字节重建、并与源码同一次提交
// （CI 的 validate 工作流会校验）。若把分支与提交写进产物，dev 分支每次提交都会让
// 产物变化，合并回 main 后 CI 必然报"产物与源码不一致"。
// 因此开发标识放在安装期元数据里，产物本身保持与 git 状态无关。
//
// 通过 Obsidian / BRAT 安装的正式发布没有这个文件，此时版本号就是 manifest 的版本——
// 那本来就是一个发版版。

export interface PluginBuildInfo {
  /** 仓库 manifest 的版本（发版身份），例如 1.0.0 */
  version: string;
  /** 展示用完整版本串；dev 时形如 1.0.0-dev.<分支>.<提交>[.dirty] */
  displayVersion: string;
  /** "release" 或 "dev" */
  channel: string;
  branch: string;
  sha: string;
  dirty: boolean;
  builtAt: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 校验并归一 build-info.json 的内容；不是本模块写出的形状则返回 null。 */
export function normalizePluginBuildInfo(value: unknown): PluginBuildInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const version = text(record.version);
  const displayVersion = text(record.displayVersion);
  const channel = text(record.channel);
  if (!version || !displayVersion || (channel !== "release" && channel !== "dev")) return null;
  return {
    version,
    displayVersion,
    channel,
    branch: text(record.branch),
    sha: text(record.sha),
    dirty: record.dirty === true,
    builtAt: text(record.builtAt),
  };
}

/**
 * 界面上显示的版本串。
 * 有开发标识时用它（其中已含分支与提交），否则回退到 manifest 的版本。
 */
export function resolveDisplayVersion(info: PluginBuildInfo | null, manifestVersion: unknown): string {
  if (info) return info.displayVersion;
  return text(manifestVersion) || "0.0.0";
}

/** 人可读的来源描述，例如「开发分支 refactor/x@a8c8a88（有未提交改动）」。 */
export function describeBuildSource(info: PluginBuildInfo): string {
  if (info.channel === "release") return "发版构建";
  const where = info.sha ? `${info.branch}@${info.sha}` : info.branch;
  return `开发分支 ${where || "未知"}${info.dirty ? "（有未提交改动）" : ""}`;
}

/**
 * 去掉预发布后缀，只留 x.y.z。
 * 版本错位自检用它比较：开发版的 manifest 带 -dev.<分支>.<提交> 后缀，
 * 那是刻意标注，不是"只换了 manifest 没换 main.js"。
 */
export function baseVersion(value: unknown): string {
  return text(value).split("-")[0];
}
