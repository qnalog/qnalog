import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const checkScript = path.join(root, "scripts/check-plugin-onload.mjs");

function runCheck() {
  try {
    const stdout = execFileSync("node", [checkScript], { cwd: root, encoding: "utf8" });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status ?? 1, output: String(error.stdout || "") + String(error.stderr || "") };
  }
}

// 检查器自身要有回归保护：它拦的是「域服务漏装」这类没有编译期报错、只在运行时静默失效的问题。
describe("plugin onload assembly check", () => {
  it("当前产物装配齐全", () => {
    const result = runCheck();
    expect(result.code).toBe(0);
    expect(result.output).toContain("域服务装配齐全");
  }, 60_000);

  it("域服务漏装时失败并指出字段名", () => {
    const mainPath = path.join(root, "src/main.ts");
    const bundlePath = path.join(root, "main.js");
    const originalMain = readFileSync(mainPath, "utf8");
    const originalBundle = readFileSync(bundlePath, "utf8");
    // 去掉一个服务的装配语句，重新打包后检查必须失败（顺带证明这条检查真的在跑 onload）
    const withoutRecording = originalMain.replace("    this.recording = new RecordingService(this);\n", "");
    expect(withoutRecording).not.toBe(originalMain);
    try {
      writeFileSync(mainPath, withoutRecording);
      execFileSync("node", [path.join(root, "esbuild.config.mjs"), "production"], { cwd: root, stdio: "ignore" });
      const result = runCheck();
      expect(result.code).toBe(1);
      expect(result.output).toContain("域服务未装配：this.recording");
    } finally {
      writeFileSync(mainPath, originalMain);
      writeFileSync(bundlePath, originalBundle);
    }
  }, 120_000);
});
