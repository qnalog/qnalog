/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// @ts-nocheck — PluginSettingTab class（this.plugin.* / 大量 setting builder 无 TS 字段声明）；已用 tsc 确认无漏引用(TS2304=0)，余者皆类字段类型噪音，故与 main.ts 同档跳过。
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。
import * as obsidian from "obsidian";
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { assertEndpointAllowed, canOmitServiceApiKey, isLocalLlmEndpoint, isSharedAddressSpaceEndpoint } from '../shared/util-llm-endpoint';
import { isLocalServiceEndpoint } from '../shared/util-note';
import { compareVersions, isMobileRuntime } from '../shared/util-platform';
import { getEffectivePolishMode, getModeDisplayName, getModeMeta, getVisibleModeEntries } from '../shared/mode-meta';
import { renderApiTab } from "./settings-api-tab";
import { UI_LANGUAGES, getActiveUiLanguage, t } from '../shared/i18n';
import { getActiveLlmServicePresetId, getLlmServicePreset } from '../llm/config';
import { currentLlmServiceLabel, currentRecordingServiceLabel, defaultQuickSetupProviderId, listQuickSetupProviders } from "../setup/service-catalog";
import { testLlmConnection } from '../llm/core';
import { isDashScopeFlashNoWordsError } from "../asr/dashscope-flash-asr";
import { normalizeAsrConcurrency, resolveTranscribeProvider, transcribeAudio } from '../asr/transcribe';
import { countVocabularyGroups, parseVocabularyGroups, summarizeVocabularyGroups } from '../vocabulary';
import { openVocabularyFile as openVocabularyFileAction } from "../vocabulary/open-vocabulary-file";
import { hasPeopleHotwordsConsent, loadPeopleDirectory, normalizePeopleContextMode, normalizePeopleSuggestionCache, normalizePeopleSuggestionIgnores } from '../people';
import { QNALOG_UPDATE_REPO_URL, countKnowledgeExtractionHistory, enumerateAudioDevices, openExternalUrl, openPickListModal, pluginBasePath, resolveUpdateRawBases, qnalogConfirm, trashVaultFileRef } from './helpers';
import { audioInputModeLabel, classifyAudioInputDevices, describeAudioDeviceAvailability, isVirtualCableLabel, normalizeAudioInputMode, pickComputerAudioDevices } from '../audio/audio-input';
import { PeopleHotwordsConsentModal, PromptTemplateModal, QueueModal, VirtualCableSetupModal } from './modals';
import { createStreamingTranscriptionClient } from '../notes/recording-issues';
import {
  MAX_SPEAKER_CHANNELS,
  buildMicrophoneAudioConstraints,
  configureMicrophoneTrackChannels,
  normalizeAudioChannelMode,
} from '../audio/channel-speakers';
import { analyzeRecordedAudioChannels } from '../asr/channel-transcription';
import { isSpeakerDiarizationProvider } from '../asr/diarization';
import { fetchImportTranscribeModels, testImportTranscribeProvider } from '../asr/long-audio-transcription';
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
} from '../setup';
import { isQuickSetupVisible, quickSetupNeedsConfirm, resolveScrollTop } from '../setup/settings-view-state';

function pickChannelProbeMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((mime) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) || "";
}

async function recordChannelProbe(stream, durationMs = 5000) {
  if (typeof MediaRecorder === "undefined") throw new Error(t("Recording file detection is not supported in the current environment"));
  const mimeType = pickChannelProbeMime();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks = [];
  return new Promise((resolve, reject) => {
    let timer = 0;
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = (event) => {
      if (timer) window.clearTimeout(timer);
      reject(event.error instanceof Error ? event.error : new Error(t("Recording sampling failed")));
    };
    recorder.onstop = () => {
      if (timer) window.clearTimeout(timer);
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
      if (!blob.size) reject(new Error(t("The recording sample is empty. Please make sure the microphone is receiving input.")));
      else resolve(blob);
    };
    recorder.start(250);
    timer = window.setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, Math.max(2000, Number(durationMs) || 5000));
  });
}

function renderChannelProbeRows(container, rows) {
  container.empty();
  for (const row of rows) {
    const line = container.createDiv({ cls: `qnalog-audio-channel-result-row ${row.state ? `is-${row.state}` : ""}` });
    line.createSpan({ cls: "qnalog-audio-channel-result-label", text: row.label });
    line.createSpan({ cls: "qnalog-audio-channel-result-value", text: row.value });
  }
}

export const QNALOG_SETTINGS_TABS = [
  { id: "home",     label: "QnALog" },
  { id: "recording", label: "Recording" },
  { id: "api",      label: "API" },
  { id: "ai",       label: "AI Briefing" },
  { id: "knowledge", label: "Knowledge" },
  { id: "inbox",     label: "Auto Import" },
  { id: "about",    label: "About" },
];

export class QnALogSettingTab extends obsidian.PluginSettingTab {
  /** 当前选中的设置标签页；openSettings 可指定要切到的标签。 */
  declare activeTab: string;
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.activeTab = "home";
    // 最近一次检测结果，按服务标识索引；只存在内存里，不落盘。
    // 界面据此区分「未测试」与「已通过 / 未通过」。
    this._probeResults = Object.create(null);
    // 快速配置卡片的显示由每次渲染按当前配置判定（isQuickSetupVisible）。
    // 两个标志只存在内存里：用户确认「快速配置」后强制显示；点卡片 × 后隐藏到再次打开。
    this._quickSetupOpenedByUser = false;
    this._quickSetupDismissed = false;
    // 上一次渲染时卡片是否可见，供「快速配置」按钮决定要不要先确认。
    this._quickSetupShown = false;
    // 上次渲染的标签页，用于重画后保持界面位置。
    this._lastRenderedTab = null;
    this._audioDeviceInfo = null;
  }
  getVisibleSettingsTabs() {
    // 标签在调用时翻译，不在模块加载时：语言可以在「关于」里随时改，
    // 若在常量定义处翻译，改完语言标签不会跟着变。
    return QNALOG_SETTINGS_TABS.map((tab) => ({ id: tab.id, label: t(tab.label) }));
  }
  display() {
    this._lastRenderedTab = null;
    this.renderSettings();
    void this.refreshAudioDeviceInfo();
  }

  /**
   * 读出音频设备并重画一次。
   *
   * 不申请权限（见 enumerateAudioDevices 的说明）：打开设置页就弹麦克风授权框，
   * 用户会以为插件在录音。因此先拿无授权的设备列表——很多系统此时已能给出设备名，
   * 拿不到就如实说没授权，由用户点「检测设备」。
   */
  async refreshAudioDeviceInfo() {
    try {
      this._audioDeviceInfo = await enumerateAudioDevices();
    } catch {
      this._audioDeviceInfo = null;
    }
    if (this.activeTab === "home") this.renderSettings();
  }

  /** 设置页实际滚动的元素：containerEl 自身或向上第一个可纵向滚动的祖先。 */
  findSettingsScroller() {
    let el = this.containerEl;
    while (el) {
      const overflowY = typeof getComputedStyle === "function" ? getComputedStyle(el).overflowY : "";
      if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return this.containerEl;
  }

  renderSettings() {
    // 重画前记下滚动位置：empty() 之后内容变短，浏览器会把位置夹到顶部。
    const scroller = this.findSettingsScroller();
    const previousScrollTop = scroller ? scroller.scrollTop : 0;
    this.containerEl.addClass("qnalog-settings-root");
    this.containerEl.empty();

    const tabs = this.getVisibleSettingsTabs();
    const tabShell = this.containerEl.createDiv({ cls: "qnalog-settings-tabs-shell" });
    const tabBar = tabShell.createDiv({ cls: "qnalog-settings-tabs" });
    for (const tab of tabs) {
      const btn = tabBar.createEl("button", { text: tab.label });
      if (this.activeTab === tab.id) btn.addClass("is-active");
      btn.onclick = () => this.handleSettingsTabClick(tab.id);
    }

    const content = this.containerEl.createDiv({ cls: "qnalog-settings-content" });
    // 移动端运行时强制单列堆叠（手机设置面板有时宽于 760px CSS px，纯靠 @media 会漏）。
    content.toggleClass("is-mobile", isMobileRuntime());
    switch (this.activeTab) {
      case "home":     this.renderHome(content); break;
      case "recording": this.renderRecording(content); break;
      case "api":      this.renderApi(content); break;
      case "ai":       this.renderAI(content); break;
      case "knowledge": this.renderKnowledge(content); break;
      case "inbox":     this.renderImport(content); break;
      case "about":     this.renderAbout(content); break;
    }
    this.applySettingsSections(content);
    const nextScrollTop = resolveScrollTop(this._lastRenderedTab, this.activeTab, previousScrollTop);
    this._lastRenderedTab = this.activeTab;
    if (scroller) scroller.scrollTop = nextScrollTop;
  }

  applySettingsSections(content) {
    if (!content || this.activeTab === "home") return;
    const children = Array.from(content.children || []);
    const headings = children.filter((el) => el && el.classList && el.classList.contains("setting-item-heading"));
    if (!headings.length) return;
    if (!this._settingsSectionOpen) this._settingsSectionOpen = Object.create(null);

    let sectionIndex = 0;
    for (const heading of headings) {
      if (!heading.parentElement || heading.parentElement !== content) continue;
      const titleEl = heading.querySelector(".setting-item-name");
      const descEl = heading.querySelector(".setting-item-description");
      const title = ((titleEl && titleEl.textContent) || heading.textContent || "").trim();
      if (!title) continue;

      const sectionKey = `${this.activeTab}:${sectionIndex}:${title}`;
      const details = content.createEl("details", { cls: "qnalog-settings-section" });
      if (Object.prototype.hasOwnProperty.call(this._settingsSectionOpen, sectionKey)) {
        details.open = !!this._settingsSectionOpen[sectionKey];
      } else {
        details.open = sectionIndex === 0;
        this._settingsSectionOpen[sectionKey] = details.open;
      }
      details.addEventListener("toggle", () => {
        this._settingsSectionOpen[sectionKey] = !!details.open;
      });

      const summary = details.createEl("summary", { cls: "qnalog-settings-section-summary" });
      summary.createSpan({ cls: "qnalog-settings-section-title", text: title });

      const descText = descEl ? String(descEl.textContent || "").trim() : "";
      const next = heading.nextElementSibling;
      const isHint = next && next.classList && (
        next.classList.contains("qnalog-settings-hint") ||
        next.classList.contains("qnalog-section-hint")
      );
      const hintText = isHint ? String(next.textContent || "").trim() : "";
      const summaryDesc = descText || hintText;
      if (summaryDesc) summary.createDiv({ cls: "qnalog-settings-section-desc", text: summaryDesc });

      const body = details.createDiv({ cls: "qnalog-settings-section-body" });
      content.insertBefore(details, heading);
      heading.remove();
      if (isHint) next.remove();

      let node = details.nextElementSibling;
      while (node && !(node.classList && node.classList.contains("setting-item-heading"))) {
        const current = node;
        node = node.nextElementSibling;
        body.appendChild(current);
      }
      for (const item of Array.from(body.children || [])) {
        if (!item.classList || !item.classList.contains("setting-item")) continue;
        const control = item.querySelector(".setting-item-control");
        if (!control || control.children.length === 0) item.classList.add("is-info-only");
      }
      sectionIndex++;
    }
  }

  createSettingsSubhead(parent, title, desc) {
    const el = parent.createDiv({ cls: "qnalog-settings-subhead" });
    el.createDiv({ cls: "qnalog-settings-subhead-title", text: title });
    if (desc) el.createDiv({ cls: "qnalog-settings-subhead-desc", text: desc });
    return el;
  }

  handleSettingsTabClick(tabId) {
    this.activeTab = tabId;
    this.renderSettings();
  }


  renderDataRiskNotice(parent, variant = "") {
    const cls = ["qnalog-risk-notice", variant].filter(Boolean).join(" ");
    const box = parent.createEl("details", { cls });
    box.createEl("summary", { cls: "qnalog-risk-title", text: t("Where your data is sent") });
    box.createDiv({
      cls: "qnalog-risk-body",
      text: t("QnALog has no cloud storage of its own and does not upload recordings to a QnALog server; recordings are saved in the local Obsidian vault path you choose. During transcription and AI organizing, the audio, transcript text, and prompts are sent to the currently configured cloud API or local model. For sensitive content, use local transcription and a local LLM, and avoid processing confidential, private, customer, medical, legal, or HR information through a cloud API."),
    });
  }

  // 快速配置：组合服务会同时更新转写和 AI 整理；整文件 ASR 只用于导入音频。
  // 字段范围由 src/setup 的 PRESET_WRITTEN_FIELDS 约束，这里只负责落盘。
  async applyOneCardProvider(id, key, options = {}) {
    const plan = planPresetApplication(this.plugin.settings, {
      providerId: id,
      apiKey: String(key || "").trim(),
      llmEndpoint: options.llmEndpoint || options.endpoint || "",
      asrModel: options.asrModel || "",
      llmModel: options.llmModel || options.model || "",
    });
    if (!plan.ok) {
      if (plan.reason) new obsidian.Notice(plan.reason, 4000);
      return false;
    }
    // 就地写入，不替换 settings 对象：域服务持有的是同一个引用，
    // 换对象会让它们继续读旧值。
    Object.assign(this.plugin.settings, applyPresetPlan(this.plugin.settings, plan));
    await this.plugin.saveSettings();
    return true;
  }

  async autoConfigureAudioInput() {
    if (isMobileRuntime()) {
      this.plugin.settings.selectedVirtualDevice = "";
      this.plugin.settings.captureMode = "mic";
      await this.plugin.saveSettings();
      new obsidian.Notice(t("Mobile is already recording from the microphone. Configure computer audio and virtual audio device capture on desktop."), 7000);
      return;
    }
    const info = await enumerateAudioDevices({ requestPermission: true });
    const virtual = info.virtualCables && info.virtualCables[0];
    const hasMic = info.mics && info.mics.length > 0;
    if (virtual) {
      this.plugin.settings.selectedVirtualDevice = virtual.deviceId;
      this.plugin.settings.captureMode = hasMic ? "mix-virtual" : "virtualCable";
      await this.plugin.saveSettings();
      new obsidian.Notice(`${t("Selected:")}${audioInputModeLabel(this.plugin.settings.captureMode)}${t("(computer audio:")}${virtual.label || t("virtual audio device")}${t("). Confirm the device you speak into in the \"Microphone\" dropdown above.")}`, 8000);
      return;
    }
    this.plugin.settings.selectedVirtualDevice = "";
    this.plugin.settings.captureMode = "mic";
    await this.plugin.saveSettings();
    const msg = info.permissionRequired
      ? t("Audio permission was not granted or no computer audio input was detected; kept \"Microphone only\". To record the Bilibili client, browser video, or system sound, grant permission and configure a virtual audio device first.")
      : t("No computer audio input detected; kept \"Microphone only\". To record the Bilibili client, browser video, or system sound, configure a virtual audio device first.");
    new obsidian.Notice(msg, 7000);
  }

  // 已移除 chooseRealMicrophone：插件不再"按名字自动挑一只真实麦克风"。
  // 麦克风选择完全交给用户（设置里的下拉），没选则用系统默认。

  /** 转写与 AI 整理两项服务当前的四态（首页与「快速配置」按钮共用）。 */
  computeServiceStates() {
    const transcribeState = (() => {
      const id = this.plugin.settings.activeTranscribeProvider || "siliconflow";
      const p = (this.plugin.settings.transcribeProviders || {})[id] || {};
      // 从 provider profile 取 requiresKey，避免硬编码与 profile 不一致
      const profile = this.getTranscribeProviderProfile(id, p);
      const needsKey = !!profile.requiresKey && !canOmitServiceApiKey(p.endpoint);
      return deriveSetupState(
        buildServiceView(p, needsKey),
        this._probeResults[`transcribe:${id}`],
      );
    })();
    const llmState = deriveSetupState(
      buildServiceView({
        endpoint: this.plugin.settings.llmEndpoint,
        model: this.plugin.settings.llmModel,
        apiKey: this.plugin.settings.llmApiKey,
      }, !canOmitServiceApiKey(this.plugin.settings.llmEndpoint)),
      this._probeResults["llm:active"],
    );
    return { transcribeState, llmState };
  }

  renderHome(c) {
    const page = c.createDiv({ cls: "qnalog-home" });
    let statusList;
    const jump = (tab, stage) => {
      this.activeTab = tab;
      // 说话人识别已移入 API 页的「进阶设置」（默认折叠）：跳过去时先展开它。
      if (tab === "api" && stage === "speaker") {
        if (!this._apiTabUiState) this._apiTabUiState = { advancedOpen: false, guideOpen: Object.create(null) };
        this._apiTabUiState.advancedOpen = true;
      }
      this.renderSettings();
      if (tab !== "api" || stage !== "llm") return;
      const modelRow = this.containerEl.querySelector(".qnalog-ai-model-setting");
      if (!modelRow) return;
      const section = modelRow.closest("details.qnalog-settings-section");
      if (section) section.open = true;
      modelRow.scrollIntoView({ block: "center" });
    };
    // 三处服务的状态都按「缺配置 / 未测试 / 已通过 / 未通过」四态呈现，
    // 而不是只看字段在不在：字段填了但没测过，与测过并通过是两回事。
    const { transcribeState, llmState } = this.computeServiceStates();

    const head = page.createDiv({ cls: "qnalog-home-head" });
    const titleLine = head.createDiv({ cls: "qnalog-home-title-line" });
    titleLine.createEl("h2", { text: "QnALog" });
    const versionEl = titleLine.createDiv({ cls: "qnalog-home-version", text: this.plugin.getDisplayVersion() });
    const buildSource = this.plugin.getBuildSourceLabel();
    if (buildSource) {
      versionEl.addClass("is-dev");
      versionEl.setAttr("title", buildSource);
    }
    head.createDiv({
      cls: "qnalog-home-summary",
      text: t("Record, transcribe, and organize into Markdown notes. Default services, models, and parameters are preset — add an API key when you are ready."),
    });
    // 首页三个动作：配置向导 = 分步引导新用户（也可从这里重开）；快速配置 = 已了解
    // 流程的用户直接换密钥；打开侧边栏 = 开始用。仍然不加「配置服务」「AI 整理设置」
    // 两条跳转——四个以上按钮无法判断该点哪个，细节调整都在各自页面里。
    const primary = head.createDiv({ cls: "qnalog-home-actions" });
    const wizardBtn = primary.createEl("button", { text: t("Setup Wizard") });
    // 主按钮用 Obsidian 强调色（即 qnalog 全局主色 --qnalog-primary-action），
    // 只给向导一个：两个强调色按钮并排会互相抵消识别度。
    wizardBtn.addClass("mod-cta");
    wizardBtn.onclick = () => this.plugin.openSetupWizard();
    const quickBtn = primary.createEl("button", { text: t("Quick config") });
    quickBtn.onclick = () => { void this.startQuickSetup(); };
    const panelBtn = primary.createEl("button", { text: t("Open sidebar") });
    panelBtn.onclick = () => this.plugin.shell.openOutlineView();

    // 快速配置面板：一把阿里云百炼 API Key 配好三段服务（录音转写 / 音频导入 / AI 整理）。
    // 地址与模型全部内置，用户不需要看到、也不需要选择它们。
    //
    // 面板只在两种情况下出现：① 还没配好（缺转写或 AI 整理）；② 用户点了「快速配置」并确认覆盖。
    // 已经配好的用户不该在首页看到一块要他重新填密钥的面板。
    this._quickSetupShown = isQuickSetupVisible({
      transcribeState,
      llmState,
      openedByUser: this._quickSetupOpenedByUser,
      dismissed: this._quickSetupDismissed,
    });
    if (this._quickSetupShown) {
    const oneCard = page.createDiv({ cls: "qnalog-home-block qnalog-home-onecard" });
    const closeBtn = oneCard.createEl("button", {
      cls: "qnalog-icon-button qnalog-onecard-close",
      attr: { type: "button", "aria-label": t("Close"), title: t("Close") },
    });
    obsidian.setIcon(closeBtn, "x");
    closeBtn.onclick = () => {
      this._quickSetupDismissed = true;
      this._quickSetupOpenedByUser = false;
      this.renderSettings();
    };
    oneCard.createEl("h3", { text: t("Quick setup") });
    oneCard.createDiv({
      cls: "qnalog-home-prep-desc",
      text: t("Pick a provider and enter its API key. Recording transcription and AI briefing are configured together; endpoints and models are preset."),
    });

    // 选服务商，而不是固定某一家。决定因素是「你所在网络能不能连上」，
    // 与界面语言无关——英文用户在中国大陆、中文用户在海外都很常见。
    // 默认项按界面语言给一个常见答案，但用户随时可以在下拉里改。
    let oneCardProvider = defaultQuickSetupProviderId(getActiveUiLanguage().id);
    let oneCardKey = "";
    const providerRow = new obsidian.Setting(oneCard).setName(t("Provider"));
    providerRow.setDesc(t("Enter the API key for this provider. QnALog stores keys through Obsidian SecretStorage, not in its plugin settings file."));
    providerRow.addDropdown(d => {
      for (const provider of listQuickSetupProviders()) {
        d.addOption(provider.id, provider.label);
      }
      d.setValue(oneCardProvider).onChange(v => { oneCardProvider = v; });
    });

    const oneCardRow = new obsidian.Setting(oneCard).setName(t("API key"));
    oneCardRow.addText(tc => {
      tc.inputEl.type = "password";
      tc.setPlaceholder("sk-…");
      tc.onChange(v => { oneCardKey = v.trim(); });
    });
    oneCardRow.addButton(b => b.setButtonText(t("Save and enable")).setCta().onClick(async () => {
      if (!oneCardKey) { new obsidian.Notice(t("Enter an API key first"), 4000); return; }
      b.setDisabled(true);
      b.setButtonText(t("Checking…"));
      // 先检测候选配置，通过后才写入：避免把一把无效密钥当成配置落盘。
      const plan = planPresetApplication(this.plugin.settings, { providerId: oneCardProvider, apiKey: oneCardKey });
      if (!plan.ok) {
        b.setDisabled(false);
        b.setButtonText(t("Save and enable"));
        new obsidian.Notice(plan.reason, 5000);
        return;
      }
      const candidate = applyPresetPlan(this.plugin.settings, plan);
      const host = buildProbeHost(this.plugin, candidate);
      try {
        const report = await runPresetDetection(host, plan, this.probePorts());
        new obsidian.Notice(formatDetectionReport(report), 10000);
        if (!report.ok) {
          // 检测未全部通过时不落盘：让用户先看到哪一段有问题。
          b.setDisabled(false);
          b.setButtonText(t("Save and enable"));
          return;
        }
        Object.assign(this.plugin.settings, candidate);
        await this.plugin.saveSettings();
        new obsidian.Notice(t("Setup complete. You can start recording."), 8000);
        this.renderSettings();
      } catch (error) {
        new obsidian.Notice(t("Check failed: {0}").replace("{0}", (error && error.message) || error), 8000);
        b.setDisabled(false);
        b.setButtonText(t("Save and enable"));
      }
    }));
    oneCardRow.addButton(b => b.setButtonText(t("Check only")).onClick(async () => {
      if (!oneCardKey) { new obsidian.Notice(t("Enter an API key first"), 4000); return; }
      b.setDisabled(true);
      b.setButtonText(t("Checking…"));
      try {
        const plan = planPresetApplication(this.plugin.settings, { providerId: oneCardProvider, apiKey: oneCardKey });
        if (!plan.ok) { new obsidian.Notice(plan.reason, 5000); return; }
        const host = buildProbeHost(this.plugin, applyPresetPlan(this.plugin.settings, plan));
        const report = await runPresetDetection(host, plan, this.probePorts());
        new obsidian.Notice(formatDetectionReport(report), 10000);
      } catch (error) {
        new obsidian.Notice(t("Check failed: {0}").replace("{0}", (error && error.message) || error), 8000);
      } finally {
        b.setDisabled(false);
        b.setButtonText(t("Check only"));
      }
    }));
    oneCard.createDiv({
      cls: "qnalog-home-prep-desc",
      text: t("Other services (SiliconFlow, Groq, OpenRouter, local models) can be configured individually on the API tab. This path only compresses first-time setup into one step."),
    });
    }

    // 「使用状态」：只回答两件事——现在能不能开始用；如果能，当前会用什么服务。
    // 因此分两层：上面一句话结论（一级信息），下面四行当前配置摘要（结论的依据）。
    // 原先这里是「使用准备」四张卡，把「需要用户准备的」与「纯粹的偏好开关」混在一起，
    // 而且不显示实际在用的服务；模型 ID 反而因为卡片面积成了最大内容，
    // 把二级技术信息放到了与结论同等的视觉权重上。
    const speakerProviderId = this.plugin.settings.importTranscribeProvider || "";
    const speakerProvider = (this.plugin.settings.transcribeProviders || {})[speakerProviderId] || {};
    const speakerProfile = speakerProviderId
      ? this.getTranscribeProviderProfile(speakerProviderId, speakerProvider)
      : null;
    const transcribeProviderId = this.plugin.settings.activeTranscribeProvider || "siliconflow";
    const transcribeProvider = (this.plugin.settings.transcribeProviders || {})[transcribeProviderId] || {};
    const transcribeProfile = this.getTranscribeProviderProfile(transcribeProviderId, transcribeProvider);
    // 各服务「缺什么」，与四态判定用的是同一份口径（§10.3）。
    const transcribeServiceIssue = setupServiceIssue(buildServiceView(transcribeProvider, !!transcribeProfile.requiresKey && !canOmitServiceApiKey(transcribeProvider.endpoint)));
    const llmServiceIssue = setupServiceIssue(buildServiceView({
      endpoint: this.plugin.settings.llmEndpoint,
      model: this.plugin.settings.llmModel,
      apiKey: this.plugin.settings.llmApiKey,
    }, !canOmitServiceApiKey(this.plugin.settings.llmEndpoint)));
    // 说话人识别是一个真实开关（settings.importSpeakerDiarization），先回答「开没开」，
    // 再回答「用什么实现」。关掉时不该显示一个空模型名。
    const speakerEnabled = this.plugin.settings.importSpeakerDiarization !== false;
    const speakerCapable = speakerProfile ? isSpeakerDiarizationProvider(speakerProvider, speakerProfile) : false;
    const speakerIssue = !speakerProviderId
      ? t("No audio import service selected")
      : !speakerCapable
        ? t("The current import audio service does not perform speaker recognition")
        : setupServiceIssue(buildServiceView(speakerProvider, !!speakerProfile.requiresKey && !canOmitServiceApiKey(speakerProvider.endpoint)));

    const status = buildSetupStatus({
      speakerEnabled,
      transcribe: {
        value: transcribeServiceIssue || currentRecordingServiceLabel(this.plugin.settings),
        detail: transcribeServiceIssue ? "" : (transcribeProvider.model || ""),
        issue: transcribeServiceIssue,
      },
      llm: {
        value: llmServiceIssue || this.getLlmServiceLabel(),
        detail: llmServiceIssue ? "" : (this.plugin.settings.llmModel || ""),
        issue: llmServiceIssue,
      },
      speaker: (() => {
        // 用户主动关闭不算问题（那是他的选择）。开启后才谈可用性：
        // 服务做不到、或该服务还缺密钥，都如实写在一级内容里，
        // 不能一边写「已启用」一边给个告警色——那两件事互相打脸。
        if (!speakerEnabled) return { value: t("Disabled") };
        if (!speakerCapable) return { value: t("Not supported by the current service"), issue: t("The current import audio service does not perform speaker recognition") };
        if (speakerIssue) return { value: speakerIssue, issue: speakerIssue };
        return { value: t("Enabled"), detail: speakerProvider.model || "" };
      })(),
      audio: this.describeAudioInputStatus(),
    });

    const statusBlock = page.createDiv({ cls: "qnalog-home-block" });
    statusBlock.createEl("h3", { text: t("Status") });
    // 结论区。正常时不放圆点/徽章：四个单项已经各自说明了状况，
    // 总结再挂一个同样的绿点只是重复；有徽章时它也该靠右，不参与左对齐扫读。
    const statusHead = statusBlock.createDiv({ cls: "qnalog-status-head" });
    const statusHeadMain = statusHead.createDiv({ cls: "qnalog-status-head-main" });
    statusHeadMain.createDiv({ cls: "qnalog-status-headline", text: status.headline });
    statusHeadMain.createDiv({ cls: "qnalog-status-detail", text: status.detail });
    if (!status.ready) {
      const badge = statusHead.createDiv({ cls: "qnalog-status-badge is-warn" });
      badge.createSpan({ cls: "qnalog-status-badge-icon", text: "!" });
      badge.createSpan({ text: `${t("Still missing ")}${status.blockerCount}${t(" items")}` });
    }
    statusList = statusBlock.createDiv({ cls: "qnalog-status-list" });
    for (const line of status.lines) {
      this.buildStatusRow(statusList, line, jump);
    }
    // 设备名要授权才读得到。首页不主动弹授权框、不点亮麦克风指示灯，
    // 因此把这一步交给用户：需要看真实设备名时点这个按钮。
    if (!this._audioDeviceInfo || this._audioDeviceInfo.permissionRequired) {
      const detectRow = new obsidian.Setting(statusBlock);
      detectRow.setDesc(t("\"Audio input\" needs microphone permission to read device names. Click the button to read them once; recording will not start."));
      detectRow.addButton((btn) => btn.setButtonText(t("Detect devices")).onClick(async (evt) => {
        const button = evt && evt.currentTarget;
        if (button) { button.disabled = true; button.setText(t("Checking…")); }
        try {
          this._audioDeviceInfo = await enumerateAudioDevices({ requestPermission: true });
        } catch (error) {
          new obsidian.Notice(`${t("Device detection failed:")}${(error && error.message) || error}`, 6000);
        }
        if (button) { button.disabled = false; button.setText(t("Detect devices")); }
        this.renderSettings();
      }));
    }

    const footer = page.createDiv({ cls: "qnalog-home-footnote" });
    footer.setText(t("Costs: the QnALog plugin itself is free. Cloud transcription and LLM services bill per usage on their own platforms; local models incur no platform fees but you install, run, and maintain them yourself."));
  }

  /**
   * 当前 AI 整理用的是哪家服务。
   *
   * 用 getActiveLlmServicePresetId 而不是直接读 llmServicePreset：用户可能在
   * 设置页改过接口地址，此时预设 id 还是旧的，直接读会报出一个并非在用的服务名。
   * 认得出预设时用 API 页选择器里的同一个名称；认不出就报出接口主机名，不凭空编造。
   */
  getLlmServiceLabel() {
    const id = getActiveLlmServicePresetId(this.plugin.settings);
    if (id && getLlmServicePreset(id)) return currentLlmServiceLabel(this.plugin.settings);
    try {
      return new URL(String(this.plugin.settings.llmEndpoint || "")).host;
    } catch {
      return t("Custom service");
    }
  }

  /**
   * 音频输入的真实状态。
   *
   * 「仅麦克风」是配置值，不是状态——它回答不了「麦克风现在能不能用」。
   * 这里只调 enumerateDevices（不触发 getUserMedia），因此不会弹出授权框、
   * 也不会点亮系统麦克风指示灯。未授权时设备名为空，如实说明并给出手动检测按钮，
   * 不替用户偷偷申请权限。
   */
  /**
   * 把浏览器给的设备名收敛成用户读得懂的短名。
   *
   * `enumerateDevices()` 的 label 是系统/浏览器原始字符串，形如
   * "Default - MacBook Pro Microphone"、"MacBook Pro麦克风 (Built-in)"、"默认 - 麦克风 (Realtek)"：
   * 直接搬到首页既是调试态，也中英混杂。这里只做去前缀与去括注，不改写设备本身的名字；
   * 认不出模式的原样返回，宁可显示长一点，也不猜成一个不准确的短名。
   */
  friendlyDeviceName(rawLabel) {
    let name = String(rawLabel || "").trim();
    if (!name) return name;
    // 去掉系统默认前缀（中英文、不同分隔符写法）
    name = name.replace(/^(?:default|默认)\s*[-–—:]\s*/i, "");
    // "Default - MacBook Pro Microphone" 只剩首尾空白时退回原名
    if (!name) return String(rawLabel || "").trim();
    return name;
  }

  describeAudioInputStatus() {
    const mode = normalizeAudioInputMode(this.plugin.settings.captureMode || "mic");
    const micId = String(this.plugin.settings.selectedMicrophoneDevice || "");
    // 次级行不再重复模式名（「音频输入」这一行已经表达了输入来源），
    // 只说这是系统默认还是用户指定的设备。
    const modeText = micId ? t("Device specified") : t("System default");
    const vcId = String(this.plugin.settings.selectedVirtualDevice || "");
    const needsVirtual = mode === "virtualCable" || mode === "mix-virtual";

    const info = this._audioDeviceInfo;
    if (!info) {
      // 还没读到设备列表（或读取失败）。这只说明「不知道」，不说明「没有设备」。
      return { value: t("Reading devices…"), detail: modeText };
    }
    const inputs = (info.all || []).filter((d) => d && d.kind === "audioinput");
    const find = (id) => (id ? inputs.find((d) => d.deviceId === id) : null);
    const nameOf = (dev) => (dev && dev.label) || "";

    // 枚举得到设备就算可用，与名字读不读得到无关——未授权时 deviceId 仍在，
    // 设备也确实存在。把「名字为空」当成「设备不可用」会误报。
    if (!inputs.length) {
      return {
        value: t("No audio input device detected"),
        detail: modeText,
        failure: t("No audio input device detected"),
      };
    }

    const micDev = find(micId);
    const vcDev = find(vcId);
    // 显式选定的设备不在了：这是真问题，不能悄悄退回默认设备。
    // 已确认不可用属于错误级（×），比「还没选」更严重：用户以为配好了，实际录不了。
    if (micId && !micDev) {
      return { value: t("The selected microphone is unavailable"), detail: modeText, failure: t("The selected microphone is unavailable") };
    }
    if (vcId && !vcDev) {
      return { value: t("The selected computer audio device is unavailable"), detail: modeText, failure: t("The selected computer audio device is unavailable") };
    }
    if (needsVirtual && !vcId) {
      return { value: t("No computer audio device selected yet"), detail: modeText, issue: t("No computer audio device selected yet") };
    }

    // 未显式选麦克风时，浏览器给的「默认」设备名更能说明现在会录到哪一只；
    // 没有这一项就退回列表里第一只有名字的。
    const defaultDev = inputs.find((d) => d.deviceId === "default") || inputs.find((d) => !!d.label) || null;
    const micName = this.friendlyDeviceName(nameOf(micDev) || nameOf(defaultDev));
    const vcName = this.friendlyDeviceName(nameOf(vcDev));

    if (mode === "virtualCable") {
      if (!vcName) return { value: t("Computer audio device selected; name shown after permission is granted"), detail: `${modeText}${t(" · Click \"Detect devices\" to show the device name")}` };
      return { value: `${vcName}${t(" · available")}`, detail: modeText };
    }
    if (mode === "mix-virtual") {
      if (!micName || !vcName) return { value: t("Device selected; name shown after permission is granted"), detail: `${modeText}${t(" · Click \"Detect devices\" to show the device name")}` };
      return { value: `${micName} + ${vcName}${t(" · available")}`, detail: modeText };
    }
    // 仅麦克风模式。
    // 判据是「有没有设备名」，不是「所选设备的名字在不在」——未显式选择时，
    // 所选设备本来就是空，拿它去判断会误报成「需要授权」，而设备名其实读得到。
    if (!micName) {
      return {
        value: `${t("System default microphone · available (")}${inputs.length}${t(" audio input devices)")}`,
        detail: `${modeText}${t(" · Click \"Detect devices\" to show the device name")}`,
      };
    }
    return { value: `${micName}${t(" · available")}`, detail: modeText };
  }

  /**
   * 一行配置摘要：名称 / 一级内容 / 次级模型名，整行可点进对应设置页。
   *
   * 正常时不显示状态图标——一排相同标记等于没有信息量，
   * 只有真正需要处理的那行才挂 `!`（缺配置）或 `×`（已确认不可用）。
   * 用原生 div 而不是 obsidian.Setting：Setting 行是为「标题 + 描述 + 控件」设计的，
   * 塞不进「三行文字 + 右侧箭头 + 整行可点」这套结构。
   */
  buildStatusRow(parent, line, jump) {
    const row = parent.createDiv({ cls: "qnalog-status-row" });
    if (line.icon) row.addClass(line.icon === "×" ? "is-fail" : "is-warn");
    const text = row.createDiv({ cls: "qnalog-status-row-text" });
    const head = text.createDiv({ cls: "qnalog-status-row-head" });
    if (line.icon) {
      head.createSpan({ cls: "qnalog-status-row-icon", text: line.icon });
    }
    head.createDiv({ cls: "qnalog-status-row-label", text: line.label });
    if (line.target) {
      row.addClass("is-clickable");
      row.setAttr("role", "button");
      row.setAttr("tabindex", "0");
      row.setAttr("aria-label", t("{0}: {1}, open the corresponding settings").replace("{0}", line.label).replace("{1}", line.value));
      row.onclick = () => jump(line.target, line.stage);
      row.onkeydown = (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); jump(line.target, line.stage); }
      };
      // 箭头只是「这一行能点」的提示，整行都是点击目标，所以它保持低存在感。
      row.createSpan({ cls: "qnalog-status-row-go", text: "›" });
    }
    text.createDiv({ cls: "qnalog-status-row-value", text: line.value });
    if (line.detail) text.createDiv({ cls: "qnalog-status-row-detail", text: line.detail });
    return row;
  }

  createAudioInputButton(parent, text, onClick, cls = "") {
    const btn = parent.createEl("button", { text, cls: ["qnalog-audio-input-btn", cls].filter(Boolean).join(" ") });
    btn.onclick = onClick;
    return btn;
  }

  async populateAudioInputMicSelect(selectEl, hintEl) {
    while (selectEl.firstChild) selectEl.removeChild(selectEl.firstChild);
    const selected = this.plugin.settings.selectedMicrophoneDevice || "";
    // 用 optgroup 分组。分组只表达「这是哪一类设备」，不替用户判断该选哪只：
    // 真实麦克风与虚拟声卡都完整列出，虚拟的加一行说明，
    // 而**不**把虚拟设备从麦克风下拉里删掉——用户可能就是想用虚拟声卡录人声，
    // 也可能自己的实体麦克风名字里带 "SoundWire" 之类关键词，过滤会把真麦克风弄丢。
    const addGroup = (label) => selectEl.createEl("optgroup", { attr: { label } });
    const addOption = (parent, value, text) => parent.createEl("option", { value, text });
    // 空值 = 跟随系统默认，不是「未选择」。未选时录音会用系统默认输入设备。
    const defaultGroup = addGroup(t("Defaults"));
    addOption(defaultGroup, "", t("System default input device"));

    if (isMobileRuntime()) {
      selectEl.value = "";
      selectEl.disabled = true;
      hintEl.setText(t("Mobile uses the system microphone; configure computer audio and virtual audio devices on desktop."));
      return;
    }

    let info;
    try {
      // 下拉要显示设备名才能选，未授权时全是空名，所以这里申请权限是用户预期的。
      info = await enumerateAudioDevices({ requestPermission: true });
    } catch {
      selectEl.disabled = true;
      selectEl.value = "";
      hintEl.setText(t("Could not read the device list. Grant microphone permission, then use “Detect devices”."));
      return;
    }

    const groups = classifyAudioInputDevices(info.all, selected);
    const availability = describeAudioDeviceAvailability(info.all);

    if (availability.state === "none") {
      selectEl.disabled = false;
      selectEl.value = "";
      hintEl.setText(t("No audio input device found. Check that your microphone is connected and that the system grants permission."));
      return;
    }

    const realGroup = addGroup(t("Microphone"));
    const virtualGroup = addGroup(t("Virtual audio device / Computer audio"));
    let micCount = 0;
    let virtualCount = 0;
    for (const dev of groups.dongles) {
      const label = dev.label || t("Not authorized to read device names");
      const isVirtual = isVirtualCableLabel(dev.label);
      addOption(isVirtual ? virtualGroup : realGroup, dev.deviceId, label);
      if (isVirtual) virtualCount++; else micCount++;
    }
    // 系统默认那一项（deviceId === "default"）在「默认」组里已用空值代表，不再重复列出。
    // 若上面按名字把设备分完，某一组可能是空的，把空组去掉，免得多一个空标题。
    if (!micCount && realGroup.parentElement) realGroup.remove();
    if (!virtualCount && virtualGroup.parentElement) virtualGroup.remove();

    // 显式选定的设备不在任何一组里（例如名字读不到、或刚被拔掉）：
    // 单独列出来并说明，让用户看到「已选的是哪个」，而不是悄悄跳回默认。
    const selectedListed = groups.dongles.some((d) => d.deviceId === selected);
    if (selected && !selectedListed) {
      const staleGroup = addGroup(t("Current selection"));
      addOption(staleGroup, selected, groups.selectedInput
        ? `${groups.selectedInput.label || t("Not authorized to read device names")}${t("(selected)")}`
        : t("The currently selected device was not detected (it may be disconnected)"));
    }

    selectEl.disabled = false;
    selectEl.value = selected || "";

    if (availability.state === "unnamed") {
      hintEl.setText(`${t("Detected ")}${availability.count}${t(" audio input devices, but the device names require microphone permission to be displayed; you can still choose in the order shown in the dropdown.")}`);
    } else if (selected && !selectedListed) {
      hintEl.setText(t("The selected microphone is disconnected. Choose another."));
    } else if (selected) {
      hintEl.setText(t("Use this device for recording."));
    } else {
      hintEl.setText(t("Uses the system default input. When recording speech, choosing a microphone explicitly is recommended."));
    }
  }

  async populateAudioInputVirtualSelect(selectEl, hintEl) {
    while (selectEl.firstChild) selectEl.removeChild(selectEl.firstChild);
    const selected = this.plugin.settings.selectedVirtualDevice || "";
    const addOption = (value, text) => selectEl.createEl("option", { value, text });
    // 电脑音频**不做自动选择**：判定哪只是虚拟声卡靠设备名关键词，判错就录到错误内容，
    // 而用户从界面上看不出来。因此一律留空让用户手动选，下拉里标出推荐项供参考。
    addOption("", t("— Select computer audio input —"));

    if (isMobileRuntime()) {
      selectEl.value = "";
      selectEl.disabled = true;
      hintEl.setText(t("Mobile does not support computer-audio capture; configure a virtual audio device on desktop."));
      return;
    }

    let info;
    try {
      // 下拉要显示设备名才能选，未授权时全是空名，所以这里申请权限是用户预期的。
      info = await enumerateAudioDevices({ requestPermission: true });
    } catch {
      selectEl.disabled = true;
      selectEl.value = "";
      hintEl.setText(t("Could not read the device list. Grant microphone permission, then choose a device."));
      return;
    }

    const groups = classifyAudioInputDevices(info.all, selected);
    const availability = describeAudioDeviceAvailability(info.all);
    if (availability.state === "none") {
      selectEl.disabled = false;
      selectEl.value = "";
      hintEl.setText(t("No audio input device found. Install a virtual audio device first."));
      return;
    }

    let hasSelected = false;
    // 电脑音频要的是虚拟声卡输入，因此：
    //   有虚拟声卡时只列虚拟声卡，普通麦克风不铺进来占位置；
    //   一个虚拟声卡都认不出时列出全部输入设备，否则万一用户的虚拟声卡名字不在
    //   关键词表里，列表就空了、他反而没得选。
    const picked = pickComputerAudioDevices(info.all);
    const ordered = picked.listed;
    const virtualDevs = picked.virtualCables;
    for (const dev of ordered) {
      const suffix = isVirtualCableLabel(dev.label) ? t("(recommended · virtual audio device)") : "";
      addOption(dev.deviceId, (dev.label || t("Not authorized to read device names")) + suffix);
      if (dev.deviceId === selected) hasSelected = true;
    }
    if (selected && !hasSelected) addOption(selected, t("Currently selected device not detected"));

    selectEl.disabled = false;
    selectEl.value = selected || "";

    if (selected && !hasSelected) {
      hintEl.setText(t("The selected computer-audio device may be disconnected. Choose another."));
    } else if (availability.state === "unnamed") {
      hintEl.setText(`${t("Detected ")}${availability.count}${t(" audio input devices, but the device names require microphone permission to be displayed; grant permission first, then reopen this page.")}`);
    } else if (groups.dongles.length === 0) {
      hintEl.setText(t("No computer-audio input found. Set up a virtual audio device first."));
    } else if (!virtualDevs.length) {
      hintEl.setText(t("No virtual audio device recognized, so all input devices are listed. Pick the one that carries computer audio."));
    } else if (selected) {
      hintEl.setText(t("Sound played on the computer will be recorded from this input."));
    } else {
      hintEl.setText(t("Pick the virtual audio device that captures computer audio (usually CABLE Output, BlackHole, and similar)."));
    }
  }

  renderAudioInputSettings(c) {
    const mode = normalizeAudioInputMode(this.plugin.settings.captureMode || "mic");
    const card = c.createDiv({ cls: "qnalog-audio-input-card" });

    const head = card.createDiv({ cls: "qnalog-audio-input-head" });
    const actions = head.createDiv({ cls: "qnalog-audio-input-actions" });
    this.createAudioInputButton(actions, t("Auto setup"), async () => {
      await this.autoConfigureAudioInput();
      this.renderSettings();
    });
    this.createAudioInputButton(actions, t("Test device"), async () => {
      await this.runAudioDiagnostic();
    });
    this.createAudioInputButton(actions, t("Set up computer audio"), () => new VirtualCableSetupModal(this.app, this.plugin).open());

    const grid = card.createDiv({ cls: "qnalog-audio-input-grid" });

    const modeField = grid.createDiv({ cls: "qnalog-audio-input-field" });
    modeField.createDiv({ cls: "qnalog-audio-input-label", text: t("Recording source") });
    const modeSelect = modeField.createEl("select", { cls: "dropdown qnalog-audio-input-select" });
    modeSelect.createEl("option", { value: "mic", text: t("Microphone only") });
    modeSelect.createEl("option", { value: "mix-virtual", text: t("Microphone + computer audio") });
    modeSelect.createEl("option", { value: "virtualCable", text: t("Computer audio only") });
    modeSelect.value = mode;
    modeSelect.addEventListener("change", async () => {
      this.plugin.settings.captureMode = normalizeAudioInputMode(modeSelect.value);
      await this.plugin.saveSettings();
      this.renderSettings();
    });
    const modeHint = modeField.createDiv({ cls: "qnalog-audio-input-hint" });
    modeHint.setText(mode === "mic"
      ? t("Record the selected microphone.")
      : mode === "virtualCable"
        ? t("Record audio played by the computer.") : t("Record microphone and computer audio at the same time."));

    // 麦克风选择器：仅麦克风 / 混合模式下显示（仅电脑音频模式不需要麦克风）
    if (mode === "mic" || mode === "mix-virtual") {
      const micField = grid.createDiv({ cls: "qnalog-audio-input-field" });
      micField.createDiv({ cls: "qnalog-audio-input-label", text: t("Microphone") });
      const micSelect = micField.createEl("select", { cls: "dropdown qnalog-audio-input-select" });
      const micHint = micField.createDiv({ cls: "qnalog-audio-input-hint" });
      micSelect.addEventListener("change", async () => {
        if (micSelect.value === "__error") return;
        this.plugin.settings.selectedMicrophoneDevice = micSelect.value;
        await this.plugin.saveSettings();
        await this.populateAudioInputMicSelect(micSelect, micHint);
        new obsidian.Notice(micSelect.value ? t("Microphone selection saved") : t("Choose a microphone"));
      });
      void this.populateAudioInputMicSelect(micSelect, micHint);
    }

    if (mode === "mic" && !isMobileRuntime()) {
      const channelField = grid.createDiv({ cls: "qnalog-audio-input-field qnalog-audio-channel-field" });
      const titleRow = channelField.createDiv({ cls: "qnalog-audio-channel-title-row" });
      titleRow.createDiv({ cls: "qnalog-audio-input-label", text: t("Speaker separation") });
      const titleActions = titleRow.createDiv({ cls: "qnalog-audio-channel-title-actions" });
      const channelModeSelect = titleActions.createEl("select", {
        cls: "dropdown qnalog-audio-channel-mode",
        attr: { "aria-label": t("Speaker separation method") },
      });
      channelModeSelect.createEl("option", { value: "auto", text: t("Auto (recommended)") });
      channelModeSelect.createEl("option", { value: "mono", text: t("Close") });
      channelModeSelect.createEl("option", { value: "multichannel", text: t("Split by channel") });
      channelModeSelect.value = normalizeAudioChannelMode(this.plugin.settings.audioChannelMode);
      channelModeSelect.addEventListener("change", async () => {
        this.plugin.settings.audioChannelMode = normalizeAudioChannelMode(channelModeSelect.value);
        await this.plugin.saveSettings();
        this.renderSettings();
      });
      const detectButton = titleActions.createEl("button", {
        cls: "qnalog-audio-channel-detect",
        text: t("Test"),
        attr: { type: "button" },
      });
      const channelHint = channelField.createDiv({ cls: "qnalog-audio-input-hint qnalog-audio-channel-hint" });
      const selectedChannelMode = normalizeAudioChannelMode(this.plugin.settings.audioChannelMode);
      channelHint.setText(selectedChannelMode === "mono"
        ? t("All recordings are treated as a single speaker.")
        : selectedChannelMode === "multichannel"
          ? t("Attempts to distinguish speakers by separate channels; mono recordings fall back automatically.")
          : t("Only distinguish speakers when the recording is confirmed to contain multiple independent channels."));
      const channelResult = channelField.createDiv({ cls: "qnalog-audio-channel-result" });
      detectButton.onclick = async () => {
        detectButton.disabled = true;
        detectButton.setText(t("Testing…"));
        renderChannelProbeRows(channelResult, [
          { label: t("Test"), value: t("Please speak into each microphone in turn"), state: "running" },
        ]);
        let stream = null;
        try {
          const selected = String(this.plugin.settings.selectedMicrophoneDevice || "").trim();
          const audio = buildMicrophoneAudioConstraints({
            deviceId: selected,
            channelMode: selectedChannelMode,
            targetChannels: MAX_SPEAKER_CHANNELS,
          });
          stream = await navigator.mediaDevices.getUserMedia({ audio });
          const info = await configureMicrophoneTrackChannels(
            stream.getAudioTracks()[0],
            selectedChannelMode,
            MAX_SPEAKER_CHANNELS,
          );
          const probeBlob = await recordChannelProbe(stream, 5000);
          const analysis = await analyzeRecordedAudioChannels(probeBlob);
          const activeChannels = analysis.channels
            .slice(0, MAX_SPEAKER_CHANNELS)
            .filter((item) => item.active)
            .map((item) => `${t("Channel ")}${item.channel}`);
          let contentStatus = t("Unconfirmed");
          let contentState = "warning";
          if (analysis.separation === "separated") {
            contentStatus = t("Separated");
            contentState = "success";
          } else if (analysis.separation === "duplicated") {
            contentStatus = t("Identical content");
            contentState = "warning";
          } else if (analysis.separation === "single") {
            contentStatus = t("Mono");
            contentState = "muted";
          }
          renderChannelProbeRows(channelResult, [
            { label: t("Input device"), value: `${info.channelCount}${t(" channels")}`, state: info.channelCount > 1 ? "success" : "muted" },
            { label: t("Test recording"), value: `${analysis.channelCount}${t(" channels")}`, state: analysis.channelCount > 1 ? "success" : "muted" },
            { label: t("Audio detected"), value: activeChannels.length ? activeChannels.join(t(", ")) : t("None"), state: activeChannels.length ? "success" : "warning" },
            { label: t("Speaker separation"), value: contentStatus, state: contentState },
          ]);
          if (analysis.separation === "separated") {
            channelHint.setText(t("Test passed. Each channel will be labelled Speaker 1, Speaker 2, and so on."));
            channelField.addClass("is-multichannel");
            channelField.removeClass("is-channel-warning");
          } else if (analysis.separation === "duplicated") {
            channelHint.setText(t("All channels carry identical content. Set the receiver output to “Stereo” and try again."));
            channelField.removeClass("is-multichannel");
            channelField.addClass("is-channel-warning");
          } else {
            channelHint.setText(analysis.channelCount > 1
              ? t("Could not confirm whether the channels are separated. Speak into each microphone separately and retry.")
              : t("The current recording is mono, so speakers cannot be separated by channel."));
            channelField.removeClass("is-multichannel");
            channelField.addClass("is-channel-warning");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          channelHint.setText(`${t("Test failed:")}${message}`);
          renderChannelProbeRows(channelResult, [
            { label: t("Detection result"), value: message, state: "error" },
          ]);
          channelField.removeClass("is-multichannel");
          channelField.addClass("is-channel-warning");
        } finally {
          if (stream) stream.getTracks().forEach((track) => track.stop());
          detectButton.disabled = false;
          detectButton.setText(t("Test"));
        }
      };
    }

    // 电脑音频选择器：仅电脑音频 / 混合模式下显示（原来藏在「设备检测」里，现在直接放到主卡片）
    if (mode === "virtualCable" || mode === "mix-virtual") {
      const vcField = grid.createDiv({ cls: "qnalog-audio-input-field" });
      vcField.createDiv({ cls: "qnalog-audio-input-label", text: t("Computer audio input") });
      const vcSelect = vcField.createEl("select", { cls: "dropdown qnalog-audio-input-select" });
      const vcHint = vcField.createDiv({ cls: "qnalog-audio-input-hint" });
      vcSelect.addEventListener("change", async () => {
        if (vcSelect.value === "__error") return;
        this.plugin.settings.selectedVirtualDevice = vcSelect.value;
        await this.plugin.saveSettings();
        await this.populateAudioInputVirtualSelect(vcSelect, vcHint);
        new obsidian.Notice(vcSelect.value ? t("Computer audio input saved") : t("Choose a computer audio input"));
      });
      void this.populateAudioInputVirtualSelect(vcSelect, vcHint);
    }

    this.diagResultEl = card.createDiv({ cls: "qnalog-diag-result qnalog-audio-input-diag" });
  }




  getTranscribeProviderProfile(id, provider) {
    return this.plugin.profiles.getTranscribeProviderProfile(id, provider);
  }

  // 用一段 1 秒静音音频走完整转写链路，验证当前转写服务连通性。返回识别文本（可能为空字符串），失败抛错。
  /**
   * 「快速配置」按钮：已配好时先确认是否覆盖，再显示面板。
   * 这样默认状态下面板不占位置，用户明确表示要重配时才出现。
   */
  async startQuickSetup() {
    // 卡片已显示：直接滚动过去。配置缺失时不弹「已配好」的确认，直接重新显示。
    if (this._quickSetupShown) {
      this.scrollToQuickSetup();
      return;
    }
    if (!quickSetupNeedsConfirm(this.computeServiceStates())) {
      this._quickSetupDismissed = false;
      this.renderSettings();
      this.scrollToQuickSetup();
      return;
    }
    const ok = await qnalogConfirm(
      this.app,
      t("Reconfigure services?"),
      t("You already have working transcription and AI organizing settings. Continuing opens the quick config panel,")
      + t("Replace the endpoints and models of these three services with a new Bailian API Key;")
      + t("Settings such as folders, prompts and recording devices will not be changed."),
      t("Continue setup"),
    );
    if (!ok) return;
    this._quickSetupOpenedByUser = true;
    this._quickSetupDismissed = false;
    this.renderSettings();
    this.scrollToQuickSetup();
  }

  scrollToQuickSetup() {
    const target = this.containerEl && typeof this.containerEl.find === "function"
      ? this.containerEl.find(".qnalog-home-onecard")
      : null;
    if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center" });
  }

  /** 四态 → 展示用的类名。缺配置与未通过都算「需要处理」，措辞由 SETUP_STATE_LABELS 区分。 */
  stateClass(state) {
    if (state === "success") return "is-ready";
    if (state === "missing" || state === "failure") return "is-required";
    return "is-neutral";
  }

  /**
   * 跑一次检测并记下结果，供首页四态显示使用。
   * 结果只存内存：它是「这次会话里测过没有」，不是用户配置，不落盘。
   * 返回 null 表示检测抛错（已记 failure 状态）。
   */
  async runAndRecordProbe(key, view, run) {
    const signature = configSignature(view);
    try {
      const detail = await run();
      this._probeResults[key] = { ok: true, detail: String(detail || ""), signature };
      return { ok: true, detail: String(detail || "") };
    } catch (error) {
      const detail = (error && error.message) || String(error);
      this._probeResults[key] = { ok: false, detail, signature };
      return { ok: false, detail };
    }
  }

  // 检测要调用的真实链路。只在这里列一次，避免各入口各写一份 ports。
  probePorts() {
    return {
      transcribe: async (h) => this.runAsrConnectivityTest(h),
      importTranscribe: async (h, providerId) => testImportTranscribeProvider(h, providerId),
      llm: async (h) => testLlmConnection(h),
    };
  }

  // host 省略时用插件自身（保存的配置）；检测候选配置时由调用方传入只读宿主。
  //
  // 按服务的**实际传输方式**分流：流式服务（百炼实时转写、OpenAI Realtime）走
  // WebSocket 握手，其余走 HTTP 上传。此前一律走 HTTP 路径，于是 wss:// 地址
  // 被按 http 规则校验、报「协议不受支持」——那是误报，且掩盖了真实连通性。
  async runAsrConnectivityTest(host) {
    const target = host || this.plugin;
    const providerId = target.settings.activeTranscribeProvider || "siliconflow";
    const profile = this.getTranscribeProviderProfile(providerId, (target.settings.transcribeProviders || {})[providerId] || {});
    if (profile && profile.transcribeMode === "streaming") {
      return await this.runStreamingConnectivityTest(target, providerId, profile);
    }
    const model = resolveTranscribeProvider(target, providerId).model;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const dest = ctx.createMediaStreamDestination();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.start();
      const rec = new MediaRecorder(dest.stream);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      await new Promise((resolve) => { rec.onstop = resolve; rec.start(); window.setTimeout(() => rec.stop(), 1000); });
      const blob = new Blob(chunks, { type: rec.mimeType });
      try {
        await transcribeAudio(target, blob, blob.type);
        return model;
      } catch (error) {
        if (providerId === "dashscope-flash" && isDashScopeFlashNoWordsError(error)) return model;
        throw error;
      }
    } finally {
      try { await ctx.close(); } catch { /* intentionally empty */ }
    }
  }

  /**
   * 流式服务的连通性检测：真的建一次 WebSocket 连接并通过鉴权（服务端在握手阶段校验密钥），
   * 成功后立即关闭。不发送音频，因此不产生识别计费。
   */
  async runStreamingConnectivityTest(target, providerId, profile) {
    const provider = (target.settings.transcribeProviders || {})[providerId] || {};
    assertEndpointAllowed(provider.endpoint, `${profile.title || providerId}${t(" Service URL")}`);
    if (!provider.apiKey && !canOmitServiceApiKey(provider.endpoint)) {
      throw new Error(`${profile.title || providerId}${t(" access key is not configured")}`);
    }
    if (!provider.model) throw new Error(`${profile.title || providerId}${t(" Model name is not configured")}`);
    const client = createStreamingTranscriptionClient(profile, provider, {
      onPartial: () => { /* 只验证握手，不接收文本 */ },
      onError: () => { /* 结束后可能收到关闭事件，忽略 */ },
      onClosed: () => { /* 同上 */ },
    });
    await client.connect();
    // 握手（含鉴权）已通过即可判定连通；立刻结束，避免占用配额。
    try { await client.finish(); } catch { /* 关闭失败不影响连通结论 */ }
    return provider.model;
  }

  renderApi(c) {
    renderApiTab(c, this.buildApiTabHost());
  }

  /** API 标签所需的宿主能力；界面实现在 ./settings-api-tab（有类型检查）。 */
  buildApiTabHost() {
    const plugin = this.plugin;
    if (!this._apiTabUiState) this._apiTabUiState = { advancedOpen: false, guideOpen: Object.create(null) };
    return {
      pickModel: (title, items, onPick, describe) => openPickListModal(this.app, title, items, onPick, describe),
      get settings() { return plugin.settings; },
      saveSettings: () => plugin.saveSettings(),
      probeResults: this._probeResults,
      runProbe: (key, view, run) => this.runAndRecordProbe(key, view, run),
      testRecording: () => this.runAsrConnectivityTest(),
      testLlm: () => testLlmConnection(plugin),
      testImport: (providerId) => testImportTranscribeProvider(plugin, providerId),
      fetchImportModels: (providerId) => fetchImportTranscribeModels(plugin, providerId),
      getProfile: (id, provider) => this.getTranscribeProviderProfile(id, provider),
      renderRiskNotice: (parent) => this.renderDataRiskNotice(parent, "is-api"),
      uiState: this._apiTabUiState,
    };
  }


  renderAI(c) {
    if (!this.plugin.settings.industryProfile) this.plugin.settings.industryProfile = {};

    new obsidian.Setting(c)
      .setName(t("Note Generation"))
      .setDesc(t("Set the structure, level of detail, and reorganization preferences for notes. Meeting information and to-do attribution are added separately before each recording."))
      .setHeading();
    const structHint = c.createDiv({ cls: "setting-item-description qnalog-section-hint" });
    structHint.setText(t("Only the refined result is adjusted by default; the raw transcript is left untouched. Repolish preference applies only to derived versions created from the context menu."));

    new obsidian.Setting(c).setName(t("Structure Level"))
      .setDesc(t("Relaxed: mostly prose. Balanced: prose plus lists 1–2 levels deep (recommended). Strict: lists up to 3 levels deep, emphasizing arguments and evidence."))
      .addDropdown(d => d
        .addOption("loose", t("Relaxed (mainly prose)"))
        .addOption("balanced", t("Balanced (recommended)"))
        .addOption("strict", t("Rigorous (multi-level nesting)"))
        .setValue(this.plugin.settings.briefingStructureLevel || "balanced")
        .onChange(async v => {
          this.plugin.settings.briefingStructureLevel = v;
          await this.plugin.saveSettings();
        }));

    // 输入框与展开说明放进同一个设置项卡片里，不在卡片外另起一块。
    const repolishSetting = new obsidian.Setting(c).setName(t("Reorganization Preference Prompt"))
      .setDesc(t("Affects only the preference items under \"Generate derived version\" in the right-click menu. Preferences adjust the level of detail, structure, tone, and whether AI may add a moderate amount of its own points. What you enter here is an additional rule and does not overwrite the built-in prompt."));
    const repolishPromptTa = repolishSetting.infoEl.createEl("textarea", { cls: "qnalog-textarea" });
    repolishPromptTa.value = this.plugin.settings.repolishPreferencePromptAddendum || "";
    repolishPromptTa.placeholder = t("For example: with moderate expansion, when the source raises a concept, question, or clear disagreement, add a short AI-supplement callout for perspective; use ==highlight== for key concepts and <u>underline</u> for core judgments. Do not fabricate facts, data, or owners.");
    repolishPromptTa.rows = 4;
    repolishPromptTa.addEventListener("change", () => {
      this.plugin.settings.repolishPreferencePromptAddendum = repolishPromptTa.value.trim();
      void this.plugin.saveSettings();
    });
    const repolishPresetHint = repolishSetting.infoEl.createEl("details", { cls: "qnalog-setting-details" });
    repolishPresetHint.createEl("summary", { text: t("View the prompt direction for built-in preferences") });
    const presetText = [
      t("Style preference:"),
      t("- More detailed: expand the context, discussion process, examples, objections, risks and the basis for to-dos."),
      t("- More concise: compress repeated speech and low-information details, keeping conclusions, evidence, to-dos and risks."),
      t("- More structured: strengthen the heading hierarchy and organize by “conclusion → evidence → impact/to-dos”."),
      t("- More natural: reduce the templated feel and use coherent paragraphs to carry the discussion forward."),
      t("- Markdown enhancement: use ==highlight==, <u>underline</u> and a small number of AI-supplement callouts in moderation."),
      "",
      t("Processing method:"),
      t("- Stay faithful to the source: do not extrapolate on your own; only organize information that explicitly appears in the recording."),
      t("- Moderate expansion: AI-supplement callouts may be used to handle questions, conceptual background and heated disagreements, but they must be marked as AI supplements and must not fabricate facts."),
    ].join("\n");
    repolishPresetHint.createEl("pre", { text: presetText });

    new obsidian.Setting(c)
      .setName(t("Language & Translation"))
      .setDesc(t("Set the language of the notes after AI organizing. The raw transcript always keeps its original text."))
      .setHeading();
    const langHint = c.createDiv({ cls: "setting-item-description qnalog-section-hint" });
    langHint.setText(t("Suitable for multilingual meetings: output one language throughout, or keep key original text in parentheses."));

    new obsidian.Setting(c).setName(t("Language Strategy"))
      .setDesc(t("By default it follows the original text. When enabled, the LLM unifies the language while organizing the notes."))
      .addDropdown(d => d
        .addOption("off", t("Follow the original text (no translation)"))
        .addOption("translate", t("Unify to the target language"))
        .addOption("bilingual", t("Target language first, with key source text in parentheses"))
        .setValue(this.plugin.settings.briefingTranslationMode || "off")
        .onChange(async v => { this.plugin.settings.briefingTranslationMode = v; await this.plugin.saveSettings(); this.renderSettings(); }));

    if ((this.plugin.settings.briefingTranslationMode || "off") !== "off") {
      new obsidian.Setting(c).setName(t("Target Language"))
        .addDropdown(d => d
          .addOption("zh-CN", t("Chinese"))
          .addOption("en", "English")
          .addOption("ja", "日本語")
          .addOption("ko", "한국어")
          .addOption("custom", t("Custom"))
          .setValue(this.plugin.settings.briefingTargetLanguage || "zh-CN")
          .onChange(async v => { this.plugin.settings.briefingTargetLanguage = v; await this.plugin.saveSettings(); this.renderSettings(); }));

      if ((this.plugin.settings.briefingTargetLanguage || "zh-CN") === "custom") {
        new obsidian.Setting(c).setName(t("Custom Target Language"))
          .setDesc(t("For example: Traditional Chinese, Deutsch, Français."))
          .addText(t => t.setValue(this.plugin.settings.briefingCustomLanguage || "")
            .onChange(async v => { this.plugin.settings.briefingCustomLanguage = v.trim(); await this.plugin.saveSettings(); }));
      }

      new obsidian.Setting(c).setName(t("Preserve Proper Nouns in Original Form"))
        .setDesc(t("Names of people and companies, model names, code identifiers, English abbreviations, and the like keep their original spelling to avoid distortion after translation."))
        .addToggle(t => t.setValue(this.plugin.settings.briefingKeepOriginalTerms !== false)
          .onChange(async v => { this.plugin.settings.briefingKeepOriginalTerms = v; await this.plugin.saveSettings(); }));

      const langSetting = new obsidian.Setting(c).setName(t("Additional Language Requirements"));
      const langTa = langSetting.infoEl.createEl("textarea", { cls: "qnalog-textarea" });
      langTa.value = this.plugin.settings.briefingLanguageInstruction || "";
      langTa.placeholder = t("For example: keep Japanese speech in the original with a parenthetical gloss; keep English terms as-is; output in Traditional Chinese.");
      langTa.rows = 3;
      langTa.addEventListener("change", () => {
        this.plugin.settings.briefingLanguageInstruction = langTa.value.trim();
        void this.plugin.saveSettings();
      });
    }

    new obsidian.Setting(c)
      .setName(t("Note template"))
      .setDesc(t("Choose the default organizing template, and manage long-term reusable formats, industry rules, and output preferences."))
      .setHeading();
    const sceneHint = c.createDiv({ cls: "setting-item-description qnalog-section-hint" });
    sceneHint.setText(t("Built-in templates can be used as-is; custom templates appear in the selection lists for recording, import, and re-organize."));

    const currentMode = getEffectivePolishMode(this.plugin.settings, this.plugin.settings.polishMode, "meeting");
    const currentMeta = getModeMeta(this.plugin.settings, currentMode);
    new obsidian.Setting(c).setName(t("Default note template"))
      .setDesc(t(currentMeta.label || currentMeta.prefix) + t(". Recordings, imported audio, and re-organizing use this template by default; you can still switch temporarily for a specific action."))
      .addDropdown(d => {
        for (const [key] of getVisibleModeEntries(this.plugin.settings, false)) d.addOption(key, getModeDisplayName(this.plugin.settings, key));
        d.setValue(currentMode);
        d.onChange(async v => { this.plugin.settings.polishMode = v; await this.plugin.saveSettings(); this.renderSettings(); });
      })
      .addButton(b => b.setButtonText(t("Open prompt library")).setCta().onClick(() => {
        const modal = new PromptTemplateModal(this.app, this.plugin);
        const origClose = modal.onClose.bind(modal);
        modal.onClose = () => { origClose(); this.renderSettings(); };
        modal.open();
      }));

  }

  renderKnowledge(c) {
    if (!this.plugin.settings.industryProfile) this.plugin.settings.industryProfile = {};

    const countMarkdownInFolder = (folderPath) => {
      const folder = obsidian.normalizePath(folderPath || "");
      if (!folder) return 0;
      const prefix = folder.endsWith("/") ? folder : folder + "/";
      return this.plugin.app.vault.getMarkdownFiles()
        .filter(f => obsidian.normalizePath(f.path).startsWith(prefix))
        .length;
    };

    const createPathSetting = (parent, name, desc, value, placeholder, onSave, refreshDesc) => {
      const setting = new obsidian.Setting(parent).setName(name).setDesc(desc);
      setting.addText(t => t.setValue(value || "")
        .setPlaceholder(placeholder)
        .onChange(async v => {
          await onSave(obsidian.normalizePath(v || placeholder));
          await this.plugin.saveSettings();
          if (refreshDesc) await refreshDesc(setting);
        }));
      if (refreshDesc) refreshDesc(setting);
      return setting;
    };

    const refreshVocabStatus = async (setting) => {
      const path = this.plugin.settings.vocabularyFile;
      if (!path) { setting.setDesc(t("No path specified yet.")); return; }
      const norm = obsidian.normalizePath(path);
      const file = this.plugin.app.vault.getAbstractFileByPath(norm);
      if (!(file instanceof obsidian.TFile)) {
        setting.setDesc(t("The file does not exist; it is created automatically when opened or scanned."));
        return;
      }
      try {
        const content = await this.plugin.app.vault.cachedRead(file);
        const groups = parseVocabularyGroups(content);
        setting.setDesc(t("Currently {0} ASR hotwords ({1}).").replace("{0}", String(countVocabularyGroups(groups))).replace("{1}", summarizeVocabularyGroups(groups)));
      } catch (e) {
        setting.setDesc(t("Failed to read: {0}").replace("{0}", String(e.message || e)));
      }
    };

    let vocabPathSetting = null;
    const openVocabularyFile = async () => {
      await openVocabularyFileAction({
        vault: this.plugin.app.vault,
        workspace: this.plugin.app.workspace,
        getSettings: () => this.plugin.settings,
        notify: (message) => new obsidian.Notice(message),
        refreshStatus: () => vocabPathSetting ? refreshVocabStatus(vocabPathSetting) : undefined,
      });
    };

    const pendingPeopleSuggestions = normalizePeopleSuggestionCache(this.plugin.settings.peopleSuggestionCache).pending;
    const ignoredPeopleSuggestions = normalizePeopleSuggestionIgnores(this.plugin.settings.peopleSuggestionIgnores);
    const peopleCount = countMarkdownInFolder(this.plugin.settings.peopleDirectoryFolder || DEFAULT_SETTINGS.peopleDirectoryFolder);

    new obsidian.Setting(c)
      .setName(t("Resource library"))
      .setDesc(t("Extract people, to-dos, and transcription glossaries from notes for reuse and retrieval; notes keep the original evidence and recording links."))
      .setHeading();

    const overview = c.createDiv({ cls: "qnalog-object-overview-grid" });
    const makeObjectCard = (title, count, unit, desc, icon, actionLabel, onClick) => {
      const btn = overview.createEl("button", {
        cls: "qnalog-object-overview-card",
        attr: { type: "button", "aria-label": actionLabel, title: actionLabel },
      });
      const head = btn.createDiv({ cls: "qnalog-object-overview-head" });
      head.createDiv({ cls: "qnalog-object-overview-title", text: title });
      const countEl = head.createDiv({ cls: "qnalog-object-overview-count" });
      countEl.createSpan({ cls: "qnalog-object-overview-count-value", text: String(count) });
      countEl.createSpan({ cls: "qnalog-object-overview-count-unit", text: unit });
      btn.createDiv({ cls: "qnalog-object-overview-desc", text: desc });
      const iconEl = btn.createDiv({ cls: "qnalog-object-overview-icon", attr: { "aria-hidden": "true" } });
      obsidian.setIcon(iconEl, icon);
      btn.onclick = onClick;
      return btn;
    };
    makeObjectCard(t("Person"), peopleCount, t("people"), t("Summarize the people who appear in meetings, one page per person, linked to notes."), "contact", t("Open person library"), () => { void this.plugin.library.openPeopleBase(); });
    const vocabCard = makeObjectCard(t("Transcription term list"), "…", t(" file items"), t("Collect terms and error-prone spellings to improve transcription accuracy."), "notebook-tabs", t("Open transcription glossary"), () => { void openVocabularyFile(); });

    void (async () => {
      const countEl = vocabCard.querySelector(".qnalog-object-overview-count-value");
      try {
        const path = obsidian.normalizePath(this.plugin.settings.vocabularyFile || DEFAULT_SETTINGS.vocabularyFile);
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof obsidian.TFile)) { if (countEl) countEl.setText("0"); return; }
        const groups = parseVocabularyGroups(await this.plugin.app.vault.cachedRead(file));
        if (countEl) countEl.setText(String(countVocabularyGroups(groups)));
      } catch {
        if (countEl) countEl.setText("—");
      }
    })();

    new obsidian.Setting(c).setName(t("Automatically extract after transcription completes"))
      .setDesc(t("Off by default to save tokens. When enabled, finishing transcription/organizing automatically scans the current note and writes to-dos; people and glossaries still go through the confirmation/maintenance flow."))
      .addToggle(txt => txt.setValue(!!this.plugin.settings.sedimentAutoExtract).onChange(async v => { this.plugin.settings.sedimentAutoExtract = v; await this.plugin.saveSettings(); }));

    new obsidian.Setting(c)
      .setName(t("Completion and deduplication"))
      .setDesc(t("Extract people and transcription glossaries from past notes, and handle duplicate person profiles."))
      .setHeading();
    new obsidian.Setting(c).setName(t("Complete from past notes"))
      .setDesc(`${t("People pending confirmation ")}${pendingPeopleSuggestions.length}${t(" items, ignored ")}${ignoredPeopleSuggestions.length}${t(" items. The scan calls the current AI organizing service; for confidential content, use a local model.")}`)
      .addButton(b => b.setButtonText(t("Extract people suggestions")).setCta().onClick(async () => this.plugin.people.suggestPeopleDirectoryFromLibrary()))
      .addButton(b => b.setButtonText(t("Extract transcript terms")).onClick(async () => this._extractVocabFromLibrary(async () => { if (vocabPathSetting) await refreshVocabStatus(vocabPathSetting); })))
      .addButton(b => b.setButtonText(t("Pending")).setDisabled(!pendingPeopleSuggestions.length).onClick(async () => { await this.plugin.people.openCachedPeopleDirectorySuggestions(); this.renderSettings(); }))
      .addButton(b => b.setButtonText(t("Ignored")).setDisabled(!ignoredPeopleSuggestions.length).onClick(async () => { await this.plugin.people.openIgnoredPeopleDirectorySuggestions(); this.renderSettings(); }));

    new obsidian.Setting(c).setName(t("Person deduplication"))
      .setDesc(t("Merge duplicate records by name, update note references, and archive duplicate pages with -1 / -2 suffixes."))
      .addButton(b => b.setButtonText(t("Merge duplicate people")).onClick(async () => {
        const ok = await qnalogConfirm(this.app, t("Merge duplicate person profiles?"), t("QnALog merges person pages with the same name into the main profile, rewrites all wiki links pointing to the duplicate pages, and moves the duplicates to the archive folder. Make sure syncing has finished first."), t("Start merging"));
        if (!ok) return;
        try {
          const result = await this.plugin.people.mergeDuplicatePeopleDirectory();
          new obsidian.Notice(result.merged
            ? `${t("Merged ")}${result.merged}${t(" duplicate person pages, updated ")}${result.updatedLinks}${t(" note references")}`
            : t("No duplicate person pages found that need merging"));
          this.renderSettings();
        } catch (e) {
          console.error("[QnALog] merge duplicate people failed", e);
          new obsidian.Notice(`${t("Failed to merge duplicate people: ")}${(e && e.message) || e}`, 8000);
        }
      }));

    new obsidian.Setting(c)
      .setName(t("Browsing and maintenance"))
      .setDesc(t("Open the detail table, or fill in the missing Base views."))
      .setHeading();

    new obsidian.Setting(c).setName(t("Detail table"))
      .setDesc(t("For checking and batch filtering; not the primary display entry point."))
      .addButton(b => b.setButtonText(t("People directory")).onClick(() => { void this.plugin.library.openPeopleBase(); }))
      .addButton(b => b.setButtonText(t("All notes")).onClick(() => this.plugin.library.openDetailBase()))
      .addButton(b => b.setButtonText(t("Backfill views")).onClick(async () => {
        try {
          const r = await this.plugin.library.createBases({ overwrite: false });
          new obsidian.Notice(`${t("Table views created: ")}${r.created}${t(" file items, skipped ")}${r.skipped}${t(" file items")}`);
        } catch (e) {
          console.error(e);
          new obsidian.Notice(`${t("Create failed: ")}${e.message || e}`);
        }
      }));

    new obsidian.Setting(c)
      .setName(t("Storage and privacy"))
      .setDesc(t("Set where resources are stored, the scan records, and the scope of person profile usage. In general, the defaults are fine."))
      .setHeading();
    const advancedBody = c;
    this.createSettingsSubhead(advancedBody, t("Save location"), t("These paths are relative paths inside the current Obsidian vault and only affect content created later."));

    vocabPathSetting = createPathSetting(advancedBody, t("Transcription term list file"), t("Used to store proper nouns, terminology, and commonly misspelled forms."), this.plugin.settings.vocabularyFile || DEFAULT_SETTINGS.vocabularyFile, DEFAULT_SETTINGS.vocabularyFile,
      async v => { this.plugin.settings.vocabularyFile = v || DEFAULT_SETTINGS.vocabularyFile; },
      refreshVocabStatus);

    createPathSetting(advancedBody, t("Person profile folder"), t("One Markdown page per person, for long-term maintenance of names, common forms of address, roles, organizations, and related notes."), this.plugin.settings.peopleDirectoryFolder || DEFAULT_SETTINGS.peopleDirectoryFolder, DEFAULT_SETTINGS.peopleDirectoryFolder,
      async v => { this.plugin.settings.peopleDirectoryFolder = v || DEFAULT_SETTINGS.peopleDirectoryFolder; },
      async setting => {
        try {
          const people = await loadPeopleDirectory(this.plugin);
          setting.setDesc(t("Currently {0} people. Person profiles are read locally only by default.").replace("{0}", String(people.length)));
        } catch (e) {
          setting.setDesc(t("Failed to read: {0}").replace("{0}", String(e.message || e)));
        }
      });

    createPathSetting(advancedBody, t("Topic pages folder"), t("Folder for topic pages created by topic integration."), this.plugin.settings.topicsFolder || DEFAULT_SETTINGS.topicsFolder, DEFAULT_SETTINGS.topicsFolder,
      async v => { this.plugin.settings.topicsFolder = v || DEFAULT_SETTINGS.topicsFolder; });

    createPathSetting(advancedBody, t("Views folder"), t("Save the resource overview and Base views generated by QnALog."), this.plugin.settings.basesFolder || DEFAULT_SETTINGS.basesFolder, DEFAULT_SETTINGS.basesFolder,
      async v => { this.plugin.settings.basesFolder = v || DEFAULT_SETTINGS.basesFolder; });

    const vocabScanCount = countKnowledgeExtractionHistory(this.plugin.settings, "vocabulary");
    const peopleScanCount = countKnowledgeExtractionHistory(this.plugin.settings, "people");
    this.createSettingsSubhead(advancedBody, t("Scan records"), t("After clearing, past meetings can re-enter the scope of person and glossary scanning."));
    new obsidian.Setting(advancedBody).setName(t("Note scan records"))
      .setDesc(`${t("Transcription glossary scanned ")}${vocabScanCount}${t(" notes; person suggestions scanned ")}${peopleScanCount}${t(" notes. After clearing the records, notes that have been modified or already exist can re-enter the scanning scope.")}`)
      .addButton(b => b.setButtonText(t("Clear term records")).setDisabled(!vocabScanCount).onClick(async () => {
        const ok = await qnalogConfirm(this.app, t("Clear glossary scan history?"), `${vocabScanCount}${t(" notes will re-enter the scanning scope; rescanning calls the LLM service again, and cloud usage is billed by volume.")}`, t("Clear"));
        if (!ok) return;
        this.plugin.knowledgeExtraction.clearKnowledgeExtractionHistory("vocabulary");
        await this.plugin.saveSettings();
        new obsidian.Notice(t("Transcription glossary scan records cleared"));
        this.renderSettings();
      }))
      .addButton(b => b.setButtonText(t("Clear people records")).setDisabled(!peopleScanCount).onClick(async () => {
        const ok = await qnalogConfirm(this.app, t("Clear person suggestion scan history?"), `${peopleScanCount}${t(" notes will re-enter the scanning scope; rescanning calls the LLM service again, and cloud usage is billed by volume.")}`, t("Clear"));
        if (!ok) return;
        this.plugin.knowledgeExtraction.clearKnowledgeExtractionHistory("people");
        await this.plugin.saveSettings();
        new obsidian.Notice(t("People suggestion scan records cleared"));
        this.renderSettings();
      }));

    const transcribeProvider = resolveTranscribeProvider(this.plugin);
    const asrScope = isLocalServiceEndpoint(transcribeProvider.endpoint)
      ? t("The current transcription service is detected as local or LAN")
      : (isSharedAddressSpaceEndpoint(transcribeProvider.endpoint)
        ? t("The current transcription service is detected as a private network such as Tailscale") : t("The current transcription service is detected as cloud"));
    const llmScope = isLocalLlmEndpoint(this.plugin.settings.llmEndpoint)
      ? t("The current LLM service is detected as local or on a LAN")
      : (isSharedAddressSpaceEndpoint(this.plugin.settings.llmEndpoint)
        ? t("The current LLM service is detected as a private network such as Tailscale") : t("The current LLM service is detected as cloud"));
    const modeLabel = { privacy: t("Privacy first"), hotwords: t("Person name hotwords"), localFull: t("Local enhancement") }[normalizePeopleContextMode(this.plugin.settings.peopleContextMode)] || t("Privacy first");
    const consentText = hasPeopleHotwordsConsent(this.plugin.settings) ? t("Name hotwords authorized on {0}.").replace("{0}", String(this.plugin.settings.peopleHotwordsConsentAt)) : t("Name hotwords not yet authorized.");

    this.createSettingsSubhead(advancedBody, t("Person profile privacy"), t("Determines whether person names and context are sent to the current service along with transcription or organizing requests."));
    new obsidian.Setting(advancedBody).setName(t("Person profile usage policy"))
      .setDesc(t("{0}. {1}; {2}. {3}").replace("{0}", modeLabel).replace("{1}", asrScope).replace("{2}", llmScope).replace("{3}", consentText))
      .addDropdown(d => d
        .addOption("privacy", t("Privacy first: do not send people data"))
        .addOption("hotwords", t("Person name hotwords: names/forms of address only, requires authorization"))
        .addOption("localFull", t("Local enhancement: only local services use the full people context"))
        .setValue(normalizePeopleContextMode(this.plugin.settings.peopleContextMode))
        .onChange(async v => {
          const next = normalizePeopleContextMode(v);
          if (next === "hotwords" && !hasPeopleHotwordsConsent(this.plugin.settings)) {
            const ok = await new Promise(resolve => {
              new PeopleHotwordsConsentModal(this.app, (confirmed) => resolve(confirmed)).open();
            });
            if (!ok) { this.renderSettings(); return; }
            this.plugin.settings.peopleHotwordsConsentAt = new Date().toISOString();
          }
          this.plugin.settings.peopleContextMode = next;
          await this.plugin.saveSettings();
          this.renderSettings();
        }))
      .addButton(b => b.setButtonText(t("Revoke consent"))
        .setDisabled(!hasPeopleHotwordsConsent(this.plugin.settings))
        .onClick(async () => {
          this.plugin.settings.peopleHotwordsConsentAt = "";
          if (normalizePeopleContextMode(this.plugin.settings.peopleContextMode) === "hotwords") this.plugin.settings.peopleContextMode = "privacy";
          await this.plugin.saveSettings();
          new obsidian.Notice(t("People-name hotword consent revoked: future transcription and organizing requests will no longer include names or forms of address, and the policy has automatically switched back to \"Privacy first\"."));
          this.renderSettings();
        }));
  }

  async _extractVocabFromLibrary(refreshStatus) {
    if (!this.plugin.settings.llmApiKey && !canOmitServiceApiKey(this.plugin.settings.llmEndpoint)) {
      new obsidian.Notice(t("Please configure an LLM service first"));
      return;
    }
    try {
      const result = await this.plugin.vocabulary.extractVocabularyFromLibrary();
      await refreshStatus();
      if (result.processed) {
        const rest = result.remaining ? `${t(", and ")}${result.remaining}${t(" notes left for the next scan")}` : "";
        const failed = result.failed ? `${t(", failed ")}${result.failed}` : "";
        new obsidian.Notice(`${t("ASR hotword scan complete: processed ")}${result.processed}${t(" notes, extracted ")}${result.added}${t(" candidate words")}${failed}${rest}`);
      }
    } catch (e) {
      console.error(e);
      new obsidian.Notice(`${t("Hotword extraction failed:")}${e.message || e}`);
    }
  }

  /**
   * 「录音」选项卡。整体只讲一件事：声音怎么进来、存到哪里、录完发生什么。
   *
   * 这里合并了两处：原先「常规」页的设备与文件设置，以及「进阶」页里的
   * 分段间隔、并发与短录音过滤。后者直接决定录到了什么，属于录音本身就是常项，
   * 不该和诊断、自动导入挤在同一页的长列表里。
   */
  renderRecording(c) {
    new obsidian.Setting(c)
      .setName(t("Audio input"))
      .setDesc(t("Choose the recording source and the actual input device. For mixed recording, be sure to specify the microphone used by the person speaking."))
      .setHeading();
    this.renderAudioInputSettings(c);

    new obsidian.Setting(c)
      .setName(t("Recording and transcription"))
      .setDesc(t("Control recording slicing, short-recording filtering, long-audio concurrency, and temporary slice retention policy."))
      .setHeading();

    // 当前转写服务若是流式（Realtime 等），分段相关设置不参与工作——在描述里就地说明，免得用户调了没反应
    const advAsrId = this.plugin.settings.activeTranscribeProvider || "siliconflow";
    const advAsrProfile = this.getTranscribeProviderProfile(advAsrId, (this.plugin.settings.transcribeProviders || {})[advAsrId] || {});
    const streamingNote = advAsrProfile && advAsrProfile.transcribeMode === "streaming" ? t("The current transcription service is streaming, so this option has no effect.") : "";

    new obsidian.Setting(c).setName(t("Real-time segmented transcription"))
      .setDesc(`${t("During recording, audio is split into segments at the set interval and transcribed in real time. When off, the recording is processed all at once after it stops.")}${streamingNote}`)
      .addToggle(txt => txt.setValue(this.plugin.settings.enableInterimOutput).onChange(async v => { this.plugin.settings.enableInterimOutput = v; await this.plugin.saveSettings(); }));

    new obsidian.Setting(c).setName(t("Filter very short recordings"))
      .setDesc(t("When enabled, recordings under 1 second are discarded without transcription. Recordings from 1 to under 10 seconds are transcribed once: blank results are discarded, complete text creates a note, and shorter text keeps the audio without creating a note. Transcription failures keep the audio and a retry task. Turn this off to process short recordings normally."))
      .addToggle(txt => txt.setValue(this.plugin.settings.filterShortRecordings !== false).onChange(async v => { this.plugin.settings.filterShortRecordings = v; await this.plugin.saveSettings(); }));

    new obsidian.Setting(c).setName(t("Segment interval"))
      .setDesc(`${t("How often to start a new segment, in minutes. Valid range 0.5–30.")}${streamingNote}`)
      .addText(txt => {
        txt.setValue(String(this.plugin.settings.segmentIntervalMinutes)).onChange(async v => {
          const n = parseFloat(v);
          if (!isFinite(n)) return; // 打字途中/非法输入不保存，失焦时回显实际值
          const clamped = Math.min(30, Math.max(0.5, n));
          if (clamped !== n) new obsidian.Notice(`${t("Segment interval adjusted (valid range 0.5–30) to")} ${clamped}${t(" minutes")}`);
          this.plugin.settings.segmentIntervalMinutes = clamped;
          await this.plugin.saveSettings();
        });
        // 失焦回显真正保存的值，避免"输入框显示 100、实际存 30"的所见非所存
        txt.inputEl.addEventListener("blur", () => { txt.setValue(String(this.plugin.settings.segmentIntervalMinutes)); });
      });

    new obsidian.Setting(c).setName(t("Concurrent transcriptions"))
      .setDesc(t("Number of segments processed simultaneously when importing long audio. If requests are throttled or service errors occur, set it back to 1."))
      .addDropdown(d => d
        .addOption("1", t("1 (most reliable)"))
        .addOption("2", t("2 (balanced)"))
        .addOption("3", t("3 (faster)"))
        .setValue(String(normalizeAsrConcurrency(this.plugin.settings.asrConcurrency)))
        .onChange(async v => {
          this.plugin.settings.asrConcurrency = normalizeAsrConcurrency(v);
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(c).setName(t("Keep temporary segment audio"))
      .setDesc(t("Used for troubleshooting transcription issues; uses more storage. When off, the full recording is kept and temporary segments are cleaned up automatically after a successful transcription."))
      .addToggle(txt => txt.setValue(this.plugin.settings.keepSegmentAudioFiles === true).onChange(async v => { this.plugin.settings.keepSegmentAudioFiles = v; await this.plugin.saveSettings(); }));

    new obsidian.Setting(c)
      .setName(t("Notes and live outline"))
      .setDesc(t("Control the organized note layout, automatic naming, and live outline behavior during recording."))
      .setHeading();

    new obsidian.Setting(c).setName(t("Automatically add topic to file name"))
      .setDesc(t("After recording, audio import, re-organizing, or a queue retry completes, the AI distills a topic of no more than 15 characters and appends it to the note file name."))
      .addToggle(txt => txt.setValue(this.plugin.settings.autoRenameWithTitle).onChange(async v => { this.plugin.settings.autoRenameWithTitle = v; await this.plugin.saveSettings(); }));

    new obsidian.Setting(c).setName(t("Live outline"))
      .setDesc(t("Automatically update the outline after each segment is transcribed. When off, you can refresh manually from the sidebar; more segments mean more AI calls."))
      .addToggle(txt => txt.setValue(this.plugin.settings.enableRealtimeOutline).onChange(async v => { this.plugin.settings.enableRealtimeOutline = v; await this.plugin.saveSettings(); }));

    new obsidian.Setting(c).setName(t("Automatically open the sidebar while recording"))
      .addToggle(txt => txt.setValue(this.plugin.settings.autoOpenOutlineOnRecord).onChange(async v => { this.plugin.settings.autoOpenOutlineOnRecord = v; await this.plugin.saveSettings(); }));
    new obsidian.Setting(c)
      .setName(t("Files and Naming"))
      .setDesc(t("Set where new recordings, notes, and meeting materials are saved, and the file name format for new notes."))
      .setHeading();

    new obsidian.Setting(c).setName(t("QnALog recordings folder"))
      .setDesc(t("Relative path within the Obsidian vault. Recording files are saved to {0} by default; change it to another location as needed. Changes only affect new files; existing files are not migrated automatically.")
        .replace("{0}", DEFAULT_SETTINGS.audioFolder))
      .addText(t => t
        .setPlaceholder(DEFAULT_SETTINGS.audioFolder)
        .setValue(this.plugin.settings.audioFolder)
        .onChange(async v => { this.plugin.settings.audioFolder = v.trim() || DEFAULT_SETTINGS.audioFolder; await this.plugin.saveSettings(); }));

    new obsidian.Setting(c).setName(t("QnALog transcripts folder"))
      .setDesc(t("Relative path within the Obsidian vault. Transcripts and organized notes are saved to {0} by default; change it to another location as needed. Changes only affect new files; existing files are not migrated automatically.")
        .replace("{0}", DEFAULT_SETTINGS.mdFolder))
      .addText(txt => txt
        .setPlaceholder(DEFAULT_SETTINGS.mdFolder)
        .setValue(this.plugin.settings.mdFolder)
        .onChange(async v => { this.plugin.settings.mdFolder = v.trim() || DEFAULT_SETTINGS.mdFolder; await this.plugin.saveSettings(); }));

    new obsidian.Setting(c).setName(t("QnALog meeting materials folder"))
      .setDesc(t("Relative path within the Obsidian vault. Supplementary materials such as images, PPT, and PDF added from the recording sidebar are copied here, in a subfolder created for each recording."))
      .addText(txt => txt
        .setPlaceholder(DEFAULT_SETTINGS.meetingMaterialsFolder)
        .setValue(this.plugin.settings.meetingMaterialsFolder || DEFAULT_SETTINGS.meetingMaterialsFolder)
        .onChange(async v => {
          this.plugin.settings.meetingMaterialsFolder = obsidian.normalizePath(v.trim() || DEFAULT_SETTINGS.meetingMaterialsFolder);
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(c).setName(t("Note file name format"))
      .setDesc(t("Each recording generates its own note. Name them with date placeholders: YYYY year, MM month, DD day, HH hour, mm minute; for example, YYYY-MM-DD HHmm produces \"2026-06-10 1830\". The syntax is the same as Obsidian's Daily Notes plugin."))
      .addText(txt => txt.setValue(this.plugin.settings.noteFileNameFormatNew).onChange(async v => { this.plugin.settings.noteFileNameFormatNew = v; await this.plugin.saveSettings(); }));

    new obsidian.Setting(c)
      .setName(t("Actions after completion"))
      .setDesc(t("Control whether the note opens after it completes."))
      .setHeading();

    new obsidian.Setting(c).setName(t("Automatically open the note when complete"))
      .addToggle(txt => txt.setValue(this.plugin.settings.autoOpenNoteAfterFinish).onChange(async v => { this.plugin.settings.autoOpenNoteAfterFinish = v; await this.plugin.saveSettings(); }));

    new obsidian.Setting(c)
      .setName(t("Floating button"))
      .setDesc(t("Configure the visibility and size of the desktop floating button."))
      .setHeading();

    new obsidian.Setting(c).setName(t("Show floating button"))
      .setDesc(t("When on, it stays visible and can be dragged anywhere; when off, it is hidden."))
      .addToggle(t => t.setValue(this.plugin.settings.showFloatingBall).onChange(async v => {
        this.plugin.settings.showFloatingBall = v; await this.plugin.saveSettings();
        this.plugin.shell.syncBubbleVisibility();
      }));

    new obsidian.Setting(c).setName(t("Floating button size"))
      .setDesc(t("Adjust the size of the button and its expanded controls."))
      .addDropdown(d => d
        .addOption("large", t("Large"))
        .addOption("medium", t("Medium"))
        .addOption("small", t("Small"))
        .setValue(this.plugin.settings.bubbleSize || "large")
        .onChange(async v => {
          this.plugin.settings.bubbleSize = v; await this.plugin.saveSettings();
          this.plugin.shell.syncBubbleVisibility();
        }));

  }

  /**
   * 「自动导入」选项卡：监控收件箱文件夹并自动处理新音频，以及后台任务的重试上限与队列入口。
   * 两者都属「不在场时自动发生的事」，放一起；从「进阶」拆出。
   */
  renderImport(c) {
    new obsidian.Setting(c)
      .setName(t("Auto-import audio"))
      .setDesc(t("Watch an inbox folder and automatically process audio synced in from cloud storage or other devices."))
      .setHeading();

    new obsidian.Setting(c).setName(t("Watched folder"))
      .setDesc(t("Enter a folder path inside the vault, for example one that phone recordings sync into. Once new audio finishes syncing, notes are generated automatically and the audio is moved to the archive subfolder."))
      .addText(txt => {
        txt.setValue(this.plugin.settings.inboxFolder || "")
          .setPlaceholder(`${DEFAULT_SETTINGS.audioFolder}/inbox`)
          .onChange(async v => {
            this.plugin.settings.inboxFolder = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new obsidian.Setting(c).setName(t("Automatically process new files"))
      .setDesc(t("When off, you can scan the watched folder manually from the command palette."))
      .addToggle(t => t.setValue(this.plugin.settings.inboxAutoImport).onChange(async v => {
        this.plugin.settings.inboxAutoImport = v;
        await this.plugin.saveSettings();
      }));

    new obsidian.Setting(c).setName(t("Archive subfolder"))
      .setDesc(t("After processing, files are moved to this subfolder of the watched folder. Leave it empty to keep files in place."))
      .addText(t => t.setValue(this.plugin.settings.inboxArchiveSubfolder || "")
        .setPlaceholder("processed")
        .onChange(async v => { this.plugin.settings.inboxArchiveSubfolder = v; await this.plugin.saveSettings(); }));

    new obsidian.Setting(c).setName(t("Wait before processing (milliseconds)"))
      .setDesc(t("Wait a while after a new file appears before processing, so that iCloud, Nutstore, and similar services have finished syncing before transcription starts. 3000–10000 recommended (that is, 3–10 seconds)."))
      .addText(txt => {
        txt.setValue(String(this.plugin.settings.inboxStabilizeDelayMs ?? 3000)).onChange(async v => {
          const n = parseInt(v, 10);
          if (!isFinite(n)) return;
          const clamped = Math.min(60000, Math.max(0, n));
          if (clamped !== n) new obsidian.Notice(`${t("Wait time adjusted to the valid range 0–60000 milliseconds: ")}${clamped}`);
          this.plugin.settings.inboxStabilizeDelayMs = clamped;
          await this.plugin.saveSettings();
        });
        txt.inputEl.addEventListener("blur", () => { txt.setValue(String(this.plugin.settings.inboxStabilizeDelayMs ?? 3000)); });
      });

    new obsidian.Setting(c).setName(t("Scan watched folder now"))
      .setDesc(t("Process all unarchived audio files. Use this to catch anything missed or to batch process after initial setup."))
      .addButton(b => b.setButtonText(t("Scan")).onClick(() => this.plugin.inbox.scanInboxFolder()));

    new obsidian.Setting(c).setName(t("Clean up blank short recordings"))
      .setDesc(t("Scan the transcripts folder and remove QnALog entries that are 10 seconds or shorter and have no valid transcript text, along with the recording files they reference. Obsidian's deleted-file setting determines whether removed files can be restored."))
      .addButton(b => b.setButtonText(t("Scan and clean")).onClick(() => this.plugin.cleanup.cleanupEmptyShortRecordings()));

    new obsidian.Setting(c)
      .setName(t("Task retries"))
      .setDesc(t("Set the automatic retry limit and view background tasks that are still waiting or have failed."))
      .setHeading();

    new obsidian.Setting(c).setName(t("Maximum retry count"))
      .setDesc(t("Automatic retry limit after a transcription or AI organization task fails; once exceeded, you must retry manually from the queue or the note. Valid range 1–10."))
      .addText(t => {
        t.setValue(String(this.plugin.settings.maxRetries || 3)).onChange(async v => {
          const n = parseInt(v, 10);
          if (!isFinite(n)) return;
          // 此前接受 0 但所有使用点都按 || 3 兜底，"填 0 实际跑 3"是谎言，收紧为 1–10
          const clamped = Math.min(10, Math.max(1, n));
          if (clamped !== n) new obsidian.Notice(`${t("Maximum retry count adjusted (valid range 1–10) to ")}${clamped}`);
          this.plugin.settings.maxRetries = clamped;
          await this.plugin.saveSettings();
        });
        t.inputEl.addEventListener("blur", () => { t.setValue(String(this.plugin.settings.maxRetries || 3)); });
      });

    new obsidian.Setting(c).setName(t("Task queue"))
      .setDesc(t("Currently {0} tasks.").replace("{0}", String(this.plugin.queue.tasks.length)))
      .addButton(b => b.setButtonText(t("Open queue")).onClick(() => new QueueModal(this.app, this.plugin).open()))
  }

  /**
   * 「关于」选项卡：版本与更新、诊断日志、版权与许可。
   * 三者都不是配置项，原先分散在「更新」与「进阶」两处。
   */
  renderAbout(c) {
    // 界面语言放在最前面：它是这一页唯一会影响「其余所有界面长什么样」的设置项，
    // 用户来找它时通常正因为界面语言不对。
    new obsidian.Setting(c).setName(t("Interface language")).setHeading();
    new obsidian.Setting(c)
      .setName(t("Interface language"))
      .setDesc(t("Language used by this plugin's interface. Choose “Follow Obsidian” to track Obsidian's own language."))
      .addDropdown(d => {
        d.addOption("", t("Follow Obsidian"));
        for (const item of UI_LANGUAGES) d.addOption(item.id, item.nativeName);
        d.setValue(this.plugin.settings.uiLanguage || "");
        d.onChange(async (v) => {
          this.plugin.settings.uiLanguage = v;
          await this.plugin.saveSettings();
          // 立刻对齐生效语言并重画：用户改完马上要看到效果，
          // 而不是等下一次打开设置页。
          this.plugin.applyUiLanguageNow();
          this.renderSettings();
        });
      });

    new obsidian.Setting(c).setName(t("Plugin Update")).setHeading();
    // 与首页同源：Obsidian 只在启动时读 manifest，直接用 manifest.version 会显示上一次安装的版本。
    const currentVersion = this.plugin.getDisplayVersion();
    const buildSource = this.plugin.getBuildSourceLabel();
    const update = this.plugin.settings.availableUpdate;
    const rawBases = resolveUpdateRawBases(this.plugin.settings);
    const installedUpdateVersion = this.plugin.settings.installedUpdateVersion || "";
    const status = [
      t("Current version:") + currentVersion,
      buildSource ? t("Build source:") + buildSource : "",
      installedUpdateVersion && compareVersions(installedUpdateVersion, currentVersion) > 0
        ? t("Detected ") + installedUpdateVersion + t(" is in place; takes effect after a restart or re-enabling")
        : "",
      update && update.version ? t("Available versions:") + update.version + t("(install from the release page)") : t("No updates available"),
      this.plugin.settings.lastUpdateCheckAt ? t("Last checked:") + this.plugin.settings.lastUpdateCheckAt : t("Not yet checked"),
      this.plugin.settings.lastUpdateError ? t("Last error:") + this.plugin.settings.lastUpdateError : "",
      rawBases.length > 1 ? t("Alternate download source:") + (rawBases.length - 1) + t(" available") : "",
      t("Write directory:") + pluginBasePath(this.plugin),
    ].filter(Boolean).join(t("; "));

    new obsidian.Setting(c).setName(t("Update Status"))
      .setDesc(status);

    new obsidian.Setting(c).setName(t("Update Source"))
      .setDesc(t("This plugin checks this project's repository (GitHub: qnalog/qnalog) for new versions. It only updates the version notice; it never downloads or rewrites any files. Installation is handled by Obsidian or BRAT. The update source does not accept upstream versions."))
      .addButton(b => b.setButtonText(t("Open GitHub")).onClick(() => openExternalUrl(QNALOG_UPDATE_REPO_URL)))
      .addButton(b => b.setButtonText(t("View versions")).onClick(() => openExternalUrl(QNALOG_UPDATE_REPO_URL + "/releases")));


    // 本插件不下载也不安装任何文件（Obsidian 开发者政策：插件不得自我更新）。
    // 这里只检查版本并引导到 GitHub Release，安装交给 Obsidian 或 BRAT。
    new obsidian.Setting(c).setName(t("Check for updates"))
      .setDesc(t("Only checks whether a new version exists; never downloads or installs automatically. See the release page for installation instructions."))
      .addButton(b => b.setButtonText(t("Check for updates")).onClick(async () => {
        await this.plugin.checkForUpdates({ silent: false });
        this.renderSettings();
      }))
      .addButton(b => b.setButtonText(t("Open releases page")).onClick(() => {
        openExternalUrl(QNALOG_UPDATE_REPO_URL + "/releases");
      }));

    new obsidian.Setting(c)
      .setName(t("Diagnostics & Logs"))
      .setDesc(t("Records local diagnostic information and generates troubleshooting reports. Audio device detection now lives under \"Recording > Audio Input\"."))
      .setHeading();

    new obsidian.Setting(c).setName(t("Local Diagnostic Logs"))
      .setDesc(t("Used to troubleshoot errors in transcription, AI polishing, queues, and live outlines. Logs are stored only in the local Obsidian vault and are never uploaded automatically; audio, transcript text, prompts, and API keys are never written to them."))
      .addToggle(txt => txt.setValue(this.plugin.settings.diagnosticsLogEnabled !== false).onChange(async v => {
        this.plugin.settings.diagnosticsLogEnabled = v;
        await this.plugin.saveSettings();
      }))
      .addButton(b => b.setButtonText(t("Copy diagnostic report")).onClick(() => this.plugin.diagnostics.copyDiagnosticReport()));

    new obsidian.Setting(c).setName(t("Diagnostic Log Folder"))
      .setDesc(t("A relative path inside the Obsidian vault. Usually you can keep the default; diagnostic reports are shared with developers for troubleshooting only after you copy them yourself. Changes affect only new log files."))
      .addText(t => t
        .setPlaceholder(DEFAULT_SETTINGS.diagnosticsLogFolder)
        .setValue(this.plugin.settings.diagnosticsLogFolder || DEFAULT_SETTINGS.diagnosticsLogFolder)
        .onChange(async v => {
          this.plugin.settings.diagnosticsLogFolder = obsidian.normalizePath(v.trim() || DEFAULT_SETTINGS.diagnosticsLogFolder);
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(c).setName(t("Clear Diagnostic Logs"))
      .setDesc(t("Deletes all .jsonl log files in the diagnostic log folder to free up space. Does not affect notes or recordings."))
      .addButton(b => b.setButtonText(t("Clear")).onClick(async () => {
        const ok = await qnalogConfirm(this.app, t("Clear diagnostic logs?"), t("This will delete all .jsonl log files in the diagnostic log folder; after deletion they can no longer be used to trace past issues (Obsidian's deleted-file setting determines whether they can be restored)."), t("Clear"));
        if (!ok) return;
        const folder = this.app.vault.getAbstractFileByPath(this.plugin.diagnostics.getDiagnosticsFolder());
        let n = 0;
        if (folder instanceof obsidian.TFolder) {
          const targets = folder.children.filter(f => f instanceof obsidian.TFile && f.extension === "jsonl");
          for (const f of targets) {
            try { await trashVaultFileRef(this.app, f); n++; } catch (e) { console.error("[QnALog] clear diagnostics log failed", e); }
          }
        }
        new obsidian.Notice(n ? t("Diagnostic log cleared: {0} files (restoration depends on Obsidian's deleted-file setting)").replace("{0}", String(n)) : t("The diagnostic log folder is empty"));
      }));

    new obsidian.Setting(c).setName(t("Copyright & License"))
      .setDesc(t("QnALog is maintained by Q&A Log Team and released as open source under the MIT License. See NOTICE and LICENSE in the repository for its code provenance and license details. Third-party APIs, models, and virtual audio device tools are configured and paid for by users themselves; this plugin operates no cloud storage and never uploads recordings to any server of its own."));
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
