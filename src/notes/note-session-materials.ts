import type { SessionMasterAudioInput } from "./audio-reference-text";
import type { RecordingSession } from "../shared/types";
import { getAudioTimeLink, getSessionMasterAudioName } from "./audio-reference-text";
import { labelText } from "../shared/note-labels";
import { isTextImportSession } from "../briefing/note-layout-policy";
import { formatElapsed } from "../shared/util-common";
import { stripArchivedOutlineSections } from "./outline-text";
import { hasMeetingWorkbenchContent, isImageMeetingMaterial, normalizeMeetingWorkbench } from "./meeting-workbench-state";

import { validateRealtimeOutlineSourceCoverage } from "./outline-coverage";
import { buildOutlineCoverageMetadata } from "./outline-storage";

export type RealtimeOutlineDetailsInput = Partial<Pick<RecordingSession,
  | "realtimeOutline"
  | "realtimeOutlineSourceCoverage"
  | "realtimeOutlineCoverageScope"
  | "segments"
>> & { realtimeOutlineCoverage?: unknown };

/** Builds the persisted current-recording outline block and its source proof. */
export function buildRealtimeOutlineDetails(
  session: RealtimeOutlineDetailsInput | null | undefined,
): string {
  const outline = String(session && session.realtimeOutline ? session.realtimeOutline : "").trim();
  if (!outline) return "";
  const coverage = session && session.realtimeOutlineCoverage as { totalSegmentCount?: unknown } | null | undefined;
  const rawSourceCoverage = session && session.realtimeOutlineSourceCoverage;
  const segments = session && Array.isArray(session.segments) ? session.segments : [];
  const sourceCoverage = rawSourceCoverage
    && validateRealtimeOutlineSourceCoverage(rawSourceCoverage, outline, segments)
    ? rawSourceCoverage
    : null;
  const totalSegmentCount = Math.max(0, Number(coverage && coverage.totalSegmentCount) || 0);
  const committedSegmentCount = Math.min(
    totalSegmentCount,
    Math.max(0, Number(sourceCoverage && sourceCoverage.committedSegmentCount) || 0)
  );
  const coverageLabel = session && session.realtimeOutlineCoverageScope === "whole-note"
    ? "outlineCoverageWholeNote"
    : "outlineCoverageCurrentRecording";
  const coverageNotice = totalSegmentCount > 0 && committedSegmentCount < totalSegmentCount
    ? `> ${labelText(coverageLabel, committedSegmentCount, totalSegmentCount)}`
    : "";
  return [
    "<details>",
    `<summary>${labelText("liveOutlineDraft")}</summary>`,
    "",
    `> ${labelText("outlineIntro")}`,
    ...(coverageNotice ? ["", coverageNotice] : []),
    "",
    outline,
    "",
    ...(sourceCoverage ? [buildOutlineCoverageMetadata(sourceCoverage), ""] : []),
    "</details>",
  ].join("\n");
}

/** rewriteConsolidated 组装实时大纲 details 的输入；对象参数便于逐项注入。 */
export interface RealtimeOutlineAssemblyInput {
  /** buildRealtimeOutlineDetails 产出的完整 details 块；空串表示本场次没有实时大纲。 */
  liveBlock: string;
  /** 本场次实时大纲文本（session.realtimeOutline）。 */
  liveText: string;
  /** 续录来源的旧大纲全文（continuationPriorOutline，可能含历史归档）。 */
  priorText: string;
  /** buildPriorSessionBlocks 产出的归档 appendix（横幅 + 旧大纲）。 */
  appendix: string;
}

/**
 * 把续录前大纲并进实时大纲 details，带一道去重闸门。
 *
 * 种子与 appendix 都来自旧笔记整个大纲 details 正文时，重写会产生
 * 「新体 = 旧体 + 横幅 + 旧体」的自引用。种子场景已包含旧实时部分时跳过 appendix；
 * 只有大纲分叉或本场次没有实时大纲时才挂归档，历史仍按场次可查。
 */
export function assembleRealtimeOutlineDetails(input: RealtimeOutlineAssemblyInput): string {
  const liveBlock = String(input.liveBlock || "");
  const appendix = String(input.appendix || "");
  if (liveBlock && appendix) {
    const squash = (value: string) => value.replace(/\s+/g, " ").trim();
    const live = squash(stripArchivedOutlineSections(String(input.liveText || "")));
    const prior = squash(stripArchivedOutlineSections(String(input.priorText || "")));
    if (live && prior && live.includes(prior)) return liveBlock;
    return liveBlock.replace(/<\/details>\s*$/, () => `${appendix}</details>`);
  }
  if (liveBlock) return liveBlock;
  if (appendix) {
    return [
      "<details>",
      `<summary>${labelText("liveOutlineDraft")}</summary>`,
      "",
      `> ${labelText("outlineIntro")}`,
      appendix,
      "</details>",
    ].join("\n");
  }
  return "";
}

export type PriorSessionBlocksInput = Pick<RecordingSession,
  | "continuationSourcePath"
  | "continuationSourceTitle"
  | "continuationRecordedAt"
  | "continuationPriorRecordingInfo"
  | "continuationPriorOutline"
  | "continuationPriorAudioNames"
>;

export interface PriorSessionBlocks {
  recordingInfoAppendix: string;
  outlineAppendix: string;
  audioAppendix: string;
}

/**
 * 续录会话重写笔记时的旧场次原始材料块。输出为纯文本，不读取宿主状态。
 * 时间格式能力由调用方显式提供；没有能力时仍保留已有录音信息。
 */
export function buildPriorSessionBlocks(
  session: PriorSessionBlocksInput | null | undefined,
  formatRecordedAt?: (recordedAt: string) => string,
): PriorSessionBlocks {
  if (!session) return { recordingInfoAppendix: "", outlineAppendix: "", audioAppendix: "" };
  const path = String(session.continuationSourcePath || "");
  if (!path) return { recordingInfoAppendix: "", outlineAppendix: "", audioAppendix: "" };
  const priorInfo = String(session.continuationPriorRecordingInfo || "").trim();
  const priorOutline = String(session.continuationPriorOutline || "").trim();
  const priorAudios = Array.isArray(session.continuationPriorAudioNames) ? session.continuationPriorAudioNames : [];
  const sourceTitle = String(session.continuationSourceTitle || "").trim();
  const recordedAt = String(session.continuationRecordedAt || "").trim();

  const infoLines: string[] = [];
  if (recordedAt && formatRecordedAt) infoLines.push(`- 追加录音：${formatRecordedAt(recordedAt)}`);
  const recordingInfoAppendix = infoLines.length
    ? `\n> 本次纪要由「追加录音」合并整理：来源《${sourceTitle || path}》。\n${infoLines.join("\n")}\n${priorInfo ? `\n${priorInfo}\n` : ""}`
    : (priorInfo ? `\n${priorInfo}\n` : "");

  const audioLines = priorAudios
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .map((name) => `![[${name}]]\n\n${labelText("listenBack")}[[${name}|00:00]]`);
  const audioAppendix = audioLines.length ? `\n${audioLines.join("\n\n")}\n` : "";

  const outlineAppendix = priorOutline
    ? `\n> 以下为追加录音前场次（${sourceTitle || "原纪要"}）的实时大纲草稿。\n\n${priorOutline}\n`
    : "";
  return { recordingInfoAppendix, outlineAppendix, audioAppendix };
}
export interface RecordingInfoDetailsInput {
  startedAt?: string;
  totalMs?: number | null;
  modeLabel?: string;
  segmentText?: string;
  segmentCount?: number | null;
  model?: string;
}

export type NoteInfoTimeFormatter = (readStartedAt: () => string) => string | undefined;

export type TextImportInfoDetailsInput = Pick<RecordingSession, "source"> & {
  startedAt?: string;
  segments?: readonly unknown[] | null;
  textImportSources?: unknown;
};

export function buildRecordingInfoDetails(
  info: RecordingInfoDetailsInput | null | undefined,
  formatStartedAt?: NoteInfoTimeFormatter,
): string {
  const lines: string[] = [];
  if (info && info.startedAt && formatStartedAt) {
    const startedAt = formatStartedAt(() => (info as RecordingInfoDetailsInput & { startedAt: string }).startedAt);
    if (startedAt !== undefined) lines.push(`- ${labelText("timeLabel")}${startedAt}`);
  }
  if (info && info.totalMs != null) lines.push(`- ${labelText("durationLabel")}${formatElapsed(info.totalMs)}`);
  if (info && info.modeLabel) lines.push(`- ${labelText("modeLabel")}${info.modeLabel}`);
  if (info && info.segmentText) lines.push(`- ${labelText("segmentsLabel")}${info.segmentText}`);
  else if (info && info.segmentCount != null) lines.push(`- ${labelText("segmentsLabel")}${info.segmentCount}`);
  if (info && info.model) lines.push(`- ${labelText("modelLabel")}${info.model}`);
  if (!lines.length) return "";
  return [
    "<details>",
    `<summary>${labelText("recordingInfo")}</summary>`,
    "",
    lines.join("\n"),
    "",
    "</details>",
  ].join("\n");
}

export function buildTextImportInfoDetails(
  session: TextImportInfoDetailsInput | null | undefined,
  modeLabel: string,
  model: string,
  formatStartedAt?: NoteInfoTimeFormatter,
): string {
  if (!session || !isTextImportSession(session)) return "";
  const lines: string[] = [];
  if (session.startedAt && formatStartedAt) {
    const startedAt = formatStartedAt(() => (session as TextImportInfoDetailsInput & { startedAt: string }).startedAt);
    if (startedAt !== undefined) lines.push(`- ${labelText("timeLabel")}${startedAt}`);
  }
  if (modeLabel) lines.push(`- ${labelText("modeLabel")}${modeLabel}`);
  const sources: readonly unknown[] = Array.isArray(session.textImportSources) ? session.textImportSources : [];
  lines.push(`- ${labelText("sourceFilesLabel")}${sources.length || (session.segments || []).length || 1}`);
  if (model) lines.push(`- ${labelText("modelLabel")}${model}`);
  if (sources.length) {
    lines.push("", labelText("sourceLabel"));
    for (const source of sources) {
      const item = source as { name?: unknown; path?: string };
      const name = item.name || (item.path ? item.path.split("/").pop() : "") || "未命名文本";
      lines.push(`- ${item.path ? `[[${item.path}|${name as string}]]` : name as string}`);
    }
  }
  return [
    "<details>",
    `<summary>${labelText("importedTextInfo")}</summary>`,
    "",
    lines.join("\n"),
    "",
    "</details>",
  ].join("\n");
}
export type MasterAudioDetailsInput = SessionMasterAudioInput;

export type ExternalAudioSourceDetailsInput = Pick<RecordingSession, "externalAudioSource">;

export function buildMasterAudioDetails(
  session: MasterAudioDetailsInput | null | undefined,
  totalMs?: number | null,
): string {
  const audioName = getSessionMasterAudioName(session);
  if (!audioName) return "";
  return [
    "<details>",
    `<summary>${labelText("originalAudioFull", formatElapsed(totalMs || 0))}</summary>`,
    "",
    `![[${audioName}]]`,
    "",
    `${labelText("listenBack")}${getAudioTimeLink(audioName, 0)}`,
    "",
    "</details>",
  ].join("\n");
}

export function buildExternalAudioSourceDetails(
  session: ExternalAudioSourceDetailsInput | null | undefined,
): string {
  const source = (session && session.externalAudioSource) as { name?: string } | null | undefined;
  const name = String(source && source.name || "").trim();
  if (!name) return "";
  return [
    "<details>",
    `<summary>${labelText("importSource")}</summary>`,
    "",
    `${labelText("fileLabel")}${name}`,
    "",
    "源音频保留在同步文件夹中，未复制到当前知识库。",
    "",
    "</details>",
  ].join("\n");
}

export type MeetingWorkbenchDetailsInput = Pick<RecordingSession, "meetingWorkbench">;

export function buildMeetingWorkbenchDetails(
  session: MeetingWorkbenchDetailsInput | null | undefined,
): string {
  const workbench = normalizeMeetingWorkbench(session && session.meetingWorkbench);
  if (!hasMeetingWorkbenchContent(workbench)) return "";
  const lines: string[] = [];
  if (workbench.notes) {
    lines.push("#### 会中零散记录", "", workbench.notes, "");
  }
  if (workbench.entries.length) {
    lines.push("#### 用户补充", "");
    for (const entry of workbench.entries) {
      const text = entry.text ? ` ${entry.text}` : "";
      lines.push(`- ${formatElapsed(entry.atMs || 0)}${text}`);
      if (entry.interaction && entry.interaction.response) {
        lines.push(`  - AI：${String(entry.interaction.response).replace(/\r?\n/g, "\n    ")}`);
      }
      for (const item of entry.materials || []) {
        const name = item.name || item.path.split("/").pop() || item.path;
        const kind = item.kind ? ` · ${item.kind}` : "";
        if (isImageMeetingMaterial(item)) {
          lines.push(`  - [[${item.path}|${name}]]${kind}`, `  ![[${item.path}]]`);
        } else {
          lines.push(`  - [[${item.path}|${name}]]${kind}`);
        }
      }
    }
    lines.push("");
  }
  if (workbench.materials.length) {
    lines.push("#### 补充材料", "");
    for (const item of workbench.materials) {
      const name = item.name || item.path.split("/").pop() || item.path;
      const kind = item.kind ? ` · ${item.kind}` : "";
      if (isImageMeetingMaterial(item)) {
        lines.push(`- [[${item.path}|${name}]]${kind}`, `![[${item.path}]]`, "");
      } else {
        lines.push(`- [[${item.path}|${name}]]${kind}`);
      }
    }
    lines.push("");
  }
  return [
    "<details>",
    `<summary>${labelText("meetingMaterial")}</summary>`,
    "",
    lines.join("\n").trim(),
    "",
    "</details>",
  ].join("\n");
}
