import { resolveBailianAsrRoute } from "./bailian-asr-registry";
import { probeDashScopeFileTrans, estimateDashScopeFileTransDuration } from "./dashscope-filetrans-asr";
import { resolveTranscribeProvider, transcribeAudio } from "./transcribe";
import { t } from "../shared/i18n";
import { isOpenRouterDiarizeProvider, testOpenRouterDiarizeProvider, transcribeWithOpenRouterDiarize } from "./openrouter-diarize";
import type { AsrTranscriptResult } from "./transcript-result";
import { fetchRecordingTranscribeModels } from "./recording-model-catalog";
import { transcribeDashScopeFile } from "./dashscope-filetrans-asr";
import type { DashScopeFileTransOptions } from "./dashscope-filetrans-asr";
export {
  composeDashScopeTranscript,
  extractDashScopePlainTexts,
  extractDashScopeSentences,
  parseServiceJsonResponse,
} from "./dashscope-filetrans-asr";

export const DASHSCOPE_FILETRANS_PROTOCOL = "dashscope-filetrans";
export interface LongAudioTranscriptionOptions extends DashScopeFileTransOptions { providerId?: string }
export interface LongAudioProgress { phase: "upload" | "submit" | "waiting" | "download"; label: string; detail?: string; taskId?: string }
export interface LongAudioTranscriptionResult extends AsrTranscriptResult { taskId?: string; sentenceCount: number; durationMs?: number }
export interface ImportTranscribeProvider { id: string; endpoint: string; apiKey: string; model: string; language?: string; protocol?: string }
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asString = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
export function estimateCloudTranscriptionDuration(audioDurationMs: unknown): { minMs: number; maxMs: number } {
  return estimateDashScopeFileTransDuration(audioDurationMs);
}
export function isDashScopeFileTransProvider(provider: unknown): boolean {
  return asString(asRecord(provider).protocol).toLowerCase() === DASHSCOPE_FILETRANS_PROTOCOL;
}
export function resolveImportTranscribeProvider(plugin: { settings?: unknown }): ImportTranscribeProvider {
  const settings = asRecord(plugin.settings);
  return resolveTranscribeProvider(plugin, asString(settings.importTranscribeProvider) || asString(settings.activeTranscribeProvider) || "siliconflow");
}
function resolveTypedTranscribeProvider(plugin: { settings?: unknown }, providerId: string): ImportTranscribeProvider {
  return resolveTranscribeProvider(plugin, providerId);
}
export async function testImportTranscribeProvider(plugin: { settings?: unknown }, providerId?: string): Promise<{ providerId: string; model: string; detail: string }> {
  const provider = resolveTypedTranscribeProvider(plugin, providerId || asString(asRecord(plugin.settings).importTranscribeProvider));
  if (!provider.endpoint) throw new Error(t("Import transcription service URL is not configured."));
  if (!provider.apiKey) throw new Error(t("Import transcription service access key is not configured."));
  if (!provider.model) throw new Error(t("Import transcription model is not configured."));
  if (isOpenRouterDiarizeProvider(provider)) return testOpenRouterDiarizeProvider(provider);
  if (!isDashScopeFileTransProvider(provider)) throw new Error(t("This service does not support connection testing without audio; import a short audio clip to verify."));
  const maxSizeMb = await probeDashScopeFileTrans(provider);
  return {
    providerId: provider.id,
    model: provider.model,
    detail: maxSizeMb > 0 ? t("Single-file upload limit: {0} MB").replace("{0}", String(maxSizeMb)) : t("Upload credentials OK"),
  };
}
export async function fetchImportTranscribeModels(plugin: { settings?: unknown }, providerId?: string): Promise<string[]> {
  const provider = resolveTypedTranscribeProvider(plugin, providerId || asString(asRecord(plugin.settings).importTranscribeProvider));
  if (!isDashScopeFileTransProvider(provider)) return provider.model ? [provider.model] : [];
  if (!provider.apiKey) throw new Error(t("Please fill in the Bailian API key first."));
  return (await fetchRecordingTranscribeModels(provider, provider.protocol))
    .filter((model) => resolveBailianAsrRoute(model)?.endpointKind === "filetrans-http");
}
export async function transcribeImportedAudio(plugin: { settings?: unknown }, blob: Blob, mime: string, options: LongAudioTranscriptionOptions = {}): Promise<LongAudioTranscriptionResult> {
  const provider = resolveTypedTranscribeProvider(plugin, options.providerId || asString(asRecord(plugin.settings).importTranscribeProvider));
  if (isDashScopeFileTransProvider(provider)) return transcribeDashScopeFile(provider, blob, options);
  if (isOpenRouterDiarizeProvider(provider)) {
    options.onProgress?.({ phase: "submit", label: t("Submitting the full audio") });
    return transcribeWithOpenRouterDiarize(provider, blob, mime, { timeoutMs: Number(options.timeoutMs) || undefined });
  }
  options.onProgress?.({ phase: "submit", label: t("Submitting the full audio") });
  const result = await transcribeAudio(plugin, blob, mime, provider.id);
  if (!result.text.trim()) throw new Error(t("Whole-file transcription returned an empty result."));
  return { ...result, sentenceCount: 0 };
}
