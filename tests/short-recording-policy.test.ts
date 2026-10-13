import { describe, expect, it } from "vitest";
import { classifyShortRecording } from "../src/audio/short-recording-policy";

const base = {
  durationMs: 5000,
  isFinal: true,
  hasSegments: false,
  filterShortRecordings: true,
  isImported: false,
  isContinuation: false,
};

describe("短录音时长分级", () => {
  it("不足 1 秒丢弃，1 秒至不足 10 秒探测，10 秒起正常处理", () => {
    expect(classifyShortRecording({ ...base, durationMs: 0 })).toBe("discard");
    expect(classifyShortRecording({ ...base, durationMs: 999 })).toBe("discard");
    expect(classifyShortRecording({ ...base, durationMs: 1000 })).toBe("probe");
    expect(classifyShortRecording({ ...base, durationMs: 9999 })).toBe("probe");
    expect(classifyShortRecording({ ...base, durationMs: 10_000 })).toBe("process");
    expect(classifyShortRecording({ ...base, durationMs: 10_001 })).toBe("process");
  });

  it("总时长未定或已有切片时不判作短录音", () => {
    expect(classifyShortRecording({ ...base, isFinal: false, durationMs: 100 })).toBe("process");
    expect(classifyShortRecording({ ...base, durationMs: 4000, hasSegments: true })).toBe("process");
    expect(classifyShortRecording({ ...base, durationMs: 100, hasSegments: true })).toBe("process");
  });

  it("导入音频始终按普通流程处理", () => {
    expect(classifyShortRecording({ ...base, durationMs: 1200, isImported: true })).toBe("process");
  });

  it("续录按同一短时长规则探测", () => {
    expect(classifyShortRecording({ ...base, durationMs: 999, isContinuation: true })).toBe("discard");
    expect(classifyShortRecording({ ...base, durationMs: 1000, isContinuation: true })).toBe("probe");
    expect(classifyShortRecording({ ...base, durationMs: 8000, isContinuation: true })).toBe("probe");
  });

  it("开关关闭后短录音按普通流程处理", () => {
    expect(classifyShortRecording({ ...base, durationMs: 1200, filterShortRecordings: false })).toBe("process");
    expect(classifyShortRecording({ ...base, durationMs: 4000, filterShortRecordings: false })).toBe("process");
  });

  it("负数和 NaN 时长按 0 处理，缺少输入按普通流程处理", () => {
    expect(classifyShortRecording({ ...base, durationMs: -1 })).toBe("discard");
    expect(classifyShortRecording({ ...base, durationMs: NaN })).toBe("discard");
    expect(classifyShortRecording(undefined as never)).toBe("process");
  });
});
