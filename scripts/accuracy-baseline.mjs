#!/usr/bin/env node
// Usage: node scripts/accuracy-baseline.mjs <ground-truth.json> <asr-result.json> [--json]
// Offline scoring only: no network, no API keys. Format notes are in scripts/accuracy-baseline/scoring.ts.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const args = process.argv.slice(2);
const json = args.includes("--json");
const files = args.filter((a) => !a.startsWith("--"));
if (files.length !== 2) {
  console.error("Usage: node scripts/accuracy-baseline.mjs <ground-truth.json> <asr-result.json> [--json]");
  process.exit(2);
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qnalog-accuracy-"));
try {
  const outfile = path.join(directory, "scoring.mjs");
  await build({
    entryPoints: [new URL("./accuracy-baseline/scoring.ts", import.meta.url).pathname],
    outfile, bundle: true, platform: "node", format: "esm", target: "node22",
  });
  const scoring = await import(outfile);
  const truth = JSON.parse(await fs.readFile(files[0], "utf8"));
  const result = JSON.parse(await fs.readFile(files[1], "utf8"));
  const report = scoring.scoreTranscript(truth, result);
  console.log(json ? JSON.stringify(report, null, 2) : scoring.formatReport(report));
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
