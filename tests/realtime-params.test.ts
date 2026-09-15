import { describe, expect, it } from "vitest";
import {
  buildRealtimeAsrParameters,
  isParaformerRealtimeModel,
  normalizeRealtimeLanguage,
} from "../src/asr/realtime-params";

// 依据（2026-09-15 查证阿里云百炼文档）：
//   `disfluency_removal_enabled` 等字段被文档标注为「仅 Paraformer 支持」，
//   Qwen-Audio-3.0-ASR-Flash-Streaming / Fun-ASR-Realtime 的参数表里没有它们。
// 这条测试钉住「只发目标模型支持的参数」，避免把 Paraformer 专属字段发给别的模型。
describe("实时转写请求参数", () => {
  it("识别 Paraformer 系列", () => {
    expect(isParaformerRealtimeModel("paraformer-realtime-v2")).toBe(true);
    expect(isParaformerRealtimeModel("paraformer-realtime-8k-v2")).toBe(true);
    expect(isParaformerRealtimeModel("qwen-audio-3.0-asr-flash-streaming")).toBe(false);
    expect(isParaformerRealtimeModel("fun-asr-realtime")).toBe(false);
  });

  it("Paraformer 才发 disfluency_removal_enabled", () => {
    const paraformer = buildRealtimeAsrParameters({ model: "paraformer-realtime-v2", sampleRate: 16000 });
    expect(paraformer.disfluency_removal_enabled).toBe(false);

    const qwen = buildRealtimeAsrParameters({ model: "qwen-audio-3.0-asr-flash-streaming", sampleRate: 16000 });
    expect(qwen).not.toHaveProperty("disfluency_removal_enabled");

    const funAsr = buildRealtimeAsrParameters({ model: "fun-asr-realtime", sampleRate: 16000 });
    expect(funAsr).not.toHaveProperty("disfluency_removal_enabled");
  });

  it("始终带上必填的 format 与 sample_rate", () => {
    for (const model of ["paraformer-realtime-v2", "qwen-audio-3.0-asr-flash-streaming", "fun-asr-realtime"]) {
      const parameters = buildRealtimeAsrParameters({ model, sampleRate: 16000 });
      expect(parameters.format, model).toBe("pcm");
      expect(parameters.sample_rate, model).toBe(16000);
    }
  });

  it("用户指定语种时下发 language_hints，未指定则不下发（交给服务端自动识别）", () => {
    const zh = buildRealtimeAsrParameters({ model: "qwen-audio-3.0-asr-flash-streaming", sampleRate: 16000, language: "zh" });
    expect(zh.language_hints).toEqual(["zh"]);

    const auto = buildRealtimeAsrParameters({ model: "qwen-audio-3.0-asr-flash-streaming", sampleRate: 16000, language: "auto" });
    expect(auto).not.toHaveProperty("language_hints");

    const empty = buildRealtimeAsrParameters({ model: "qwen-audio-3.0-asr-flash-streaming", sampleRate: 16000, language: "" });
    expect(empty).not.toHaveProperty("language_hints");
  });

  it("不再无条件下发中英混合（旧实现会给未指定语种的用户强制下发 zh+en）", () => {
    const parameters = buildRealtimeAsrParameters({ model: "qwen-audio-3.0-asr-flash-streaming", sampleRate: 16000, language: "" });
    expect(parameters.language_hints).toBeUndefined();
  });

  it("语种写法归一：zh-CN / 中文 / en-US 都落到服务端认的代码", () => {
    expect(normalizeRealtimeLanguage("zh-CN")).toBe("zh");
    expect(normalizeRealtimeLanguage("ZH_CN")).toBe("zh");
    expect(normalizeRealtimeLanguage("en-US")).toBe("en");
    expect(normalizeRealtimeLanguage("ja")).toBe("ja");
    expect(normalizeRealtimeLanguage("auto")).toBe("");
    expect(normalizeRealtimeLanguage("")).toBe("");
  });
});
