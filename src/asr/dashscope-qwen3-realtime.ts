import { assertSafeServiceEndpoint } from "../shared/util-llm-endpoint";
import { t } from "../shared/i18n";

export type Qwen3RealtimeState = "idle" | "connecting" | "ready" | "finishing" | "finished" | "failed";

export interface Qwen3RealtimeSocket {
  readyState?: number;
  binaryType?: string;
  send(data: string): void;
  close(): void;
  on?(event: "open" | "message" | "error" | "close", listener: (...args: unknown[]) => void): void;
  onopen?: ((event: unknown) => void) | null;
  onmessage?: ((event: { data: unknown }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  onclose?: ((event: unknown) => void) | null;
}

export type Qwen3RealtimeSocketFactory = (
  url: string,
  options: { headers: { Authorization: string }; handshakeTimeout: number },
) => Qwen3RealtimeSocket;

export interface Qwen3RealtimeOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  language?: string;
  onTranscript?: (text: string, completed: boolean) => void;
  onError?: (error: Error) => void;
  socketFactory?: Qwen3RealtimeSocketFactory;
}

export type Qwen3RealtimeServerEvent =
  | { type: "session.updated"; session?: unknown }
  | { type: "conversation.item.input_audio_transcription.text"; item_id?: string; text?: string; stash?: string; [key: string]: unknown }
  | { type: "conversation.item.input_audio_transcription.completed"; item_id?: string; text?: string; [key: string]: unknown }
  | { type: "session.finished"; [key: string]: unknown }
  | { type: "error"; error?: { message?: string; code?: string }; message?: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

const SOCKET_OPEN = 1;
let nodeWebSocketCtorPromise: Promise<Qwen3RealtimeSocketFactory | null> | null = null;

function socketFactoryFrom(candidate: unknown): Qwen3RealtimeSocketFactory | null {
  if (typeof candidate !== "function") return null;
  // Keep `ws` out of the mobile bundle; the desktop WebSocket runtime is not available there.
  const SocketConstructor = candidate as new (
    url: string,
    options: { headers: { Authorization: string }; handshakeTimeout: number },
  ) => Qwen3RealtimeSocket;
  return (url, options) => new SocketConstructor(url, options);
}

async function getDesktopSocketFactory(): Promise<Qwen3RealtimeSocketFactory> {
  if (nodeWebSocketCtorPromise === null) {
    nodeWebSocketCtorPromise = (async (): Promise<Qwen3RealtimeSocketFactory | null> => {
      try {
        const imported: unknown = await import("ws");
        const shape = imported as { WebSocket?: unknown; default?: unknown };
        return socketFactoryFrom(shape.WebSocket ?? shape.default ?? imported);
      } catch {
        return null;
      }
    })();
  }
  const factory = await nodeWebSocketCtorPromise;
  if (!factory) throw new Error(t("Qwen3 real-time transcription requires the desktop WebSocket runtime."));
  return factory;
}

function makeModelUrl(endpoint: string, model: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("model", model);
  return url.toString();
}

function socketMessageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return "";
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(typeof error === "string" ? error : fallback);
}

/** Desktop client for Bailian's Qwen3-ASR-Flash-Realtime event protocol. */
export class DashScopeQwen3RealtimeClient {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly language: string;
  state: Qwen3RealtimeState = "idle";
  private eventCounter = 0;
  private readonly onTranscript: (text: string, completed: boolean) => void;
  private readonly onError: (error: Error) => void;
  private readonly socketFactory?: Qwen3RealtimeSocketFactory;
  private socket: Qwen3RealtimeSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private resolveFinished: (() => void) | null = null;
  private rejectFinished: ((error: Error) => void) | null = null;
  private finishedPromise: Promise<void> | null = null;
  private readonly completedTranscripts: string[] = [];
  private partialTranscript = "";
  private settledFailure: Error | null = null;

  constructor(options: Qwen3RealtimeOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.language = options.language || "";
    this.onTranscript = options.onTranscript || (() => undefined);
    this.onError = options.onError || (() => undefined);
    this.socketFactory = options.socketFactory;
  }

  async connect(): Promise<void> {
    if (this.state === "ready") return;
    if (this.connectPromise !== null) return this.connectPromise;
    if (this.state !== "idle") throw new Error(`Cannot connect Qwen3 realtime client in state ${this.state}.`);
    assertSafeServiceEndpoint(this.endpoint, "websocket", t("Realtime transcription service URL"));
    const endpointUrl = new URL(this.endpoint);
    if (endpointUrl.protocol !== "wss:") throw new Error(t("Qwen3 real-time transcription requires a secure WSS endpoint."));
    if (!this.apiKey) throw new Error(t("DashScope API key is not configured."));
    if (!this.model.trim()) throw new Error(t("Transcription model name is not configured."));

    this.state = "connecting";
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    try {
      const factory = this.socketFactory ?? (await getDesktopSocketFactory());
      const socket = factory(makeModelUrl(this.endpoint, this.model), {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        handshakeTimeout: 8000,
      });
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      this.attach(socket);
    } catch (error) {
      this.fail(toError(error, "Could not create Qwen3 realtime WebSocket."));
    }
    return this.connectPromise;
  }

  /** Send one little-endian signed 16-bit mono PCM frame after session.updated. */
  appendAudio(pcm: ArrayBuffer | ArrayBufferView): boolean {
    if (this.state !== "ready" || !this.socket || this.socket.readyState !== SOCKET_OPEN) return false;
    const bytes = pcm instanceof ArrayBuffer
      ? new Uint8Array(pcm)
      : new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    this.socket.send(JSON.stringify({ event_id: this.nextEventId(), type: "input_audio_buffer.append", audio: bytesToBase64(bytes) }));
    return true;
  }

  /** Finish input and resolve only after the service confirms session.finished. */
  finish(): Promise<void> {
    if (this.state === "finished") return Promise.resolve();
    if (this.state === "failed") return Promise.reject(this.settledFailure || new Error("Qwen3 realtime session failed."));
    if (this.state === "idle" || this.state === "connecting") return Promise.reject(new Error("Qwen3 realtime session is not ready."));
    if (this.finishedPromise !== null) return this.finishedPromise;
    this.state = "finishing";
    this.finishedPromise = new Promise<void>((resolve, reject) => {
      this.resolveFinished = resolve;
      this.rejectFinished = reject;
    });
    try {
      if (!this.socket || this.socket.readyState !== SOCKET_OPEN) throw new Error("Qwen3 realtime WebSocket is not open.");
      this.socket.send(JSON.stringify({ event_id: this.nextEventId(), type: "session.finish" }));
    } catch (error) {
      this.fail(toError(error, "Could not finish Qwen3 realtime session."));
    }
    return this.finishedPromise;
  }

  getFullText(): string {
    return (this.completedTranscripts.join("") + (this.state === "finished" ? "" : this.partialTranscript)).trim();
  }

  private nextEventId(): string {
    this.eventCounter += 1;
    return `qnalog-${Date.now()}-${this.eventCounter}`;
  }

  private attach(socket: Qwen3RealtimeSocket): void {
    const onOpen = () => {
      try {
        const session: Record<string, unknown> = {
          input_audio_format: "pcm",
          sample_rate: 16000,
          turn_detection: { type: "server_vad" },
        };
        if (/^(zh|yue|en|ja|de|ko|ru|fr|pt|ar|it|es|hi|id|th|tr|uk|vi|cs|da|fil|fi|is|ms|no|pl|sv)$/i.test(this.language)) {
          session.input_audio_transcription = { language: this.language.toLowerCase() };
        }
        socket.send(JSON.stringify({ event_id: this.nextEventId(), type: "session.update", session }));
      } catch (error) { this.fail(toError(error, "Could not configure Qwen3 realtime session.")); }
    };
    const onMessage = (data: unknown) => this.handleMessage(data);
    const onSocketError = (error: unknown) => this.fail(toError(error, "Qwen3 realtime WebSocket error."));
    const onClose = () => {
      if (this.state !== "finished" && this.state !== "failed") {
        this.fail(new Error(this.state === "connecting"
          ? "Qwen3 realtime connection closed before the session was ready."
          : "Qwen3 realtime connection closed before session.finished."));
      }
    };
    if (typeof socket.on === "function") {
      socket.on("open", onOpen);
      socket.on("message", (data) => onMessage(data));
      socket.on("error", onSocketError);
      socket.on("close", onClose);
    } else {
      socket.onopen = onOpen;
      socket.onmessage = (event) => onMessage(event.data);
      socket.onerror = onSocketError;
      socket.onclose = onClose;
    }
  }

  private handleMessage(data: unknown): void {
    const text = socketMessageText(data);
    if (!text) return;
    let event: Qwen3RealtimeServerEvent;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !("type" in parsed) || typeof parsed.type !== "string") {
        throw new Error("missing event type");
      }
      event = parsed as Qwen3RealtimeServerEvent;
    } catch {
      this.fail(new Error("Qwen3 realtime service sent invalid JSON or an invalid event."));
      return;
    }

    switch (event.type) {
      case "session.updated":
        if (this.state !== "connecting") return;
        this.state = "ready";
        this.resolveReady?.();
        this.resolveReady = null;
        this.rejectReady = null;
        return;
      case "conversation.item.input_audio_transcription.text": {
        const confirmed = typeof event.text === "string" ? event.text : "";
        const draft = typeof event.stash === "string" ? event.stash : "";
        this.partialTranscript = confirmed + draft;
        this.onTranscript(this.getFullText(), false);
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const transcript = typeof event.text === "string" ? event.text : this.partialTranscript;
        if (transcript) this.completedTranscripts.push(transcript);
        this.partialTranscript = "";
        this.onTranscript(this.getFullText(), true);
        return;
      }
      case "session.finished":
        if (this.state !== "finishing") return;
        this.state = "finished";
        this.partialTranscript = "";
        this.resolveFinished?.();
        this.resolveFinished = null;
        this.rejectFinished = null;
        try { this.socket?.close(); } catch { /* already closed */ }
        return;
      case "error": {
        let detail = typeof event.message === "string" ? event.message : "";
        if (!detail && "error" in event && event.error && typeof event.error === "object") {
          const errorInfo = event.error;
          if ("message" in errorInfo && typeof errorInfo.message === "string") detail = errorInfo.message;
          else if ("code" in errorInfo && typeof errorInfo.code === "string") detail = errorInfo.code;
        }
        this.fail(new Error(`Qwen3 realtime service error: ${detail || JSON.stringify(event)}`));
        return;
      }
      default:
        return;
    }
  }

  private fail(error: Error): void {
    if (this.state === "failed" || this.state === "finished") return;
    this.state = "failed";
    this.settledFailure = error;
    this.onError(error);
    this.rejectReady?.(error);
    this.rejectReady = null;
    this.resolveReady = null;
    this.rejectFinished?.(error);
    this.rejectFinished = null;
    this.resolveFinished = null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;
    output += alphabet[first >> 2];
    output += alphabet[((first & 3) << 4) | (second >> 4)];
    output += hasSecond ? alphabet[((second & 15) << 2) | (third >> 6)] : "=";
    output += hasThird ? alphabet[third & 63] : "=";
  }
  return output;
}
