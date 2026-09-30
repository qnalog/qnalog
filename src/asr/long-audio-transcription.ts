import { requestUrl } from "obsidian";
import { delayMs } from "../shared/util-audio";
import { formatElapsed } from "../shared/util-common";
import { resolveTranscribeProvider, transcribeAudio } from "./transcribe";
import { buildDashScopeTranscriptionParameters } from "./diarization";

import { t } from "../shared/i18n";
import { isOpenRouterDiarizeProvider, testOpenRouterDiarizeProvider, transcribeWithOpenRouterDiarize } from "./openrouter-diarize";
import type { AsrTranscriptResult, AsrTranscriptUnit } from "./transcript-result";
import { splitTranscriptTextUnits } from "../transcript/session-transcript";
export const DASHSCOPE_FILETRANS_PROTOCOL = "dashscope-filetrans";

export interface LongAudioTranscriptionOptions {
  providerId?: string;
  diarization?: boolean;
  speakerCount?: number;
  fileName?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  audioDurationMs?: number;
  onProgress?: (progress: LongAudioProgress) => void;
}

export interface LongAudioProgress {
  phase: "upload" | "submit" | "waiting" | "download";
  label: string;
  detail?: string;
  taskId?: string;
}

export interface LongAudioTranscriptionResult extends AsrTranscriptResult {
  taskId?: string;
  sentenceCount: number;
  durationMs?: number;
}

type JsonRecord = Record<string, unknown>;

interface HttpResponseLike {
  status: number;
  text?: string;
}

interface ImportTranscribeProvider {
  id: string;
  endpoint: string;
  apiKey: string;
  model: string;
  language?: string;
  protocol?: string;
}

export const DASHSCOPE_IMPORT_MODEL_OPTIONS = ["fun-asr", "paraformer-v2"] as const;

export function estimateCloudTranscriptionDuration(audioDurationMs: unknown): { minMs: number; maxMs: number } {
  const durationMs = Math.max(0, Number(audioDurationMs) || 0);
  if (!durationMs) return { minMs: 2 * 60_000, maxMs: 10 * 60_000 };
  const minMs = Math.min(12 * 60_000, Math.max(45_000, Math.round(durationMs * 0.025)));
  const maxMs = Math.min(30 * 60_000, Math.max(3 * 60_000, Math.round(durationMs * 0.08)));
  return { minMs, maxMs: Math.max(maxMs, minMs + 60_000) };
}

function formatEstimateMinutes(ms: number): string {
  return String(Math.max(1, Math.ceil(ms / 60_000)));
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function asNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function makeServiceError(prefix: string, payload: unknown): Error {
  const value = asRecord(payload);
  const output = asRecord(value.output);
  const message = asString(output.message) || asString(value.message) || asString(output.code) || asString(value.code);
  return new Error(message ? t("{0}: {1}").replace("{0}", prefix).replace("{1}", message) : prefix);
}

function parseJsonText(text: unknown): unknown {
  const raw = asString(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function parseServiceJsonResponse(response: HttpResponseLike, phase: string): JsonRecord {
  const status = Number(response && response.status) || 0;
  const raw = typeof response?.text === "string" ? response.text.trim() : "";
  if (!raw) {
    throw new Error(t("{0} returned an empty response (HTTP {1}).").replace("{0}", phase).replace("{1}", String(status || t("unknown"))));
  }
  const parsed = parseJsonText(raw);
  if (!parsed) {
    throw new Error(t("{0} did not return valid JSON (HTTP {1}): {2}").replace("{0}", phase).replace("{1}", String(status || t("unknown"))).replace("{2}", raw.slice(0, 180)));
  }
  return asRecord(parsed);
}

function requireSuccessfulJsonResponse(response: HttpResponseLike, phase: string): JsonRecord {
  const status = Number(response && response.status) || 0;
  const raw = typeof response?.text === "string" ? response.text.trim() : "";
  const parsed = raw ? parseJsonText(raw) : null;
  if (status < 200 || status >= 300) {
    const payload = parsed || (raw ? { message: raw.slice(0, 180) } : {});
    throw makeServiceError(t("{0} (HTTP {1})").replace("{0}", phase).replace("{1}", String(status || t("unknown"))), payload);
  }
  return parseServiceJsonResponse(response, phase);
}

function safeUploadFileName(value: unknown, mime: string): string {
  const fallbackExt = mime.includes("wav") ? "wav"
    : mime.includes("mpeg") ? "mp3"
      : mime.includes("mp4") ? "m4a"
        : mime.includes("ogg") ? "ogg"
          : mime.includes("flac") ? "flac"
            : "webm";
  const raw = asString(value) || `qnalog-import.${fallbackExt}`;
  const normalized = raw.replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(-160);
  return /\.[a-z0-9]{2,8}$/i.test(normalized) ? normalized : `${normalized}.${fallbackExt}`;
}

export function isDashScopeFileTransProvider(provider: unknown): boolean {
  const value = asRecord(provider);
  return asString(value.protocol).toLowerCase() === DASHSCOPE_FILETRANS_PROTOCOL;
}

export function resolveImportTranscribeProvider(plugin: { settings?: unknown }) {
  const settings = asRecord(plugin && plugin.settings);
  const providerId = asString(settings.importTranscribeProvider)
    || asString(settings.activeTranscribeProvider)
    || "siliconflow";
  return resolveTranscribeProvider(plugin, providerId) as ImportTranscribeProvider;
}

function resolveTypedTranscribeProvider(
  plugin: { settings?: unknown },
  providerId: string,
): ImportTranscribeProvider {
  return resolveTranscribeProvider(plugin, providerId);
}

function validDashScopeTime(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.round(milliseconds) : null;
}

function getDashScopePlainTexts(payload: unknown): string[] {
  const root = asRecord(payload);
  const transcriptGroups = [
    root.transcripts,
    asRecord(root.output).transcripts,
    asRecord(root.result).transcripts,
    asRecord(asRecord(root.output).result).transcripts,
  ];
  const transcripts = transcriptGroups.map(asArray).find((items) => items.length) || [];
  const texts = transcripts
    .map((value) => {
      const row = asRecord(value);
      return (typeof row.transcript === "string" ? row.transcript : "")
        || (typeof row.text === "string" ? row.text : "");
    })
    .filter((text) => text.length > 0);
  if (texts.length) return texts;
  if (typeof root.text === "string") return [root.text];
  const outputText = asRecord(root.output).text;
  return typeof outputText === "string" ? [outputText] : [];
}

export function extractDashScopePlainTexts(payload: unknown): string[] {
  return getDashScopePlainTexts(payload);
}

export interface DashScopeSentence {
  beginTimeMs: number | null;
  endTimeMs: number | null;
  text: string;
  speakerId: string;
}

export function extractDashScopeSentences(payload: unknown): DashScopeSentence[] {
  const root = asRecord(payload);
  const candidates = [
    root.transcripts,
    asRecord(root.output).transcripts,
    asRecord(root.result).transcripts,
    asRecord(asRecord(root.output).result).transcripts,
  ];
  const transcripts = candidates.map(asArray).find((items) => items.length) || [];
  const sentences: DashScopeSentence[] = [];
  for (const transcriptValue of transcripts) {
    const transcript = asRecord(transcriptValue);
    for (const sentenceValue of asArray(transcript.sentences)) {
      const sentence = asRecord(sentenceValue);
      const rawText = typeof sentence.text === "string" ? sentence.text
        : typeof sentence.text === "number" ? String(sentence.text) : "";
      if (!rawText.trim()) continue;
      const beginMs = validDashScopeTime(sentence.begin_time ?? sentence.beginTime ?? sentence.start_time);
      const endMs = validDashScopeTime(sentence.end_time ?? sentence.endTime ?? sentence.stop_time);
      const hasRange = beginMs !== null && endMs !== null && endMs >= beginMs;
      sentences.push({
        beginTimeMs: hasRange ? beginMs : null,
        endTimeMs: hasRange ? endMs : null,
        text: rawText,
        speakerId: asString(sentence.speaker_id ?? sentence.speakerId ?? sentence.speaker),
      });
    }
  }
  return sentences;
}

export function composeDashScopeTranscript(payload: unknown): { text: string; sentenceCount: number; durationMs?: number } {
  const sentences = extractDashScopeSentences(payload);
  if (!sentences.length) {
    const root = asRecord(payload);
    const transcriptGroups = [
      root.transcripts,
      asRecord(root.output).transcripts,
      asRecord(root.result).transcripts,
      asRecord(asRecord(root.output).result).transcripts,
    ];
    const transcripts = transcriptGroups.map(asArray).find((items) => items.length) || [];
    const plain = transcripts
      .map((item) => asString(asRecord(item).transcript) || asString(asRecord(item).text))
      .filter(Boolean)
      .join("\n")
      || asString(root.text)
      || asString(asRecord(root.output).text);
    return { text: plain, sentenceCount: 0 };
  }

  const speakerMap = new Map<string, string>();
  const turns: Array<{ startMs: number | null; speaker: string; parts: string[] }> = [];
  for (const sentence of sentences) {
    let speaker = "";
    if (sentence.speakerId) {
      if (!speakerMap.has(sentence.speakerId)) {
        speakerMap.set(sentence.speakerId, `说话人${speakerMap.size + 1}`);
      }
      speaker = speakerMap.get(sentence.speakerId) || "";
    }
    const previous = turns[turns.length - 1];
    if (previous && previous.speaker === speaker) {
      previous.parts.push(sentence.text);
    } else {
      turns.push({ startMs: sentence.beginTimeMs, speaker, parts: [sentence.text] });
    }
  }
  const text = turns.map((turn) => {
    const timestamp = turn.startMs === null ? "" : `[${formatElapsed(turn.startMs)}]`;
    const speaker = turn.speaker ? `[${turn.speaker}]` : "";
    const prefix = [timestamp, speaker].filter(Boolean).join(" ");
    return `${prefix ? `${prefix} ` : ""}${turn.parts.join(" ").replace(/\s+/g, " ").trim()}`;
  }).join("\n\n");
  const durationMs = sentences.reduce((max, sentence) => sentence.endTimeMs === null ? max : Math.max(max, sentence.endTimeMs), 0);
  return { text, sentenceCount: sentences.length, durationMs: durationMs || undefined };
}

function dashScopeBaseUrl(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, "");
  const marker = "/api/v1/services/audio/asr/transcription";
  const index = normalized.indexOf(marker);
  return index >= 0 ? normalized.slice(0, index) : "https://dashscope.aliyuncs.com";
}

async function getDashScopeUploadPolicy(
  endpoint: string,
  apiKey: string,
  model: string,
): Promise<JsonRecord> {
  const baseUrl = dashScopeBaseUrl(endpoint);
  const policyResponse = await requestUrl({
    url: `${baseUrl}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    throw: false,
  });
  const payload = requireSuccessfulJsonResponse(policyResponse, t("Failed to get Alibaba Cloud upload credentials."));
  const policy = asRecord(payload.data);
  if (!asString(policy.upload_host) || !asString(policy.upload_dir)) {
    throw new Error(t("Alibaba Cloud upload credential response lacks an upload URL; check that the model supports audio file transcription."));
  }
  return policy;
}

export async function testImportTranscribeProvider(
  plugin: { settings?: unknown },
  providerId?: string,
): Promise<{ providerId: string; model: string; detail: string }> {
  const provider = resolveTypedTranscribeProvider(
    plugin,
    providerId || asString(asRecord(plugin && plugin.settings).importTranscribeProvider),
  );
  if (!provider.endpoint) throw new Error(t("Import transcription service URL is not configured."));
  if (!provider.apiKey) throw new Error(t("Import transcription service access key is not configured."));
  if (!provider.model) throw new Error(t("Import transcription model is not configured."));
  if (isOpenRouterDiarizeProvider(provider)) {
    return testOpenRouterDiarizeProvider(provider);
  }
  if (!isDashScopeFileTransProvider(provider)) {
    throw new Error(t("This service does not support connection testing without audio; import a short audio clip to verify."));
  }
  const policy = await getDashScopeUploadPolicy(provider.endpoint, provider.apiKey, provider.model);
  const maxSizeMb = asNumber(policy.max_file_size_mb);
  return {
    providerId: provider.id,
    model: provider.model,
    detail: maxSizeMb > 0 ? t("Single-file upload limit: {0} MB").replace("{0}", String(maxSizeMb)) : t("Upload credentials OK"),
  };
}

export async function fetchImportTranscribeModels(
  plugin: { settings?: unknown },
  providerId?: string,
): Promise<string[]> {
  const provider = resolveTypedTranscribeProvider(
    plugin,
    providerId || asString(asRecord(plugin && plugin.settings).importTranscribeProvider),
  );
  if (!isDashScopeFileTransProvider(provider)) return provider.model ? [provider.model] : [];
  if (!provider.apiKey) throw new Error(t("Please fill in the Bailian API key first."));
  const baseUrl = dashScopeBaseUrl(provider.endpoint || "");
  const response = await requestUrl({
    url: `${baseUrl}/api/v1/deployments/models?page_no=1&page_size=100&version=v1.0&model_source=base`,
    method: "GET",
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    throw: false,
  });
  const builtIns = [...DASHSCOPE_IMPORT_MODEL_OPTIONS];
  if (response.status < 200 || response.status >= 300 || !String(response.text || "").trim()) {
    return Array.from(new Set<string>([provider.model, ...builtIns].filter((id): id is string => !!id)));
  }
  const payload = parseServiceJsonResponse(response, t("Failed to fetch the Alibaba Cloud model list."));
  const records = [
    ...asArray(payload.data),
    ...asArray(payload.models),
    ...asArray(asRecord(payload.output).models),
  ];
  const remoteIds = records
    .map((item) => asString(asRecord(item).model_name ?? asRecord(item).model ?? asRecord(item).id ?? asRecord(item).name))
    .filter((id) => /(?:asr|paraformer)/i.test(id));
  return Array.from(new Set<string>([provider.model, ...builtIns, ...remoteIds].filter((id): id is string => !!id)))
    .sort((a, b) => a.localeCompare(b));
}

async function getDashScopeUploadUrl(
  endpoint: string,
  apiKey: string,
  model: string,
  blob: Blob,
  fileName: string,
): Promise<string> {
  const policy = await getDashScopeUploadPolicy(endpoint, apiKey, model);
  const maxSizeMb = asNumber(policy.max_file_size_mb);
  if (maxSizeMb > 0 && blob.size > maxSizeMb * 1024 * 1024) {
    throw new Error(t("The audio file exceeds the Alibaba Cloud temporary upload limit of {0} MB.").replace("{0}", String(maxSizeMb)));
  }
  const uploadHost = asString(policy.upload_host);
  const uploadDir = asString(policy.upload_dir).replace(/\/+$/, "");
  if (!uploadHost || !uploadDir) throw new Error(t("Alibaba Cloud did not return a valid file upload URL."));
  const key = `${uploadDir}/${safeUploadFileName(fileName, blob.type || "audio/webm")}`;
  const form = new FormData();
  form.append("OSSAccessKeyId", asString(policy.oss_access_key_id));
  form.append("policy", asString(policy.policy));
  form.append("Signature", asString(policy.signature));
  form.append("key", key);
  form.append("x-oss-object-acl", asString(policy.x_oss_object_acl) || "private");
  form.append("x-oss-forbid-overwrite", asString(policy.x_oss_forbid_overwrite) || "true");
  form.append("success_action_status", "200");
  form.append("file", blob, safeUploadFileName(fileName, blob.type || "audio/webm"));
  // OSS policy upload requires multipart FormData. Obsidian requestUrl does not expose an equivalent multipart body API.
  const uploadResponse = await window.fetch(uploadHost, { method: "POST", body: form });
  if (!uploadResponse.ok) {
    const body = await uploadResponse.text().catch(() => "");
    throw new Error(t("Failed to upload the audio to Alibaba Cloud temporary storage (HTTP {0}){1}.").replace("{0}", String(uploadResponse.status)).replace("{1}", body ? t(": ") + body.slice(0, 180) : ""));
  }
  return `oss://${key}`;
}

async function transcribeWithDashScope(
  provider: ImportTranscribeProvider,
  blob: Blob,
  options: LongAudioTranscriptionOptions,
): Promise<LongAudioTranscriptionResult> {
  if (!provider.endpoint) throw new Error(t("Import transcription service URL is not configured."));
  if (!provider.apiKey) throw new Error(t("Import transcription service access key is not configured."));
  if (!provider.model) throw new Error(t("Import transcription model is not configured."));
  const notify = (progress: LongAudioProgress) => options.onProgress?.(progress);
  notify({ phase: "upload", label: t("Uploading audio") });
  const fileUrl = await getDashScopeUploadUrl(
    provider.endpoint,
    provider.apiKey,
    provider.model,
    blob,
    options.fileName || "",
  );
  notify({ phase: "submit", label: t("Submitting transcription task") });
  const parameters = buildDashScopeTranscriptionParameters(options, provider.language);
  const submitResponse = await requestUrl({
    url: provider.endpoint,
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
      "X-DashScope-OssResourceResolve": "enable",
    },
    body: JSON.stringify({
      model: provider.model,
      input: { file_urls: [fileUrl] },
      parameters,
    }),
    throw: false,
  });
  const submitPayload = requireSuccessfulJsonResponse(submitResponse, t("Failed to submit the Alibaba Cloud long-audio transcription task."));
  const taskId = asString(asRecord(submitPayload.output).task_id);
  if (!taskId) throw new Error(t("Alibaba Cloud did not return a transcription task ID."));
  const queryUrl = `${dashScopeBaseUrl(provider.endpoint)}/api/v1/tasks/${encodeURIComponent(taskId)}`;
  const pollIntervalMs = Math.max(1500, Number(options.pollIntervalMs) || 3000);
  const timeoutMs = Math.max(60_000, Number(options.timeoutMs) || 6 * 60 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;
  const estimate = estimateCloudTranscriptionDuration(options.audioDurationMs);
  const durationLabel = Number(options.audioDurationMs) > 0 ? formatElapsed(Number(options.audioDurationMs)) : t("unknown");
  const estimateLabel = t("{0}–{1} minutes").replace("{0}", formatEstimateMinutes(estimate.minMs)).replace("{1}", formatEstimateMinutes(estimate.maxMs));
  let transcriptionUrl = "";
  while (Date.now() < deadline) {
    notify({
      phase: "waiting",
      label: t("Sending the full audio to the cloud for recognition"),
      detail: t("Audio duration {0} · estimated to finish in about {1}").replace("{0}", durationLabel).replace("{1}", estimateLabel),
      taskId,
    });
    const queryResponse = await requestUrl({
      url: queryUrl,
      method: "GET",
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      throw: false,
    });
    const queryPayload = requireSuccessfulJsonResponse(queryResponse, t("Failed to query the Alibaba Cloud transcription task."));
    const output = asRecord(queryPayload.output);
    const status = asString(output.task_status).toUpperCase();
    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      throw makeServiceError(t("Alibaba Cloud long-audio transcription failed."), queryPayload);
    }
    if (status === "SUCCEEDED") {
      const result = asArray(output.results).map(asRecord).find((item) => asString(item.subtask_status).toUpperCase() === "SUCCEEDED")
        || asRecord(asArray(output.results)[0]);
      transcriptionUrl = asString(result.transcription_url);
      if (!transcriptionUrl) throw makeServiceError(t("Alibaba Cloud transcription finished but returned no result URL."), result);
      break;
    }
    await delayMs(pollIntervalMs);
  }
  if (!transcriptionUrl) throw new Error(t("Timed out waiting for the Alibaba Cloud long-audio transcription; the task may still run on the server."));
  notify({ phase: "download", label: t("Reading transcription result"), taskId });
  const resultResponse = await requestUrl({ url: transcriptionUrl, method: "GET", throw: false });
  const resultPayload = requireSuccessfulJsonResponse(resultResponse, t("Failed to download the Alibaba Cloud transcription result."));
  const composed = composeDashScopeTranscript(resultPayload);
  if (!composed.text.trim()) throw new Error(t("Alibaba Cloud long-audio transcription finished, but the result contains no usable text."));
  const sentences = extractDashScopeSentences(resultPayload);
  const speakerMap = new Map<string, string>();
  const plainTexts = sentences.length ? [] : getDashScopePlainTexts(resultPayload);
  const rawText = plainTexts.length === 1 ? plainTexts[0] : null;
  const units: AsrTranscriptUnit[] = sentences.length
    ? sentences.map((sentence) => {
      let speakerName: string | null = null;
      if (sentence.speakerId) {
        if (!speakerMap.has(sentence.speakerId)) speakerMap.set(sentence.speakerId, `说话人${speakerMap.size + 1}`);
        speakerName = speakerMap.get(sentence.speakerId) || null;
      }
      const hasRange = sentence.beginTimeMs !== null && sentence.endTimeMs !== null && sentence.endTimeMs >= sentence.beginTimeMs;
      return {
        rawText: sentence.text,
        normalizedText: sentence.text,
        speakerId: sentence.speakerId || null,
        speakerName,
        startMs: hasRange ? sentence.beginTimeMs : null,
        endMs: hasRange ? sentence.endTimeMs : null,
        timing: hasRange ? "provider" : "unknown",
      };
    })
    : plainTexts.flatMap((plainText) => splitTranscriptTextUnits(plainText).map((unit): AsrTranscriptUnit => ({
      rawText: unit, normalizedText: unit, speakerId: null, speakerName: null,
      startMs: null, endMs: null, timing: "unknown",
    })));
  return {
    text: composed.text,
    rawText,
    providerId: provider.id,
    units,
    taskId,
    sentenceCount: composed.sentenceCount,
    durationMs: composed.durationMs,
  };
}

export async function transcribeImportedAudio(
  plugin: { settings?: unknown },
  blob: Blob,
  mime: string,
  options: LongAudioTranscriptionOptions = {},
): Promise<LongAudioTranscriptionResult> {
  const provider = resolveTypedTranscribeProvider(
    plugin,
    options.providerId || asString(asRecord(plugin && plugin.settings).importTranscribeProvider),
  );
  if (isDashScopeFileTransProvider(provider)) {
    return transcribeWithDashScope(provider, blob, options);
  }
  if (isOpenRouterDiarizeProvider(provider)) {
    options.onProgress?.({ phase: "submit", label: t("Submitting the full audio") });
    return transcribeWithOpenRouterDiarize(provider, blob, mime, {
      timeoutMs: Number(options.timeoutMs) || undefined,
    });
  }
  options.onProgress?.({ phase: "submit", label: t("Submitting the full audio") });
  const result = await transcribeAudio(plugin, blob, mime, provider.id);
  if (!result.text.trim()) throw new Error(t("Whole-file transcription returned an empty result."));
  return { ...result, sentenceCount: 0 };
}
