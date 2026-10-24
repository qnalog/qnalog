#!/usr/bin/env node
// Builds a synthetic multi-speaker recording and its ground truth for the accuracy baseline (MAINTAINING §6.1).
//
// Usage:
//   node scripts/accuracy-baseline/assemble-dialogue.mjs <dialogue.json> <out-dir> --tts-cmd "<command>"
//
// The TTS command is a template run once per utterance; {voice} {lang} {text_file} {out} are replaced
// (quoted). Clips are cached in <out-dir>/clips by a hash of voice, language and text, so re-runs do not
// synthesize again. Leading and trailing silence of each clip is removed with ffmpeg, so the ground-truth
// start and end times are the edges of audible speech.
//
// Dialogue file (JSON):
//   {
//     "title": string, "language": "zh" | "en" | "mixed",
//     "gapMs": number,                       // default pause between utterances
//     "speakers": { "<name>": { "voice": string, "lang": string } },
//     "utterances": [{ "speaker": string, "text": string, "lang"?: string,
//                      "gapMs"?: number,      // pause before this utterance
//                      "overlapMs"?: number }] // starts this long before the previous one ends (interruption)
//   }
//
// Output in <out-dir>: dialogue.wav (16 kHz mono), dialogue.mp3, truth.json (scoring.ts ground-truth format).
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SAMPLE_RATE = 16000;

function fail(message) {
  console.error(message);
  process.exit(2);
}

const args = process.argv.slice(2);
const ttsIndex = args.indexOf("--tts-cmd");
const ttsTemplate = ttsIndex >= 0 ? args[ttsIndex + 1] : "";
const positional = args.filter((arg, index) => !arg.startsWith("--") && index !== ttsIndex + 1);
if (positional.length !== 2 || !ttsTemplate) fail("Usage: assemble-dialogue.mjs <dialogue.json> <out-dir> --tts-cmd \"<command>\"");
const [dialoguePath, outDir] = positional;
const dialogue = JSON.parse(fs.readFileSync(dialoguePath, "utf8"));
const clipDir = path.join(outDir, "clips");
fs.mkdirSync(clipDir, { recursive: true });

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** Synthesizes one utterance (cached) and returns its trimmed 16 kHz mono PCM samples. */
function clipSamples(voice, lang, text) {
  const key = createHash("sha256").update(JSON.stringify([voice, lang, text])).digest("hex").slice(0, 16);
  const raw = path.join(clipDir, `${key}.mp3`);
  const pcm = path.join(clipDir, `${key}.s16le`);
  if (!fs.existsSync(raw)) {
    const textFile = path.join(clipDir, `${key}.txt`);
    fs.writeFileSync(textFile, text);
    const command = ttsTemplate
      .replace("{voice}", shellQuote(voice))
      .replace("{lang}", shellQuote(lang))
      .replace("{text_file}", shellQuote(textFile))
      .replace("{out}", shellQuote(raw));
    const result = spawnSync("/bin/sh", ["-c", command], { stdio: ["ignore", "inherit", "inherit"] });
    if (result.status !== 0 || !fs.existsSync(raw)) fail(`TTS failed for clip ${key}`);
  }
  if (!fs.existsSync(pcm)) {
    // Remove silence at both ends: trim the start, reverse, trim again, reverse back.
    const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05";
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", raw, "-af", `${trim},areverse,${trim},areverse`,
      "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", pcm]);
  }
  const buffer = fs.readFileSync(pcm);
  return new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
}

const defaultGap = Number.isFinite(dialogue.gapMs) ? dialogue.gapMs : 400;
const placed = [];
let previousEndMs = 0;
for (const utterance of dialogue.utterances) {
  const speaker = dialogue.speakers[utterance.speaker];
  if (!speaker) fail(`Unknown speaker: ${utterance.speaker}`);
  const samples = clipSamples(speaker.voice, utterance.lang || speaker.lang, utterance.text);
  const durationMs = Math.round((samples.length / SAMPLE_RATE) * 1000);
  const startMs = placed.length === 0
    ? 500
    : utterance.overlapMs ? Math.max(0, previousEndMs - utterance.overlapMs)
      : previousEndMs + (Number.isFinite(utterance.gapMs) ? utterance.gapMs : defaultGap);
  placed.push({ speaker: utterance.speaker, text: utterance.text, startMs, endMs: startMs + durationMs, samples });
  previousEndMs = Math.max(previousEndMs, startMs + durationMs);
}

const totalSamples = Math.ceil(((previousEndMs + 800) / 1000) * SAMPLE_RATE);
const mix = new Int32Array(totalSamples);
for (const clip of placed) {
  const offset = Math.round((clip.startMs / 1000) * SAMPLE_RATE);
  for (let i = 0; i < clip.samples.length; i += 1) mix[offset + i] += clip.samples[i];
}
const out = new Int16Array(totalSamples);
for (let i = 0; i < totalSamples; i += 1) out[i] = Math.max(-32768, Math.min(32767, mix[i]));
const pcmOut = path.join(outDir, "dialogue.s16le");
fs.writeFileSync(pcmOut, Buffer.from(out.buffer));
const common = ["-v", "error", "-y", "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", pcmOut];
execFileSync("ffmpeg", [...common, path.join(outDir, "dialogue.wav")]);
execFileSync("ffmpeg", [...common, "-b:a", "64k", path.join(outDir, "dialogue.mp3")]);
fs.rmSync(pcmOut);

const truth = {
  title: dialogue.title,
  language: dialogue.language,
  utterances: placed.map(({ speaker, text, startMs, endMs }) => ({ speaker, text, startMs, endMs })),
};
fs.writeFileSync(path.join(outDir, "truth.json"), `${JSON.stringify(truth, null, 2)}\n`);
console.log(`ok ${outDir}: ${placed.length} utterances, ${(previousEndMs / 60000).toFixed(1)} min`);
