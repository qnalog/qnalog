import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkTagOnMain } from "../scripts/check-release-tag-on-main.mjs";

// 这条检查拦的是「tag 推得出去、main 却被分支保护拒绝」——
// 2026-09-15 发 1.0.1 时真实发生过：Release 正常发布，main 却停在旧版本。
//
// 测试自建一个临时仓库，不用本仓库的历史与 tag：
// CI 是浅克隆，拿不到 tag，依赖真实 tag 的用例在 CI 上会失败。
let repo = "";

function git(args, cwd = repo) {
  return execFileSync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 }).toString().trim();
}

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "qnalog-tagcheck-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(path.join(repo, "a.txt"), "1");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "on main"], repo);
  // origin/main 指向这个提交
  git(["update-ref", "refs/remotes/origin/main", "HEAD"], repo);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("发布前置：tag 必须在 main 上", () => {
  it("tag 指向 main 上的提交 → 放行", () => {
    const r = checkTagOnMain({ cwd: repo, target: "HEAD", branch: "refs/remotes/origin/main" });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("");
    expect(r.target).toMatch(/^[0-9a-f]+$/);
  });

  it("tag 指向 main 之外的提交 → 拒绝，并给出两边 SHA", () => {
    git(["commit", "-q", "--allow-empty", "-m", "off main"], repo);
    const r = checkTagOnMain({ cwd: repo, target: "HEAD", branch: "refs/remotes/origin/main" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("不在");
    // 失败信息要能直接定位：带上 tag 与 main 各自的 SHA
    expect(r.target).toMatch(/^[0-9a-f]+$/);
    expect(r.branch).toMatch(/^[0-9a-f]+$/);
    expect(r.target).not.toBe(r.branch);
    git(["reset", "-q", "--hard", "refs/remotes/origin/main"], repo);
  });

  it("父提交在 main 上、子提交不在 → 仍拒绝（只看是否为祖先）", () => {
    git(["commit", "-q", "--allow-empty", "-m", "child"], repo);
    const r = checkTagOnMain({ cwd: repo, target: "HEAD^", branch: "refs/remotes/origin/main" });
    expect(r.ok).toBe(true);
    const child = checkTagOnMain({ cwd: repo, target: "HEAD", branch: "refs/remotes/origin/main" });
    expect(child.ok).toBe(false);
    git(["reset", "-q", "--hard", "refs/remotes/origin/main"], repo);
  });

  it("缺 main 引用（浅克隆）时给出原因而不是抛错", () => {
    const r = checkTagOnMain({ cwd: repo, target: "HEAD", branch: "refs/remotes/origin/不存在" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("无法解析");
  });
});
