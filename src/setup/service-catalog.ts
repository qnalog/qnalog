// 服务目录：首页快速配置、配置向导、API 页三处共用的「可选服务」清单。
//
// 规则：
//   1. 新用户可选的服务只有这里列出的几项；其余服务的代码和已保存配置都保留；
//   2. 用户当前正在用的服务即使不在清单里，也会以「旧服务（仍可用）」出现在选择器里，不会被改写或清除；
//   3. 本模块只读设置、返回要写入的字段，不写盘；调用方负责保存。

import type { PluginSettings } from "../shared/types";
import { t } from "../shared/i18n";
import { ONE_CARD_PROVIDERS, getActiveLlmServicePresetId, getLlmServicePreset } from "../llm/config";
import { resolveBailianAsrRoute } from "../asr/bailian-asr-registry";

export interface CatalogService {
  /** 目录 id；旧服务条目使用它原本的 provider id / 预设 id。 */
  id: string;
  label: string;
  hint: string;
  /** 不在当前目录里、但用户正在使用的服务。 */
  legacy: boolean;
}

function legacyLabel(name: string): string {
  return `${name} (${t("Legacy (still works)")})`;
}

// ---------------------------------------------------------------- 录音转写

interface RecordingServiceDef {
  id: string;
  label: () => string;
  hint: () => string;
  /** 该目录项对应的已有 provider id；第一项以外的是同一服务按模型分出的路线。 */
  providerIds: string[];
  /** 从其它服务切换过来时选用的 provider id。 */
  defaultProviderId: string;
}

/**
 * 百炼只有一个目录项，具体路线由模型决定（src/asr/bailian-asr-registry.ts）：
 *   dashscope-flash  原生 HTTP 分段转写（新用户默认）
 *   dashscope-chat   旧版 Chat Completions 接口（qwen3-asr-flash）
 *   dashscope        WebSocket 流式（仅桌面端）
 * 存储结构不变：activeTranscribeProvider 仍是这三个 id 之一。
 */
const RECORDING_SERVICES: readonly RecordingServiceDef[] = [
  {
    id: "openai",
    label: () => "OpenAI",
    hint: () => t("gpt-transcribe. Needs access to the OpenAI API."),
    providerIds: ["openai"],
    defaultProviderId: "openai",
  },
  {
    id: "groq",
    label: () => "Groq",
    hint: () => t("Whisper models over an OpenAI-compatible upload."),
    providerIds: ["groq"],
    defaultProviderId: "groq",
  },
  {
    id: "bailian",
    label: () => t("Alibaba Cloud Bailian"),
    hint: () => t("The model you choose decides how audio is sent to Bailian."),
    providerIds: ["dashscope-flash", "dashscope-chat", "dashscope"],
    defaultProviderId: "dashscope-flash",
  },
  {
    id: "siliconflow",
    label: () => t("SiliconFlow"),
    hint: () => t("SenseVoice and other models; reachable from mainland China."),
    providerIds: ["siliconflow"],
    defaultProviderId: "siliconflow",
  },
  {
    id: "custom",
    label: () => t("Local / custom (OpenAI-compatible)"),
    hint: () => t("Your own server, such as whisper.cpp, faster-whisper or SenseVoice, or a gateway such as OpenRouter."),
    providerIds: ["custom", "local"],
    defaultProviderId: "custom",
  },
];

function activeRecordingProviderId(settings: Pick<PluginSettings, "activeTranscribeProvider">): string {
  return settings.activeTranscribeProvider || "siliconflow";
}

/** provider id 属于哪个目录项；不属于任何项返回 null（旧服务）。 */
export function recordingServiceIdForProvider(providerId: string): string | null {
  const def = RECORDING_SERVICES.find((item) => item.providerIds.includes(providerId));
  return def ? def.id : null;
}

/** 当前录音转写服务在选择器里对应的值：目录项 id，或旧服务的 provider id。 */
export function currentRecordingServiceId(settings: Pick<PluginSettings, "activeTranscribeProvider">): string {
  const providerId = activeRecordingProviderId(settings);
  return recordingServiceIdForProvider(providerId) || providerId;
}

/** 录音转写选择器的内容：目录项在前；当前服务不在目录里时追加一项旧服务。 */
export function listRecordingServices(
  settings: Pick<PluginSettings, "activeTranscribeProvider" | "transcribeProviders">,
): CatalogService[] {
  const list: CatalogService[] = RECORDING_SERVICES.map((def) => ({
    id: def.id,
    label: def.label(),
    hint: def.hint(),
    legacy: false,
  }));
  const providerId = activeRecordingProviderId(settings);
  if (!recordingServiceIdForProvider(providerId)) {
    const provider = (settings.transcribeProviders || {})[providerId];
    list.push({
      id: providerId,
      label: legacyLabel(t((provider && provider.name) || providerId)),
      hint: "",
      legacy: true,
    });
  }
  return list;
}

/** 当前录音转写服务在 API 页选择器里显示的名称；首页「使用状态」用同一个名称。 */
export function currentRecordingServiceLabel(
  settings: Pick<PluginSettings, "activeTranscribeProvider" | "transcribeProviders">,
): string {
  const id = currentRecordingServiceId(settings);
  const item = listRecordingServices(settings).find((service) => service.id === id);
  return item ? item.label : id;
}

/**
 * 选择某个录音转写服务应写入的字段（只有 activeTranscribeProvider，不改任何服务配置）。
 * 当前 provider 已属于该目录项时保持不变，避免把百炼的流式或旧版路线改回默认。
 */
export function selectRecordingService(
  settings: Pick<PluginSettings, "activeTranscribeProvider" | "transcribeProviders">,
  serviceId: string,
): Partial<Pick<PluginSettings, "activeTranscribeProvider">> {
  const def = RECORDING_SERVICES.find((item) => item.id === serviceId);
  if (def) {
    const current = activeRecordingProviderId(settings);
    return { activeTranscribeProvider: def.providerIds.includes(current) ? current : def.defaultProviderId };
  }
  if (serviceId && (settings.transcribeProviders || {})[serviceId]) return { activeTranscribeProvider: serviceId };
  return {};
}

/**
 * 百炼：按模型选录音转写的 provider id。
 * 分段 HTTP 模型 → dashscope-flash / dashscope-chat，流式模型 → dashscope；
 * 整文件模型（仅导入使用）和未登记的模型返回 null。
 */
export function bailianRecordingProviderIdForModel(model: string): string | null {
  const route = resolveBailianAsrRoute(model);
  if (!route) return null;
  if (route.transcribeMode === "streaming") return "dashscope";
  if (route.transcribeMode !== "segmented") return null;
  if (route.protocol === "dashscope-flash-input-audio") return "dashscope-flash";
  if (route.protocol === "dashscope-chat-input-audio") return "dashscope-chat";
  return null;
}

// ---------------------------------------------------------------- AI 整理

export interface LlmServiceDef {
  id: string;
  label: () => string;
  hint: () => string;
  /** 对应的 LLM_SERVICE_PRESETS id；多个 id 表示同一选项合并了它们。 */
  presetIds: string[];
  /** 从其它服务切换过来、没有记忆时写入的预设 id。 */
  defaultPresetId: string;
  /** 没有记忆时写入的模型；返回空串表示让用户自己填。写成函数是为了不在加载模块时读取预设表。 */
  defaultModel: () => string;
}

const LLM_SERVICES: readonly LlmServiceDef[] = [
  {
    id: "openai",
    label: () => "OpenAI",
    hint: () => t("Chat Completions on the OpenAI API."),
    presetIds: ["openai"],
    defaultPresetId: "openai",
    defaultModel: () => String(ONE_CARD_PROVIDERS.openai.llmModel),
  },
  {
    id: "anthropic",
    label: () => "Anthropic Claude",
    hint: () => t("Claude through Anthropic's OpenAI-compatible endpoint."),
    presetIds: ["anthropic"],
    defaultPresetId: "anthropic",
    defaultModel: () => "claude-sonnet-5-5",
  },
  {
    id: "gemini-openai",
    label: () => "Google Gemini",
    hint: () => t("Gemini through Google's OpenAI-compatible endpoint."),
    presetIds: ["gemini-openai"],
    defaultPresetId: "gemini-openai",
    defaultModel: () => "",
  },
  {
    id: "openrouter",
    label: () => "OpenRouter",
    hint: () => t("One key for models from many providers."),
    presetIds: ["openrouter"],
    defaultPresetId: "openrouter",
    defaultModel: () => String(ONE_CARD_PROVIDERS.openrouter.llmModel),
  },
  {
    id: "deepseek",
    label: () => "DeepSeek",
    hint: () => t("DeepSeek official API."),
    presetIds: ["deepseek"],
    defaultPresetId: "deepseek",
    defaultModel: () => "",
  },
  {
    id: "dashscope",
    label: () => t("Alibaba Cloud Bailian"),
    hint: () => t("Qwen and other models on Bailian."),
    presetIds: ["dashscope"],
    defaultPresetId: "dashscope",
    defaultModel: () => String(ONE_CARD_PROVIDERS.bailian.llmModel),
  },
  {
    id: "siliconflow",
    label: () => t("SiliconFlow"),
    hint: () => t("Open-source models; reachable from mainland China."),
    presetIds: ["siliconflow"],
    defaultPresetId: "siliconflow",
    defaultModel: () => "",
  },
  {
    id: "local",
    label: () => t("Local / custom (OpenAI-compatible)"),
    hint: () => t("Ollama, LM Studio, vLLM, or any OpenAI-compatible gateway or relay."),
    // 四个旧预设合并为一项；保存的 llmServicePreset 仍可是其中任意一个。
    presetIds: ["ollama", "lmstudio", "local-openai-compatible", "openai-compatible-gateway"],
    defaultPresetId: "ollama",
    defaultModel: () => "",
  },
];

/** 按目录 id 或（旧服务的）预设 id 取服务定义；旧服务按单独一项处理。 */
export function getLlmServiceDef(serviceId: string): LlmServiceDef | null {
  const listed = LLM_SERVICES.find((item) => item.id === serviceId);
  if (listed) return listed;
  const preset = getLlmServicePreset(serviceId) as { id: string; label: string } | null;
  if (!preset) return null;
  return {
    id: preset.id,
    label: () => preset.label,
    hint: () => "",
    presetIds: [preset.id],
    defaultPresetId: preset.id,
    defaultModel: () => "",
  };
}

/** 保存的预设 id 属于哪个目录项；不属于任何项返回 null（旧服务）。 */
export function llmServiceIdForPreset(presetId: string): string | null {
  const def = LLM_SERVICES.find((item) => item.presetIds.includes(presetId));
  return def ? def.id : null;
}

/**
 * 当前 AI 整理服务在选择器里对应的值。
 * 地址不匹配任何预设（自建网关）归入「本地 / 自定义」；匹配到已隐藏的预设时返回该预设 id（旧服务）。
 */
export function currentLlmServiceId(
  settings: Pick<PluginSettings, "llmEndpoint" | "llmServicePreset">,
): string {
  const presetId = String(getActiveLlmServicePresetId(settings) || "");
  if (!presetId) return "local";
  return llmServiceIdForPreset(presetId) || presetId;
}

/** AI 整理选择器的内容：目录项在前；当前服务不在目录里时追加一项旧服务。 */
export function listLlmServices(
  settings: Pick<PluginSettings, "llmEndpoint" | "llmServicePreset">,
): CatalogService[] {
  const list: CatalogService[] = LLM_SERVICES.map((def) => ({
    id: def.id,
    label: def.label(),
    hint: def.hint(),
    legacy: false,
  }));
  const currentId = currentLlmServiceId(settings);
  if (!LLM_SERVICES.some((def) => def.id === currentId)) {
    const preset = getLlmServicePreset(currentId) as { label: string } | null;
    list.push({ id: currentId, label: legacyLabel(preset ? preset.label : currentId), hint: "", legacy: true });
  }
  return list;
}

/** 当前 AI 整理服务在 API 页选择器里显示的名称。 */
export function currentLlmServiceLabel(
  settings: Pick<PluginSettings, "llmEndpoint" | "llmServicePreset">,
): string {
  const id = currentLlmServiceId(settings);
  const item = listLlmServices(settings).find((service) => service.id === id);
  return item ? item.label : id;
}

// ---------------------------------------------------------------- 快速配置

/** 首页快速配置与向导的一站式方案：一把密钥配好录音转写与 AI 整理。 */
export const QUICK_SETUP_PROVIDER_IDS: readonly string[] = ["bailian", "openai"];

export interface QuickSetupProvider {
  id: string;
  label: string;
  applyDesc: string;
}

export function listQuickSetupProviders(): QuickSetupProvider[] {
  const registry = ONE_CARD_PROVIDERS as Record<string, { label?: string; applyDesc?: string }>;
  return QUICK_SETUP_PROVIDER_IDS.filter((id) => !!registry[id]).map((id) => ({
    id,
    label: registry[id].label || id,
    applyDesc: registry[id].applyDesc || "",
  }));
}

/** 快速配置的默认项：中文界面默认百炼，其余默认 OpenAI；用户可在下拉里改。 */
export function defaultQuickSetupProviderId(uiLanguageId: string): string {
  return uiLanguageId === "en" ? "openai" : "bailian";
}
