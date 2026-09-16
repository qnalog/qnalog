import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  requestUrl: async () => ({ json: {} }),
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
}));
vi.mock("obsidian", () => ({ requestUrl: async () => ({ json: {} }), normalizePath: (p: string) => String(p||""), TFile: class {}, TFolder: class {} }));
import { isSpeakerDiarizationProvider, isImportCapableTranscribeProvider } from "../src/asr/diarization";
import { isOpenRouterDiarizeProvider } from "../src/asr/openrouter-diarize";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";

describe("OpenRouter 说话人分离识别", () => {
  const p = (DEFAULT_SETTINGS.transcribeProviders as any)["openrouter-diarize"];
  it("该 provider 被判为可做说话人分离、可用于导入音频", () => {
    expect(isOpenRouterDiarizeProvider(p)).toBe(true);
    expect(isSpeakerDiarizationProvider(p)).toBe(true);
    // 导入音频的选项由服务能力决定，不是 id 白名单
    expect(isImportCapableTranscribeProvider(null, p)).toBe(true);
  });
  it("普通 openrouter 转写不因新协议被误判", () => {
    const plain = (DEFAULT_SETTINGS.transcribeProviders as any)["openrouter"];
    expect(isOpenRouterDiarizeProvider(plain)).toBe(false);
    expect(isSpeakerDiarizationProvider(plain)).toBe(false);
  });
});

import { planPresetApplication } from "../src/setup";

describe("OpenRouter 一站式预设", () => {
  it("一把密钥配好三段：录音转写、导入音频（说话人分离）、AI 整理", () => {
    const S = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    const plan = planPresetApplication(S, { providerId: "openrouter", apiKey: "sk-or-test" });
    expect(plan.ok).toBe(true);
    expect(plan.asrProviderId).toBe("openrouter");
    expect(plan.importAsrProviderId).toBe("openrouter-diarize");
    const tp = plan.changes.transcribeProviders as any;
    expect(tp.openrouter.model).toBe("qwen/qwen3-asr-1.7b");
    expect(tp["openrouter-diarize"].model).toBe("microsoft/mai-transcribe-2");
    expect(tp["openrouter-diarize"].protocol).toBe("openrouter-diarize");
    expect(plan.changes.llmModel).toBe("qwen/qwen3.8-flash");
    expect(plan.changes.llmEndpoint).toBe("https://openrouter.ai/api/v1");
    // 两个 provider 共用同一把密钥
    expect(tp.openrouter.apiKey).toBe("sk-or-test");
    expect(tp["openrouter-diarize"].apiKey).toBe("sk-or-test");
  });
});

import { testOpenRouterDiarizeProvider } from "../src/asr/openrouter-diarize";

describe("OpenRouter 无音频检测", () => {
  it("密钥有效时返回有效；被拒时报错", async () => {
    (globalThis as any).window = { fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: { label: "sk-or-...abc" } }) }) };
    const ok = await testOpenRouterDiarizeProvider({ id: "openrouter-diarize", apiKey: "sk-x", model: "microsoft/mai-transcribe-2" });
    expect(ok.detail).toContain("valid");
    expect(ok.model).toBe("microsoft/mai-transcribe-2");

    (globalThis as any).window = { fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) };
    await expect(testOpenRouterDiarizeProvider({ id: "x", apiKey: "bad", model: "m" })).rejects.toThrow(/401/);

    (globalThis as any).window = { fetch: async () => ({ ok: false, status: 200, json: async () => ({}) }) };
    await expect(testOpenRouterDiarizeProvider({ id: "x", apiKey: "", model: "m" })).rejects.toThrow();
  });
});
