/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：笔记正文写入：整合版重写与追加、分段标记插入、重新整理、合并历史笔记

import * as obsidian from "obsidian";
import { isKnownPolishMode, getModeMeta, getModePrefix, getEffectivePolishMode } from "../shared/mode-meta";
import { splitOutSedimentBlock } from "../sediment";
import type { NoteIndexService } from "./note-index-service";
import { formatLlmFailureIssue, stripModeSuggestionBlocks } from "../llm/core";
import type { PluginSettings, RecordingSession, Segment, SessionMetaForMerge } from "../shared/types";
import { genId, formatElapsed } from "../shared/util-common";
import { getTranscribeSegmentPlaceholder } from "../shared/util-audio";
import { extractAllRawBlocksFromText, findNoteMarkerOffset, findSessionNoteBlock, iterateNoteDetailsBlocks, splitLeadingFrontmatter } from "./note-document";
import { buildEmptyLlmOutputFallback } from "../prompts/briefing-prompts";
import { buildRealtimeOutlineDetails, stripArchivedOutlineSections } from "../notes/realtime-outline";
import { normalizeMeetingWorkbench } from "../notes/meeting-workbench";
import { buildExternalAudioSourceDetails, buildMasterAudioDetails, buildMeetingWorkbenchDetails, buildPlaybackTimelineDetails, buildRecordingInfoDetails, buildTextImportInfoDetails, buildTextImportSourceDetails } from "../notes/detail-blocks";
import { getAudioSegmentListItem, getAudioTimeLink, getDurationMs, getSegmentsDurationMs, getSegmentAudioLinkOffsetMs } from "../notes/audio-refs";
import { readCurrentOutlineBlock } from "./outline-storage";
import { readTranscriptBlocks, serializeTranscriptBlock } from "../transcript/transcript-markdown";
import { getFrontmatterTags } from "../shared/util-note";
import { buildRenamedMarkdownPath, ensureTranscriptBlocks, extractTranscriptSegments, getSourceIdFromMarkdown, inferNoteStartedAtIso, isTextImportSession, normalizeModeFromLabel, normalizeSegmentsForMergedNote } from "./note-markdown";
import { detectRecentModeFromFilename } from "../recent/recent-notes";
import { NS_MERGE_BLOCK_RE, NS_OUTLINE_BACKUP_FOLDER, NS_TAG, nsMarker, readNamespaceFrontmatter } from "../shared/namespace";
import { labelPattern, labelText } from "../shared/note-labels";

import { shouldRewriteConsolidatedNote } from "../briefing/note-layout-policy";
import { commitContinuationFlow, type ContinuationCommitFlowHost, type ContinuationTranscriptSegment } from "./continuation-commit-flow";
import { appendPolishNoteContent, buildConsolidatedNoteContent, buildPolishAppendBlock } from "./note-write-content";

import { t } from "../shared/i18n";


export type RealtimeOutlineReplacementResult =
  | { status: "written"; backupPath: string }
  | { status: "stale" | "backup-failed" | "write-failed"; backupPath: string | null; errorMessage?: string };

/** rewriteConsolidated 组装实时大纲 details 的输入；对象参数便于测试逐项注入。 */
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
 * 历史 bug：种子与 appendix 都来自旧笔记整个大纲 details 正文，重写于是执行
 * 「新体 = 旧体 + 横幅 + 旧体」——每次追加精确翻倍（实测备份链 1→2→4→8 份、
 * 横幅 0→1→3→7 条 = 2^k−1），且同一重写再执行一次就再翻一倍（不幂等）。
 * 闸门：实时大纲里已包含（空白折叠后）旧大纲的实时部分时跳过 appendix——
 * 种子场景必然成立，直接得到单份；只有大纲真的分叉（重新生成丢了旧话题、
 * 或本场次没有实时大纲）才挂归档，历史仍按场次可查。
 */
export function assembleRealtimeOutlineDetails(input: RealtimeOutlineAssemblyInput): string {
  const liveBlock = String(input.liveBlock || "");
  const appendix = String(input.appendix || "");
  if (liveBlock && appendix) {
    const squash = (value: string) => value.replace(/\s+/g, " ").trim();
    const live = squash(stripArchivedOutlineSections(String(input.liveText || "")));
    const prior = squash(stripArchivedOutlineSections(String(input.priorText || "")));
    if (live && prior && live.includes(prior)) return liveBlock;
    return liveBlock.replace(/<\/details>\s*$/, `${appendix}</details>`);
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

/**
 * 续录会话（continuationSourcePath 非空）重写笔记时的旧场次原始材料块。
 * 三个 appendix 都是纯文本拼接，空串表示该项没有旧材料：
 *   recordingInfoAppendix —— 并进「录音信息」details 的旧场次行（时间/时长/模式/分段/模型 + 音频名）；
 *   outlineAppendix       —— 旧场次的「录音中实时大纲（草稿）」正文，重写时并进大纲 details；
 *   audioAppendix         —— 旧场次的音频嵌入与回听链接行，重写时并进原始音频 details。
 * 依据只有 session 上的 continuationPrior* 字段，输出与宿主无关，可单测。
 */
export function buildPriorSessionBlocks(session) {
  const path = String((session && session.continuationSourcePath) || "");
  if (!path) return { recordingInfoAppendix: "", outlineAppendix: "", audioAppendix: "" };
  const priorInfo = String(session.continuationPriorRecordingInfo || "").trim();
  const priorOutline = String(session.continuationPriorOutline || "").trim();
  const priorAudios = Array.isArray(session.continuationPriorAudioNames) ? session.continuationPriorAudioNames : [];
  const sourceTitle = String(session.continuationSourceTitle || "").trim();
  const recordedAt = String(session.continuationRecordedAt || "").trim();

  const infoLines = [];
  const momentFn = typeof window !== "undefined" ? window.moment : null;
  if (recordedAt && momentFn) infoLines.push(`- 追加录音：${momentFn(recordedAt).format("YYYY-MM-DD HH:mm:ss")}`);
  const recordingInfoAppendix = infoLines.length
    ? `\n> 本次纪要由「追加录音」合并整理：来源《${sourceTitle || path}》。\n${infoLines.join("\n")}\n${priorInfo ? `\n${priorInfo}\n` : ""}`
    : (priorInfo ? `\n${priorInfo}\n` : "");

  const audioLines = (priorAudios || [])
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .map((name) => `![[${name}]]\n\n${labelText("listenBack")}[[${name}|00:00]]`);
  const audioAppendix = audioLines.length ? `\n${audioLines.join("\n\n")}\n` : "";

  const outlineAppendix = priorOutline
    ? `\n> 以下为追加录音前场次（${sourceTitle || "原纪要"}）的实时大纲草稿。\n\n${priorOutline}\n`
    : "";
  return { recordingInfoAppendix, outlineAppendix, audioAppendix };
}

export type NoteWriterSettings = Pick<PluginSettings,
  | "promptTemplates" | "polishMode" | "llmModel" | "consolidatedLayout"
  | "autoRenameWithTitle" | "mdFolder" | "noteFileNameFormatNew"
>;

export type NoteWriterVault = Pick<obsidian.Vault,
  "getAbstractFileByPath" | "read" | "modify" | "create" | "process" | "configDir"
> & {
  readonly adapter?: Pick<obsidian.DataAdapter, "exists" | "mkdir" | "write" | "read">;
};

export interface NoteWriterHost {
  readonly vault: NoteWriterVault;
  readonly settings: NoteWriterSettings;
  readonly noteIndex: Pick<NoteIndexService, "refreshNoteIndexSafely">;
  getFileFrontmatter(file: obsidian.TFile): obsidian.CachedMetadata["frontmatter"];
  ensureFolder(path: string): Promise<void>;
  findAvailableMarkdownPath(targetPath: string, currentPath?: string): string;
  renameFile(file: obsidian.TFile, path: string): Promise<void>;
  openFile(file: obsidian.TFile): Promise<void>;
  confirm(title: string, body: string, ctaText: string): Promise<unknown>;
  getRecentNotes(limit: number): Array<{ file: obsidian.TFile; timestamp: number }>;
  generateTitleTag(polished: string, mode: string): Promise<string>;
  polishTranscript(raw: string, mode: string): Promise<string>;
  mergeAndPolish(segments: Segment[], mode: string, sessionMeta: SessionMetaForMerge): Promise<string>;
  clearCommittedBriefingCheckpoint(sessionMeta: SessionMetaForMerge): Promise<void>;
}

export class NoteWriter {
  declare host: NoteWriterHost;
  private readonly continuationCommitHost: ContinuationCommitFlowHost;
  constructor(host: NoteWriterHost) {
    this.host = host;
    this.continuationCommitHost = {
      readTarget: async (mdPath) => {
        const file = this.host.vault.getAbstractFileByPath(mdPath);
        if (!(file instanceof obsidian.TFile)) throw new Error("Continuation target note is missing");
        return this.host.vault.read(file);
      },
      shouldRewrite: (session) => shouldRewriteConsolidatedNote(this.host.settings, session),
      serializeIncomingSegment: (segment) => this.serializeContinuationSegment(segment),
      rewrite: (session, polished, continuationSessionId) => this.rewriteConsolidated(session, polished, continuationSessionId),
      append: (session, polished, continuationSessionId, initialMarkdown) => this.appendPolishBlock(
        session, polished, null, false, continuationSessionId, initialMarkdown,
      ),
    };
  }
  async readNoteMarkdown(file: obsidian.TFile): Promise<string> {
    return this.host.vault.read(file);
  }

  async replaceRealtimeOutline(
    file: obsidian.TFile,
    expectedMarkdown: string,
    outlineDetails: string,
  ): Promise<RealtimeOutlineReplacementResult> {
    const vault = this.host.vault;
    const generatedOutlineBlock = readCurrentOutlineBlock(outlineDetails);
    if (!(file instanceof obsidian.TFile) || file.extension !== "md" || !generatedOutlineBlock
      || generatedOutlineBlock.range.start !== 0 || generatedOutlineBlock.range.end !== outlineDetails.length) {
      return { status: "write-failed", backupPath: null, errorMessage: "Invalid outline replacement target or details block" };
    }

    let currentMarkdown: string;
    try {
      currentMarkdown = await vault.read(file);
    } catch (error) {
      return { status: "write-failed", backupPath: null, errorMessage: error instanceof Error ? error.message : String(error) };
    }
    if (currentMarkdown !== expectedMarkdown) return { status: "stale", backupPath: null };

    const replacement = this.replaceCurrentOutlineDetails(expectedMarkdown, outlineDetails);
    if (replacement == null) return { status: "write-failed", backupPath: null, errorMessage: "Could not place the outline details block" };

    let backupPath: string;
    try {
      backupPath = await this.backupOutlineSource(file, expectedMarkdown);
    } catch (error) {
      return { status: "backup-failed", backupPath: null, errorMessage: error instanceof Error ? error.message : String(error) };
    }

    let staleDuringProcess = false;
    try {
      await vault.process(file, (content) => {
        if (content !== expectedMarkdown) {
          staleDuringProcess = true;
          return content;
        }
        return replacement;
      });
    } catch (error) {
      return {
        status: "write-failed",
        backupPath,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    if (staleDuringProcess) return { status: "stale", backupPath };

    try {
      const readback = await vault.read(file);
      if (readback !== replacement) {
        return { status: "write-failed", backupPath, errorMessage: "Outline replacement readback did not match" };
      }
    } catch (error) {
      return {
        status: "write-failed",
        backupPath,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    return { status: "written", backupPath };
  }

  private replaceCurrentOutlineDetails(markdown: string, outlineDetails: string): string | null {
    const text = String(markdown || "");
    const current = readCurrentOutlineBlock(text);
    if (current) {
      return text.slice(0, current.range.start) + outlineDetails + text.slice(current.range.end);
    }

    let recordingInfoRange: { start: number; end: number } | null = null;
    for (const range of iterateNoteDetailsBlocks(text)) {
      const summary = text.slice(range.summaryStart, range.summaryEnd).replace(/<[^>]*>/g, "").trim();
      if (labelPattern("recordingInfo").test(summary)) recordingInfoRange = range;
    }
    const insertAt = recordingInfoRange ? recordingInfoRange.end : text.length;
    const before = text.slice(0, insertAt);
    const after = text.slice(insertAt);
    const beforeSeparator = !before
      ? ""
      : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const afterSeparator = !after
      ? ""
      : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
    return `${before}${beforeSeparator}${outlineDetails}${afterSeparator}${after}`;
  }

  private async backupOutlineSource(file: obsidian.TFile, originalMarkdown: string): Promise<string> {
    const vault = this.host.vault;
    const adapter = vault.adapter;
    if (!adapter) throw new Error("Vault storage adapter is unavailable");
    const configDir = obsidian.normalizePath(String(vault.configDir || "").trim());
    const backupRoot = obsidian.normalizePath(`${configDir ? `${configDir}/` : ""}${NS_OUTLINE_BACKUP_FOLDER}`);
    if (!(await adapter.exists(backupRoot))) await adapter.mkdir(backupRoot);
    if (!(await adapter.exists(backupRoot))) throw new Error("Could not create the outline backup folder");

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (let attempt = 0; attempt < 100; attempt++) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
      const timestampFolder = obsidian.normalizePath(`${backupRoot}/${timestamp}${suffix}`);
      if (await adapter.exists(timestampFolder)) continue;
      try {
        await adapter.mkdir(timestampFolder);
      } catch (error) {
        if (!(await adapter.exists(timestampFolder))) throw error;
        continue;
      }
      const backupPath = obsidian.normalizePath(`${timestampFolder}/${file.name}`);
      if (await adapter.exists(backupPath)) continue;
      await adapter.write(backupPath, originalMarkdown);
      if (await adapter.read(backupPath) !== originalMarkdown) {
        throw new Error("Outline backup readback did not match the original note");
      }
      return backupPath;
    }
    throw new Error("Could not allocate a unique outline backup timestamp");
  }


  async appendRepolishBlock(file, polished, mode, segments) {
    const meta = getModeMeta(this.host.settings, mode);
    const stamp = window.moment ? window.moment().format("YYYY-MM-DD HH:mm:ss") : new Date().toISOString();
    const cur = await this.host.vault.read(file);

    // 关键：从全文里把所有原始 / 元数据块（任意深度）抽出来，避免再次嵌套。
    // 旧实现只识别 "## 📁 原始材料"，对 appendPolishBlock 产出的
    // "## ✨ 整合版 + ‹details›录音信息/原始音频/录音中实时大纲/回听时间轴" 结构识别不到，
    // 导致每次重新整理都把整个旧文件包进新的 ‹details›上一版纪要›，重复存放段落和元数据。
    const { tail: rawTail, withoutRaw } = extractAllRawBlocksFromText(cur);
    const beforeParts = splitLeadingFrontmatter(withoutRaw);
    const beforeBody = beforeParts.body.replace(/^\n+/, "");
    const emptyBriefingFallback = buildEmptyLlmOutputFallback();
    const polishedParts = splitLeadingFrontmatter(stripModeSuggestionBlocks(polished || emptyBriefingFallback).trim());
    const polishedFrontmatter = polishedParts.frontmatter ? polishedParts.frontmatter.trimEnd() : "";
    const polishedBody = polishedParts.body.trim() || emptyBriefingFallback;

    const titleMatch = beforeBody.match(/^#\s+[^\n]+\n*/);
    const titleBlock = titleMatch ? titleMatch[0].replace(/\n*$/, "\n") : "";
    let previousBody = titleMatch ? beforeBody.slice(titleMatch[0].length) : beforeBody;
    previousBody = previousBody
      .replace(/\s*---\s*$/m, "")
      .replace(/\s+$/, "")
      .trim();

    const currentBlock = [
      polishedFrontmatter || beforeParts.frontmatter.trimEnd() || null,
      titleBlock ? titleBlock.trimEnd() : null,
      titleBlock ? "" : null,
      `## ${labelText("currentMinutesAt", `${getModePrefix(meta)} · ${stamp}`)}`,
      "",
      `> [!info] 基于本文底部的原始转写重新生成 · 段数：${segments.length} · 模型：${this.host.settings.llmModel}`,
      "",
      polishedBody,
      "",
      "---",
      "",
      "<details>",
      `<summary>${labelText("previousVersion", stamp)}</summary>`,
      "",
      previousBody || `_${labelText("previousVersionEmpty")}_`,
      "",
      "</details>",
      "",
      rawTail ? rawTail.trimEnd() : "",
      "",
    ].filter(v => v !== null).join("\n");

    await this.host.vault.modify(file, currentBlock.replace(/\n{4,}/g, "\n\n\n"));
  }
  async rewriteConsolidated(session: RecordingSession, polished: string, continuationSessionId = ""): Promise<void> {
    const file = this.host.vault.getAbstractFileByPath(session.mdPath);
    if (!(file instanceof obsidian.TFile)) return;
    const currentMarkdown = await this.host.vault.read(file);
    readTranscriptBlocks(currentMarkdown);
    const meta = getModeMeta(this.host.settings, session.mode);
    const moment = window.moment;
    const startedAt = moment(session.startedAt);
    const totalMs = session.segments.length ? session.segments[session.segments.length - 1].endOffsetMs : 0;
    const textImport = isTextImportSession(session);
    const externalAudioImport = !!session.externalAudioSource;
    const retainAudio = !textImport && !externalAudioImport;
    const priorBlocks = buildPriorSessionBlocks(session);
    const isContinuation = !!priorBlocks.recordingInfoAppendix || !!priorBlocks.outlineAppendix || !!priorBlocks.audioAppendix;
    const masterAudioBlock = retainAudio && !session.multiSourceAudio ? buildMasterAudioDetails(session, totalMs) : "";
    const audioRow = masterAudioBlock || session.segments.map((s, i) => getAudioSegmentListItem(s, i)).filter(Boolean).join("\n");
    const realtimeOutlineBlock = buildRealtimeOutlineDetails(session);
    const playbackTimelineBlock = retainAudio ? buildPlaybackTimelineDetails(session) : "";
    const meetingWorkbenchBlock = buildMeetingWorkbenchDetails(session);
    const recordingInfoBlock = textImport ? buildTextImportInfoDetails(session, meta.prefix, this.host.settings.llmModel) : buildRecordingInfoDetails({
      startedAt: session.startedAt,
      totalMs,
      modeLabel: getModePrefix(meta),
      segmentCount: session.segments.length,
      model: this.host.settings.llmModel,
    });
    const recordingInfoWithPrior = recordingInfoBlock && priorBlocks.recordingInfoAppendix
      ? recordingInfoBlock.replace(/<\/details>\s*$/, `${priorBlocks.recordingInfoAppendix}</details>`)
      : recordingInfoBlock;
    const realtimeOutlineWithPrior = assembleRealtimeOutlineDetails({
      liveBlock: realtimeOutlineBlock,
      liveText: session.realtimeOutline || "",
      priorText: session.continuationPriorOutline || "",
      appendix: priorBlocks.outlineAppendix,
    });
    const textImportSourceBlock = textImport ? buildTextImportSourceDetails(session) : "";
    const externalAudioSourceBlock = externalAudioImport ? buildExternalAudioSourceDetails(session) : "";
    const rawBlocks = textImport ? "" : session.segments.map((segment) => {
      const number = segment.index + 1;
      const heading = `### ${labelText("segment", number)} (${formatElapsed(segment.startOffsetMs)}–${formatElapsed(segment.endOffsetMs)}) ${getAudioTimeLink(segment.audioName, getSegmentAudioLinkOffsetMs(segment))}${segment.isFinal ? " · 结束" : ""}`;
      const taskMarker = segment.queueTaskId ? nsMarker("transcribe-task", segment.queueTaskId) : "";
      const body = segment.error
        ? getTranscribeSegmentPlaceholder(segment.error, { retryable: !!segment.queueTaskId })
        : (segment.text || labelText("noContentSegment"));
      const blockHeading = taskMarker ? `${heading}\n\n${taskMarker}` : heading;
      return segment.transcript
        ? serializeTranscriptBlock(segment, blockHeading, body)
        : `${heading}\n\n${taskMarker ? `${taskMarker}\n` : ""}${body}\n`;
    }).join("\n");
    const emptyBriefingFallback = buildEmptyLlmOutputFallback();
    const polishedParts = splitLeadingFrontmatter(polished || emptyBriefingFallback);
    const polishedFrontmatter = polishedParts.frontmatter ? polishedParts.frontmatter.trimEnd() : "";
    const sediment = splitOutSedimentBlock(polishedParts.body);
    const polishedBody = sediment.body.trim() || emptyBriefingFallback;
    const content = buildConsolidatedNoteContent({
      currentMarkdown,
      title: `# ${startedAt.format("YYYY-MM-DD HH:mm")} · ${getModePrefix(meta)}`,
      sessionId: session.id,
      continuationSessionId,
      totalMs,
      segmentCount: session.segments.length,
      textImport,
      retainAudio,
      isContinuation,
      masterAudioBlock,
      audioRow,
      priorAudioAppendix: priorBlocks.audioAppendix,
      rawBlocks,
      polish: { frontmatter: polishedFrontmatter, body: polishedBody, sedimentBlock: sediment.block },
      materials: {
        recordingInfo: recordingInfoWithPrior,
        externalAudioSource: externalAudioSourceBlock,
        meetingWorkbench: meetingWorkbenchBlock,
        realtimeOutline: realtimeOutlineWithPrior,
        textImportSource: textImportSourceBlock,
        playbackTimeline: playbackTimelineBlock,
      },
    });
    await this.host.vault.modify(file, content);
  }
  async appendPolishBlock(
    session: RecordingSession,
    polished: string,
    mergeError: unknown,
    nonRetryableMergeError = false,
    continuationSessionId = "",
    initialMarkdown: string | null = null,
  ): Promise<void> {
    const file = this.host.vault.getAbstractFileByPath(session.mdPath);
    if (!(file instanceof obsidian.TFile)) return;
    const totalMs = session.segments.length ? session.segments[session.segments.length - 1].endOffsetMs : 0;
    const meta = getModeMeta(this.host.settings, session.mode);
    const emptyBriefingFallback = buildEmptyLlmOutputFallback();
    const polishedParts = splitLeadingFrontmatter(polished || emptyBriefingFallback);
    const polishedFrontmatter = polishedParts.frontmatter ? polishedParts.frontmatter.trimEnd() : "";
    const sediment = splitOutSedimentBlock(polishedParts.body);
    const polishedBody = sediment.body.trim() || emptyBriefingFallback;
    const textImport = isTextImportSession(session);
    const externalAudioImport = !!session.externalAudioSource;
    const retainAudio = !textImport && !externalAudioImport;
    const realtimeOutlineBlock = buildRealtimeOutlineDetails(session);
    const playbackTimelineBlock = retainAudio ? buildPlaybackTimelineDetails(session) : "";
    const recordingInfoBlock = textImport ? buildTextImportInfoDetails(session, meta.prefix, this.host.settings.llmModel) : buildRecordingInfoDetails({
      startedAt: session.startedAt,
      totalMs,
      modeLabel: getModePrefix(meta),
      segmentCount: session.segments.length,
      model: this.host.settings.llmModel,
    });
    const textImportSourceBlock = textImport ? buildTextImportSourceDetails(session) : "";
    const externalAudioSourceBlock = externalAudioImport ? buildExternalAudioSourceDetails(session) : "";
    const masterAudioBlock = retainAudio && !session.multiSourceAudio ? buildMasterAudioDetails(session, totalMs) : "";
    const meetingWorkbenchBlock = buildMeetingWorkbenchDetails(session);
    const hasMergeError = !!mergeError;
    const mergeErrorMessage = mergeError && (typeof mergeError === "object" || typeof mergeError === "function") && "message" in mergeError
      ? mergeError.message || mergeError
      : mergeError;
    const failureText = mergeError
      ? (nonRetryableMergeError
        ? `_[${labelText("aiOrganizingFailed", formatLlmFailureIssue(mergeErrorMessage))}]_`
        : `_[${labelText("mergeFailedQueued", mergeErrorMessage as string | number)}]_`)
      : "";
    const block = buildPolishAppendBlock({
      modelAndModeLabel: `${this.host.settings.llmModel} · ${getModePrefix(meta)}`,
      textImport,
      masterAudioBlock,
      hasMergeError,
      failureText,
      polish: { frontmatter: polishedFrontmatter, body: polishedBody, sedimentBlock: sediment.block },
      materials: {
        recordingInfo: recordingInfoBlock,
        externalAudioSource: externalAudioSourceBlock,
        meetingWorkbench: meetingWorkbenchBlock,
        realtimeOutline: realtimeOutlineBlock,
        textImportSource: textImportSourceBlock,
        playbackTimeline: playbackTimelineBlock,
      },
    });
    const cur = initialMarkdown ?? await this.host.vault.read(file);
    const next = appendPolishNoteContent({
      currentMarkdown: cur,
      block,
      polishedFrontmatter,
      hasMergeError,
      textImport,
      totalMs,
      continuationSessionId,
    });
    await this.host.vault.modify(file, next);
  }

  async commitContinuation(session: RecordingSession, polished: string, committedSessionIds: readonly string[]): Promise<void> {
    return commitContinuationFlow(this.continuationCommitHost, session, polished, committedSessionIds);
  }

  private serializeContinuationSegment(segment: ContinuationTranscriptSegment): string {
    const number = segment.index + 1;
    const heading = `### ${labelText("segment", number)} (${formatElapsed(segment.startOffsetMs)}–${formatElapsed(segment.endOffsetMs)}) ${getAudioTimeLink(segment.audioName, getSegmentAudioLinkOffsetMs(segment))}${segment.isFinal ? " · 结束" : ""}`;
    const body = segment.error
      ? getTranscribeSegmentPlaceholder(segment.error, { retryable: !!segment.queueTaskId })
      : (segment.text || labelText("noContentSegment"));
    return serializeTranscriptBlock(segment, heading, body);
  }
  async appendToNote(path, content) {
    const existing = this.host.vault.getAbstractFileByPath(path);
    if (existing instanceof obsidian.TFile) {
      const cur = await this.host.vault.read(existing);
      const sep = cur.endsWith("\n") ? "" : "\n";
      await this.host.vault.modify(existing, cur + sep + content);
    } else {
      await this.host.vault.create(path, content);
    }
  }
  // 把内容插到 segments-start marker 之前（即分段转写区上方），用于录音期把会中生成的提纲放在段落之上。
  async insertBeforeSegmentsStart(path, content, sessionId) {
    const file = this.host.vault.getAbstractFileByPath(path);
    if (!(file instanceof obsidian.TFile)) return this.appendToNote(path, content);
    const cur = await this.host.vault.read(file);
    const marker = nsMarker("segments-start", sessionId || undefined);
    const idx = findNoteMarkerOffset(cur, marker, "first");
    if (idx >= 0) {
      const next = cur.slice(0, idx) + content + "\n" + cur.slice(idx);
      await this.host.vault.modify(file, next);
      return;
    }
    await this.appendToNote(path, content);
  }
  async insertBeforeSegmentsEnd(path, content, sessionId) {
    const file = this.host.vault.getAbstractFileByPath(path);
    if (!(file instanceof obsidian.TFile)) return this.appendToNote(path, content);
    const cur = await this.host.vault.read(file);
    const specific = sessionId ? nsMarker("segments-end", sessionId) : null;
    const legacy = nsMarker("segments-end");
    const specificIndex = specific ? findNoteMarkerOffset(cur, specific, "first") : -1;
    if (specific && specificIndex >= 0) {
      const next = cur.slice(0, specificIndex) + `${content}\n${specific}` + cur.slice(specificIndex + specific.length);
      await this.host.vault.modify(file, next);
      return;
    }
    const lastIdx = findNoteMarkerOffset(cur, legacy, "last");
    if (lastIdx >= 0) {
      const next = cur.slice(0, lastIdx) + content + "\n" + cur.slice(lastIdx);
      await this.host.vault.modify(file, next);
      return;
    }
    await this.appendToNote(path, content);
  }
  async removeEmptySessionBlock(session) {
    const file = this.host.vault.getAbstractFileByPath(session.mdPath);
    if (!(file instanceof obsidian.TFile)) return;
    const cur = await this.host.vault.read(file);
    const range = findSessionNoteBlock(cur, session.id);
    if (!range) return;
    const before = cur.slice(0, range.start).replace(/\n+$/, "\n");
    const after = cur.slice(range.end).replace(/^\n+/, "");
    const next = before + (after ? "\n" + after : "");
    if (next !== cur) await this.host.vault.modify(file, next);
  }

  async renameMarkdownWithGeneratedTitle(fileOrPath, polished, mode) {
    if (!this.host.settings.autoRenameWithTitle || !polished || mode === "off") return null;
    const file = typeof fileOrPath === "string"
      ? this.host.vault.getAbstractFileByPath(fileOrPath)
      : fileOrPath;
    if (!(file instanceof obsidian.TFile)) return null;
    try {
      const tag = await this.host.generateTitleTag(polished, mode);
      if (!tag) return file;
      const target = buildRenamedMarkdownPath(file.path, mode, tag, this.host.settings);
      const newPath = this.host.findAvailableMarkdownPath(target, file.path);
      if (!newPath || obsidian.normalizePath(newPath) === obsidian.normalizePath(file.path)) return file;
      await this.host.renameFile(file, newPath);
      const renamed = this.host.vault.getAbstractFileByPath(newPath);
      return renamed instanceof obsidian.TFile ? renamed : file;
    } catch (e) {
      console.error("[QnALog] rename failed", e);
      return file;
    }
  }
  async polishEditor(editor) {
    const sel = editor.getSelection();
    const raw = sel || editor.getValue();
    if (!raw || !raw.trim()) { new obsidian.Notice(t("Nothing to polish")); return; }
    new obsidian.Notice(t("AI polishing..."));
    try {
      const mode = getEffectivePolishMode(this.host.settings, this.host.settings.polishMode === "off" ? "meeting" : this.host.settings.polishMode);
      const polished = await this.host.polishTranscript(raw, mode);
      if (sel) editor.replaceSelection(polished); else editor.setValue(polished);
      new obsidian.Notice(t("Polishing complete"));
    } catch (e) {
      console.error(e);
      new obsidian.Notice(`${t("Polish failed: ")}${(e && e.message) || e}`);
    }
  }
  // 从 .md 文件的 frontmatter 推断模式（mode 字段；找不到时尝试 类型 字段中文映射）
  detectModeFromMarkdown(file) {
    if (!(file instanceof obsidian.TFile)) return null;
    const cache = this.host.getFileFrontmatter(file);
    if (!cache) {
      const fallbackMode = detectRecentModeFromFilename(this.host.settings, file.basename);
      return fallbackMode && fallbackMode !== "off" ? fallbackMode : null;
    }
    const m = readNamespaceFrontmatter(cache, "mode");
    if (m === "cleanscript") {
      for (const tag of getFrontmatterTags(cache)) {
        const tagMode = normalizeModeFromLabel(this.host.settings, tag);
        if (tagMode && tagMode !== "off" && isKnownPolishMode(this.host.settings, tagMode)) return tagMode;
      }
      const filenameMode = detectRecentModeFromFilename(this.host.settings, file.basename);
      if (filenameMode && filenameMode !== "off") return filenameMode;
      return getEffectivePolishMode(this.host.settings, this.host.settings.polishMode === "off" ? "meeting" : this.host.settings.polishMode);
    }
    if (typeof m === "string" && isKnownPolishMode(this.host.settings, m)) return m;
    const typeStr = String(readNamespaceFrontmatter(cache, "type") || cache["模板"] || cache.template || "").trim();
    const typeToMode = {
      "学习": "learning",
      "学习记录": "learning",
      "学习视频": "learning",
      "视频学习": "learning",
      "课程笔记": "learning",
      "访谈": "interview",
      "访谈调研": "interview",
      "研讨": "seminar",
      "研讨会": "seminar",
      "学术研讨": "seminar",
      "主题沙龙": "seminar",
      "会议": "meeting",
      "工作纪要": "meeting",
      "小会": "huddle",
      "讨论": "huddle",
      "圆桌讨论": "huddle",
      "独白": "monologue",
      "手记": "monologue",
      "个人笔记": "monologue",
    };
    if (typeToMode[typeStr]) {
      const mode = typeToMode[typeStr];
      return isKnownPolishMode(this.host.settings, mode) ? mode : null;
    }
    const fallbackMode = detectRecentModeFromFilename(this.host.settings, file.basename);
    return fallbackMode && fallbackMode !== "off" ? fallbackMode : null;
  }
  findPreviousRecentNoteFile(file) {
    if (!(file instanceof obsidian.TFile)) return null;
    const currentPath = obsidian.normalizePath(file.path);
    const recents = this.host.getRecentNotes(240);
    const current = recents.find((item) => item && item.file && obsidian.normalizePath(item.file.path) === currentPath);
    if (!current) return null;
    const older = recents
      .filter((item) => item && item.file && obsidian.normalizePath(item.file.path) !== currentPath && item.timestamp < current.timestamp)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    return older && older.file instanceof obsidian.TFile ? older.file : null;
  }
  async readMergeSourceFromMarkdown(file, offsetMs, startIndex) {
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") {
      throw new Error(t("Only QnALog Markdown minutes notes can be merged"));
    }
    let content = await this.host.vault.read(file);
    const sourceId = getSourceIdFromMarkdown(content, file);
    const transcriptReady = ensureTranscriptBlocks(content, sourceId);
    if (transcriptReady !== content) {
      await this.host.vault.modify(file, transcriptReady);
      content = transcriptReady;
    }
    const rawSegments = extractTranscriptSegments(content);
    if (!rawSegments.length) {
      throw new Error(t("No original transcription segments found in \"{0}\"").replace("{0}", file.basename));
    }
    const frontmatter = this.host.getFileFrontmatter(file) || {};
    const rawDurationMs = getSegmentsDurationMs(rawSegments) || getDurationMs(content);
    const segments = normalizeSegmentsForMergedNote(rawSegments, offsetMs, startIndex, file);
    if (segments.length) {
      segments[0] = Object.assign({}, segments[0], {
        text: `【来源纪要：${file.basename}】\n${segments[0].text || ""}`.trim(),
      });
    }
    return {
      file,
      content,
      frontmatter,
      mode: this.detectModeFromMarkdown(file),
      startedAt: inferNoteStartedAtIso(file, frontmatter),
      rawDurationMs,
      segments,
    };
  }
  async mergeMarkdownFileWithPrevious(file) {
    if (!(file instanceof obsidian.TFile)) return;
    const previous = this.findPreviousRecentNoteFile(file);
    if (!(previous instanceof obsidian.TFile)) {
      new obsidian.Notice(t("No most recent QnALog summary before this one was found."), 6000);
      return;
    }
    const ok = await this.host.confirm(t("Merge minutes"), t("A new merged minutes note will be created; the source files will be kept.\n\nSources:\n1. {0}\n2. {1}\n\nContinue?").replace("{0}", previous.basename).replace("{1}", file.basename), t("Merge"));
    if (!ok) return;
    try {
      await this.mergeMarkdownFilesAsNew([previous, file]);
    } catch (e) {
      console.error("[QnALog] merge notes failed", e);
      new obsidian.Notice(`${t("Merging minutes failed: ")}${(e && e.message) || e}`, 8000);
    }
  }
  async mergeMarkdownFilesAsNew(files) {
    const sources = [];
    let offsetMs = 0;
    let startIndex = 0;
    for (const file of files || []) {
      const source = await this.readMergeSourceFromMarkdown(file, offsetMs, startIndex);
      sources.push(source);
      offsetMs += Math.max(0, Number(source.rawDurationMs) || 0);
      startIndex += source.segments.length;
    }
    if (sources.length < 2) {
      new obsidian.Notice(t("At least two summaries are required to merge."));
      return;
    }
    const segments = sources.flatMap((source) => source.segments);
    if (!segments.length) {
      new obsidian.Notice(t("No original transcriptions found to merge."), 8000);
      return;
    }
    const mode = sources[sources.length - 1].mode || sources[0].mode || getEffectivePolishMode(this.host.settings, this.host.settings.polishMode);
    await this.host.ensureFolder(this.host.settings.mdFolder);
    const moment = window.moment;
    const startedAtIso = sources[0].startedAt || new Date().toISOString();
    const startedAt = moment ? moment(startedAtIso) : null;
    const stamp = startedAt && startedAt.isValid && startedAt.isValid()
      ? startedAt.format(this.host.settings.noteFileNameFormatNew)
      : (moment ? moment().format(this.host.settings.noteFileNameFormatNew) : "合并纪要");
    const targetPath = this.host.findAvailableMarkdownPath(obsidian.normalizePath(`${this.host.settings.mdFolder}/${stamp} · ${t("Merge")}.md`));
    if (!targetPath) throw new Error(t("Failed to generate a path for the merged minutes file"));

    new obsidian.Notice(`${t("QnALog: merging ")}${sources.length}${t(" minutes notes...")}`, 8000);
    await this.host.vault.create(targetPath, "");
    const session = {
      id: genId(),
      sessionStamp: moment ? moment().format("YYYYMMDD-HHmmss") : String(Date.now()),
      mdPath: targetPath,
      mode,
      startedAt: startedAtIso,
      finalized: true,
      source: "merged-notes",
      segments,
      multiSourceAudio: true,
      meetingWorkbench: { notes: "", draft: "", materials: [], entries: [] },
      mergedSources: sources.map((source) => ({
        path: source.file.path,
        title: source.file.basename,
        durationMs: source.rawDurationMs,
      })),
    };
    const lastSeg = segments[segments.length - 1];
    const sessionMeta = {
      startedAt: session.startedAt,
      duration: lastSeg ? formatElapsed(lastSeg.endOffsetMs || 0) : "",
      source: "merged-notes",
      meetingWorkbench: normalizeMeetingWorkbench(session.meetingWorkbench),
    };
    const polished = await this.host.mergeAndPolish(segments.map((segment) => ({ ...segment })), mode, sessionMeta);
    await this.rewriteConsolidated(session, polished);
    await this.host.clearCommittedBriefingCheckpoint(sessionMeta);
    let finalFile = this.host.vault.getAbstractFileByPath(session.mdPath);
    const renamed = await this.renameMarkdownWithGeneratedTitle(session.mdPath, polished, mode);
    if (renamed instanceof obsidian.TFile) {
      session.mdPath = renamed.path;
      finalFile = renamed;
    }
    if (finalFile instanceof obsidian.TFile) {
      await this.appendMergeMetadataBlock(finalFile, session.mergedSources);
      await this.host.noteIndex.refreshNoteIndexSafely(finalFile, {
        meetingDate: session.startedAt,
        reason: "merge-notes",
      });
      try { await this.host.openFile(finalFile); } catch { /* intentionally empty */ }
    }
    new obsidian.Notice(`${t("Generated merged minutes: ")}${finalFile instanceof obsidian.TFile ? finalFile.basename : getModeMeta({}, "synthesis").prefix}`);
  }
  async appendMergeMetadataBlock(file, sources) {
    if (!(file instanceof obsidian.TFile)) return;
    const payload = {
      mergedAt: new Date().toISOString(),
      sources: (sources || []).map((source) => ({
        path: source.path || "",
        title: source.title || "",
        durationMs: Number(source.durationMs) || 0,
      })),
    };
    const block = `${nsMarker("merge")}\n${JSON.stringify(payload, null, 2)}\n${NS_TAG}-merge-end -->`;
    const cur = await this.host.vault.read(file);
    if (NS_MERGE_BLOCK_RE.test(cur)) {
      await this.host.vault.modify(file, cur.replace(NS_MERGE_BLOCK_RE, block));
    } else {
      await this.host.vault.modify(file, cur.replace(/\s*$/, "\n\n" + block + "\n"));
    }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
