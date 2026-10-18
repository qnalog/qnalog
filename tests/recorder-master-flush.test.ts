vi.mock("obsidian", () => ({ Platform: { isMobile: false, isMobileApp: false } }));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecorderService } from "../src/audio/recorder-service";
import type { MasterFlushPayload, RecorderHost } from "../src/audio/recorder-service";
import { makeRecordingIssue } from "../src/asr/transcribe";
import { resolveRuntimeAudioInputMode } from "../src/notes/recording-issues";
import { MASTER_FLUSH_INTERVAL_MS } from "../src/shared/limits";
import type { PluginSettings, RecorderSegmentPayload } from "../src/shared/types";

// 每个 MediaRecorder 只是测试替身：记录 start/stop/pause/resume，并让测试手动推送分片。
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType || "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }
  start(): void { this.state = "recording"; }
  stop(): void {
    this.state = "inactive";
    if (this.onstop) this.onstop();
  }
  pause(): void { this.state = "paused"; }
  resume(): void { this.state = "recording"; }
  push(text: string): void {
    this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) });
  }
}

function makeStream() {
  const track = {
    kind: "audio",
    label: "Test microphone",
    enabled: true,
    muted: false,
    readyState: "live" as MediaStreamTrackState,
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
}

function makeHost(): RecorderHost {
  const settings: Pick<PluginSettings, "audioChannelMode" | "selectedMicrophoneDevice" | "selectedVirtualDevice"> = {
    audioChannelMode: "mono",
    selectedMicrophoneDevice: "",
    selectedVirtualDevice: "",
  };
  return {
    getSettings: () => settings,
    prefersOpus: () => false,
    resolveCaptureMode: (mode) => resolveRuntimeAudioInputMode(mode),
    makeRecordingIssue,
    setRecordingIssue: () => undefined,
    clearRecordingIssue: () => undefined,
    logDiagnostic: async () => undefined,
  };
}

function installBrowser(): void {
  const mediaDevices = { getUserMedia: vi.fn().mockResolvedValue(makeStream()) };
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("navigator", { mediaDevices });
  vi.stubGlobal("window", {
    setInterval: (...args: Parameters<typeof globalThis.setInterval>) => globalThis.setInterval(...args),
    clearInterval: (...args: Parameters<typeof globalThis.clearInterval>) => globalThis.clearInterval(...args),
    setTimeout: (...args: Parameters<typeof globalThis.setTimeout>) => globalThis.setTimeout(...args),
    AudioContext: undefined,
  });
}

/** 按 1 秒推进时钟，每秒推送一个分片（内容为 `c<序号>;`）。 */
async function recordSeconds(from: number, to: number): Promise<void> {
  const master = FakeMediaRecorder.instances[0]!;
  for (let second = from; second <= to; second++) {
    await vi.advanceTimersByTimeAsync(1000);
    master.push(`c${second};`);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeMediaRecorder.instances = [];
  installBrowser();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("master audio flush while recording", () => {
  it("does not flush before the interval, then flushes only the new chunks at each interval", async () => {
    const service = new RecorderService(makeHost());
    const flushes: MasterFlushPayload[] = [];
    const onMasterFlush = vi.fn((payload: MasterFlushPayload) => { flushes.push(payload); return true; });
    await service.start({ onMasterFlush });

    // 0 到 19 秒：还没到第一个间隔，不应发起落盘。
    await recordSeconds(1, 19);
    expect(onMasterFlush).not.toHaveBeenCalled();

    // 第 20 秒：tick 发起第一次落盘，覆盖 c1..c19。
    await vi.advanceTimersByTimeAsync(1000);
    expect(onMasterFlush).toHaveBeenCalledTimes(1);
    expect(flushes[0]!.chunkCount).toBe(19);
    expect(flushes[0]!.elapsedMs).toBeGreaterThanOrEqual(MASTER_FLUSH_INTERVAL_MS);
    expect(await flushes[0]!.blob.text()).toBe(Array.from({ length: 19 }, (_, i) => `c${i + 1};`).join(""));

    // 第 40 秒：第二次只覆盖上次之后的 c20..c39，不重复已落盘的分片。
    FakeMediaRecorder.instances[0]!.push("c20;");
    await recordSeconds(21, 39);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onMasterFlush).toHaveBeenCalledTimes(2);
    expect(flushes[1]!.chunkCount).toBe(20);
    expect(await flushes[1]!.blob.text()).toBe(Array.from({ length: 20 }, (_, i) => `c${i + 20};`).join(""));
  });

  it("keeps the complete master audio on stop even after several flushes", async () => {
    const service = new RecorderService(makeHost());
    const onMasterFlush = vi.fn(() => true);
    const onSegment = vi.fn((_payload: RecorderSegmentPayload) => undefined);
    await service.start({ onMasterFlush, onSegment });
    await recordSeconds(1, 45);
    expect(onMasterFlush.mock.calls.length).toBeGreaterThanOrEqual(2);

    await service.stop();
    const final = onSegment.mock.calls.find(([payload]) => payload.isFinal)?.[0];
    expect(final?.masterBlob).toBeDefined();
    expect(await final!.masterBlob!.text()).toBe(Array.from({ length: 45 }, (_, i) => `c${i + 1};`).join(""));
  });

  it("does not count paused time toward the interval and keeps flush numbering monotonic", async () => {
    const service = new RecorderService(makeHost());
    const flushes: MasterFlushPayload[] = [];
    await service.start({ onMasterFlush: (payload) => { flushes.push(payload); return true; } });
    const master = FakeMediaRecorder.instances[0]!;
    master.push("c1;");
    await vi.advanceTimersByTimeAsync(10_000);
    master.push("c2;");

    service.pause();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(flushes).toHaveLength(0);

    service.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    master.push("c3;");
    expect(flushes).toHaveLength(0);

    // 录音时长 15 秒（不含暂停）后仍不到 20 秒；再录 5 秒才到第一次间隔。
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.chunkCount).toBe(3);
    expect(flushes[0]!.elapsedMs).toBeGreaterThanOrEqual(MASTER_FLUSH_INTERVAL_MS);
    expect(flushes[0]!.elapsedMs).toBeLessThan(MASTER_FLUSH_INTERVAL_MS + 1000);
  });

  it("retries a failed flush with the same chunks and does not drop them", async () => {
    const service = new RecorderService(makeHost());
    const flushes: MasterFlushPayload[] = [];
    let attempt = 0;
    const onMasterFlush = vi.fn((payload: MasterFlushPayload) => {
      flushes.push(payload);
      attempt++;
      if (attempt === 1) return false;
      if (attempt === 2) throw new Error("simulated vault write failure");
      return true;
    });
    await service.start({ onMasterFlush });

    // 第 20 秒的第一次请求返回 false（覆盖 c1..c19）。
    await recordSeconds(1, 20);
    expect(onMasterFlush).toHaveBeenCalledTimes(1);
    // 第 40 秒的重试抛错（仍覆盖 c1..c39，因为前一次没有确认）。
    await recordSeconds(21, 40);
    expect(onMasterFlush).toHaveBeenCalledTimes(2);
    // 第 60 秒成功（覆盖 c1..c59）。
    await recordSeconds(41, 62);
    expect(onMasterFlush).toHaveBeenCalledTimes(3);

    expect(flushes.map((payload) => payload.chunkCount)).toEqual([19, 39, 59]);
    expect(await flushes[2]!.blob.text()).toBe(Array.from({ length: 59 }, (_, i) => `c${i + 1};`).join(""));
  });

  it("does nothing while idle and stops flushing after stop", async () => {
    const service = new RecorderService(makeHost());
    const onMasterFlush = vi.fn(() => true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onMasterFlush).not.toHaveBeenCalled();

    await service.start({ onMasterFlush });
    await recordSeconds(1, 25);
    await service.stop();
    const callsAtStop = onMasterFlush.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onMasterFlush.mock.calls.length).toBe(callsAtStop);
  });
});
