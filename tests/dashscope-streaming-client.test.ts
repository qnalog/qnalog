import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ Platform: { isMobile: false, isMobileApp: false } }));

import { DashScopeStreamingClient } from "../src/asr/clients";

class FakeSocket {
  readyState = 0;
  sent: Array<string | ArrayBuffer> = [];
  listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(readonly url: string, readonly options: { headers: Record<string, string>; handshakeTimeout: number }) {}
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) || []), listener]);
  }
  send(data: string | ArrayBuffer): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.emit("close"); }
  emit(event: string, ...args: unknown[]): void {
    if (event === "open") this.readyState = 1;
    for (const listener of this.listeners.get(event) || []) listener(...args);
  }
  message(header: Record<string, unknown>, payload: unknown = {}): void {
    this.emit("message", JSON.stringify({ header, payload }));
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DashScope task WebSocket transcription", () => {
  it("uses only supported ASR fields and reads Gummy transcription results without translation", async () => {
    let socket: FakeSocket | null = null;
    const updates: Array<{ text: string; final: boolean }> = [];
    const client = new DashScopeStreamingClient({
      endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      apiKey: "test-key",
      model: "gummy-realtime-v1",
      language: "zh",
      socketFactory: class {
        constructor(url: string, options: FakeSocket["options"]) {
          socket = new FakeSocket(url, options);
          return socket;
        }
      },
      onPartial: (text: string, final: boolean) => updates.push({ text, final }),
    });

    const connecting = client.connect();
    await vi.waitFor(() => expect(socket).not.toBeNull());
    const opened = socket!;
    opened.emit("open");
    const start = JSON.parse(String(opened.sent[0])) as { payload: { parameters: Record<string, unknown> } };
    expect(start.payload.parameters).toEqual({ format: "pcm", sample_rate: 16000 });
    opened.message({ event: "task-started" });
    await connecting;
    client.sendAudioFrame(new ArrayBuffer(4));
    expect(opened.sent[1]).toBeInstanceOf(ArrayBuffer);

    opened.message({ event: "result-generated" }, { output: { transcription: { text: "你好", sentence_end: false } } });
    opened.message({ event: "result-generated" }, {
      output: {
        transcription: { text: "你好。", sentence_end: true },
        translations: [{ text: "Hello." }],
      },
    });
    expect(client.getFullText()).toBe("你好。");
    expect(updates).toEqual([
      { text: "你好", final: false },
      { text: "你好。", final: true },
    ]);
  });

  it("rotates Gummy one-sentence tasks before the one-minute service limit and sends queued PCM once", async () => {
    const sockets: FakeSocket[] = [];
    const client = new DashScopeStreamingClient({
      endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      apiKey: "test-key",
      model: "gummy-chat-v1",
      socketFactory: class {
        constructor(url: string, options: FakeSocket["options"]) {
          const socket = new FakeSocket(url, options);
          sockets.push(socket);
          return socket;
        }
      },
    });
    const connecting = client.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const first = sockets[0];
    first.emit("open");
    const firstTask = JSON.parse(String(first.sent[0])) as { header: { task_id: string } };
    first.message({ event: "task-started", task_id: firstTask.header.task_id });
    await connecting;
    client.sendAudioFrame(new ArrayBuffer(55 * 16_000 * 2));
    expect(JSON.parse(String(first.sent[2])).header).toMatchObject({
      action: "finish-task",
      task_id: firstTask.header.task_id,
    });
    first.message({ event: "result-generated", task_id: firstTask.header.task_id }, {
      output: { transcription: { text: "第一句。", sentence_end: true } },
    });
    first.message({ event: "task-finished", task_id: firstTask.header.task_id });
    client.sendAudioFrame(new ArrayBuffer(4));
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    const second = sockets[1];
    second.emit("open");
    second.message({ event: "task-started" });
    const secondTask = JSON.parse(String(second.sent[0])) as { header: { task_id: string } };
    expect(secondTask.header.task_id).not.toBe(firstTask.header.task_id);
    expect(second.sent[1]).toBeInstanceOf(ArrayBuffer);
    second.message({ event: "result-generated", task_id: secondTask.header.task_id }, {
      output: { transcription: { text: "第二句。", sentence_end: true } },
    });
    expect(client.getFullText()).toBe("第一句。第二句。");
  });
  it("finishes the current Gummy task when recording stops during a handoff", async () => {
    const sockets: FakeSocket[] = [];
    const client = new DashScopeStreamingClient({
      endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      apiKey: "test-key",
      model: "gummy-chat-v1",
      socketFactory: class {
        constructor(url: string, options: FakeSocket["options"]) {
          const socket = new FakeSocket(url, options);
          sockets.push(socket);
          return socket;
        }
      },
    });
    const connecting = client.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const first = sockets[0];
    first.emit("open");
    const firstTaskId = (JSON.parse(String(first.sent[0])) as { header: { task_id: string } }).header.task_id;
    first.message({ event: "task-started", task_id: firstTaskId });
    await connecting;
    client.sendAudioFrame(new ArrayBuffer(55 * 16_000 * 2));
    first.message({ event: "task-finished", task_id: firstTaskId });
    client.sendAudioFrame(new ArrayBuffer(4));
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const finished = client.finish();
    const second = sockets[1];
    second.emit("open");
    const secondTaskId = (JSON.parse(String(second.sent[0])) as { header: { task_id: string } }).header.task_id;
    second.message({ event: "task-started", task_id: secondTaskId });
    const sentEvents = second.sent.filter((item): item is string => typeof item === "string").map((item) => JSON.parse(item));
    expect(sentEvents.filter((item) => item.header?.action === "finish-task")).toHaveLength(1);
    expect(second.sent.some((item) => item instanceof ArrayBuffer)).toBe(true);
    second.message({ event: "task-finished", task_id: secondTaskId });
    await finished;
  });

});
