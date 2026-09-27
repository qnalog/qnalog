// 首次配置向导的步骤状态机：纯逻辑，不碰 DOM。
// 界面在 src/ui/setup-wizard-modal.ts（把控制器状态渲染成 DOM），触发判据在本文件末尾。
// 与 tests/setup-wizard.test.ts 一一对应的契约：
//   1. 计划不完整（ok=false）进不了下一步，reason 原样展示给用户；
//   2. 填写与计划只存内存：进入写盘动作之前，设置原样、saveSettings 不被调用；
//   3. 检测跑在候选配置上，检测宿主的写盘入口是拒绝函数（buildProbeHost 保证）；
//   4. 自动弹出判据与设置首页四态同口径（buildServiceView + setupServiceIssue）。
//
// 写盘点只有两个：apply（应用候选配置）与 dismiss（记下「不再自动弹出」），
// 都必须经装配层注入的 saveSettings，不直接触碰 saveData。

import {
  applyPresetPlan,
  buildProbeHost,
  buildServiceView,
  planPresetApplication,
  runPresetDetection,
  setupServiceIssue,
} from "./index";
import type { DetectionReport, PresetPlan, PresetRequest, ProbePorts } from "./index";
import { canOmitServiceApiKey } from "../shared/util-llm-endpoint";
import type { PluginSettings, TranscribeProviderSettings } from "../shared/types";

export type WizardStep = "pick-preset" | "enter-key" | "probe" | "done";

/** 向导需要的依赖；由装配层（src/main.ts）提供，界面模块不 import main.ts。 */
export interface SetupWizardDeps<T extends { settings: PluginSettings }> {
  /** 插件实例：buildProbeHost 在它上面构造只读检测宿主，控制器只读它的 settings。 */
  plugin: T;
  /** 检测端口：装配层指向设置页同一套实现。 */
  probePorts(): ProbePorts;
  /** 唯一写盘点：装配层指向插件的 saveSettings。 */
  saveSettings(): Promise<void>;
}

export class SetupWizardController<T extends { settings: PluginSettings }> {
  step: WizardStep = "pick-preset";
  /** 步骤 1 选中的预设 id；未选时为空串。 */
  providerId = "";
  /** 步骤 2 用户填写（密钥与可选模型）；取消即丢弃，不回填。 */
  request: PresetRequest | null = null;
  /** 由 updateRequest 重算的计划；ok 为 false 时界面禁用「下一步」。 */
  plan: PresetPlan | null = null;
  /** 步骤 3 的检测结果；跳过检测时保持 null。 */
  report: DetectionReport | null = null;

  constructor(private readonly deps: SetupWizardDeps<T>) {}

  get settings(): PluginSettings {
    return this.deps.plugin.settings;
  }

  /** 步骤 1 → 2：选定预设，之前的填写与计划作废。 */
  selectPreset(providerId: string): void {
    this.providerId = providerId;
    this.request = null;
    this.plan = null;
    this.report = null;
    this.step = "enter-key";
  }

  /** 步骤 2：密钥/模型每次变化都重算计划。不写盘——计划是纯函数的产物。 */
  updateRequest(patch: Partial<Omit<PresetRequest, "providerId">>): PresetPlan {
    const merged: Partial<PresetRequest> = { ...(this.request || {}), ...patch };
    const request: PresetRequest = {
      providerId: this.providerId,
      apiKey: String(merged.apiKey || ""),
      llmEndpoint: merged.llmEndpoint,
      asrModel: merged.asrModel,
      llmModel: merged.llmModel,
      importAsrModel: merged.importAsrModel,
    };
    this.request = request;
    this.plan = planPresetApplication(this.settings, request);
    return this.plan;
  }

  /** 界面用：能否进入下一步（计划完整才算能）。 */
  get canProceed(): boolean {
    return !!this.plan && this.plan.ok;
  }

  /** 步骤 3：在候选配置上分阶段检测。检测宿主的 settings 是候选值，写盘入口被拒绝。 */
  async detect(): Promise<DetectionReport> {
    const plan = this.requirePlan();
    this.step = "probe";
    const candidate = applyPresetPlan(this.settings, plan);
    const probeHost = buildProbeHost(this.deps.plugin, candidate);
    this.report = await runPresetDetection(probeHost as never, plan, this.deps.probePorts());
    return this.report;
  }

  /** 检测未通过时的「跳过检测直接应用」：不写盘，report 保持原样，首页四态照常显示。 */
  proceedWithoutDetection(): void {
    this.step = "done";
  }

  /** 步骤 4「应用并开始」：候选配置合入设置并保存——向导的第一个写盘点。 */
  async apply(): Promise<void> {
    const plan = this.requirePlan();
    const candidate = applyPresetPlan(this.settings, plan);
    Object.assign(this.settings, candidate);
    await this.deps.saveSettings();
    this.step = "done";
  }

  /** 「稍后设置」或关闭：丢弃内存计划，记下不再自动弹出——向导的第二个写盘点。 */
  async dismiss(): Promise<void> {
    this.plan = null;
    this.request = null;
    if (this.settings.setupWizardDismissed !== true) {
      this.settings.setupWizardDismissed = true;
      await this.deps.saveSettings();
    }
  }

  /**
   * 各分类的生效默认模型：走计划的同一条计算链（回退顺序、既有值都一致），
   * 界面预填的值因此与「不改模型直接应用」写入的值相同。
   * 密钥位放占位值只为了让计划算出 changes——结果只读模型字段，不落盘。
   */
  modelDefaults(): { asrModel: string; llmModel: string; importAsrModel: string } {
    const empty = { asrModel: "", llmModel: "", importAsrModel: "" };
    if (!this.providerId) return empty;
    const probe = planPresetApplication(this.settings, { providerId: this.providerId, apiKey: "sk-model-defaults-probe" });
    if (!probe.ok) return empty;
    const providers: Record<string, { model?: string } | undefined> = probe.changes.transcribeProviders || {};
    const readModel = (providerId: string) => {
      const provider = providerId ? providers[providerId] : undefined;
      return provider ? String(provider.model || "") : "";
    };
    return {
      asrModel: readModel(probe.asrProviderId),
      llmModel: String(probe.changes.llmModel || ""),
      importAsrModel: readModel(probe.importAsrProviderId),
    };
  }

  private requirePlan(): PresetPlan {
    if (!this.plan || !this.plan.ok) throw new Error("配置向导：计划不完整，不能继续");
    return this.plan;
  }
}

/** profiles 的窄接口：真实实现是 TranscribeProfileService，测试可注入。 */
export interface TranscribeProfilesPort {
  getTranscribeProviderProfile(id: string, provider: TranscribeProviderSettings): { requiresKey?: boolean } | null | undefined;
}

/**
 * 自动弹出向导的判据，与设置首页的四态同一口径（同一对 buildServiceView +
 * setupServiceIssue）：转写与 AI 整理**都**缺配置才弹；用户关闭过向导则永不自动弹。
 * 首页的手动入口不受 setupWizardDismissed 影响。
 */
export function needsFirstRunWizard(settings: PluginSettings, profiles: TranscribeProfilesPort): boolean {
  if (settings.setupWizardDismissed === true) return false;
  const providers = settings.transcribeProviders || {};
  const providerId = settings.activeTranscribeProvider || "siliconflow";
  const provider = providers[providerId] || {};
  const profile = profiles.getTranscribeProviderProfile(providerId, provider);
  const requiresKey = !!(profile && profile.requiresKey) && !canOmitServiceApiKey(provider.endpoint);
  const transcribeIssue = setupServiceIssue(buildServiceView(provider, requiresKey));
  const llmIssue = setupServiceIssue(buildServiceView({
    endpoint: settings.llmEndpoint,
    model: settings.llmModel,
    apiKey: settings.llmApiKey,
  }, !canOmitServiceApiKey(settings.llmEndpoint)));
  return Boolean(transcribeIssue) && Boolean(llmIssue);
}
