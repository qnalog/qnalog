// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。

import { t } from "./i18n";
import { labelText } from "./note-labels";

const stringifyAsrValue = String as (value: unknown) => string;

function readAsrField(
  value: unknown,
  field: "message" | "asrTransport" | "nonRetryable" | "type" | "status" | "lastError" | "retries",
): unknown {
  if (!value) return value;
  if (typeof value === "object" || typeof value === "function") return Reflect.get(value, field);
  return undefined;
}

export function mimeFromExt(ext: string | null | undefined): string {
  const e = (ext || "").toLowerCase();
  if (e === "m4a" || e === "mp4") return "audio/mp4";
  if (e === "aac" || e === "acc") return "audio/aac";
  if (e === "mp3" || e === "mpga" || e === "mpeg") return "audio/mpeg";
  if (e === "wav") return "audio/wav";
  if (e === "ogg" || e === "oga") return "audio/ogg";
  if (e === "flac") return "audio/flac";
  if (e === "webm") return "audio/webm";
  return "audio/" + e;
}

export function extFromMime(mime: string | null | undefined): string {
  if (!mime) return "webm";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("aac")) return "aac";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("mp3")) return "mp3";
  if (mime.includes("flac")) return "flac";
  return "webm";
}

export function delayMs(ms: number): Promise<void> {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms));
}

export function isTransientAsrError(error: unknown): boolean {
  if (isAsrNonRetryableError(error)) return false;
  if (isAsrTransportError(error)) return true;
  const msg = stringifyAsrValue((readAsrField(error, "message") || error || ""));
  // 中文关键字：限流（429 提示语）、超时（转写请求超时：…）、流中断（SSE 半路断线）都必须归为瞬时错误，
  // 否则这些典型的网络性故障不会进重试。
  return /\b(429|500|502|503|504)\b|too many|rate\s*limit|timeout|timed?\s*out|network|temporarily|service unavailable|failed to fetch|empty result|限流|超时|流中断|空结果|空转写|stream interrupted/i.test(msg);
}

export function isAsrTransportError(error: unknown): boolean {
  if (isAsrNonRetryableError(error)) return false;
  if (readAsrField(error, "asrTransport") === true) return true;
  const msg = stringifyAsrValue((readAsrField(error, "message") || error || ""));
  return /\b(429|500|502|503|504)\b|too many|rate\s*limit|timeout|timed?\s*out|network(?:error)?|temporarily|service unavailable|failed to fetch|fetch failed|err_(?:internet|network|connection)|dns|enotfound|econn(?:reset|refused|aborted)|etimedout|net::|限流|超时|流中断|无法连接|连接(?:失败|中断|关闭)|网络(?:错误|不可用)|stream interrupted/i.test(msg);
}

export function isAsrNonRetryableError(error: unknown): boolean {
  if (readAsrField(error, "nonRetryable")) return true;
  const msg = stringifyAsrValue((readAsrField(error, "message") || error || ""));
  return /密钥未配置|模型名称未配置|服务地址未配置|无法解码|仅 wav\/mp3|不被 MiMo 服务端接受|不被 .{1,40} 接受|base64 仍超过|单次最多自动切|mime type must be|service address is not configured|service url is not configured|model name is not configured|api key is not configured|access key is not configured/i.test(msg);
}

export function getNextAsrTaskRetryCount(currentRetries: unknown, maxRetries: unknown, error: unknown): number {
  const current = Math.max(0, Math.floor(Number(currentRetries) || 0));
  const maximum = Math.max(1, Math.floor(Number(maxRetries) || 1));
  if (isAsrTransportError(error)) return current;
  if (isAsrNonRetryableError(error)) return Math.max(current + 1, maximum);
  return current + 1;
}

// 占位文案按当前界面语言取（labelText 必须在函数体内求值，模块期常量会把语言冻住）。
export function getTranscribeSegmentPlaceholder(
  error: unknown,
  options: { streaming?: boolean; retryable?: boolean; deferred?: boolean } = {},
): string {
  const streaming = !!options.streaming;
  const retryable = options.retryable !== undefined
    ? !!options.retryable
    : (!!options.deferred || isTransientAsrError(error));
  return !streaming && retryable
    ? labelText("waitingBackground")
    : labelText("notFullyTranscribed");
}

export function getAsrTransportTaskRecoveryPatch(
  task: unknown,
  maxRetries: unknown,
): { status: "pending"; retries: number; deferredReason: "service-unavailable" } | null {
  if (
    readAsrField(task, "type") !== "transcribe"
    || readAsrField(task, "status") !== "failed"
    || !isAsrTransportError(readAsrField(task, "lastError") || "")
  ) {
    return null;
  }
  const maximum = Math.max(1, Math.floor(Number(maxRetries) || 1));
  return {
    status: "pending",
    retries: Math.min(
      Math.max(0, Number(readAsrField(task, "retries")) || 0),
      Math.max(0, maximum - 1),
    ),
    deferredReason: "service-unavailable",
  };
}

export function pickMimeType(preferOpus: boolean): string {
  // 默认 mp4/AAC 优先：SiliconFlow 等云端 ASR 原生收 m4a，直接上传最稳；WebM 作为 Chromium 兜底。
  // preferOpus（选 APIMiMo 时传入）：MiMo 服务端只收 wav/mp3（实测发 audio/mp4 直接 400 拒绝），
  // 段落必须本机转码成 WAV 再发；而 Electron 的 decodeAudioData 解不了 AAC、能解 Opus——
  // 所以此时必须录 WebM/Opus，否则每段都卡死在"无法解码"。
  const candidates = preferOpus
    ? ["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/mp4;codecs=mp4a.40.2","audio/mp4"]
    : ["audio/mp4;codecs=mp4a.40.2","audio/mp4","audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus"];
  for (const c of candidates) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  return "";
}

export function assertAudioCaptureSupported(): void {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    throw new Error(t("This Obsidian environment does not support microphone recording. Update Obsidian, or use QnALog on desktop."));
  }
  if (typeof MediaRecorder === "undefined") {
    throw new Error(t("This Obsidian environment does not support MediaRecorder, so recording is unavailable right now. You can record with a system app first and then import the audio."));
  }
}
