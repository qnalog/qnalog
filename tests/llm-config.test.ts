import { describe, expect, it } from "vitest";
import {
  ONE_CARD_PROVIDERS,
  getBriefingMergeDesiredTokens,
  getBriefingMergeMaxTokens,
  getLlmOutputCeiling,
  inferLlmServicePresetId,
  isDashscopeCompatibleLlmEndpoint,
} from "../src/llm/config";

describe("LLM 服务预设", () => {
  it("百炼一站式预设内置三段服务与全部模型", () => {
    // 首次配置的主路径：只填密钥。因此地址与三个模型必须都写在预设里，
    // 界面上不该再出现需要用户选择的模型项（见 MAINTAINING §10.6）。
    expect(ONE_CARD_PROVIDERS.bailian).toMatchObject({
      scope: "asr-llm",
      // 录音转写走实时流式
      asrProvider: "dashscope",
      asrTarget: "recording",
      asrModel: "qwen-audio-3.0-asr-flash-streaming",
      asrEndpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      // 导入音频走整文件 + 说话人分离
      importAsrProvider: "dashscope-filetrans",
      importAsrModel: "qwen-audio-3.0-asr-flash-filetrans",
      // AI 整理
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
