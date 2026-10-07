import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  requestUrl: vi.fn(),
}));

import { requestUrl } from "obsidian";
import {
  composeDashScopeTranscript,
  DASHSCOPE_IMPORT_MODEL_OPTIONS,
  estimateCloudTranscriptionDuration,
  extractDashScopePlainTexts,
  extractDashScopeSentences,
  isDashScopeFileTransProvider,
  parseServiceJsonResponse,
  transcribeImportedAudio,
} from "../src/asr/long-audio-transcription";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
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
  it("offers only models implemented by the whole-file endpoint", () => {
    expect(DASHSCOPE_IMPORT_MODEL_OPTIONS).toEqual([
      "qwen-audio-3.1-asr-flash-filetrans",
      "qwen-audio-3.0-asr-flash-filetrans",
      "fun-asr",
      "paraformer-v2",
    ]);
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

  it("preserves sentence text and does not convert absent or invalid times to zero", () => {
    const payload = {
      transcripts: [{ sentences: [
        { text: "  原始文本  " },
        { text: "NaN 时间", begin_time: "NaN", end_time: 900 },
        { text: "倒序时间", begin_time: 2200, end_time: 2100 },
        { text: "真实零点", begin_time: 0, end_time: 0 },
      ] }],
    };
    expect(extractDashScopeSentences(payload)).toEqual([
      { text: "  原始文本  ", beginTimeMs: null, endTimeMs: null, speakerId: "" },
      { text: "NaN 时间", beginTimeMs: null, endTimeMs: null, speakerId: "" },
      { text: "倒序时间", beginTimeMs: null, endTimeMs: null, speakerId: "" },
      { text: "真实零点", beginTimeMs: 0, endTimeMs: 0, speakerId: "" },
    ]);
    expect(composeDashScopeTranscript({ transcripts: [{ sentences: [{ text: "无时间戳", speaker_id: 1 }] }] }).text)
      .toBe("[说话人1] 无时间戳");
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
  it("retains every plain DashScope transcript entry as an independent source unit", () => {
    const payload = { transcripts: [
      { text: "First entry." },
      { transcript: "Second entry." },
    ] };
    expect(extractDashScopePlainTexts(payload)).toEqual(["First entry.", "Second entry."]);
    expect(composeDashScopeTranscript(payload).text).toBe("First entry.\nSecond entry.");
  });

  it("reports empty and malformed service responses without leaking a JSON parser error", () => {
    expect(() => parseServiceJsonResponse({ status: 200, text: "" }, "提交转写任务"))
      .toThrow("(HTTP 200)");
    expect(() => parseServiceJsonResponse({ status: 502, text: "upstream unavailable" }, "查询转写任务"))
      .toThrow("(HTTP 502)");
  });

  it("parses JSON from response text rather than relying on requestUrl.json", () => {
    expect(parseServiceJsonResponse({
      status: 200,
      text: JSON.stringify({ output: { task_id: "task-1" } }),
    }, "提交转写任务")).toEqual({ output: { task_id: "task-1" } });
  });

  it("runs the Qwen-Audio 3.1 filetrans upload and maps provider sentences into transcript units", async () => {
    const responses = [
      { status: 200, text: JSON.stringify({ data: {
        upload_host: "https://oss.example",
        upload_dir: "audio",
        oss_access_key_id: "access-id",
        policy: "policy",
        signature: "signature",
      } }) },
      { status: 200, text: JSON.stringify({ output: { task_id: "task-1" } }) },
      { status: 200, text: JSON.stringify({ output: {
        task_status: "SUCCEEDED",
        results: [{ subtask_status: "SUCCEEDED", transcription_url: "https://result.example/transcript" }],
      } }) },
      { status: 200, text: JSON.stringify({ output: { transcripts: [{ sentences: [
        { begin_time: 0, end_time: 500, speaker_id: 0, text: "你好。" },
        { begin_time: 700, end_time: 1200, speaker_id: 4, text: "再见。" },
      ] }] } }) },
    ];
    let callIndex = 0;
    vi.mocked(requestUrl).mockImplementation(() => {
      const response = responses[callIndex++];
      const parsed = JSON.parse(response.text);
      const buffer = new ArrayBuffer(0);
      return Object.assign(Promise.resolve({
        status: response.status,
        headers: {},
        arrayBuffer: buffer,
        json: parsed,
        text: response.text,
      }), {
        arrayBuffer: Promise.resolve(buffer),
        json: Promise.resolve(parsed),
        text: Promise.resolve(response.text),
      });
    });
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("window", { fetch });
    const provider = {
      id: "dashscope-filetrans",
      endpoint: "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
      apiKey: "test-key",
      model: "qwen-audio-3.1-asr-flash-filetrans",
      language: "",
      protocol: "dashscope-filetrans",
    };

    const result = await transcribeImportedAudio(
      { settings: { importTranscribeProvider: provider.id, transcribeProviders: { [provider.id]: provider } } },
      new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
      "audio/wav",
      { fileName: "meeting.wav", pollIntervalMs: 1500, timeoutMs: 60_000 },
    );

    expect(callIndex).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.text).toBe(["[00:00] [说话人1] 你好。", "[00:00] [说话人2] 再见。"].join("\n\n"));
    expect(result.units).toEqual([
      expect.objectContaining({ rawText: "你好。", speakerId: "0", speakerName: "说话人1", startMs: 0, endMs: 500, timing: "provider" }),
      expect.objectContaining({ rawText: "再见。", speakerId: "4", speakerName: "说话人2", startMs: 700, endMs: 1200, timing: "provider" }),
    ]);
  });
});
