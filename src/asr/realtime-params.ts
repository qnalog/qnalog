// 实时转写（DashScope WebSocket）的请求参数构造。
//
// 为什么单独成模块：`src/asr/clients.ts` 带 `@ts-nocheck`，参数写错了不会被类型检查发现，
// 而这类错误只在真机录音时以「task-failed」的形式暴露。这里把「哪个模型接受哪些参数」
// 变成可测的事实。
//
// 依据（2026-09-15 查证阿里云百炼文档）：
//   1. `disfluency_removal_enabled`、`semantic_punctuation_enabled`、`max_sentence_silence`、
//      `punctuation_prediction_enabled`、`inverse_text_normalization_enabled` 文档均标注
//      **仅 Paraformer 支持**。Qwen-Audio-3.0-ASR-Flash-Streaming / Fun-ASR-Realtime 的参数表
//      里没有这些字段（该参数表见「实时语音识别（Qwen-Audio-3.0-ASR-Flash-Streaming/Fun-ASR-Realtime）
//      客户端事件 → run-task → parameters」）。
//   2. `language_hints` 两类模型都支持；Qwen 系列最多 4 个值，Fun-ASR-Realtime 系列只取第一个。
//   3. `format` / `sample_rate` 是必填项。

/** 需要的音频与语种信息；由调用方从 provider 配置得来。 */
export interface RealtimeAsrRequestInput {
  model: string;
  sampleRate: number;
  /** 用户设置的语种；空或 auto 表示不指定，交给服务端自动识别。 */
  language?: string;
}

/** Paraformer 专属参数：只有 Paraformer 系列的参数表里有这些字段。 */
const PARAFORMER_ONLY_MODELS = /^(?:paraformer-realtime)/i;

/**
 * 该模型是否属于 Paraformer 系列。
 * 只用于决定「能不能发 Paraformer 专属参数」；不用于别的能力判定。
 */
export function isParaformerRealtimeModel(model: string): boolean {
  return PARAFORMER_ONLY_MODELS.test(String(model || "").trim());
}

/**
 * 构造 run-task 的 parameters。
 *
 * 原则是**只发目标模型确实支持的字段**：多发的字段虽然在部分服务端被忽略，
 * 但文档明确标注「仅 Paraformer 支持」，不能假定另一个模型也会忽略它。
 */
export function buildRealtimeAsrParameters(input: RealtimeAsrRequestInput): Record<string, unknown> {
  const model = String((input && input.model) || "").trim();
  const sampleRate = Number(input && input.sampleRate) || 16000;
  const language = String((input && input.language) || "").trim().toLowerCase();

  const parameters: Record<string, unknown> = {
    format: "pcm",
    sample_rate: sampleRate,
  };

  if (isParaformerRealtimeModel(model)) {
    // 关掉语气词过滤：保留原话，「嗯/啊」不参与识别结果清洗。
    parameters.disfluency_removal_enabled = false;
  }

  // 明确语种能提升准确率；不指定时服务端自动识别。
  // 取值限定为两类模型共同支持的语种，避免下发服务端不认的代码。
  if (language && language !== "auto") {
    parameters.language_hints = [language];
  }

  return parameters;
}

/**
 * 由用户填写的语种推断下发给服务的语种代码。
 * 中文的常见写法（zh-CN / zh_CN / 中文）统一成 zh；其余交给 buildRealtimeAsrParameters 判断。
 */
export function normalizeRealtimeLanguage(value: string): string {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "auto") return "";
  if (raw.startsWith("zh")) return "zh";
  if (raw.startsWith("en")) return "en";
  if (raw.startsWith("ja")) return "ja";
  return raw;
}
