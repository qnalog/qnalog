import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import {
  DASHSCOPE_CHAT_ASR_CHUNK_MS,
  DASHSCOPE_CHAT_ASR_MAX_BASE64_BYTES,
  DASHSCOPE_CHAT_ASR_MAX_DURATION_MS,
  DASHSCOPE_CHAT_ASR_PROTOCOL,
  approxBase64Bytes,
  getChatInputAudioPlan,
  getChatInputAudioProfile,
  isApimimoAsrProvider,
  isChatInputAudioProvider,
} from "../src/asr/transcribe";

// MediaRecorder 在桌面录的就是 webm/opus；用它的体积推算时长对不上，
// 所以切块判断必须先解码。这里只需要 plan 的决策，不涉及真实解码。
const dashscopeProvider = {
  id: "dashscope-chat",
  endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen3-asr-flash",
  protocol: DASHSCOPE_CHAT_ASR_PROTOCOL,
  language: "",
};

const profile = getChatInputAudioProfile(dashscopeProvider)!;

describe("百炼分段转写的服务识别", () => {
  it("按 protocol 认出百炼分段服务", () => {
    expect(profile).not.toBeNull();
    expect(profile.protocol).toBe(DASHSCOPE_CHAT_ASR_PROTOCOL);
    expect(isChatInputAudioProvider(dashscopeProvider)).toBe(true);
  });

  it("百炼分段服务不是 APIMiMo，两者不会互相误判", () => {
    // 误判的后果很具体：TPM 配速会白白拖慢百炼（多等几十秒），
    // 语种参数会被改成 MiMo 才认的 auto，而百炼在语种不确定时要求整个字段省略。
    expect(isApimimoAsrProvider(dashscopeProvider)).toBe(false);
    const apimimo = getChatInputAudioProfile({ id: "apimimo", model: "mimo-v2.5-asr" })!;
    expect(apimimo.protocol).toBe("apimimo-chat-input-audio");
    expect(apimimo.tpmPacing).toBe(true);
    expect(profile.tpmPacing).toBe(false);
  });

  it("只按模型名也要认出 qwen3-asr-flash（用户自建条目时不带 protocol）", () => {
    const byModel = getChatInputAudioProfile({
      id: "custom",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-asr-flash",
    })!;
    expect(byModel.protocol).toBe(DASHSCOPE_CHAT_ASR_PROTOCOL);
  });

  it("其它服务不受影响", () => {
    expect(getChatInputAudioProfile({ id: "siliconflow", model: "FunAudioLLM/SenseVoiceSmall" })).toBeNull();
    expect(getChatInputAudioProfile({ id: "dashscope", model: "paraformer-realtime-v2" })).toBeNull();
  });
});

describe("百炼分段转写的切块上限", () => {
  it("3 分钟切块换算成 base64 后必须落在 10MB 以内", () => {
    // 16kHz 单声道 16-bit WAV = 32,000 字节/秒。这是切块尺寸的硬约束：
    // 4 分钟就会产出 base64 后超过 10MB 的单块，被服务端拒绝。
    const bytesPerSecond = 32000;
    const chunkBytes = (DASHSCOPE_CHAT_ASR_CHUNK_MS / 1000) * bytesPerSecond;
    expect(approxBase64Bytes(chunkBytes)).toBeLessThanOrEqual(DASHSCOPE_CHAT_ASR_MAX_BASE64_BYTES);

    const fourMinutes = 4 * 60 * bytesPerSecond;
    expect(approxBase64Bytes(fourMinutes)).toBeGreaterThan(DASHSCOPE_CHAT_ASR_MAX_BASE64_BYTES);
  });
  it("服务端单次上限是 5 分钟，比切块尺寸宽松", () => {
    expect(DASHSCOPE_CHAT_ASR_MAX_DURATION_MS).toBe(5 * 60 * 1000);
    expect(DASHSCOPE_CHAT_ASR_MAX_DURATION_MS).toBeGreaterThan(DASHSCOPE_CHAT_ASR_CHUNK_MS);
  });

  it("未超过服务端单次上限的音频原样直发，超过则切块", () => {
    const webm = { size: 50_000, type: "audio/webm" };
    expect(getChatInputAudioPlan(profile, webm, "audio/webm", DASHSCOPE_CHAT_ASR_MAX_DURATION_MS - 1).action).toBe("direct");
    expect(getChatInputAudioPlan(profile, webm, "audio/webm", DASHSCOPE_CHAT_ASR_MAX_DURATION_MS + 1).action).toBe("split");
  });

  it("webm/opus 属原生格式，不必转码（否则每段都要膨胀成 WAV 再上传）", () => {
    const plan = getChatInputAudioPlan(profile, { size: 1024, type: "audio/webm" }, "audio/webm");
    expect(plan.nativeMime).toBe("audio/webm");
    expect(plan.action).toBe("inspect");
  });

  it("时长未知时先解码核实，不靠体积猜", () => {
    expect(getChatInputAudioPlan(profile, { size: 1024, type: "audio/wav" }, "audio/wav").action).toBe("inspect");
  });
});

describe("百炼分段转写的语种参数", () => {
  it("语种留空或 auto 时不下发该字段", () => {
    // 文档：「若音频语种不确定，或包含多种语种…请勿指定该参数」。
    // 下发 auto 与省略不等价，服务端会当成指定了语种。
    expect(profile.languageFor("")).toBe("");
    expect(profile.languageFor("auto")).toBe("");
  });

  it("明确语种透传，取值域比 MiMo 宽", () => {
    expect(profile.languageFor("zh")).toBe("zh");
    expect(profile.languageFor("en")).toBe("en");
    // MiMo 只认 zh/en，其它一律归一为 auto；百炼的取值域是完整的语种码表。
    expect(profile.languageFor("yue")).toBe("yue");
    expect(profile.languageFor("ja")).toBe("ja");
    // 非法值同样不下发，避免把方言名之类的自由文本当成语种发出去。
    expect(profile.languageFor("中文（普通话）")).toBe("");
  });
});

describe("百炼分段服务在设置界面里的归类", () => {
  it("只出现在录音转写下拉里，不进导入音频下拉", async () => {
    const { TranscribeProfileService } = await import("../src/asr/transcribe-profile-service");
    const { isImportCapableTranscribeProvider } = await import("../src/asr/diarization");
    const service = new TranscribeProfileService({ settings: {} });
    const provider = { endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-asr-flash", protocol: DASHSCOPE_CHAT_ASR_PROTOCOL };
    const profile = service.getTranscribeProviderProfile("dashscope-chat", provider);
    // 单次 5 分钟的上限决定它不适合整文件导入；导入走 dashscope-filetrans。
    expect(isImportCapableTranscribeProvider(profile, provider)).toBe(false);
    expect(profile.transcribeMode).toBe("segmented");
  });

  it("实时流式那条 dashscope 条目不受影响，仍留在下拉里", async () => {
    const { TranscribeProfileService } = await import("../src/asr/transcribe-profile-service");
    const service = new TranscribeProfileService({ settings: {} });
    const profile = service.getTranscribeProviderProfile("dashscope", { model: "paraformer-realtime-v2" });
    expect(profile.title).toContain("Real-time");
    expect(profile.transcribeMode).toBe("streaming");
  });
});
