#!/usr/bin/env node
// Usage: node scripts/accuracy-baseline-run.mjs --provider <dashscope-filetrans|dashscope-flash|custom> --audio <file> --out <result.json> [options]
// Run with --help for all options. Keys are read from QNALOG_EVAL_BAILIAN_KEY / QNALOG_EVAL_CUSTOM_KEY only.
// Bundles scripts/accuracy-baseline/runner.ts with esbuild at run time (same approach as accuracy-baseline.mjs),
// with `obsidian` aliased to a Node stand-in, then runs it. Nothing here is part of the plugin bundle.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qnalog-accuracy-run-"));
let code = 1;
try {
  const outfile = path.join(directory, "runner.mjs");
  await build({
    absWorkingDir: path.join(here, ".."),
    entryPoints: [path.join(here, "accuracy-baseline", "runner.ts")],
    outfile, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "error",
    alias: { obsidian: path.join(here, "accuracy-baseline", "obsidian-shim.ts") },
    // Some plugin modules read this build-time constant; the runner has no manifest to inject it from.
    define: { QNALOG_BUILD_VERSION: JSON.stringify("accuracy-baseline-runner") },
    // CommonJS dependencies bundled into an ES module need a require function.
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  });
  code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
    child.on("exit", (status) => resolve(status ?? 1));
  });
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
process.exit(code);
