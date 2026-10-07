import { describe, expect, it, vi } from "vitest";
import {
  DashScopeQwen3RealtimeClient,
  type Qwen3RealtimeSocket,
  type Qwen3RealtimeSocketFactory,
} from "../src/asr/dashscope-qwen3-realtime";

class FakeSocket implements Qwen3RealtimeSocket {
  readyState = 0;
  sent: string[] = [];
  listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(readonly url: string, readonly options: { headers: { Authorization: string }; handshakeTimeout: number }) {}
  on(event: "open" | "message" | "error" | "close", listener: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event) || [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  emit(event: string, ...args: unknown[]): void {
    if (event === "open") this.readyState = 1;
    for (const listener of this.listeners.get(event) || []) listener(...args);
  }
  message(payload: object): void { this.emit("message", JSON.stringify(payload)); }
}

function setup(overrides: Partial<ConstructorParameters<typeof DashScopeQwen3RealtimeClient>[0]> = {}) {
  let socket: FakeSocket | null = null;
  const socketFactory: Qwen3RealtimeSocketFactory = (url, options) => {
    socket = new FakeSocket(url, options);
    return socket;
  };
  const client = new DashScopeQwen3RealtimeClient({
    endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    apiKey: "fake-key",
    model: "qwen3-asr-flash-realtime",
    socketFactory,
    ...overrides,
  });
  return { client, getSocket: () => socket };
}

async function openSession(client: DashScopeQwen3RealtimeClient, getSocket: () => FakeSocket): Promise<FakeSocket> {
  const connected = client.connect();
  await vi.waitFor(() => expect(getSocket()).toBeTruthy());
  const socket = getSocket();
  socket.emit("open");
  const sessionUpdate = JSON.parse(socket.sent[0]) as Record<string, unknown>;
  expect(sessionUpdate).toMatchObject({
    type: "session.update",
    session: {
      input_audio_format: "pcm",
      sample_rate: 16000,
      turn_detection: { type: "server_vad" },
    },
  });
  expect(sessionUpdate.event_id).toEqual(expect.any(String));
  socket.message({ type: "session.updated", session: { id: "session-1" } });
  await connected;
  return socket;
}

describe("DashScope Qwen3 realtime client", () => {
  it("uses Authorization handshake and escapes the complete model ID in the query", async () => {
    const model = "qwen3-asr-flash-realtime.2025/01 & preview";
    const { client, getSocket } = setup({ model });
    const connecting = client.connect();
    await vi.waitFor(() => expect(getSocket()).not.toBeNull());
    const openedSocket = getSocket()!;
    expect(openedSocket.options.headers).toEqual({ Authorization: "Bearer fake-key" });
    expect(new URL(openedSocket.url).searchParams.get("model")).toBe(model);
    expect(openedSocket.url).toContain("model=qwen3-asr-flash-realtime.2025%2F01+%26+preview");
    openedSocket.emit("open");
    openedSocket.message({ type: "session.updated" });
    await connecting;
  });

  it("does not send PCM before session.updated and appends Base64 after it", async () => {
    const { client, getSocket } = setup();
    const connecting = client.connect();
    await vi.waitFor(() => expect(getSocket()).not.toBeNull());
    const openedSocket = getSocket()!;
    openedSocket.emit("open");
    expect(client.appendAudio(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(openedSocket.sent).toHaveLength(1);
    openedSocket.message({ type: "session.updated" });
    await connecting;
    expect(client.appendAudio(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(JSON.parse(openedSocket.sent[1])).toMatchObject({ type: "input_audio_buffer.append", audio: "AQID", event_id: expect.any(String) });
  });

  it("retains completed transcript events and waits for session.finished", async () => {
    const updates: Array<{ text: string; completed: boolean }> = [];
    const { client, getSocket } = setup({ onTranscript: (text, completed) => updates.push({ text, completed }) });
    const openedSocket = await openSession(client, () => getSocket()!);
    openedSocket.message({ type: "conversation.item.input_audio_transcription.text", text: "你好", stash: "啊" });
    openedSocket.message({ type: "conversation.item.input_audio_transcription.completed", text: "你好啊。" });
    openedSocket.message({ type: "conversation.item.input_audio_transcription.completed", text: "下一句。" });
    expect(client.getFullText()).toBe("你好啊。下一句。");
    const finishing = client.finish();
    expect(JSON.parse(openedSocket.sent.at(-1)!)).toMatchObject({ type: "session.finish", event_id: expect.any(String) });
    let resolved = false;
    void finishing.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    openedSocket.message({ type: "session.finished" });
    await finishing;
    expect(client.state).toBe("finished");
    expect(client.getFullText()).toBe("你好啊。下一句。");
    expect(updates.at(-1)).toEqual({ text: "你好啊。下一句。", completed: true });
  });

  it("rejects service errors during connect and finish", async () => {
    const onError = vi.fn();
    const first = setup({ onError });
    const connecting = first.client.connect();
    await vi.waitFor(() => expect(first.getSocket()).not.toBeNull());
    first.getSocket()!.emit("open");
    first.getSocket()!.message({ type: "error", error: { code: "model_not_found", message: "not enabled" } });
    await expect(connecting).rejects.toThrow("not enabled");
    expect(onError).toHaveBeenCalledOnce();

    const second = setup();
    await openSession(second.client, () => second.getSocket()!);
    const finishing = second.client.finish();
    second.getSocket()!.message({ type: "error", error: { message: "provider failed" } });
    await expect(finishing).rejects.toThrow("provider failed");
  });

  it("rejects premature close before readiness or finish confirmation", async () => {
    const beforeReady = setup();
    const connecting = beforeReady.client.connect();
    await vi.waitFor(() => expect(beforeReady.getSocket()).not.toBeNull());
    beforeReady.getSocket()!.emit("close");
    await expect(connecting).rejects.toThrow(/closed before the session was ready/);

    const beforeFinished = setup();
    await openSession(beforeFinished.client, () => beforeFinished.getSocket()!);
    const finishing = beforeFinished.client.finish();
    beforeFinished.getSocket()!.emit("close");
    await expect(finishing).rejects.toThrow(/before session.finished/);
  });

  it("rejects insecure or non-WSS endpoints before opening a socket", async () => {
    const factory = vi.fn(() => new FakeSocket("", { headers: { Authorization: "" }, handshakeTimeout: 0 }));
    for (const endpoint of ["ws://example.com/realtime", "https://example.com/realtime"]) {
      const client = new DashScopeQwen3RealtimeClient({ endpoint, apiKey: "fake-key", model: "qwen3-asr-flash-realtime", socketFactory: factory });
      await expect(client.connect()).rejects.toThrow();
    }
    expect(factory).not.toHaveBeenCalled();
  });
});
