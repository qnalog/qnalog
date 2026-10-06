vi.mock("obsidian", () => ({ Platform: { isMobile: false, isMobileApp: false } }));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecorderService } from "../src/audio/recorder-service";
import type { RecorderHost } from "../src/audio/recorder-service";
import { makeRecordingIssue } from "../src/asr/transcribe";
import { resolveRuntimeAudioInputMode } from "../src/notes/recording-issues";
import type { PluginSettings } from "../src/shared/types";

type RecorderEvent = "dataavailable" | "stop" | "error";
type RecorderHandler = ((event: unknown) => void) | null;
type RecordingIssueRecord = { kind: string; at: number; message?: string; stoppedAtMs?: number | null; reason?: string };

class FakeMediaRecorder {
  static supported = ["audio/mp4;codecs=mp4a.40.2", "audio/webm;codecs=opus"];
  static instances: FakeMediaRecorder[] = [];
  static failConstructionAt = 0;
  static constructionCount = 0;

  static isTypeSupported(type: string): boolean { return this.supported.includes(type); }

  state: RecordingState = "inactive";
  mimeType: string;
  ondataavailable: RecorderHandler = null;
  onstop: RecorderHandler = null;
  onerror: RecorderHandler = null;
  stopCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  stopBehavior: "event" | "silent" | "throw" = "event";
  failPause = false;
  failResume = false;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    FakeMediaRecorder.constructionCount++;
    if (FakeMediaRecorder.failConstructionAt === FakeMediaRecorder.constructionCount) {
      throw new Error("simulated recorder construction failure");
    }
    this.mimeType = options?.mimeType || "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  start(): void { this.state = "recording"; }
  stop(): void {
    this.stopCalls++;
    if (this.stopBehavior === "throw") throw new Error("simulated stop failure");
    this.state = "inactive";
    if (this.stopBehavior === "event") this.emit("stop");
  }
  pause(): void {
    this.pauseCalls++;
    if (this.failPause) throw new Error("simulated pause failure");
    this.state = "paused";
  }
  resume(): void {
    this.resumeCalls++;
    if (this.failResume) throw new Error("simulated resume failure");
    this.state = "recording";
  }
  emit(type: RecorderEvent, event: unknown = {}): void {
    const handler = type === "stop"
      ? this.onstop
      : type === "dataavailable"
        ? this.ondataavailable
        : this.onerror;
    if (handler && (type !== "dataavailable" || (event !== null && typeof event === "object" && "data" in event))) {
      handler(event as Event);
    }
  }
  data(text: string, type = this.mimeType): void { this.emit("dataavailable", { data: new Blob([text], { type }) }); }
}

function makeStream() {
  const ended = new Set<() => void>();
  const muted = new Set<() => void>();
  const track = {
    kind: "audio",
    label: "Test microphone",
    enabled: true,
    muted: false,
    readyState: "live" as MediaStreamTrackState,
    stop: vi.fn(() => { track.readyState = "ended"; }),
    addEventListener: vi.fn((name: string, callback: EventListenerOrEventListenerObject) => {
      const listener = callback as () => void;
      (name === "ended" ? ended : muted).add(listener);
    }),
    removeEventListener: vi.fn((name: string, callback: EventListenerOrEventListenerObject) => {
      (name === "ended" ? ended : muted).delete(callback as () => void);
    }),
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track, ended, muted };
}

function makeHost() {
  const effects = { issues: [] as Array<{ kind: string; issue: RecordingIssueRecord }>, cleared: [] as string[], logs: [] as unknown[][] };
  let settings: Pick<PluginSettings, "audioChannelMode" | "selectedMicrophoneDevice" | "selectedVirtualDevice"> = {
    audioChannelMode: "mono",
    selectedMicrophoneDevice: "",
    selectedVirtualDevice: "",
  };
  let preferOpus = false;
  const host: RecorderHost = {
    getSettings: () => settings,
    prefersOpus: () => preferOpus,
    resolveCaptureMode: (mode) => resolveRuntimeAudioInputMode(mode),
    makeRecordingIssue,
    setRecordingIssue: (kind, issue) => { effects.issues.push({ kind, issue }); },
    clearRecordingIssue: (kind) => { effects.cleared.push(kind); },
    logDiagnostic: async (...args) => { effects.logs.push(args); },
  };
  return {
    host,
    effects,
    setSettings(value: typeof settings) { settings = value; },
    setPreferOpus(value: boolean) { preferOpus = value; },
  };
}

function installBrowser(recorderCtor = FakeMediaRecorder) {
  const mic = makeStream();
  const mediaDevices = { getUserMedia: vi.fn().mockResolvedValue(mic.stream) };
  vi.stubGlobal("MediaRecorder", recorderCtor);
  vi.stubGlobal("navigator", { mediaDevices });
  vi.stubGlobal("window", {
    setInterval: (...args: Parameters<typeof globalThis.setInterval>) => globalThis.setInterval(...args),
    clearInterval: (...args: Parameters<typeof globalThis.clearInterval>) => globalThis.clearInterval(...args),
    setTimeout: (...args: Parameters<typeof globalThis.setTimeout>) => globalThis.setTimeout(...args),
    AudioContext: undefined,
  });
  return { mic, mediaDevices };
}

function resetFakeRecorder() {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.failConstructionAt = 0;
  FakeMediaRecorder.constructionCount = 0;
  FakeMediaRecorder.supported = ["audio/mp4;codecs=mp4a.40.2", "audio/webm;codecs=opus"];
}

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetFakeRecorder();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RecorderService browser boundaries", () => {
  it("waits for stop events before releasing resources and ignores late stop after timeout", async () => {
    vi.useFakeTimers();
    const { mic } = installBrowser();
    const { host } = makeHost();
    const service = new RecorderService(host);
    let releaseCallback!: () => void;
    const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
    const onSegment = vi.fn(() => callbackGate);
    await service.start({ onSegment });
    const segment = FakeMediaRecorder.instances[1]!;
    const master = FakeMediaRecorder.instances[0]!;
    segment.data("final-segment");
    master.data("whole-session");
    segment.stopBehavior = "silent";
    master.stopBehavior = "event";
    const stopping = service.stop();
    let settled = false;
    void stopping.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mic.track.stop).not.toHaveBeenCalled();
    segment.emit("stop");
    await Promise.resolve();
    expect(typeof master.onstop).toBe("function");
    master.emit("stop");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mic.track.stop).toHaveBeenCalled();
    expect(service.state).toBe("idle");
    expect(settled).toBe(false);
    expect(await onSegment.mock.calls[0]![0].blob.text()).toBe("final-segment");
    releaseCallback();
    const result = await stopping;
    expect(result?.segmentsEmitted).toBe(1);
    expect(result?.totalDurationMs).toBeGreaterThanOrEqual(0);

    const { mic: timeoutMic } = installBrowser();
    const second = new RecorderService(host);
    const lateCallback = vi.fn();
    await second.start({ onSegment: lateCallback });
    const timeoutRecorders = FakeMediaRecorder.instances.slice(-2);
    const timeoutSegment = timeoutRecorders[1]!;
    const timeoutMaster = timeoutRecorders[0]!;
    timeoutSegment.data("timeout-kept");
    timeoutMaster.data("timeout-master");
    timeoutSegment.stopBehavior = "silent";
    let timeoutSettled = false;
    const pendingStop = second.stop().then((result) => { timeoutSettled = true; return result; });
    await vi.advanceTimersByTimeAsync(3999);
    expect(timeoutSettled).toBe(false);
    expect(timeoutMic.track.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const timeoutResult = await pendingStop;
    expect(timeoutResult?.segmentsEmitted).toBe(1);
    expect(timeoutMic.track.stop).toHaveBeenCalled();
    expect(await lateCallback.mock.calls[0]![0].blob.text()).toBe("timeout-kept");
    const countAfterTimeout = lateCallback.mock.calls.length;
    timeoutSegment.emit("stop");
    timeoutMaster.emit("stop");
    expect(lateCallback).toHaveBeenCalledTimes(countAfterTimeout);
    expect(second.state).toBe("idle");
  });

  it("swallows final callback rejection after cleaning up stopped resources", async () => {
    const { mic } = installBrowser();
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = new RecorderService(makeHost().host);
    const onSegment = vi.fn((payload) => { if (payload.isFinal) throw new Error("consumer failed"); });
    await service.start({ onSegment });
    FakeMediaRecorder.instances[1]!.data("first segment");
    await service.cutSegment();
    FakeMediaRecorder.instances.at(-1)!.data("final audio");
    await expect(service.stop()).resolves.toMatchObject({ segmentsEmitted: 2 });
    expect(onSegment.mock.calls[1]![0].masterMime).toBeNull();
    expect(service.state).toBe("idle");
    expect(logError).toHaveBeenCalledWith("[QnALog] onSegment(final) error", expect.any(Error));
  });

  it("emits master-only final audio when the final segment has no data", async () => {
    installBrowser();
    const service = new RecorderService(makeHost().host);
    const onSegment = vi.fn();
    await service.start({ onSegment });
    const initialSegment = FakeMediaRecorder.instances[1]!;
    initialSegment.data("first segment");
    await service.cutSegment();
    const finalSegment = FakeMediaRecorder.instances.at(-1)!;
    FakeMediaRecorder.instances[0]!.data("remaining master audio");
    finalSegment.stopBehavior = "throw";
    await service.stop();
    const finalPayload = onSegment.mock.calls.at(-1)?.[0];
    expect(finalPayload).toMatchObject({ isFinal: true, masterOnly: true, index: 1 });
    expect(finalPayload.blob.size).toBe(0);
    expect(await finalPayload.masterBlob.text()).toBe("remaining master audio");
    expect(finalPayload.masterMime).toBeTruthy();
  });

  it("returns a successful stop without a final payload when both audio routes are empty", async () => {
    installBrowser();
    const service = new RecorderService(makeHost().host);
    const onSegment = vi.fn();
    await service.start({ onSegment });
    FakeMediaRecorder.instances[1]!.stopBehavior = "throw";
    const result = await service.stop();
    expect(result).toMatchObject({ segmentsEmitted: 1 });
    expect(onSegment).not.toHaveBeenCalled();
  });

  it("preserves master audio and the completed segment when segment restart fails, then rethrows", async () => {
    installBrowser();
    const { host, effects } = makeHost();
    const service = new RecorderService(host);
    const onSegment = vi.fn();
    await service.start({ onSegment });
    const firstSegment = FakeMediaRecorder.instances[1]!;
    const master = FakeMediaRecorder.instances[0]!;
    firstSegment.data("cut payload");
    master.data("master survives");
    FakeMediaRecorder.failConstructionAt = FakeMediaRecorder.constructionCount + 1;
    await expect(service.cutSegment()).rejects.toThrow("simulated recorder construction failure");
    expect(service.state).toBe("paused");
    expect(service.cutting).toBe(false);
    expect(service.recorder).toBe(firstSegment);
    expect(master.state).toBe("paused");
    expect(await onSegment.mock.calls[0]![0].blob.text()).toBe("cut payload");
    expect(onSegment.mock.calls[0]![0]).toMatchObject({ index: 0, isFinal: false });
    expect(service.masterChunks).toHaveLength(1);
    expect(await new Blob(service.masterChunks).text()).toBe("master survives");
    expect(effects.issues.at(-1)).toMatchObject({ kind: "service", issue: { reason: "segment-restart-failed" } });
    expect(effects.logs.at(-1)?.[1]).toBe("recording.segment_cut_failed");
    await service.stop();
  });

  it("resumes paused recorders, accumulates pause time, and stays paused when segment resume fails", async () => {
    vi.useFakeTimers();
    installBrowser();
    const { host, effects } = makeHost();
    const service = new RecorderService(host);
    await service.start();
    const segment = FakeMediaRecorder.instances[1]!;
    const master = FakeMediaRecorder.instances[0]!;
    segment.data("preserved segment");
    master.data("preserved master");
    service.pause();
    await vi.advanceTimersByTimeAsync(1250);
    service.resume();
    expect(service.state).toBe("recording");
    expect(service.pausedFor).toBe(1250);
    expect(segment.resumeCalls).toBe(1);
    expect(master.resumeCalls).toBe(1);
    expect(effects.cleared).toContain("service");
    service.pause();
    segment.failResume = true;
    service.resume();
    expect(service.state).toBe("paused");
    expect(await new Blob(service.chunks).text()).toBe("preserved segment");
    expect(await new Blob(service.masterChunks).text()).toBe("preserved master");
    await service.stop();
  });

  it("remains paused with a service issue when the master recorder fails to resume", async () => {
    installBrowser();
    const { host, effects } = makeHost();
    const service = new RecorderService(host);
    await service.start();
    const segment = FakeMediaRecorder.instances[1]!;
    const master = FakeMediaRecorder.instances[0]!;
    segment.data("master failure segment");
    master.data("master failure master");
    service.pause();
    master.failResume = true;
    service.resume();
    expect(service.state).toBe("paused");
    expect(segment.state).toBe("paused");
    expect(await new Blob(service.chunks).text()).toBe("master failure segment");
    expect(await new Blob(service.masterChunks).text()).toBe("master failure master");
    await service.stop();
  });

  it("reads dynamic audio settings per start and honors provider MIME preference errors", async () => {
    const { mediaDevices } = installBrowser();
    const harness = makeHost();
    const service = new RecorderService(harness.host);
    await service.start({ captureMode: "mic" });
    expect(service.inputChannelMode).toBe("mono");
    await service.stop();

    harness.setSettings({ audioChannelMode: "multichannel", selectedMicrophoneDevice: "mic-2", selectedVirtualDevice: "" });
    harness.setPreferOpus(true);
    await service.start({ captureMode: "mic" });
    expect(service.inputChannelMode).toBe("multichannel");
    expect(mediaDevices.getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({ audio: expect.objectContaining({ deviceId: { exact: "mic-2" } }) }));
    expect(service.mime).toBe("audio/webm;codecs=opus");
    await service.stop();

    harness.setPreferOpus(false);
    const preferenceFailure = vi.spyOn(harness.host, "prefersOpus").mockImplementation(() => { throw new Error("provider lookup failed"); });
    await service.start({ captureMode: "mic" });
    expect(preferenceFailure).toHaveBeenCalled();
    expect(service.mime).toBe("audio/mp4;codecs=mp4a.40.2");
    await service.stop();
    preferenceFailure.mockRestore();
    harness.setPreferOpus(true);
    FakeMediaRecorder.supported = [];
    await service.start({ captureMode: "mic" });
    expect(service.mime).toBe("");
    expect(FakeMediaRecorder.instances.at(-1)?.mimeType).toBe("audio/webm");
    await service.stop();
  });
});
