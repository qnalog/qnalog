import { describe, expect, it } from "vitest";
import { computeBuildIdentity } from "../scripts/build-identity.mjs";
import { describeBuildIdentity, computeBuildIdentity as compute } from "../scripts/build-identity.mjs";
import { baseVersion, getBuildIdentity } from "../src/shared/build-identity";

// 开发分支的构建必须在版本号上能看出来：这是用户在本地验证时区分
// "我正在跑哪一份构建"的唯一依据，静默退化成发版号会让验证失去意义。
describe("构建身份标识", () => {
  it("main 上且无未提交改动 → 发版identity，不带后缀", () => {
    const identity = computeBuildIdentity({ version: "1.0.0", branch: "main", sha: "abc1234", dirty: false });
    expect(identity.channel).toBe("release");
    expect(identity.displayVersion).toBe("1.0.0");
  });

  it("开发分支 → 带分支与提交的 dev 后缀", () => {
    const identity = computeBuildIdentity({ version: "1.0.0", branch: "refactor/main-ts-decomposition", sha: "8a83183", dirty: false });
    expect(identity.channel).toBe("dev");
    expect(identity.displayVersion).toBe("1.0.0-dev.refactor-main-ts-decomposition.8a83183");
  });

  it("有未提交改动 → 追加 dirty，避免把工作树状态当成已提交版本", () => {
    const identity = computeBuildIdentity({ version: "1.0.0", branch: "feat/x", sha: "abc1234", dirty: true });
    expect(identity.displayVersion).toBe("1.0.0-dev.feat-x.abc1234.dirty");
  });

  it("main 上有未提交改动同样算开发版", () => {
    const identity = computeBuildIdentity({ version: "1.0.0", branch: "main", sha: "abc1234", dirty: true });
    expect(identity.channel).toBe("dev");
    expect(identity.displayVersion).toBe("1.0.0-dev.main.abc1234.dirty");
  });

  it("游离头指针没有分支名，用 detached 占位", () => {
    const identity = computeBuildIdentity({ version: "2.1.0", branch: "HEAD", sha: "abc1234", dirty: false });
    expect(identity.channel).toBe("dev");
    expect(identity.displayVersion).toBe("2.1.0-dev.detached.abc1234");
  });

  it("版本串中的分支名只保留 semver 允许的字符", () => {
    const identity = computeBuildIdentity({ version: "1.0.0", branch: "feat/中文 分支#1", sha: "abc1234", dirty: false });
    expect(identity.displayVersion).toBe("1.0.0-dev.feat-1.abc1234");
  });
});

describe("构建来源描述", () => {
  it("开发版给出分支、提交与工作树状态，供设置页展示", () => {
    expect(describeBuildIdentity(compute({ version: "1.0.0", branch: "refactor/main-ts-decomposition", sha: "2548132", dirty: true })))
      .toBe("开发分支 refactor/main-ts-decomposition@2548132（有未提交改动）");
  });

  it("发版版只说明是发版构建", () => {
    expect(describeBuildIdentity(compute({ version: "1.0.0", branch: "main", sha: "abc1234", dirty: false })))
      .toBe("发版构建 · 1.0.0");
  });
});

describe("构建身份读取", () => {
  it("未注入构建常量时（vitest 直接跑源码）回退为开发版，不谎报发版", () => {
    const identity = getBuildIdentity();
    expect(identity.isDev).toBe(true);
    expect(identity.version).toBe("0.0.0");
    expect(identity.sourceDescription).toContain("开发");
  });

  it("baseVersion 去掉预发布后缀，供版本错位自检只比 x.y.z", () => {
    expect(baseVersion("1.0.0-dev.refactor-x.abc1234.dirty")).toBe("1.0.0");
    expect(baseVersion("1.0.0")).toBe("1.0.0");
    expect(baseVersion(undefined)).toBe("");
  });


});
