#!/usr/bin/env node
// Usage: node scripts/decision-eval.mjs <answer-key.json> <run.json> [--dialogue <dialogue.json>] [--json]
// Offline scoring only: no network, no API keys. Formats are described in scripts/decision-eval/scoring.ts.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const args = process.argv.slice(2);
const json = args.includes("--json");
const dialogueIndex = args.indexOf("--dialogue");
const dialoguePath = dialogueIndex >= 0 ? args[dialogueIndex + 1] : null;
const files = args.filter((value, index) => !value.startsWith("--") && index !== dialogueIndex + 1);
if (files.length !== 2 || (dialogueIndex >= 0 && !dialoguePath)) {
  console.error("Usage: node scripts/decision-eval.mjs <answer-key.json> <run.json> [--dialogue <dialogue.json>] [--json]");
  process.exit(2);
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qnalog-decision-score-"));
try {
  const outfile = path.join(directory, "scoring.mjs");
  await build({
    entryPoints: [new URL("./decision-eval/scoring.ts", import.meta.url).pathname],
    outfile, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "error",
  });
  const scoring = await import(outfile);
  const key = JSON.parse(await fs.readFile(files[0], "utf8"));
  const run = JSON.parse(await fs.readFile(files[1], "utf8"));
  const dialogue = dialoguePath ? JSON.parse(await fs.readFile(dialoguePath, "utf8")) : null;
  const report = scoring.scoreDecisionEval(key, run, dialogue);
  console.log(json ? JSON.stringify(report, null, 2) : scoring.formatDecisionEvalReport(report));
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
