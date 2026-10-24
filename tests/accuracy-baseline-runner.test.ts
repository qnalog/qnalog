import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  BAILIAN_KEY_ENV,
  CUSTOM_KEY_ENV,
  RunnerUsageError,
  parseRunnerArgs,
  redactSecrets,
  resolveRunnerSettings,
} from "../scripts/accuracy-baseline/runner-config";
import { createRequestUrl, normalizePath, type ShimFetch } from "../scripts/accuracy-baseline/obsidian-shim";
import { createAudioBuffer, installNodeAudioGlobals, mixToMono, resampleMono } from "../scripts/accuracy-baseline/node-audio";
import { resolveBailianAsrRoute } from "../src/asr/bailian-asr-registry";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";

vi.mock("obsidian", async () => await import("../scripts/accuracy-baseline/obsidian-shim"));

const BASE = ["--provider", "dashscope-filetrans", "--audio", "a.wav", "--out", "r.json"];

describe("parseRunnerArgs", () => {
  it("reads the required and optional flags", () => {
    const args = parseRunnerArgs([...BASE, "--diarize", "--speakers", "3", "--language", "en"]);
    expect(args).toMatchObject({ provider: "dashscope-filetrans", audio: "a.wav", out: "r.json", diarize: true, speakers: 3, language: "en" });
  });

  it("rejects unknown providers, unknown flags and missing values", () => {
    expect(() => parseRunnerArgs(["--provider", "x", "--audio", "a", "--out", "o"])).toThrow(RunnerUsageError);
    expect(() => parseRunnerArgs([...BASE, "--bogus"])).toThrow(/Unknown argument/);
    expect(() => parseRunnerArgs(["--provider", "dashscope-flash", "--audio"])).toThrow(/needs a value/);
    expect(() => parseRunnerArgs([...BASE, "--language", "fr"])).toThrow(/zh, en or auto/);
    expect(() => parseRunnerArgs([...BASE, "--speakers", "-1"])).toThrow(/speakers/);
  });

  it("requires endpoint and model for custom, and only for custom", () => {
    expect(() => parseRunnerArgs(["--provider", "custom", "--audio", "a", "--out", "o"])).toThrow(/--endpoint/);
    expect(() => parseRunnerArgs([...BASE, "--endpoint", "http://x"])).toThrow(/only used with/);
    const custom = parseRunnerArgs(["--provider", "custom", "--audio", "a", "--out", "o", "--endpoint", "http://100.98.7.95:18081/v1/audio/transcriptions", "--model", "m"]);
    expect(custom.endpoint).toContain("100.98.7.95");
  });
});

describe("resolveRunnerSettings", () => {
  it("takes the filetrans endpoint, model and protocol from the plugin defaults", () => {
    const { settings, providerId } = resolveRunnerSettings(parseRunnerArgs(BASE), { [BAILIAN_KEY_ENV]: "sk-test-key-123456" });
    const provider = settings.transcribeProviders[providerId];
    const defaults = DEFAULT_SETTINGS.transcribeProviders["dashscope-filetrans"];
    expect(provider.endpoint).toBe(defaults.endpoint);
    expect(provider.model).toBe(defaults.model);
    expect(provider.protocol).toBe("dashscope-filetrans");
    expect(provider.apiKey).toBe("sk-test-key-123456");
    expect(resolveBailianAsrRoute(provider.model ?? "")?.protocol).toBe("dashscope-filetrans");
    expect(settings.vocabularyFile).toBe("");
  });

  it("takes the flash model and protocol from the plugin defaults and routes to the flash protocol", () => {
    const args = parseRunnerArgs(["--provider", "dashscope-flash", "--audio", "a", "--out", "o"]);
    const { settings } = resolveRunnerSettings(args, { [BAILIAN_KEY_ENV]: "k-abcdefgh" });
    const provider = settings.transcribeProviders["dashscope-flash"];
    expect(provider.protocol).toBe("dashscope-flash-input-audio");
    expect(resolveBailianAsrRoute(provider.model ?? "")?.protocol).toBe("dashscope-flash-input-audio");
  });

  it("applies --model and --language overrides", () => {
    const args = parseRunnerArgs([...BASE, "--model", "qwen-audio-3.0-asr-flash-filetrans", "--language", "auto"]);
    const provider = resolveRunnerSettings(args, { [BAILIAN_KEY_ENV]: "k-abcdefgh" }).settings.transcribeProviders["dashscope-filetrans"];
    expect(provider.model).toBe("qwen-audio-3.0-asr-flash-filetrans");
    expect(provider.language).toBe("auto");
  });

  it("requires the Bailian key but not the custom key", () => {
    expect(() => resolveRunnerSettings(parseRunnerArgs(BASE), {})).toThrow(new RegExp(BAILIAN_KEY_ENV));
    const custom = parseRunnerArgs(["--provider", "custom", "--audio", "a", "--out", "o", "--endpoint", "http://100.98.7.95:18081/v1/audio/transcriptions", "--model", "fun-asr-nano"]);
    expect(resolveRunnerSettings(custom, {}).apiKey).toBe("");
    expect(resolveRunnerSettings(custom, { [CUSTOM_KEY_ENV]: "abcd1234" }).apiKey).toBe("abcd1234");
  });

  it("notes that diarization options are ignored outside filetrans", () => {
    const args = parseRunnerArgs(["--provider", "dashscope-flash", "--audio", "a", "--out", "o", "--diarize"]);
    expect(resolveRunnerSettings(args, { [BAILIAN_KEY_ENV]: "k-abcdefgh" }).notes[0]).toMatch(/ignored/);
  });
});

describe("redactSecrets", () => {
  it("removes the key value, bearer tokens and sk- keys", () => {
    const text = "failed with key sk-abcdef123456 and header Authorization: Bearer abc.def-ghi_jklmno; token qwertyuiop9999";
    const safe = redactSecrets(text, ["qwertyuiop9999"]);
    expect(safe).not.toContain("abcdef123456");
    expect(safe).not.toContain("abc.def-ghi_jklmno");
    expect(safe).not.toContain("qwertyuiop9999");
  });
});

describe("obsidian shim requestUrl", () => {
  const fakeFetch = (status: number, body: string): ShimFetch => async () => ({
    status,
    headers: { forEach: (callback) => callback("application/json", "Content-Type") },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  });

  it("returns status, lower-case headers, text and json, and forwards the request", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string | ArrayBuffer }> = [];
    const requestUrl = createRequestUrl(async (url, init) => { calls.push({ url, ...init }); return fakeFetch(200, '{"a":1}')(url, init); });
    const response = await requestUrl({ url: "https://x.test/p", method: "POST", headers: { Authorization: "Bearer k" }, body: "{}", contentType: "application/json" });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.text).toBe('{"a":1}');
    expect(response.json).toEqual({ a: 1 });
    expect(calls[0]).toMatchObject({ url: "https://x.test/p", method: "POST", body: "{}" });
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
  });

  it("returns an error status without throwing when throw is false, and rejects otherwise", async () => {
    const requestUrl = createRequestUrl(fakeFetch(403, '{"message":"no"}'));
    expect((await requestUrl({ url: "https://x.test", throw: false })).status).toBe(403);
    await expect(requestUrl({ url: "https://x.test" })).rejects.toThrow(/status 403/);
  });

  it("normalizes paths like Obsidian does", () => {
    expect(normalizePath("/a//b\\c/")).toBe("a/b/c");
  });
});

describe("node audio helpers", () => {
  it("averages channels and downsamples with a box filter", () => {
    expect(Array.from(mixToMono([Float32Array.of(1, 0), Float32Array.of(0, 1)]))).toEqual([0.5, 0.5]);
    expect(Array.from(resampleMono(Float32Array.of(1, 1, 0, 0, 1, 1), 6, 3))).toEqual([1, 0, 1]);
    expect(resampleMono(Float32Array.of(0, 1), 1, 2).length).toBe(4);
  });

  it("reports duration from length and rate", () => {
    expect(createAudioBuffer([new Float32Array(16000)], 16000).duration).toBe(1);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const scratch = mkdtempSync(path.join(tmpdir(), "qnalog-runner-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.skipIf(!hasFfmpeg)("dashscope-flash path on Node audio stand-ins", () => {
  it("sends a 6-minute recording as two 3-minute WAV requests (fake service)", async () => {
    const file = path.join(scratch, "silent-6min.wav");
    const made = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "360", file]);
    expect(made.status).toBe(0);
    installNodeAudioGlobals();
    const sent: Array<{ format: string; sampleRate: string; bytes: number }> = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const payload = JSON.parse(init.body) as { input: { messages: Array<{ content: Array<{ input_audio: { data: string } }> }> }; parameters: { format: string; sample_rate: string } };
      sent.push({ format: payload.parameters.format, sampleRate: payload.parameters.sample_rate, bytes: payload.input.messages[0].content[0].input_audio.data.length });
      return new Response(JSON.stringify({ output: { text: "hello" } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const { transcribeAudioWithDashScopeFlash } = await import("../src/asr/transcribe");
      const provider = { id: "dashscope-flash", ...DEFAULT_SETTINGS.transcribeProviders["dashscope-flash"], apiKey: "k-abcdefgh" };
      const bytes = await readFile(file);
      const result = await transcribeAudioWithDashScopeFlash({ settings: {} }, provider, new Blob([bytes], { type: "audio/wav" }), "audio/wav", {});
      expect(sent.length).toBe(2);
      expect(sent.every((request) => request.format === "wav" && request.sampleRate === "16000")).toBe(true);
      // 180 s of 16 kHz mono 16-bit PCM plus a 44-byte header, base64 encoded, plus the data-URL prefix.
      expect(sent[0].bytes).toBeGreaterThan(Math.ceil((180 * 32000 + 44) / 3) * 4);
      expect(result.text).toBe("hello hello");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
