import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { isTrustedUpdateSourceUrl, resolveUpdateRawBases } from "../src/update-source";

// 从上游版本迁移过来时，data.json 里会残留指向上游仓库的 availableUpdate
// （典型是 version 2.3.2）。设置页会把它显示成"可用版本"，「安装更新」也可能据此
// 去取产物，所以这个判定必须把上游地址挡掉，同时不能误伤本仓库的镜像地址。
describe("update source trust", () => {
  it("accepts every mirror this repository actually uses", () => {
    expect(resolveUpdateRawBases()).toEqual([
      "https://raw.githubusercontent.com/qnalog/qnalog/main",
      "https://fastly.jsdelivr.net/gh/qnalog/qnalog@main",
      "https://cdn.jsdelivr.net/gh/qnalog/qnalog@main",
    ]);
    for (const url of resolveUpdateRawBases()) {
      expect(isTrustedUpdateSourceUrl(url)).toBe(true);
    }
    expect(isTrustedUpdateSourceUrl("https://github.com/qnalog/qnalog/releases/download/2.1.6")).toBe(true);
    expect(isTrustedUpdateSourceUrl("https://mirror.ghproxy.com/https://github.com/qnalog/qnalog/releases/download/2.1.6")).toBe(true);
  });

  it("rejects update records that point at the upstream repository", () => {
    expect(isTrustedUpdateSourceUrl("https://raw.githubusercontent.com/Lynn-x/LexVoice/main")).toBe(false);
    expect(isTrustedUpdateSourceUrl("https://fastly.jsdelivr.net/gh/Lynn-x/LexVoice@main")).toBe(false);
    expect(isTrustedUpdateSourceUrl("https://github.com/Lynn-x/LexVoice/releases/download/2.3.2")).toBe(false);
  });

  it("rejects unrelated hosts and malformed values even when the path looks right", () => {
    expect(isTrustedUpdateSourceUrl("https://evil.example/qnalog/qnalog/main")).toBe(false);
    expect(isTrustedUpdateSourceUrl("https://raw.githubusercontent.com/attacker/LexVoice/main")).toBe(false);
    expect(isTrustedUpdateSourceUrl("qnalog/qnalog")).toBe(false);
    expect(isTrustedUpdateSourceUrl("")).toBe(false);
    expect(isTrustedUpdateSourceUrl(undefined as unknown as string)).toBe(false);
  });
});
