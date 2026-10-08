import type { RecordingSession } from "../shared/types";
import { labelText } from "../shared/note-labels";
import { isTextImportSession } from "../briefing/note-layout-policy";
import { formatElapsed } from "../shared/util-common";
import { stripArchivedOutlineSections } from "./outline-text";

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
