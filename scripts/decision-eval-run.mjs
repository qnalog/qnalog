#!/usr/bin/env node
// Usage: node scripts/decision-eval-run.mjs --transcript <asr-result.json> --out <run.json> [--mode meeting|general] [--lang zh|en]
// Model from QNALOG_EVAL_LLM_ENDPOINT / QNALOG_EVAL_LLM_MODEL / QNALOG_EVAL_LLM_KEY (OpenAI-compatible); calls a paid service.
// Bundles scripts/decision-eval/runner.ts with esbuild at run time (same approach as accuracy-baseline-run.mjs),
// with `obsidian` aliased to a Node stand-in, then runs it. Nothing here is part of the plugin bundle.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qnalog-decision-eval-"));
let code = 1;
try {
  const outfile = path.join(directory, "runner.mjs");
  await build({
    absWorkingDir: path.join(here, ".."),
    entryPoints: [path.join(here, "decision-eval", "runner.ts")],
    outfile, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "error",
    alias: { obsidian: path.join(here, "decision-eval", "obsidian-shim.ts") },
    define: { QNALOG_BUILD_VERSION: JSON.stringify("decision-eval-runner") },
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
