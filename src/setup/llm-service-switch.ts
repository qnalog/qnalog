// AI 整理：按服务记忆配置。
//
// 工作配置仍是 llmEndpoint / llmApiKey / llmModel / llmServicePreset，调用大模型的代码只读这几项。
// llmServiceMemory 存放「不是当前服务」的其它服务上次使用的配置：
//   切换服务时，当前工作配置先存到旧服务名下；目标服务有记忆就恢复，没有就用预设默认值（密钥为空）。
// 当前服务不在 llmServiceMemory 里保留副本，保证每个服务只有一处存放（MAINTAINING §9.2）。
// 本模块不碰 llmProfiles，也不写盘；调用方把返回值 Object.assign 到设置后自行保存。
// 密钥随 llmServiceMemory 序列化，走和其它 apiKey 字段相同的 SecretStorage 路径（src/shared/api-key-storage.ts）。

import type { LlmServiceMemoryEntry, PluginSettings } from "../shared/types";
import { inferLlmServicePresetId, getLlmServicePreset } from "../llm/config";
import { currentLlmServiceId, getLlmServiceDef } from "./service-catalog";

export type LlmServiceSwitchInput = Pick<
  PluginSettings,
  "llmEndpoint" | "llmApiKey" | "llmModel" | "llmServicePreset" | "llmServiceMemory" | "transcribeProviders"
>;

export type LlmServiceSwitchResult = Pick<
  PluginSettings,
  "llmEndpoint" | "llmApiKey" | "llmModel" | "llmServicePreset" | "llmServiceMemory" | "activeLlmProfile"
>;

/** 把当前工作配置记到当前服务名下，返回新的记忆表；三项都为空时不记。 */
export function rememberWorkingLlmConfig(settings: LlmServiceSwitchInput): Record<string, LlmServiceMemoryEntry> {
  const memory: Record<string, LlmServiceMemoryEntry> = { ...(settings.llmServiceMemory || {}) };
  const entry: LlmServiceMemoryEntry = {
    endpoint: String(settings.llmEndpoint || "").trim(),
    apiKey: String(settings.llmApiKey || ""),
    model: String(settings.llmModel || "").trim(),
  };
  if (!entry.endpoint && !entry.apiKey && !entry.model) return memory;
  memory[currentLlmServiceId(settings)] = entry;
  return memory;
}

/**
 * 切换 AI 整理服务，返回要写入设置的字段；目标服务就是当前服务或无法识别时返回 null。
 *
 * activeLlmProfile 置空：工作配置不再等于那套已保存方案，留着指针会让之后的编辑回写并覆盖该方案。
 * llmProfiles 数组本身不变。
 */
export function switchLlmService(settings: LlmServiceSwitchInput, targetId: string): LlmServiceSwitchResult | null {
  const def = getLlmServiceDef(targetId);
  if (!def || def.id === currentLlmServiceId(settings)) return null;

  const memory = rememberWorkingLlmConfig(settings);
  const remembered = memory[def.id];
  delete memory[def.id];

  let endpoint: string;
  let apiKey: string;
  let model: string;
  let presetId: string;

  if (remembered) {
    endpoint = remembered.endpoint;
    apiKey = remembered.apiKey;
    model = remembered.model;
    const inferred = String(inferLlmServicePresetId({ llmEndpoint: endpoint }) || "");
    presetId = def.presetIds.includes(inferred) ? inferred : (def.id === "local" ? "" : def.defaultPresetId);
  } else {
    const preset = getLlmServicePreset(def.defaultPresetId) as { endpoint?: string } | null;
    endpoint = String((preset && preset.endpoint) || "");
    apiKey = "";
    model = def.defaultModel();
    presetId = def.defaultPresetId;
  }

  // 硅基流动的转写与整理常用同一把密钥：整理没有记忆密钥时沿用已保存的转写密钥。
  if (def.id === "siliconflow" && !apiKey) {
    apiKey = String(((settings.transcribeProviders || {}).siliconflow || {}).apiKey || "");
  }

  return {
    llmEndpoint: endpoint,
    llmApiKey: apiKey,
    llmModel: model,
    llmServicePreset: presetId,
    llmServiceMemory: memory,
    activeLlmProfile: "",
  };
}
