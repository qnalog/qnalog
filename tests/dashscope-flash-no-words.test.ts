import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || ""),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

vi.mock("../src/shared/util-audio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shared/util-audio")>()),
  delayMs: async () => undefined,
}));

import { DASHSCOPE_FLASH_ASR_PROTOCOL } from "../src/asr/dashscope-flash-asr";
import { transcribeAudio } from "../src/asr/transcribe";

const endpoint = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const provider = { id: "dashscope-flash", endpoint, apiKey: "test-key", model: "qwen-audio-3.1-asr-flash", language: "", protocol: DASHSCOPE_FLASH_ASR_PROTOCOL };
// 400 s of decoded audio splits into three 180 s chunks at the Flash chunk length.
const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
const NO_WORDS_BODY = { code: "CLIENT_ERROR", message: "ASR_RESPONSE_HAVE_NO_WORDS", request_id: "x" };
const TEXT_BODY = { output: { text: "你好" } };

/** Stubs the browser audio and HTTP layers. `responses` are consumed one per HTTP request, in order. */
function stubFlash(durationSec: number, responses: Array<{ status: number; body: unknown }>) {
  const buffer = {
    duration: durationSec,
    sampleRate: 16000,
    numberOfChannels: 1,
  };
  class StubAudioContext {
    decodeAudioData = vi.fn(async () => buffer);
    close = vi.fn(async () => undefined);
  }
  class StubOfflineAudioContext {
    destination = {};
    createBufferSource() { return { buffer: null, connect: () => undefined, start: () => undefined }; }
    async startRendering() { return { sampleRate: 16000, getChannelData: () => new Float32Array(1) }; }
  }
  const fetchStub = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("window", {
    AudioContext: StubAudioContext,
    OfflineAudioContext: StubOfflineAudioContext,
    fetch: fetchStub,
    setTimeout,
    clearTimeout,
  });
  return fetchStub;
}

function makePlugin() {
  return {
    settings: { vocabularyFile: "", customVocabulary: "" },
    diagnostics: { logDiagnostic: vi.fn(async () => undefined) },
  };
}

describe("Bailian Flash no-words handling in the transcription path", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("turns the no-words error of a short recording into an empty result with noSpeech, without retrying", async () => {
    const fetchStub = stubFlash(4, [{ status: 400, body: NO_WORDS_BODY }]);
    const plugin = makePlugin();
    const result = await transcribeAudio(plugin, blob, "audio/webm", provider);
    expect(result.text).toBe("");
    expect(result.noSpeech).toBe(true);
    expect("quiet" in result).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(plugin.diagnostics.logDiagnostic).toHaveBeenCalledWith(
      "info",
      "asr.dashscope_flash_no_words",
      expect.any(String),
      expect.objectContaining({ chunkIndex: 0, chunkCount: 1 }),
    );
  });

  it("rethrows an authorization failure unchanged", async () => {
    const fetchStub = stubFlash(4, [{ status: 401, body: { code: "InvalidApiKey", message: "Invalid API-key provided." } }]);
    await expect(transcribeAudio(makePlugin(), blob, "audio/webm", provider)).rejects.toThrow("HTTP 401");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("rethrows a different 400 error code unchanged", async () => {
    const fetchStub = stubFlash(4, [{ status: 400, body: { code: "InvalidParameter", message: "bad audio" } }]);
    await expect(transcribeAudio(makePlugin(), blob, "audio/webm", provider)).rejects.toThrow("InvalidParameter");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("rethrows a rate-limit error unchanged", async () => {
    stubFlash(4, [{ status: 429, body: { code: "Throttling", message: "rate limited" } }]);
    await expect(transcribeAudio(makePlugin(), blob, "audio/webm", provider)).rejects.toThrow("HTTP 429");
  });

  it("keeps text from speech chunks when another chunk has no words, and does not set noSpeech", async () => {
    const fetchStub = stubFlash(400, [
      { status: 400, body: NO_WORDS_BODY },
      { status: 200, body: TEXT_BODY },
      { status: 400, body: NO_WORDS_BODY },
    ]);
    const result = await transcribeAudio(makePlugin(), blob, "audio/webm", provider);
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(result.text).toBe("你好");
    expect("noSpeech" in result).toBe(false);
    expect("quiet" in result).toBe(false);
  });

  it("sets noSpeech when every chunk of a multi-chunk recording has no words", async () => {
    const fetchStub = stubFlash(400, [
      { status: 400, body: NO_WORDS_BODY },
      { status: 400, body: NO_WORDS_BODY },
      { status: 400, body: NO_WORDS_BODY },
    ]);
    const result = await transcribeAudio(makePlugin(), blob, "audio/webm", provider);
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(result.text).toBe("");
    expect(result.noSpeech).toBe(true);
  });

  it("does not set noSpeech when a later chunk fails with another error", async () => {
    stubFlash(400, [
      { status: 400, body: NO_WORDS_BODY },
      { status: 403, body: { code: "AccessDenied", message: "forbidden" } },
    ]);
    await expect(transcribeAudio(makePlugin(), blob, "audio/webm", provider)).rejects.toThrow("HTTP 403");
  });
});
