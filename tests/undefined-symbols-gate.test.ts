import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findUndefinedSymbols } from "../scripts/check-undefined-symbols.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 该用例要验证「门禁能拦住 @ts-nocheck 文件里的悬空引用」，因此必须挑一个仍带指令的文件。
// 逐个文件退出指令是本仓库的常规操作，写死路径会随之下线；这里改为运行时挑一个。
function pickTsNoCheckFile() {
  const directive = /(?:^\s*\/\/\s*@ts-nocheck\b|^\s*\/\*\s*@ts-nocheck\b)/m;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
        continue;
      }
      if (entry.name.endsWith(".ts") && directive.test(fs.readFileSync(full, "utf8"))) return full;
    }
    return null;
  };
  return walk(path.join(projectRoot, "src"));
}

describe("undefined runtime symbol gate", () => {
  it("keeps all @ts-nocheck source files free of unresolved names", () => {
    const result = findUndefinedSymbols({ root: projectRoot });
    expect(result.diagnostics).toEqual([]);
  }, 20_000);

  it("detects the class of dangling function call that broke 1.15.0", () => {
    const target = pickTsNoCheckFile();
    expect(target, "仓库里应当仍有带 @ts-nocheck 的文件；若已全部退出，此用例应改为直接验证 tsc").toBeTruthy();
    const source = fs.readFileSync(target, "utf8");
    const sourceOverrides = new Map([
      [target, `${source}\nqnalogDeliberatelyMissingRuntimeSymbol();\n`],
    ]);
    const result = findUndefinedSymbols({ root: projectRoot, sourceOverrides });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: path.relative(projectRoot, target),
          message: expect.stringContaining("qnalogDeliberatelyMissingRuntimeSymbol"),
        }),
      ]),
    );
  }, 20_000);
});
