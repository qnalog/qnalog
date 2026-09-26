import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { PluginSettings } from "../src/shared/types";
import { applyPresetPlan } from "../src/setup";
import { diarizationModelCandidates, filterModelsForCategory, mergeModelCandidates, wizardModelCandidates } from "../src/setup/model-catalog";
import { SetupWizardController, needsFirstRunWizard } from "../src/setup/wizard-controller";
import type { ProbePorts } from "../src/setup";

// 向导编排层的契约（与 src/setup/wizard-controller.ts 头注释一一对应）：
//   1. 计划不完整进不了下一步，reason 原样可见；
//   2. 填写与计划只存内存，写盘点只有 apply 与 dismiss；
//   3. 检测跑在候选配置上，检测宿主没有可用的写盘入口；
//   4. 自动弹出判据与首页四态同口径。

function freshSettings(): PluginSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as PluginSettings;
}

function makeWizard(settings: PluginSettings = freshSettings()) {
  let saveCalls = 0;
  const host = {
    plugin: {
      settings,
      saveSettings: async () => { saveCalls += 1; },
    },
    probePorts: (): ProbePorts => ({
      transcribe: async () => "你好",
      importTranscribe: async () => ({}),
      llm: async () => ({ model: "m" }),
    }),
    saveSettings: async () => { saveCalls += 1; },
  };
  const controller = new SetupWizardController(host);
  return { controller, settings, saveCount: () => saveCalls };
}

describe("步骤 2 的启用条件（计划完整性）", () => {
  it("未填密钥时计划不完整：ok=false、reason 非空、进不了下一步", () => {
    const { controller } = makeWizard();
    controller.selectPreset("mimo");
    const plan = controller.updateRequest({ apiKey: "" });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBeTruthy();
    expect(controller.canProceed).toBe(false);
  });

  it("填了密钥后计划完整，可以进入检测", () => {
    const { controller } = makeWizard();
    controller.selectPreset("mimo");
    const plan = controller.updateRequest({ apiKey: "sk-test" });
    expect(plan.ok).toBe(true);
    expect(plan.reason).toBe("");
    expect(controller.canProceed).toBe(true);
  });
});

describe("取消不写盘", () => {
  it("选预设、填密钥阶段：设置原样，saveSettings 不被调用", () => {
    const { controller, settings, saveCount } = makeWizard();
    const before = JSON.parse(JSON.stringify(settings));
    controller.selectPreset("mimo");
    controller.updateRequest({ apiKey: "sk-typed-but-cancelled" });
    expect(settings).toEqual(before);
    expect(saveCount()).toBe(0);
  });

  it("dismiss 只写「不再自动弹出」这一个字段，服务配置原样", async () => {
    const { controller, settings, saveCount } = makeWizard();
    controller.selectPreset("mimo");
    controller.updateRequest({ apiKey: "sk-typed-but-cancelled" });
    const servicesBefore = JSON.parse(JSON.stringify({
      transcribeProviders: settings.transcribeProviders,
      llmApiKey: settings.llmApiKey,
      activeTranscribeProvider: settings.activeTranscribeProvider,
    }));

    await controller.dismiss();

    expect(settings.setupWizardDismissed).toBe(true);
    expect(saveCount()).toBe(1);
    expect(controller.plan).toBeNull();
    expect(controller.request).toBeNull();
    expect(JSON.parse(JSON.stringify({
      transcribeProviders: settings.transcribeProviders,
      llmApiKey: settings.llmApiKey,
      activeTranscribeProvider: settings.activeTranscribeProvider,
    }))).toEqual(servicesBefore);

    // 已经记过的不再重复写盘
    await controller.dismiss();
    expect(saveCount()).toBe(1);
  });
});

describe("检测用候选配置且不落盘", () => {
  it("检测读到的是候选密钥；检测期间调用写盘入口会被拒绝", async () => {
    const settings = freshSettings();
    settings.llmApiKey = "sk-old-llm";
    settings.transcribeProviders.siliconflow.apiKey = "sk-old-asr";

    const seen: PluginSettings[] = [];
    const plugin = {
      settings,
      saveSettings: async () => { throw new Error("检测过程不得写盘"); },
      saveAll: async () => { throw new Error("检测过程不得写盘"); },
    };
    let refused = 0;
    const controller = new SetupWizardController({
      plugin,
      probePorts: (): ProbePorts => ({
        transcribe: async (h) => {
          const probe = h as unknown as { settings: PluginSettings; saveSettings(): Promise<void> };
          seen.push(probe.settings);
          try {
            await probe.saveSettings();
          } catch {
            refused += 1;
          }
          return "你好";
        },
        importTranscribe: async (h) => {
          const probe = h as unknown as { settings: PluginSettings };
          seen.push(probe.settings);
          return {};
        },
        llm: async (h) => {
          const probe = h as unknown as { settings: PluginSettings };
          seen.push(probe.settings);
          return { model: "m" };
        },
      }),
      saveSettings: async () => undefined,
    });

    controller.selectPreset("mimo");
    controller.updateRequest({ apiKey: "sk-candidate" });
    const report = await controller.detect();

    expect(report.ok).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const probe of seen) {
      // 检测看到的是候选密钥，不是磁盘上的旧值
      expect(probe.llmApiKey).toBe("sk-candidate");
      expect(probe.transcribeProviders.siliconflow?.apiKey === "sk-candidate"
        || probe.transcribeProviders.apimimo?.apiKey === "sk-candidate").toBe(true);
    }
    // buildProbeHost 装上的拒绝函数生效
    expect(refused).toBeGreaterThanOrEqual(1);
    // 真实 saveSettings（plugin 上那个）没有被检测碰到
    expect(settings.llmApiKey).toBe("sk-old-llm");
    expect(settings.setupWizardDismissed).toBe(false);
  });

  it("apply 是写盘点：候选配置合入设置并保存一次", async () => {
    const { controller, settings, saveCount } = makeWizard();
    controller.selectPreset("mimo");
    controller.updateRequest({ apiKey: "sk-apply" });
    await controller.apply();
    expect(saveCount()).toBe(1);
    expect(settings.llmApiKey).toBe("sk-apply");
    expect(controller.step).toBe("done");
  });

  it("计划不完整时 apply/detect 直接抛错，不会写出半套配置", async () => {
    const { controller, saveCount } = makeWizard();
    controller.selectPreset("mimo");
    controller.updateRequest({ apiKey: "" });
    await expect(controller.apply()).rejects.toThrow();
    await expect(controller.detect()).rejects.toThrow();
    expect(saveCount()).toBe(0);
  });
});

describe("自动弹出判据", () => {
  const profiles = { getTranscribeProviderProfile: () => ({ requiresKey: true }) };

  function completedSettings(): PluginSettings {
    const s = freshSettings();
    s.transcribeProviders.siliconflow = {
      ...s.transcribeProviders.siliconflow,
      endpoint: "https://api.siliconflow.cn/v1/audio/transcriptions",
      model: "FunAudioLLM/SenseVoiceSmall",
      apiKey: "sk-asr",
    };
    s.llmEndpoint = "https://api.openai.com/v1";
    s.llmModel = "gpt-4o-mini";
    s.llmApiKey = "sk-llm";
    return s;
  }

  it("全新设置（转写与 AI 整理都缺配置）→ 弹", () => {
    expect(needsFirstRunWizard(freshSettings(), profiles)).toBe(true);
  });

  it("AI 整理已配置 → 不弹", () => {
    const s = freshSettings();
    s.llmEndpoint = "https://api.openai.com/v1";
    s.llmModel = "gpt-4o-mini";
    s.llmApiKey = "sk-llm";
    expect(needsFirstRunWizard(s, profiles)).toBe(false);
  });

  it("转写已配置 → 不弹", () => {
    const s = freshSettings();
    s.transcribeProviders.siliconflow = {
      ...s.transcribeProviders.siliconflow,
      endpoint: "https://api.siliconflow.cn/v1/audio/transcriptions",
      model: "FunAudioLLM/SenseVoiceSmall",
      apiKey: "sk-asr",
    };
    expect(needsFirstRunWizard(s, profiles)).toBe(false);
  });

  it("两项都配好 → 不弹", () => {
    expect(needsFirstRunWizard(completedSettings(), profiles)).toBe(false);
  });

  it("用户关闭过向导 → 永不自动弹（即使缺配置）", () => {
    const s = freshSettings();
    s.setupWizardDismissed = true;
    expect(needsFirstRunWizard(s, profiles)).toBe(false);
  });
});

describe("模型候选的分类过滤（model-catalog）", () => {
  const mixed = ["qwen3-asr-flash", "mimo-v2.6-flash", "whisper-large-v3", "qwen3.8-flash", "mimo-v2.5-asr", "deepseek-v4.1-flash"];

  it("asr 分类取转写命名族内的模型", () => {
    const asr = filterModelsForCategory(mixed, "asr");
    expect(asr).toContain("qwen3-asr-flash");
    expect(asr).toContain("whisper-large-v3");
    expect(asr).not.toContain("qwen3.8-flash");
  });

  it("llm 分类排除转写族", () => {
    const llm = filterModelsForCategory(mixed, "llm");
    expect(llm).toContain("qwen3.8-flash");
    expect(llm).not.toContain("mimo-v2.5-asr");
  });

  it("asr 筛空返回空，由「当前默认值」合并兜底，不再把大模型整表端上来", () => {
    expect(filterModelsForCategory(["gemini-2.5-pro", "qwen3.8-flash"], "asr")).toEqual([]);
    expect(mergeModelCandidates(["qwen3-asr-flash"], filterModelsForCategory(["qwen3.8-flash", "qwen-max"], "asr")))
      .toEqual(["qwen3-asr-flash"]);
  });

  it("llm 筛空回退全量，不留空列表", () => {
    expect(filterModelsForCategory(["qwen3-asr-flash"], "llm")).toEqual(["qwen3-asr-flash"]);
    expect(filterModelsForCategory([], "llm")).toEqual([]);
  });

  it("mergeModelCandidates 保序去重", () => {
    expect(mergeModelCandidates(["a"], ["a", "b"], ["b", "c"], [])).toEqual(["a", "b", "c"]);
    expect(mergeModelCandidates([], [])).toEqual([]);
  });
});

describe("说话人分离候选（只列仓库内有依据的模型）", () => {
  it("预设默认排最前，再补平台已验证候选", () => {
    expect(diarizationModelCandidates("openrouter", "microsoft/mai-transcribe-2")[0]).toBe("microsoft/mai-transcribe-2");
    const bailian = diarizationModelCandidates("bailian", "qwen-audio-3.0-asr-flash-filetrans");
    expect(bailian).toContain("qwen-audio-3.0-asr-flash-filetrans");
    expect(bailian).toContain("paraformer-v2");
  });

  it("未知平台只回默认值", () => {
    expect(diarizationModelCandidates("mimo", "mimo-v2.5-asr")).toEqual(["mimo-v2.5-asr"]);
  });
});

describe("模型默认值继承预设", () => {
  it("mimo：转写默认取服务默认模型，整理默认取预设内置，无分离模型", () => {
    const { controller } = makeWizard();
    controller.selectPreset("mimo");
    const defaults = controller.modelDefaults();
    expect(defaults.asrModel).toBe(DEFAULT_SETTINGS.transcribeProviders.apimimo.model);
    expect(defaults.llmModel).toBe("mimo-v2.6-flash");
    expect(defaults.importAsrModel).toBe("");
  });

  it("bailian：三个分类都有默认", () => {
    const { controller } = makeWizard();
    controller.selectPreset("bailian");
    const defaults = controller.modelDefaults();
    expect(defaults.asrModel).toBe("qwen3-asr-flash");
    expect(defaults.llmModel).toBe("qwen3.8-flash");
    expect(defaults.importAsrModel).toBe("qwen-audio-3.0-asr-flash-filetrans");
  });

  it("自定义模型经 updateRequest 进计划并由 apply 写入", () => {
    const { controller, settings } = makeWizard();
    controller.selectPreset("bailian");
    controller.updateRequest({ apiKey: "sk-bailian", asrModel: "paraformer-v2", importAsrModel: "paraformer-v2" });
    expect(controller.canProceed).toBe(true);
    const plan = controller.plan!;
    const after = applyPresetPlan(settings, plan);
    expect(after.transcribeProviders["dashscope-chat"].model).toBe("paraformer-v2");
    expect(after.transcribeProviders["dashscope-filetrans"].model).toBe("paraformer-v2");
  });
});

describe("带 type 字段的目录分类（百炼原生形态）", () => {
  it("id 不含命名族词根、但 type 是 asr 的条目也能进转写候选", () => {
    const entries = [
      { id: "custom-voice-model-1", type: "asr" },
      { id: "qwen3.8-flash", type: "llm" },
      { id: "cosyvoice-v2", type: "tts" },
    ];
    const asr = filterModelsForCategory(entries, "asr");
    expect(asr).toContain("custom-voice-model-1");
    expect(asr).not.toContain("qwen3.8-flash");
    // tts 不冒充转写模型
    expect(asr).not.toContain("cosyvoice-v2");
  });

  it("命名族命中与 type 命中合并去重", () => {
    const entries = [
      { id: "qwen3-asr-flash", type: "asr" },
      { id: "other-asr-model", type: "asr" },
    ];
    const asr = filterModelsForCategory(entries, "asr");
    expect(asr).toEqual(["qwen3-asr-flash", "other-asr-model"]);
  });
});

describe("AI 整理分类排除生成类模型", () => {
  it("输出模态含 image/video/audio 的排除，纯文本与无模态信息的保留", () => {
    const entries = [
      { id: "qwen3.8-max", outputModalities: ["text"] },
      { id: "happyhorse-1.1-t2v", outputModalities: ["video"] },
      { id: "wan2.7-t2i", outputModalities: ["image"] },
      { id: "cosyvoice-v2", outputModalities: ["audio"] },
      { id: "gemini-3.1-flash-image", outputModalities: ["image", "text"] },
      { id: "mimo-v2.6-flash" },
      { id: "qwen3-asr-flash", outputModalities: ["text"] },
    ];
    const llm = filterModelsForCategory(entries, "llm");
    expect(llm).toContain("qwen3.8-max");
    expect(llm).toContain("mimo-v2.6-flash");
    expect(llm).not.toContain("happyhorse-1.1-t2v");
    expect(llm).not.toContain("wan2.7-t2i");
    expect(llm).not.toContain("cosyvoice-v2");
    expect(llm).not.toContain("gemini-3.1-flash-image");
    expect(llm).not.toContain("qwen3-asr-flash");
  });
});

describe("转写候选只认 id 命名族与 type", () => {
  it("理解型音频模型、裸 audio 词根与 type=audio 都不收（合成模型会挂这类值）", () => {
    const entries = [
      "openai/gpt-audio",
      "whisper-large-v3",
      { id: "qwen3-asr-flash" },
      { id: "vendor-x", type: "asr" },
      { id: "vendor-tts", type: "audio" },
      { id: "pure-text-model" },
    ];
    expect(filterModelsForCategory(entries, "asr")).toEqual([
      "whisper-large-v3",
      "qwen3-asr-flash",
      "vendor-x",
    ]);
  });

  it("AI 整理排除向量/重排/合成族 id（即便没有模态信息）", () => {
    const entries = [
      "text-embedding-v4",
      "bge-reranker-v2",
      "cosyvoice-v2",
      "sambert-v1",
      "tts-kimi",
      "qwen3.8-flash",
    ];
    const llm = filterModelsForCategory(entries, "llm");
    expect(llm).toEqual(["qwen3.8-flash"]);
  });
});

describe("说话人分离候选的目录发现", () => {
  it("描述写明说话人分离且具备转写能力的目录模型被收进来", () => {
    const catalog = [
      { id: "paraformer-v2", description: "支持说话人分离的中文语音识别模型" },
      { id: "fun-asr-longform", description: "Speaker diarization supported for long audio files." },
      { id: "some-chat-model", description: "支持多说话人对话理解的大模型" },
      { id: "vendor-via-type", type: "asr", description: "支持说话人分离的音频理解" },
    ];
    const list = diarizationModelCandidates("bailian", "qwen-audio-3.0-asr-flash-filetrans", catalog);
    expect(list[0]).toBe("qwen-audio-3.0-asr-flash-filetrans");
    expect(list).toContain("paraformer-v2");
    expect(list).toContain("fun-asr-longform");
    expect(list).toContain("vendor-via-type");
    // 描述提到「说话人」但没有转写能力的大模型不收
    expect(list).not.toContain("some-chat-model");
    // 仓库内已验证候选仍在
    expect(list).toContain("paraformer-v2");
  });

  it("目录为空（拉取失败回退）时只有仓库内候选", () => {
    const list = diarizationModelCandidates("openrouter", "microsoft/mai-transcribe-2");
    expect(list).toEqual(["microsoft/mai-transcribe-2"]);
  });
});

describe("向导列表组装（wizardModelCandidates）", () => {
  it("openrouter 转写列表 = 预填值 ∪ 8 个实测特例 ∪ 目录命中，保序去重", () => {
    const list = wizardModelCandidates(
      "openrouter",
      "asr",
      "qwen/qwen3-asr-1.7b",
      [{ id: "openai/gpt-audio" }, { id: "some-asr-model" }],
    );
    expect(list[0]).toBe("qwen/qwen3-asr-1.7b");
    expect(list).toContain("openai/whisper-large-v3");
    expect(list).toContain("openai/gpt-4o-transcribe");
    expect(list).toContain("microsoft/mai-transcribe-2");
    expect(list).toContain("deepgram/nova-3");
    expect(list).toContain("some-asr-model");
    expect(list).not.toContain("openai/gpt-audio");
    // 8 个实测特例 + 目录命中的 some-asr-model；预填值与特例重复不计
    expect(list).toHaveLength(9);
    expect(new Set(list).size).toBe(list.length);
  });

  it("整理列表不含特例清单（whisper 类不能混进 AI 整理）", () => {
    const llm = wizardModelCandidates(
      "openrouter",
      "llm",
      "deepseek/deepseek-v4.1-flash",
      [{ id: "deepseek/deepseek-v4.1-flash" }, { id: "qwen/qwen3.8-flash" }],
    );
    expect(llm).toEqual(["deepseek/deepseek-v4.1-flash", "qwen/qwen3.8-flash"]);
    expect(llm.join(",")).not.toContain("whisper");
    expect(llm.join(",")).not.toContain("transcribe");
  });

  it("可枚举平台的转写列表不掺特例（百炼只信目录命名族）", () => {
    const bailian = wizardModelCandidates("bailian", "asr", "qwen3-asr-flash", [{ id: "qwen3-asr-flash" }, { id: "paraformer-v2" }]);
    expect(bailian).toEqual(["qwen3-asr-flash", "paraformer-v2"]);
    expect(wizardModelCandidates("mimo", "asr", "mimo-v2.5-asr", [])).toEqual(["mimo-v2.5-asr"]);
  });
});
