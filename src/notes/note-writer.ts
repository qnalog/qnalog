/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：笔记正文写入：整合版重写与追加、分段标记插入、重新整理、合并历史笔记

import * as obsidian from "obsidian";
import { isKnownPolishMode, getModeMeta, getModePrefix, getEffectivePolishMode } from "../shared/mode-meta";
import type { NoteIndexService } from "./note-index-service";
import { formatLlmFailureIssue, stripModeSuggestionBlocks } from "../llm/core";
import type { PluginSettings, RecordingSession, Segment, SessionMetaForMerge } from "../shared/types";
import { genId, formatElapsed } from "../shared/util-common";
import { extractAllRawBlocksFromText, splitLeadingFrontmatter } from "./note-document";
import { buildEmptyLlmOutputFallback } from "../prompts/briefing-prompts";
import { normalizeMeetingWorkbench } from "../notes/meeting-workbench-state";
import { getAudioTimeLink } from "../notes/audio-reference-text";
import { getAudioSegmentListItem, getDurationMs, getSegmentsDurationMs, getSegmentAudioLinkOffsetMs } from "../notes/audio-refs";
import { getFrontmatterTags } from "../shared/util-note";
import { buildRenamedMarkdownPath, ensureTranscriptBlocks, extractTranscriptSegments, getSourceIdFromMarkdown, inferNoteStartedAtIso, normalizeModeFromLabel, normalizeSegmentsForMergedNote } from "./note-markdown";
import { detectRecentModeFromFilename } from "../recent/recent-notes";
import { NS_MERGE_BLOCK_RE, NS_TAG, nsMarker, readNamespaceFrontmatter } from "../shared/namespace";
import { labelText } from "../shared/note-labels";

import { shouldRewriteConsolidatedNote } from "../briefing/note-layout-policy";
import { commitContinuationFlow, type ContinuationCommitFlowHost } from "./continuation-commit-flow";
import { serializeContinuationSegmentBlock } from "./note-transcript-materials";
import { rewriteConsolidatedFlow, appendPolishBlockFlow, type NotePolishFlowHost } from "./note-polish-flow";
import { replaceRealtimeOutlineNote, type OutlineNoteStoreHost, type RealtimeOutlineReplacementResult } from "./outline-note-store";
import {
  readMergeSourceFlow,
  type NoteMergeSource,
  type NoteMergeSourceFlowHost,
} from "./note-merge-source-flow";
import {
  appendNoteText,
  insertBeforeSessionSegmentsEnd,
  insertBeforeSessionSegmentsStart,
  removeSessionNoteBlock,
  type NoteSegmentStoreHost,
} from "./note-segment-store";

import { t } from "../shared/i18n";



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
  private readonly notePolishFlowHost: NotePolishFlowHost;
  private readonly continuationCommitHost: ContinuationCommitFlowHost;
  private readonly outlineNoteStoreHost: OutlineNoteStoreHost;
  private readonly noteMergeSourceFlowHost: NoteMergeSourceFlowHost;
  private readonly noteSegmentStoreHost: NoteSegmentStoreHost;
  constructor(host: NoteWriterHost) {
    this.host = host;
    this.notePolishFlowHost = {
      getVault: () => this.host.vault,
      getModeMeta: (session) => getModeMeta(this.host.settings, session.mode),
      getModePrefix: (meta) => getModePrefix(meta),
      getModel: () => this.host.settings.llmModel,
      getAudioSegmentListItem: (segment, index) => getAudioSegmentListItem(segment, index),
      getSegmentAudioLinkOffsetMs: (segment) => getSegmentAudioLinkOffsetMs(segment),
      buildEmptyBody: () => buildEmptyLlmOutputFallback(),
      formatFailureIssue: (issue) => formatLlmFailureIssue(issue),
    };
    this.noteMergeSourceFlowHost = {
      getVault: () => this.host.vault,
      getSourceIdFromMarkdown: (markdown, file) => getSourceIdFromMarkdown(markdown, file),
      ensureTranscriptBlocks: (markdown, sourceId) => ensureTranscriptBlocks(markdown, sourceId),
      extractTranscriptSegments: (markdown) => extractTranscriptSegments(markdown),
      getFileFrontmatter: (file) => this.host.getFileFrontmatter(file),
      getSegmentsDurationMs: (segments) => getSegmentsDurationMs(segments),
      getDurationMs: (markdown) => getDurationMs(markdown),
      normalizeSegmentsForMergedNote: (segments, offsetMs, startIndex, file) =>
        normalizeSegmentsForMergedNote(segments, offsetMs, startIndex, file),
      detectModeFromMarkdown: (file) => this.detectModeFromMarkdown(file),
      inferNoteStartedAtIso: (file, frontmatter) => inferNoteStartedAtIso(file, frontmatter),
    };
    this.outlineNoteStoreHost = { getVault: () => this.host.vault };
    this.noteSegmentStoreHost = {
      getVault: () => this.host.vault,
      appendToNote: (path, content) => this.appendToNote(path, content),
    };
    this.continuationCommitHost = {
      readTarget: async (mdPath) => {
        const file = this.host.vault.getAbstractFileByPath(mdPath);
        if (!(file instanceof obsidian.TFile)) throw new Error("Continuation target note is missing");
        return this.host.vault.read(file);
      },
      shouldRewrite: (session) => shouldRewriteConsolidatedNote(this.host.settings, session),
      serializeIncomingSegment: (segment) => serializeContinuationSegmentBlock(
        segment,
        getAudioTimeLink(segment.audioName, getSegmentAudioLinkOffsetMs(segment)),
      ),
      rewrite: (session, polished, continuationSessionId) => this.rewriteConsolidated(session, polished, continuationSessionId),
      append: (session, polished, continuationSessionId, initialMarkdown) => this.appendPolishBlock(
        session, polished, null, false, continuationSessionId, initialMarkdown,
      ),
    };
  }
  async readNoteMarkdown(file: obsidian.TFile): Promise<string> {
    return this.host.vault.read(file);
  }

  replaceRealtimeOutline(
    file: obsidian.TFile,
    expectedMarkdown: string,
    outlineDetails: string,
  ): Promise<RealtimeOutlineReplacementResult> {
    return replaceRealtimeOutlineNote(this.outlineNoteStoreHost, file, expectedMarkdown, outlineDetails);
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
  rewriteConsolidated(session: RecordingSession, polished: string, continuationSessionId = ""): Promise<void> {
    return rewriteConsolidatedFlow(this.notePolishFlowHost, session, polished, continuationSessionId);
  }
  appendPolishBlock(
    session: RecordingSession,
    polished: string,
    mergeError: unknown,
    nonRetryableMergeError = false,
    continuationSessionId = "",
    initialMarkdown: string | null = null,
  ): Promise<void> {
    return appendPolishBlockFlow(
      this.notePolishFlowHost,
      session,
      polished,
      mergeError,
      nonRetryableMergeError,
      continuationSessionId,
      initialMarkdown,
    );
  }

  async commitContinuation(session: RecordingSession, polished: string, committedSessionIds: readonly string[]): Promise<void> {
    return commitContinuationFlow(this.continuationCommitHost, session, polished, committedSessionIds);
  }

  appendToNote(path: string, content: string): Promise<void> {
    return appendNoteText(this.noteSegmentStoreHost, path, content);
  }
  // 把内容插到 segments-start marker 之前（即分段转写区上方），用于录音期把会中生成的提纲放在段落之上。
  insertBeforeSegmentsStart(path: string, content: string, sessionId?: string | null): Promise<void> {
    return insertBeforeSessionSegmentsStart(this.noteSegmentStoreHost, path, content, sessionId);
  }
  insertBeforeSegmentsEnd(path: string, content: string, sessionId?: string | null): Promise<void> {
    return insertBeforeSessionSegmentsEnd(this.noteSegmentStoreHost, path, content, sessionId);
  }
  removeEmptySessionBlock(session: Pick<RecordingSession, "mdPath" | "id">): Promise<void> {
    return removeSessionNoteBlock(this.noteSegmentStoreHost, session);
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
  readMergeSourceFromMarkdown(file: unknown, offsetMs: number, startIndex: number): Promise<NoteMergeSource> {
    return readMergeSourceFlow(this.noteMergeSourceFlowHost, file, offsetMs, startIndex);
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
    const sources: NoteMergeSource[] = [];
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
