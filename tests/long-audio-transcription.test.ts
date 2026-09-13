import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  requestUrl: vi.fn(),
}));

import {
  composeDashScopeTranscript,
  estimateCloudTranscriptionDuration,
  extractDashScopeSentences,
  isDashScopeFileTransProvider,
  parseServiceJsonResponse,
} from "../src/asr/long-audio-transcription";

describe("long audio transcription", () => {
  it("estimates a clear processing window from the full audio duration", () => {
    expect(estimateCloudTranscriptionDuration(3 * 60 * 60 * 1000)).toEqual({
      minMs: 270_000,
      maxMs: 864_000,
    });
  });

  it("recognizes the DashScope file transcription protocol", () => {
    expect(isDashScopeFileTransProvider({ protocol: "dashscope-filetrans" })).toBe(true);
    expect(isDashScopeFileTransProvider({ protocol: "dashscope-ws" })).toBe(false);
  });

  it("extracts speaker-labelled sentences from DashScope results", () => {
    const payload = {
      transcripts: [{
        sentences: [
          { begin_time: 0, end_time: 2100, speaker_id: 7, text: "大家好。" },
          { begin_time: 2200, end_time: 4300, speaker_id: 7, text: "先看第一项。" },
          { begin_time: 4500, end_time: 7200, speaker_id: 2, text: "我补充一点。" },
        ],
      }],
    };

    expect(extractDashScopeSentences(payload)).toHaveLength(3);
    expect(composeDashScopeTranscript(payload)).toEqual({
      text: "[00:00] [说话人1] 大家好。 先看第一项。\n\n[00:04] [说话人2] 我补充一点。",
      sentenceCount: 3,
      durationMs: 7200,
    });
  });

  it("accepts nested output payloads and plain transcript fallback", () => {
    expect(composeDashScopeTranscript({
      output: { transcripts: [{ sentences: [{ begin_time: 1000, end_time: 2000, speaker_id: 0, text: "测试。" }] }] },
    }).text).toBe("[00:01] [说话人1] 测试。");

    expect(composeDashScopeTranscript({ transcripts: [{ text: "完整逐字稿" }] })).toEqual({
      text: "完整逐字稿",
      sentenceCount: 0,
    });

    expect(composeDashScopeTranscript({ output: { transcripts: [{ transcript: "嵌套完整逐字稿" }] } })).toEqual({
      text: "嵌套完整逐字稿",
      sentenceCount: 0,
    });
  });

  it("reports empty and malformed service responses without leaking a JSON parser error", () => {
    expect(() => parseServiceJsonResponse({ status: 200, text: "" }, "提交转写任务"))
      .toThrow("提交转写任务返回空响应（HTTP 200）");
    expect(() => parseServiceJsonResponse({ status: 502, text: "upstream unavailable" }, "查询转写任务"))
      .toThrow("查询转写任务返回的不是有效 JSON（HTTP 502）：upstream unavailable");
  });

  it("parses JSON from response text rather than relying on requestUrl.json", () => {
    expect(parseServiceJsonResponse({
      status: 200,
      text: JSON.stringify({ output: { task_id: "task-1" } }),
    }, "提交转写任务")).toEqual({ output: { task_id: "task-1" } });
  });
});
