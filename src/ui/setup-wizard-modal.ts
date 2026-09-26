// 首次配置向导：分步引导新用户完成服务配置的 Modal。
// 只做界面编排与步骤渲染——计划、检测、写盘都在 src/setup/wizard-controller.ts，
// 本文件不碰 plan/apply/detect 逻辑，也不 import src/main.ts（依赖由构造参数注入）。
//
// 四步：选方案 → 填密钥 → 检测 → 完成。任意时刻「稍后设置」退出：
// 退出只写「不再自动弹出」标志，不写任何服务配置（取消 = 丢弃内存中的计划）。

import * as obsidian from "obsidian";
import { ONE_CARD_PROVIDERS } from "../llm/config";
import { fetchLlmModelList } from "../llm/core";
import { formatDetectionReport, resolvePresetEndpoint } from "../setup";
import type { PresetDefinition } from "../setup";
import { diarizationModelCandidates, filterModelsForCategory } from "../setup/model-catalog";
import type { WizardModelCategory } from "../setup/model-catalog";
import { SetupWizardController } from "../setup/wizard-controller";
import type { SetupWizardDeps } from "../setup/wizard-controller";
import { t } from "../shared/i18n";
import type { PluginSettings } from "../shared/types";
import { openPickListModal } from "./helpers";

/** 与 src/setup 里的 PRESETS 同构的类型化视图（ONE_CARD_PROVIDERS 的字面量类型逐项兼容 PresetDefinition）。 */
const PRESET_VIEW: Record<string, PresetDefinition> = ONE_CARD_PROVIDERS;

/** 步骤 2 的输入补丁：与 PresetRequest 的可选字段同形（providerId 由控制器持有）。 */
type ModelPatch = { apiKey?: string; asrModel?: string; llmModel?: string; importAsrModel?: string };

/** 向导界面在控制器依赖之上还需要的两个跳转动作，由装配层注入。 */
export interface SetupWizardModalDeps<T extends { settings: PluginSettings }> extends SetupWizardDeps<T> {
  /** 「手动配置」入口：跳到设置页的指定标签。 */
  openSettingsTab(tab: string): void;
  /** 完成页的「打开侧边栏」。 */
  openOutlineView(): Promise<void>;
}

export class SetupWizardModal<T extends { settings: PluginSettings }> extends obsidian.Modal {
  private readonly controller: SetupWizardController<T>;
  /** 已经写过盘（应用或关闭标志），onClose 不必再补一次。 */
  private settled = false;
  private detecting = false;
  private probeError = "";
  /** 「应用并开始」已完成：完成页切到应用后形态。 */
  private appliedDone = false;
  /** 步骤 2 的校验信息与「下一步」按钮，随输入就地刷新（不整体重渲染，避免输入框丢焦点）。 */
  private reasonEl: HTMLElement | null = null;
  private nextBtn: HTMLButtonElement | null = null;
  /** 步骤 2 的模型输入与拉取按钮；锁定态随密钥是否填写切换。 */
  private modelFields: Array<{ category: WizardModelCategory; text: obsidian.TextComponent; button: obsidian.ButtonComponent }> = [];
  /** 平台模型目录按端点缓存，同一方案的三个分类共用一次拉取。 */
  private modelCache: { endpoint: string; ids: string[] } | null = null;

  constructor(app: obsidian.App, private readonly deps: SetupWizardModalDeps<T>) {
    super(app);
    this.controller = new SetupWizardController(deps);
  }

  onOpen(): void {
    this.setTitle(t("Setup Wizard"));
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) void this.controller.dismiss();
  }

  private render(): void {
    this.reasonEl = null;
    this.nextBtn = null;
    this.modelFields = [];
    const wrap = this.contentEl;
    wrap.empty();
    const root = wrap.createDiv({ cls: "qnalog-wizard-root" });
    switch (this.controller.step) {
      case "pick-preset": this.renderPick(root); break;
      case "enter-key": this.renderKeyEntry(root); break;
      case "probe": this.renderProbe(root); break;
      case "done": this.renderDone(root); break;
    }
    // 页脚固定承载次要动作，跨步骤位置不变：左「稍后设置」（最弱的退出动作），
    // 右「手动配置」（仅选方案步，与右侧主导航同侧）。主按钮一律强调色，二者用默认/弱化两级。
    if (!this.settled || this.controller.step === "pick-preset") {
      const foot = root.createDiv({ cls: "qnalog-wizard-foot" });
      if (!this.settled) {
        const later = foot.createEl("button", { text: t("Set up later"), cls: "qnalog-wizard-btn-quiet" });
        later.onclick = () => { void this.dismissAndClose(); };
      }
      if (this.controller.step === "pick-preset") {
        const manual = foot.createEl("button", { text: t("Manual setup") });
        manual.onclick = () => {
          this.deps.openSettingsTab("api");
          this.close();
        };
      }
    }
  }

  /** 步骤 1：选方案；「手动配置」出口在页脚，与「稍后设置」同一行。 */
  private renderPick(root: HTMLElement): void {
    root.createDiv({
      cls: "qnalog-wizard-desc",
      text: t("Pick a preset plan below, choose a provider, and enter its API key to start recording voice notes and organizing them automatically."),
    });
    for (const [id, preset] of Object.entries(PRESET_VIEW)) {
      const row = root.createDiv({ cls: "qnalog-wizard-preset" });
      const head = row.createDiv({ cls: "qnalog-wizard-preset-head" });
      head.createSpan({ cls: "qnalog-wizard-preset-label", text: preset.label || id });
      const use = head.createEl("button", { text: t("Use this plan") });
      use.onclick = () => { this.controller.selectPreset(id); this.render(); };
      if (preset.applyDesc) row.createDiv({ cls: "qnalog-wizard-preset-desc", text: preset.applyDesc });
    }
  }

  /** 步骤 2：填密钥；模型选择默认继承预设，密钥非空后解锁并可拉取平台模型列表。 */
  private renderKeyEntry(root: HTMLElement): void {
    const preset = PRESET_VIEW[this.controller.providerId] || {};
    root.createEl("h3", { text: preset.label || this.controller.providerId });
    const defaults = this.controller.modelDefaults();
    const request = this.controller.request;

    const keyRow = new obsidian.Setting(root)
      .setName(t("API key"))
      .setDesc(t("Model pickers below unlock once an API key is entered."));
    keyRow.addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("sk-…");
      if (request && request.apiKey) text.setValue(request.apiKey);
      text.onChange((v) => {
        this.refreshPlan(v.trim() ? { apiKey: v.trim() } : { apiKey: "" });
        this.updateModelLocks();
      });
    });

    const addModelRow = (
      label: string,
      category: WizardModelCategory,
      initial: string,
      patch: (value: string) => ModelPatch,
    ): void => {
      let input!: obsidian.TextComponent;
      let pickButton!: obsidian.ButtonComponent;
      const row = new obsidian.Setting(root).setName(label);
      row.addText((text) => {
        input = text;
        text.setValue(initial);
        text.onChange((v) => { this.refreshPlan(patch(v.trim())); });
      });
      row.addButton((button) => {
        pickButton = button;
        button.setButtonText(t("Get available models"));
        button.onClick(() => {
          void this.openModelPicker(category, input.getValue(), (id) => {
            input.setValue(id);
            this.refreshPlan(patch(id));
          });
        });
      });
      this.modelFields.push({ category, text: input, button: pickButton });
    };

    addModelRow(t("Transcription model"), "asr",
      request && request.asrModel ? request.asrModel : defaults.asrModel,
      (value) => ({ asrModel: value }));
    if (preset.llmPreset) {
      addModelRow(t("AI organizing model"), "llm",
        request && request.llmModel ? request.llmModel : defaults.llmModel,
        (value) => ({ llmModel: value }));
    }
    if (preset.importAsrProvider) {
      addModelRow(t("Speaker diarization model"), "diarization",
        request && request.importAsrModel ? request.importAsrModel : defaults.importAsrModel,
        (value) => ({ importAsrModel: value }));
    }

    this.reasonEl = root.createDiv({ cls: "qnalog-wizard-reason" });

    const nav = root.createDiv({ cls: "qnalog-wizard-nav" });
    const back = nav.createEl("button", { text: t("Back") });
    back.onclick = () => { this.controller.step = "pick-preset"; this.render(); };
    this.nextBtn = nav.createEl("button", { text: t("Next"), cls: "mod-cta" });
    this.nextBtn.onclick = () => { void this.startDetection(); };
    this.refreshPlan(null);
    this.updateModelLocks();
  }

  /** 密钥非空才解锁模型选择；真正的有效性由步骤 3 的检测把关。 */
  private updateModelLocks(): void {
    const unlocked = (((this.controller.request && this.controller.request.apiKey) || "")).trim().length > 0;
    for (const field of this.modelFields) {
      field.text.inputEl.disabled = !unlocked;
      field.button.setDisabled(!unlocked);
    }
  }

  /** 拉取平台模型目录（按端点缓存，三个分类共用一次请求）→ 分类过滤 → 点选。 */
  private async openModelPicker(category: WizardModelCategory, current: string, apply: (id: string) => void): Promise<void> {
    const apiKey = (((this.controller.request && this.controller.request.apiKey) || "")).trim();
    if (!apiKey) return;
    const preset = PRESET_VIEW[this.controller.providerId] || {};
    try {
      let list: string[];
      if (category === "diarization") {
        list = diarizationModelCandidates(this.controller.providerId, current || preset.importAsrModel || "");
      } else {
        const endpoint = resolvePresetEndpoint(preset, apiKey);
        const ids = await this.getPlatformModels(endpoint, apiKey);
        list = filterModelsForCategory(ids, category);
      }
      if (!list.length) {
        new obsidian.Notice(t("The service did not return a model list. Please enter the model ID manually."), 6000);
        return;
      }
      openPickListModal(this.app, `${t("Select a model ( ")}${list.length}${t(")")}`, list, apply);
    } catch (error) {
      new obsidian.Notice(`${t("Failed to get the model list:")}${(error && (error as Error).message) || error}${t(". You can enter the model ID manually.")}`, 8000);
    }
  }

  private async getPlatformModels(endpoint: string, apiKey: string): Promise<string[]> {
    if (this.modelCache && this.modelCache.endpoint === endpoint) return this.modelCache.ids;
    const ids = await fetchLlmModelList(endpoint, apiKey);
    this.modelCache = { endpoint, ids };
    return ids;
  }

  /** 输入变化 → 控制器重算计划 → 就地刷新 reason 与「下一步」可用态。 */
  private refreshPlan(patch: ModelPatch | null): void {
    if (patch) this.controller.updateRequest(patch);
    const plan = this.controller.plan;
    if (this.reasonEl) this.reasonEl.setText(plan && !plan.ok ? plan.reason : "");
    if (this.nextBtn) this.nextBtn.disabled = !this.controller.canProceed;
  }

  private async startDetection(): Promise<void> {
    this.controller.step = "probe";
    this.detecting = true;
    this.probeError = "";
    this.render();
    try {
      await this.controller.detect();
    } catch (error) {
      this.probeError = (error && (error as Error).message) || String(error);
    } finally {
      this.detecting = false;
      this.render();
    }
  }

  /** 步骤 3：分阶段显示检测结果；失败可重试或跳过（跳过后首页四态仍显示未测试）。 */
  private renderProbe(root: HTMLElement): void {
    root.createEl("h3", { text: t("Checking…") });
    const list = root.createDiv({ cls: "qnalog-wizard-stages" });
    if (this.detecting) {
      list.createDiv({ cls: "qnalog-wizard-stage is-neutral", text: t("Checking…") });
      return;
    }
    const report = this.controller.report;
    if (report) {
      for (const stage of report.stages) {
        const row = list.createDiv({ cls: `qnalog-wizard-stage ${stage.ok ? "is-ok" : "is-fail"}` });
        row.createSpan({ cls: "qnalog-wizard-stage-mark", text: stage.ok ? "✓" : "✗" });
        row.createSpan({ cls: "qnalog-wizard-stage-label", text: stage.label });
        row.createSpan({ cls: "qnalog-wizard-stage-detail", text: stage.detail });
      }
    }
    if (this.probeError) {
      list.createDiv({ cls: "qnalog-wizard-stage is-fail", text: this.probeError });
    }
    if (!report && !this.probeError) return;

    const nav = root.createDiv({ cls: "qnalog-wizard-nav" });
    const back = nav.createEl("button", { text: t("Back") });
    back.onclick = () => { this.controller.step = "enter-key"; this.render(); };
    if (report && report.ok && !this.probeError) {
      const next = nav.createEl("button", { text: t("Next"), cls: "mod-cta" });
      next.onclick = () => { this.controller.step = "done"; this.render(); };
      return;
    }
    const retry = nav.createEl("button", { text: t("Retry") });
    retry.onclick = () => { void this.startDetection(); };
    const skip = nav.createEl("button", { text: t("Skip the check and continue") });
    skip.onclick = () => { this.controller.proceedWithoutDetection(); this.render(); };
  }

  /** 步骤 4：检测汇总；「应用并开始」是写盘点，应用后给「打开侧边栏」出口。 */
  private renderDone(root: HTMLElement): void {
    root.createEl("h3", {
      text: this.appliedDone ? t("Setup complete. You can start recording.") : t("Finish setup"),
    });
    const report = this.controller.report;
    root.createDiv({
      cls: "qnalog-wizard-summary",
      text: report ? formatDetectionReport(report) : t("Check skipped"),
    });

    const nav = root.createDiv({ cls: "qnalog-wizard-nav" });
    if (this.appliedDone) {
      const sidebar = nav.createEl("button", { text: t("Open sidebar"), cls: "mod-cta" });
      sidebar.onclick = () => {
        void Promise.resolve(this.deps.openOutlineView()).catch(() => undefined);
        this.close();
      };
      const done = nav.createEl("button", { text: t("Done") });
      done.onclick = () => this.close();
      return;
    }
    const back = nav.createEl("button", { text: t("Back") });
    back.onclick = () => { this.controller.step = "probe"; this.render(); };
    const apply = nav.createEl("button", { text: t("Apply and start"), cls: "mod-cta" });
    apply.onclick = () => { void this.applyAndStart(apply); };
  }

  private async applyAndStart(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      await this.controller.apply();
      this.appliedDone = true;
      this.settled = true;
    } catch (error) {
      button.disabled = false;
      new obsidian.Notice(`${t("Check failed")}：${(error && (error as Error).message) || error}`, 8000);
      return;
    }
    this.render();
  }

  private async dismissAndClose(): Promise<void> {
    try {
      await this.controller.dismiss();
    } finally {
      this.settled = true;
      this.close();
    }
  }
}
