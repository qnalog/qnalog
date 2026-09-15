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

/**
 * 预设允许写入的设置键。
 * 这张表之外的一律不碰——`tests/setup.test.ts` 会拿一份完整设置逐项核对。
 * 新增预设字段时先自问：这是「完成服务配置所需」，还是顺手覆盖用户的偏好？
 */
export const PRESET_WRITTEN_FIELDS: Record<string, true> = {
  transcribeProviders: true,
  activeTranscribeProvider: true,
  importTranscribeProvider: true,
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
  /**
   * 允许不带密钥地算计划：只填地址与模型，密钥留给用户下一步填。
   * 供「先套一套推荐配置、再填密钥」的入口使用——它与带密钥的预设共用同一条
   * 字段白名单与同一份计算，避免出现第三套写入实现。
   */
  allowMissingKey?: boolean;
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
    llmPresetId: "",
  });

  if (!preset) return empty("请选择一个服务方案");
  // 密钥缺失时是否算「不完整」取决于入口：带密钥的预设要求填全，
  // 「先套推荐配置、再填密钥」的入口允许留空。
  if (!apiKey && !request.allowMissingKey) return empty("请先填写 API Key");

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
        // 密钥留空时保留用户已填的那个：allowMissingKey 的入口只负责套地址与模型，
        // 不能顺手把已有密钥清成空串。
        apiKey: apiKey || existing.apiKey || "",
      }),
    });
    if (asrTarget === "import") changes.importTranscribeProvider = asrProviderId;
    else if (asrTarget === "recording") changes.activeTranscribeProvider = asrProviderId;
  }

  changes.llmServicePreset = llmPresetId;
  changes.llmEndpoint = llmEndpoint;
  if (customLlmModel || presetLlmModel) changes.llmModel = customLlmModel || presetLlmModel;
  if (apiKey) changes.llmApiKey = apiKey;

  // 同时存成一套完整 API 方案（带转写快照），出现在 API 页顶部可一键重选。
  // 同名方案就地覆盖，不重复堆叠。
  const schemeName = String(preset.label || providerId);
  const nextProviders: Record<string, TranscribeProviderSettings> = changes.transcribeProviders || current;
  const profiles = readLlmProfiles(settings && settings.llmProfiles);
  const nextModel = String(changes.llmModel !== undefined ? changes.llmModel : (settings && settings.llmModel) || "");
  const existingProfile = profiles.find((profile) => profile.name === schemeName);
  const asrSnapshot = asrProviderId && asrTarget !== "import"
    ? takeAsrSnapshot(Object.assign({}, settings, { transcribeProviders: nextProviders, activeTranscribeProvider: asrProviderId }))
    : null;

  let activeProfileId: string;
  if (existingProfile) {
    existingProfile.endpoint = String(changes.llmEndpoint || "");
    if (apiKey) existingProfile.apiKey = apiKey;
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

  return { ok: true, reason: "", providerId, changes, asrTarget, asrProviderId, llmPresetId };
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

  if (plan.asrTarget === "import") {
    try {
      const result = await ports.importTranscribe(host, plan.asrProviderId);
      stages.push({
        stage: "import-transcribe",
        label: "音频导入转写",
        ok: true,
        detail: `${result && result.model ? result.model : "服务"}${result && result.detail ? ` · ${result.detail}` : ""}`,
      });
    } catch (error) {
      stages.push({
        stage: "import-transcribe",
        label: "音频导入转写",
        ok: false,
        detail: errorMessage(error),
      });
    }
  } else if (plan.asrTarget === "recording") {
    try {
      const text = await ports.transcribe(host);
      stages.push({ stage: "transcribe", label: "录音转写", ok: true, detail: `返回：${(text || "<空>").slice(0, 20)}` });
    } catch (error) {
      stages.push({ stage: "transcribe", label: "录音转写", ok: false, detail: errorMessage(error) });
    }
  }

  try {
    const result = await ports.llm(host);
    stages.push({
      stage: "llm",
      label: "AI 整理",
      ok: true,
      detail: result && result.model ? result.model : "已连接",
    });
  } catch (error) {
    stages.push({ stage: "llm", label: "AI 整理", ok: false, detail: errorMessage(error) });
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
