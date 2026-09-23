// 首次配置：预设的写入范围、候选配置检测、四态判定。
//
// 这一层从设置页抽出，因为它有四个必须可测的契约，放在 @ts-nocheck 的
// settings-tab.ts 里都测不出来：
//   1. 预设只改「完成服务配置所需」的字段，不碰目录、提示词、设备与自动化偏好；
//   2. 检测对象是**用户正在填写的候选配置**，不是已保存的配置；
//   3. 检测过程不写盘（检测专用的宿主没有可用写盘入口）；
//   4. 配置状态区分「缺配置 / 未测试 / 成功 / 失败」，而不是「已填写 / 未填写」。
//
// 计划（plan）与应用（apply）分开：计划是纯函数，任何界面都能先算出「要改什么」
// 再决定改不改。取消 = 丢弃计划，因此取消天然不会覆盖已有配置。

import { DEFAULT_SETTINGS } from "../shared/defaults";
import { genId } from "../shared/util-common";
import { ONE_CARD_PROVIDERS, normalizeLlmProfiles } from "../llm/config";
import { snapshotActiveAsr } from "../llm/asr-scheme";
import type { LlmProfile, PluginSettings, TranscribeProviderSettings } from "../shared/types";

import { t } from "../shared/i18n";
/**
 * 预设允许写入的设置键。
 * 这张表之外的一律不碰——`tests/setup.test.ts` 会拿一份完整设置逐项核对。
 * 新增预设字段时先自问：这是「完成服务配置所需」，还是顺手覆盖用户的偏好？
 */
export const PRESET_WRITTEN_FIELDS: Record<string, true> = {
  transcribeProviders: true,
  activeTranscribeProvider: true,
  importTranscribeProvider: true,
  importSpeakerDiarization: true,
  llmServicePreset: true,
  llmEndpoint: true,
  llmModel: true,
  llmApiKey: true,
  llmProfiles: true,
  activeLlmProfile: true,
};

/**
 * 组合服务预设的字段形状。
 * `src/llm/config.ts` 带 `@ts-nocheck`，它的 `ONE_CARD_PROVIDERS` 在类型上是 any；
 * 这里声明我们需要的那部分，取用时做一次收窄，避免 any 扩散到本模块。
 */
export interface PresetDefinition {
  label?: string;
  scope?: string;
  asrProvider?: string;
  asrTarget?: string;
  asrEndpoint?: string;
  asrModel?: string;
  /** 一站式方案的导入音频转写（整文件）：与录音转写可以是不同的服务与模型。 */
  importAsrProvider?: string;
  importAsrEndpoint?: string;
  importAsrModel?: string;
  llmPreset?: string;
  llmEndpoint?: string;
  tokenPlanEndpoint?: string;
  llmModel?: string;
  applyDesc?: string;
}

/** 预设注册表的类型化视图。 */
const PRESETS: Record<string, PresetDefinition> = ONE_CARD_PROVIDERS;

/**
 * 读取已保存的 API 方案。
 * `normalizeLlmProfiles` 在 `@ts-nocheck` 的 config.ts 里，返回类型是 any；
 * 这里收窄成 `LlmProfile[]`，让本模块后续对方案的读写都是有类型的。
 */
function readLlmProfiles(input: unknown): LlmProfile[] {
  return normalizeLlmProfiles(input) as LlmProfile[];
}

/** 生成转写快照；`snapshotActiveAsr` 同样来自 @ts-nocheck 模块。 */
function takeAsrSnapshot(settings: PluginSettings): LlmProfile["asr"] {
  return snapshotActiveAsr(settings);
}

/** 预设要检测哪个转写环节。 */
export type PresetAsrTarget = "recording" | "import" | "none";

export interface PresetRequest {
  providerId: string;
  apiKey: string;
  /** 只有可改地址的预设（百炼）用得上；其它预设忽略。 */
  llmEndpoint?: string;
  /** 只有需要挑选模型的预设（百炼）用得上。 */
  asrModel?: string;
  llmModel?: string;
}

export interface PresetPlan {
  /** 输入是否完整到可以应用/检测。 */
  ok: boolean;
  /** ok 为 false 时说明缺什么；ok 为 true 时为空串。 */
  reason: string;
  providerId: string;
  /** 只含 PRESET_WRITTEN_FIELDS 里的键；值是这些键的完整新值。 */
  changes: Partial<PluginSettings>;
  asrTarget: PresetAsrTarget;
  asrProviderId: string;
  /** 一站式方案的导入音频转写服务；没有则为空串。 */
  importAsrProviderId: string;
  llmPresetId: string;
}

/** 组合服务里，同一把密钥可能对应普通地址与按量套餐地址；按密钥前缀选择。 */
export function resolvePresetEndpoint(preset: { llmEndpoint?: string; tokenPlanEndpoint?: string }, apiKey: string): string {
  const normal = String((preset && preset.llmEndpoint) || "").trim();
  const tokenPlan = String((preset && preset.tokenPlanEndpoint) || "").trim();
  if (!tokenPlan) return normal;
  const key = String(apiKey || "").trim().toLowerCase();
  if (!key) return normal;
  if (key.startsWith("tp-") || key.includes("token-plan")) return tokenPlan;
  return normal;
}

/**
 * 算出「应用这个预设会改哪些字段」。
 *
 * 纯函数：不改传入的 settings，不落盘、不发请求。界面拿到计划后可以只用来检测，
 * 也可以应用——两者共用同一份计算，避免「检测的是一套、应用的是另一套」。
 */
export function planPresetApplication(settings: PluginSettings, request: PresetRequest): PresetPlan {
  const providerId = String((request && request.providerId) || "").trim();
  const apiKey = String((request && request.apiKey) || "").trim();
  const preset = PRESETS[providerId];

  const empty = (reason: string): PresetPlan => ({
    ok: false,
    reason,
    providerId,
    changes: {},
    asrTarget: "none",
    asrProviderId: "",
    importAsrProviderId: "",
    llmPresetId: "",
  });

  if (!preset) return empty("请选择一个服务方案");
  // 密钥是唯一必填项：地址与模型都内置在预设里。
  if (!apiKey) return empty("请先填写 API Key");

  const llmPresetId = String(preset.llmPreset || "");
  const asrProviderId = String(preset.asrProvider || "");
  const asrTarget: PresetAsrTarget = !asrProviderId
    ? "none"
    : preset.asrTarget === "import" ? "import" : "recording";

  const customEndpoint = String((request && request.llmEndpoint) || "").trim();
  const llmEndpoint = customEndpoint || resolvePresetEndpoint(preset, apiKey) || String(preset.llmEndpoint || "");

  const customAsrModel = String((request && request.asrModel) || "").trim();
  const customLlmModel = String((request && request.llmModel) || "").trim();
  const presetAsrModel = String(preset.asrModel || "").trim();
  const presetLlmModel = String(preset.llmModel || "").trim();

  // 需要挑选模型的预设（百炼）在模型缺失时不算完整，避免应用出半套配置。
  if (preset.scope === "asr-llm" && (!customAsrModel && !presetAsrModel || !customLlmModel && !presetLlmModel)) {
    return empty("请先选择 ASR 模型和 AI 整理模型");
  }

  const changes: Partial<PluginSettings> = {};
  const current = (settings && settings.transcribeProviders) || {};
  let nextProviders: Record<string, TranscribeProviderSettings> = current;

  if (asrProviderId) {
    const defaults = (DEFAULT_SETTINGS.transcribeProviders || {})[asrProviderId] || {};
    const existing: TranscribeProviderSettings = current[asrProviderId] || {};
    // 该键是整体替换：预设要保证「地址/模型/密钥」成套，不能让旧值残留成半新半旧。
    // 语言与协议沿用用户已有选择（用户调过就保留），没有才用默认。
    changes.transcribeProviders = Object.assign({}, current, {
      [asrProviderId]: Object.assign({}, existing, {
        name: existing.name || defaults.name,
        endpoint: String(preset.asrEndpoint || "") || defaults.endpoint || existing.endpoint || llmEndpoint,
        model: customAsrModel || presetAsrModel || defaults.model || existing.model || "",
        language: existing.language || defaults.language || "auto",
        protocol: defaults.protocol || existing.protocol,
        apiKey,
      }),
    });
    nextProviders = changes.transcribeProviders || current;
    if (asrTarget === "import") changes.importTranscribeProvider = asrProviderId;
    else if (asrTarget === "recording") changes.activeTranscribeProvider = asrProviderId;
  }

  // 导入音频转写：一站式方案里是独立的一项（与服务可以是不同服务、不同模型）。
  // 只写完成服务配置所需的字段，与录音转写同一套规则。
  const importProviderId = String(preset.importAsrProvider || "").trim();
  if (importProviderId) {
    const importDefaults = (DEFAULT_SETTINGS.transcribeProviders || {})[importProviderId] || {};
    const existingImport: TranscribeProviderSettings = nextProviders[importProviderId] || {};
    changes.transcribeProviders = Object.assign({}, nextProviders, {
      [importProviderId]: Object.assign({}, existingImport, {
        name: existingImport.name || importDefaults.name,
        endpoint: String(preset.importAsrEndpoint || "") || importDefaults.endpoint || existingImport.endpoint || "",
        model: String(preset.importAsrModel || "").trim() || importDefaults.model || existingImport.model || "",
        language: existingImport.language || importDefaults.language || "zh",
        protocol: importDefaults.protocol || existingImport.protocol,
        apiKey,
      }),
    });
    changes.importTranscribeProvider = importProviderId;
    nextProviders = changes.transcribeProviders;
  }

  // 说话人识别按预设差异化：预设自带导入服务（含说话人识别模型，如百炼 / OpenRouter）就写为启用，
  // 否则写为未启用（例如小米 MiMo 没有说话人识别模型）。
  // 说话人识别是可选项，不是「配置完整」的前提——两件套预设照样能录、能整理。
  const importConfigured = !!importProviderId || asrTarget === "import";
  changes.importSpeakerDiarization = importConfigured;

  changes.llmServicePreset = llmPresetId;
  changes.llmEndpoint = llmEndpoint;
  if (customLlmModel || presetLlmModel) changes.llmModel = customLlmModel || presetLlmModel;
  changes.llmApiKey = apiKey;

  // 同时存成一套完整 API 方案（带转写快照），出现在 API 页顶部可一键重选。
  // 同名方案就地覆盖，不重复堆叠。
  const schemeName = String(preset.label || providerId);
  const profiles = readLlmProfiles(settings && settings.llmProfiles);
  const nextModel = String(changes.llmModel !== undefined ? changes.llmModel : (settings && settings.llmModel) || "");
  const existingProfile = profiles.find((profile) => profile.name === schemeName);
  const asrSnapshot = asrProviderId && asrTarget !== "import"
    ? takeAsrSnapshot(Object.assign({}, settings, { transcribeProviders: nextProviders, activeTranscribeProvider: asrProviderId }))
    : null;

  let activeProfileId: string;
  if (existingProfile) {
    existingProfile.endpoint = String(changes.llmEndpoint || "");
    existingProfile.apiKey = apiKey;
    existingProfile.model = nextModel;
    if (asrSnapshot) existingProfile.asr = asrSnapshot;
    else delete existingProfile.asr;
    activeProfileId = existingProfile.id;
  } else {
    activeProfileId = `llm-${genId()}`;
    const scheme: LlmProfile = {
      id: activeProfileId,
      name: schemeName,
      endpoint: String(changes.llmEndpoint || ""),
      apiKey,
      model: nextModel,
    };
    if (asrSnapshot) scheme.asr = asrSnapshot;
    profiles.push(scheme);
  }
  changes.llmProfiles = profiles;
  changes.activeLlmProfile = activeProfileId;

  return {
    ok: true,
    reason: "",
    providerId,
    changes,
    asrTarget,
    asrProviderId,
    importAsrProviderId: importProviderId,
    llmPresetId,
  };
}

/** 把计划落到一份新设置对象上；传入的 settings 不被修改。 */
export function applyPresetPlan(settings: PluginSettings, plan: PresetPlan): PluginSettings {
  if (!plan || !plan.ok) return settings;
  return Object.assign({}, settings, plan.changes);
}

/**
 * 检测专用宿主：settings 指向候选配置，写盘入口被移走。
 *
 * `saveSettings` / `saveAll` 保留原方法但指向同名的拒绝函数——不是删掉，
 * 而是让「检测顺手把候选配置写进磁盘」这件事直接失败，而不是静默发生。
 * 检测必须是只读的：用户点了「检测」不等于同意保存。
 */
export function buildProbeHost<T extends object>(plugin: T, settings: PluginSettings): T & { settings: PluginSettings } {
  const refuse = () => Promise.reject(new Error("检测过程不得写盘"));
  // Object.create 的返回值是 any；经 unknown 中转再断言成记录，避免 any 扩散。
  const proto: object = (Object.getPrototypeOf(plugin) as object | null) || Object.prototype;
  const host: Record<string, unknown> = Object.create(proto) as Record<string, unknown>;
  const source: Record<string, unknown> = plugin as Record<string, unknown>;
  Object.assign(host, source);
  host.settings = settings;
  host.saveSettings = refuse;
  host.saveAll = refuse;
  return host as T & { settings: PluginSettings };
}

/** 判断某服务是否已填全；返回空串表示填全了。 */
export interface SetupServiceView {
  endpoint: string;
  model: string;
  apiKey: string;
  requiresKey: boolean;
}

export function buildServiceView(
  provider: TranscribeProviderSettings | undefined,
  requiresKey: boolean,
): SetupServiceView {
  const p = provider || {};
  return {
    endpoint: String(p.endpoint || "").trim(),
    model: String(p.model || "").trim(),
    apiKey: String(p.apiKey || "").trim(),
    requiresKey: !!requiresKey,
  };
}

/** 缺什么配置；返回空串表示不缺。 */
export function setupServiceIssue(view: SetupServiceView): string {
  if (!view.endpoint) return "服务地址未填写";
  if (!view.model) return "模型名称未填写";
  if (view.requiresKey && !view.apiKey) return "访问密钥未填写";
  return "";
}

/** 配置状态。四态互斥，界面据此显示不同文案。 */
export type SetupState = "missing" | "untested" | "success" | "failure";

export interface ProbeResult {
  ok: boolean;
  detail: string;
  /** 产生这条结果时的配置指纹；指纹变了结果即失效。 */
  signature: string;
}

/**
 * 配置指纹：端点、模型与密钥都会参与，任一项变了旧的测试结果就不再适用。
 * 密钥只进摘要不进原文，避免把明文带进界面属性或诊断输出。
 */
export function configSignature(view: SetupServiceView): string {
  return [view.endpoint, view.model, view.apiKey ? `k${fnv1a(view.apiKey)}` : "nokey"].join("|");
}

/** FNV-1a：只用于「配置变没变」的比对，不做安全用途。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/**
 * 由「服务是否填全」和「最近一次同指纹的测试结果」推出状态。
 * 结果与当前配置指纹不一致时按未测试处理——不需要在每个输入框上挂重置逻辑。
 */
export function deriveSetupState(view: SetupServiceView, result?: ProbeResult | null): SetupState {
  if (setupServiceIssue(view)) return "missing";
  if (!result || result.signature !== configSignature(view)) return "untested";
  return result.ok ? "success" : "failure";
}

export const SETUP_STATE_LABELS: Record<SetupState, string> = {
  missing: "缺配置",
  untested: "未测试",
  success: "已通过",
  failure: "未通过",
};

export interface DetectionStage {
  /** 阶段标识，供界面排序与断言使用。 */
  stage: "transcribe" | "import-transcribe" | "llm";
  label: string;
  ok: boolean;
  detail: string;
}

export interface DetectionReport {
  ok: boolean;
  stages: DetectionStage[];
}

/** 检测要调用的外部动作。界面注入真实实现，测试注入桩。 */
export interface ProbePorts {
  /** 录音转写链路：返回识别到的文本。 */
  transcribe(host: never): Promise<string>;
  /** 导入音频转写链路。 */
  importTranscribe(host: never, providerId: string): Promise<{ model?: string; detail?: string }>;
  /** 大模型链路。 */
  llm(host: never): Promise<{ model?: string; preview?: string }>;
}

/**
 * 对候选配置跑一遍检测：各阶段独立捕获失败，一个阶段挂了不影响另一个。
 *
 * host 由 buildProbeHost 构造，其 settings 是候选配置、写盘入口被拒绝——
 * 因此「检测的是用户正在填的值」与「检测不落盘」由构造方式保证，不依赖调用方自觉。
 */
export async function runPresetDetection(
  host: never,
  plan: PresetPlan,
  ports: ProbePorts,
): Promise<DetectionReport> {
  const stages: DetectionStage[] = [];

  // 录音转写
  if (plan.asrTarget === "recording") {
    try {
      const text = await ports.transcribe(host);
      stages.push({ stage: "transcribe", label: t("Recording transcription"), ok: true, detail: `返回：${(text || "<空>").slice(0, 20)}` });
    } catch (error) {
      stages.push({ stage: "transcribe", label: t("Recording transcription"), ok: false, detail: errorMessage(error) });
    }
  }

  // 音频导入转写：一站式方案里它是独立的一项，与录音转写各自检测。
  if (plan.importAsrProviderId) {
    try {
      const result = await ports.importTranscribe(host, plan.importAsrProviderId);
      stages.push({
        stage: "import-transcribe",
        label: t("Audio import transcription"),
        ok: true,
        detail: `${result && result.model ? result.model : "服务"}${result && result.detail ? ` · ${result.detail}` : ""}`,
      });
    } catch (error) {
      stages.push({
        stage: "import-transcribe",
        label: t("Audio import transcription"),
        ok: false,
        detail: errorMessage(error),
      });
    }
  }

  // 「仅导入」的旧预设（asrTarget 为 import 且没有独立导入项）仍走这里
  if (plan.asrTarget === "import" && !plan.importAsrProviderId) {
    try {
      const result = await ports.importTranscribe(host, plan.asrProviderId);
      stages.push({
        stage: "import-transcribe",
        label: t("Audio import transcription"),
        ok: true,
        detail: `${result && result.model ? result.model : "服务"}${result && result.detail ? ` · ${result.detail}` : ""}`,
      });
    } catch (error) {
      stages.push({ stage: "import-transcribe", label: t("Audio import transcription"), ok: false, detail: errorMessage(error) });
    }
  }

  try {
    const result = await ports.llm(host);
    stages.push({
      stage: "llm",
      label: t("AI Organize"),
      ok: true,
      detail: result && result.model ? result.model : "已连接",
    });
  } catch (error) {
    stages.push({ stage: "llm", label: t("AI Organize"), ok: false, detail: errorMessage(error) });
  }

  return { ok: stages.every((stage) => stage.ok), stages };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || "未知错误";
  if (typeof error === "string") return error || "未知错误";
  const withMessage: unknown = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  if (typeof withMessage === "string" && withMessage) return withMessage;
  return "未知错误";
}

/** 把一次检测报告转成可展示的一行文案。 */
export function formatDetectionReport(report: DetectionReport): string {
  if (!report || !report.stages.length) return "没有可检测的环节";
  return report.stages
    .map((stage) => `${stage.label} ${stage.ok ? "✓" : "✗"}${stage.ok ? `（${stage.detail}）` : `：${stage.detail}`}`)
    .join("　|　");
}

/**
 * 「使用状态」展示用的数据。
 *
 * 要回答的唯一问题：现在能不能开始用？如果能，当前会用什么服务；如果不能，哪里有问题。
 * 因此分成两层：
 *   - headline + detail：状态结论，一级信息。
 *   - lines：结论的依据（当前配置摘要），二级信息，逐行可点进对应设置页。
 */
export interface SetupStatusLine {
  /**
   * 这一行对应哪项能力。用于「是否拦住开始使用」的判定：
   * 标签经 t() 后随界面语言变化，不能用标签文本比对。
   */
  stage: "transcribe" | "llm" | "speaker" | "audio";
  /** 这一行讲的是哪一项，例如「语音转写」。 */
  label: string;
  /** 一级内容：用户最先要知道的（服务名 / 是否启用）。 */
  value: string;
  /**
   * 次级内容：模型标识等技术信息；没有就不显示这一行。
   *
   * 用 muted 色、不随之高亮：模型 ID 是技术详情，
   * 与服务名同等权重会让技术细节抢占注意力。
   */
  detail: string;
  /**
   * 需要用户处理时显示的图标："" 表示正常（不显示图标）。
   *
   * 只在异常时才出现视觉信号——正常时给每行都挂一个标记，
   * 一排相同的标记等于没有信息量，还会把注意力从真正有问题的那行拉走。
   */
  icon: "" | "!" | "×";
  /** 点击这一行跳到哪个设置标签页；没有就不做可点击。 */
  target: string;
}

export interface SetupStatusReport {
  /** 整体能否开始使用。 */
  ready: boolean;
  /** 一句话结论。 */
  headline: string;
  /** 拦住「开始使用」的项数；徽章与 headline 都用它，避免两处各算一遍。 */
  blockerCount: number;
  /** 结论的补充说明；正常时只讲「可以开始了」，不重复下面已列出的具体能力。 */
  detail: string;
  /** 逐项明细。 */
  lines: SetupStatusLine[];
  /**
   * 不拦住「开始使用」、但仍需用户处理的项目名（如所选的麦克风已断开）。
   *
   * 与 headline 的计数分开：headline 只说「还差几项配置」，
   * 这里的是「能用，但这些地方有问题」。两者口径若混在一起，
   * 会出现「说还差 2 项、但结论又是已准备好」。
   */
  warnings: string[];
}

export interface SetupStatusLineInput {
  stage?: "transcribe" | "llm" | "speaker" | "audio";
  label: string;
  /** 一级内容；缺配置时是「缺什么」。 */
  value: string;
  detail?: string;
  /** 需要用户处理时填：说明缺什么或哪里不可用。留空即正常。 */
  issue?: string;
  /** 截断性的失败（如服务已确认连不上）；比 issue 更严重，用 × 而不是 !。 */
  failure?: string;
  target?: string;
}

export interface SetupStatusInput {
  /** 语音转写：服务名与模型标识。 */
  transcribe: SetupStatusLineInput;
  /** AI 整理：服务名与模型标识。 */
  llm: SetupStatusLineInput;
  /** 说话人识别：是否启用、服务名与模型标识。 */
  speaker: SetupStatusLineInput;
  /** 音频输入：真实设备状态，不是配置模式。 */
  audio: SetupStatusLineInput;
}

/** 判定某一项该显示什么状态图标：正常为空，越严重级别越高。 */
function statusIcon(row: SetupStatusLineInput): "" | "!" | "×" {
  if (row.failure) return "×";
  if (row.issue) return "!";
  return "";
}

/**
 * 汇总当前配置状态。
 *
 * 判据只用「是否缺配置」：填全了就算可用——测试结果属于 §10.3 的四态，
 * 由各服务自己的徽章承担，不混进这份总览（否则每次改一个字符都会让总览翻脸）。
 */
export function buildSetupStatus(input: SetupStatusInput): SetupStatusReport {
  const toLine = (row: SetupStatusLineInput): SetupStatusLine => ({
    stage: row.stage,
    label: row.label,
    value: row.value,
    detail: row.detail || "",
    icon: statusIcon(row),
    target: row.target || "",
  });
  const lines: SetupStatusLine[] = [
    toLine({ stage: "transcribe", label: t("Speech transcription"), target: "api", ...input.transcribe }),
    toLine({ stage: "llm", label: t("AI Organize"), target: "ai", ...input.llm }),
    toLine({ stage: "speaker", label: t("Speaker recognition"), target: "api", ...input.speaker }),
    // 目标必须是 settings-tab.ts 里真实存在的选项卡 id。
    // 曾写作 "general"，而该页已改名 "recording"，导致这一行点了没反应。
    toLine({ stage: "audio", label: t("Audio input"), target: "recording", ...input.audio }),
  ];
  // 只有转写与 AI 整理缺配置才拦得住「开始使用」：没有它们产不出纪要。
  // 说话人识别与音频输入不影响能否开始，因此既不参与 ready 判定，
  // 也不计入下面的「还需要完成 N 项」—— 计数口径与 ready 必须一致，
  // 否则会出现「说还差 3 项、但结论又能开始用」这种自相矛盾。
  // 按稳定标识判定，不能用标签文本：标签经 t() 后随语言变化，比对会失配。
  const BLOCKING_STAGES = ["transcribe", "llm"];
  const blockers = lines.filter((l) => l.icon && BLOCKING_STAGES.includes(l.stage));
  const ready = blockers.length === 0;
  return {
    ready,
    blockerCount: blockers.length,
    headline: ready ? t("Ready to go") : t("Still need to configure {0} items").replace("{0}", String(blockers.length)),
    // 正常时只说结论，不复述下面已经逐项列出的能力（那会让总结变成清单的副本）。
    detail: ready
      ? t("Core setup is complete; you can start recording.")
      : t("These items still need attention: {0}.").replace("{0}", blockers.map((l) => l.label).join(", ")),
    lines,
    warnings: lines.filter((l) => l.icon && !BLOCKING_STAGES.includes(l.stage)).map((l) => l.label),
  };
}
