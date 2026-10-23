import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (p: string) => String(p || ""), TFile: class {}, TFolder: class {} }));
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { PluginSettings } from "../src/shared/types";
import { rememberWorkingLlmConfig, switchLlmService } from "../src/setup/llm-service-switch";
import { currentLlmServiceId } from "../src/setup/service-catalog";
import { normalizeLlmServiceMemory } from "../src/shared/llm-service-memory";

function fresh(): PluginSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as PluginSettings;
}

function apply(settings: PluginSettings, target: string): void {
  const update = switchLlmService(settings, target);
  if (update) Object.assign(settings, update);
}

function onOpenAi(): PluginSettings {
  const s = fresh();
  s.llmServicePreset = "openai";
  s.llmEndpoint = "https://api.openai.com/v1";
  s.llmApiKey = "sk-openai";
  s.llmModel = "gpt-4.1-mini";
  return s;
}

describe("AI 整理按服务记忆配置", () => {
  it("来回切换恢复各自的地址、密钥和模型", () => {
    const s = onOpenAi();
    apply(s, "dashscope");
    expect(s.llmApiKey).toBe("");
    s.llmApiKey = "sk-bailian";
    s.llmModel = "qwen3.8-flash";
    apply(s, "openai");
    expect(s).toMatchObject({ llmEndpoint: "https://api.openai.com/v1", llmApiKey: "sk-openai", llmModel: "gpt-4.1-mini", llmServicePreset: "openai" });
    apply(s, "dashscope");
    expect(s).toMatchObject({ llmApiKey: "sk-bailian", llmModel: "qwen3.8-flash", llmServicePreset: "dashscope" });
    expect(s.llmEndpoint).toContain("dashscope.aliyuncs.com");
  });

  it("没用过的服务得到预设默认值和空密钥", () => {
    const s = onOpenAi();
    apply(s, "anthropic");
    expect(s).toMatchObject({ llmEndpoint: "https://api.anthropic.com/v1", llmApiKey: "", llmModel: "claude-sonnet-5-5", llmServicePreset: "anthropic" });
    apply(s, "deepseek");
    expect(s).toMatchObject({ llmEndpoint: "https://api.deepseek.com", llmApiKey: "", llmModel: "" });
  });

  it("切换前，当前工作配置存到旧服务名下；当前服务不留副本", () => {
    const s = onOpenAi();
    apply(s, "anthropic");
    expect(s.llmServiceMemory.openai).toEqual({ endpoint: "https://api.openai.com/v1", apiKey: "sk-openai", model: "gpt-4.1-mini" });
    expect(s.llmServiceMemory.anthropic).toBeUndefined();
    apply(s, "openai");
    expect(s.llmServiceMemory.openai).toBeUndefined();
    expect(s.llmServiceMemory.anthropic).toBeDefined();
  });

  it("不改 llmProfiles；activeLlmProfile 置空，避免之后的编辑回写并覆盖已保存方案", () => {
    const s = onOpenAi();
    s.llmProfiles = [{ id: "p1", name: "mine", endpoint: "https://api.openai.com/v1", apiKey: "sk-openai", model: "gpt-4.1-mini" }];
    s.activeLlmProfile = "p1";
    const before = JSON.stringify(s.llmProfiles);
    apply(s, "dashscope");
    expect(JSON.stringify(s.llmProfiles)).toBe(before);
    expect(s.activeLlmProfile).toBe("");
  });

  it("目标就是当前服务或无法识别时不返回改动", () => {
    const s = onOpenAi();
    expect(switchLlmService(s, "openai")).toBeNull();
    expect(switchLlmService(s, "no-such-service")).toBeNull();
  });

  it("本地/自定义：自定义局域网地址随记忆恢复，仍归入同一项", () => {
    const s = onOpenAi();
    apply(s, "local");
    expect(s.llmEndpoint).toBe("http://127.0.0.1:11434/v1");
    s.llmEndpoint = "http://192.168.1.50:8000/v1";
    s.llmModel = "qwen2.5";
    s.llmServicePreset = "";
    apply(s, "openai");
    apply(s, "local");
    expect(s).toMatchObject({ llmEndpoint: "http://192.168.1.50:8000/v1", llmModel: "qwen2.5", llmServicePreset: "" });
    expect(currentLlmServiceId(s)).toBe("local");
  });

  it("硅基流动没有记忆时沿用已保存的转写密钥", () => {
    const s = onOpenAi();
    s.transcribeProviders.siliconflow.apiKey = "sk-sf-asr";
    apply(s, "siliconflow");
    expect(s.llmApiKey).toBe("sk-sf-asr");
  });

  it("切到旧服务（隐藏预设）同样可用，且不丢当前配置", () => {
    const s = onOpenAi();
    apply(s, "poe");
    expect(s.llmServicePreset).toBe("poe");
    apply(s, "openai");
    expect(s.llmApiKey).toBe("sk-openai");
  });

  it("三项都为空的工作配置不写入记忆", () => {
    const s = fresh();
    s.llmEndpoint = "";
    s.llmApiKey = "";
    s.llmModel = "";
    expect(rememberWorkingLlmConfig(s)).toEqual({});
  });

  it("记忆表读回时清洗：丢弃非法 id 与非对象，字段补成字符串", () => {
    const parsed = normalizeLlmServiceMemory({
      openai: { endpoint: " https://x ", apiKey: "k", model: 3 },
      "__proto__": { endpoint: "a" },
      "bad id!": { endpoint: "a" },
      broken: "text",
    });
    expect(Object.keys(parsed)).toEqual(["openai"]);
    expect(parsed.openai).toEqual({ endpoint: "https://x", apiKey: "k", model: "" });
    expect(normalizeLlmServiceMemory(null)).toEqual({});
  });
});
