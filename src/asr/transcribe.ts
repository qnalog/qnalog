/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。
import { delayMs, extFromMime, mimeFromExt, isAsrTransportError } from '../shared/util-audio';
import { extractLlmContent } from '../shared/util-json';
import { isLocalServiceEndpoint } from '../shared/util-note';
import { assertSafeServiceEndpoint, canOmitServiceApiKey } from '../shared/util-llm-endpoint';
import { buildVocabularyPrompt, applyVocabularyCorrections, loadVocabularyGroups } from '../vocabulary';
import { buildPeopleHotwordsForAsr } from '../people';
import { qnalogArrayBufferToBase64 } from './clients';
import { extractTranscriptText } from './speaker-labels';
import { cleanApimimoAsrRepeatedLoops } from './apimimo-clean';
import { getSpeakerDiarizationRequestOptions } from './diarization';

export type AsrLifecycleSignalType =
  | "attempt-start"
  | "request-start"
  | "response-start"
  | "stream-progress"
  | "retry-wait"
  | "attempt-empty"
  | "attempt-error"
  | "attempt-complete";

export interface AsrLifecycleSignal {
  type: AsrLifecycleSignalType;
  at: number;
  attempt?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  deadlineAt?: number;
  retryAt?: number;
  retryDelayMs?: number;
  receivedChars?: number;
  providerChunkIndex?: number;
  providerChunkCount?: number;
  error?: string;
}

export type AsrLifecycleObserver = (signal: AsrLifecycleSignal) => void;

function emitAsrLifecycle(
  observer: AsrLifecycleObserver | undefined,
  signal: Omit<AsrLifecycleSignal, "at"> & { at?: number },
): void {
  if (typeof observer !== "function") return;
  try {
    observer(Object.assign({ at: Date.now() }, signal));
  } catch {
    // Observability must never affect transcription.
  }
}

export function normalizeAsrConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(3, Math.floor(n)));
}

export const IMPORT_AUDIO_CHUNK_SAMPLE_RATE = 16000;

export async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const AudioContextCtor = window.AudioContext || window["webkitAudioContext"];
  if (!AudioContextCtor) throw new Error("当前环境不支持音频解码");
  const ctx = new AudioContextCtor();
  try {
    const ab = await blob.arrayBuffer();
    return await ctx.decodeAudioData(ab.slice(0));
  } finally {
    try { await ctx.close(); } catch { /* intentionally empty */ }
  }
}

export async function renderAudioBufferSliceToWav(audioBuffer, startMs, endMs) {
  const OfflineContextCtor = window.OfflineAudioContext || window["webkitOfflineAudioContext"];
  if (!OfflineContextCtor) throw new Error("当前环境不支持离线音频切片");
  const startSec = Math.max(0, (Number(startMs) || 0) / 1000);
  const endSec = Math.max(startSec + 0.1, (Number(endMs) || 0) / 1000);
  const durationSec = endSec - startSec;
  const frameCount = Math.max(1, Math.ceil(durationSec * IMPORT_AUDIO_CHUNK_SAMPLE_RATE));
  const offline = new OfflineContextCtor(1, frameCount, IMPORT_AUDIO_CHUNK_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offline.destination);
  source.start(0, startSec, durationSec);
  const rendered = await offline.startRendering();
  return new Blob([encodeMonoWav(rendered)], { type: "audio/wav" });
}

export function encodeMonoWav(audioBuffer) {
  const samples = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

// 按错误内容挑重试退避时长（纯函数，供测试）：
// 1) 错误信息带 Retry-After 提示 → 按服务端要求的秒数等（+0-2s 随机抖动，封顶 90s）；
// 2) 限流类（429 / 限流 / rate limit / too many request）→ 30-45s 随机（MiMo 的 10K TPM 按分钟窗滚动，
//    1-2s 的短退避只会立刻再撞限流，白烧一次重试机会）；
// 3) 网络/超时/5xx → 5s 起步指数退避，避免服务不可达时连续发送无效请求；
// 4) 空结果等其它软失败 → 维持 1.2-2s 短退避。
export function pickAsrRetryDelayMs(errorMessage, attempt?) {
  const msg = String(errorMessage || "");
  const retryAfter = msg.match(/retry-after[:：]?\s*(\d+)/i);
  if (retryAfter) return Math.min(90000, Number(retryAfter[1]) * 1000 + Math.floor(Math.random() * 2000));
  if (/(^|\D)429(\D|$)|限流|rate.?limit|too many request/i.test(msg)) return 30000 + Math.floor(Math.random() * 15000);
  if (/\b(500|502|503|504)\b|timeout|timed?\s*out|network(?:error)?|failed to fetch|fetch failed|err_(?:internet|network|connection)|dns|enotfound|econn(?:reset|refused|aborted)|etimedout|net::|超时|流中断|连接(?:失败|中断|关闭)|网络(?:错误|不可用)/i.test(msg)) {
    const retryIndex = Math.max(0, Math.min(3, (Math.floor(Number(attempt) || 1) - 1)));
    return Math.min(30000, 5000 * (2 ** retryIndex)) + Math.floor(Math.random() * 1000);
  }
  return 1200 + Math.floor(Math.random() * 800);
}

export function resolveTranscribeProvider(plugin, forceId?: string) {
  const s = plugin.settings;
  const id = forceId || s.activeTranscribeProvider || "siliconflow";
  const provider = (s.transcribeProviders && s.transcribeProviders[id]) || null;
  // 优先用 provider 子对象；否则回退到顶层旧字段
  const endpoint = (provider && provider.endpoint) || s.transcribeEndpoint || "";
  const apiKey   = (provider && provider.apiKey)   || s.transcribeApiKey   || "";
  const model    = (provider && provider.model)    || s.transcribeModel    || "";
  const language = (provider && provider.language !== undefined ? provider.language : s.transcribeLanguage) || "";
  const protocol = provider && provider.protocol ? String(provider.protocol) : "";
  return { id, endpoint, apiKey, model, language, protocol, name: provider ? provider.name : "" };
}

export function formatUploadSize(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

export function compactErrorBody(text, maxLen = 240) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

export function approxBase64Bytes(rawBytes) {
  return Math.ceil(Math.max(0, Number(rawBytes) || 0) / 3) * 4;
}

export function buildTranscribeHttpError(res, body, provider, blob, mime) {
  const status = Number(res && res.status) || 0;
  const statusText = String(res && res.statusText ? res.statusText : "").trim();
  const traceId = res && res.headers && typeof res.headers.get === "function"
    ? (res.headers.get("x-siliconcloud-trace-id") || res.headers.get("x-request-id") || res.headers.get("cf-ray") || "")
    : "";
  const service = (provider && (provider.name || provider.id)) || "当前服务";
  const model = provider && provider.model ? `模型：${provider.model}` : "";
  const detail = compactErrorBody(body);
  const ext = extFromMime(mime || (blob && blob.type) || "");
  const audioInfo = `音频：${ext || "unknown"} / ${formatUploadSize(blob && blob.size)}`;
  const hints = [];

  if (status === 401 || status === 403) hints.push("请检查转写访问密钥和服务权限");
  else if (status === 404) hints.push("请检查转写服务地址和模型名称");
  else if (status === 413) hints.push("音频文件过大，请缩短切片或降低码率后重试");
  else if (status === 429) hints.push("服务限流，请稍后重试或切换服务");
  else if (status >= 500) hints.push("服务端错误，建议稍后重试；连续失败时可切换转写服务或调整音频格式");

  return [
    `转写失败 ${status}${statusText ? " " + statusText : ""}`,
    `服务：${service}`,
    model,
    audioInfo,
    traceId ? `Trace ID：${traceId}` : "",
    detail ? `返回：${detail}` : "",
    hints.join("；"),
  ].filter(Boolean).join("；");
}

export function makeRecordingIssue(kind, patch) {
  return Object.assign({
    kind: kind || "service",
    at: Date.now(),
    message: "",
    stoppedAtMs: null,
  }, patch || {});
}

export function getTranscribeRequestTimeoutMs(provider, blobBytes?) {
  if (isLocalServiceEndpoint(provider && provider.endpoint)) return 10 * 60 * 1000;
  // 云端：120s 基础 + 按上传体积追加（≈1s / 50KB，封顶 180s）——3 分钟 WAV（~5.8MB）约 233s，
  // 避免大块 WAV 在慢上行下被固定 120s 掐死后反复重试。
  const bytes = Math.max(0, Number(blobBytes) || 0);
  const uploadAllowanceMs = Math.min(180, Math.ceil(bytes / 51200)) * 1000;
  return 120 * 1000 + uploadAllowanceMs;
}

export const APIMIMO_ASR_PROTOCOL = "apimimo-chat-input-audio";

// 百炼的 qwen3-asr-flash 用同一套 OpenAI 兼容 Chat Completions + input_audio 协议，
// 但参数与 MiMo 不同：语种不可填 auto（文档要求不确定时整个字段省略）、
// 单次 5 分钟 / base64 后 10MB、无 2K 输出上限、无 TPM 配速限制。
export const DASHSCOPE_CHAT_ASR_PROTOCOL = "dashscope-chat-input-audio";

export const APIMIMO_ASR_MAX_BASE64_BYTES = Math.floor(9.5 * 1024 * 1024);

// 百炼文档原文：「Base64 编码会增大体积，请控制原文件大小，确保编码后仍符合输入音频大小限制（10MB）」。
// 按十进制 10,000,000 字节取值，而不是 10×1024×1024：文档没写清是哪种 MB，
// 取更严的那个，两种读法下都不会超限。
export const DASHSCOPE_CHAT_ASR_MAX_BASE64_BYTES = 10 * 1000 * 1000;

// 走本机转码的格式：MediaRecorder 产出 webm/ogg/mp4，服务端虽多数格式都收，
// 但只有统一转成 WAV 才能按精确时长切块（见 getChatInputAudioNativePlan 的说明）。
export const CHAT_INPUT_AUDIO_NATIVE_EXTS = new Set(["mp3", "wav"]);

export const APIMIMO_ASR_NATIVE_EXTS = CHAT_INPUT_AUDIO_NATIVE_EXTS;

// MiMo 切块 2 分钟：单次输出上限 2K tokens，3 分钟密集中文讲话的转写文字会超 2K 被截断（实测触顶）；
// 收窄到 2 分钟让输出稳在 2K 以内。总配速按音频秒数计、与块数无关，故缩小切块不增 TPM 压力。
export const APIMIMO_ASR_CHUNK_MS = 2 * 60 * 1000;

// 百炼切块 3 分钟：限制来自单次 5 分钟 / base64 后 10MB。16kHz 单声道 16-bit WAV 为
// 32,000 字节/秒，3 分钟 = 5.76MB，base64 后约 7.68MB，留出余量；4 分钟则达 10.24MB 超出上限。
// 官方没有输出 token 上限，故不必像 MiMo 那样为截断收窄。
export const DASHSCOPE_CHAT_ASR_CHUNK_MS = 3 * 60 * 1000;

// 服务端单次请求的硬上限：文档「≤10MB；≤5分钟」。切块尺寸（3 分钟）比它紧，
// 所以只有明确不超过 5 分钟的音频才可能原样直发。
export const DASHSCOPE_CHAT_ASR_MAX_DURATION_MS = 5 * 60 * 1000;

// 百炼 natively 接受的格式（文档列出 aac/amr/avi/flac/flv/m4a/mkv/mov/mp3/mp4/mpeg/ogg/opus/wav/webm/wma/wmv）。
// 这里只列 MediaRecorder 会产出的几种：列进去就能在时长合规时原样直发，
// 省掉「5 分钟 opus ≈ 1.6MB」→「3 分钟 WAV base64 ≈ 7.7MB」的转码与体积膨胀。
// 超过时长或体积上限时仍会解码切块，所以列进来不会绕过限制。
export const DASHSCOPE_CHAT_ASR_NATIVE_EXTS = new Set(["webm", "ogg", "mp4", "m4a", "mp3", "wav", "flac", "aac"]);

export const DASHSCOPE_CHAT_ASR_MAX_CHUNKS = 240;

export const APIMIMO_ASR_MAX_CHUNKS = 160;

/**
 * 同一套 input_audio 协议下各服务的差异点。切块、SSE 解析、请求构造都是共用的，
 * 只有这些参数按服务取值。
 */
export interface ChatInputAudioProfile {
  /** 判定用：该 provider 是否走本协议。 */
  protocol: string;
  /**
   * 切块时每块的最大时长（毫秒）。
   * 取「服务端单次上限」与「单块 base64 体积上限」中更紧的一个：
   * 16kHz 单声道 16-bit WAV 为 32,000 字节/秒，3 分钟 = 5.76MB，base64 后约 7.68MB。
   */
  chunkMs: number;
  /**
   * 服务端单次请求允许的最大音频时长（毫秒）。
   * 只有它以内的音频才可能原样直发；超过就必须切块。
   * MiMo 的瓶颈是 2K 输出 tokens，故与 chunkMs 同为 2 分钟；
   * 百炼是 5 分钟，比切块尺寸（受体积限制）更宽松。
   */
  maxDurationMs: number;
  /** 单次请求最多自动切多少块。 */
  maxChunks: number;
  /** 单块 base64 后允许的体积上限。 */
  maxBase64Bytes: number;
  /** 服务名，用于错误文案。 */
  label: string;
  /** 服务简称，用于「第 N/M 块」这类紧凑文案与诊断消息。 */
  shortLabel: string;
  /** 诊断键前缀，生成 `asr.<slug>_empty_chunk` 这类键名。 */
  diagnosticSlug: string;
  /** provider 未填模型时的兜底模型名。 */
  defaultModel: string;
  /**
   * 服务端接受的原始音频格式（不经本机转码直接上传）。
   * 空集合表示任何格式都先转码——百炼收 webm，但只有 WAV 能按精确时长切块。
   */
  nativeExts: Set<string>;
  /**
   * 服务端是否直接拒收 nativeExts 之外的格式。
   * MiMo 实测发 audio/mp4 直接 400，属拒收；百炼多数格式都收，转码只为精确切块。
   * 只影响解码失败时的错误措辞。
   */
  serverRejectsNonNative: boolean;
  /** 原生格式的展示文本，用在错误信息里。显式写出来，不从 nativeExts 推导。 */
  nativeFormatsLabel: string;
  /** 语种参数取值；返回空串表示整个 asr_options.language 字段都不下发。 */
  languageFor: (language: string) => string;
  /** 是否启用按音频秒数计的 TPM 配速（MiMo 10K TPM 需要，百炼不需要）。 */
  tpmPacing: boolean;
}

const APIMIMO_PROFILE: ChatInputAudioProfile = {
  protocol: APIMIMO_ASR_PROTOCOL,
  chunkMs: APIMIMO_ASR_CHUNK_MS,
  maxDurationMs: APIMIMO_ASR_CHUNK_MS,
  maxChunks: APIMIMO_ASR_MAX_CHUNKS,
  maxBase64Bytes: APIMIMO_ASR_MAX_BASE64_BYTES,
  label: "APIMiMo-V2.5-ASR",
  shortLabel: "APIMiMo",
  diagnosticSlug: "apimimo",
  defaultModel: "mimo-v2.5-asr",
  nativeExts: APIMIMO_ASR_NATIVE_EXTS,
  serverRejectsNonNative: true,
  nativeFormatsLabel: "wav/mp3",
  // MiMo 文档仅支持 auto / zh / en；其它值（含空 / 方言码）一律归一为 auto。
  languageFor: (language) => {
    const lang = String(language || "").trim().toLowerCase();
    return (lang === "zh" || lang === "en") ? lang : "auto";
  },
  tpmPacing: true,
};

const DASHSCOPE_CHAT_PROFILE: ChatInputAudioProfile = {
  protocol: DASHSCOPE_CHAT_ASR_PROTOCOL,
  chunkMs: DASHSCOPE_CHAT_ASR_CHUNK_MS,
  maxDurationMs: DASHSCOPE_CHAT_ASR_MAX_DURATION_MS,
  maxChunks: DASHSCOPE_CHAT_ASR_MAX_CHUNKS,
  maxBase64Bytes: DASHSCOPE_CHAT_ASR_MAX_BASE64_BYTES,
  label: "百炼 qwen3-asr-flash",
  shortLabel: "百炼 qwen3-asr-flash",
  diagnosticSlug: "dashscope_chat",
  defaultModel: "qwen3-asr-flash",
  // MediaRecorder 产出的 webm/ogg/mp4 都在此列：时长达标就原样直发，
  // 超出 5 分钟或 base64 超 10MB 时才解码切块（见 getChatInputAudioPlan）。
  nativeExts: DASHSCOPE_CHAT_ASR_NATIVE_EXTS,
  serverRejectsNonNative: false,
  nativeFormatsLabel: "webm/ogg/mp4/mp3/wav 等",
  // 文档：「若音频语种不确定，或包含多种语种…请勿指定该参数」。故只透传明确的语种码，
  // 其余（含 auto / 空）一律不下发该字段。取值域比 MiMo 宽。
  languageFor: (language) => {
    const lang = String(language || "").trim().toLowerCase();
    if (!lang || lang === "auto") return "";
    return /^[a-z]{2,3}$/.test(lang) ? lang : "";
  },
  tpmPacing: false,
};

export function getChatInputAudioProfile(provider): ChatInputAudioProfile | null {
  const p = provider || {};
  const protocol = String(p.protocol || "");
  if (protocol === DASHSCOPE_CHAT_ASR_PROTOCOL) return DASHSCOPE_CHAT_PROFILE;
  if (protocol === APIMIMO_ASR_PROTOCOL) return APIMIMO_PROFILE;
  const id = String(p.id || "").toLowerCase();
  const endpoint = String(p.endpoint || "").toLowerCase();
  const model = String(p.model || "").toLowerCase();
  if (id === "apimimo" || endpoint.includes("xiaomimimo.com") || model === "mimo-v2.5-asr") return APIMIMO_PROFILE;
  if (id === "dashscope-chat" || model === "qwen3-asr-flash") return DASHSCOPE_CHAT_PROFILE;
  return null;
}

export function isApimimoAsrProvider(provider) {
  return getChatInputAudioProfile(provider)?.protocol === APIMIMO_ASR_PROTOCOL;
}

export function isChatInputAudioProvider(provider) {
  return getChatInputAudioProfile(provider) !== null;
}

export function normalizeApimimoAsrEndpoint(endpoint) {
  const raw = String(endpoint || "").trim();
  if (!raw) return "";
  const noTrail = raw.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(noTrail)) return noTrail;
  try {
    const url = new URL(noTrail);
    const path = (url.pathname || "").replace(/\/+$/, "");
    url.pathname = path + "/chat/completions";
    return url.toString().replace(/\/+$/, "");
  } catch { /* intentionally empty */ }
  return noTrail;
}

/**
 * 标记为不可重试的转写错误：格式不被接受、本机无法解码、超过体积上限等，
 * 重试同样必败，队列据此直接吃满重试退出（见 src/notes/audio-refs.ts）。
 */
export function chatInputAudioPermanentError(message) {
  const err = new Error(message) as Error & { nonRetryable?: boolean };
  err.nonRetryable = true;
  return err;
}

// 单次上限既受上传体积影响，也受音频时长影响。WAV/MP3 都可能来自不同采样率或码率，
// 仅凭文件体积无法可靠判断时长，因此原生格式也先解码核实。
// decodedDurationMs 传入后给出最终 direct/split 决策，未传时给出 inspect 预判。
export function getChatInputAudioPlan(profile, blob, mime, decodedDurationMs?) {
  const inputMime = String(mime || (blob && blob.type) || "").toLowerCase();
  const ext = extFromMime(inputMime);
  const isNative = profile.nativeExts.has(ext);
  const nativeMime = isNative ? mimeFromExt(ext) : "";
  if (!nativeMime) return { nativeMime: "", action: "transcode" };
  const overSize = approxBase64Bytes(blob && blob.size) > profile.maxBase64Bytes;
  if (Number.isFinite(Number(decodedDurationMs))) {
    const tooLong = Math.max(0, Number(decodedDurationMs) || 0) > profile.maxDurationMs;
    return { nativeMime, action: (!overSize && !tooLong) ? "direct" : "split" };
  }
  return { nativeMime, action: "inspect" };
}

export async function buildChatInputAudioChunks(profile, blob, mime) {
  const inputMime = String(mime || (blob && blob.type) || "").toLowerCase();
  const initialPlan = getChatInputAudioPlan(profile, blob, inputMime);
  const nativeMime = initialPlan.nativeMime;
  const chunkMinutes = Math.round(profile.chunkMs / 60000);

  // 只有拿到解码后的真实时长才允许原样直发，避免低码率长音频绕过时长上限。
  if (initialPlan.action === "direct") {
    return [{ blob, mime: nativeMime }];
  }

  // 走到这里：非原生格式、原生音频可能超过时长上限，或 base64 超过体积上限。
  let audioBuffer;
  try {
    audioBuffer = await decodeAudioBlob(blob);
  } catch (e) {
    // 原生格式本身能被服务端接收。仅在本机无法核实时长、且上传体积仍合法时保留兼容直发；
    // 非原生格式或超体积音频仍必须报错，不能把服务端必拒的请求发出去。
    if (nativeMime && approxBase64Bytes(blob.size) <= profile.maxBase64Bytes) {
      return [{ blob, mime: nativeMime }];
    }
    const reason = profile.serverRejectsNonNative
      ? `格式 ${inputMime || "unknown"} 不被 ${profile.label} 接受（仅 ${profile.nativeFormatsLabel}）`
      : `格式 ${inputMime || "unknown"} 需先转成 WAV 才能按 ${chunkMinutes} 分钟切块`;
    const detail = e && e.message ? e.message : e;
    throw chatInputAudioPermanentError(`${profile.label}：${reason}，但本机无法解码它（${detail}）。请改用其它转写服务，或缩短分段间隔后重录。`);
  }
  const totalMs = Math.max(1, Math.round((audioBuffer.duration || 0) * 1000));
  const decodedPlan = getChatInputAudioPlan(profile, blob, inputMime, totalMs);
  if (decodedPlan.action === "direct") return [{ blob, mime: decodedPlan.nativeMime }];
  const chunkCount = Math.ceil(totalMs / profile.chunkMs);
  if (chunkCount > profile.maxChunks) {
    throw chatInputAudioPermanentError(`${profile.label} 单次最多自动切 ${profile.maxChunks} 块（约 ${Math.round(profile.maxChunks * profile.chunkMs / 60000)} 分钟）；当前约 ${Math.round(totalMs / 60000)} 分钟过长。请缩短分段间隔，或对超长录音改用支持大文件的 ASR 服务。`);
  }
  const chunks = [];
  for (let startMs = 0; startMs < totalMs; startMs += profile.chunkMs) {
    const endMs = Math.min(totalMs, startMs + profile.chunkMs);
    const wavBlob = await renderAudioBufferSliceToWav(audioBuffer, startMs, endMs);
    if (approxBase64Bytes(wavBlob.size) > profile.maxBase64Bytes) {
      throw chatInputAudioPermanentError(`${profile.label} 转码后单块 base64 仍超过 ${Math.round(profile.maxBase64Bytes / 1024 / 1024)}MB（${formatUploadSize(wavBlob.size)}）。请改用支持更大切片的 ASR 服务。`);
    }
    chunks.push({ blob: wavBlob, mime: "audio/wav" });
  }
  return chunks;
}

export function getApimimoNativeAudioPlan(blob, mime, decodedDurationMs?) {
  return getChatInputAudioPlan(APIMIMO_PROFILE, blob, mime, decodedDurationMs);
}

export function extractApimimoAsrText(data) {
  const text = extractLlmContent(data).trim();
  if (text) return text;
  return String(
    (data && (data.text || data.transcript || data.result)) ||
    (data && data.output_text) ||
    ""
  ).trim();
}

// 据 blob 体积估算音频秒数（纯函数，供测试）：
// wav = 16kHz 单声道 16-bit ⇒ 32,000 字节/秒；其余按 mp3 ~16,000 字节/秒估。
export function estimateApimimoAudioSeconds(blob, mime) {
  const size = Math.max(0, Number(blob && blob.size) || 0);
  const m = String(mime || (blob && blob.type) || "").toLowerCase();
  return size / (m.includes("wav") ? 32000 : 16000);
}

// TPM 配速闸门（模块级，同插件实例内所有 MiMo 请求共享）：
// MiMo 账户限额 10K TPM / 100 RPM，音频 ≈ 25 token/秒 ⇒ 25 tok/s ÷ 10K TPM = 每秒音频需 ≥150ms 间隔
// 才不超额；取 160ms/秒（+7% 安全余量），封顶 45s。原先各块背靠背直发，3 分钟块 ≈ 5.2K token，
// 连发两块就撞 TPM → 429/超时/空结果。
// 间隔从"本次请求发起"起算——token 在服务端摄取音频时即已消耗，若请求本身耗时 ≥ 间隔，下一次无需再等。
  // 体感：短音频（~10s → 1.6s 间隔）几乎无感；3 分钟导入块 → ~29s 间隔，恰好贴住 10K TPM。
let _apimimoNextAllowedAt = 0;
export function reserveApimimoTpmSlot(nextAllowedAt, gapMs, nowMs = Date.now()) {
  const now = Math.max(0, Number(nowMs) || 0);
  const slotAt = Math.max(now, Math.max(0, Number(nextAllowedAt) || 0));
  return {
    waitMs: Math.max(0, slotAt - now),
    nextAllowedAt: slotAt + Math.max(0, Number(gapMs) || 0),
  };
}

export async function waitApimimoTpmSlot(blob, mime) {
  const now = Date.now();
  const gapMs = Math.max(0, Math.min(45000, Math.round(estimateApimimoAudioSeconds(blob, mime) * 160)));
  // 先同步预留时段、再等待。JavaScript 在首次 await 前会完整执行这段，多个并发调用
  // 因而会拿到不同的 FIFO 时段，不会在同一个旧时间点一起醒来。
  const reservation = reserveApimimoTpmSlot(_apimimoNextAllowedAt, gapMs, now);
  _apimimoNextAllowedAt = reservation.nextAllowedAt;
  if (reservation.waitMs > 0) await delayMs(reservation.waitMs);
}

// SSE 事件累加器（纯函数，供测试）。acc = { text, finishReason, done }。
// - "[DONE]" → done = true；
// - JSON 解析失败（注释/心跳/半包）→ 忽略该事件，acc 原样返回；
// - choices[0].delta.content 为字符串时追加；choices[0].message.content 作为全文兜底，
//   仅在比已累积文本更长时整体替换（防止短的兜底覆盖已收全的增量）；
// - choices[0].finish_reason 非空时记录（"length" = 撞 2K max output 截断，由调用方判为硬错误）。
export function applyApimimoSseData(acc, payloadStr) {
  const payload = String(payloadStr == null ? "" : payloadStr).trim();
  if (!payload) return acc;
  if (payload === "[DONE]") { acc.done = true; return acc; }
  let evt;
  try { evt = JSON.parse(payload); } catch { return acc; }
  const choice = evt && Array.isArray(evt.choices) ? evt.choices[0] : null;
  if (!choice) return acc;
  if (choice.delta && typeof choice.delta.content === "string") acc.text += choice.delta.content;
  if (choice.message && typeof choice.message.content === "string" && choice.message.content.length > acc.text.length) {
    acc.text = choice.message.content;
  }
  if (choice.finish_reason != null) acc.finishReason = choice.finish_reason;
  return acc;
}

export async function requestChatInputAudioChunk(
  profile: ChatInputAudioProfile,
  provider,
  prepared,
  endpoint,
  observer?: AsrLifecycleObserver,
) {
  assertSafeServiceEndpoint(endpoint, "http", "转写服务地址");
  // 安全校验后立即执行 TPM 配速（在读 arrayBuffer/编码 base64 之前），确保跨块、跨会话的请求间隔满足 10K TPM。
  // 只有按量配速的服务才需要；百炼没有该限制，等下去只会平白拖慢录音分段。
  if (profile.tpmPacing) await waitApimimoTpmSlot(prepared.blob, prepared.mime);
  const ab = await prepared.blob.arrayBuffer();
  const audioDataUrl = `data:${prepared.mime};base64,${qnalogArrayBufferToBase64(ab)}`;
  // 三段式超时（替代原先单一固定计时器）：
  // - 首字节超时：沿用体积自适应值（服务端要先吃完整段音频才能吐第一个 token，大块上传+摄取耗时长）；
  // - 空闲超时 60s：进入流式后每收到一个网络分片就重置——只要 token 还在流动就永不误杀；
  // - 总时长封顶 10 分钟：防御服务端无限慢速滴流。
  const firstByteTimeoutMs = getTranscribeRequestTimeoutMs(Object.assign({}, provider, { endpoint }), prepared.blob && prepared.blob.size);
  const CHAT_INPUT_SSE_IDLE_TIMEOUT_MS = 60 * 1000;
  const CHAT_INPUT_SSE_TOTAL_CAP_MS = 10 * 60 * 1000;
  const requestStartedAt = Date.now();
  emitAsrLifecycle(observer, {
    type: "request-start",
    timeoutMs: firstByteTimeoutMs,
    deadlineAt: requestStartedAt + firstByteTimeoutMs,
  });
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let abortHint = "";
  let phaseTimer = null; // 首字节 / 空闲计时器（可重置，同一时刻只有一个在跑）
  let totalTimer = null;
  const armPhaseTimer = (ms, hint) => {
    if (!controller) return;
    if (phaseTimer !== null) window.clearTimeout(phaseTimer);
    phaseTimer = window.setTimeout(() => { abortHint = hint; controller.abort(); }, ms);
  };
  if (controller) {
    totalTimer = window.setTimeout(() => {
      abortHint = `总时长超过 ${Math.round(CHAT_INPUT_SSE_TOTAL_CAP_MS / 1000)} 秒仍未完成`;
      controller.abort();
    }, CHAT_INPUT_SSE_TOTAL_CAP_MS);
    armPhaseTimer(firstByteTimeoutMs, `${Math.round(firstByteTimeoutMs / 1000)} 秒内没有响应`);
  }
  // asr_options.language：由各服务的 profile 决定取值。
  // MiMo 只认 auto / zh / en；百炼在语种不确定时要求整个字段省略——所以空串表示不下发该字段。
  const asrLanguage = profile.languageFor(provider.language);
  const payload = {
    model: provider.model || profile.defaultModel,
    messages: [{
      role: "user",
      content: [{
        type: "input_audio",
        // 官方请求结构只有 input_audio.data（data:{MIME};base64,...），靠 MIME 前缀识别格式，无 format 字段。
        input_audio: {
          data: audioDataUrl,
        },
      }],
    }],
    // 百炼在语种不确定时不下发该字段；MiMo 始终下发（含 auto）。
    ...(asrLanguage ? { asr_options: { language: asrLanguage } } : {}),
    // 官方支持 OpenAI 兼容 SSE。非流式下服务端要攒完整段结果才回包，长块极易撞客户端总超时；
    // 流式 + 空闲超时后，只要服务端还在吐字就不会被误杀。
    stream: true,
  };
  try {
    // 用 window.fetch（行为同 fetch、避开 no-restricted-globals）：ASR 上传需要 AbortController 超时，requestUrl 不暴露同等中止语义。
    const res = await window.fetch(endpoint, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, provider.apiKey ? { "Authorization": `Bearer ${provider.apiKey}` } : {}),
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      let errText = buildTranscribeHttpError(res, msg, provider, prepared.blob, prepared.mime);
      // 限流时服务端可能带 Retry-After（秒）：拼进错误信息，供 pickAsrRetryDelayMs 按服务端要求退避。
      const retryAfterHeader = res.headers && typeof res.headers.get === "function" ? String(res.headers.get("retry-after") || "").trim() : "";
      if (/^\d+$/.test(retryAfterHeader)) errText += `；Retry-After: ${retryAfterHeader}s`;
      const httpErr = new Error(errText) as Error & { nonRetryable?: boolean };
      // 400 格式/大小、401 密钥、402 余额、403 风控、404 能力、421 内容审核——都不是重试能解决的。
      // 百炼同样用 4xx 表达参数与鉴权错误，两组码都有交集，故共用一套判定。
      if ([400, 401, 402, 403, 404, 421].includes(res.status)) httpErr.nonRetryable = true;
      throw httpErr;
    }
    emitAsrLifecycle(observer, {
      type: "response-start",
      timeoutMs: CHAT_INPUT_SSE_IDLE_TIMEOUT_MS,
      deadlineAt: Date.now() + CHAT_INPUT_SSE_IDLE_TIMEOUT_MS,
    });
    const contentType = res.headers && typeof res.headers.get === "function" ? String(res.headers.get("content-type") || "").toLowerCase() : "";
    const canReadStream = contentType.includes("text/event-stream") && res.body && typeof res.body.getReader === "function";
    if (!canReadStream) {
      // 服务端忽略 stream 参数（直接回整包 JSON）或当前环境不支持流式读取：回落到旧的非流式解析。
      // 关键：body 读取（res.json）必须在 timer 清除之前完成，否则服务端 200 后挂起 body 会永久 hang
      // 卡死该 session 的 writeQueue。json() 失败必须往外抛（abort 由下面统一报超时，解析失败显式报错）——
      // 绝不可静默换成 {}，否则超时/断流被吞成"空转写"，段被标成功并删缓存音频 = 静默丢段。
      let data;
      try {
        data = await res.json();
      } catch (e) {
        if (controller && controller.signal && controller.signal.aborted) throw e; // 外层 catch 统一报超时
        throw new Error(`${profile.label} 响应解析失败（HTTP ${res.status} 但响应体非法或中断）：${(e && e.message) || e}`);
      }
      const apiErr = data && data.error;
      if (typeof apiErr === "string" && apiErr.trim()) {
        throw new Error(`${profile.label} 返回错误：${apiErr.trim()}`);
      }
      if (apiErr && (apiErr.message || apiErr.code)) {
        const bodyErr = new Error(`${profile.label} 返回错误${apiErr.code ? `（${apiErr.code}）` : ""}：${apiErr.message || "未知错误"}`) as Error & { nonRetryable?: boolean };
        if (/^4/.test(String(apiErr.code || ""))) bodyErr.nonRetryable = true;
        throw bodyErr;
      }
      const text = extractApimimoAsrText(data);
      emitAsrLifecycle(observer, {
        type: "stream-progress",
        receivedChars: String(text || "").length,
        timeoutMs: CHAT_INPUT_SSE_IDLE_TIMEOUT_MS,
        deadlineAt: Date.now() + CHAT_INPUT_SSE_IDLE_TIMEOUT_MS,
      });
      return text;
    }
    // —— SSE 流式路径 ——：逐网络分片解码、按行切分，data: 事件交给纯累加器 applyApimimoSseData。
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const acc = { text: "", finishReason: null, done: false };
    let lastProgressSignalAt = 0;
    const feedLine = (line) => {
      const trimmed = String(line || "").trim();
      if (!trimmed.startsWith("data:")) return; // event:/id:/注释行等一律忽略
      applyApimimoSseData(acc, trimmed.slice(5).trim());
    };
    let lineBuffer = "";
    for (;;) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;
      // 每收到一个网络分片就重置空闲计时：数据还在流动就不判超时（首字节到达后即切入 60s 空闲档）。
      armPhaseTimer(CHAT_INPUT_SSE_IDLE_TIMEOUT_MS, `${Math.round(CHAT_INPUT_SSE_IDLE_TIMEOUT_MS / 1000)} 秒内无新数据`);
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || ""; // 最后一段可能是半行，留到下一分片
      for (const line of lines) feedLine(line);
      const progressAt = Date.now();
      if (lastProgressSignalAt === 0 || progressAt - lastProgressSignalAt >= 1500) {
        lastProgressSignalAt = progressAt;
        emitAsrLifecycle(observer, {
          type: "stream-progress",
          receivedChars: String(acc.text || "").length,
          timeoutMs: CHAT_INPUT_SSE_IDLE_TIMEOUT_MS,
          deadlineAt: progressAt + CHAT_INPUT_SSE_IDLE_TIMEOUT_MS,
        });
      }
      if (acc.done) break;
    }
    const tail = lineBuffer + decoder.decode();
    if (tail) for (const line of tail.split(/\r?\n/)) feedLine(line);
    if (acc.done) { try { await reader.cancel(); } catch { /* intentionally empty */ } }
    // 反静默截断的完成规则：
    // 1) finish_reason === "length"：输出撞服务的单次 max tokens 被截断。保住已转出的部分（半截 >> 整块丢）+
    //    可见标记 + 告警，不再硬失败（此前硬失败 nonRetryable 会让整块永久丢，比截断更糟）。
    //    MiMo 的 2K 输出上限使此路可能触发（切块已收窄到 2 分钟）；百炼无该上限，一般不触发。
    if (acc.finishReason === "length") {
      const salvaged = String(acc.text || "").trim();
      if (salvaged) {
        console.warn(`[QnALog] ${profile.label} 输出触顶被截断，已保住 ${salvaged.length} 字（末尾可能缺失）`);
        return `${salvaged}\n_[本段较长，末尾可能有少量内容未转完]_`;
      }
      throw chatInputAudioPermanentError(`${profile.label} 输出触顶被截断且无可保留文本：请缩短切块时长后重试`);
    }
    // 2) 收到 [DONE] 或非 length 的 finish_reason：正常完成，返回累积文本（空文本由调用方按软失败处理）；
    // 3) 两者都没有（连接中途断开）：绝不把半截文本当成功返回——那会重新引入"静默丢段"这一类 bug。
    if (!acc.done && !acc.finishReason) {
      throw new Error(`转写流中断（已收到 ${acc.text.length} 字，未收到结束标记）`);
    }
    return String(acc.text || "").trim();
  } catch (e) {
    if (controller && controller.signal && controller.signal.aborted) {
      // 保留"超时"关键字：isTransientAsrError 据此归为瞬时错误，导入重试链路才会自动重试。
      throw new Error(`转写请求超时：${abortHint || "等待响应超时"}；录音文件已保留，可稍后重试或降低 ASR 并发数`);
    }
    if (isAsrTransportError(e)) {
      const originalMessage = String((e && e.message) || e || "网络连接失败");
      const transportError = new Error("无法连接转写服务；音频已保留，恢复连接后可继续重试") as Error & {
        asrTransport?: boolean;
        statusDetail?: string;
      };
      transportError.name = "AsrTransportError";
      transportError.asrTransport = true;
      transportError.statusDetail = originalMessage;
      throw transportError;
    }
    throw e;
  } finally {
    if (phaseTimer !== null) window.clearTimeout(phaseTimer);
    if (totalTimer !== null) window.clearTimeout(totalTimer);
  }
}

export async function requestChatInputAudioChunkWithEmptyRetry(
  profile: ChatInputAudioProfile,
  plugin,
  provider,
  prepared,
  endpoint,
  chunkIndex,
  chunkCount,
  requestChunk,
  wait = delayMs,
  observer?: AsrLifecycleObserver,
) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const part = String(await requestChunk(
      provider,
      prepared,
      endpoint,
      observer
        ? (signal) => observer(Object.assign({}, signal, {
          providerChunkIndex: chunkIndex,
          providerChunkCount: chunkCount,
        }))
        : undefined,
    ) || "").trim();
    if (part) return part;
    try {
      if (plugin && plugin.diagnostics && typeof plugin.diagnostics.logDiagnostic === "function") {
        await plugin.diagnostics.logDiagnostic("warn", `asr.${profile.diagnosticSlug}_empty_chunk`, `${profile.shortLabel} 单块转写为空`, {
          chunkIndex,
          chunkCount,
          chunkBytes: prepared && prepared.blob && prepared.blob.size,
          attempt,
        });
      }
    } catch { /* intentionally empty */ }
    if (attempt < 2) {
      const retryDelayMs = pickAsrRetryDelayMs("empty result", attempt);
      emitAsrLifecycle(observer, {
        type: "retry-wait",
        retryDelayMs,
        retryAt: Date.now() + retryDelayMs,
        error: `服务内部第 ${chunkIndex + 1}/${chunkCount} 块返回空结果`,
        providerChunkIndex: chunkIndex,
        providerChunkCount: chunkCount,
      });
      await wait(retryDelayMs);
    }
  }
  throw new Error(`${profile.shortLabel} 第 ${chunkIndex + 1}/${chunkCount} 块连续返回空结果；音频已保留，可稍后重试`);
}

export async function transcribeAudioWithChatInputAudio(
  profile: ChatInputAudioProfile,
  plugin,
  provider,
  blob,
  mime,
  vocabularyGroups,
  observer?: AsrLifecycleObserver,
) {
  const chunks = await buildChatInputAudioChunks(profile, blob, mime);
  const endpoint = normalizeApimimoAsrEndpoint(provider.endpoint);
  // 顺序转写各块（保留时序，避免并发触发限流），拼接后对全文统一做热词修正。
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    // HTTP 200 但空文本通常是服务端瞬时异常。只重试当前块一次，避免重跑此前已成功的块并重复计费。
    parts.push(await requestChatInputAudioChunkWithEmptyRetry(
      profile,
      plugin,
      provider,
      chunks[i],
      endpoint,
      i,
      chunks.length,
      (p, prepared, url, obs) => requestChatInputAudioChunk(profile, p, prepared, url, obs),
      delayMs,
      observer,
    ));
  }
  const rawText = parts.join(" ").replace(/\s+/g, " ").trim();
  const cleaned = cleanApimimoAsrRepeatedLoops(rawText);
  if (cleaned.suppressedChars > 0) {
    try {
      await plugin.diagnostics.logDiagnostic("warn", `asr.${profile.diagnosticSlug}_repeat_detected`, `${profile.shortLabel} 转写疑似存在重复循环，已保留原始转写`, {
        suppressedChars: cleaned.suppressedChars,
        suppressedRepeats: cleaned.suppressedRepeats,
        chunkCount: chunks.length,
      });
    } catch { /* intentionally empty */ }
  }
  return applyVocabularyCorrections(rawText, vocabularyGroups).trim();
}

export async function requestApimimoAsrChunk(
  provider,
  prepared,
  endpoint,
  observer?: AsrLifecycleObserver,
) {
  return await requestChatInputAudioChunk(APIMIMO_PROFILE, provider, prepared, endpoint, observer);
}

/** MiMo 入口。协议实现与百炼共用，此函数只固定 profile。 */
export async function requestApimimoAsrChunkWithEmptyRetry(
  plugin,
  provider,
  prepared,
  endpoint,
  chunkIndex,
  chunkCount,
  requestChunk = requestApimimoAsrChunk,
  wait = delayMs,
  observer?: AsrLifecycleObserver,
) {
  return await requestChatInputAudioChunkWithEmptyRetry(
    APIMIMO_PROFILE,
    plugin,
    provider,
    prepared,
    endpoint,
    chunkIndex,
    chunkCount,
    requestChunk,
    wait,
    observer,
  );
}

export async function transcribeAudio(
  plugin,
  blob,
  mime,
  providerOverride?,
  observer?: AsrLifecycleObserver,
) {
  // providerOverride 可为：provider id 字符串（走注册表解析）或完整 provider 对象（快速口述专用服务直传）。
  const p = (providerOverride && typeof providerOverride === "object")
    ? providerOverride
    : resolveTranscribeProvider(plugin, providerOverride);
  if (!p.endpoint) throw new Error(`转写服务地址未配置（当前服务：${p.name || p.id}）`);
  assertSafeServiceEndpoint(p.endpoint, "http", "转写服务地址");
  if (!p.apiKey && !canOmitServiceApiKey(p.endpoint)) throw new Error(`转写访问密钥未配置（当前服务：${p.name || p.id}）`);
  if (!p.model)    throw new Error(`转写模型名称未配置（当前服务：${p.name || p.id}）`);
  const vocabularyGroups = await loadVocabularyGroups(plugin);
  const chatInputProfile = getChatInputAudioProfile(Object.assign({ id: p.id }, p));
  if (chatInputProfile) {
    return await transcribeAudioWithChatInputAudio(chatInputProfile, plugin, p, blob, mime, vocabularyGroups, observer);
  }
  const form = new FormData();
  const diarizationOptions = getSpeakerDiarizationRequestOptions(p);
  const ext = extFromMime(mime);
  form.append("file", blob, `recording.${ext}`);
  form.append("model", p.model);
  if (p.language && p.language !== "auto") form.append("language", p.language);
  form.append("response_format", diarizationOptions.responseFormat);
  if (diarizationOptions.chunkingStrategy) form.append("chunking_strategy", diarizationOptions.chunkingStrategy);
  const peopleHotwords = await buildPeopleHotwordsForAsr(plugin, p);
  const promptText = buildVocabularyPrompt(vocabularyGroups, peopleHotwords);
  if (promptText && diarizationOptions.supportsPrompt) form.append("prompt", promptText);
  const timeoutMs = getTranscribeRequestTimeoutMs(p, blob && blob.size);
  const requestStartedAt = Date.now();
  emitAsrLifecycle(observer, {
    type: "request-start",
    timeoutMs,
    deadlineAt: requestStartedAt + timeoutMs,
  });
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    // 用 window.fetch（行为同 fetch、避开 no-restricted-globals）：ASR 上传走 FormData + AbortController 保持可取消；requestUrl 仅供非流式调用方。
    res = await window.fetch(p.endpoint, {
      method: "POST",
      headers: p.apiKey ? { "Authorization": `Bearer ${p.apiKey}` } : {},
      body: form,
      signal: controller ? controller.signal : undefined,
    });
    emitAsrLifecycle(observer, {
      type: "response-start",
      timeoutMs,
      deadlineAt: requestStartedAt + timeoutMs,
    });
  } catch (e) {
    if (timer) window.clearTimeout(timer);
    if (controller && controller.signal && controller.signal.aborted) {
      throw new Error(`转写请求超时：${Math.round(timeoutMs / 1000)} 秒内没有响应；录音文件已保留，可稍后重试或降低 ASR 并发数`);
    }
    throw e;
  }
  // 关键：把超时计时器保留到 body 读取完成再清。否则服务端 hang 在 body 传输（连接不断）会让
  // res.json()/res.text() 永久挂起 → 卡死整条 writeQueue，录音继续但纪要再不更新。
  try {
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      let errText = buildTranscribeHttpError(res, msg, p, blob, mime);
      // 限流时服务端可能带 Retry-After（秒）：拼进错误信息，供 pickAsrRetryDelayMs 按服务端要求退避。
      const retryAfterHeader = res.headers && typeof res.headers.get === "function" ? String(res.headers.get("retry-after") || "").trim() : "";
      if (/^\d+$/.test(retryAfterHeader)) errText += `；Retry-After: ${retryAfterHeader}s`;
      throw new Error(errText);
    }
    // json() 失败必须显式报错——静默换 {} 会把超时/断流吞成"空转写"，段被标成功并删缓存音频 = 静默丢段。
    let data;
    try {
      data = await res.json();
    } catch (e) {
      if (controller && controller.signal && controller.signal.aborted) {
        throw new Error(`转写请求超时：${Math.round(timeoutMs / 1000)} 秒内响应未读完；录音文件已保留，可稍后重试或降低 ASR 并发数`);
      }
      throw new Error(`转写响应解析失败（HTTP ${res.status} 但响应体非法或中断）：${(e && e.message) || e}`);
    }
    // 取最终文本：若服务返回了说话人分离信息（segments[].speaker 或内联 [SPEAKER_00]），归一成 [说话人N] 前缀；否则同旧行为。
    const rawText = extractTranscriptText(data);
    emitAsrLifecycle(observer, {
      type: "stream-progress",
      receivedChars: String(rawText || "").length,
      timeoutMs,
      deadlineAt: requestStartedAt + timeoutMs,
    });
    return applyVocabularyCorrections(rawText, vocabularyGroups).trim();
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
