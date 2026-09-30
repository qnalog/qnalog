/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's ASR layer reads untyped JSON from service responses; these type-only rules yield no actionable findings here and are tracked for incremental typing */
// OpenRouter 整文件转写 + 说话人分离。
//
// 与 asr/transcribe.ts 的 OpenAI 兼容路径分开，因为请求形状不同：
// 那条路走 multipart/form-data（file + model），而说话人分离的参数必须放进
// provider.options.<上游 slug> 这个嵌套对象里，multipart 传不了结构化 JSON。
// 因此这里改发 JSON 正文（input_audio.data 为 base64 原始字节）。
//
// 上游 slug 由模型决定：模型详情接口的 endpoints[].tag 就是该键
// （例如 microsoft/mai-transcribe-2 只有 azure 一个上游，tag 即 azure）。
// 拿到 slug 后按 OpenRouter 文档给出的字段名传分离开关。
//
// 依据：https://openrouter.ai/docs/guides/overview/multimodal/stt
//   - 端点 /api/v1/audio/transcriptions，JSON 正文
//   - response_format=verbose_json 才返回 segments[].speaker
//   - 分离开关经 provider.options 按上游 slugs 传递，字段名沿用该上游自己的 API

import * as obsidian from "obsidian";
import { assertSafeServiceEndpoint } from "../shared/util-llm-endpoint";
import { qnalogArrayBufferToBase64 } from "./clients";
import { extractTranscriptText, friendlySpeakerLabel } from "./speaker-labels";
import { t } from "../shared/i18n";
import type { AsrTranscriptResult, AsrTranscriptUnit } from "./transcript-result";
import { splitTranscriptTextUnits } from "../transcript/session-transcript";

export const OPENROUTER_DIARIZE_PROTOCOL = "openrouter-diarize";

interface ResolvedProvider {
  id?: string;
  name?: string;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  language?: string;
  protocol?: string;
}

export interface OpenRouterDiarizeResult extends AsrTranscriptResult {
  sentenceCount: number;
  durationMs?: number;
}

export function isOpenRouterDiarizeProvider(provider: unknown): boolean {
  const value = provider && typeof provider === "object" ? provider as ResolvedProvider : {};
  return String(value.protocol || "").trim().toLowerCase() === OPENROUTER_DIARIZE_PROTOCOL;
}

function mimeToFormat(mime: string): string {
  const m = String(mime || "").toLowerCase();
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("webm")) return "webm";
  if (m.includes("flac")) return "flac";
  if (m.includes("aac")) return "aac";
  return "mp3";
}

/**
 * 查该模型的上游 slug。多个上游时取第一个——分离开关会按 slug 分别传递，
 * 只有真正服务本次请求的那个上游的选项会被转发。
 */
async function resolveUpstreamSlug(model: string): Promise<string> {
  const id = String(model || "").trim();
  if (!id) return "";
  const url = `https://openrouter.ai/api/v1/models/${id}/endpoints`;
  try {
    const res = await obsidian.requestUrl({ url, method: "GET" });
    const data = res && res.json ? res.json : null;
    const payload = data && data.data ? data.data : data;
    const endpoints = payload && Array.isArray(payload.endpoints) ? payload.endpoints : [];
    for (const ep of endpoints) {
      const tag = String((ep && ep.tag) || "").trim();
      if (tag) return tag;
    }
  } catch (e) {
    console.warn("[QnALog] 查询 OpenRouter 上游失败，将不带分离参数重试", e);
  }
  return "";
}

function providerTimeMs(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

function speakerValue(value: Record<string, unknown>): string | null {
  const candidate = value.speaker ?? value.speaker_id ?? value.speakerId;
  return typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : null;
}

function readDiarizedUnits(payload: Record<string, unknown>): AsrTranscriptUnit[] {
  const speakerMap = new Map<string, string>();
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  if (segments.length) {
    return segments.flatMap((value): AsrTranscriptUnit[] => {
      if (!value || typeof value !== "object" || typeof value.text !== "string" || !value.text.trim()) return [];
      const row = value as Record<string, unknown>;
      const speakerId = speakerValue(row);
      const startMs = providerTimeMs(row.start ?? row.start_time);
      const endMs = providerTimeMs(row.end ?? row.end_time);
      const hasRange = startMs !== null && endMs !== null && endMs >= startMs;
      return [{
        rawText: row.text as string,
        normalizedText: row.text as string,
        speakerId,
        speakerName: speakerId ? friendlySpeakerLabel(speakerId, speakerMap) : null,
        startMs: hasRange ? startMs : null,
        endMs: hasRange ? endMs : null,
        timing: hasRange ? "provider" : "unknown",
      }];
    });
  }

  const words = Array.isArray(payload.words) ? payload.words : [];
  const units: AsrTranscriptUnit[] = [];
  let pending: { rawText: string; speakerId: string | null; startMs: number | null; endMs: number | null } | null = null;
  const flush = () => {
    if (!pending || !pending.rawText.trim()) { pending = null; return; }
    const hasRange = pending.startMs !== null && pending.endMs !== null && pending.endMs >= pending.startMs;
    units.push({
      rawText: pending.rawText,
      normalizedText: pending.rawText,
      speakerId: pending.speakerId,
      speakerName: pending.speakerId ? friendlySpeakerLabel(pending.speakerId, speakerMap) : null,
      startMs: hasRange ? pending.startMs : null,
      endMs: hasRange ? pending.endMs : null,
      timing: hasRange ? "provider" : "unknown",
    });
    pending = null;
  };
  for (const value of words) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const rawWord = typeof row.word === "string" ? row.word : typeof row.text === "string" ? row.text : "";
    if (!rawWord) continue;
    const speakerId = speakerValue(row);
    if (pending && pending.speakerId !== speakerId) flush();
    const startMs = providerTimeMs(row.start);
    const endMs = providerTimeMs(row.end);
    if (!pending) pending = { rawText: "", speakerId, startMs, endMs };
    else pending.endMs = endMs;
    pending.rawText += rawWord;
    if (/[。！？.!?;；]$/.test(rawWord.trim())) flush();
  }
  flush();
  return units;
}

export async function transcribeWithOpenRouterDiarize(
  provider: ResolvedProvider,
  blob: Blob,
  mime: string,
  options: { timeoutMs?: number } = {},
): Promise<OpenRouterDiarizeResult> {
  const endpoint = String(provider && provider.endpoint || "").trim();
  if (!endpoint) throw new Error(t("Transcription service URL is not configured."));
  assertSafeServiceEndpoint(endpoint, "http", t("Transcription service URL"));
  if (!provider.apiKey) throw new Error(t("Transcription access key is not configured."));
  if (!provider.model) throw new Error(t("Transcription model name is not configured."));

  const buffer = await blob.arrayBuffer();
  const slug = await resolveUpstreamSlug(String(provider.model));

  const body: Record<string, unknown> = {
    model: provider.model,
    input_audio: { data: qnalogArrayBufferToBase64(buffer), format: mimeToFormat(mime) },
    // verbose_json 才会返回 segments[].speaker；缺了它说话人分离拿不到标签。
    response_format: "verbose_json",
    timestamp_granularities: ["segment", "word"],
  };
  if (provider.language && provider.language !== "auto") body.language = provider.language;
  // 分离开关按上游自己的字段名传递。Azure 用 diarization.enabled
  // （OpenRouter 文档的示例即以 azure 上游演示 mai-transcribe-2 的分离）。
  if (slug) {
    body.provider = { options: { [slug]: { diarization: { enabled: true } } } };
  }

  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 600_000);
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  let data: unknown;
  try {
    const res = await window.fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      let detail = msg;
      try { detail = JSON.stringify(JSON.parse(msg)).slice(0, 400); } catch { /* 保留原文本 */ }
      throw new Error(
        detail
          ? t("Transcription service returned HTTP {0}: {1}").replace("{0}", String(res.status)).replace("{1}", detail)
          : t("Transcription service returned HTTP {0}").replace("{0}", String(res.status)),
      );
    }
    try {
      data = await res.json();
    } catch (e) {
      throw new Error(t("Could not parse the transcription response: {0}").replace("{0}", (e && e.message) || e));
    }
  } catch (e) {
    if (controller && controller.signal && controller.signal.aborted) {
      throw new Error(t("Transcription request timed out; the audio file is kept, so you can retry later."));
    }
    throw e;
  } finally {
    if (timer) window.clearTimeout(timer);
  }

  const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const text = String(extractTranscriptText(payload) || "").trim();
  if (!text) throw new Error(t("The transcription service returned no usable text."));
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  const responseUnits = readDiarizedUnits(payload);
  const rawField = typeof payload.text === "string" ? payload.text
    : typeof payload.transcript === "string" ? payload.transcript
      : typeof payload.result === "string" ? payload.result : null;
  const units = responseUnits.length || rawField === null ? responseUnits : splitTranscriptTextUnits(rawField).map((rawText): AsrTranscriptUnit => ({
    rawText,
    normalizedText: rawText,
    speakerId: null,
    speakerName: null,
    startMs: null,
    endMs: null,
    timing: "unknown",
  }));
  const durationSec = Number(payload.duration);
  return {
    text,
    rawText: responseUnits.length ? null : rawField,
    providerId: String(provider.id || ""),
    units,
    sentenceCount: segments.length || units.length,
    durationMs: Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec * 1000) : undefined,
  };
}


/**
 * 无音频连通性检测：调 OpenRouter 的密钥查询接口。
 *
 * 转写端点必须上传音频才会鉴权，拿不到「密钥对不对」的结论；
 * `/api/v1/key` 是同一套鉴权，未带有效密钥返回 401，因此用它做只读检测。
 * 不发送音频，也不产生识别计费。
 */
export async function testOpenRouterDiarizeProvider(
  provider: ResolvedProvider,
): Promise<{ providerId: string; model: string; detail: string }> {
  const apiKey = String(provider && provider.apiKey || "").trim();
  const model = String(provider && provider.model || "").trim();
  if (!apiKey) throw new Error(t("Transcription access key is not configured."));
  if (!model) throw new Error(t("Transcription model name is not configured."));

  const res = await window.fetch("https://openrouter.ai/api/v1/key", {
    method: "GET",
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(t("The access key was rejected by OpenRouter (HTTP {0}).").replace("{0}", String(res.status)));
  }
  if (!res.ok) {
    throw new Error(t("OpenRouter returned HTTP {0}").replace("{0}", String(res.status)));
  }
  const payload = await res.json().catch(() => null);
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>).data : null;
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  // label 是接口返回的任意值：非字符串时不要走 String()，否则会得到 "[object Object]"。
  const label = typeof record.label === "string" ? record.label.trim() : "";
  return {
    providerId: String(provider.id || ""),
    model,
    detail: label ? t("Access key valid ({0})").replace("{0}", label) : t("Access key valid"),
  };
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of dynamic-typing region */
