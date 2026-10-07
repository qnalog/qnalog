import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("obsidian", () => ({ requestUrl: requestMock, Platform: { isMobile: false, isMobileApp: false } }));

import { fetchLlmModelEntries } from "../src/llm/core";
import { resolveBailianAsrRoute, resolveBailianEndpoint, selectBailianAsrModel } from "../src/asr/bailian-asr-registry";

beforeEach(() => requestMock.mockReset());

describe("Bailian ASR route registry", () => {
  it("maps model families and dated snapshots without matching chat or TTS models", () => {
    expect(resolveBailianAsrRoute("qwen-audio-3.1-asr-flash-20250815")).toMatchObject({
      family: "qwen-audio-asr",
      protocol: "dashscope-flash-input-audio",
      transcribeMode: "segmented",
      sampleRate: 16000,
    });
    expect(resolveBailianAsrRoute("paraformer-realtime-v2-8k")).toMatchObject({
      family: "paraformer-realtime",
      transcribeMode: "streaming",
      sampleRate: 8000,
    });
    expect(resolveBailianAsrRoute("qwen3-asr-flash-realtime-2025-09-15")?.protocol).toBe("dashscope-qwen3-realtime");
    expect(resolveBailianAsrRoute("qwen3.8-flash")).toBeNull();
    expect(resolveBailianAsrRoute("qwen-audio-tts")).toBeNull();
  });

  it("rewrites recognized service suffixes while retaining region and proxy prefix", () => {
    expect(resolveBailianEndpoint(
      "https://cn-shanghai.example/proxy/api/v1/services/aigc/multimodal-generation/generation?old=x",
      "filetrans-http",
    )).toBe("https://cn-shanghai.example/proxy/api/v1/services/audio/asr/transcription");
    expect(() => resolveBailianEndpoint("https://gateway.example/custom", "native-http")).toThrow(/API root or a recognized/);
  });
  it("selects one model with matching endpoint and protocol while preserving unrelated provider settings", () => {
    const result = selectBailianAsrModel("dashscope-flash", {
      endpoint: "https://cn-shanghai.example/prefix/api/v1/services/aigc/multimodal-generation/generation",
      apiKey: "secret",
      language: "zh",
      name: "Existing Bailian",
      protocol: "dashscope-flash-input-audio",
    }, "paraformer-realtime-v2-8k");
    expect(result).toMatchObject({
      route: { transcribeMode: "streaming", sampleRate: 8000 },
      provider: {
        endpoint: "wss://cn-shanghai.example/prefix/api-ws/v1/inference",
        apiKey: "secret",
        language: "zh",
        name: "Existing Bailian",
        model: "paraformer-realtime-v2-8k",
        protocol: "dashscope-ws",
      },
    });
    expect(selectBailianAsrModel("custom", { endpoint: "https://other.example/api/v1", protocol: "", apiKey: "secret" }, "qwen3-asr-flash")).toBeNull();
    expect(selectBailianAsrModel("dashscope", { endpoint: "https://relay.example/custom", protocol: "dashscope-ws" }, "qwen3-asr-flash")).toBeNull();
  });

  it("preserves ASR capability metadata and requires a complete, progressing platform listing", async () => {
    const pageOne = {
      output: { total: 3, page_no: 1, page_size: 2, models: [
        { model: "qwen-audio-3.1-asr-flash", name: "ASR Flash", capabilities: ["ASR"] },
        { model: "qwen3.8-flash", capabilities: ["TextGeneration"] },
      ] },
    };
    const pageTwo = {
      output: { total: 3, page_no: 2, page_size: 2, models: [
        { model: "qwen3-asr-flash-realtime-2025-09-15", capabilities: ["Realtime-ASR"] },
      ] },
    };
    requestMock.mockImplementation(async ({ url }: { url: string }) => ({
      status: 200,
      json: String(url).includes("page_no=2") ? pageTwo : pageOne,
      text: "",
    }));
    const entries = await fetchLlmModelEntries("https://dashscope.aliyuncs.com/api/v1", "sk-test", undefined, { requireCompletePagination: true });
    expect(entries.find((entry) => entry.id === "qwen-audio-3.1-asr-flash")?.capabilities).toEqual(["ASR"]);
    expect(entries.map((entry) => entry.id)).toHaveLength(3);
    expect(requestMock).toHaveBeenCalledTimes(2);

    requestMock.mockReset();
    requestMock.mockImplementation(async (request: { url?: string } = {}) => ({
      status: String(request.url || "").includes("page_no=2") ? 503 : 200,
      json: pageOne,
      text: "service unavailable",
    }));
    await expect(fetchLlmModelEntries("https://dashscope.aliyuncs.com/api/v1", "sk-test", undefined, { requireCompletePagination: true }))
      .rejects.toThrow(/HTTP status 503/);
  });
});
