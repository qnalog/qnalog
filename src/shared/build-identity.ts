// 当前构建的身份：由 esbuild 在打包时注入（见 esbuild.config.mjs）。
//
// 为什么要单独一层：仓库里的 manifest.json 是发版身份，CI 会校验它与
// package.json / package-lock.json / versions.json 四处一致，社区目录也只接受它；
// 因此"这是开发分支的构建"这类信息不能写进仓库的 manifest，
// 只能由构建时注入，并在本地安装时写进知识库副本的 manifest。
//
// typeof 判断是必需的：vitest 直接跑源码，没有 esbuild 的 define 替换。

declare const LEXVOICE_BUILD_VERSION: string;
declare const LEXVOICE_BUILD_CHANNEL: string;
declare const LEXVOICE_BUILD_DISPLAY: string;
declare const LEXVOICE_BUILD_SOURCE: string;

export interface BuildIdentity {
  /** 仓库 manifest 的版本（发版身份），例如 1.0.0 */
  version: string;
  /** "release"：在 main 上且工作树干净；"dev"：其他情况 */
  channel: string;
  /** 界面展示用的完整版本串；dev 时形如 1.0.0-dev.<分支>.<提交>[.dirty] */
  displayVersion: string;
  /** 人可读的来源描述，例如「开发分支 refactor/x@a8c8a88（有未提交改动）」 */
  sourceDescription: string;
  isDev: boolean;
}

function raw(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function getBuildIdentity(): BuildIdentity {
  const version = raw(typeof LEXVOICE_BUILD_VERSION === "string" ? LEXVOICE_BUILD_VERSION : "", "0.0.0");
  const channel = raw(typeof LEXVOICE_BUILD_CHANNEL === "string" ? LEXVOICE_BUILD_CHANNEL : "", "dev");
  const displayVersion = raw(typeof LEXVOICE_BUILD_DISPLAY === "string" ? LEXVOICE_BUILD_DISPLAY : "", version);
  const isDev = channel !== "release";
  const sourceDescription = raw(
    typeof LEXVOICE_BUILD_SOURCE === "string" ? LEXVOICE_BUILD_SOURCE : "",
    isDev ? "开发构建（未注入来源信息）" : `发版构建 · ${version}`,
  );
  return { version, channel, displayVersion, sourceDescription, isDev };
}

/**
 * 去掉预发布后缀，只留 x.y.z 部分。
 * 版本错位自检用它比较：本地安装的开发版 manifest 带 -dev.<分支>.<提交> 后缀，
 * 那是刻意标注，不该被当成"只换了 manifest 没换 main.js"。
 */
export function baseVersion(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.split("-")[0].trim();
}
