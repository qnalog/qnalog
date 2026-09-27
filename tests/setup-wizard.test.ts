import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { PluginSettings } from "../src/shared/types";
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
