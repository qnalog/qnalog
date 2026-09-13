import { describe, expect, it } from "vitest";
import { checkMainlineIsolation } from "../scripts/check-mainline-isolation.mjs";

// 这条检查守的是 MAINTAINING.md §3 的硬约束：代码与产物不得指向上游仓库。
// 它静默失效的代价是「插件内的检查更新把闭源版本装回来」，所以检查器本身要有用例。
function files(overrides = {}) {
  return {
    "manifest.json": JSON.stringify({ id: "qnalog", version: "2.1.5" }),
    "main.js": `/* banner */ const url = "https://github.com/qnalog/qnalog";`,
    "src/update-source.ts": `export const LEXVOICE_UPDATE_REPO_URL = "https://github.com/qnalog/qnalog";`,
    ...overrides,
  };
}

describe("mainline isolation check", () => {
  it("passes when code and bundle point at this repository", () => {
    expect(checkMainlineIsolation(files())).toEqual([]);
  });

  it("flags an upstream repository URL in source", () => {
    const violations = checkMainlineIsolation(files({
      "src/update-source.ts": `export const LEXVOICE_UPDATE_REPO_URL = "https://github.com/Lynn-x/LexVoice";`,
    }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("src/update-source.ts:1");
  });

  it("flags an upstream URL that only survives in the built bundle", () => {
    const violations = checkMainlineIsolation(files({
      "main.js": `/* banner */ const url = "https://github.com/Lynn-x/LexVoice";`,
    }));
    // 既报上游地址，也报缺少本仓库更新源
    expect(violations).toHaveLength(2);
    expect(violations.join("\n")).toContain("上游仓库标识");
    expect(violations.join("\n")).toContain("更新源可能被改到别处");
  });

  it("flags a bundle that lost this repository's update source", () => {
    const violations = checkMainlineIsolation(files({ "main.js": "/* banner */" }));
    expect(violations).toEqual([`main.js 未包含本仓库更新源 https://github.com/qnalog/qnalog：更新源可能被改到别处`]);
  });

  it("flags a plugin id that collides with the community directory entry", () => {
    const violations = checkMainlineIsolation(files({
      "manifest.json": JSON.stringify({ id: "lexvoice", version: "2.1.5" }),
    }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("预期 qnalog");
  });

  it("flags a missing bundle instead of passing silently", () => {
    const violations = checkMainlineIsolation({ ...files(), "main.js": undefined });
    expect(violations.join("\n")).toContain("main.js 缺失");
  });
});
