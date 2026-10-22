import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// String.prototype.replace expands `$&`, `` $` ``, `$'` and `$$` in a string
// replacement. Transcript text is user content, so every substitution of a
// transcript placeholder must pass a function replacer (or a fixed literal).
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "locales" ? [] : sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("transcript prompt substitution", () => {
  it("inserts runtime transcript text into {{TRANSCRIPT}} only through function replacers", () => {
    const offenders: string[] = [];
    let functionReplacers = 0;
    for (const file of sourceFiles(join(__dirname, "../src"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/\.replace\(\s*"\{\{TRANSCRIPT\}\}"\s*,\s*(.{0,40})/g)) {
        const replacement = match[1].trim();
        if (/^\(\)\s*=>/.test(replacement)) functionReplacers++;
        else if (!/^["'`]/.test(replacement)) offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(functionReplacers).toBeGreaterThan(0);
  });
});
