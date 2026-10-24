/**
 * Accuracy baseline runner entry. Sends one local audio file through the plugin's own
 * import transcription path and returns the AsrTranscriptResult it produces.
 *
 * Bundled at run time by scripts/accuracy-baseline-run.mjs with `obsidian` aliased to
 * ./obsidian-shim.ts. Outside tsconfig "include", so the plugin bundle never contains it.
 *
 * Call boundary: transcribeImportedAudio (src/asr/long-audio-transcription.ts), the
 * function src/imports/import-service.ts calls. It routes by provider protocol:
 *   dashscope-filetrans -> transcribeDashScopeFile (upload, async task, poll, download)
 *   dashscope-flash     -> transcribeAudio -> transcribeAudioWithDashScopeFlash (3-minute WAV chunks)
 *   custom              -> transcribeAudio (multipart upload to /v1/audio/transcriptions)
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { transcribeImportedAudio } from "../../src/asr/long-audio-transcription";
import type { AsrTranscriptResult } from "../../src/asr/transcript-result";
import { mimeFromExt } from "../../src/shared/util-audio";
import { installNodeAudioGlobals, probeDurationMs } from "./node-audio";
import { RunnerUsageError, parseRunnerArgs, redactSecrets, resolveRunnerSettings, RUNNER_USAGE } from "./runner-config";

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    log(RUNNER_USAGE);
    return 0;
  }
  const secrets: string[] = [];
  try {
    const args = parseRunnerArgs(argv);
    const { settings, providerId, apiKey, notes } = resolveRunnerSettings(args, process.env);
    secrets.push(apiKey);
    for (const note of notes) log(note);
    installNodeAudioGlobals();
    const bytes = await readFile(args.audio);
    const extension = path.extname(args.audio).replace(/^\./, "").toLowerCase();
    const mime = mimeFromExt(extension);
    const blob = new Blob([bytes], { type: mime });
    // The plugin's host object, reduced to what the transcription code reads.
    const host = {
      settings,
      app: { vault: { getAbstractFileByPath: () => null } },
      diagnostics: { logDiagnostic: (level: string, code: string) => { log(`[${level}] ${code}`); return Promise.resolve(); } },
    };
    const model = settings.transcribeProviders[providerId]?.model ?? "";
    log(`provider=${providerId} model=${model} audio=${path.basename(args.audio)} mime=${mime} bytes=${bytes.byteLength}`);
    const result: AsrTranscriptResult = await transcribeImportedAudio(host, blob, mime, {
      providerId,
      diarization: args.diarize,
      speakerCount: args.speakers,
      fileName: path.basename(args.audio),
      audioDurationMs: probeDurationMs(args.audio),
      onProgress: (progress) => log(`[${progress.phase}] ${progress.label}${progress.detail ? ` - ${progress.detail}` : ""}`),
    });
    await writeFile(args.out, `${JSON.stringify(result, null, 2)}\n`);
    log(`wrote ${args.out}: ${result.units.length} units, ${result.text.length} chars${result.noSpeech ? " (no speech reported)" : ""}${result.quiet ? " (quiet audio)" : ""}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Error: ${redactSecrets(message, secrets)}`);
    if (error instanceof RunnerUsageError) log(RUNNER_USAGE);
    return error instanceof RunnerUsageError ? 2 : 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
