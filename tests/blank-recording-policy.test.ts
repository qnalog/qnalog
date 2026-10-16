import { describe, expect, it } from "vitest";
import { classifyBlankRecording } from "../src/audio/blank-recording-policy";
import { BLANK_RECORDING_DISCARD_LIMIT_MS } from "../src/shared/limits";

describe("全空录音收尾判定", () => {
  const blankSegments = [{ text: "" }, { text: "   " }];

  it("普通录音不足 60 秒走丢弃流程，60 秒起保留", () => {
    expect(classifyBlankRecording({ durationMs: 59_999, isOrdinaryRecording: true, segments: blankSegments })).toBe("discard");
    expect(classifyBlankRecording({ durationMs: BLANK_RECORDING_DISCARD_LIMIT_MS, isOrdinaryRecording: true, segments: blankSegments })).toBe("keep");
    expect(classifyBlankRecording({ durationMs: 60_001, isOrdinaryRecording: true, segments: blankSegments })).toBe("keep");
  });

  it("导入与续录即使短于 60 秒也保留", () => {
    expect(classifyBlankRecording({ durationMs: 10_000, isOrdinaryRecording: false, segments: blankSegments })).toBe("keep");
  });

  it("无效时长按 0 处理", () => {
    expect(classifyBlankRecording({ durationMs: Number.NaN, isOrdinaryRecording: true, segments: blankSegments })).toBe("discard");
  });

  it("文字、失败片段或空分段列表不属于全空成功转写", () => {
    expect(classifyBlankRecording({ durationMs: 10_000, isOrdinaryRecording: true, segments: [{ text: "有内容" }, { text: "" }] })).toBe("not-applicable");
    expect(classifyBlankRecording({ durationMs: 10_000, isOrdinaryRecording: true, segments: [{ text: "", error: "ASR failed" }] })).toBe("not-applicable");
    expect(classifyBlankRecording({ durationMs: 10_000, isOrdinaryRecording: true, segments: [] })).toBe("not-applicable");
  });
});
