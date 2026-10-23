import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import { getTranscribeRequestTimeoutMs, requestApimimoAsrChunk, transcribeAudio } from "../src/asr/transcribe";

describe("transcribeAudio endpoint security", () => {
  it("上传音频前阻止公网 HTTP 端点", async () => {
    const provider = {
      id: "custom",
      name: "自定义转写",
      endpoint: "http://asr.example.com/v1/audio/transcriptions",
      apiKey: "secret",
      model: "model",
    };
    await expect(transcribeAudio({ settings: {} }, new Blob(["audio"]), "audio/webm", provider))
      .rejects.toThrow("must use HTTPS");
  });

  it("APIMiMo 底层请求也会在读取和编码音频前阻止公网 HTTP", async () => {
    const arrayBuffer = vi.fn();
    await expect(requestApimimoAsrChunk(
      { apiKey: "secret", model: "mimo-v2.5-asr" },
      { blob: { size: 5, arrayBuffer }, mime: "audio/webm" },
      "http://asr.example.com/v1/chat/completions",
    )).rejects.toThrow("must use HTTPS");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

describe("getTranscribeRequestTimeoutMs", () => {
  it("本地服务固定 10 分钟，与体积无关", () => {
    expect(getTranscribeRequestTimeoutMs({ endpoint: "http://127.0.0.1:8000/v1/audio/transcriptions" }, 100 * 1024 * 1024))
      .toBe(10 * 60 * 1000);
    expect(getTranscribeRequestTimeoutMs({ endpoint: "http://localhost:8000/v1/audio/transcriptions" }))
      .toBe(10 * 60 * 1000);
  });

  it("云端无体积信息时保持 120 秒基础超时", () => {
    expect(getTranscribeRequestTimeoutMs({ endpoint: "https://api.siliconflow.cn/v1/audio/transcriptions" }))
      .toBe(120 * 1000);
    expect(getTranscribeRequestTimeoutMs({ endpoint: "https://api.siliconflow.cn/v1/audio/transcriptions" }, 0))
      .toBe(120 * 1000);
  });

  it("云端按体积追加 ≈1s/50KB：3 分钟 WAV（约 5.8MB）≈ 233 秒", () => {
    const bytes = Math.round(5.8 * 1024 * 1024);
    const ms = getTranscribeRequestTimeoutMs({ endpoint: "https://api.siliconflow.cn/v1/audio/transcriptions" }, bytes);
    expect(ms).toBe((120 + Math.ceil(bytes / 51200)) * 1000);
    expect(ms).toBeGreaterThanOrEqual(230 * 1000);
    expect(ms).toBeLessThanOrEqual(240 * 1000);
  });

  it("上传追加封顶 180 秒（总计 300 秒）", () => {
    expect(getTranscribeRequestTimeoutMs({ endpoint: "https://api.siliconflow.cn/v1/audio/transcriptions" }, 1024 * 1024 * 1024))
      .toBe(300 * 1000);
  });
});

describe("transcribeAudio language field", () => {
  async function sentForm(endpoint: string, model: string): Promise<FormData> {
    const fetchMock = vi.fn(async (_url: string, init: { body: FormData }) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ text: "ok" }),
      json: async () => ({ text: "ok" }),
    }));
    vi.stubGlobal("window", { fetch: fetchMock, setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) });
    try {
      await transcribeAudio({ settings: {} }, new Blob(["audio"]), "audio/webm", { id: "custom", name: "x", endpoint, apiKey: "k", model, language: "zh" });
    } finally {
      vi.unstubAllGlobals();
    }
    return fetchMock.mock.calls[0][1].body;
  }

  it("api.openai.com 上的 gpt-transcribe 系列不发送 language，其它模型与地址照旧发送", async () => {
    const openai = "https://api.openai.com/v1/audio/transcriptions";
    expect((await sentForm(openai, "gpt-transcribe")).has("language")).toBe(false);
    expect((await sentForm(openai, "gpt-live-transcribe")).has("language")).toBe(false);
    expect((await sentForm(openai, "whisper-1")).get("language")).toBe("zh");
    expect((await sentForm("https://api.example.com/v1/audio/transcriptions", "gpt-transcribe")).get("language")).toBe("zh");
  });
});
