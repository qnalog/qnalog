import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import type { Plugin } from "esbuild";
import { createBuildOptions } from "../esbuild.config.mjs";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const checkScript = path.join(root, "scripts/check-plugin-onload.mjs");
const sourcePath = path.join(root, "src/main.ts");
const mainBundlePath = path.join(root, "main.js");
const manifestPath = path.join(root, "manifest.json");
const audioLinksAssignment = "    this.audioLinks = new AudioTimeLinkService(this);\n";

async function hashSharedInputs() {
  const paths = [sourcePath, mainBundlePath, manifestPath];
  const entries = await Promise.all(paths.map(async (file) => [file, createHash("sha256").update(await readFile(file)).digest("hex")] as const));
  return Object.fromEntries(entries);
}

function childFailure(error: unknown) {
  const details = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
  return {
    code: typeof details.code === "number" ? details.code : 1,
    output: String(details.stdout || "") + String(details.stderr || ""),
  };
}

async function runCheck(bundlePath?: string) {
  const args = bundlePath === undefined ? [checkScript] : [checkScript, "--bundle", bundlePath];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, { cwd: root, encoding: "utf8" });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    return childFailure(error);
  }
}

async function buildFixture(removeAudioLinks: boolean) {
  const directory = await mkdtemp(path.join(root, ".plugin-onload-"));
  try {
    const fixturePlugins: Plugin[] = removeAudioLinks
      ? [{
        name: "remove-audio-links-fixture",
        setup(buildContext) {
          buildContext.onLoad({ filter: /\.ts$/ }, async (args) => {
            if (path.resolve(args.path) !== sourcePath) return undefined;
            const source = await readFile(args.path, "utf8");
            const matches = source.split(audioLinksAssignment).length - 1;
            if (matches !== 1) throw new Error(`Expected exactly one audioLinks assignment, found ${matches}`);
            return {
              contents: source.replace(audioLinksAssignment, ""),
              loader: "ts",
              resolveDir: path.dirname(args.path),
            };
          });
        },
      }]
      : [];
    const outfile = path.join(directory, "main.js");
    await build(createBuildOptions({ production: true, outfile, plugins: fixturePlugins }));
    return { directory, outfile };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// 检查器自身要有回归保护：它拦的是「域服务漏装」这类没有编译期报错、只在运行时静默失效的问题。
describe("plugin onload assembly check", () => {
  it("当前仓库产物装配齐全", async () => {
    const result = await runCheck();
    expect(result.code).toBe(0);
    expect(result.output).toContain("域服务装配齐全");
  }, 60_000);

  it("临时漏装 bundle 失败并指出字段名", async () => {
    const fixture = await buildFixture(true);
    try {
      const result = await runCheck(fixture.outfile);
      expect(result.code).toBe(1);
      expect(result.output).toContain("域服务未装配：this.audioLinks");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, 120_000);

  it("并行检查独立 fixture 且不改写共享输入", async () => {
    const before = await hashSharedInputs();
    const [valid, invalid] = await Promise.all([buildFixture(false), buildFixture(true)]);
    try {
      const [validResult, invalidResult] = await Promise.all([
        runCheck(valid.outfile),
        runCheck(invalid.outfile),
      ]);
      expect(validResult.code).toBe(0);
      expect(validResult.output).toContain("域服务装配齐全");
      expect(invalidResult.code).toBe(1);
      expect(invalidResult.output).toContain("域服务未装配：this.audioLinks");
      expect(await hashSharedInputs()).toEqual(before);
    } finally {
      await Promise.all([
        rm(valid.directory, { recursive: true, force: true }),
        rm(invalid.directory, { recursive: true, force: true }),
      ]);
    }
  }, 180_000);

  it("bundle 参数拒绝不完整、未知和不可读输入", async () => {
    const cases = [
      { args: ["--bundle"], expected: "Usage: node scripts/check-plugin-onload.mjs [--bundle <path>]" },
      { args: ["--unknown"], expected: "Usage: node scripts/check-plugin-onload.mjs [--bundle <path>]" },
      { args: ["--bundle", "missing.js", "--bundle", "other.js"], expected: "Usage: node scripts/check-plugin-onload.mjs [--bundle <path>]" },
      { args: ["--bundle", "missing.js"], expected: "[plugin-onload] ENOENT" },
    ];
    for (const testCase of cases) {
      let result: { code: number; output: string };
      try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [checkScript, ...testCase.args], { cwd: root, encoding: "utf8" });
        result = { code: 0, output: stdout + stderr };
      } catch (error) {
        result = childFailure(error);
      }
      expect(result.code).toBe(1);
      expect(result.output).toContain(testCase.expected);
    }
  }, 60_000);
});
