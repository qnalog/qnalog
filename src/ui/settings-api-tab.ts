/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- the LLM config helpers imported here (llm/config.ts, llm/core.ts, llm/asr-scheme.ts) are still untyped */
// 设置页「API」标签：语音转写卡片、AI 整理卡片、进阶区（导入音频说话人识别、已保存的方案）。
//
// 本模块只建 DOM、收集输入并调用 src/setup/ 里有类型检查的决策函数；不读写磁盘，保存经 host.saveSettings。
// 重画方式：每张卡片、每个进阶区块各自是一个容器（createBlock），动作只清空并重建受影响的容器；
// 在输入框里打字只写设置，不重画。整页重画（renderSettings）只在切换标签页时发生。

import * as obsidian from "obsidian";
import type { PluginSettings, TranscribeProviderSettings } from "../shared/types";
import { t } from "../shared/i18n";
import { canOmitServiceApiKey } from "../shared/util-llm-endpoint";
import { isMobileRuntime } from "../shared/util-platform";
import {
  applyLlmProfileToWorkingConfig,
  findLlmProfile,
  getActiveLlmServicePresetId,
  getLlmServicePreset,
  inferLlmServicePresetId,
  normalizeLlmProfiles,
  syncWorkingConfigToLlmProfile,
} from "../llm/config";
import { fetchLlmModelList } from "../llm/core";
import { syncWorkingAsrToActiveScheme } from "../llm/asr-scheme";
import { resolveBailianAsrRoute } from "../asr/bailian-asr-registry";
import { isImportCapableTranscribeProvider } from "../asr/diarization";
import { fetchRecordingTranscribeModels } from "../asr/recording-model-catalog";
import { SETUP_STATE_LABELS, buildServiceView, deriveSetupState } from "../setup";
import type { ProbeResult, SetupServiceView, SetupState } from "../setup";
import {
  currentLlmServiceId,
  currentRecordingServiceId,
  listLlmServices,
  listRecordingServices,
  selectRecordingService,
} from "../setup/service-catalog";
import { switchLlmService } from "../setup/llm-service-switch";
import { applyBailianModelPlan, isBailianRecordingProvider, planBailianModelSelection } from "../setup/bailian-model-route";
import { resolvePanelOpen } from "../setup/settings-view-state";
import { openExternalUrl } from "./helpers";

/** 转写服务档案里本模块用到的字段（档案由 TranscribeProfileService 提供）。 */
export interface ApiProviderProfile {
  title?: string;
  description?: string;
  badge?: string;
  requiresKey?: boolean;
  transcribeMode?: string;
  requiresWholeSession?: unknown;
  streamProtocol?: string;
  hideLanguage?: boolean;
  showTargetLanguage?: boolean;
  steps?: string[];
  priceHint?: string;
  note?: string;
  links?: Array<[string, string]>;
  keyHelp?: string;
  endpointHelp?: string;
  modelHelp?: string;
  languageHelp?: string;
  endpointPlaceholder?: string;
  modelPlaceholder?: string;
  languagePlaceholder?: string;
}

/** 只存在内存里的界面状态，跨整页重画保留。 */
export interface ApiTabUiState {
  advancedOpen: boolean;
  /** 配置指南的展开状态，键为 `<区块>:<服务>`。 */
  guideOpen: Record<string, boolean>;
}

/** API 标签读写的设置键；不接收完整设置对象的类型。 */
export type ApiTabSettings = Pick<
  PluginSettings,
  | "activeTranscribeProvider"
  | "transcribeProviders"
  | "importTranscribeProvider"
  | "importSpeakerDiarization"
  | "importSpeakerCount"
  | "llmEndpoint"
  | "llmApiKey"
  | "llmModel"
  | "llmServicePreset"
  | "llmServiceMemory"
  | "llmProfiles"
  | "activeLlmProfile"
>;

/** API 标签需要的宿主能力；不暴露插件对象与完整设置。 */
export interface ApiTabHost {
  /** 打开模型选择列表。 */
  pickModel(title: string, items: string[], onPick: (id: string) => unknown, describe?: (id: string) => string): void;
  readonly settings: ApiTabSettings;
  saveSettings(): Promise<void>;
  readonly probeResults: Record<string, ProbeResult | undefined>;
  /** 跑一次检测并记录结果（只存内存）。 */
  runProbe(key: string, view: SetupServiceView, run: () => Promise<string>): Promise<{ ok: boolean; detail: string }>;
  testRecording(): Promise<string>;
  testLlm(): Promise<{ model?: string; preview?: string }>;
  testImport(providerId: string): Promise<{ model: string; detail: string }>;
  fetchImportModels(providerId: string): Promise<string[]>;
  getProfile(id: string, provider: TranscribeProviderSettings): ApiProviderProfile;
  renderRiskNotice(parent: HTMLElement): void;
  readonly uiState: ApiTabUiState;
}

interface Block {
  el: HTMLElement;
  refresh(): void;
}

interface Refreshers {
  recording(): void;
  ai(): void;
  importAudio(): void;
  saved(): void;
}

const FIELD_ATTR = "data-qnalog-field";

/** 容器：render 建内容；refresh 清空后重建，并把焦点还给原来的控件。 */
function createBlock(parent: HTMLElement, cls: string, render: (el: HTMLElement) => void): Block {
  const el = parent.createDiv({ cls });
  const refresh = (): void => {
    const active = el.ownerDocument ? el.ownerDocument.activeElement : null;
    const focusKey = active && el.contains(active) ? active.getAttribute(FIELD_ATTR) : null;
    el.empty();
    render(el);
    if (focusKey) {
      const target = el.querySelector<HTMLElement>(`[${FIELD_ATTR}="${focusKey}"]`);
      if (target) target.focus();
    }
  };
  render(el);
  return { el, refresh };
}

function badgeClass(state: SetupState): string {
  // 只用已有的两种配色；四态差别由文字承担。
  return state === "success" ? "is-ready" : state === "untested" ? "" : "is-missing";
}

function renderCardHead(el: HTMLElement, title: string, state: SetupState): void {
  const head = el.createDiv({ cls: "qnalog-api-card-head" });
  head.createDiv({ cls: "qnalog-provider-title", text: title });
  head.createDiv({
    cls: ("qnalog-provider-status " + badgeClass(state)).trim(),
    text: t(SETUP_STATE_LABELS[state]),
  });
}

function mark(control: HTMLElement | undefined, key: string): void {
  if (control) control.setAttribute(FIELD_ATTR, key);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

interface TextRow {
  name: string;
  desc?: string;
  value: string;
  placeholder?: string;
  password?: boolean;
  onChange: (value: string) => unknown;
}

function addTextRow(parent: HTMLElement, row: TextRow): obsidian.Setting {
  const setting = new obsidian.Setting(parent).setName(row.name);
  if (row.desc) setting.setDesc(row.desc);
  setting.addText((text) => {
    if (row.password) text.inputEl.type = "password";
    if (row.placeholder) text.setPlaceholder(row.placeholder);
    text.setValue(row.value).onChange(row.onChange);
  });
  return setting;
}

function renderGuideBody(body: HTMLElement, profile: ApiProviderProfile, missing: string[]): void {
  const checklist = body.createEl("ol", { cls: "qnalog-provider-checklist" });
  for (const step of profile.steps || []) checklist.createEl("li", { text: t(step) });
  if (missing.length) {
    body.createDiv({ cls: "qnalog-provider-missing", text: t("Still to be filled in:") + missing.join(t(", ")) });
  }
  if (profile.priceHint) body.createDiv({ cls: "qnalog-provider-price", text: t(profile.priceHint) });
  if (profile.note) body.createDiv({ cls: "qnalog-provider-note", text: t(profile.note) });
  if (profile.links && profile.links.length) {
    const row = body.createDiv({ cls: "qnalog-provider-links" });
    for (const [label, url] of profile.links) {
      const btn = row.createEl("button", { text: t(label) });
      btn.onclick = () => openExternalUrl(url);
    }
  }
}

function missingFields(provider: TranscribeProviderSettings, needsKey: boolean): string[] {
  const missing: string[] = [];
  if (!provider.endpoint) missing.push(t("Service URL"));
  if (!provider.model) missing.push(t("Model Name"));
  if (needsKey && !provider.apiKey) missing.push(t("Access Key"));
  return missing;
}

/** 折叠的配置指南：未配好时默认展开，用户操作过就沿用。 */
function renderGuide(
  parent: HTMLElement,
  host: ApiTabHost,
  guideKey: string,
  profile: ApiProviderProfile,
  provider: TranscribeProviderSettings,
  needsKey: boolean,
): void {
  const hasContent = (profile.steps && profile.steps.length) || profile.priceHint || profile.note || (profile.links && profile.links.length);
  const missing = missingFields(provider, needsKey);
  if (!hasContent && !missing.length) return;
  const panel = parent.createEl("details", { cls: "qnalog-api-guide" });
  panel.open = resolvePanelOpen(host.uiState.guideOpen, guideKey, missing.length > 0);
  panel.addEventListener("toggle", () => { host.uiState.guideOpen[guideKey] = !!panel.open; });
  panel.createEl("summary", { cls: "qnalog-api-guide-summary", text: t("Setup guide") });
  renderGuideBody(panel.createDiv({ cls: "qnalog-provider-body" }), profile, missing);
}

function targetLanguages(): Array<[string, string]> {
  return [
    ["en", t("English")],
    ["zh", t("Chinese Chinese")],
    ["ja", t("Japanese 日本語")],
    ["ko", t("Korean 한국어")],
    ["fr", t("French Français")],
    ["es", t("Spanish Español")],
    ["de", t("German Deutsch")],
    ["it", t("Italian Italiano")],
    ["pt", t("Portuguese Português")],
    ["ru", t("Russian Русский")],
    ["ar", t("Arabic العربية")],
    ["hi", t("Hindi हिन्दी")],
    ["tr", t("Turkish (Türkçe)")],
  ];
}

// ------------------------------------------------------------------ 语音转写卡片

function renderRecordingCard(el: HTMLElement, host: ApiTabHost, refresh: Refreshers): void {
  const settings = host.settings;
  const activeId = settings.activeTranscribeProvider || "siliconflow";
  const live = (): TranscribeProviderSettings => {
    if (!settings.transcribeProviders) settings.transcribeProviders = {};
    return settings.transcribeProviders[activeId] || (settings.transcribeProviders[activeId] = {});
  };
  const provider = (settings.transcribeProviders || {})[activeId] || {};
  const profile = host.getProfile(activeId, provider);
  const needsKey = !!profile.requiresKey && !canOmitServiceApiKey(provider.endpoint);
  const state = deriveSetupState(buildServiceView(provider, needsKey), host.probeResults[`transcribe:${activeId}`]);

  renderCardHead(el, t("Speech transcription"), state);
  const body = el.createDiv({ cls: "qnalog-api-fields" });

  const services = listRecordingServices(settings);
  const currentServiceId = currentRecordingServiceId(settings);
  const currentService = services.find((service) => service.id === currentServiceId);
  new obsidian.Setting(body)
    .setName(t("Transcription Service"))
    .setDesc((currentService && currentService.hint) || t(profile.description || ""))
    .addDropdown((dropdown) => {
      mark(dropdown.selectEl, "recording-service");
      for (const service of services) dropdown.addOption(service.id, service.label);
      dropdown.setValue(currentServiceId).onChange(async (value) => {
        Object.assign(settings, selectRecordingService(settings, value));
        await host.saveSettings();
        refresh.recording();
      });
    });

  renderGuide(body, host, `recording:${activeId}`, profile, provider, needsKey);

  const writeProvider = async (key: keyof TranscribeProviderSettings, value: string): Promise<void> => {
    live()[key] = value;
    // 下方任何修改自动更新到当前方案（含密钥）；没有活动方案时不做事。
    syncWorkingAsrToActiveScheme(settings);
    await host.saveSettings();
  };

  /** 选定百炼模型：按模型的路线写入；requireRoute 为真时不能安全写入就报错，不改任何字段。 */
  const writeSelectedModel = async (model: string, requireRoute: boolean): Promise<void> => {
    const plan = planBailianModelSelection(settings, model);
    if (plan.kind === "unusable" && requireRoute) {
      throw new Error(plan.reason === "unmapped-endpoint"
        ? t("The Bailian endpoint could not be mapped safely. Keep the current settings unchanged and enter a recognized Bailian API path.")
        : t("This Bailian model has no supported transcription protocol, so it was not selected."));
    }
    if (plan.kind !== "select") {
      await writeProvider("model", String(model || "").trim());
      return;
    }
    try {
      await applyBailianModelPlan(settings, plan, async () => {
        syncWorkingAsrToActiveScheme(settings);
        await host.saveSettings();
      });
    } catch (error) {
      syncWorkingAsrToActiveScheme(settings);
      throw error;
    }
    if (plan.switched) new obsidian.Notice(t("This model uses a different Bailian route, so the transcription settings were switched to match."), 6000);
  };

  const keyRow = addTextRow(body, {
    name: needsKey ? t("API key") : t("API key (optional)"),
    desc: t(profile.keyHelp || ""),
    value: provider.apiKey || "",
    password: true,
    onChange: (value) => writeProvider("apiKey", value),
  });
  keyRow.settingEl.addClass("qnalog-api-key-setting");

  addTextRow(body, {
    name: t("Service URL"),
    desc: t(profile.endpointHelp || ""),
    value: provider.endpoint || "",
    placeholder: profile.endpointPlaceholder || "",
    onChange: (value) => writeProvider("endpoint", value.trim()),
  });

  const bailian = isBailianRecordingProvider(activeId, provider);
  const modelRow = new obsidian.Setting(body).setName(t("Model Name")).setDesc(t(profile.modelHelp || ""));
  modelRow.addText((text) => {
    if (profile.modelPlaceholder) text.setPlaceholder(profile.modelPlaceholder);
    text.setValue(provider.model || "");
    if (bailian) {
      // 路线可能随模型变化，切换 provider 会重画卡片，因此输入过程中只写当前 provider，输入结束（change）时再按模型选路线。
      text.onChange(async (value) => {
        const model = value.trim();
        const plan = planBailianModelSelection(settings, model);
        if (plan.kind === "select" && plan.switched) return;
        try {
          await writeSelectedModel(model, false);
        } catch (error) {
          new obsidian.Notice(`${t("Failed to save the selected model:")}${errorText(error)}`, 8000);
        }
      });
      text.inputEl.addEventListener("change", () => {
        const model = text.inputEl.value.trim();
        const plan = planBailianModelSelection(settings, model);
        if (plan.kind !== "select" || !plan.switched) return;
        void writeSelectedModel(model, false)
          .then(() => refresh.recording())
          .catch((error: unknown) => new obsidian.Notice(`${t("Failed to save the selected model:")}${errorText(error)}`, 8000));
      });
    } else {
      text.onChange((value) => writeProvider("model", value.trim()));
    }
  });
  modelRow.addButton((button) => button.setButtonText(t("Get models")).onClick(async () => {
    const stored = live();
    const endpoint = String(stored.endpoint || "");
    const apiKey = String(stored.apiKey || "");
    const protocol = String(stored.protocol || "");
    const modelSnapshot = String(stored.model || "");
    const schemeId = String(settings.activeLlmProfile || "");
    const isCurrentConfiguration = (): boolean => {
      const currentProvider = (settings.transcribeProviders || {})[activeId];
      return (settings.activeTranscribeProvider || "siliconflow") === activeId
        && String(settings.activeLlmProfile || "") === schemeId
        && currentProvider === stored
        && String(currentProvider.endpoint || "") === endpoint
        && String(currentProvider.apiKey || "") === apiKey
        && String(currentProvider.protocol || "") === protocol
        && String(currentProvider.model || "") === modelSnapshot;
    };
    if (!endpoint.trim()) {
      new obsidian.Notice(t("Please fill in the service endpoint first"), 4000);
      return;
    }
    button.setDisabled(true);
    button.setButtonText(t("Fetching…"));
    try {
      const models = await fetchRecordingTranscribeModels({ id: activeId, endpoint, apiKey, protocol }, profile.streamProtocol);
      if (!isCurrentConfiguration()) {
        new obsidian.Notice(t("The transcription service changed. Get the models again."), 4000);
        return;
      }
      if (!models.length) {
        new obsidian.Notice(t("The service returned no usable models. Enter the model name manually."), 6000);
        return;
      }
      host.pickModel(`${t("Select a model ( ")}${models.length}${t(")")}`, models, async (model) => {
        if (!isCurrentConfiguration()) {
          new obsidian.Notice(t("The transcription service changed. Get the models again."), 4000);
          return;
        }
        try {
          if (bailian) await writeSelectedModel(model, true);
          else await writeProvider("model", model);
          new obsidian.Notice(`${t("Selected model:")}${model}`, 4000);
          refresh.recording();
        } catch (error) {
          new obsidian.Notice(`${t("Failed to save the selected model:")}${errorText(error)}`, 8000);
        }
      }, (model) => {
        if (!bailian) return "";
        const route = resolveBailianAsrRoute(model);
        if (!route) return t("No supported execution protocol");
        const modeLabel = t(route.transcribeMode === "whole-file" ? "Whole-file" : route.transcribeMode === "streaming" ? "Streaming" : "Segmented");
        const deviceLabel = route.transcribeMode === "streaming" && isMobileRuntime() ? t("Requires desktop WebSocket") : "";
        return [modeLabel, `${route.sampleRate} Hz`, deviceLabel].filter(Boolean).join(" · ");
      });
    } catch (error) {
      new obsidian.Notice(`${t("Failed to get the model list:")}${errorText(error)}${t(". You can enter the model ID manually.")}`, 8000);
    } finally {
      button.setDisabled(false);
      button.setButtonText(t("Get models"));
    }
  }));

  if (!profile.hideLanguage) {
    addTextRow(body, {
      name: t("Recognition Language"),
      desc: t(profile.languageHelp || "") || t("Leave blank or auto to detect automatically; usually fill in zh for Chinese and en for English."),
      value: provider.language || "",
      placeholder: profile.languagePlaceholder || "",
      onChange: (value) => writeProvider("language", value.trim()),
    });
  }

  if (profile.showTargetLanguage) {
    new obsidian.Setting(body)
      .setName(t("Target Language (translation output)"))
      .setDesc(t("Choose which language QnALog translates speech into. The speaker's language is detected automatically."))
      .addDropdown((dropdown) => {
        for (const [code, label] of targetLanguages()) dropdown.addOption(code, label);
        dropdown.setValue(provider.targetLanguage || "zh").onChange((value) => writeProvider("targetLanguage", value));
      });
  }

  if (profile.transcribeMode === "streaming") {
    body.createDiv({
      cls: "qnalog-provider-streaming-tip",
      text: t("Live mode: the connection stays open for the whole recording and text appears as you speak; audio is no longer uploaded in segments. “Segment interval” and “Interim segment transcription” on the Recording tab have no effect for this service."),
    });
  }

  new obsidian.Setting(body)
    .setName(t("Connectivity Test"))
    .setDesc(t("Verify that the current transcription service works using a 1-second silent audio clip."))
    .addButton((button) => {
      mark(button.buttonEl, "recording-test");
      button.setButtonText(t("Test")).onClick(async () => {
        button.setDisabled(true);
        button.setButtonText(t("Testing…"));
        const view = buildServiceView(provider, needsKey);
        const result = await host.runProbe(`transcribe:${activeId}`, view, () => host.testRecording());
        new obsidian.Notice(result.ok ? t("Connected successfully ({0})").replace("{0}", result.detail) : `${t("Test failed:")}${result.detail}`, 8000);
        refresh.recording();
      });
    });
}

// ------------------------------------------------------------------ AI 整理卡片

function renderAiCard(el: HTMLElement, host: ApiTabHost, refresh: Refreshers): void {
  const settings = host.settings;
  const needsKey = !canOmitServiceApiKey(settings.llmEndpoint);
  const view = buildServiceView({ endpoint: settings.llmEndpoint, model: settings.llmModel, apiKey: settings.llmApiKey }, needsKey);
  renderCardHead(el, t("AI organizing service"), deriveSetupState(view, host.probeResults["llm:active"]));
  const body = el.createDiv({ cls: "qnalog-api-fields" });

  const activePreset = getLlmServicePreset(getActiveLlmServicePresetId(settings)) as
    { endpointHelp?: string; keyHelp?: string; modelHelp?: string; modelPlaceholder?: string } | null;
  const services = listLlmServices(settings);
  const currentId = currentLlmServiceId(settings);
  const currentService = services.find((service) => service.id === currentId);

  new obsidian.Setting(body)
    .setName(t("Service Preset"))
    .setDesc((currentService && currentService.hint) || t("Each service keeps its own service URL, access key and model. Switching restores what you used last with that service; a service you have not used yet starts with its defaults and an empty key."))
    .addDropdown((dropdown) => {
      mark(dropdown.selectEl, "ai-service");
      for (const service of services) dropdown.addOption(service.id, service.label);
      dropdown.setValue(currentId).onChange(async (id) => {
        const update = switchLlmService(settings, id);
        if (!update) return;
        Object.assign(settings, update);
        await host.saveSettings();
        const picked = listLlmServices(settings).find((service) => service.id === id);
        new obsidian.Notice(`${t("Applied service preset:")}${picked ? picked.label : id}${t(". Confirm the access key and model ID, then test the connection.")}`, 6000);
        refresh.ai();
      });
    });
  if (currentService && currentService.hint) {
    body.createDiv({
      cls: "qnalog-settings-hint",
      text: t("Each service keeps its own service URL, access key and model. Switching restores what you used last with that service; a service you have not used yet starts with its defaults and an empty key."),
    });
  }

  const syncProfile = (): void => syncWorkingConfigToLlmProfile(settings, settings.activeLlmProfile);

  const keyRow = addTextRow(body, {
    name: t("Access Key"),
    desc: activePreset && activePreset.keyHelp
      ? t(activePreset.keyHelp)
      : t("Enter the API Key provided by the provider or relay service. Can be left empty for local localhost LLM services."),
    value: settings.llmApiKey,
    password: true,
    onChange: async (value) => {
      settings.llmApiKey = value;
      syncProfile();
      await host.saveSettings();
    },
  });
  const providers = settings.transcribeProviders || {};
  const siliconflowKey = (providers.siliconflow || {}).apiKey || "";
  const mimoKey = (providers.apimimo || {}).apiKey || "";
  const endpointNow = settings.llmEndpoint || "";
  if (siliconflowKey && !settings.llmApiKey && /siliconflow\.cn/i.test(endpointNow)) {
    keyRow.addButton((button) => button.setButtonText(t("Reuse transcription key")).onClick(async () => {
      settings.llmApiKey = siliconflowKey;
      await host.saveSettings();
      new obsidian.Notice(t("Reused the SiliconFlow transcription key for the LLM service."), 5000);
      refresh.ai();
    }));
  } else if (mimoKey && !settings.llmApiKey && /xiaomimimo\.com/i.test(endpointNow)) {
    keyRow.addButton((button) => button.setButtonText(t("Reuse MiMo transcription key")).onClick(async () => {
      settings.llmApiKey = mimoKey;
      await host.saveSettings();
      new obsidian.Notice(t("Reused the MiMo transcription key for the LLM service."), 5000);
      refresh.ai();
    }));
  }

  addTextRow(body, {
    name: t("Service URL"),
    desc: activePreset && activePreset.endpointHelp
      ? t(activePreset.endpointHelp)
      : t("Enter the LLM service endpoint (the \"OpenAI-compatible / Chat Completions\" URL). You can enter it up to /v1 or the root address and QnALog will complete it automatically; you can also enter the full /v1/chat/completions."),
    value: settings.llmEndpoint,
    onChange: async (value) => {
      settings.llmEndpoint = value;
      settings.llmServicePreset = inferLlmServicePresetId(settings);
      syncProfile();
      await host.saveSettings();
    },
  });

  const modelRow = new obsidian.Setting(body)
    .setName(t("Model ID"))
    .setDesc(activePreset && activePreset.modelHelp
      ? t(activePreset.modelHelp)
      : t("Enter the model name required by the service; for relay services such as Poe and OpenRouter, use the name shown in their console or model list."));
  modelRow.settingEl.addClass("qnalog-ai-model-setting");
  modelRow.addText((text) => {
    text.setPlaceholder(activePreset && activePreset.modelPlaceholder ? activePreset.modelPlaceholder : t("For example: the model ID shown in the provider's console"));
    text.setValue(settings.llmModel);
    text.onChange(async (value) => {
      settings.llmModel = value;
      syncProfile();
      await host.saveSettings();
    });
  });
  modelRow.addButton((button) => button.setButtonText(t("Get available models")).onClick(async () => {
    if (!settings.llmEndpoint) {
      new obsidian.Notice(t("Please fill in the service endpoint first"), 4000);
      return;
    }
    button.setDisabled(true);
    button.setButtonText(t("Fetching…"));
    try {
      const models = await fetchLlmModelList(settings.llmEndpoint, settings.llmApiKey);
      if (!models.length) {
        new obsidian.Notice(t("The service did not return a model list. Please enter the model ID manually."), 6000);
        return;
      }
      host.pickModel(`${t("Select a model ( ")}${models.length}${t(")")}`, models, async (id) => {
        settings.llmModel = id;
        syncProfile();
        await host.saveSettings();
        new obsidian.Notice(`${t("Selected model:")}${id}`, 4000);
        refresh.ai();
      });
    } catch (error) {
      new obsidian.Notice(`${t("Failed to get the model list:")}${errorText(error)}${t(". You can enter the model ID manually.")}`, 8000);
    } finally {
      button.setDisabled(false);
      button.setButtonText(t("Get available models"));
    }
  }));

  new obsidian.Setting(body)
    .setName(t("LLM Connectivity Test"))
    .setDesc(t("Sends a very short text request to verify that the service URL, access key, and model name match; it does not upload recordings, transcripts, or prompts."))
    .addButton((button) => {
      mark(button.buttonEl, "ai-test");
      button.setButtonText(t("Test connection")).onClick(async () => {
        button.setDisabled(true);
        button.setButtonText(t("Testing…"));
        const testView = buildServiceView({ endpoint: settings.llmEndpoint, model: settings.llmModel, apiKey: settings.llmApiKey }, !canOmitServiceApiKey(settings.llmEndpoint));
        const result = await host.runProbe("llm:active", testView, async () => {
          const r = await host.testLlm();
          return `${r.model || t("Unnamed model")}${t("(returned:")}${r.preview || t("<empty>")}${t(")")}`;
        });
        new obsidian.Notice(result.ok ? t("LLM connected successfully: {0}").replace("{0}", result.detail) : `${t("LLM test failed: ")}${result.detail}`, 8000);
        refresh.ai();
      });
    });
}

// ------------------------------------------------------------------ 进阶：导入音频的说话人识别

function renderSubhead(parent: HTMLElement, title: string, desc: string): void {
  const el = parent.createDiv({ cls: "qnalog-settings-subhead" });
  el.createDiv({ cls: "qnalog-settings-subhead-title", text: title });
  if (desc) el.createDiv({ cls: "qnalog-settings-subhead-desc", text: desc });
}

function renderImportBlock(el: HTMLElement, host: ApiTabHost, refresh: Refreshers): void {
  const settings = host.settings;
  renderSubhead(
    el,
    t("Speaker recognition for imported audio"),
    t("Importing a whole audio file uses a separate service for transcription and speaker identification, and does not take part in live recording segmentation."),
  );

  const providers = settings.transcribeProviders || {};
  const supportedIds = Object.keys(providers).filter((id) =>
    isImportCapableTranscribeProvider(host.getProfile(id, providers[id] || {}), providers[id] || {}));
  // 已选服务不可用时只在内存里借用第一个可用项来画界面，设置保持用户原值，并说明后果。
  const savedId = settings.importTranscribeProvider;
  const savedIsUsable = supportedIds.includes(savedId);
  const activeId = savedIsUsable ? savedId : (supportedIds[0] || "dashscope-filetrans");
  const provider = providers[activeId] || {};
  const profile = host.getProfile(activeId, provider);
  const needsKey = !!profile.requiresKey && !canOmitServiceApiKey(provider.endpoint);

  if (!savedIsUsable) {
    const savedLabel = savedId
      ? (t((providers[savedId] || {}).name || "") || savedId)
      : t("(Not set)");
    const box = el.createEl("details", { cls: "qnalog-risk-notice" });
    box.createEl("summary", { cls: "qnalog-risk-title", text: t("Import service unavailable") });
    box.createDiv({
      cls: "qnalog-risk-body",
      text: `${t("The import service you selected \"")}${savedLabel}${t("\" is currently unavailable (it was deleted, or its protocol does not support whole-file transcription).")}`
        + t("The alternatives shown below are available, but your setting was not changed — importing audio will still use the one you originally selected and fail.")
        + t("Please select a service again above. If you really want to keep using the original one, change its protocol back to one that supports whole-file transcription, then try again."),
    });
  }

  const fields = el.createDiv({ cls: "qnalog-api-fields" });
  const writeProvider = async (key: keyof TranscribeProviderSettings, value: string): Promise<void> => {
    if (!settings.transcribeProviders[activeId]) settings.transcribeProviders[activeId] = {};
    settings.transcribeProviders[activeId][key] = value;
    await host.saveSettings();
  };

  new obsidian.Setting(fields)
    .setName(t("Transcription Service"))
    .setDesc(t("Used only for imported audio; it does not affect live recording."))
    .addDropdown((dropdown) => {
      mark(dropdown.selectEl, "import-service");
      for (const id of supportedIds) {
        const item = providers[id] || {};
        dropdown.addOption(id, host.getProfile(id, item).title || t(item.name || "") || id);
      }
      dropdown.setValue(activeId).onChange(async (value) => {
        settings.importTranscribeProvider = value;
        await host.saveSettings();
        refresh.importAudio();
      });
    });

  renderGuide(fields, host, `import:${activeId}`, profile, provider, needsKey);

  addTextRow(fields, {
    name: needsKey ? t("API key") : t("API key (optional)"),
    desc: t(profile.keyHelp || "") || t("Enter the access key for this service."),
    value: provider.apiKey || "",
    password: true,
    onChange: (value) => writeProvider("apiKey", value),
  });
  addTextRow(fields, {
    name: t("Service URL"),
    desc: t(profile.endpointHelp || "") || t("Transcription endpoint for imported audio."),
    value: provider.endpoint || "",
    placeholder: profile.endpointPlaceholder || "",
    onChange: (value) => writeProvider("endpoint", value.trim()),
  });

  new obsidian.Setting(fields)
    .setName(t("Model Name"))
    .setDesc(t(profile.modelHelp || "") || t("Enter a long-audio transcription model supported by the service."))
    .addText((text) => {
      if (profile.modelPlaceholder) text.setPlaceholder(profile.modelPlaceholder);
      text.setValue(provider.model || "").onChange((value) => writeProvider("model", value.trim()));
    })
    .addButton((button) => button.setButtonText(t("Get models")).onClick(async () => {
      button.setDisabled(true);
      button.setButtonText(t("Fetching…"));
      try {
        const models = await host.fetchImportModels(activeId);
        if (!models.length) {
          new obsidian.Notice(t("The service returned no usable models. Enter the model name manually."), 6000);
          return;
        }
        host.pickModel(`${t("Select the audio import model ( ")}${models.length}${t(")")}`, models, async (model) => {
          await writeProvider("model", model);
          new obsidian.Notice(`${t("Selected model:")}${model}`, 4000);
          refresh.importAudio();
        });
      } catch (error) {
        new obsidian.Notice(`${t("Failed to get models:")}${errorText(error)}`, 8000);
      } finally {
        button.setDisabled(false);
        button.setButtonText(t("Get models"));
      }
    }));

  new obsidian.Setting(fields)
    .setName(t("Connection Test"))
    .setDesc(t("Verifies that the service URL, access key, and model are available; it does not upload recording content."))
    .addButton((button) => {
      mark(button.buttonEl, "import-test");
      button.setButtonText(t("Test connection")).onClick(async () => {
        button.setDisabled(true);
        button.setButtonText(t("Testing…"));
        const view = buildServiceView(provider, needsKey);
        const result = await host.runProbe(`import:${activeId}`, view, async () => {
          const r = await host.testImport(activeId);
          return `${r.model} · ${r.detail}`;
        });
        new obsidian.Notice(result.ok ? `${t("Connection OK: ")}${result.detail}` : `${t("Connection failed:")}${result.detail}`, 9000);
        refresh.importAudio();
      });
    });

  if (!profile.hideLanguage) {
    addTextRow(fields, {
      name: t("Recognition Language"),
      desc: t(profile.languageHelp || "") || t("Leave blank or auto to detect automatically."),
      value: provider.language || "",
      placeholder: profile.languagePlaceholder || "",
      onChange: (value) => writeProvider("language", value.trim()),
    });
  }

  new obsidian.Setting(fields)
    .setName(t("Distinguish Speakers"))
    .setDesc(t("After transcription completes, confirm the names for \"Speaker 1, 2, 3\" before moving on to AI organizing."))
    .addToggle((toggle) => toggle
      .setValue(settings.importSpeakerDiarization !== false)
      .onChange(async (value) => {
        settings.importSpeakerDiarization = value;
        await host.saveSettings();
        refresh.importAudio();
      }));

  if (settings.importSpeakerDiarization !== false) {
    new obsidian.Setting(fields)
      .setName(t("Number of Speakers"))
      .setDesc(t("Leave empty to detect automatically; if you know the number of speakers, filling it in improves speaker separation consistency."))
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "2";
        text.inputEl.max = "100";
        text.inputEl.step = "1";
        text.setPlaceholder(t("Auto"));
        text.setValue(settings.importSpeakerCount > 0 ? String(settings.importSpeakerCount) : "");
        text.onChange(async (value) => {
          const number = Math.floor(Number(value) || 0);
          settings.importSpeakerCount = number >= 2 ? Math.min(100, number) : 0;
          await host.saveSettings();
        });
      });
  }
}

// ------------------------------------------------------------------ 进阶：已保存的方案

function renderSavedProfiles(el: HTMLElement, host: ApiTabHost, refresh: Refreshers): void {
  const settings = host.settings;
  const profiles = Array.isArray(settings.llmProfiles) ? settings.llmProfiles : [];
  if (!profiles.length) return;
  renderSubhead(
    el,
    t("Saved configurations"),
    t("Each service now remembers its own settings, so you no longer need to save a configuration. Configurations you saved earlier are kept here."),
  );
  const fields = el.createDiv({ cls: "qnalog-api-fields" });
  for (const profile of profiles) {
    const isActive = settings.activeLlmProfile === profile.id;
    const kind = profile.asr ? t("Transcription and AI briefing") : t("AI briefing only (legacy)");
    new obsidian.Setting(fields)
      .setName(profile.name)
      .setDesc(isActive ? `${kind} · ${t("In use")}` : kind)
      .addButton((button) => {
        mark(button.buttonEl, `profile-use:${profile.id}`);
        button.setButtonText(t("Use this configuration")).onClick(async () => {
          applyLlmProfileToWorkingConfig(settings, profile.id);
          await host.saveSettings();
          const applied = findLlmProfile(settings, profile.id);
          new obsidian.Notice(
            t("Switched to configuration \"{0}\"{1}")
              .replace("{0}", applied ? applied.name : profile.id)
              .replace("{1}", applied && applied.asr ? t(" (transcription and AI briefing)") : t(" (AI briefing only)")),
            5000,
          );
          // 方案同时带转写与整理配置，两张卡和导入区块都可能变化。
          refresh.recording();
          refresh.ai();
          refresh.importAudio();
          refresh.saved();
        });
      })
      .addExtraButton((button) => {
        button.setIcon("trash-2").setTooltip(t("Delete this configuration")).onClick(async () => {
          settings.llmProfiles = normalizeLlmProfiles(settings.llmProfiles).filter((item: { id: string }) => item.id !== profile.id);
          if (settings.activeLlmProfile === profile.id) settings.activeLlmProfile = "";
          await host.saveSettings();
          new obsidian.Notice(`${t("Deleted configuration \"")}${profile.name}${t("\". The current service settings are kept.")}`, 6000);
          refresh.saved();
        });
      });
  }
}

// ------------------------------------------------------------------ 入口

export function renderApiTab(parent: HTMLElement, host: ApiTabHost): void {
  parent.createDiv({
    cls: "qnalog-settings-hint",
    text: t("Choose a service for each step and enter its key. Use Test on each card to check that it works."),
  });
  host.renderRiskNotice(parent);

  const refreshers: Refreshers = {
    recording: () => recordingCard.refresh(),
    ai: () => aiCard.refresh(),
    importAudio: () => importBlock.refresh(),
    saved: () => savedBlock.refresh(),
  };

  const recordingCard = createBlock(parent, "qnalog-api-card qnalog-api-card-recording", (el) => renderRecordingCard(el, host, refreshers));
  const aiCard = createBlock(parent, "qnalog-api-card qnalog-api-card-ai", (el) => renderAiCard(el, host, refreshers));

  const advanced = parent.createEl("details", { cls: "qnalog-settings-section qnalog-api-advanced" });
  advanced.open = host.uiState.advancedOpen;
  advanced.addEventListener("toggle", () => { host.uiState.advancedOpen = !!advanced.open; });
  const summary = advanced.createEl("summary", { cls: "qnalog-settings-section-summary" });
  summary.createSpan({ cls: "qnalog-settings-section-title", text: t("Advanced settings") });
  summary.createDiv({
    cls: "qnalog-settings-section-desc",
    text: t("Speaker recognition for imported audio and saved configurations."),
  });
  const advancedBody = advanced.createDiv({ cls: "qnalog-settings-section-body" });
  const importBlock = createBlock(advancedBody, "qnalog-api-block", (el) => renderImportBlock(el, host, refreshers));
  const savedBlock = createBlock(advancedBody, "qnalog-api-block", (el) => renderSavedProfiles(el, host, refreshers));
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of untyped-helper region */
