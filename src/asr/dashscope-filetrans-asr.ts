import { requestUrl } from "obsidian";
import { delayMs } from "../shared/util-audio";
import { formatElapsed } from "../shared/util-common";
import { t } from "../shared/i18n";
import { buildDashScopeTranscriptionParameters } from "./diarization";
import type { AsrTranscriptResult, AsrTranscriptUnit } from "./transcript-result";
import { splitTranscriptTextUnits } from "../transcript/session-transcript";
import { assertSafeServiceEndpoint } from "../shared/util-llm-endpoint";


export interface DashScopeFileTransProvider {
  id: string; endpoint: string; apiKey: string; model: string; language?: string; protocol?: string;
}
export interface DashScopeFileTransOptions {
  diarization?: boolean; speakerCount?: number; fileName?: string; pollIntervalMs?: number;
  timeoutMs?: number; audioDurationMs?: number;
  onProgress?: (progress: { phase: "upload" | "submit" | "waiting" | "download"; label: string; detail?: string; taskId?: string }) => void;
}
export interface DashScopeFileTransResult extends AsrTranscriptResult { taskId: string; sentenceCount: number; durationMs?: number }
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => v && typeof v === "object" && !Array.isArray(v) ? v as Rec : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string => typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
const num = (v: unknown): number => Number.isFinite(Number(v)) ? Number(v) : 0;
function parse(text: unknown): unknown { try { return JSON.parse(str(text)) as unknown; } catch { return null; } }
function fail(prefix: string, payload: unknown): Error {
  const root = rec(payload), output = rec(root.output);
  const message = str(output.message) || str(root.message) || str(output.code) || str(root.code);
  return new Error(message ? t("{0}: {1}").replace("{0}", prefix).replace("{1}", message) : prefix);
}
function responseJson(response: { status: number; text?: string }, phase: string): Rec {
  const status = Number(response?.status) || 0, raw = typeof response?.text === "string" ? response.text.trim() : "";
  const payload = raw ? parse(raw) : null;
  if (status < 200 || status >= 300) throw fail(t("{0} (HTTP {1})").replace("{0}", phase).replace("{1}", String(status || t("unknown"))), payload || { message: raw.slice(0, 180) });
  if (!payload || typeof payload !== "object") throw new Error(t("{0} did not return valid JSON (HTTP {1}): {2}").replace("{0}", phase).replace("{1}", String(status || t("unknown"))).replace("{2}", raw.slice(0, 180)));
  return rec(payload);
}
function baseUrl(endpoint: string): string {
  assertSafeServiceEndpoint(endpoint, "http", t("Transcription service URL"));
  const normalized = endpoint.replace(/\/+$/, "");
  const marker = "/api/v1/services/audio/asr/transcription", index = normalized.toLowerCase().indexOf(marker);
  if (index < 0 || index + marker.length !== normalized.length) {
    throw new Error(t("Enter a Bailian file transcription endpoint before importing audio."));
  }
  return normalized.slice(0, index);
}
function filename(value: unknown, mime: string): string {
  const ext = mime.includes("wav") ? "wav" : mime.includes("mpeg") ? "mp3" : mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : mime.includes("flac") ? "flac" : "webm";
  const clean = (str(value) || `qnalog-import.${ext}`).replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(-160);
  return /\.[a-z0-9]{2,8}$/i.test(clean) ? clean : `${clean}.${ext}`;
}
async function uploadPolicy(provider: DashScopeFileTransProvider): Promise<Rec> {
  const response = await requestUrl({ url: `${baseUrl(provider.endpoint)}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(provider.model)}`, method: "GET", headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" }, throw: false });
  const policy = rec(responseJson(response, t("Failed to get Alibaba Cloud upload credentials.")).data);
  if (!str(policy.upload_host) || !str(policy.upload_dir)) throw new Error(t("Alibaba Cloud upload credential response lacks an upload URL; check that the model supports audio file transcription."));
  return policy;
}
async function upload(provider: DashScopeFileTransProvider, blob: Blob, name: string): Promise<string> {
  const policy = await uploadPolicy(provider), limit = num(policy.max_file_size_mb);
  if (limit > 0 && blob.size > limit * 1024 * 1024) throw new Error(t("The audio file exceeds the Alibaba Cloud temporary upload limit of {0} MB.").replace("{0}", String(limit)));
  const uploadDir = str(policy.upload_dir).replace(/\/+$/, ""), safeName = filename(name, blob.type || "audio/webm"), key = `${uploadDir}/${safeName}`;
  const form = new FormData();
  form.append("OSSAccessKeyId", str(policy.oss_access_key_id)); form.append("policy", str(policy.policy)); form.append("Signature", str(policy.signature));
  form.append("key", key); form.append("x-oss-object-acl", str(policy.x_oss_object_acl) || "private"); form.append("x-oss-forbid-overwrite", str(policy.x_oss_forbid_overwrite) || "true"); form.append("success_action_status", "200"); form.append("file", blob, safeName);
  const uploadHost = str(policy.upload_host);
  assertSafeServiceEndpoint(uploadHost, "http", t("Alibaba Cloud temporary upload URL"));
  if (new URL(uploadHost).protocol !== "https:") throw new Error(t("Alibaba Cloud temporary upload URL must use HTTPS."));
  const result = await window.fetch(uploadHost, { method: "POST", body: form });
  if (!result.ok) { const body = await result.text().catch(() => ""); throw new Error(t("Failed to upload the audio to Alibaba Cloud temporary storage (HTTP {0}){1}.").replace("{0}", String(result.status)).replace("{1}", body ? t(": ") + body.slice(0, 180) : "")); }
  return `oss://${key}`;
}
function sentenceData(payload: unknown): Array<{ text: string; speaker: string; start: number | null; end: number | null }> {
  const root = rec(payload), groups = [root.transcripts, rec(root.output).transcripts, rec(root.result).transcripts, rec(rec(root.output).result).transcripts];
  const transcripts = groups.map(arr).find((v) => v.length) || [], out: Array<{ text: string; speaker: string; start: number | null; end: number | null }> = [];
  for (const group of transcripts) for (const value of arr(rec(group).sentences)) {
    const s = rec(value), text = typeof s.text === "string" ? s.text : typeof s.text === "number" ? String(s.text) : "";
    if (!text.trim()) continue;
    const time = (v: unknown): number | null => { if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : null; };
    const start = time(s.begin_time ?? s.beginTime ?? s.start_time), end = time(s.end_time ?? s.endTime ?? s.stop_time);
    out.push({ text, speaker: str(s.speaker_id ?? s.speakerId ?? s.speaker), start: start !== null && end !== null && end >= start ? start : null, end: start !== null && end !== null && end >= start ? end : null });
  }
  return out;
}
function plainTexts(payload: unknown): string[] {
  const root = rec(payload), groups = [root.transcripts, rec(root.output).transcripts, rec(root.result).transcripts, rec(rec(root.output).result).transcripts];
  const transcripts = groups.map(arr).find((v) => v.length) || [];
  return transcripts.map((item) => str(rec(item).transcript) || str(rec(item).text)).filter(Boolean);
}
function compose(payload: unknown, sentences: ReturnType<typeof sentenceData>): { text: string; duration?: number } {
  if (!sentences.length) { const root = rec(payload); return { text: plainTexts(payload).join("\n") || str(root.text) || str(rec(root.output).text) }; }
  const speakers = new Map<string, string>(), turns: Array<{ speaker: string; start: number | null; text: string[] }> = [];
  for (const s of sentences) { if (s.speaker && !speakers.has(s.speaker)) speakers.set(s.speaker, `${t("Speaker ")}${speakers.size + 1}`); const speaker = s.speaker ? speakers.get(s.speaker) || "" : "", prev = turns[turns.length - 1]; if (prev && prev.speaker === speaker) prev.text.push(s.text); else turns.push({ speaker, start: s.start, text: [s.text] }); }
  const text = turns.map((v) => `${[v.start === null ? "" : `[${formatElapsed(v.start)}]`, v.speaker ? `[${v.speaker}]` : ""].filter(Boolean).join(" ")}${v.start !== null || v.speaker ? " " : ""}${v.text.join(" ").replace(/\s+/g, " ").trim()}`).join("\n\n");
  const duration = sentences.reduce((m, s) => s.end === null ? m : Math.max(m, s.end), 0);
  return { text, duration: duration || undefined };
}
export interface DashScopeSentence {
  beginTimeMs: number | null;
  endTimeMs: number | null;
  text: string;
  speakerId: string;
}
export function extractDashScopeSentences(payload: unknown): DashScopeSentence[] {
  return sentenceData(payload).map((sentence) => ({
    beginTimeMs: sentence.start,
    endTimeMs: sentence.end,
    text: sentence.text,
    speakerId: sentence.speaker,
  }));
}
export function extractDashScopePlainTexts(payload: unknown): string[] {
  return plainTexts(payload);
}
export function composeDashScopeTranscript(payload: unknown): { text: string; sentenceCount: number; durationMs?: number } {
  const sentences = sentenceData(payload);
  const result = compose(payload, sentences);
  return { text: result.text, sentenceCount: sentences.length, durationMs: result.duration };
}
export function parseServiceJsonResponse(response: { status: number; text?: string }, phase: string): Rec {
  const raw = typeof response.text === "string" ? response.text.trim() : "";
  if (!raw) throw new Error(t("{0} returned an empty response (HTTP {1}).").replace("{0}", phase).replace("{1}", String(response.status || t("unknown"))));
  return responseJson(response, phase);
}
function estimate(ms: unknown): { min: number; max: number } { const duration = Number(ms); if (!Number.isFinite(duration) || duration <= 0) return { min: 60_000, max: 5 * 60_000 }; const min = Math.max(60_000, Math.round(duration * 0.1)); return { min, max: Math.max(min + 60_000, Math.round(duration * 0.5)) }; }
function mins(ms: number): string { return String(Math.max(1, Math.ceil(ms / 60_000))); }
export async function probeDashScopeFileTrans(provider: DashScopeFileTransProvider): Promise<number> {
  const policy = await uploadPolicy(provider);
  return num(policy.max_file_size_mb);
}
export function estimateDashScopeFileTransDuration(audioDurationMs: unknown): { minMs: number; maxMs: number } {
  const duration = Math.max(0, Number(audioDurationMs) || 0);
  if (!duration) return { minMs: 120_000, maxMs: 600_000 };
  const minMs = Math.min(720_000, Math.max(45_000, Math.round(duration * 0.025)));
  const maxMs = Math.min(1_800_000, Math.max(180_000, Math.round(duration * 0.08)));
  return { minMs, maxMs: Math.max(maxMs, minMs + 60_000) };
}

/** Uploads and transcribes a full audio file through DashScope's asynchronous file transcription API. */
export async function transcribeDashScopeFile(
  provider: DashScopeFileTransProvider, blob: Blob, options: DashScopeFileTransOptions = {},
): Promise<DashScopeFileTransResult> {
  if (!provider.endpoint) throw new Error(t("Import transcription service URL is not configured."));
  if (!provider.apiKey) throw new Error(t("Import transcription service access key is not configured."));
  if (!provider.model) throw new Error(t("Import transcription model is not configured."));
  const notify = options.onProgress;
  notify?.({ phase: "upload", label: t("Uploading audio") });
  const fileUrl = await upload(provider, blob, options.fileName || "");
  notify?.({ phase: "submit", label: t("Submitting transcription task") });
  const submitted = responseJson(await requestUrl({ url: provider.endpoint, method: "POST", headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json", "X-DashScope-Async": "enable", "X-DashScope-OssResourceResolve": "enable" }, body: JSON.stringify({ model: provider.model, input: { file_urls: [fileUrl] }, parameters: buildDashScopeTranscriptionParameters(options, provider.language) }), throw: false }), t("Failed to submit the Alibaba Cloud long-audio transcription task."));
  const taskId = str(rec(submitted.output).task_id);
  if (!taskId) throw new Error(t("Alibaba Cloud did not return a transcription task ID."));
  const queryUrl = `${baseUrl(provider.endpoint)}/api/v1/tasks/${encodeURIComponent(taskId)}`;
  const poll = Math.max(1500, Number(options.pollIntervalMs) || 3000), timeout = Math.max(60_000, Number(options.timeoutMs) || 6 * 60 * 60 * 1000), deadline = Date.now() + timeout;
  const e = estimate(options.audioDurationMs), duration = Number(options.audioDurationMs) > 0 ? formatElapsed(Number(options.audioDurationMs)) : t("unknown");
  const estimateText = t("{0}–{1} minutes").replace("{0}", mins(e.min)).replace("{1}", mins(e.max));
  let resultUrl = "";
  while (Date.now() < deadline) {
    notify?.({ phase: "waiting", label: t("Sending the full audio to the cloud for recognition"), detail: t("Audio duration {0} · estimated to finish in about {1}").replace("{0}", duration).replace("{1}", estimateText), taskId });
    const task = responseJson(await requestUrl({ url: queryUrl, method: "GET", headers: { Authorization: `Bearer ${provider.apiKey}` }, throw: false }), t("Failed to query the Alibaba Cloud transcription task.")), output = rec(task.output), status = str(output.task_status).toUpperCase();
    if (["FAILED", "CANCELED", "UNKNOWN"].includes(status)) throw fail(t("Alibaba Cloud long-audio transcription failed."), task);
    if (status === "SUCCEEDED") { const results = arr(output.results).map(rec), result = results.find((v) => str(v.subtask_status).toUpperCase() === "SUCCEEDED") || rec(results[0]); resultUrl = str(result.transcription_url); if (!resultUrl) throw fail(t("Alibaba Cloud transcription finished but returned no result URL."), result); break; }
    await delayMs(poll);
  }
  if (!resultUrl) throw new Error(t("Timed out waiting for the Alibaba Cloud long-audio transcription; the task may still run on the server."));
  notify?.({ phase: "download", label: t("Reading transcription result"), taskId });
  // Result URLs are signed downloads; never forward the service API key.
  assertSafeServiceEndpoint(resultUrl, "http", t("Alibaba Cloud transcription result URL"));
  if (new URL(resultUrl).protocol !== "https:") throw new Error(t("Alibaba Cloud transcription result URL must use HTTPS."));
  const payload = responseJson(await requestUrl({ url: resultUrl, method: "GET", throw: false }), t("Failed to download the Alibaba Cloud transcription result."));
  const sentences = sentenceData(payload), composed = compose(payload, sentences);
  if (!composed.text.trim()) throw new Error(t("Alibaba Cloud long-audio transcription finished, but the result contains no usable text."));
  const speakerMap = new Map<string, string>();
  const texts = sentences.length ? [] : plainTexts(payload);
  const units: AsrTranscriptUnit[] = sentences.length ? sentences.map((s) => {
    if (s.speaker && !speakerMap.has(s.speaker)) speakerMap.set(s.speaker, `${t("Speaker ")}${speakerMap.size + 1}`);
    const valid = s.start !== null && s.end !== null && s.end >= s.start;
    return { rawText: s.text, normalizedText: s.text, speakerId: s.speaker || null, speakerName: s.speaker ? speakerMap.get(s.speaker) || null : null, startMs: valid ? s.start : null, endMs: valid ? s.end : null, timing: valid ? "provider" : "unknown" };
  }) : texts.flatMap((text) => splitTranscriptTextUnits(text).map((unit): AsrTranscriptUnit => ({ rawText: unit, normalizedText: unit, speakerId: null, speakerName: null, startMs: null, endMs: null, timing: "unknown" })));
  return { text: composed.text, rawText: texts.length === 1 ? texts[0] : null, providerId: provider.id, units, taskId, sentenceCount: sentences.length, durationMs: composed.duration };
}
