import type { TranscribeProviderSettings } from "../shared/types";
export type BailianEndpointKind =
  | "native-http"
  | "chat-http"
  | "filetrans-http"
  | "dashscope-ws"
  | "qwen3-realtime-ws";

export type BailianProtocol =
  | "dashscope-flash-input-audio"
  | "dashscope-chat-input-audio"
  | "dashscope-filetrans"
  | "dashscope-ws"
  | "dashscope-qwen3-realtime";

export type BailianTranscribeMode = "segmented" | "whole-file" | "streaming";

export interface BailianAsrRoute {
  family: string;
  protocol: BailianProtocol;
  endpointKind: BailianEndpointKind;
  transcribeMode: BailianTranscribeMode;
  sampleRate: 8000 | 16000;
  speakerDiarization: boolean;
  supportsLanguage: boolean;
  lifecycle?: "legacy" | "deprecation-notice";
}

export const BAILIAN_ENDPOINTS: Readonly<Record<BailianEndpointKind, string>> = {
  "native-http": "/api/v1/services/aigc/multimodal-generation/generation",
  "chat-http": "/compatible-mode/v1/chat/completions",
  "filetrans-http": "/api/v1/services/audio/asr/transcription",
  "dashscope-ws": "/api-ws/v1/inference",
  "qwen3-realtime-ws": "/api-ws/v1/realtime",
};
const BAILIAN_ENDPOINT_SUFFIXES = Object.values(BAILIAN_ENDPOINTS).sort((a, b) => b.length - a.length);

interface BailianModelFamily {
  family: string;
  pattern: RegExp;
  endpointKind: BailianEndpointKind;
  protocol: BailianProtocol;
  transcribeMode: BailianTranscribeMode;
  sampleRate?: 8000 | 16000;
  speakerDiarization?: boolean;
  supportsLanguage?: boolean;
  lifecycle?: "legacy" | "deprecation-notice";
}

// More specific transport suffixes precede base model families. Snapshot dates
// remain part of the model identifier sent to Bailian, but do not select a new protocol.
const MODEL_FAMILIES: readonly BailianModelFamily[] = [
  { family: "qwen-audio-message", pattern: /^qwen-audio-(?:3\.[0-9]+-)?asr-(?:flash-)?message(?:[-.].*)?$/i, endpointKind: "dashscope-ws", protocol: "dashscope-ws", transcribeMode: "streaming" },
  { family: "qwen-audio-streaming", pattern: /^qwen-audio-3\.[0-9]+-asr-flash-streaming(?:[-.].*)?$/i, endpointKind: "dashscope-ws", protocol: "dashscope-ws", transcribeMode: "streaming" },
  { family: "qwen3-asr-realtime", pattern: /^qwen3-asr-flash-realtime(?:[-.].*)?$/i, endpointKind: "qwen3-realtime-ws", protocol: "dashscope-qwen3-realtime", transcribeMode: "streaming" },
  { family: "qwen-audio-filetrans", pattern: /^qwen-audio-3\.[0-9]+-asr-flash-filetrans(?:[-.].*)?$/i, endpointKind: "filetrans-http", protocol: "dashscope-filetrans", transcribeMode: "whole-file", speakerDiarization: true },
  { family: "qwen3-asr-chat", pattern: /^qwen3-asr-flash(?:[-.].*)?$/i, endpointKind: "chat-http", protocol: "dashscope-chat-input-audio", transcribeMode: "segmented" },
  { family: "qwen-audio-asr", pattern: /^qwen-audio-3\.[0-9]+-asr-flash(?:[-.].*)?$/i, endpointKind: "native-http", protocol: "dashscope-flash-input-audio", transcribeMode: "segmented" },
  { family: "fun-asr-flash", pattern: /^fun-asr-flash(?:[-.].*)?$/i, endpointKind: "native-http", protocol: "dashscope-flash-input-audio", transcribeMode: "segmented" },
  { family: "fun-asr-realtime", pattern: /^fun-asr(?:-mtl)?-realtime(?:-8k)?(?:[-.].*)?$/i, endpointKind: "dashscope-ws", protocol: "dashscope-ws", transcribeMode: "streaming", sampleRate: 8000 },
  { family: "fun-asr-filetrans", pattern: /^fun-asr(?:-mtl)?(?:[-.].*)?$/i, endpointKind: "filetrans-http", protocol: "dashscope-filetrans", transcribeMode: "whole-file", speakerDiarization: true },
  { family: "paraformer-realtime", pattern: /^paraformer-realtime(?:-8k)?(?:[-.].*)?$/i, endpointKind: "dashscope-ws", protocol: "dashscope-ws", transcribeMode: "streaming", sampleRate: 8000 },
  { family: "paraformer-filetrans", pattern: /^paraformer(?:-v[0-9]+)?(?:[-.].*)?$/i, endpointKind: "filetrans-http", protocol: "dashscope-filetrans", transcribeMode: "whole-file", speakerDiarization: true },
  { family: "gummy-chat", pattern: /^gummy-chat(?:[-.].*)?$/i, endpointKind: "dashscope-ws", protocol: "dashscope-ws", transcribeMode: "streaming", supportsLanguage: false, lifecycle: "deprecation-notice" },
  { family: "gummy-realtime", pattern: /^gummy(?:-realtime)?(?:[-.].*)?$/i, endpointKind: "dashscope-ws", protocol: "dashscope-ws", transcribeMode: "streaming", supportsLanguage: false, lifecycle: "deprecation-notice" },
  { family: "sensevoice-filetrans", pattern: /^sensevoice(?:[-.].*)?$/i, endpointKind: "filetrans-http", protocol: "dashscope-filetrans", transcribeMode: "whole-file", lifecycle: "deprecation-notice" },
];

export function resolveBailianAsrRoute(model: string): BailianAsrRoute | null {
  const id = String(model || "").trim();
  if (!id) return null;
  const family = MODEL_FAMILIES.find((candidate) => candidate.pattern.test(id));
  if (!family) return null;
  return {
    family: family.family,
    protocol: family.protocol,
    endpointKind: family.endpointKind,
    transcribeMode: family.transcribeMode,
    sampleRate: family.sampleRate || 16000,
    speakerDiarization: family.speakerDiarization === true,
    supportsLanguage: family.supportsLanguage !== false,
  };
}
export function resolveBailianEndpoint(currentEndpoint: string, endpointKind: BailianEndpointKind): string {
  const current = new URL(String(currentEndpoint || "").trim());
  const pathname = current.pathname.replace(/\/+$/, "") || "/";
  let prefix = "";
  const matched = BAILIAN_ENDPOINT_SUFFIXES.find((suffix) => pathname.toLowerCase().endsWith(suffix.toLowerCase()));
  if (matched) {
    prefix = pathname.slice(0, pathname.length - matched.length);
  } else if (/\/(?:api\/v1|compatible-mode\/v1)$/i.test(pathname)) {
    prefix = pathname.replace(/\/(?:api\/v1|compatible-mode\/v1)$/i, "");
  } else {
    throw new Error("Enter a Bailian API root or a recognized Bailian public endpoint.");
  }
  current.pathname = `${prefix}${BAILIAN_ENDPOINTS[endpointKind]}`;
  current.search = "";
  current.hash = "";
  const websocket = endpointKind === "dashscope-ws" || endpointKind === "qwen3-realtime-ws";
  if (websocket && current.protocol === "https:") current.protocol = "wss:";
  else if (websocket && current.protocol === "http:") current.protocol = "ws:";
  else if (!websocket && current.protocol === "wss:") current.protocol = "https:";
  else if (!websocket && current.protocol === "ws:") current.protocol = "http:";
  if (![ "https:", "http:", "wss:", "ws:" ].includes(current.protocol)) {
    throw new Error("Bailian endpoint must use HTTP or WebSocket transport.");
  }
  return current.toString();
}


export interface BailianModelSelection {
  route: BailianAsrRoute;
  provider: TranscribeProviderSettings;
}

/** Construct all routing fields together; unsupported or unrecognized endpoints never yield a partial update. */
export function selectBailianAsrModel(
  providerId: string,
  currentProvider: TranscribeProviderSettings,
  model: string,
): BailianModelSelection | null {
  const provider = String(providerId || "").toLowerCase();
  const endpoint = String(currentProvider.endpoint || "");
  const route = resolveBailianAsrRoute(model);
  if (!route || !endpoint) return null;
  try {
    const recognizedBailianSource = /^(?:bailian|dashscope)(?:-|$)/i.test(provider)
      || /^dashscope(?:-|$)/i.test(String(currentProvider.protocol || ""))
      || /(?:^|\.)aliyuncs\.com$/i.test(new URL(endpoint).hostname);
    if (!recognizedBailianSource) return null;
    return {
      route,
      provider: {
        ...currentProvider,
        model: String(model).trim(),
        protocol: route.protocol,
        endpoint: resolveBailianEndpoint(endpoint, route.endpointKind),
      },
    };
  } catch {
    return null;
  }
}

export function isBailianAsrCapability(capabilities: unknown): boolean {
  const values = Array.isArray(capabilities)
    ? capabilities
    : capabilities && typeof capabilities === "object"
      ? Object.keys(capabilities as Record<string, unknown>).filter((key) => Boolean((capabilities as Record<string, unknown>)[key]))
      : typeof capabilities === "string" ? [capabilities] : [];
  return values.some((value) => /^(?:ASR|Realtime-ASR)$/i.test(String(value).trim()));
}
