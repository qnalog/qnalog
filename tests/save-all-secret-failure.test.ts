import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");

describe("saveAll when SecretStorage writes fail", () => {
  it("persists the queued task and retains existing settings", async () => {
    let code = 0;
    let output = "";
    try {
      const result = await execFileAsync(
        process.execPath,
        ["scripts/check-plugin-onload.mjs", "--save-all-secret-failure"],
        { cwd: root, encoding: "utf8" },
      );
      output = result.stdout + result.stderr;
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      code = typeof failure.code === "number" ? failure.code : 1;
      output = String(failure.stdout || "") + String(failure.stderr || "");
    }

    expect(code, output).toBe(0);
  }, 60_000);
});
