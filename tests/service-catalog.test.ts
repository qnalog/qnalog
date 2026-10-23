import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (p: string) => String(p || ""), TFile: class {}, TFolder: class {} }));
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { PluginSettings } from "../src/shared/types";
import { getLlmServicePreset } from "../src/llm/config";
import { TranscribeProfileService } from "../src/asr/transcribe-profile-service";
import { resolveBailianAsrRoute } from "../src/asr/bailian-asr-registry";
import {
  bailianRecordingProviderIdForModel,
  currentLlmServiceId,
  currentLlmServiceLabel,
  currentRecordingServiceId,
  currentRecordingServiceLabel,
  defaultQuickSetupProviderId,
  listLlmServices,
  listQuickSetupProviders,
  listRecordingServices,
  selectRecordingService,
} from "../src/setup/service-catalog";

function fresh(): PluginSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as PluginSettings;
}

const ids = (list: { id: string }[]) => list.map((item) => item.id);

describe("录音转写目录", () => {
  it("新用户只看到五项，且没有旧服务条目", () => {
    const list = listRecordingServices(fresh());
    expect(ids(list)).toEqual(["openai", "groq", "bailian", "siliconflow", "custom"]);
    expect(list.every((item) => !item.legacy)).toBe(true);
  });

  it("当前服务已隐藏时，选择器多出一项旧服务，且是当前值", () => {
    const s = fresh();
    s.activeTranscribeProvider = "apimimo";
    const list = listRecordingServices(s);
    expect(ids(list)).toEqual(["openai", "groq", "bailian", "siliconflow", "custom", "apimimo"]);
    const legacy = list[list.length - 1];
    expect(legacy.legacy).toBe(true);
    expect(legacy.label).toContain("Legacy (still works)");
    expect(currentRecordingServiceId(s)).toBe("apimimo");
  });

  it("每个隐藏的 provider 在设置里仍可解析（代码与默认配置都保留）", () => {
    for (const id of ["apimimo", "openai-realtime", "openai-realtime-translate", "openai-diarize", "openrouter", "dashscope-chat", "dashscope-filetrans", "openrouter-diarize"]) {
      expect(DEFAULT_SETTINGS.transcribeProviders[id], id).toBeTruthy();
    }
  });

  it("百炼是单一目录项：三条路线都显示为它，不算旧服务", () => {
    for (const providerId of ["dashscope-flash", "dashscope-chat", "dashscope"]) {
      const s = fresh();
      s.activeTranscribeProvider = providerId;
      expect(currentRecordingServiceId(s)).toBe("bailian");
      expect(listRecordingServices(s).some((item) => item.legacy)).toBe(false);
    }
  });

  it("选百炼：从别的服务切来用 HTTP 默认路线，已在百炼内则保持当前路线", () => {
    const s = fresh();
    expect(selectRecordingService(s, "bailian")).toEqual({ activeTranscribeProvider: "dashscope-flash" });
    s.activeTranscribeProvider = "dashscope";
    expect(selectRecordingService(s, "bailian")).toEqual({ activeTranscribeProvider: "dashscope" });
    expect(selectRecordingService(s, "openai")).toEqual({ activeTranscribeProvider: "openai" });
  });

  it("选择只写 activeTranscribeProvider，不改任何服务配置", () => {
    const s = fresh();
    s.transcribeProviders.custom = { ...s.transcribeProviders.custom, endpoint: "http://192.168.1.20:9000/v1/audio/transcriptions", apiKey: "k" };
    const update = selectRecordingService(s, "custom");
    expect(Object.keys(update)).toEqual(["activeTranscribeProvider"]);
  });

  it("百炼按模型决定路线，且与登记表一致", () => {
    expect(bailianRecordingProviderIdForModel("qwen-audio-3.1-asr-flash")).toBe("dashscope-flash");
    expect(bailianRecordingProviderIdForModel("fun-asr-flash")).toBe("dashscope-flash");
    expect(bailianRecordingProviderIdForModel("qwen3-asr-flash")).toBe("dashscope-chat");
    expect(bailianRecordingProviderIdForModel("qwen-audio-3.1-asr-flash-streaming")).toBe("dashscope");
    expect(bailianRecordingProviderIdForModel("paraformer-realtime-v2")).toBe("dashscope");
    // 整文件模型只用于导入；未登记模型不猜
    expect(bailianRecordingProviderIdForModel("qwen-audio-3.1-asr-flash-filetrans")).toBeNull();
    expect(bailianRecordingProviderIdForModel("some-unknown-model")).toBeNull();
    expect(resolveBailianAsrRoute("qwen3-asr-flash")?.protocol).toBe("dashscope-chat-input-audio");
  });

  it("Groq 默认配置走 OpenAI 兼容的分段上传，且需要密钥", () => {
    const groq = DEFAULT_SETTINGS.transcribeProviders.groq;
    expect(groq.endpoint).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(groq.model).toBe("whisper-large-v3-turbo");
    expect(groq.protocol).toBeUndefined();
    const profile = new TranscribeProfileService({ settings: fresh() }).getTranscribeProviderProfile("groq", groq) as {
      transcribeMode: string; requiresKey: boolean; streamProtocol?: string;
    };
    expect(profile.transcribeMode).toBe("segmented");
    expect(profile.requiresKey).toBe(true);
    expect(profile.streamProtocol).toBeUndefined();
  });
});

describe("AI 整理目录", () => {
  it("新用户的选择器：OpenAI、Claude、Gemini、OpenRouter、DeepSeek、百炼、硅基流动、本地/自定义", () => {
    const s = fresh();
    s.llmServicePreset = "openai";
    s.llmEndpoint = "https://api.openai.com/v1";
    expect(ids(listLlmServices(s))).toEqual(["openai", "anthropic", "gemini-openai", "openrouter", "deepseek", "dashscope", "siliconflow", "local"]);
  });

  it("四个本地/网关预设合并为一项，自建网关（无匹配预设）也归入它", () => {
    for (const preset of ["ollama", "lmstudio", "local-openai-compatible"]) {
      const endpoint = (getLlmServicePreset(preset) as { endpoint: string }).endpoint;
      expect(currentLlmServiceId({ llmEndpoint: endpoint, llmServicePreset: preset })).toBe("local");
    }
    expect(currentLlmServiceId({ llmEndpoint: "http://192.168.1.9:8000/v1", llmServicePreset: "" })).toBe("local");
    expect(currentLlmServiceId({ llmEndpoint: "https://relay.example.com/v1", llmServicePreset: "openai-compatible-gateway" })).toBe("local");
  });

  it("当前服务已隐藏时作为旧服务出现，隐藏预设仍可解析", () => {
    const poe = getLlmServicePreset("poe") as { endpoint: string };
    const settings = { llmEndpoint: poe.endpoint, llmServicePreset: "poe" };
    const list = listLlmServices(settings);
    expect(ids(list)).toContain("poe");
    const legacy = list.find((item) => item.id === "poe");
    expect(legacy?.legacy).toBe(true);
    expect(legacy?.label).toContain("Legacy (still works)");
    expect(currentLlmServiceId(settings)).toBe("poe");
    for (const hidden of ["poe", "moonshot", "mimo", "zhipu", "volcengine", "hunyuan", "xai", "groq", "mistral", "perplexity"]) {
      expect(getLlmServicePreset(hidden), hidden).toBeTruthy();
    }
  });

  it("Claude 预设使用兼容接口地址", () => {
    expect((getLlmServicePreset("anthropic") as { endpoint: string }).endpoint).toBe("https://api.anthropic.com/v1");
  });
});

describe("当前服务名称（首页使用状态与 API 页一致）", () => {
  it("录音转写：custom 显示为目录名「本地 / 自定义」，而不是服务配置里的英文名", () => {
    const s = fresh();
    s.activeTranscribeProvider = "custom";
    expect(currentRecordingServiceLabel(s)).toBe("Local / custom (OpenAI-compatible)");
    s.activeTranscribeProvider = "apimimo";
    expect(currentRecordingServiceLabel(s)).toContain("Legacy (still works)");
  });

  it("AI 整理：与选择器里当前项的名称相同", () => {
    const settings = { llmEndpoint: "https://api.openai.com/v1", llmServicePreset: "openai" };
    const current = listLlmServices(settings).find((item) => item.id === currentLlmServiceId(settings));
    expect(currentLlmServiceLabel(settings)).toBe(current?.label);
    expect(currentLlmServiceLabel({ llmEndpoint: "http://192.168.1.9:8000/v1", llmServicePreset: "" })).toBe("Local / custom (OpenAI-compatible)");
  });
});

describe("快速配置清单", () => {
  it("只列百炼与 OpenAI；默认项按界面语言", () => {
    expect(ids(listQuickSetupProviders())).toEqual(["bailian", "openai"]);
    expect(defaultQuickSetupProviderId("zh")).toBe("bailian");
    expect(defaultQuickSetupProviderId("en")).toBe("openai");
  });
});
