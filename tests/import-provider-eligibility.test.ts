import { describe, expect, it } from "vitest";
import { isImportCapableTranscribeProvider } from "../src/asr/diarization";

// 「导入音频」下拉里能出现哪些服务。这条规则若退回成硬编码 id 名单，
// 用户自定义的说话人分离服务（如 siliconflow-diarize）会被静默移出选项，
// 设置页随即把 importTranscribeProvider 改写掉——一次打开设置就丢配置。
describe("import transcription provider eligibility", () => {
  const segmented = { endpoint: "https://api.siliconflow.cn/v1/audio/transcriptions", model: "FunAudioLLM/SenseVoiceSmall" };

  it("accepts providers the profile marks as whole-session", () => {
    expect(isImportCapableTranscribeProvider({ requiresWholeSession: true }, segmented)).toBe(true);
  });

  it("rejects providers that can only transcribe in live segments", () => {
    expect(isImportCapableTranscribeProvider({ transcribeMode: "segmented" }, segmented)).toBe(false);
    expect(isImportCapableTranscribeProvider(undefined, segmented)).toBe(false);
  });

  it("accepts user-defined providers that declare a diarization protocol", () => {
    const userDiarize = {
      endpoint: "https://api.siliconflow.cn/v1/audio/transcriptions",
      model: "XingChenAGI/XingChenASR-Diarize-V3.0",
      protocol: "speaker-diarization",
    };
    // 未知 id 会回退到 profile.custom，其中没有 requiresWholeSession。
    expect(isImportCapableTranscribeProvider({ transcribeMode: "segmented" }, userDiarize)).toBe(true);
  });

  it("accepts diarization-capable models even without an explicit protocol", () => {
    expect(isImportCapableTranscribeProvider(undefined, { model: "gpt-4o-transcribe-diarize" })).toBe(true);
    expect(isImportCapableTranscribeProvider(undefined, { model: "whisper-large-v3", endpoint: "http://127.0.0.1:8000/v1/audio/transcriptions", protocol: "speaker-diarization" })).toBe(true);
  });
});
