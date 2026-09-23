/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { comparableLlmEndpoint } from '../shared/util-llm-endpoint';

export const LLM_SERVICE_PRESETS = [
  {
    id: "siliconflow",
    label: "SiliconFlow",
    endpoint: DEFAULT_SETTINGS.llmEndpoint,
    endpointHelp: "SiliconFlow's LLM chat endpoint address. Usually you can keep the default; Q&A Log sends it as a Chat Completions request.",
    keyHelp: "Enter the access key created in the SiliconFlow console; if you also use SiliconFlow for speech transcription, you can reuse the same key.",
    modelPlaceholder: "Enter the model name from the SiliconFlow console",
    modelHelp: "Enter the full model identifier shown in the SiliconFlow model hub or console.",
  },
  {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    endpointHelp: "Official OpenAI API Base URL. Enter up to /v1; Q&A Log will append /chat/completions automatically.",
    keyHelp: "Enter the access key (API Key) for your OpenAI project.",
    modelPlaceholder: "Enter the OpenAI model name",
    modelHelp: "Enter a chat/completions model name supported by the OpenAI platform.",
  },
  {
    id: "poe",
    label: "Poe",
    endpoint: "https://api.poe.com/v1",
    endpointHelp: "Poe's OpenAI-compatible API Base URL; keep the default. A single Poe Key is enough to call Claude / GPT / Gemini and many other models.",
    keyHelp: "Enter your Poe access key (get it at poe.com/api_key). Note that Poe bills by points, and every request consumes points.",
    modelPlaceholder: "Click \"Fetch available models\" to select the Poe bot name",
    modelHelp: "Enter Poe's bot name, case-sensitive, exactly as returned in the Poe model list. Use \"Fetch available models\" below to select it directly and avoid typos that cause 404s.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    endpointHelp: "OpenRouter's OpenAI-compatible API Base URL. Q&A Log will automatically add the app-identification headers recommended by OpenRouter.",
    keyHelp: "Enter your OpenRouter access key (API Key). Different models may be billed by different upstream providers.",
    modelPlaceholder: "Enter a name from the OpenRouter model list, usually with a provider prefix",
    modelHelp: "Enter the full model ID from the OpenRouter model list, usually something like provider/model.",
  },
  {
    id: "moonshot",
    label: "Moonshot / Kimi",
    endpoint: "https://api.moonshot.cn/v1",
    endpointHelp: "Moonshot / Kimi API Base URL. Enter up to /v1; Q&A Log will append /chat/completions automatically.",
    keyHelp: "Enter the access key (API Key) created in the Moonshot console.",
    modelPlaceholder: "Enter the Kimi model name from the Moonshot console",
    modelHelp: "Enter a currently available Kimi model name from the Moonshot console.",
  },
  {
    id: "dashscope",
    label: "Alibaba Cloud Bailian / DashScope",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    endpointHelp: "Alibaba Cloud Bailian OpenAI-compatible address. You can use the default address, or paste the compatible-mode/v1 address provided by your workspace.",
    keyHelp: "Enter the access key (API Key) created in the Bailian console.",
    modelPlaceholder: "Fetch models, or enter the model name according to the Bailian console",
    modelHelp: "Enter a model name supported by the Bailian OpenAI-compatible endpoint; deployed models can be fetched directly through the workspace.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com",
    endpointHelp: "DeepSeek API Base URL. Enter the root address; Q&A Log will append /chat/completions automatically.",
    keyHelp: "Enter the access key (API Key) created on the DeepSeek platform.",
    modelPlaceholder: "Enter the model name from the DeepSeek console",
    modelHelp: "Enter a model name supported by the DeepSeek console.",
  },
  {
    id: "mimo",
    label: "Xiaomi MiMo",
    endpoint: "https://api.xiaomimimo.com/v1",
    altEndpoints: ["https://token-plan-cn.xiaomimimo.com/v1"],
    endpointHelp: "Xiaomi MiMo's OpenAI-compatible API Base URL. Enter up to /v1; Q&A Log will append /chat/completions automatically. It shares the same address and key as MiMo speech transcription.",
    keyHelp: "Enter the access key (API Key) for the Xiaomi MiMo platform. The same key works for both speech transcription (mimo-v2.5-asr) and AI summarization (mimo-v2.6-flash), with no need to apply for them separately.",
    modelPlaceholder: "mimo-v2.6-flash",
    modelHelp: "mimo-v2.6-flash (V2.6 series) is recommended; refer to the MiMo console's model list. Note that MiMo is a reasoning model: too small a max_tokens will be spent on thinking and leave the body empty, while the allowance used for meeting summaries is large enough to be unaffected.",
  },
  {
    id: "zhipu",
    label: "Zhipu GLM",
    endpoint: "https://open.bigmodel.cn/api/paas/v4",
    endpointHelp: "Zhipu Open Platform API Base URL. Enter up to /api/paas/v4.",
    keyHelp: "Enter your Zhipu Open Platform access key (API Key).",
    modelPlaceholder: "Enter the model name from the Zhipu Open Platform",
    modelHelp: "Enter a GLM model name supported by the Zhipu Open Platform.",
  },
  {
    id: "volcengine",
    label: "Volcano Ark",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    endpointHelp: "Volcano Ark OpenAI-compatible API Base URL. It may differ by region; refer to the Ark console.",
    keyHelp: "Enter your Volcano Ark access key (API Key).",
    modelPlaceholder: "Enter the Volcano Ark inference endpoint or model identifier",
    modelHelp: "Volcano Ark typically uses an inference endpoint ID or the model identifier given by the console.",
  },
  {
    id: "hunyuan",
    label: "Tencent Hunyuan",
    endpoint: "https://api.hunyuan.cloud.tencent.com/v1",
    endpointHelp: "Tencent Hunyuan OpenAI-compatible API Base URL. Enter up to /v1.",
    keyHelp: "Enter your Tencent Hunyuan access key (API Key).",
    modelPlaceholder: "Enter the model name from the Tencent Hunyuan console",
    modelHelp: "Enter a model name supported by the Tencent Hunyuan console.",
  },
  {
    id: "gemini-openai",
    label: "Google Gemini (OpenAI compatible)",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    endpointHelp: "Gemini's OpenAI-compatible entry point. Enter up to /v1beta/openai.",
    keyHelp: "Enter the access key (API Key) provided by Google AI Studio or Google Cloud.",
    modelPlaceholder: "Enter the OpenAI-compatible model name from the Gemini API",
    modelHelp: "Enter a model name supported by the Gemini OpenAI-compatible endpoint.",
  },
  {
    id: "xai",
    label: "xAI",
    endpoint: "https://api.x.ai/v1",
    endpointHelp: "xAI API Base URL. Enter up to /v1.",
    keyHelp: "Enter the access key (API Key) created in the xAI console.",
    modelPlaceholder: "Enter the model name from the xAI console",
    modelHelp: "Enter a model name supported by the xAI console.",
  },
  {
    id: "groq",
    label: "Groq",
    endpoint: "https://api.groq.com/openai/v1",
    endpointHelp: "Groq's OpenAI-compatible API Base URL. Enter up to /openai/v1.",
    keyHelp: "Enter the access key (API Key) created in the Groq console.",
    modelPlaceholder: "Enter the model name from the Groq console",
    modelHelp: "Enter a model name supported by the Groq console.",
  },
  {
    id: "mistral",
    label: "Mistral",
    endpoint: "https://api.mistral.ai/v1",
    endpointHelp: "Mistral API Base URL. Enter up to /v1.",
    keyHelp: "Enter the access key (API Key) created in the Mistral console.",
    modelPlaceholder: "Enter the model name from the Mistral console",
    modelHelp: "Enter a model name supported by the Mistral console.",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    endpoint: "https://api.perplexity.ai",
    endpointHelp: "Perplexity API Base URL. Enter the root address; Q&A Log will append /chat/completions automatically.",
    keyHelp: "Enter the access key (API Key) created in the Perplexity console.",
    modelPlaceholder: "Enter the model name from the Perplexity console",
    modelHelp: "Enter a model name supported by the Perplexity API.",
  },
  {
    id: "openai-compatible-gateway",
    label: "Other OpenAI-compatible gateway / relay station",
    endpoint: "",
    endpointHelp: "Enter the OpenAI-compatible address provided by the relay station. You can enter the full /chat/completions path or just the Base URL.",
    keyHelp: "Enter the access key provided by the relay station; if the gateway does not require authentication, you can leave it empty for a local service.",
    modelPlaceholder: "Enter the model name required by this relay station",
    modelHelp: "Use the model name shown in the relay station's console or documentation.",
  },
  {
    id: "ollama",
    label: "Local Ollama",
    endpoint: "http://127.0.0.1:11434/v1",
    endpointHelp: "Local Ollama OpenAI-compatible address. Start Ollama before using the default address.",
    keyHelp: "Local Ollama usually does not require an access key.",
    modelPlaceholder: "Enter a model name already installed in your local Ollama",
    modelHelp: "Enter a model name already installed according to `ollama list`.",
  },
  {
    id: "lmstudio",
    label: "Local LM Studio",
    endpoint: "http://127.0.0.1:1234/v1",
    endpointHelp: "Local LM Studio OpenAI-compatible address. Start the local server before using the default address.",
    keyHelp: "Local LM Studio usually does not require an access key.",
    modelPlaceholder: "Enter the model identifier currently loaded in LM Studio",
    modelHelp: "Enter the model identifier currently exposed by the LM Studio service; check the LM Studio Server panel if unsure.",
  },
  {
    id: "local-openai-compatible",
    label: "Local OpenAI-compatible service",
    endpoint: "http://127.0.0.1:8000/v1",
    endpointHelp: "Address of a local OpenAI-compatible service, such as vLLM, Xinference, or llama.cpp server. Start the service before use.",
    keyHelp: "Local services can usually be left blank; enter the corresponding key if authentication is configured.",
    modelPlaceholder: "Enter the model name of a local service such as vLLM / Xinference / llama.cpp",
    modelHelp: "Enter the model name actually exposed by the local service.",
  },
];

export const ONE_CARD_PROVIDERS = {
  // 小米 MiMo 平台只有大语言模型与转录模型，没有说话人识别模型：
  // 预设因此只配两段（录音转写 + AI 整理），说话人识别写为未启用（见 src/setup 的 planPresetApplication）。
  mimo: {
    label: "Xiaomi MiMo",
    asrProvider: "apimimo",
    llmPreset: "mimo",
    llmEndpoint: "https://api.xiaomimimo.com/v1",
    tokenPlanEndpoint: "https://token-plan-cn.xiaomimimo.com/v1",
    llmModel: "mimo-v2.6-flash",
    applyDesc: "已用同一把 MiMo Key 配好语音转写（mimo-v2.5-asr）和 AI 整理（mimo-v2.6-flash）。",
  },
  siliconflow: {
    label: "SiliconFlow",
    asrProvider: "siliconflow",
    llmPreset: "siliconflow",
    llmEndpoint: DEFAULT_SETTINGS.llmEndpoint,
    llmModel: "", // 硅基流动大模型型号多，留给用户在「大模型服务」里选
    applyDesc: "已用同一把硅基流动 Key 配好语音转写（SenseVoiceSmall）和大模型服务；硅基流动大模型型号较多，请到「大模型服务」填一个模型标识后测试连通。",
  },
  // 一站式方案：一把百炼 API Key 同时配好「录音转写 / 导入音频 / AI 整理」三段。
  // 地址与模型全部内置，用户只需填密钥——这是首次配置唯一的正式推荐路径。
  //
  // 模型依据（2026-09-17 查证阿里云百炼模型列表与 Qwen-ASR API 参考，见 MAINTAINING §11.1）：
  //   - 录音转写 qwen3-asr-flash：非实时、HTTP（OpenAI 兼容），走
  //     /compatible-mode/v1/chat/completions 的 input_audio 字段（与既有 apimimo 协议同形状）。
  //     选它而不是 qwen-audio-3.0-asr-flash-streaming：后者是 WebSocket 实时识别，
  //     鉴权只能走 Authorization 请求头，而手机端浏览器的 WebSocket API 不允许设置请求头，
  //     因此那条路在移动端必然失败。非实时模型桌面与移动端都能用，符合「一次配置到处可用」。
  //   - 导入音频 qwen-audio-3.0-asr-flash-filetrans：DashScope 异步调用，支持说话人分离，
  //     走 /api/v1/services/audio/asr/transcription（与既有 dashscope-filetrans 协议一致）。
  //   - AI 整理 qwen3.8-flash：OpenAI 兼容 Chat Completions。
  bailian: {
    label: "Alibaba Cloud Bailian",
    scope: "asr-llm",
    // 录音转写（分段，桌面与移动端通用）
    asrProvider: "dashscope-chat",
    asrTarget: "recording",
    asrEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    asrModel: "qwen3-asr-flash",
    // 导入音频（整文件，带说话人分离）
    importAsrProvider: "dashscope-filetrans",
    importAsrEndpoint: "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
    importAsrModel: "qwen-audio-3.0-asr-flash-filetrans",
    llmPreset: "dashscope",
    llmEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    llmModel: "qwen3.8-flash",
    applyDesc: "已用一把百炼 Key 配好录音转写、音频导入与 AI 整理。",
  },
  // 面向中国大陆以外用户：一把 OpenRouter Key 配好「录音转写 / 导入音频 / AI 整理」三段。
  // 与百炼的区别是「能不能连上」而不是界面语言——两者都在下拉里，由用户按网络环境自选。
  //
  // 模型依据（2026-09-16 查证 OpenRouter 模型接口）：
  //   - 录音转写 qwen/qwen3-asr-1.7b：走 /api/v1/audio/transcriptions（分段上传，
  //     与既有 OpenAI 兼容路径同形状）。
  //   - 导入音频 microsoft/mai-transcribe-2：整文件转写并做说话人分离。该模型的唯一上游是
  //     Azure，分离开关必须经 provider.options.azure.diarization.enabled 传递，
  //     因此单独走 openrouter-diarize 协议（见 asr/openrouter-diarize.ts）。
  //   - AI 整理 deepseek/deepseek-v4.1-flash：OpenAI 兼容 Chat Completions。
  //     选它而不是 qwen/qwen3.8-flash：两者都默认开思考，但 DeepSeek 支持 reasoning.effort
  //     （max/high/low），Qwen 只支持开与关。可降 effort 才有实际的提速手段。
  openrouter: {
    label: "OpenRouter",
    scope: "asr-llm",
    asrProvider: "openrouter",
    asrTarget: "recording",
    asrEndpoint: "https://openrouter.ai/api/v1/audio/transcriptions",
    asrModel: "qwen/qwen3-asr-1.7b",
    importAsrProvider: "openrouter-diarize",
    importAsrEndpoint: "https://openrouter.ai/api/v1/audio/transcriptions",
    importAsrModel: "microsoft/mai-transcribe-2",
    llmPreset: "openrouter",
    llmEndpoint: "https://openrouter.ai/api/v1",
    llmModel: "deepseek/deepseek-v4.1-flash",
    applyDesc: "已用一把 OpenRouter Key 配好录音转写、音频导入与 AI 整理。",
  },
};

export function getLlmServicePreset(id) {
  return LLM_SERVICE_PRESETS.find(p => p.id === id) || null;
}

export function normalizeLlmProfiles(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "").trim();
    const name = String(item.name || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const profile: Record<string, unknown> = {
      id,
      name: name || "未命名配置",
      endpoint: String(item.endpoint || "").trim(),
      apiKey: String(item.apiKey || ""),
      model: String(item.model || "").trim(),
    };
    const asr = normalizeSchemeAsrSnapshot(item.asr);
    if (asr) profile.asr = asr;
    out.push(profile);
  }
  return out;
}

export function findLlmProfile(settings, id) {
  if (!id) return null;
  return (settings && Array.isArray(settings.llmProfiles) ? settings.llmProfiles : []).find(p => p.id === id) || null;
}

export function syncWorkingConfigToLlmProfile(settings, id) {
  const profile = findLlmProfile(settings, id);
  if (!profile) return;
  profile.endpoint = settings.llmEndpoint || "";
  profile.apiKey = settings.llmApiKey || "";
  profile.model = settings.llmModel || "";
}

export function applyLlmProfileToWorkingConfig(settings, id) {
  const profile = findLlmProfile(settings, id);
  if (!profile) return false;
  settings.llmEndpoint = profile.endpoint || "";
  settings.llmApiKey = profile.apiKey || "";
  settings.llmModel = profile.model || "";
  settings.activeLlmProfile = id;
  settings.llmServicePreset = inferLlmServicePresetId(settings);
  // 完整方案（带 asr 快照）：一并切换并写入转写服务配置
  const asr = profile.asr;
  if (asr && asr.providerId) {
    const providers = settings.transcribeProviders || (settings.transcribeProviders = {});
    const dft = (DEFAULT_SETTINGS.transcribeProviders || {})[asr.providerId] || {};
    const cur = providers[asr.providerId] || {};
    providers[asr.providerId] = Object.assign({}, cur, {
      name: cur.name || dft.name,
      endpoint: asr.endpoint || cur.endpoint || dft.endpoint || "",
      model: asr.model || cur.model || dft.model || "",
      language: asr.language || cur.language || dft.language || "auto",
      protocol: dft.protocol || cur.protocol,
      apiKey: asr.apiKey || "",
    });
    settings.activeTranscribeProvider = asr.providerId;
  }
  return true;
}

export function inferLlmServicePresetId(settings) {
  const current = comparableLlmEndpoint(settings && settings.llmEndpoint);
  if (!current) return "";
  const matched = LLM_SERVICE_PRESETS.find(p => llmPresetEndpointMatches(p, current));
  return matched ? matched.id : "";
}

export function getActiveLlmServicePresetId(settings) {
  const saved = settings && settings.llmServicePreset ? settings.llmServicePreset : "";
  const preset = getLlmServicePreset(saved);
  if (!preset) return inferLlmServicePresetId(settings);
  if (!preset.endpoint) return saved;
  return llmPresetEndpointMatches(preset, settings && settings.llmEndpoint)
    ? saved
    : inferLlmServicePresetId(settings);
}

function llmPresetEndpointMatches(preset, endpoint) {
  const current = comparableLlmEndpoint(endpoint);
  if (!preset || !current) return false;
  if (preset.id === "dashscope" && isDashscopeCompatibleLlmEndpoint(current)) return true;
  if (preset.endpoint && comparableLlmEndpoint(preset.endpoint) === current) return true;
  return Array.isArray(preset.altEndpoints) && preset.altEndpoints.some(ep => comparableLlmEndpoint(ep) === current);
}

export function isDashscopeCompatibleLlmEndpoint(endpoint) {
  try {
    const host = new URL(comparableLlmEndpoint(endpoint)).hostname.toLowerCase();
    return host === "dashscope.aliyuncs.com"
      || host === "coding.dashscope.aliyuncs.com"
      || host.endsWith(".maas.aliyuncs.com");
  } catch {
    return false;
  }
}

export function getLlmOutputCeiling(settings) {
  // 保留旧导出名，避免外部调用方断裂；真正的能力上限由
  // src/llm/output-budget.ts 在服务端明确拒绝后按 endpoint + model 记忆。
  // 这里永远不再根据模型名称猜测上限。
  return 0;
}

function normalizeBriefingMetric(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

// 录音长度分档（单一来源）：输出 token 配额（下方 getBriefingMergeDesiredTokens）与篇幅策略指令
// （main.ts buildAdaptiveBriefingLengthInstruction）共用，避免两处各写一份阈值导致漂移。
// 阈值较早期下调过一档（段数 48/24/12 → 36/18/9，时长/字符同比例下调），让中长会议更早拿到
// 更高的 token 配额和更强的"必须全程覆盖"展开指令——这是长会议纪要不被压缩的关键前置条件。
export function classifyBriefingLength(stats) {
  const durationMs = normalizeBriefingMetric(stats && stats.durationMs);
  const transcriptChars = normalizeBriefingMetric(stats && stats.transcriptChars);
  const segmentCount = normalizeBriefingMetric(stats && stats.segmentCount);
  const hours = durationMs / 3600000;
  if (hours >= 3 || transcriptChars >= 90000 || segmentCount >= 36) return "ultra";
  if (hours >= 1.5 || transcriptChars >= 45000 || segmentCount >= 18) return "long";
  if (hours >= 0.75 || transcriptChars >= 22000 || segmentCount >= 9) return "medium";
  return "short";
}

export function getBriefingMergeDesiredTokens(stats) {
  const transcriptChars = normalizeBriefingMetric(stats && stats.transcriptChars);
  const durationMs = normalizeBriefingMetric(stats && stats.durationMs);
  let baseTokens = BRIEFING_MERGE_MAX_TOKENS_SHORT;
  switch (classifyBriefingLength(stats)) {
    case "ultra": baseTokens = BRIEFING_MERGE_MAX_TOKENS_ULTRA; break;
    case "long": baseTokens = BRIEFING_MERGE_MAX_TOKENS_LONG; break;
    case "medium": baseTokens = BRIEFING_MERGE_MAX_TOKENS_MEDIUM; break;
  }
  // 正常预算只由材料体量和用户要求决定，不再套用全局输出上限。
  // 服务端若明确拒绝该预算，请求层会按实际能力降档并记忆 endpoint + model 的运行时上限。
  return Math.max(
    baseTokens,
    Math.ceil(transcriptChars / 2),
    Math.ceil(durationMs / 3600000 * 16000),
  );
}

export function getBriefingMergeMaxTokens(stats, settings, runtimeCeiling = 0) {
  const desired = getBriefingMergeDesiredTokens(stats);
  const ceiling = Number(runtimeCeiling) > 0 ? Math.floor(Number(runtimeCeiling)) : 0;
  return ceiling > 0 ? Math.min(desired, ceiling) : desired;
}

export const BRIEFING_MERGE_MAX_TOKENS_SHORT = 4096;

export const BRIEFING_MERGE_MAX_TOKENS_MEDIUM = 8192;

export const BRIEFING_MERGE_MAX_TOKENS_LONG = 16000;

export const BRIEFING_MERGE_MAX_TOKENS_ULTRA = 48000;

export function normalizeSchemeAsrSnapshot(asr) {
  if (!asr || typeof asr !== "object") return undefined;
  const providerId = String(asr.providerId || "").trim();
  if (!providerId) return undefined;
  return {
    providerId,
    apiKey: String(asr.apiKey || ""),
    endpoint: String(asr.endpoint || "").trim(),
    model: String(asr.model || "").trim(),
    language: String(asr.language || "").trim(),
  };
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
