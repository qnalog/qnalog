// 说话人标签摄取（diarization）的纯函数回归测试。运行：npm test
import { describe, it, expect } from "vitest";
import {
  friendlySpeakerLabel,
  composeSpeakerLabeledText,
  normalizeInlineSpeakerTags,
  extractTranscriptText,
} from "../src/asr/speaker-labels";

describe("friendlySpeakerLabel", () => {
  it("通用 ID 按出现顺序编号，映射稳定", () => {
    const m = new Map();
    expect(friendlySpeakerLabel("SPEAKER_00", m)).toBe("说话人1");
    expect(friendlySpeakerLabel("SPEAKER_01", m)).toBe("说话人2");
    expect(friendlySpeakerLabel("SPEAKER_00", m)).toBe("说话人1"); // 复用
    expect(friendlySpeakerLabel("0", m)).toBe("说话人3");
  });
  it("命名说话人原样保留", () => {
    const m = new Map();
    expect(friendlySpeakerLabel("A", m)).toBe("说话人1");
    expect(friendlySpeakerLabel("B", m)).toBe("说话人2");
    expect(friendlySpeakerLabel("Alice", m)).toBe("Alice");
    expect(friendlySpeakerLabel("面试官", m)).toBe("面试官");
  });
  it("空值返回空串", () => {
    expect(friendlySpeakerLabel("", new Map())).toBe("");
    expect(friendlySpeakerLabel(null, new Map())).toBe("");
  });
});

describe("composeSpeakerLabeledText", () => {
  it("WhisperX 风格 segments → [说话人N] 前缀，连续同一人合并为一轮", () => {
    const segs = [
      { text: "哈喽，能听到吗？", speaker: "SPEAKER_00" },
      { text: "你好你好。", speaker: "SPEAKER_01" },
      { text: "是陈同学吗？", speaker: "SPEAKER_00" },
      { text: "对对。", speaker: "SPEAKER_00" },
    ];
    expect(composeSpeakerLabeledText(segs)).toBe(
      "[说话人1] 哈喽，能听到吗？\n[说话人2] 你好你好。\n[说话人1] 是陈同学吗？ 对对。"
    );
  });
  it("跳过空文本段；非数组返回空串", () => {
    expect(composeSpeakerLabeledText([{ text: "  ", speaker: "SPEAKER_00" }, { text: "在", speaker: "SPEAKER_00" }]))
      .toBe("[说话人1] 在");
    expect(composeSpeakerLabeledText(null as any)).toBe("");
  });
});

describe("normalizeInlineSpeakerTags", () => {
  it("内联 [SPEAKER_00] / SPEAKER_01: 归一成 [说话人N]", () => {
    expect(normalizeInlineSpeakerTags("[SPEAKER_00] 你好。SPEAKER_01: 嗯。[SPEAKER_00] 再见。"))
      .toBe("[说话人1] 你好。[说话人2] 嗯。[说话人1] 再见。");
  });
  it("没有说话人标签的文本原样返回", () => {
    expect(normalizeInlineSpeakerTags("今天的会议主要讨论 Q2 计划。")).toBe("今天的会议主要讨论 Q2 计划。");
  });
});

describe("extractTranscriptText", () => {
  it("结构化 speaker 优先", () => {
    expect(extractTranscriptText({ segments: [{ text: "甲说", speaker: "SPEAKER_00" }, { text: "乙说", speaker: "SPEAKER_01" }] }))
      .toBe("[说话人1] 甲说\n[说话人2] 乙说");
  });
  it("无 speaker 的普通响应：行为不变（取 text）", () => {
    expect(extractTranscriptText({ text: "普通转写结果" })).toBe("普通转写结果");
    // OpenAI verbose_json：有 segments 但无 speaker → 不触发分人，回退 text
    expect(extractTranscriptText({ text: "回退文本", segments: [{ text: "回退文本", start: 0, end: 1 }] }))
      .toBe("回退文本");
  });
  it("内联标签也归一", () => {
    expect(extractTranscriptText({ text: "[SPEAKER_00] 你好" })).toBe("[说话人1] 你好");
  });
  it("兼容 transcript/result 字段与空响应", () => {
    expect(extractTranscriptText({ transcript: "字段二" })).toBe("字段二");
    expect(extractTranscriptText({ result: "字段三" })).toBe("字段三");
    expect(extractTranscriptText({})).toBe("");
    expect(extractTranscriptText(null as any)).toBe("");
  });
});
