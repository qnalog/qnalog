// 构建身份：谁编译了这份 main.js。
//
// 背景：仓库里的 manifest.json 是发版身份（CI 校验 manifest / package.json / package-lock.json /
// versions.json 四处一致，社区目录也只接受它），因此不能用它承载"这是开发分支"的信息。
// 开发标识改由构建时注入，作用有两处：
//   1) main.js 内（LEXVOICE_BUILD_* 常量）→ 设置页与诊断报告显示当前跑的是哪个分支的构建；
//   2) 本地安装时写进知识库里的 manifest.json → Obsidian 自己的插件列表也能看出是开发版。
// 仓库内的 manifest.json 始终不变。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_BRANCH = "main";

function git(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// 分支名要进版本号字符串：只保留 semver 允许的字符，其余换成短横。
function slug(value) {
  return String(value || "").replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/**
 * 纯函数：由版本、分支、提交、脏标记算出构建身份。独立出来便于单测。
 * - channel："release"（在 main 上、无未提交改动）或 "dev"
 * - displayVersion：release 时等于 version；dev 时形如 1.0.0-dev.<分支>.<提交>[.dirty]
 */
export function computeBuildIdentity(input) {
  const version = String(input.version || "0.0.0");
  const branch = String(input.branch || "");
  const sha = String(input.sha || "");
  const dirty = !!input.dirty;
  const detached = !branch || branch === "HEAD";

  if (!detached && branch === RELEASE_BRANCH && !dirty) {
    return { version, channel: "release", displayVersion: version, branch: RELEASE_BRANCH, sha, dirty: false };
  }

  const parts = ["dev"];
  parts.push(slug(detached ? "detached" : branch) || "unknown");
  if (sha) parts.push(sha);
  if (dirty) parts.push("dirty");

  return {
    version,
    channel: "dev",
    displayVersion: `${version}-${parts.join(".")}`,
    branch: detached ? "detached" : branch,
    sha,
    dirty,
  };
}

/**
 * 工作树是否有"会进打包"的未提交改动。
 * 只看两类：已跟踪文件的改动，以及 src/ 下的未跟踪文件。
 * 不把仓库里任何未跟踪文件都算脏——那样每加一个草稿文件都会让构建被标成开发版，标识就失去意义了。
 */
function hasBundledChanges() {
  if (git(["status", "--porcelain", "--untracked-files=no"]).length > 0) return true;
  return git(["ls-files", "--others", "--exclude-standard", "src"]).length > 0;
}

/** 解析当前工作树的构建身份（读取 manifest.json 与 git 状态）。 */
export function resolveBuildIdentity() {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "manifest.json"), "utf8"));
  return computeBuildIdentity({
    version: String(manifest.version || "0.0.0"),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    sha: git(["rev-parse", "--short", "HEAD"]),
    dirty: hasBundledChanges(),
  });
}

/** 界面与日志用的一行描述，例如「开发分支 refactor/x@a8c8a88（有未提交改动）」。 */
export function describeBuildIdentity(identity = resolveBuildIdentity()) {
  if (identity.channel === "release") return `发版构建 · ${identity.displayVersion}`;
  const where = identity.sha ? `${identity.branch}@${identity.sha}` : identity.branch;
  return `开发分支 ${where}${identity.dirty ? "（有未提交改动）" : ""}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const identity = resolveBuildIdentity();
  console.log(describeBuildIdentity(identity));
  console.log(`manifest 版本：${identity.version}`);
  console.log(`安装到知识库的版本号：${identity.displayVersion}`);
}
