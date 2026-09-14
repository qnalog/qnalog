/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。
import { findLlmProfile } from './config';

export function snapshotActiveAsr(settings) {
  const providerId = String((settings && settings.activeTranscribeProvider) || "").trim();
  if (!providerId) return undefined;
  const p = (settings.transcribeProviders || {})[providerId] || {};
  return {
    providerId,
    apiKey: String(p.apiKey || ""),
    endpoint: String(p.endpoint || "").trim(),
    model: String(p.model || "").trim(),
    language: String(p.language || "").trim(),
  };
}

export function syncWorkingAsrToActiveScheme(settings) {
  const profile = findLlmProfile(settings, settings && settings.activeLlmProfile);
  if (!profile || !profile.asr) return;
  const snap = snapshotActiveAsr(settings);
  if (snap) profile.asr = snap;
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
