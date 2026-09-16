/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：会话处理进度的状态映射

import { isSameVaultPath } from "./audio-refs";

import { clampProgress } from "./note-markdown";

import * as obsidian from "obsidian";

import { t } from "../shared/i18n";
export function getSessionWorkProgressState(session, recorderState) {
  if (!session) return null;
  const progress = session.workProgress || session.aiProgress || {};
  const pct = clampProgress(progress.percent);
  const label = String(progress.label || "").trim();
  const detail = String(progress.detail || "").trim();
  if (session.finalizing) {
    return {
      kind: "processing",
      label: label || "AI 整理中",
      title: detail || "正在调用大模型整理纪要",
      detail: detail || "正在调用大模型整理纪要",
      percent: pct == null ? 65 : pct,
    };
  }
  if (recorderState === "recording") {
    return {
      kind: "processing",
      label: t("Recording"),
      title: t("Recording; segmented transcriptions will be written to the note as they complete"),
      detail: "正在录音；分段转写会陆续写入纪要",
      percent: pct,
    };
  }
  if (recorderState === "paused") {
    return {
      kind: "processing",
      label: t("Paused"),
      title: t("Recording paused; processing will resume when you continue"),
      detail: "录音已暂停，继续后会接着处理",
      percent: pct,
    };
  }
  return {
    kind: "processing",
    label: label || "转写中",
    title: detail || "正在处理最后的音频片段",
    detail: detail || "正在处理最后的音频片段",
    percent: pct,
  };
}

export function getActiveSessionProcessingState(plugin, file) {
  const session = plugin && plugin.session;
  if (!session || !(file instanceof obsidian.TFile) || !session.mdPath) return null;
  if (!isSameVaultPath(session.mdPath, file.path)) return null;
  const recorderState = plugin.recorder && plugin.recorder.state;
  return getSessionWorkProgressState(session, recorderState);
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
