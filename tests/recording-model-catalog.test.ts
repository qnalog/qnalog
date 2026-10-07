import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("obsidian", () => ({ requestUrl: requestMock, Platform: { isMobile: false, isMobileApp: false } }));

import { fetchRecordingTranscribeModels } from "../src/asr/recording-model-catalog";
import * as obsidian from "obsidian";

function respond(data: unknown, status = 200) {
  requestMock.mockResolvedValue({ status, json: data, text: JSON.stringify(data) });
}

const catalog = (ids: string[]) => ({
  output: { total: ids.length, page_no: 1, page_size: Math.max(1, ids.length), models: ids.map((id) => ({ id })) },
});

beforeEach(() => { requestMock.mockReset(); });

describe("录音转写模型目录", () => {
  it("普通转写地址改为同源目录并只列语音模型", async () => {
    respond(catalog(["FunAudioLLM/SenseVoiceSmall", "chat-model", "voice-tts"]));
    const models = await fetchRecordingTranscribeModels({
      id: "siliconflow",
      endpoint: "https://api.siliconflow.cn/v1/audio/transcriptions",
      apiKey: "secret",
    });
    expect(models).toEqual(["FunAudioLLM/SenseVoiceSmall"]);
    expect(requestMock.mock.calls[0][0].url).toBe("https://api.siliconflow.cn/v1/models");
  });

  it("OpenRouter 使用 transcription 查询参数且目录分类保留 Whisper", async () => {
    respond({ data: [
      { id: "openai/whisper-large-v3", architecture: { output_modalities: ["text"] } },
      { id: "chat-model", architecture: { output_modalities: ["text"] } },
      { id: "voice-tts", architecture: { output_modalities: ["audio"] } },
    ] });
    const models = await fetchRecordingTranscribeModels({ id: "openrouter", endpoint: "https://openrouter.ai/api/v1/audio/transcriptions", apiKey: "secret" });
    expect(models).toEqual(["openai/whisper-large-v3"]);
    expect(requestMock.mock.calls[0][0].url).toBe("https://openrouter.ai/api/v1/models?output_modalities=transcription");
  });

  it("百炼目录不随当前协议缩窄，保留各转写接口族", async () => {
    respond(catalog(["qwen-audio-3.1-asr-flash", "qwen3-asr-flash", "qwen-audio-3.1-asr-flash-filetrans", "chat-model"]));
    const expected = ["qwen-audio-3.1-asr-flash", "qwen-audio-3.1-asr-flash-filetrans", "qwen3-asr-flash"];
    const native = await fetchRecordingTranscribeModels({ id: "dashscope-flash", endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", apiKey: "secret" });
    expect(native).toEqual(expected);
    expect(requestMock.mock.calls[0][0].url).toBe("https://dashscope.aliyuncs.com/api/v1/models?page_no=1&page_size=100");

    requestMock.mockClear();
    const legacy = await fetchRecordingTranscribeModels({ id: "dashscope-chat", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "secret" });
    expect(legacy).toEqual(expected);
    expect(requestMock.mock.calls[0][0].url).toBe("https://dashscope.aliyuncs.com/api/v1/models?page_no=1&page_size=100");
  });

  it("requests Bailian pages in batches of 100 to avoid the six-page rate-limit failure", async () => {
    requestMock.mockImplementation(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      const pageSize = Number(parsed.searchParams.get("page_size") || 20);
      const pageNo = Number(parsed.searchParams.get("page_no") || 1);
      if (pageNo === 6) return { status: 429, text: '{"code":"Throttling.RateQuota"}' };
      const total = 121;
      const start = (pageNo - 1) * pageSize;
      const models = Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, index) => ({
        model: `asr-model-${String(start + index + 1).padStart(3, "0")}`,
        capabilities: ["ASR"],
      }));
      const body = { output: { total, page_no: pageNo, page_size: pageSize, models } };
      return { status: 200, json: body, text: JSON.stringify(body) };
    });

    const models = await fetchRecordingTranscribeModels({
      id: "dashscope-flash",
      endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      apiKey: "secret",
    });

    expect(models).toHaveLength(121);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls.map(([request]) => new URL(request.url).searchParams.get("page_size"))).toEqual(["100", "100"]);
  });


  it("实时转写、翻译与 DashScope WS 使用同源 HTTPS 目录和协议候选", async () => {
    respond(catalog(["gpt-realtime-whisper", "gpt-realtime-translate", "paraformer-realtime-v2", "qwen-audio-3.1-asr-flash-streaming"]));
    const openai = await fetchRecordingTranscribeModels({ id: "openai-realtime", endpoint: "wss://api.openai.com/v1/realtime", apiKey: "secret" }, "openai-realtime-transcription");
    expect(openai).toEqual(["gpt-realtime-whisper"]);
    expect(requestMock.mock.calls[0][0].url).toBe("https://api.openai.com/v1/models");

    requestMock.mockClear();
    const translate = await fetchRecordingTranscribeModels({ id: "openai-realtime-translate", endpoint: "wss://api.openai.com/v1/realtime/translations", apiKey: "secret" }, "openai-realtime-translation");
    expect(translate).toEqual(["gpt-realtime-translate"]);

    requestMock.mockClear();
    const dashscope = await fetchRecordingTranscribeModels({ id: "dashscope", endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference", apiKey: "secret" }, "dashscope-ws");
    expect(dashscope).toEqual(["paraformer-realtime-v2", "qwen-audio-3.1-asr-flash-streaming"]);
    expect(requestMock.mock.calls[0][0].url).toBe("https://dashscope.aliyuncs.com/api/v1/models?page_no=1&page_size=100");
  });

  it("代理前缀与百炼区域 origin 保留，密钥不转发到默认域名", async () => {
    respond(catalog(["qwen-audio-3.1-asr-flash-streaming"]));
    await fetchRecordingTranscribeModels({ id: "dashscope", endpoint: "wss://relay.example/prefix/api-ws/v1/inference", apiKey: "private" }, "dashscope-ws");
    expect(requestMock.mock.calls[0][0].url).toBe("https://relay.example/prefix/api/v1/models?page_no=1&page_size=100");
    expect(requestMock.mock.calls[0][0].headers.Authorization).toBe("Bearer private");

    requestMock.mockClear();
    respond(catalog(["qwen-audio-3.1-asr-flash"]));
    await fetchRecordingTranscribeModels({ id: "dashscope-flash", endpoint: "https://cn-shanghai.example/proxy/api/v1/services/aigc/multimodal-generation/generation?token=x", apiKey: "private" });
    expect(requestMock.mock.calls[0][0].url).toBe("https://cn-shanghai.example/proxy/api/v1/models?page_no=1&page_size=100");
  });

  it("filetrans、MiMo 与 OpenRouter 分离列表只保留实现支持的候选", async () => {
    respond(catalog(["qwen-audio-3.1-asr-flash-filetrans", "qwen-audio-3.0-asr-flash-filetrans", "qwen3-asr-flash"]));
    expect(await fetchRecordingTranscribeModels({ id: "dashscope-filetrans", endpoint: "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription", apiKey: "secret", protocol: "dashscope-filetrans" }))
      .toEqual(["qwen-audio-3.0-asr-flash-filetrans", "qwen-audio-3.1-asr-flash-filetrans", "qwen3-asr-flash"]);

    requestMock.mockClear();
    respond(catalog(["mimo-v2.5-asr", "mimo-v2.5-chat"]));
    expect(await fetchRecordingTranscribeModels({ id: "apimimo", endpoint: "https://api.xiaomimimo.com/v1/chat/completions", apiKey: "secret" })).toEqual(["mimo-v2.5-asr"]);

    requestMock.mockClear();
    respond({ data: [
      { id: "microsoft/mai-transcribe-2", description: "speech" },
      { id: "openai/whisper-large-v3", description: "speaker diarization", architecture: { output_modalities: ["text"] } },
      { id: "chat-model", description: "speaker" },
    ] });
    expect(await fetchRecordingTranscribeModels({ id: "openrouter-diarize", endpoint: "https://openrouter.ai/api/v1/audio/transcriptions", apiKey: "secret", protocol: "openrouter-diarize" })).toEqual(["microsoft/mai-transcribe-2", "openai/whisper-large-v3"]);
    expect(requestMock.mock.calls[0][0].url).toContain("output_modalities=transcription");
  });

  it("拒绝不安全或未知服务，且目录错误不伪造成功", async () => {
    requestMock.mockClear();
    respond(catalog(["chat-model", "voice-tts"]));
    await expect(fetchRecordingTranscribeModels({ id: "local", endpoint: "http://127.0.0.1:8000/v1/audio/transcriptions", apiKey: "" })).resolves.toEqual([]);
    expect(requestMock).toHaveBeenCalledTimes(1);

    requestMock.mockClear();
    await expect(fetchRecordingTranscribeModels({ id: "custom", endpoint: "http://api.example.com/v1/audio/transcriptions", apiKey: "secret" })).rejects.toThrow("must use HTTPS");
    expect(requestMock).not.toHaveBeenCalled();
    await expect(fetchRecordingTranscribeModels({ id: "custom", endpoint: "not a URL", apiKey: "secret" })).rejects.toThrow();
    await expect(fetchRecordingTranscribeModels({ id: "custom", endpoint: "wss://custom.example/realtime", apiKey: "secret" }, "unknown-stream")).rejects.toThrow("does not expose a supported model catalogue");
    expect(requestMock).not.toHaveBeenCalled();

    respond({}, 401);
    await expect(fetchRecordingTranscribeModels({ id: "custom", endpoint: "https://api.example.com/v1/audio/transcriptions", apiKey: "secret" })).rejects.toThrow("HTTP status 401");
    requestMock.mockResolvedValue({ status: 200, text: "not-json" });
    await expect(fetchRecordingTranscribeModels({ id: "custom", endpoint: "https://api.example.com/v1/audio/transcriptions", apiKey: "secret" })).rejects.toThrow("Response is not valid JSON");
  });

  it("未返回转写候选时不回退到聊天模型", async () => {
    respond(catalog(["chat-model", "voice-tts"]));
    await expect(fetchRecordingTranscribeModels({ id: "custom", endpoint: "https://api.example.com/v1/audio/transcriptions", apiKey: "secret" })).resolves.toEqual([]);
    expect(vi.mocked(obsidian.requestUrl)).toHaveBeenCalledTimes(1);
  });
});
