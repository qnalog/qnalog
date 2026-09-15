import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { ONE_CARD_PROVIDERS } from "../src/llm/config";
import type { PluginSettings } from "../src/shared/types";
import {
  PRESET_WRITTEN_FIELDS,
  applyPresetPlan,
  buildProbeHost,
  buildServiceView,
  configSignature,
  deriveSetupState,
  formatDetectionReport,
  planPresetApplication,
  resolvePresetEndpoint,
  runPresetDetection,
  setupServiceIssue,
  type SetupState,
  type DetectionReport,
  type ProbePorts,
} from "../src/setup";

// 任务 1 的四个契约：
//   1. 预设只改「完成服务配置所需」的字段；
//   2. 检测对象是候选配置，不是已保存的配置；
//   3. 取消 / 检测失败都不覆盖已有配置；
//   4. 四态（缺配置 / 未测试 / 成功 / 失败）由「是否填全」+「同指纹的测试结果」决定。

function freshSettings(): PluginSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as PluginSettings;
}

function completedSettings(): PluginSettings {
  const s = freshSettings();
  s.audioFolder = "我的/录音";
  s.mdFolder = "我的/纪要";
  s.polishMode = "interview";
  s.captureMode = "mix-virtual";
  s.selectedMicrophoneDevice = "mic-1";
  s.segmentIntervalMinutes = 12;
  s.maxRetries = 7;
  s.diagnosticsLogEnabled = false;
  s.briefingStructureLevel = "strict";
  s.dailyMeetingOverviewTemplate = "自定义模板 {{time}}";
  s.inboxAutoImport = false;
  s.transcribeProviders.siliconflow.apiKey = "sk-existing-asr";
  s.llmApiKey = "sk-existing-llm";
  s.llmModel = "existing-model";
  return s;
}

describe("预设的写入范围", () => {
  it("只改完成服务配置所需的字段，逐项核对其它键不变", () => {
    const before = completedSettings();
    const plan = planPresetApplication(before, { providerId: "mimo", apiKey: "sk-new" });
    expect(plan.ok).toBe(true);

    const after = applyPresetPlan(before, plan);
    const written: Record<string, true> = PRESET_WRITTEN_FIELDS;

    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof PluginSettings)[]) {
      if (written[key]) continue;
      expect(after[key], `预设不应改动 ${String(key)}`).toEqual(before[key]);
    }
  });

  it("用户填过的服务配置与偏好不会被预设顺手覆盖", () => {
    const before = completedSettings();
    const after = applyPresetPlan(before, planPresetApplication(before, { providerId: "mimo", apiKey: "sk-new" }));

    expect(after.audioFolder).toBe("我的/录音");
    expect(after.mdFolder).toBe("我的/纪要");
    expect(after.polishMode).toBe("interview");
    expect(after.captureMode).toBe("mix-virtual");
    expect(after.segmentIntervalMinutes).toBe(12);
    expect(after.maxRetries).toBe(7);
    expect(after.diagnosticsLogEnabled).toBe(false);
    expect(after.briefingStructureLevel).toBe("strict");
    expect(after.dailyMeetingOverviewTemplate).toBe("自定义模板 {{time}}");
    expect(after.inboxAutoImport).toBe(false);
  });

  it("写入的服务字段确实成套更新（地址、模型、密钥）", () => {
    const before = completedSettings();
    const after = applyPresetPlan(before, planPresetApplication(before, { providerId: "mimo", apiKey: "sk-new" }));

    expect(after.llmApiKey).toBe("sk-new");
    expect(after.llmModel).toBe(ONE_CARD_PROVIDERS.mimo.llmModel);
    expect(after.llmEndpoint).toBe(ONE_CARD_PROVIDERS.mimo.llmEndpoint);
    const asr = after.transcribeProviders.apimimo;
    expect(asr.apiKey).toBe("sk-new");
    expect(asr.endpoint).toBeTruthy();
    expect(asr.model).toBeTruthy();
    expect(after.activeTranscribeProvider).toBe("apimimo");
  });

  it("用户既有的转写语言选择被保留（预设不覆盖它）", () => {
    const before = completedSettings();
    before.transcribeProviders.apimimo = { ...before.transcribeProviders.apimimo, language: "en" };
    const after = applyPresetPlan(before, planPresetApplication(before, { providerId: "mimo", apiKey: "sk-new" }));
    expect(after.transcribeProviders.apimimo.language).toBe("en");
  });

  it("计划是纯函数：不改动传入的设置", () => {
    const before = completedSettings();
    const snapshot = JSON.stringify(before);
    planPresetApplication(before, { providerId: "mimo", apiKey: "sk-new" });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("同名方案就地覆盖，不重复堆叠", () => {
    const before = completedSettings();
    const first = applyPresetPlan(before, planPresetApplication(before, { providerId: "mimo", apiKey: "sk-1" }));
    const second = applyPresetPlan(first, planPresetApplication(first, { providerId: "mimo", apiKey: "sk-2" }));

    expect(second.llmProfiles).toHaveLength(1);
    expect(second.llmProfiles[0].apiKey).toBe("sk-2");
    expect(second.activeLlmProfile).toBe(second.llmProfiles[0].id);
  });

  it("输入不完整时给出原因且不产出改动", () => {
    const s = freshSettings();
    const noKey = planPresetApplication(s, { providerId: "mimo", apiKey: "  " });
    expect(noKey.ok).toBe(false);
    expect(noKey.reason).toContain("API Key");
    expect(Object.keys(noKey.changes)).toHaveLength(0);

    // 一站式方案内置了三个模型，只需密钥即可成立
    const bailian = planPresetApplication(s, { providerId: "bailian", apiKey: "sk-x" });
    expect(bailian.ok).toBe(true);
  });

  it("按密钥前缀选择普通地址或按量套餐地址", () => {
    const preset = { llmEndpoint: "https://normal.example/v1", tokenPlanEndpoint: "https://tp.example/v1" };
    expect(resolvePresetEndpoint(preset, "sk-abc")).toBe("https://normal.example/v1");
    expect(resolvePresetEndpoint(preset, "tp-abc")).toBe("https://tp.example/v1");
  });
});

describe("检测对象是候选配置", () => {
  it("面向录制转写的预设把候选值构造成检测宿主的设置", async () => {
    const saved = completedSettings();
    const plan = planPresetApplication(saved, { providerId: "mimo", apiKey: "sk-candidate" });
    const candidate = applyPresetPlan(saved, plan);
    const host = buildProbeHost({ settings: saved }, candidate);

    const seen: PluginSettings[] = [];
    const ports: ProbePorts = {
      transcribe: async (h) => { seen.push((h as { settings: PluginSettings }).settings); return "你好"; },
      importTranscribe: async () => { throw new Error("不应走到导入链路"); },
      llm: async (h) => { seen.push((h as { settings: PluginSettings }).settings); return { model: "m" }; },
    };

    const report = await runPresetDetection(host as never, plan, ports);

    expect(report.ok).toBe(true);
    expect(seen).toHaveLength(2);
    // 检测看到的是候选密钥，而不是磁盘上的旧密钥
    for (const settings of seen) {
      expect(settings.llmApiKey).toBe("sk-candidate");
    }
    expect(seen[0].transcribeProviders.apimimo.apiKey).toBe("sk-candidate");
  });

  it("百炼一站式：只填密钥就把录音转写、音频导入、AI 整理三段一次配齐", () => {
    const saved = freshSettings();
    const plan = planPresetApplication(saved, { providerId: "bailian", apiKey: "sk-bailian" });
    expect(plan.ok).toBe(true);
    expect(plan.reason).toBe("");

    const after = applyPresetPlan(saved, plan);

    // 录音转写：实时流式模型
    expect(after.activeTranscribeProvider).toBe("dashscope");
    expect(after.transcribeProviders.dashscope.model).toBe("qwen-audio-3.0-asr-flash-streaming");
    expect(after.transcribeProviders.dashscope.endpoint).toBe("wss://dashscope.aliyuncs.com/api-ws/v1/inference");
    expect(after.transcribeProviders.dashscope.apiKey).toBe("sk-bailian");

    // 导入音频：整文件模型（与录音转写是两个独立服务）
    expect(after.importTranscribeProvider).toBe("dashscope-filetrans");
    expect(after.transcribeProviders["dashscope-filetrans"].model).toBe("qwen-audio-3.0-asr-flash-filetrans");
    expect(after.transcribeProviders["dashscope-filetrans"].apiKey).toBe("sk-bailian");

    // AI 整理
    expect(after.llmServicePreset).toBe("dashscope");
    expect(after.llmModel).toBe("qwen3.8-flash");
    expect(after.llmEndpoint).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(after.llmApiKey).toBe("sk-bailian");

    // 三段共用同一把密钥
    expect(after.transcribeProviders.dashscope.apiKey).toBe(after.llmApiKey);
  });

  it("百炼一站式不需要用户提供任何地址或模型名", () => {
    const saved = freshSettings();
    const plan = planPresetApplication(saved, { providerId: "bailian", apiKey: "sk-bailian" });
    const after = applyPresetPlan(saved, plan);
    // 三个地址与三个模型全部来自内置默认值，非空且与预设一致
    expect(after.llmEndpoint).toContain("dashscope.aliyuncs.com");
    expect(after.llmModel).toBe("qwen3.8-flash");
    expect(after.transcribeProviders.dashscope.endpoint).toContain("api-ws/v1/inference");
    expect(after.transcribeProviders["dashscope-filetrans"].endpoint).toContain("/api/v1/services/audio/asr/transcription");
  });

  it("面向导入音频的预设检测导入链路，而不是录制链路", async () => {
    const saved = completedSettings();
    const plan = planPresetApplication(saved, { providerId: "bailian", apiKey: "sk-bailian" });
    expect(plan.ok).toBe(true);

    const host = buildProbeHost({ settings: saved }, applyPresetPlan(saved, plan));
    let transcribeCalls = 0;
    let importCalls = 0;
    const report = await runPresetDetection(host as never, plan, {
      transcribe: async () => { transcribeCalls += 1; return "你好"; },
      importTranscribe: async (_h, providerId) => { importCalls += 1; expect(providerId).toBe("dashscope-filetrans"); return { model: "qwen-audio-3.0-asr-flash-filetrans" }; },
      llm: async () => ({ model: "qwen3.8-flash" }),
    });

    // 一站式方案三段都要检测：录音转写、导入音频、AI 整理
    expect(transcribeCalls).toBe(1);
    expect(importCalls).toBe(1);
    expect(report.stages.map((s) => s.stage)).toEqual(["transcribe", "import-transcribe", "llm"]);
    expect(report.ok).toBe(true);
  });

  it("检测过程不得写盘：宿主上没有可用的保存入口", async () => {
    const saved = completedSettings();
    const plan = planPresetApplication(saved, { providerId: "mimo", apiKey: "sk-candidate" });
    const saveSettings = vi.fn(async () => undefined);
    const host = buildProbeHost({ settings: saved, saveSettings }, applyPresetPlan(saved, plan));

    await expect((host as unknown as { saveSettings: () => Promise<void> }).saveSettings()).rejects.toThrow(/不得写盘/);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("一个阶段失败不影响另一个阶段，且如实报告是哪一段挂了", async () => {
    const saved = completedSettings();
    const plan = planPresetApplication(saved, { providerId: "mimo", apiKey: "sk-x" });
    const host = buildProbeHost({ settings: saved }, applyPresetPlan(saved, plan));

    const report = await runPresetDetection(host as never, plan, {
      transcribe: async () => { throw new Error("密钥无效"); },
      importTranscribe: async () => { throw new Error("unused"); },
      llm: async () => ({ model: "ok-model" }),
    });

    expect(report.ok).toBe(false);
    expect(report.stages).toHaveLength(2);
    const transcribe = report.stages.find((s) => s.stage === "transcribe");
    const llm = report.stages.find((s) => s.stage === "llm");
    expect(transcribe?.ok).toBe(false);
    expect(transcribe?.detail).toContain("密钥无效");
    expect(llm?.ok).toBe(true);
    expect(llm?.detail).toContain("ok-model");
  });

  it("汇总文案同时呈现成功与失败的两个阶段", () => {
    const report: DetectionReport = {
      ok: false,
      stages: [
        { stage: "transcribe", label: "录音转写", ok: true, detail: "返回：你好" },
        { stage: "llm", label: "AI 整理", ok: false, detail: "HTTP 401" },
      ],
    };
    const text = formatDetectionReport(report);
    expect(text).toContain("录音转写 ✓");
    expect(text).toContain("AI 整理 ✗");
    expect(text).toContain("HTTP 401");
  });
});

describe("取消与失败不覆盖已有配置", () => {
  it("取消 = 丢弃计划，磁盘上的设置逐项不变", () => {
    const saved = completedSettings();
    const snapshot = JSON.stringify(saved);
    const plan = planPresetApplication(saved, { providerId: "mimo", apiKey: "sk-typed-then-cancelled" });

    // 取消：只算计划、不应用
    expect(plan.ok).toBe(true);
    expect(JSON.stringify(saved)).toBe(snapshot);
  });

  it("检测失败后应用计划以外的字段不变，用户已填的密钥不被清空", () => {
    const saved = completedSettings();
    const plan = planPresetApplication(saved, { providerId: "mimo", apiKey: "sk-bad" });
    const after = applyPresetPlan(saved, plan);

    // 「失败」只是检测结果，不改变写入语义：密钥仍是用户填的那个
    expect(after.llmApiKey).toBe("sk-bad");
    // 与预设无关的既有配置原样保留
    expect(after.transcribeProviders.siliconflow.apiKey).toBe("sk-existing-asr");
    expect(after.audioFolder).toBe("我的/录音");
  });

  it("未点「应用」时不会有任何写盘调用", async () => {
    const saved = completedSettings();
    const saveSettings = vi.fn(async () => undefined);
    const plan = planPresetApplication(saved, { providerId: "mimo", apiKey: "sk-x" });
    const host = buildProbeHost({ settings: saved, saveSettings }, applyPresetPlan(saved, plan));

    await runPresetDetection(host as never, plan, {
      transcribe: async () => "ok",
      importTranscribe: async () => ({ model: "m" }),
      llm: async () => ({ model: "m" }),
    });

    expect(saveSettings).not.toHaveBeenCalled();
  });
});

describe("四态：缺配置 / 未测试 / 成功 / 失败", () => {
  const complete = buildServiceView({ endpoint: "https://api.example/v1", model: "m", apiKey: "sk" }, true);

  it("缺配置优先于其它状态", () => {
    const missing = buildServiceView({ endpoint: "", model: "m", apiKey: "sk" }, true);
    expect(setupServiceIssue(missing)).toContain("服务地址");
    expect(deriveSetupState(missing, null)).toBe("missing");
  });

  it("本地服务可省略密钥，不算缺配置", () => {
    const local = buildServiceView({ endpoint: "http://127.0.0.1:8000/v1", model: "whisper" }, false);
    expect(setupServiceIssue(local)).toBe("");
    expect(deriveSetupState(local)).toBe("untested");
  });

  it("填全但没测过 → 未测试（不是「已配置」）", () => {
    expect(deriveSetupState(complete, null)).toBe("untested");
    expect(deriveSetupState(complete, undefined)).toBe("untested");
  });

  it("同指纹的成功/失败结果分别映射为成功与失败", () => {
    const signature = configSignature(complete);
    expect(deriveSetupState(complete, { ok: true, detail: "好", signature })).toBe("success");
    expect(deriveSetupState(complete, { ok: false, detail: "HTTP 401", signature })).toBe("failure");
  });

  it("改了端点、模型或密钥后，旧结果失效回到未测试", () => {
    const success = { ok: true, detail: "好", signature: configSignature(complete) };
    expect(deriveSetupState({ ...complete, endpoint: "https://other.example/v1" }, success)).toBe("untested");
    expect(deriveSetupState({ ...complete, model: "other" }, success)).toBe("untested");
    expect(deriveSetupState({ ...complete, apiKey: "sk-other" }, success)).toBe("untested");
  });

  it("指纹不把密钥明文写进去", () => {
    expect(configSignature(complete)).not.toContain("sk");
  });

  it("四态互斥且各有文案", () => {
    const states: SetupState[] = [
      deriveSetupState(buildServiceView({}, true), null),
      deriveSetupState(complete, null),
      deriveSetupState(complete, { ok: true, detail: "", signature: configSignature(complete) }),
      deriveSetupState(complete, { ok: false, detail: "", signature: configSignature(complete) }),
    ];
    expect(states).toEqual(["missing", "untested", "success", "failure"]);
  });
});

describe("计划与真实预设数据一致", () => {
  it("每个预设都能算出可应用的计划，且只写登记过的键", () => {
    const allowed: Record<string, true> = PRESET_WRITTEN_FIELDS;
    for (const providerId of Object.keys(ONE_CARD_PROVIDERS)) {
      const s = freshSettings();
      const plan = planPresetApplication(s, {
        providerId,
        apiKey: "sk-test",
        llmEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        asrModel: "fun-asr",
        llmModel: "qwen-plus",
      });
      expect(plan.ok, `${providerId} 应能产出计划`).toBe(true);
      for (const key of Object.keys(plan.changes)) {
        expect(allowed[key], `${providerId} 写了未登记的键 ${key}`).toBe(true);
      }
    }
  });
});
