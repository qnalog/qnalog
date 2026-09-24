import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// validate.yml 的契约（MAINTAINING §4.4）：
//   1) CI 的真实定义 = package.json 的 verify:push，workflow 里不得再长出第二份检查清单；
//   2) fork PR 必须能跑：只读权限、不引用 secret、不发布；
//   3) workflow 名与 job id 是 required status check 绑定的 check context，不得改名——
//      改名后 GitHub 继续等待旧 context，Main Protect 会把所有 PR 永久卡住。
// 断言只看 YAML 本体：头注释允许提到 release.yml 的 contents: write 等对照信息。
const workflow = readFileSync(new URL("../.github/workflows/validate.yml", import.meta.url), "utf8");
const yaml = workflow.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

describe("validate workflow contract", () => {
  it("以 verify:push 作为唯一完整验证入口", () => {
    // YAML 里所有 `npm run X` 都算数：定义只允许存在一处。
    const commands = [...yaml.matchAll(/npm run ([A-Za-z0-9:._-]+)/g)].map((m) => m[1]);
    expect(commands).toEqual(["verify:push"]);
    expect(yaml).toMatch(/npm ci/);
  });

  it("fork PR 可运行：只读权限、无 secret、无发布、监听 pull_request", () => {
    expect(yaml).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(yaml).not.toMatch(/contents:\s*write/);
    expect(yaml).not.toContain("secrets.");
    expect(yaml).not.toContain("gh release");
    expect(yaml).toContain("pull_request:");
  });

  it("钉住 required status check 的 context 名字", () => {
    expect(yaml).toMatch(/^name: Validate$/m);
    // job id 后直接是 runs-on：job 级 name 一旦插入，check context 就从 validate 变成那个名字。
    expect(yaml).toContain("jobs:\n  validate:\n    runs-on:");
  });
});
