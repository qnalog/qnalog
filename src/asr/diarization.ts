export interface DiarizationRequestOptions {
  responseFormat: "json" | "diarized_json";
  chunkingStrategy: "auto" | "";
  supportsPrompt: boolean;
}

export function normalizeRequestedSpeakerCount(value: unknown): number {
  const count = Math.floor(Number(value) || 0);
  if (count < 2) return 0;
  return Math.min(100, count);
}

export function buildDashScopeTranscriptionParameters(
  options: { diarization?: boolean; speakerCount?: number },
  language?: string,
): Record<string, unknown> {
  const parameters: Record<string, unknown> = {
    channel_id: [0],
    diarization_enabled: options.diarization !== false,
  };
  const speakerCount = normalizeRequestedSpeakerCount(options.speakerCount);
  if (speakerCount >= 2 && options.diarization !== false) parameters.speaker_count = speakerCount;
  const normalizedLanguage = typeof language === "string" ? language.trim() : "";
  if (normalizedLanguage && normalizedLanguage !== "auto") parameters.language_hints = [normalizedLanguage];
  return parameters;
}

function providerRecord(provider: unknown): Record<string, unknown> {
  return provider && typeof provider === "object" ? provider as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isSpeakerDiarizationProvider(provider: unknown): boolean {
  const value = providerRecord(provider);
  const protocol = stringValue(value.protocol).trim().toLowerCase();
  const model = stringValue(value.model).trim().toLowerCase();
  return protocol === "dashscope-filetrans"
    || protocol === "openai-diarized-transcription"
    || protocol === "openrouter-diarize"
    || protocol === "speaker-diarization"
    || /(?:^|[-_/])diari[sz](?:e|ation)(?:$|[-_/])/.test(model)
    || /whisperx/i.test(model);
}

// 能否用于「导入音频」（整场录音统一转写）：由服务本身的能力决定，
// 而不是由预设 id 的名单决定。用户自定义的说话人分离服务（例如 siliconflow-diarize
// 这类协议为 speaker-diarization 的条目）因此不会被排除在选项之外。
// 若这条规则退回成硬编码 id 名单，自定义服务的设置会被设置页静默改写。
export function isImportCapableTranscribeProvider(
  profile: { requiresWholeSession?: unknown } | null | undefined,
  provider: unknown,
): boolean {
  if (profile && providerRecord(profile).requiresWholeSession) return true;
  return isSpeakerDiarizationProvider(provider);
}

export function getSpeakerDiarizationRequestOptions(provider: unknown): DiarizationRequestOptions {
  const value = providerRecord(provider);
  const protocol = stringValue(value.protocol).trim().toLowerCase();
  const model = stringValue(value.model).trim().toLowerCase();
  const openAiDiarized = protocol === "openai-diarized-transcription" || model === "gpt-4o-transcribe-diarize";
  return {
    responseFormat: openAiDiarized ? "diarized_json" : "json",
    chunkingStrategy: openAiDiarized ? "auto" : "",
    supportsPrompt: !openAiDiarized,
  };
}
