import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const TS_NOCHECK_DIRECTIVE = /(?:^\s*\/\/\s*@ts-nocheck\b.*$|^\s*\/\*\s*@ts-nocheck\b.*?\*\/\s*$)/m;

function normalizedPath(filePath) {
  return path.resolve(filePath);
}

export function findUndefinedSymbols({ root = process.cwd(), sourceOverrides = new Map() } = {}) {
  const projectRoot = path.resolve(root);
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    throw new Error(`tsconfig.json not found under ${projectRoot}`);
  }

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  const overrides = new Map(
    [...sourceOverrides.entries()].map(([filePath, source]) => [normalizedPath(filePath), String(source)]),
  );
  const getSourceText = (filePath) => {
    const resolved = normalizedPath(filePath);
    return overrides.has(resolved) ? overrides.get(resolved) : fs.readFileSync(resolved, "utf8");
  };
  const checkedFiles = parsed.fileNames.filter((filePath) => TS_NOCHECK_DIRECTIVE.test(getSourceText(filePath)));
  const checkedSet = new Set(checkedFiles.map(normalizedPath));

  const host = ts.createCompilerHost(parsed.options);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (!checkedSet.has(normalizedPath(fileName))) {
      return defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    }
    const source = getSourceText(fileName).replace(TS_NOCHECK_DIRECTIVE, "");
    return ts.createSourceFile(fileName, source, languageVersion, true);
  };

  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const diagnostics = [];
  for (const filePath of checkedFiles) {
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) continue;
    for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
      if (diagnostic.code !== 2304) continue;
      const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      diagnostics.push({
        file: path.relative(projectRoot, filePath),
        line: position.line + 1,
        column: position.character + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      });
    }
  }

  return {
    checkedFiles: checkedFiles.map((filePath) => path.relative(projectRoot, filePath)),
    diagnostics,
  };
}

function run() {
  const result = findUndefinedSymbols();
  if (!result.diagnostics.length) {
    console.log(`[runtime-symbols] OK: checked ${result.checkedFiles.length} @ts-nocheck files`);
    return;
  }

  console.error("[runtime-symbols] Undefined names found in @ts-nocheck files:");
  for (const diagnostic of result.diagnostics) {
    console.error(
      `  ${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run();
}
