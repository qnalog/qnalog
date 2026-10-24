/**
 * Argument parsing, provider resolution and secret redaction for the accuracy
 * baseline runner (scripts/accuracy-baseline-run.mjs).
 *
 * Location: scripts/accuracy-baseline/. Outside tsconfig "include" (src only), so the
 * plugin bundle never contains it. This file imports no plugin module except the
 * default settings, so it loads in tests without an `obsidian` stand-in.
 *
 * Endpoints, models, protocols and default languages come from DEFAULT_SETTINGS
 * (src/shared/defaults.ts), the same table the plugin writes into a new install.
 */
import { DEFAULT_SETTINGS } from "../../src/shared/defaults";
import type { PluginSettings, TranscribeProviderSettings } from "../../src/shared/types";

export const RUNNER_PROVIDER_IDS = ["dashscope-filetrans", "dashscope-flash", "custom"] as const;
export type RunnerProviderId = (typeof RUNNER_PROVIDER_IDS)[number];

export const BAILIAN_KEY_ENV = "QNALOG_EVAL_BAILIAN_KEY";
export const CUSTOM_KEY_ENV = "QNALOG_EVAL_CUSTOM_KEY";

export const RUNNER_USAGE = [
  "Usage: node scripts/accuracy-baseline-run.mjs --provider <dashscope-filetrans|dashscope-flash|custom> --audio <file> --out <result.json>",
  "         [--diarize] [--speakers N] [--language zh|en|auto] [--model <name>] [--endpoint <url>]",
  "  custom needs --endpoint <url> --model <name>.",
  `  Keys come from environment variables only: ${BAILIAN_KEY_ENV} (dashscope-*), ${CUSTOM_KEY_ENV} (custom, optional).`,
  `  Example: ${BAILIAN_KEY_ENV}=$(security find-generic-password -s herald-bailian -w) node scripts/accuracy-baseline-run.mjs ...`,
].join("\n");

export interface RunnerArgs {
  provider: RunnerProviderId;
  audio: string;
  out: string;
  diarize: boolean;
  speakers: number;
  language: string | null;
  model: string | null;
  endpoint: string | null;
}

export class RunnerUsageError extends Error {}

const VALUE_FLAGS = new Set(["--provider", "--audio", "--out", "--speakers", "--language", "--model", "--endpoint"]);

export function parseRunnerArgs(argv: readonly string[]): RunnerArgs {
  const values = new Map<string, string>();
  let diarize = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--diarize") { diarize = true; continue; }
    if (!VALUE_FLAGS.has(flag)) throw new RunnerUsageError(`Unknown argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new RunnerUsageError(`${flag} needs a value.`);
    values.set(flag, value);
    i++;
  }
  const provider = values.get("--provider") ?? "";
  if (!(RUNNER_PROVIDER_IDS as readonly string[]).includes(provider)) {
    throw new RunnerUsageError(`--provider must be one of: ${RUNNER_PROVIDER_IDS.join(", ")}.`);
  }
  const audio = values.get("--audio") ?? "";
  const out = values.get("--out") ?? "";
  if (!audio) throw new RunnerUsageError("--audio is required.");
  if (!out) throw new RunnerUsageError("--out is required.");
  const speakersText = values.get("--speakers");
  const speakers = speakersText === undefined ? 0 : Number(speakersText);
  if (!Number.isInteger(speakers) || speakers < 0) throw new RunnerUsageError("--speakers must be a non-negative integer.");
  const language = values.get("--language") ?? null;
  if (language !== null && !["zh", "en", "auto"].includes(language)) throw new RunnerUsageError("--language must be zh, en or auto.");
  const endpoint = values.get("--endpoint") ?? null;
  const model = values.get("--model") ?? null;
  if (provider === "custom" && (!endpoint || !model)) throw new RunnerUsageError("--provider custom needs --endpoint <url> and --model <name>.");
  if (provider !== "custom" && endpoint) throw new RunnerUsageError("--endpoint is only used with --provider custom.");
  return { provider: provider as RunnerProviderId, audio, out, diarize, speakers, language, model, endpoint };
}

export interface RunnerSettingsResult {
  settings: PluginSettings;
  providerId: RunnerProviderId;
  apiKey: string;
  /** Notes for stderr, such as options the chosen provider ignores. */
  notes: string[];
}

/**
 * Builds the settings object the plugin's transcription code reads. The provider entry is
 * copied from DEFAULT_SETTINGS; only the key, the CLI overrides and the vocabulary source
 * are changed. Throws RunnerUsageError when a required key is missing.
 */
export function resolveRunnerSettings(args: RunnerArgs, env: Readonly<Record<string, string | undefined>>): RunnerSettingsResult {
  const notes: string[] = [];
  const bailian = args.provider !== "custom";
  const apiKey = (env[bailian ? BAILIAN_KEY_ENV : CUSTOM_KEY_ENV] ?? "").trim();
  if (bailian && !apiKey) throw new RunnerUsageError(`${BAILIAN_KEY_ENV} is not set. Fill it from Keychain service herald-bailian; see the usage text.`);
  const base: TranscribeProviderSettings = { ...(DEFAULT_SETTINGS.transcribeProviders[args.provider] ?? {}) };
  const provider: TranscribeProviderSettings = { ...base, apiKey };
  if (args.model) provider.model = args.model;
  if (args.endpoint) provider.endpoint = args.endpoint;
  if (args.language) provider.language = args.language;
  if (!provider.endpoint || !provider.model) throw new RunnerUsageError(`Provider ${args.provider} has no endpoint or model in the plugin defaults.`);
  if (args.provider !== "dashscope-filetrans" && (args.diarize || args.speakers)) {
    notes.push(`--diarize/--speakers are ignored: ${args.provider} does not do speaker separation in the plugin's path.`);
  }
  const settings: PluginSettings = {
    ...DEFAULT_SETTINGS,
    // The plugin reads a vocabulary note from the vault; the runner has no vault, so no vocabulary is applied.
    vocabularyFile: "",
    customVocabulary: "",
    importTranscribeProvider: args.provider,
    activeTranscribeProvider: args.provider,
    transcribeProviders: { ...DEFAULT_SETTINGS.transcribeProviders, [args.provider]: provider },
  };
  return { settings, providerId: args.provider, apiKey, notes };
}

/** Removes the given secret values and common credential shapes from text destined for the terminal. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let safe = String(text);
  for (const secret of secrets) {
    if (secret.length >= 4) safe = safe.split(secret).join("[redacted]");
  }
  return safe
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}
