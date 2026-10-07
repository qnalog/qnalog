const RECORDING_MODELS = new Set([
  "qwen-audio-3.1-asr-flash",
  "qwen3-asr-flash",
]);

const FILE_TRANSCRIPTION_MODELS = new Set([
  "fun-asr",

  "qwen-audio-3.0-asr-flash-filetrans",
  "qwen-audio-3.1-asr-flash-filetrans",
]);

const SPEAKER_FILE_TRANSCRIPTION_MODELS = new Set([
  "fun-asr",
  "paraformer-v2",
  "qwen-audio-3.0-asr-flash-filetrans",
  "qwen-audio-3.1-asr-flash-filetrans",
]);

function normalizedModelId(model: string): string {
  return String(model || "").trim().toLowerCase();
}
export function resolveBailianRecordingProvider(model: string): "dashscope-flash" | "dashscope-chat" | null {
  const id = normalizedModelId(model);
  if (id === "qwen-audio-3.1-asr-flash") return "dashscope-flash";
  if (id === "qwen3-asr-flash") return "dashscope-chat";
  return null;
}


/** Bailian recording candidates that have a supported segmented HTTP protocol. */
export function isBailianRecordingModel(model: string): boolean {
  return RECORDING_MODELS.has(normalizedModelId(model));
}

/** Bailian models implemented by the existing asynchronous file-transcription workflow. */
export function isBailianFileTranscriptionModel(model: string): boolean {
  return FILE_TRANSCRIPTION_MODELS.has(normalizedModelId(model));
}

/** File-transcription models whose result supports the speaker-confirmation workflow. */
export function isBailianSpeakerFileTranscriptionModel(model: string): boolean {
  return SPEAKER_FILE_TRANSCRIPTION_MODELS.has(normalizedModelId(model));
}
