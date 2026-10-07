import { qnalogArrayBufferToBase64 } from "./clients";
import { assertSafeServiceEndpoint } from "../shared/util-llm-endpoint";
import { t } from "../shared/i18n";

export const DASHSCOPE_FLASH_ASR_PROTOCOL = "dashscope-flash-input-audio";
export const DASHSCOPE_FLASH_ASR_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

export interface DashScopeFlashProvider {
  endpoint: string;
  apiKey: string;
  model: string;
  language?: string;
}

export interface DashScopeFlashAudio {
  blob: Blob;
  mime: string;
}

export interface DashScopeFlashChunkResult {
  text: string;
  rawText: string;
}
export interface DashScopeFlashLifecycleSignal {
  type: "request-start" | "response-start";
  at: number;
  timeoutMs?: number;
  deadlineAt?: number;
}

function audioFormat(mime: string): string {
  const value = String(mime || "").toLowerCase().split(";")[0].trim();
  if (value === "audio/mpeg") return "mp3";
  if (value === "audio/x-wav") return "wav";
  return value.startsWith("audio/") ? value.slice("audio/".length) : "";
}

function wavSampleRate(data: ArrayBuffer): number | null {
  if (data.byteLength < 28) return null;
  const bytes = new Uint8Array(data, 0, 12);
  const signature = String.fromCharCode(...bytes);
  if (signature.slice(0, 4) !== "RIFF" || signature.slice(8, 12) !== "WAVE") return null;
  const rate = new DataView(data).getUint32(24, true);
  return rate > 0 ? rate : null;
}

function responseError(data: unknown, apiKey: string): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const root = data as Record<string, unknown>;
  const output = root.output && typeof root.output === "object" ? root.output as Record<string, unknown> : {};
  const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : {};
  const codeValue = output.code ?? root.code ?? error.code;
  const messageValue = output.message ?? root.message ?? error.message;
  const code = typeof codeValue === "string" ? codeValue.trim() : typeof codeValue === "number" ? String(codeValue) : "";
  const message = typeof messageValue === "string" ? messageValue.trim() : typeof messageValue === "number" ? String(messageValue) : "";
  const redact = (value: string): string => {
    let safe = apiKey ? value.split(apiKey).join("[redacted]") : value;
    safe = safe
      .replace(/data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi, "[audio omitted]")
      .replace(/\b[A-Za-z0-9+/_=-]{128,}\b/g, "[binary data omitted]")
      .replace(/\s+/g, " ")
      .trim();
    return safe.slice(0, 300);
  };
  return [code, message].filter(Boolean).map(redact).filter(Boolean).join(": ");
}

/** Sends one audio chunk using the native multimodal-generation HTTP API. */
export async function requestDashScopeFlashChunk(
  provider: DashScopeFlashProvider,
  audio: DashScopeFlashAudio,
  timeoutMs: number,
  observer?: (signal: DashScopeFlashLifecycleSignal) => void,
): Promise<DashScopeFlashChunkResult> {
  assertSafeServiceEndpoint(provider.endpoint, "http", t("Transcription service URL"));
  const format = audioFormat(audio.mime);
  if (!format) throw new Error(t("Could not determine the audio format for the Bailian request."));
  const audioBytes = await audio.blob.arrayBuffer();
  const audioData = `data:audio/${format};base64,${qnalogArrayBufferToBase64(audioBytes)}`;
  const language = String(provider.language || "").trim().toLowerCase();
  const parameters: Record<string, unknown> = { format };
  const sampleRate = format === "wav" ? wavSampleRate(audioBytes) : null;
  if (sampleRate !== null) parameters.sample_rate = String(sampleRate);
  if (language && language !== "auto" && /^[a-z]{2,3}$/.test(language)) parameters.language_hints = [language];
  const payload = {
    model: provider.model,
    input: {
      messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: audioData } }] }],
    },
    parameters,
  };
  const requestStartedAt = Date.now();
  const notify = (signal: Omit<DashScopeFlashLifecycleSignal, "at">) => {
    try { observer?.({ ...signal, at: Date.now() }); } catch { /* progress observers must not affect transcription */ }
  };
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  notify({ type: "request-start", timeoutMs, deadlineAt: requestStartedAt + timeoutMs });
  try {
    const response = await window.fetch(provider.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-SSE": "disable",
      },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
    notify({ type: "response-start", timeoutMs, deadlineAt: requestStartedAt + timeoutMs });
    if (!response.ok) {
      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        // Keep the status-only error when the service returns a non-JSON body.
      }
      const detail = responseError(data, provider.apiKey);
      const message = detail
        ? t("Bailian speech recognition request failed (HTTP {0}): {1}.")
          .replace("{0}", String(response.status))
          .replace("{1}", detail)
        : t("Bailian speech recognition request failed (HTTP {0}).").replace("{0}", String(response.status));
      const error = new Error(message) as Error & { nonRetryable?: boolean };
      if ([400, 401, 402, 403, 404, 421].includes(response.status)) error.nonRetryable = true;
      throw error;
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      if (controller?.signal.aborted) throw error;
      throw new Error(t("Failed to parse the Bailian speech recognition response."));
    }
    const serviceError = responseError(data, provider.apiKey);
    if (serviceError) {
      const error = new Error(t("Bailian speech recognition returned an error: {0}").replace("{0}", serviceError)) as Error & { nonRetryable?: boolean };
      if (/^4\d{2}/.test(serviceError)) error.nonRetryable = true;
      throw error;
    }
    const output = data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).output
      : undefined;
    const text = output && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, unknown>).text
      : undefined;
    if (typeof text !== "string") throw new Error(t("Bailian speech recognition response has no transcript text."));
    return { text: text.trim(), rawText: text };
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new Error(t("Transcription request timed out; the audio file is kept, so you can retry later."));
    }
    if (error instanceof TypeError) {
      throw new Error(t("Could not connect to the transcription service. Check the service URL and network access from Obsidian, then retry."));
    }
    throw error;
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}
