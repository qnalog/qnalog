import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Obsidian styles every non-icon button with `button:not(.clickable-icon) { color; background-color; box-shadow }`,
// specificity (0,1,1). A plugin rule written as a bare `.qnalog-x` is (0,1,0) and loses, so its colour,
// background and box-shadow never apply (a transparent text button renders grey; an accent button renders
// grey with default text). Rules for <button> classes that set any of these must be written as
// `button.qnalog-x` or carry more context.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function buttonClasses(): Set<string> {
  const classes = new Set<string>();
  for (const file of sourceFiles("src")) {
    const source = readFileSync(file, "utf8");
    // The options object may contain `${...}` in a template-literal class, so read up to the closing quote
    // of `cls:` instead of up to the first `}`.
    for (const match of source.matchAll(/createEl\(\s*"button"\s*,\s*\{\s*(?:[\w]+:[^,]*,\s*)*?cls:\s*([`"'])([\s\S]*?)\1/g)) {
      const cls = match[2];
      if (cls.includes("clickable-icon")) continue;
      for (const name of cls.match(/qnalog-[\w-]+/g) || []) classes.add(name);
    }
  }
  return classes;
}

describe("button style specificity", () => {
  it("no bare single-class rule sets color, background or box-shadow on a plugin <button> class", () => {
    const classes = buttonClasses();
    const css = readFileSync("styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders: string[] = [];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(^|[\s;])(color|background(-color)?|box-shadow)\s*:/.test(rule[2])) continue;
      for (const selector of rule[1].split(",").map((part) => part.trim())) {
        const bare = /^\.([\w-]+)$/.exec(selector);
        if (bare && classes.has(bare[1])) offenders.push(selector);
      }
    }
    expect(classes.size).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
