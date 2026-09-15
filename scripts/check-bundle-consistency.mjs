// 产物一致性检查：确认仓库里提交的 main.js 能由同一提交的源码重建。
//
// 为什么要有这条：AGENTS.md §5 的本地检查是 `git status --porcelain main.js`，
// 它只能发现「重新构建了但忘了 git add」。如果压根没重新构建，工作区的 main.js
// 与 HEAD 一致，那条检查会给出假通过。实测过：改一处 src 的取值、不构建、只提交源码，
// 本地检查无输出，而 CI 从干净检出构建后判定失败。
//
// 本脚本补上这个缺口，且不需要网络、不需要 CI：
//   1. 把 HEAD 里参与构建的文件导出到一个临时目录；
//   2. 在那里跑一次生产打包；
//   3. 把构建结果与 HEAD 里提交的 main.js 逐字节比对。
//
// 比对对象是 git 对象（HEAD 里的那份），不是工作区文件，因此「忘了构建」
// 与「构建了但忘了提交」两种情况都会被抓住。
//
// 只跑打包这一步：类型检查与其它门禁由 build 与 CI 负责，这里只回答
// 「提交的 main.js 是否等于这份源码构建出的 main.js」。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = "main.js";
const MAX_BUFFER = 64 * 1024 * 1024;

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: root, maxBuffer: MAX_BUFFER, ...options });
}

function fail(message) {
  console.error("[bundle] 产物一致性检查未通过：");
  console.error(`  - ${message}`);
  console.error("[bundle] 见 AGENTS.md §5：main.js 必须能由同一次提交的源码重建。");
  process.exit(1);
}

// 参与构建的路径：src/ 全部，加上构建链路会读取的配置与 manifest。
const BUILD_INPUTS = /^(src\/|esbuild\.config\.mjs$|package\.json$|package-lock\.json$|manifest\.json$|versions\.json$|tsconfig.*\.json$)/;

// 1) 源码有未提交改动时，HEAD 与工作区不一致，比对没有意义。
const dirty = git(["status", "--porcelain", "--", "src", "esbuild.config.mjs", "package.json", "package-lock.json"])
  .toString().trim();
if (dirty) {
  fail(`src 或构建配置有未提交改动，本检查比对的是 HEAD 而不是工作区，此时比对无意义。请先提交：\n${dirty}`);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "qnalog-bundle-"));
try {
  // 2) 把 HEAD 里参与构建的文件写进临时目录。
  const tracked = git(["ls-tree", "-r", "--name-only", "HEAD"]).toString().split("\n").filter(Boolean);
  let copied = 0;
  for (const rel of tracked) {
    if (!BUILD_INPUTS.test(rel)) continue;
    const abs = path.join(tmp, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, git(["show", `HEAD:${rel}`]));
    copied += 1;
  }
  if (copied === 0) fail("HEAD 里没有找到参与构建的文件，检查路径规则是否已失效。");

  // 3) node_modules 从仓库根软链，省去复制开销。
  const nodeModules = path.join(root, "node_modules");
  if (!existsSync(nodeModules)) fail("仓库根没有 node_modules，请先 npm ci。");
  try {
    execFileSync("ln", ["-s", nodeModules, path.join(tmp, "node_modules")]);
  } catch {
    fail("无法在临时目录挂载 node_modules，请确认运行环境为 macOS 或 Linux。");
  }

  // 4) 用临时目录里的源码重新打包。
  execFileSync("node", ["esbuild.config.mjs", "production"], { cwd: tmp, stdio: ["ignore", "pipe", "pipe"] });

  // 5) 逐字节比对。走 cat-file 而不是 git show：后者按文本通道读出，
  //    会把产物里的换行规范化，比对结果失真。
  const rebuilt = readFileSync(path.join(tmp, BUNDLE));
  const committed = git(["cat-file", "blob", `HEAD:${BUNDLE}`]);
  if (!rebuilt.equals(committed)) {
    fail(`提交的 ${BUNDLE}（${committed.length} 字节）与由 HEAD 源码重建的结果（${rebuilt.length} 字节）不一致。\n`
      + "  本地跑 npm run build 后把 main.js 一起提交，再重跑本检查。");
  }

  console.log(`[bundle] OK: 提交的 ${BUNDLE} 可由 HEAD 源码逐字节重建（${rebuilt.length} 字节，源文件 ${copied} 个）`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
