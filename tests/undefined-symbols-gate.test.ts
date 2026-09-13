import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findUndefinedSymbols } from "../scripts/check-undefined-symbols.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainPath = path.join(projectRoot, "src", "main.ts");

describe("undefined runtime symbol gate", () => {
  it("keeps all @ts-nocheck source files free of unresolved names", () => {
    const result = findUndefinedSymbols({ root: projectRoot });
    expect(result.diagnostics).toEqual([]);
  }, 20_000);

  it("detects the class of dangling function call that broke 1.15.0", () => {
    const mainSource = fs.readFileSync(mainPath, "utf8");
    const sourceOverrides = new Map([
      [mainPath, `${mainSource}\nlexvoiceDeliberatelyMissingRuntimeSymbol();\n`],
    ]);
    const result = findUndefinedSymbols({ root: projectRoot, sourceOverrides });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: path.join("src", "main.ts"),
          message: expect.stringContaining("lexvoiceDeliberatelyMissingRuntimeSymbol"),
        }),
      ]),
    );
  }, 20_000);
});
