import { resolveBailianAsrRoute } from "./bailian-asr-registry";

export function resolveBailianRecordingProvider(model: string): "dashscope-flash" | "dashscope-chat" | null {
  const route = resolveBailianAsrRoute(model);
  if (!route || route.transcribeMode !== "segmented") return null;
  if (route.protocol === "dashscope-flash-input-audio") return "dashscope-flash";
  if (route.protocol === "dashscope-chat-input-audio") return "dashscope-chat";
  return null;
}

/** Bailian models implemented by the segmented HTTP recording flow. */
export function isBailianRecordingModel(model: string): boolean {
  return resolveBailianAsrRoute(model)?.transcribeMode === "segmented";
}

/** Bailian models implemented by asynchronous full-file transcription. */
export function isBailianFileTranscriptionModel(model: string): boolean {
  const route = resolveBailianAsrRoute(model);
  return route?.transcribeMode === "whole-file" && route.protocol === "dashscope-filetrans";
}

/** File-transcription models whose result supports speaker confirmation. */
export function isBailianSpeakerFileTranscriptionModel(model: string): boolean {
  return isBailianFileTranscriptionModel(model) && resolveBailianAsrRoute(model)?.speakerDiarization === true;
}
