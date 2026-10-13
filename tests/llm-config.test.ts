import { describe, expect, it } from "vitest";
import {
  ONE_CARD_PROVIDERS,
  applyLlmProfileToWorkingConfig,
  applyLlmServicePresetToWorkingConfig,
  getBriefingMergeDesiredTokens,
  getBriefingMergeMaxTokens,
  getLlmServicePreset,
  getLlmOutputCeiling,
  inferLlmServicePresetId,
  isDashscopeCompatibleLlmEndpoint,
  syncWorkingConfigToLlmProfile,
} from "../src/llm/config";

describe("服务预设与 API 方案密钥隔离（回归期望）", () => {
  function settingsWithTwoProfiles() {
    const settings = {
      llmProfiles: [
        { id: "profile-a", name: "方案 A", endpoint: "https://service-a.example/v1", apiKey: "fake-key-service-a", model: "model-a" },
        { id: "profile-b", name: "方案 B", endpoint: "https://service-b.example/v1", apiKey: "fake-key-service-b", model: "model-b" },
      ],
      activeLlmProfile: "profile-a",
      llmServicePreset: "custom",
      llmEndpoint: "",
      llmApiKey: "",
      llmModel: "",
      transcribeProviders: { siliconflow: { apiKey: "" } },
    };
    applyLlmProfileToWorkingConfig(settings, "profile-a");
    return settings;
  }

  it("更换服务预设并输入新密钥时，不会覆盖原活动方案或把旧密钥配给新地址", () => {
    const settings = settingsWithTwoProfiles();
    const profileA = { ...settings.llmProfiles[0] };

    Object.assign(settings, applyLlmServicePresetToWorkingConfig(settings, "openrouter"));

    // 模拟用户随后在设置页修改密钥；activeLlmProfile 为空时同步函数不会找到方案。
    settings.llmApiKey = "fake-key-new-service";
    syncWorkingConfigToLlmProfile(settings, settings.activeLlmProfile);

    // 期望：编辑临时服务时不覆盖仍选中的方案 A。
    expect(settings.llmProfiles[0]).toEqual(profileA);
  });

  it("只切换服务预设后，请求配置不会把原服务密钥与新地址组合", () => {
    const settings = settingsWithTwoProfiles();

    Object.assign(settings, applyLlmServicePresetToWorkingConfig(settings, "openrouter"));

    // 网络请求从这两个工作字段读取配置；这里断言其组合，不发起网络请求。
    expect(settings.llmApiKey).not.toBe(settings.llmProfiles[0].apiKey);
  });

  it("切换预设时保留已保存方案，且工作配置进入临时服务状态", () => {
    const settings = settingsWithTwoProfiles();
    const savedProfiles = settings.llmProfiles.map(profile => ({ ...profile }));

    Object.assign(settings, applyLlmServicePresetToWorkingConfig(settings, "openrouter"));

    expect(settings.llmProfiles).toEqual(savedProfiles);
    expect(settings.activeLlmProfile).toBe("");
    expect(settings.llmEndpoint).toBe(getLlmServicePreset("openrouter")?.endpoint);
    expect(settings.llmApiKey).toBe("");
  });

  it("临时服务输入新密钥后再选方案 A，会恢复方案 A 的地址、密钥和模型", () => {
    const settings = settingsWithTwoProfiles();
    const profileA = { ...settings.llmProfiles[0] };

    Object.assign(settings, applyLlmServicePresetToWorkingConfig(settings, "openrouter"));
    settings.llmApiKey = "fake-key-new-service";
    syncWorkingConfigToLlmProfile(settings, settings.activeLlmProfile);
    expect(settings.llmProfiles[0]).toEqual(profileA);

    expect(applyLlmProfileToWorkingConfig(settings, "profile-a")).toBe(true);
    expect(settings).toMatchObject({
      activeLlmProfile: "profile-a",
      llmEndpoint: profileA.endpoint,
      llmApiKey: profileA.apiKey,
      llmModel: profileA.model,
    });
  });

  it("SiliconFlow 预设只复用已保存的硅基流动转写密钥", () => {
    const settings = settingsWithTwoProfiles();
    settings.transcribeProviders.siliconflow = { apiKey: "fake-key-siliconflow-asr" };

    const update = applyLlmServicePresetToWorkingConfig(settings, "siliconflow");

    expect(update.llmApiKey).toBe("fake-key-siliconflow-asr");
    expect(settings.llmProfiles[0].apiKey).toBe("fake-key-service-a");
  });
});

describe("LLM 服务预设", () => {
  it("百炼一站式预设内置三段服务与全部模型", () => {
    // 首次配置的主路径：只填密钥。因此地址与三个模型必须都写在预设里，
    // 界面上不该再出现需要用户选择的模型项（见 MAINTAINING §11.1）。
    expect(ONE_CARD_PROVIDERS.bailian).toMatchObject({
      scope: "asr-llm",
      asrProvider: "dashscope-flash",
      asrTarget: "recording",
      asrModel: "qwen-audio-3.1-asr-flash",
      asrEndpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      importAsrProvider: "dashscope-filetrans",
      importAsrModel: "qwen-audio-3.1-asr-flash-filetrans",
      llmPreset: "dashscope",
      llmEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      llmModel: "qwen3.8-flash",
    });
  });

  it("识别默认地址和业务空间地址为百炼服务", () => {
    const workspaceEndpoint = "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
    expect(isDashscopeCompatibleLlmEndpoint(workspaceEndpoint)).toBe(true);
    expect(inferLlmServicePresetId({ llmEndpoint: workspaceEndpoint })).toBe("dashscope");
    expect(inferLlmServicePresetId({ llmEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1" })).toBe("dashscope");
  });

  it("快速配置只列三家：MiMo、百炼、OpenRouter", () => {
    // 下拉按注册表顺序渲染（settings-tab 的 Object.entries 循环），成员与顺序就是用户看到的列表。
    // 硅基流动已退出：有合适的语音模型，但大语言模型价格偏高，不进快捷配置（2026-09-23 维护者决定）。
    expect(Object.keys(ONE_CARD_PROVIDERS)).toEqual(["mimo", "bailian", "openrouter"]);
  });
  it("restores Bailian routing from the selected model instead of the provider default", () => {
    const settings = {
      llmProfiles: [{
        id: "saved",
        endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        asr: {
          providerId: "dashscope-flash",
          endpoint: "https://cn-shanghai.example/proxy/api/v1/services/aigc/multimodal-generation/generation",
          apiKey: "saved-key",
          model: "paraformer-realtime-v2",
          language: "zh",
          protocol: "dashscope-ws",
        },
      }],
      activeLlmProfile: "",
      activeTranscribeProvider: "",
      transcribeProviders: { "dashscope-flash": { protocol: "dashscope-flash-input-audio" } },
    };
    expect(applyLlmProfileToWorkingConfig(settings, "saved")).toBe(true);
    expect(settings.transcribeProviders["dashscope-flash"]).toMatchObject({
      endpoint: "wss://cn-shanghai.example/proxy/api-ws/v1/inference",
      apiKey: "saved-key",
      model: "paraformer-realtime-v2",
      language: "zh",
      protocol: "dashscope-ws",
    });
  });
});

describe("LLM 输出预算策略", () => {
  it("新模型和未知模型不再继承历史 8K 默认上限", () => {
    const stats = { durationMs: 3 * 60 * 60 * 1000, transcriptChars: 120000, segmentCount: 48 };
    const desired = getBriefingMergeDesiredTokens(stats);

    expect(desired).toBeGreaterThan(32000);
    expect(getLlmOutputCeiling({ llmModel: "mimo-v2.5-pro" })).toBe(0);
    expect(getLlmOutputCeiling({ llmModel: "custom-gateway-model" })).toBe(0);
    expect(getBriefingMergeMaxTokens(stats, { llmModel: "custom-gateway-model" })).toBe(desired);
    expect(getBriefingMergeMaxTokens(stats)).toBe(desired);
  });

  it("不再根据模型名称猜测输出上限", () => {
    expect(getLlmOutputCeiling({ llmModel: "deepseek-chat" })).toBe(0);
    expect(getLlmOutputCeiling({ llmModel: "deepseek-v4-pro" })).toBe(0);
    expect(getLlmOutputCeiling({ llmModel: "gpt-4" })).toBe(0);
  });

  it("超长材料的目标预算不再被 384K 全局截断", () => {
    const stats = { durationMs: 30 * 60 * 60 * 1000, transcriptChars: 1000000, segmentCount: 360 };
    expect(getBriefingMergeDesiredTokens(stats)).toBe(500000);
    expect(getBriefingMergeMaxTokens(stats)).toBe(500000);
  });

  it("异常统计值不会生成无限预算", () => {
    expect(getBriefingMergeDesiredTokens({ durationMs: Infinity, transcriptChars: NaN, segmentCount: Infinity })).toBe(4096);
  });
});
