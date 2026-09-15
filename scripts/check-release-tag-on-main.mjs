// 发布前置检查：tag 指向的提交必须在 main 上。
//
// 为什么需要：`main` 有 `Main Protect` 规则、直推会被拒绝，而**推 tag 不受同一规则约束**。
// 于是「提交 → 推 main（被拒）→ 推 tag（成功）」会让 Release 正常发出去、main 却停在
// 旧版本。2026-09-15 发 1.0.1 时就是这样（见 MAINTAINING §4.2）。
//
// Release 内容本身不会错——发布工作流检出的是 tag 而不是 main。但仓库状态不一致，
// 而且下一个版本会从一个落后的 main 继续往前走。这条检查把它变成机械失败。
//
// 放进脚本而不是写成 workflow 里的内联 bash：这样本地能跑、也能被测试覆盖
// （内联 bash 只能等真的推 tag 才知道对不对）。

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BUFFER = 16 * 1024 * 1024;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, maxBuffer: MAX_BUFFER }).toString().trim();
}

/**
 * 判断 `target` 是否已在 `branch` 上（即 target 是 branch 的祖先）。
 *
 * 返回 `{ ok, target, branch, reason }`；查不到 ref 时 ok=false 并给出原因，
 * 而不是抛异常——调用方要能把原因写进失败信息里。
 */
export function checkTagOnMain({ cwd, target = "HEAD", branch = "refs/remotes/origin/main" } = {}) {
  const at = cwd ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let targetSha = "";
  let branchSha = "";
  try {
    targetSha = git(["rev-parse", "--short", target], at);
    branchSha = git(["rev-parse", "--short", branch], at);
  } catch {
    return { ok: false, target, branch, reason: `无法解析 ${target} 或 ${branch}（浅克隆会缺 main 的引用，需要 fetch-depth: 0）` };
  }
  try {
    git(["merge-base", "--is-ancestor", target, branch], at);
    return { ok: true, target: targetSha, branch: branchSha, reason: "" };
  } catch {
    return {
      ok: false,
      target: targetSha,
      branch: branchSha,
      reason: `提交 ${targetSha} 不在 ${branch}（${branchSha}）上`,
    };
  }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const target = process.env.GITHUB_REF_NAME ? `refs/tags/${process.env.GITHUB_REF_NAME}` : "HEAD";
  const branch = process.env.QNALOG_MAIN_REF ?? "refs/remotes/origin/main";
  const result = checkTagOnMain({ cwd: root, target, branch });

  if (!result.ok) {
    console.error("[release-tag] 拒绝发布：");
    console.error(`  ${result.reason}`);
    console.error("[release-tag] 先把版本提交合并进 main（走 PR），删掉这个 tag，再重新打 tag 推送。");
    console.error("[release-tag] 补救步骤见 MAINTAINING.md §4.2。");
    process.exit(1);
  }
  console.log(`[release-tag] OK: tag 已在 main 上（${result.target}）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
