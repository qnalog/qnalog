import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (p: string) => String(p || "").replace(/\/+/g, "/"), TFile: class {}, TFolder: class {}, requestUrl: vi.fn(), Platform: { isMobile: false, isMobileApp: false } }));
vi.mock("../src/shared/settings-runtime-deps", async () => {
  const cfg = await import("../src/llm/config");
  return {
    normalizeAsrConcurrency: (value: unknown) => Math.max(1, Math.min(3, Math.floor(Number(value)) || 1)),
    normalizeLlmProfiles: cfg.normalizeLlmProfiles,
    normalizePeopleContextMode: (value: unknown) => (value === "hotwords" || value === "localFull" ? value : "privacy"),
    normalizePeopleSuggestionIgnores: (value: unknown) => (Array.isArray(value) ? value : []),
    normalizePeopleSuggestionCache: (value: unknown) => (value && typeof value === "object" && "pending" in value ? value : { pending: [] }),
    isCustomPromptModeTemplate: () => false,
    normalizeKnowledgeExtractionHistory: (value: unknown) => (value && typeof value === "object" && "vocabulary" in value && "people" in value ? value : { vocabulary: {}, people: {} }),
  };
});
import { normalizePluginSettings, serializePluginSettings } from "../src/shared/settings-io";
import { restoreApiKeySecrets, storeApiKeySecrets, type ApiKeySecretStorage } from "../src/shared/api-key-storage";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { buildLlmHeaders, isAnthropicApiEndpoint } from "../src/shared/util-llm-endpoint";
import { currentLlmServiceId, currentRecordingServiceId, listLlmServices, listRecordingServices } from "../src/setup/service-catalog";
import { requestLlmChatCompletion } from "../src/llm/core";
import { switchLlmService } from "../src/setup/llm-service-switch";

const NAMESPACE = "0123456789abcdef0123456789abcdef";

function memoryStorage(): ApiKeySecretStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getSecret: (id) => (data.has(id) ? (data.get(id) as string) : null),
    listSecrets: () => Array.from(data.keys()),
    setSecret: (id, secret) => { data.set(id, secret); },
  };
}

/** 一位现有用户：局域网自建转写服务、百炼整理、一个已保存方案、都带密钥。 */
function existingUserData() {
  return {
    schemaVersion: 1,
    speech: {
      activeProviderId: "custom",
      importProviderId: "dashscope-filetrans",
      providers: {
        custom: { name: "Other transcription services", endpoint: "http://192.168.1.20:9000/v1/audio/transcriptions", apiKey: "lan-key", model: "sensevoice-small", language: "zh" },
        apimimo: { endpoint: "https://api.xiaomimimo.com/v1/chat/completions", apiKey: "mimo-key", model: "mimo-v2.5-asr", language: "auto" },
        "dashscope-filetrans": { endpoint: "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription", apiKey: "bl-key", model: "qwen-audio-3.1-asr-flash-filetrans", language: "zh" },
      },
    },
    composer: {
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "bl-llm-key",
      model: "qwen-plus",
      servicePreset: "dashscope",
      profiles: [{ id: "llm-1", name: "My plan", endpoint: "https://api.deepseek.com", apiKey: "ds-key", model: "deepseek-chat" }],
      activeProfile: "",
    },
  };
}

describe("已有用户的设置在新目录下原样保留", () => {
  it("读回后服务选择器显示正确的当前值，没有任何配置被改写", () => {
    const s = normalizePluginSettings(existingUserData());
    expect(s.activeTranscribeProvider).toBe("custom");
    expect(currentRecordingServiceId(s)).toBe("custom");
    expect(s.transcribeProviders.custom).toMatchObject({ endpoint: "http://192.168.1.20:9000/v1/audio/transcriptions", apiKey: "lan-key", model: "sensevoice-small", language: "zh" });
    expect(s.transcribeProviders.apimimo.apiKey).toBe("mimo-key");
    expect(s.importTranscribeProvider).toBe("dashscope-filetrans");
    expect(currentLlmServiceId(s)).toBe("dashscope");
    expect(s).toMatchObject({ llmApiKey: "bl-llm-key", llmModel: "qwen-plus", llmServicePreset: "dashscope" });
    expect(s.llmProfiles).toHaveLength(1);
    expect(s.llmProfiles[0]).toMatchObject({ id: "llm-1", apiKey: "ds-key" });
    expect(s.llmServiceMemory).toEqual({});
    expect(listRecordingServices(s).some((item) => item.legacy)).toBe(false);
    expect(listLlmServices(s).some((item) => item.legacy)).toBe(false);
  });

  it("用户正在用隐藏的服务时仍是当前值，并标为旧服务", () => {
    const data = existingUserData();
    data.speech.activeProviderId = "apimimo";
    const s = normalizePluginSettings(data);
    expect(currentRecordingServiceId(s)).toBe("apimimo");
    expect(listRecordingServices(s).find((item) => item.id === "apimimo")?.legacy).toBe(true);
    expect(s.transcribeProviders.apimimo.apiKey).toBe("mimo-key");
  });

  it("写盘再读回：全部密钥与配置仍在，各服务记忆也一起存取", () => {
    const s = normalizePluginSettings(existingUserData());
    Object.assign(s, switchLlmService(s, "openai"));
    s.llmApiKey = "sk-openai";

    const serialized = serializePluginSettings(s);
    const storage = memoryStorage();
    storeApiKeySecrets(serialized, storage, NAMESPACE);
    // 落盘快照里没有任何明文密钥，包括服务记忆里的
    expect(JSON.stringify(serialized)).not.toMatch(/bl-llm-key|sk-openai|lan-key|ds-key/);
    expect(Array.from(storage.data.values())).toEqual(expect.arrayContaining(["bl-llm-key", "sk-openai", "lan-key", "ds-key"]));

    const reread = JSON.parse(JSON.stringify(serialized));
    restoreApiKeySecrets(reread, storage, NAMESPACE, true);
    const back = normalizePluginSettings(reread);
    expect(back.llmServiceMemory.dashscope).toMatchObject({ apiKey: "bl-llm-key", model: "qwen-plus" });
    expect(back.llmApiKey).toBe("sk-openai");
    expect(back.transcribeProviders.custom.apiKey).toBe("lan-key");
    expect(back.llmProfiles[0].apiKey).toBe("ds-key");

    // 切回百炼：整理配置完整恢复
    Object.assign(back, switchLlmService(back, "dashscope"));
    expect(back).toMatchObject({ llmApiKey: "bl-llm-key", llmModel: "qwen-plus", llmServicePreset: "dashscope" });
  });
});

describe("Anthropic 兼容接口的请求", () => {
  it("识别官方地址，密钥用 Bearer 头发送", () => {
    expect(isAnthropicApiEndpoint("https://api.anthropic.com/v1")).toBe(true);
    expect(isAnthropicApiEndpoint("https://api.openai.com/v1")).toBe(false);
    expect(buildLlmHeaders("sk-ant", "https://api.anthropic.com/v1").Authorization).toBe("Bearer sk-ant");
  });
});

describe("请求体按服务调整", () => {
  async function sentBody(endpoint: string): Promise<Record<string, unknown>> {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }),
      _body: init.body,
    }));
    vi.stubGlobal("window", { fetch: fetchMock, setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) });
    try {
      await requestLlmChatCompletion({ settings: { llmEndpoint: endpoint, llmApiKey: "k", llmModel: "m", thinkingMode: "auto" } }, [{ role: "user", content: "hi" }], { stream: false });
      return JSON.parse(fetchMock.mock.calls[0][1].body) as Record<string, unknown>;
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("Anthropic 兼容接口不带 temperature（新模型对小于 1 的值返回 400），其它服务保持 0.3", async () => {
    expect(await sentBody("https://api.anthropic.com/v1")).not.toHaveProperty("temperature");
    expect((await sentBody("https://api.openai.com/v1")).temperature).toBe(0.3);
  });
});

describe("默认设置", () => {
  it("新增 llmServiceMemory 默认空表，不需要升级设置版本", () => {
    expect(DEFAULT_SETTINGS.llmServiceMemory).toEqual({});
  });
});
