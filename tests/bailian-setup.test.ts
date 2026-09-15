import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { PluginSettings } from "../src/shared/types";
import {
  applyPresetPlan,
  buildProbeHost,
  buildServiceView,
  buildSetupStatus,
  configSignature,
  deriveSetupState,
  formatDetectionReport,
  planPresetApplication,
  runPresetDetection,
  setupServiceIssue,
  type ProbePorts,
} from "../src/setup";

// 任务 2 的交付契约：首次配置只需一把阿里云百炼 API Key。
// 「地址与模型内置」「检测未通过不落盘」这两条是用户可观察的行为，逐条钉住。

function empty(): PluginSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as PluginSettings;
}

const KEY = "sk-bailian-test";

describe("百炼一站式配置", () => {
  it("只用一把密钥就能算出完整计划（无需地址、无需选模型）", () => {
    const plan = planPresetApplication(empty(), { providerId: "bailian", apiKey: KEY });
    expect(plan.ok).toBe(true);
    expect(plan.reason).toBe("");
    // 用户没有提供任何地址或模型名
    expect(Object.keys(plan.changes)).not.toContain("llmEndpoint_unused");
  });

  it("三段服务成套落地，且共用同一把密钥", () => {
    // 起点故意偏离默认值：默认的 importTranscribeProvider 恰好就是 dashscope-filetrans，
    // 若从这里出发，即使预设漏写这一项，断言也会因为默认值相同而通过。
    const start = empty();
    start.importTranscribeProvider = "openai";
    start.activeTranscribeProvider = "siliconflow";
    start.transcribeProviders["dashscope-filetrans"].model = "fun-asr";
    start.transcribeProviders.dashscope.model = "paraformer-realtime-v2";
    start.llmModel = "some-old-model";

    const settings = applyPresetPlan(start, planPresetApplication(start, { providerId: "bailian", apiKey: KEY }));

    expect(settings.transcribeProviders.dashscope.model).toBe("qwen-audio-3.0-asr-flash-streaming");
    expect(settings.transcribeProviders.dashscope.endpoint).toBe("wss://dashscope.aliyuncs.com/api-ws/v1/inference");
    expect(settings.activeTranscribeProvider).toBe("dashscope");

    expect(settings.transcribeProviders["dashscope-filetrans"].model).toBe("qwen-audio-3.0-asr-flash-filetrans");
    expect(settings.importTranscribeProvider).toBe("dashscope-filetrans");

    expect(settings.llmModel).toBe("qwen3.8-flash");
    expect(settings.llmEndpoint).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(settings.llmServicePreset).toBe("dashscope");

    for (const key of [settings.transcribeProviders.dashscope.apiKey,
                       settings.transcribeProviders["dashscope-filetrans"].apiKey,
                       settings.llmApiKey]) {
      expect(key).toBe(KEY);
    }
  });

  it("不覆盖用户的目录、提示词与设备选择", () => {
    const before = empty();
    before.audioFolder = "我的/录音";
    before.mdFolder = "我的/纪要";
    before.captureMode = "mix-virtual";
    before.polishMode = "interview";
    before.segmentIntervalMinutes = 9;

    const after = applyPresetPlan(before, planPresetApplication(before, { providerId: "bailian", apiKey: KEY }));

    expect(after.audioFolder).toBe("我的/录音");
    expect(after.mdFolder).toBe("我的/纪要");
    expect(after.captureMode).toBe("mix-virtual");
    expect(after.polishMode).toBe("interview");
    expect(after.segmentIntervalMinutes).toBe(9);
  });

  it("缺密钥时给出原因且不产出改动（不落盘）", () => {
    const plan = planPresetApplication(empty(), { providerId: "bailian", apiKey: "   " });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("API Key");
    expect(Object.keys(plan.changes)).toHaveLength(0);
  });

  it("检测覆盖三段；全部通过才算通过", async () => {
    const before = empty();
    const plan = planPresetApplication(before, { providerId: "bailian", apiKey: KEY });
    const host = buildProbeHost({ settings: before }, applyPresetPlan(before, plan));

    const ports: ProbePorts = {
      transcribe: async () => "你好",
      importTranscribe: async () => ({ model: "qwen-audio-3.0-asr-flash-filetrans" }),
      llm: async () => ({ model: "qwen3.8-flash" }),
    };
    const report = await runPresetDetection(host as never, plan, ports);

    expect(report.stages.map((s) => s.stage)).toEqual(["transcribe", "import-transcribe", "llm"]);
    expect(report.ok).toBe(true);
    expect(formatDetectionReport(report)).toContain("录音转写 ✓");
  });

  it("任一段失败都如实报出是哪一段，且整体判为未通过", async () => {
    const before = empty();
    const plan = planPresetApplication(before, { providerId: "bailian", apiKey: KEY });
    const host = buildProbeHost({ settings: before }, applyPresetPlan(before, plan));

    const report = await runPresetDetection(host as never, plan, {
      transcribe: async () => "你好",
      importTranscribe: async () => { throw new Error("模型未开通"); },
      llm: async () => ({ model: "qwen3.8-flash" }),
    });

    expect(report.ok).toBe(false);
    const importStage = report.stages.find((s) => s.stage === "import-transcribe");
    expect(importStage?.ok).toBe(false);
    expect(importStage?.detail).toContain("模型未开通");
    // 未通过时不应给出「配置完成」这类结论
    expect(formatDetectionReport(report)).toContain("音频导入转写 ✗");
  });

  it("密钥无效时整段未通过，界面据此不落盘（四态为未通过）", async () => {
    const before = empty();
    const plan = planPresetApplication(before, { providerId: "bailian", apiKey: "sk-bad" });
    const candidate = applyPresetPlan(before, plan);
    const host = buildProbeHost({ settings: before }, candidate);

    const report = await runPresetDetection(host as never, plan, {
      transcribe: async () => { throw new Error("HTTP 401 无效的 API Key"); },
      importTranscribe: async () => { throw new Error("HTTP 401 无效的 API Key"); },
      llm: async () => { throw new Error("HTTP 401 无效的 API Key"); },
    });
    expect(report.ok).toBe(false);

    // 用户看到的是「未通过」而不是「已配置」
    const view = buildServiceView({
      endpoint: candidate.llmEndpoint,
      model: candidate.llmModel,
      apiKey: candidate.llmApiKey,
    }, true);
    const state = deriveSetupState(view, {
      ok: report.ok,
      detail: formatDetectionReport(report),
      signature: configSignature(view),
    });
    expect(state).toBe("failure");
  });
});

describe("快速配置面板的显示规则", () => {
  it("已配好（转写与 AI 整理都不缺）时不应再显示面板", () => {
    // 面板可见性由「两端是否缺配置」决定，而不是由是否有密钥决定：
    // 用户已经能用了，就不该在首页看到一块要他重新填密钥的面板。
    const ready = empty();
    ready.transcribeProviders.dashscope = {
      name: "百炼", endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      apiKey: "sk-a", model: "qwen-audio-3.0-asr-flash-streaming", language: "",
    };
    ready.activeTranscribeProvider = "dashscope";
    ready.llmEndpoint = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    ready.llmModel = "qwen3.8-flash";
    ready.llmApiKey = "sk-a";

    const transcribeIssue = setupServiceIssue(buildServiceView(ready.transcribeProviders.dashscope, true));
    const llmIssue = setupServiceIssue(buildServiceView({
      endpoint: ready.llmEndpoint, model: ready.llmModel, apiKey: ready.llmApiKey,
    }, true));
    expect(transcribeIssue).toBe("");
    expect(llmIssue).toBe("");
  });

  it("缺任一端时面板应当显示", () => {
    const fresh = empty();
    const transcribeIssue = setupServiceIssue(buildServiceView(fresh.transcribeProviders[fresh.activeTranscribeProvider], true));
    // 全新安装没有任何密钥 → 缺配置 → 面板显示
    expect(transcribeIssue).not.toBe("");
  });
});

describe("程序状态总览", () => {
  const base = {
    transcribe: { label: "阿里云百炼实时转写", model: "qwen-audio-3.0-asr-flash-streaming", issue: "" },
    llm: { model: "qwen3.8-flash", issue: "" },
    speaker: { label: "阿里云百炼录音文件识别", model: "qwen-audio-3.0-asr-flash-filetrans", issue: "" },
    audio: "仅麦克风",
  };

  it("配好时给出肯定结论，并列出实际在用的模型", () => {
    const report = buildSetupStatus(base);
    expect(report.ready).toBe(true);
    expect(report.headline).toContain("可以开始使用");
    const byLabel = Object.fromEntries(report.lines.map((l) => [l.label, l.value]));
    expect(byLabel["语音转写"]).toContain("qwen-audio-3.0-asr-flash-streaming");
    expect(byLabel["AI 整理"]).toContain("qwen3.8-flash");
    expect(byLabel["说话人识别"]).toContain("qwen-audio-3.0-asr-flash-filetrans");
    expect(byLabel["音频输入"]).toBe("仅麦克风");
    expect(report.lines.every((l) => !l.needsAttention)).toBe(true);
  });

  it("缺转写或 AI 整理时不算配好，并标出是哪一项", () => {
    const noTranscribe = buildSetupStatus({ ...base, transcribe: { ...base.transcribe, issue: "服务地址未填写" } });
    expect(noTranscribe.ready).toBe(false);
    expect(noTranscribe.lines.find((l) => l.label === "语音转写")?.needsAttention).toBe(true);
    // 缺配置时显示的是「缺什么」，不是空白
    expect(noTranscribe.lines.find((l) => l.label === "语音转写")?.value).toBe("服务地址未填写");

    const noLlm = buildSetupStatus({ ...base, llm: { model: "", issue: "大模型名称未配置" } });
    expect(noLlm.ready).toBe(false);
    expect(noLlm.lines.find((l) => l.label === "AI 整理")?.needsAttention).toBe(true);
  });

  it("状态总览不把「测试结果」算进来（那由各服务徽章承担）", () => {
    // 只要填全就算可用：填全但从未测试时，总览仍应给出肯定结论，
    // 否则改一个字符就会让总览翻脸，与四态徽章的职责重复。
    const report = buildSetupStatus(base);
    expect(report.ready).toBe(true);
    expect(report.detail).toContain("无需再调整");
  });

  it("四项明细的标签固定，便于用户形成固定阅读位置", () => {
    expect(buildSetupStatus(base).lines.map((l) => l.label)).toEqual([
      "语音转写", "AI 整理", "说话人识别", "音频输入",
    ]);
  });
});
