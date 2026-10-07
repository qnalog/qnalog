import { isBailianAsrCapability, resolveBailianAsrRoute } from "./bailian-asr-registry";
import { fetchLlmModelEntries } from "../llm/core";
import { filterModelsForCategory, transcriptionListQuery } from "../setup/model-catalog";
import { assertEndpointAllowed } from "../shared/util-llm-endpoint";
import { t } from "../shared/i18n";

export interface RecordingModelProvider {
  id: string;
  endpoint: string;
  apiKey: string;
  protocol?: string;
}

const PROVIDER_PROTOCOLS: Record<string, string> = {
  "dashscope-flash": "dashscope-flash-input-audio",
  "dashscope-chat": "dashscope-chat-input-audio",
  "dashscope-filetrans": "dashscope-filetrans",
  bailian: "dashscope-flash-input-audio",
  "dashscope": "dashscope-flash-input-audio",
  apimimo: "apimimo-chat-input-audio",
  "openrouter-diarize": "openrouter-diarize",
};

const SUPPORTED_STREAM_PROTOCOLS = new Set([
  "openai-realtime-transcription",
  "openai-realtime-translation",
  "dashscope-ws",
  "dashscope-qwen3-realtime",
]);

function catalogueEndpoint(endpoint: string, protocol: string): string {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (protocol === "openai-realtime-transcription" || protocol === "openai-realtime-translation") {
    url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    url.pathname = path.replace(/\/realtime(?:\/translations)?$/i, "");
  } else if (protocol === "dashscope-ws") {
    url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    url.pathname = path.replace(/\/api-ws\/v1\/inference$/i, "/api/v1");
  } else if (protocol === "dashscope-flash-input-audio" || protocol === "dashscope-filetrans") {
    const servicePath = path.match(/^(.*)\/api\/v1\/services\/.+$/i);
    if (servicePath) url.pathname = `${servicePath[1]}/api/v1`;
  } else if (/\/audio\/transcriptions$/i.test(path)) {
    url.pathname = path.replace(/\/audio\/transcriptions$/i, "");
  }

  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/** Fetch model ids exposed by the configured recording transcription service. */
export async function fetchRecordingTranscribeModels(
  provider: RecordingModelProvider,
  streamProtocol?: string,
): Promise<string[]> {
  assertEndpointAllowed(provider.endpoint, t("Transcription service URL"));
  const protocol = streamProtocol || provider.protocol || PROVIDER_PROTOCOLS[provider.id] || "";
  if (streamProtocol && !SUPPORTED_STREAM_PROTOCOLS.has(streamProtocol)) {
    throw new Error(t("This streaming service does not expose a supported model catalogue. Enter the model name manually."));
  }

  const isBailian = protocol.startsWith("dashscope")
    || /^(?:bailian|dashscope)(?:-|$)/i.test(provider.id)
    || /(?:^|\.)aliyuncs\.com$/i.test(new URL(provider.endpoint).hostname);
  const queryProvider = provider.id === "openrouter-diarize" || protocol === "openrouter-diarize"
    ? "openrouter"
    : provider.id;
  const entries = await fetchLlmModelEntries(
    catalogueEndpoint(provider.endpoint, protocol),
    provider.apiKey,
    isBailian ? undefined : transcriptionListQuery(queryProvider) || undefined,
    isBailian ? { requireCompletePagination: true } : undefined,
  );

  if (isBailian) {
    return entries
      .filter((entry) => isBailianAsrCapability(entry.capabilities) || resolveBailianAsrRoute(entry.id) !== null)
      .map((entry) => entry.id);
  }
  if (protocol === "apimimo-chat-input-audio") {
    return entries.map((entry) => entry.id).filter((model) => model.toLowerCase() === "mimo-v2.5-asr");
  }
  if (protocol === "dashscope-ws") {
    return entries.map((entry) => entry.id).filter((model) => /^paraformer-realtime(?:-|$)|^qwen-audio-[0-9.]+-asr-flash-streaming$/i.test(model));
  }
  if (protocol === "openai-realtime-transcription") {
    return entries.map((entry) => entry.id).filter((model) => model.toLowerCase() === "gpt-realtime-whisper");
  }
  if (protocol === "openai-realtime-translation") {
    return entries.map((entry) => entry.id).filter((model) => model.toLowerCase() === "gpt-realtime-translate");
  }

  const asrModels = filterModelsForCategory(entries, "asr");
  if (protocol === "openrouter-diarize") {
    return entries
      .filter((entry) => entry.id.toLowerCase() === "microsoft/mai-transcribe-2"
        || (/说话人|语者|分离|diariz|speaker/i.test(entry.description || "") && asrModels.includes(entry.id)))
      .map((entry) => entry.id);
  }
  return asrModels;
}
