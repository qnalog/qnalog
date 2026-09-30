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
      label: label || t("AI organizing"),
      title: detail || t("Calling the AI model to organize the minutes"),
      detail: detail || t("Calling the AI model to organize the minutes"),
      percent: pct == null ? 65 : pct,
    };
  }
  if (recorderState === "recording") {
    return {
      kind: "processing",
      label: t("Recording"),
      title: t("Recording; segmented transcriptions will be written to the note as they complete"),
      detail: t("Recording; segmented transcriptions will be written to the note as they complete"),
      percent: pct,
    };
  }
  if (recorderState === "paused") {
    return {
      kind: "processing",
      label: t("Paused"),
      title: t("Recording paused; processing will resume when you continue"),
      detail: t("Recording paused; processing will resume when you continue"),
      percent: pct,
    };
  }
  return {
    kind: "processing",
    label: label || t("Transcription in progress"),
    title: detail || t("Processing the final audio segments"),
    detail: detail || t("Processing the final audio segments"),
    percent: pct,
  };
}

export function getActiveSessionProcessingState(plugin, file) {
  const session = plugin && plugin.getCurrentSession();
  if (!session || !(file instanceof obsidian.TFile) || !session.mdPath) return null;
  if (!isSameVaultPath(session.mdPath, file.path)) return null;
  const recorderState = plugin.recorder && plugin.recorder.state;
  return getSessionWorkProgressState(session, recorderState);
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
