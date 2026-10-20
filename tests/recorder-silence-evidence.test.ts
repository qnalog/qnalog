import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ Platform: { isMobile: false, isMobileApp: false } }));
vi.mock("../src/shared/util-audio", () => ({ assertAudioCaptureSupported: vi.fn(), pickMimeType: () => "audio/webm", extFromMime: () => "webm" }));
import { RecorderService } from "../src/audio/recorder-service";

afterEach(() => { vi.unstubAllGlobals(); });

function meter(options: { throws?: boolean; contextState?: AudioContextState } = {}) {
  const timeData = new Uint8Array(1024).fill(128);
  const freqData = new Uint8Array(512);
  return {
    kind: "mic", icon: "●", label: "Microphone",
    context: { state: options.contextState || "running" },
    source: {}, splitter: null,
    analyser: {
      getByteTimeDomainData: (target: Uint8Array) => {
        if (options.throws) throw new Error("meter read failed");
        target.set(timeData);
      },
      getByteFrequencyData: (target: Uint8Array) => target.set(freqData),
    },
    timeData, freqData, level: 0, bars: new Array<number>(12).fill(0), _resumeAttempts: 0,
  } as never;
}

function recorderWithMeters(...meters: unknown[]): RecorderService {
  const recorder = new RecorderService({} as never);
  recorder.state = "recording";
  recorder._voicedTicks = 0;
  recorder._silentTicks = 0;
  recorder.levelMeters = meters as never;
  return recorder;
}

describe("录音电平静音证据", () => {
  it("全帧采样失败时标记证据未知且不增加计数", () => {
    const recorder = recorderWithMeters(meter({ throws: true }));
    recorder.updateAudioLevel();
    expect(recorder._silenceEvidenceUnknown).toBe(true);
    expect(recorder._voicedTicks).toBe(0);
    expect(recorder._silentTicks).toBe(0);
    expect(recorder.audioLevel).toBe(0);
  });

  it("先取得有效静音、随后采样失败时保留已有计数并标记证据未知", () => {
    const recorder = recorderWithMeters(meter());
    recorder.updateAudioLevel();
    expect(recorder._silentTicks).toBe(1);
    recorder.levelMeters = [meter({ throws: true })] as never;
    recorder.updateAudioLevel();
    expect(recorder._silenceEvidenceUnknown).toBe(true);
    expect(recorder._silentTicks).toBe(1);
    expect(recorder._voicedTicks).toBe(0);
  });

  it("双 meter 中任一路采样失败时整帧不计数", () => {
    const recorder = recorderWithMeters(meter(), meter({ throws: true }));
    recorder.updateAudioLevel();
    expect(recorder._silenceEvidenceUnknown).toBe(true);
    expect(recorder._silentTicks).toBe(0);
    expect(recorder._voicedTicks).toBe(0);
  });

  it("只有有效静音采样时正常累计静音计数", () => {
    const recorder = recorderWithMeters(meter());
    recorder.updateAudioLevel();
    expect(recorder._silenceEvidenceUnknown).toBe(false);
    expect(recorder._silentTicks).toBe(1);
  });

  it("录音中没有 meter 或 meter 已挂起/关闭时标记证据未知", () => {
    const missing = recorderWithMeters();
    missing.updateAudioLevel();
    expect(missing._silenceEvidenceUnknown).toBe(true);

    for (const contextState of ["suspended", "closed"] as const) {
      const unavailable = recorderWithMeters(meter({ contextState }));
      unavailable.updateAudioLevel();
      expect(unavailable._silenceEvidenceUnknown).toBe(true);
      expect(unavailable._silentTicks).toBe(0);
    }
  });

  it("新录音开始时重置上一次的未知采样状态", async () => {
    const recorder = new RecorderService({ resolveCaptureMode: (mode: unknown) => mode } as never);
    recorder.state = "idle";
    recorder._silenceEvidenceUnknown = true;
    recorder.acquireStream = async () => ({ getTracks: () => [], getAudioTracks: () => [] } as never);
    recorder.attachStreamInterruptionHandlers = () => undefined;
    recorder.startLevelMeter = () => undefined;
    recorder.startMasterRecorder = () => undefined;
    recorder.startNewRecorder = () => undefined;
    vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => undefined });
    await recorder.start();
    expect(recorder._silenceEvidenceUnknown).toBe(false);
    if (recorder.ticker !== null) window.clearInterval(recorder.ticker);
  });
});
