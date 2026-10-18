import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

vi.mock("../src/shared/util-audio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shared/util-audio")>()),
  delayMs: async () => undefined,
}));

import { parseVocabularyGroups } from "../src/vocabulary";
import {
  transcribeAudioWithChatInputAudio,
  DASHSCOPE_CHAT_ASR_CHUNK_MS,
  DASHSCOPE_CHAT_ASR_MAX_BASE64_BYTES,
  DASHSCOPE_CHAT_ASR_MAX_DURATION_MS,
  DASHSCOPE_CHAT_ASR_PROTOCOL,
  approxBase64Bytes,
  buildChatInputAudioChunks,
  getChatInputAudioPlan,
  getChatInputAudioProfile,
  isApimimoAsrProvider,
  isChatInputAudioProvider,
  requestChatInputAudioChunkWithEmptyRetry,
} from "../src/asr/transcribe";

// MediaRecorder 在桌面录的就是 webm/opus；用它的体积推算时长对不上，
// 所以切块判断必须先解码。这里只需要 plan 的决策，不涉及真实解码。
const dashscopeProvider = {
  id: "dashscope-chat",
  endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen3-asr-flash",
  protocol: DASHSCOPE_CHAT_ASR_PROTOCOL,
  language: "",
};

const profile = getChatInputAudioProfile(dashscopeProvider)!;

describe("百炼分段转写的服务识别", () => {
  it("按 protocol 认出百炼分段服务", () => {
    expect(profile).not.toBeNull();
    expect(profile.protocol).toBe(DASHSCOPE_CHAT_ASR_PROTOCOL);
    expect(isChatInputAudioProvider(dashscopeProvider)).toBe(true);
  });

  it("百炼分段服务不是 APIMiMo，两者不会互相误判", () => {
    // 误判的后果很具体：TPM 配速会白白拖慢百炼（多等几十秒），
    // 语种参数会被改成 MiMo 才认的 auto，而百炼在语种不确定时要求整个字段省略。
    expect(isApimimoAsrProvider(dashscopeProvider)).toBe(false);
    const apimimo = getChatInputAudioProfile({ id: "apimimo", model: "mimo-v2.5-asr" })!;
    expect(apimimo.protocol).toBe("apimimo-chat-input-audio");
    expect(apimimo.tpmPacing).toBe(true);
    expect(profile.tpmPacing).toBe(false);
  });

  it("只按模型名也要认出 qwen3-asr-flash（用户自建条目时不带 protocol）", () => {
    const byModel = getChatInputAudioProfile({
      id: "custom",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-asr-flash",
    })!;
    expect(byModel.protocol).toBe(DASHSCOPE_CHAT_ASR_PROTOCOL);
  });

  it("其它服务不受影响", () => {
    expect(getChatInputAudioProfile({ id: "siliconflow", model: "FunAudioLLM/SenseVoiceSmall" })).toBeNull();
    expect(getChatInputAudioProfile({ id: "dashscope", model: "paraformer-realtime-v2" })).toBeNull();
  });
});

describe("百炼分段转写的切块上限", () => {
  it("3 分钟切块换算成 base64 后必须落在 10MB 以内", () => {
    // 16kHz 单声道 16-bit WAV = 32,000 字节/秒。这是切块尺寸的硬约束：
    // 4 分钟就会产出 base64 后超过 10MB 的单块，被服务端拒绝。
    const bytesPerSecond = 32000;
    const chunkBytes = (DASHSCOPE_CHAT_ASR_CHUNK_MS / 1000) * bytesPerSecond;
    expect(approxBase64Bytes(chunkBytes)).toBeLessThanOrEqual(DASHSCOPE_CHAT_ASR_MAX_BASE64_BYTES);

    const fourMinutes = 4 * 60 * bytesPerSecond;
    expect(approxBase64Bytes(fourMinutes)).toBeGreaterThan(DASHSCOPE_CHAT_ASR_MAX_BASE64_BYTES);
  });
  it("服务端单次上限是 5 分钟，比切块尺寸宽松", () => {
    expect(DASHSCOPE_CHAT_ASR_MAX_DURATION_MS).toBe(5 * 60 * 1000);
    expect(DASHSCOPE_CHAT_ASR_MAX_DURATION_MS).toBeGreaterThan(DASHSCOPE_CHAT_ASR_CHUNK_MS);
  });

  it("未超过服务端单次上限的音频原样直发，超过则切块", () => {
    const webm = { size: 50_000, type: "audio/webm" };
    expect(getChatInputAudioPlan(profile, webm, "audio/webm", DASHSCOPE_CHAT_ASR_MAX_DURATION_MS - 1).action).toBe("direct");
    expect(getChatInputAudioPlan(profile, webm, "audio/webm", DASHSCOPE_CHAT_ASR_MAX_DURATION_MS + 1).action).toBe("split");
  });

  it("webm/opus 属原生格式，不必转码（否则每段都要膨胀成 WAV 再上传）", () => {
    const plan = getChatInputAudioPlan(profile, { size: 1024, type: "audio/webm" }, "audio/webm");
    expect(plan.nativeMime).toBe("audio/webm");
    expect(plan.action).toBe("inspect");
  });

  it("时长未知时先解码核实，不靠体积猜", () => {
    expect(getChatInputAudioPlan(profile, { size: 1024, type: "audio/wav" }, "audio/wav").action).toBe("inspect");
  });
});

describe("百炼分段转写的语种参数", () => {
  it("语种留空或 auto 时不下发该字段", () => {
    // 文档：「若音频语种不确定，或包含多种语种…请勿指定该参数」。
    // 下发 auto 与省略不等价，服务端会当成指定了语种。
    expect(profile.languageFor("")).toBe("");
    expect(profile.languageFor("auto")).toBe("");
  });

  it("明确语种透传，取值域比 MiMo 宽", () => {
    expect(profile.languageFor("zh")).toBe("zh");
    expect(profile.languageFor("en")).toBe("en");
    // MiMo 只认 zh/en，其它一律归一为 auto；百炼的取值域是完整的语种码表。
    expect(profile.languageFor("yue")).toBe("yue");
    expect(profile.languageFor("ja")).toBe("ja");
    // 非法值同样不下发，避免把方言名之类的自由文本当成语种发出去。
    expect(profile.languageFor("中文（普通话）")).toBe("");
  });
});

describe("聊天式音频输入的空结果重试", () => {
  it("从解码结果把音频总时长写入直发 chunk", async () => {
    class StubAudioContext {
      decodeAudioData = vi.fn(async () => ({ duration: 2 }));
      close = vi.fn(async () => undefined);
    }
    vi.stubGlobal("window", { AudioContext: StubAudioContext });
    try {
      const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
      const chunks = await buildChatInputAudioChunks(profile, blob, "audio/webm");
      expect(chunks).toEqual([{ blob, mime: "audio/webm", durationMs: 2000 }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("百炼 30 秒以下分块连续空结果返回空文本并保留诊断", async () => {
    const request = vi.fn().mockResolvedValue("");
    const wait = vi.fn().mockResolvedValue(undefined);
    const logDiagnostic = vi.fn().mockResolvedValue(undefined);
    const result = await requestChatInputAudioChunkWithEmptyRetry(
      profile,
      { diagnostics: { logDiagnostic } },
      dashscopeProvider,
      { blob: { size: 1024 }, mime: "audio/webm", durationMs: 2000 },
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      0,
      1,
      request,
      wait,
    );

    expect(result).toEqual({ text: "", rawText: "" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(logDiagnostic).toHaveBeenCalledTimes(2);
    expect(logDiagnostic).toHaveBeenNthCalledWith(1, "warn", "asr.dashscope_chat_empty_chunk", expect.any(String), expect.objectContaining({ attempt: 1 }));
    expect(logDiagnostic).toHaveBeenNthCalledWith(2, "warn", "asr.dashscope_chat_empty_chunk", expect.any(String), expect.objectContaining({ attempt: 2 }));
  });

  it("静音的 50 秒块连续空结果返回空文本且不抛错，两次诊断都保留", async () => {
    const request = vi.fn().mockResolvedValue("");
    const wait = vi.fn().mockResolvedValue(undefined);
    const logDiagnostic = vi.fn().mockResolvedValue(undefined);
    const result = await requestChatInputAudioChunkWithEmptyRetry(
      profile,
      { diagnostics: { logDiagnostic } },
      dashscopeProvider,
      { blob: { size: 1024 }, mime: "audio/wav", durationMs: 50000, quiet: true },
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      0,
      1,
      request,
      wait,
    );

    expect(result).toEqual({ text: "", rawText: "" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(logDiagnostic).toHaveBeenCalledTimes(2);
    expect(logDiagnostic).toHaveBeenNthCalledWith(1, "warn", "asr.dashscope_chat_empty_chunk", expect.any(String), expect.objectContaining({ attempt: 1 }));
    expect(logDiagnostic).toHaveBeenNthCalledWith(2, "warn", "asr.dashscope_chat_empty_chunk", expect.any(String), expect.objectContaining({ attempt: 2 }));
  });

  it("有声的 50 秒块连续空结果仍按失败抛错", async () => {
    const request = vi.fn().mockResolvedValue("");
    const wait = vi.fn().mockResolvedValue(undefined);
    const logDiagnostic = vi.fn().mockResolvedValue(undefined);
    await expect(requestChatInputAudioChunkWithEmptyRetry(
      profile,
      { diagnostics: { logDiagnostic } },
      dashscopeProvider,
      { blob: { size: 1024 }, mime: "audio/wav", durationMs: 50000, quiet: false },
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      0,
      1,
      request,
      wait,
    )).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
    expect(logDiagnostic).toHaveBeenCalledTimes(2);
  });

  it("音量未知且时长 50 秒的块连续空结果仍按失败抛错", async () => {
    const request = vi.fn().mockResolvedValue("");
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(requestChatInputAudioChunkWithEmptyRetry(
      profile,
      null,
      dashscopeProvider,
      { blob: { size: 1024 }, mime: "audio/wav", durationMs: 50000 },
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      0,
      1,
      request,
      wait,
    )).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("聊天式音频输入的静音标记", () => {
  // 采样率取 100 Hz 以缩小测试数据；静音判断只看振幅，与采样率的实际取值无关。
  function stubDecodedAudio(channels: Float32Array[], sampleRate: number, extra: Record<string, unknown> = {}) {
    const buffer = {
      duration: channels[0].length / sampleRate,
      sampleRate,
      numberOfChannels: channels.length,
      getChannelData: (i: number) => channels[i],
      ...extra,
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
    vi.stubGlobal("window", { AudioContext: StubAudioContext, OfflineAudioContext: StubOfflineAudioContext });
  }

  it("直发路径：静音音频标记 quiet 为 true，有声音频为 false", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    try {
      stubDecodedAudio([new Float32Array(50 * 100)], 100);
      const quietChunks = await buildChatInputAudioChunks(profile, blob, "audio/webm");
      expect(quietChunks).toEqual([{ blob, mime: "audio/webm", durationMs: 50000, quiet: true, rms: expect.any(Number) }]);

      stubDecodedAudio([new Float32Array(50 * 100).fill(0.5)], 100);
      const loudChunks = await buildChatInputAudioChunks(profile, blob, "audio/webm");
      expect(loudChunks).toEqual([{ blob, mime: "audio/webm", durationMs: 50000, quiet: false, rms: expect.any(Number) }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("分段路径：每个分块分别判断静音，静音块 quiet 为 true、有声块为 false", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const frames = 6 * 60 * 100; // 6 分钟，100 Hz；前 3 分钟静音，后 3 分钟有声。
    const samples = new Float32Array(frames);
    samples.fill(0.5, frames / 2);
    try {
      stubDecodedAudio([samples], 100);
      const chunks = await buildChatInputAudioChunks(profile, blob, "audio/webm");
      expect(chunks.map((c) => c.durationMs)).toEqual([180000, 180000]);
      expect(chunks.map((c) => c.quiet)).toEqual([true, false]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("无法读取声道数据时 quiet 为未知（undefined），直发结果与原先一致", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    try {
      vi.stubGlobal("window", { AudioContext: class { decodeAudioData = vi.fn(async () => ({ duration: 2 })); close = vi.fn(async () => undefined); } });
      const chunks = await buildChatInputAudioChunks(profile, blob, "audio/webm");
      expect(chunks).toEqual([{ blob, mime: "audio/webm", durationMs: 2000 }]);
      expect(chunks[0].quiet).toBeUndefined();
      expect(chunks[0].rms).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("每个分块携带测得的 RMS：静音块接近 0，有声块等于振幅（0.5）", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const frames = 6 * 60 * 100;
    const samples = new Float32Array(frames);
    samples.fill(0.5, frames / 2);
    try {
      stubDecodedAudio([samples], 100);
      const chunks = await buildChatInputAudioChunks(profile, blob, "audio/webm");
      expect(chunks[0].rms).toBeCloseTo(0, 6);
      expect(chunks[1].rms).toBeCloseTo(0.5, 6);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("百炼分段服务在设置界面里的归类", () => {
  it("只出现在录音转写下拉里，不进导入音频下拉", async () => {
    const { TranscribeProfileService } = await import("../src/asr/transcribe-profile-service");
    const { isImportCapableTranscribeProvider } = await import("../src/asr/diarization");
    const service = new TranscribeProfileService({ settings: {} });
    const provider = { endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-asr-flash", protocol: DASHSCOPE_CHAT_ASR_PROTOCOL };
    const profile = service.getTranscribeProviderProfile("dashscope-chat", provider);
    // 单次 5 分钟的上限决定它不适合整文件导入；导入走 dashscope-filetrans。
    expect(isImportCapableTranscribeProvider(profile, provider)).toBe(false);
    expect(profile.transcribeMode).toBe("segmented");
  });

  it("实时流式那条 dashscope 条目不受影响，仍留在下拉里", async () => {
    const { TranscribeProfileService } = await import("../src/asr/transcribe-profile-service");
    const service = new TranscribeProfileService({ settings: {} });
    const profile = service.getTranscribeProviderProfile("dashscope", { model: "paraformer-realtime-v2" });
    expect(profile.title).toContain("paraformer-realtime");
    expect(profile.transcribeMode).toBe("streaming");
  });
});

describe("聊天式音频输入空块诊断的音量字段", () => {
  it("空块诊断带上时长、quiet 与四位小数的 rms", async () => {
    const logDiagnostic = vi.fn().mockResolvedValue(undefined);
    await requestChatInputAudioChunkWithEmptyRetry(
      profile,
      { diagnostics: { logDiagnostic } },
      dashscopeProvider,
      { blob: { size: 1024 }, mime: "audio/wav", durationMs: 50000, quiet: true, rms: 0.00123456 },
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      0,
      1,
      vi.fn().mockResolvedValue(""),
      vi.fn().mockResolvedValue(undefined),
    );
    expect(logDiagnostic).toHaveBeenNthCalledWith(1, "warn", "asr.dashscope_chat_empty_chunk", expect.any(String), expect.objectContaining({
      durationMs: 50000,
      quiet: true,
      rms: 0.0012,
    }));
  });

  it("有声块诊断 quiet 为 false、rms 约为振幅", async () => {
    const logDiagnostic = vi.fn().mockResolvedValue(undefined);
    await expect(requestChatInputAudioChunkWithEmptyRetry(
      profile,
      { diagnostics: { logDiagnostic } },
      dashscopeProvider,
      { blob: { size: 1024 }, mime: "audio/wav", durationMs: 50000, quiet: false, rms: 0.2 },
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      0,
      1,
      vi.fn().mockResolvedValue(""),
      vi.fn().mockResolvedValue(undefined),
    )).rejects.toThrow();
    expect(logDiagnostic).toHaveBeenNthCalledWith(1, "warn", "asr.dashscope_chat_empty_chunk", expect.any(String), expect.objectContaining({
      durationMs: 50000,
      quiet: false,
      rms: 0.2,
    }));
  });

  it("音量未知时 rms 与 quiet 写为 null，不写成 0 或 false", async () => {
    const logDiagnostic = vi.fn().mockResolvedValue(undefined);
    await expect(requestChatInputAudioChunkWithEmptyRetry(
      profile,
      { diagnostics: { logDiagnostic } },
      dashscopeProvider,
      { blob: { size: 1024 }, mime: "audio/wav", durationMs: 50000 },
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      0,
      1,
      vi.fn().mockResolvedValue(""),
      vi.fn().mockResolvedValue(undefined),
    )).rejects.toThrow();
    expect(logDiagnostic).toHaveBeenNthCalledWith(1, "warn", "asr.dashscope_chat_empty_chunk", expect.any(String), expect.objectContaining({
      durationMs: 50000,
      quiet: null,
      rms: null,
    }));
  });
});

describe("聊天式音频输入的整体结果 quiet 标记", () => {
  // 音频解码用桩；服务响应用桩 JSON（非流式路径），内容由每个用例指定。
  function stubAudioAndResponse(channels: Float32Array[], sampleRate: number, content: string) {
    const buffer = {
      duration: channels[0].length / sampleRate,
      sampleRate,
      numberOfChannels: channels.length,
      getChannelData: (i: number) => channels[i],
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
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("window", { AudioContext: StubAudioContext, OfflineAudioContext: StubOfflineAudioContext, fetch: fetchStub, setTimeout, clearTimeout });
    return fetchStub;
  }
  const plugin = { diagnostics: { logDiagnostic: vi.fn(async () => undefined) } };
  const provider = { ...dashscopeProvider, apiKey: "local-test-key", endpoint: "http://127.0.0.1:9444/compatible-mode/v1/chat/completions" };
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  const vocabulary = parseVocabularyGroups("");
  const quietSamples = () => [new Float32Array(50 * 100)];
  const loudSamples = () => [new Float32Array(50 * 100).fill(0.5)];

  it("全部块静音且文本为空时标记 quiet 为 true", async () => {
    try {
      stubAudioAndResponse(quietSamples(), 100, "");
      const result = await transcribeAudioWithChatInputAudio(profile, plugin, provider, blob, "audio/webm", vocabulary);
      expect(result.text).toBe("");
      expect(result.quiet).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("有声块的空结果不标记 quiet 并继续按失败抛错", async () => {
    try {
      stubAudioAndResponse(loudSamples(), 100, "");
      await expect(transcribeAudioWithChatInputAudio(profile, plugin, provider, blob, "audio/webm", vocabulary)).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("静音块返回非空文本时不标记 quiet", async () => {
    try {
      stubAudioAndResponse(quietSamples(), 100, "你好");
      const result = await transcribeAudioWithChatInputAudio(profile, plugin, provider, blob, "audio/webm", vocabulary);
      expect(result.text).toBe("你好");
      expect("quiet" in result).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
