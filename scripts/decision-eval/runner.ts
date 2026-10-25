/**
 * Decision evaluation runner. Sends one transcript (an AsrTranscriptResult JSON made by the accuracy
 * baseline runner) through the plugin's own organizing pipeline (mergeAndPolish, which runs
 * mergeAndPolishLongSession for ledger-backed transcripts) and writes the resulting session knowledge.
 *
 * Bundled at run time by scripts/decision-eval-run.mjs with `obsidian` aliased to ./obsidian-shim.ts.
 * Outside tsconfig "include", so the plugin bundle never contains it.
 *
 * The model is any OpenAI-compatible endpoint from the environment:
 *   QNALOG_EVAL_LLM_ENDPOINT, QNALOG_EVAL_LLM_MODEL, QNALOG_EVAL_LLM_KEY.
 * The key is only placed in the in-memory settings; error messages are redacted before printing.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AsrTranscriptResult } from "../../src/asr/transcript-result";
import { mergeAndPolish } from "../../src/briefing/merge-pipeline";
import { readSelectedSessionKnowledge } from "../../src/briefing/session-knowledge";
import { resolveUiLanguage, setActiveUiLanguage } from "../../src/shared/i18n";
import { normalizePluginSettings } from "../../src/shared/settings-io";
import { attachTranscriptResult, getCurrentTranscript } from "../../src/transcript/session-transcript";
import { redactSecrets } from "../accuracy-baseline/runner-config";

export const ENDPOINT_ENV = "QNALOG_EVAL_LLM_ENDPOINT";
export const MODEL_ENV = "QNALOG_EVAL_LLM_MODEL";
export const KEY_ENV = "QNALOG_EVAL_LLM_KEY";
const MODES = ["meeting", "general"] as const;
type EvalMode = (typeof MODES)[number];

const USAGE = [
  "Usage: node scripts/decision-eval-run.mjs --transcript <asr-result.json> --out <run.json> [--mode meeting|general] [--lang zh|en]",
  `Model from ${ENDPOINT_ENV}, ${MODEL_ENV} and ${KEY_ENV} (OpenAI-compatible chat completions).`,
  "Writes <run.json> ({ knowledge, utterances, mode, model }) and <run>.md (the organized note body).",
].join("\n");

class UsageError extends Error {}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function parseArgs(argv: readonly string[]): { transcript: string; out: string; mode: EvalMode; lang: "zh" | "en" } {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const transcript = value("--transcript");
  const out = value("--out");
  const mode = (value("--mode") ?? "meeting") as EvalMode;
  const lang = (value("--lang") ?? "zh") as "zh" | "en";
  if (!transcript || !out) throw new UsageError("--transcript and --out are required");
  if (!MODES.includes(mode)) throw new UsageError(`--mode must be one of ${MODES.join(", ")}`);
  if (lang !== "zh" && lang !== "en") throw new UsageError("--lang must be zh or en");
  return { transcript, out, mode, lang };
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { log(USAGE); return 0; }
  const secrets: string[] = [];
  try {
    const args = parseArgs(argv);
    const endpoint = String(process.env[ENDPOINT_ENV] || "").trim();
    const model = String(process.env[MODEL_ENV] || "").trim();
    const apiKey = String(process.env[KEY_ENV] || "").trim();
    secrets.push(apiKey);
    if (!endpoint || !model || !apiKey) throw new UsageError(`${ENDPOINT_ENV}, ${MODEL_ENV} and ${KEY_ENV} must be set`);

    // The pipeline reads a few browser globals (window.fetch, timers, window.moment).
    Object.assign(globalThis, { window: globalThis });
    setActiveUiLanguage(resolveUiLanguage(args.lang, args.lang));

    const result = JSON.parse(await readFile(args.transcript, "utf8")) as AsrTranscriptResult & { durationMs?: number };
    // The accuracy runner ran with English labels; a Chinese UI labels numbered speakers 说话人N.
    if (args.lang === "zh") {
      for (const unit of result.units) {
        if (unit.speakerName) unit.speakerName = unit.speakerName.replace(/^Speaker (\d+)$/, "说话人$1");
      }
    }
    const durationMs = Number(result.durationMs) || Math.max(0, ...result.units.map((unit) => Number(unit.endMs) || 0));
    const audioName = `${path.basename(args.transcript).replace(/\.json$/i, "")}.mp3`;
    const segment = attachTranscriptResult({
      index: 0, startOffsetMs: 0, endOffsetMs: durationMs, text: result.text, audioPath: `QnALog/Audio/${audioName}`, audioName,
    }, `decision-eval-${audioName}`, result, "asr");

    const settings = Object.assign(normalizePluginSettings({}), { llmEndpoint: endpoint, llmModel: model, llmApiKey: apiKey });
    const files = new Map<string, string>();
    const folders = new Set<string>();
    const adapter = {
      exists: (file: string) => Promise.resolve(files.has(file) || folders.has(file)),
      mkdir: (folder: string) => { folders.add(folder); return Promise.resolve(); },
      write: (file: string, value: string) => { files.set(file, value); return Promise.resolve(); },
      read: (file: string) => {
        const value = files.get(file);
        return value === undefined ? Promise.reject(new Error(`missing ${file}`)) : Promise.resolve(value);
      },
      remove: (file: string) => { files.delete(file); return Promise.resolve(); },
      rename: () => Promise.resolve(),
      list: () => Promise.resolve({ files: [], folders: [] }),
    };
    const host = {
      settings,
      manifest: { id: "qnalog" },
      app: { vault: { adapter, configDir: ".obsidian", getAbstractFileByPath: () => null, getMarkdownFiles: () => [] } },
      getCurrentSession: () => null,
      // The people directory is empty (no vault files); this holds its load cache.
      people: { _peopleDirectoryCache: null },
      diagnostics: {
        logDiagnostic: (level: string, code: string, _message: string, data?: Record<string, unknown>) => {
          const reasons = data && Array.isArray(data.reasons) ? ` reasons=${(data.reasons as unknown[]).join(",")}` : "";
          const part = data && data.part !== undefined ? ` part=${String(data.part)}` : "";
          log(`[${level}] ${code}${part}${reasons}`);
          return Promise.resolve();
        },
      },
    };
    log(`mode=${args.mode} model=${model} transcript=${path.basename(args.transcript)} units=${result.units.length}`);
    const markdown = await mergeAndPolish(host, [segment], args.mode, { duration: "", _freshBriefing: true }, null, null);
    if (typeof markdown !== "string" || !markdown) throw new Error("the pipeline returned no note body");
    const knowledge = readSelectedSessionKnowledge(markdown);
    if (!knowledge) throw new Error("the organized note has no session knowledge");
    const utterances = getCurrentTranscript(segment.transcript!).utterances.map((utterance) => ({
      id: utterance.id, speakerName: utterance.speakerName, text: utterance.normalizedText,
    }));
    await writeFile(args.out, `${JSON.stringify({ mode: args.mode, model, knowledge, utterances }, null, 2)}\n`);
    await writeFile(args.out.replace(/\.json$/i, "") + ".md", markdown);
    log(`wrote ${args.out}: status=${knowledge.status} decisions=${knowledge.decisions.length} actions=${knowledge.actions.length} questions=${knowledge.questions.length}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Error: ${redactSecrets(message, secrets)}`);
    if (error instanceof UsageError) log(USAGE);
    return error instanceof UsageError ? 2 : 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
