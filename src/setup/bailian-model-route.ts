// 百炼录音转写：按所选模型决定使用哪条路线（哪个 provider）并算出要写入的字段。
//
// 目录里百炼只有一项（service-catalog.ts），实际存储仍是三个 provider：
//   dashscope-flash / dashscope-chat / dashscope（流式）。
// 选模型时：
//   1. 模型对应的路线与当前 provider 相同 → 只改当前 provider 的 model / protocol / endpoint；
//   2. 路线不同 → 目标 provider 沿用当前 provider 的地址主机与密钥，并成为当前转写服务；
//      原 provider 的配置不改动；
//   3. 无法安全映射地址、或模型不能用于录音转写（整文件模型、未登记模型）→ 返回不可用，不写任何字段。
// 本模块不写盘；写入与回滚见 applyBailianModelPlan。

import type { PluginSettings, TranscribeProviderSettings } from "../shared/types";
import { resolveBailianAsrRoute, selectBailianAsrModel } from "../asr/bailian-asr-registry";
import { bailianRecordingProviderIdForModel, recordingServiceIdForProvider } from "./service-catalog";

type RecordingSettings = Pick<PluginSettings, "activeTranscribeProvider" | "transcribeProviders">;

export type BailianModelPlan =
  /** 当前服务不是百炼，或没有模型可处理：调用方只写 model 字符串。 */
  | { kind: "not-bailian" }
  /** 模型不能用于录音转写，或地址无法安全映射。 */
  | { kind: "unusable"; reason: "no-protocol" | "unmapped-endpoint" }
  | { kind: "select"; providerId: string; provider: TranscribeProviderSettings; switched: boolean };

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "";
  }
}

/** 当前 provider 是否按百炼处理（沿用设置页原有的判定）。 */
export function isBailianRecordingProvider(providerId: string, provider: TranscribeProviderSettings): boolean {
  return /^(?:bailian|dashscope)(?:-|$)/i.test(String(providerId || ""))
    || /^dashscope(?:-|$)/i.test(String(provider.protocol || ""))
    || /(?:^|\.)aliyuncs\.com$/i.test(endpointHost(String(provider.endpoint || "")));
}

export function planBailianModelSelection(settings: RecordingSettings, model: string): BailianModelPlan {
  const activeId = settings.activeTranscribeProvider || "siliconflow";
  const providers = settings.transcribeProviders || {};
  const current: TranscribeProviderSettings = providers[activeId] || {};
  if (!isBailianRecordingProvider(activeId, current)) return { kind: "not-bailian" };

  const route = resolveBailianAsrRoute(model);
  const targetId = bailianRecordingProviderIdForModel(model);
  if (!route || !targetId) return { kind: "unusable", reason: "no-protocol" };

  // 只在百炼的三条录音路线之间切换；其它 provider（自建网关等）留在原处。
  const canSwitch = recordingServiceIdForProvider(activeId) === "bailian";
  const useId = canSwitch ? targetId : activeId;
  const stored: TranscribeProviderSettings = providers[useId] || {};
  const base: TranscribeProviderSettings = useId === activeId
    ? current
    : {
        ...stored,
        endpoint: current.endpoint,
        apiKey: current.apiKey || stored.apiKey,
        language: current.language !== undefined ? current.language : stored.language,
      };
  const selection = selectBailianAsrModel(useId, base, model);
  if (!selection) return { kind: "unusable", reason: "unmapped-endpoint" };
  return { kind: "select", providerId: useId, provider: selection.provider, switched: useId !== activeId };
}

/**
 * 把方案写入设置并保存；保存失败时恢复写入前的状态再抛出，避免内存与磁盘不一致。
 * 恢复前确认这两项仍是本次写入的值，用户在保存期间又改过则不覆盖。
 */
export async function applyBailianModelPlan(
  settings: RecordingSettings,
  plan: Extract<BailianModelPlan, { kind: "select" }>,
  save: () => Promise<void>,
): Promise<void> {
  const providers = settings.transcribeProviders;
  const previousActive = settings.activeTranscribeProvider;
  const previousStored = providers[plan.providerId];
  const previousCopy = previousStored ? { ...previousStored } : undefined;
  const written = previousStored ? Object.assign(previousStored, plan.provider) : (providers[plan.providerId] = { ...plan.provider });
  settings.activeTranscribeProvider = plan.providerId;
  try {
    await save();
  } catch (error) {
    if (providers[plan.providerId] === written && settings.activeTranscribeProvider === plan.providerId) {
      if (previousCopy) {
        for (const key of Object.keys(written)) delete (written as Record<string, unknown>)[key];
        Object.assign(written, previousCopy);
      } else {
        delete providers[plan.providerId];
      }
      settings.activeTranscribeProvider = previousActive;
    }
    throw error;
  }
}
