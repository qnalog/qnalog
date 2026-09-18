import { describe, expect, it } from "vitest";
import { classifyShortRecording } from "../src/audio/short-recording-policy";

// 短录音分级的判据。用户的预期只有一条：不足 10 秒的录音不要自动生成纪要，
// 但音频要留在录音目录里；早于 3 秒的误触录音仍按既有行为直接丢弃。
// 边界值必须落在正确的一侧，否则「刚好 10 秒的正常录音」会被当成短录音丢掉。

const base = {
  durationMs: 5000,
  isFinal: true,
  hasSegments: false,
  filterShortRecordings: true,
  isImported: false,
  isContinuation: false,
};

describe("短录音处理级别", () => {
  it("按 3 秒与 10 秒两个阈值分三段", () => {
    expect(classifyShortRecording({ ...base, durationMs: 0 })).toBe("discard");
    expect(classifyShortRecording({ ...base, durationMs: 2999 })).toBe("discard");
    expect(classifyShortRecording({ ...base, durationMs: 3000 })).toBe("keep-audio");
    expect(classifyShortRecording({ ...base, durationMs: 9999 })).toBe("keep-audio");
    expect(classifyShortRecording({ ...base, durationMs: 10_000 })).toBe("process");
    expect(classifyShortRecording({ ...base, durationMs: 10_001 })).toBe("process");
  });

  it("总时长未定时不判定：切段阶段不能把长录音当成短录音", () => {
    expect(classifyShortRecording({ ...base, isFinal: false, durationMs: 100 })).toBe("process");
  });

  it("已经有切片说明录音不短，不再按时长判定", () => {
    expect(classifyShortRecording({ ...base, durationMs: 4000, hasSegments: true })).toBe("process");
    expect(classifyShortRecording({ ...base, durationMs: 100, hasSegments: true })).toBe("process");
  });

  it("导入音频由用户显式指定要转写，始终正常处理", () => {
    expect(classifyShortRecording({ ...base, durationMs: 1200, isImported: true })).toBe("process");
  });

  it("续录到既有纪要：3 秒内仍按误触丢弃，3–10 秒并入原纪要", () => {
    expect(classifyShortRecording({ ...base, durationMs: 1200, isContinuation: true })).toBe("discard");
    expect(classifyShortRecording({ ...base, durationMs: 3000, isContinuation: true })).toBe("process");
    expect(classifyShortRecording({ ...base, durationMs: 8000, isContinuation: true })).toBe("process");
  });

  it("关掉短录音保护后，短录音与普通录音一样走完整流程", () => {
    expect(classifyShortRecording({ ...base, durationMs: 1200, filterShortRecordings: false })).toBe("process");
    expect(classifyShortRecording({ ...base, durationMs: 4000, filterShortRecordings: false })).toBe("process");
  });

  it("时长为负或缺失时按 0 处理，不退化成正常处理", () => {
    expect(classifyShortRecording({ ...base, durationMs: -1 })).toBe("discard");
    expect(classifyShortRecording({ ...base, durationMs: NaN })).toBe("discard");
    expect(classifyShortRecording(undefined as never)).toBe("process");
  });
});
