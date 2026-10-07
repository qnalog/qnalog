import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || ""),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import {
  DASHSCOPE_FLASH_ASR_PROTOCOL,
  requestDashScopeFlashChunk,
} from "../src/asr/dashscope-flash-asr";
import { transcribeAudio } from "../src/asr/transcribe";
const endpoint = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const audio = { blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), mime: "audio/webm" };
const provider = { id: "dashscope-flash", endpoint, apiKey: "test-key", model: "qwen-audio-3.1-asr-flash", language: "" };
let request: { url: string; init: RequestInit } | null = null;

function installWindow(response: unknown = { output: { text: "  原始转写正文。  " } }): void {
  request = null;
  vi.stubGlobal("window", {
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      request = { url, init };
      return { ok: true, status: 200, json: async () => response };
    }),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    AudioContext: class {
      decodeAudioData = async () => ({ duration: 4, sampleRate: 48000 });
      close = async () => undefined;
    },
  });
}

describe("Bailian Qwen-Audio-3.1-ASR-Flash native HTTP", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends native JSON and extracts output.text without Chat Completions fields", async () => {
    installWindow();
    const result = await requestDashScopeFlashChunk(provider, audio, 5000);
    expect(result).toEqual({ text: "原始转写正文。", rawText: "  原始转写正文。  " });
    expect(request?.url).toBe(endpoint);
    const headers = request?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["X-DashScope-SSE"]).toBe("disable");
    const body = JSON.parse(String(request?.init.body));
    expect(body.model).toBe(provider.model);
    expect(body.input.messages[0].content[0].input_audio.data).toMatch(/^data:audio\/webm;base64,/);
    expect(body.parameters).toEqual({ format: "webm" });
    expect(body.messages).toBeUndefined();
  });

  it("omits automatic language and applies explicit language_hints", async () => {
    installWindow();
    await requestDashScopeFlashChunk(provider, audio, 5000);
    expect(JSON.parse(String(request?.init.body)).parameters.language_hints).toBeUndefined();

    installWindow();
    await requestDashScopeFlashChunk({ ...provider, language: "zh" }, audio, 5000);
    expect(JSON.parse(String(request?.init.body)).parameters.language_hints).toEqual(["zh"]);
  });

  it("sends a WAV sample rate only when it can be read from the WAV header", async () => {
    installWindow();
    await requestDashScopeFlashChunk(provider, audio, 5000);
    expect(JSON.parse(String(request?.init.body)).parameters.sample_rate).toBeUndefined();

    const bytes = new Uint8Array(44);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    bytes.set(new TextEncoder().encode("WAVE"), 8);
    new DataView(bytes.buffer).setUint32(24, 44100, true);
    const wav = { blob: new Blob([bytes], { type: "audio/wav" }), mime: "audio/wav" };
    installWindow();
    await requestDashScopeFlashChunk(provider, wav, 5000);
    expect(JSON.parse(String(request?.init.body)).parameters).toMatchObject({ format: "wav", sample_rate: "44100" });
  });

  it("dispatches the protocol through chunk planning, local correction, and transcript-unit preservation", async () => {
    installWindow({ output: { text: "原始术语。" } });
    const result = await transcribeAudio(
      { settings: { vocabularyFile: "", customVocabulary: "## 易错写法\n原始术语 => 标准术语" } },
      audio.blob,
      audio.mime,
      { ...provider, protocol: DASHSCOPE_FLASH_ASR_PROTOCOL },
    );
    expect(request?.url).toBe(endpoint);
    expect(result.text).toBe("标准术语。");
    expect(result.rawText).toBeNull();
    expect(result.units).toEqual([expect.objectContaining({
      rawText: "原始术语。",
      normalizedText: "标准术语。",
      speakerId: null,
      startMs: null,
      endMs: null,
      timing: "unknown",
    })]);
  });

  it("does not include audio bytes in HTTP or API error messages", async () => {
    installWindow({ output: { code: "InvalidParameter", message: "bad request" } });
    await expect(requestDashScopeFlashChunk(provider, audio, 5000)).rejects.toThrow("InvalidParameter: bad request");
  });
});
