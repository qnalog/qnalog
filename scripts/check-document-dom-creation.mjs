import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourceRoot = path.join(root, "src");
const forbidden = /\bdocument\s*\.\s*create(?:El|Div|Span|Svg)\s*\(/g;
const violations = [];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(filePath);
      continue;
    }
    if (!entry.isFile() || !filePath.endsWith(".ts")) continue;
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(forbidden)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${path.relative(root, filePath)}:${line}`);
    }
  }
}

visit(sourceRoot);
if (violations.length > 0) {
  console.error("[document-dom-creation] Forbidden document.create* calls found:");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error("Use activeDocument.createElement(...) or an unmounted global createEl()/createDiv() helper.");
  process.exitCode = 1;
} else {
  console.log("[document-dom-creation] OK: no document.createEl/createDiv/createSpan/createSvg calls in src/**/*.ts");
}
