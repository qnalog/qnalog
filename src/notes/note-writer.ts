/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：笔记正文写入：整合版重写与追加、分段标记插入、重新整理、合并历史笔记

import * as obsidian from "obsidian";
import { isKnownPolishMode, getModeMeta, getModePrefix, getEffectivePolishMode } from "../shared/mode-meta";
import type { NoteIndexService } from "./note-index-service";
import { formatLlmFailureIssue } from "../llm/failure-presentation";
import type { PluginSettings, RecordingSession, Segment, SessionMetaForMerge } from "../shared/types";
import { buildEmptyLlmOutputFallback } from "../prompts/briefing-prompts";
import { getAudioTimeLink } from "../notes/audio-reference-text";
import { getAudioSegmentListItem, getDurationMs, getSegmentsDurationMs, getSegmentAudioLinkOffsetMs } from "../notes/audio-refs";
import { getFrontmatterTags } from "../shared/util-note";
import { buildRenamedMarkdownPath, ensureTranscriptBlocks, extractTranscriptSegments, getSourceIdFromMarkdown, inferNoteStartedAtIso, normalizeSegmentsForMergedNote } from "./note-markdown";
import { normalizeModeFromLabel } from "../shared/mode-label";
import { detectRecentModeFromFilename } from "../recent/recent-note-mode";
import { detectModeFromMarkdownFlow, type NoteModeInferenceHost } from "./note-mode-inference";

import { shouldRewriteConsolidatedNote } from "../briefing/note-layout-policy";
import { commitContinuationFlow, type ContinuationCommitFlowHost } from "./continuation-commit-flow";
import { serializeContinuationSegmentBlock } from "./note-transcript-materials";
import { rewriteConsolidatedFlow, appendPolishBlockFlow, type NotePolishFlowHost } from "./note-polish-flow";
import { polishEditorFlow, type NoteEditorPolishFlowHost, type NotePolishEditor } from "./note-editor-polish-flow";
import { replaceRealtimeOutlineNote, type OutlineNoteStoreHost, type RealtimeOutlineReplacementResult } from "./outline-note-store";
import {
  readMergeSourceFlow,
  type NoteMergeSource,
  type NoteMergeSourceFlowHost,
} from "./note-merge-source-flow";
import {
  mergeMarkdownFilesAsNewFlow,
  type NoteMergeFlowHost,
  type NoteMergeMoment,
  type NoteMergeSourceMetadata,
} from "./note-merge-flow";
import {
  findPreviousRecentNoteFileFlow,
  mergeMarkdownFileWithPreviousFlow,
  type NoteMergePreviousFlowHost,
} from "./note-merge-previous-flow";
import { writeMergeMetadataBlock, type NoteMergeMetadataStoreHost } from "./note-merge-metadata-store";
import {
  renameMarkdownWithGeneratedTitleFlow,
  type NoteTitleRenameFlowHost,
} from "./note-title-rename-flow";
import {
  appendNoteText,
  insertBeforeSessionSegmentsEnd,
  insertBeforeSessionSegmentsStart,
  removeSessionNoteBlock,
  type NoteSegmentStoreHost,
} from "./note-segment-store";




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
  private readonly noteModeInferenceHost: NoteModeInferenceHost;
  private readonly notePolishFlowHost: NotePolishFlowHost;
  private readonly continuationCommitHost: ContinuationCommitFlowHost;
  private readonly outlineNoteStoreHost: OutlineNoteStoreHost;
  private readonly noteMergeSourceFlowHost: NoteMergeSourceFlowHost;
  private readonly noteMergeFlowHost: NoteMergeFlowHost;
  private readonly noteTitleRenameFlowHost: NoteTitleRenameFlowHost;
  private readonly noteSegmentStoreHost: NoteSegmentStoreHost;
  private readonly noteMergeMetadataStoreHost: NoteMergeMetadataStoreHost;
  private readonly noteMergePreviousFlowHost: NoteMergePreviousFlowHost;
  private readonly noteEditorPolishFlowHost: NoteEditorPolishFlowHost;
  constructor(host: NoteWriterHost) {
    this.host = host;
    this.noteEditorPolishFlowHost = {
      getMode: () => getEffectivePolishMode(
        this.host.settings,
        this.host.settings.polishMode === "off" ? "meeting" : this.host.settings.polishMode,
      ),
      polishTranscript: (raw, mode) => this.host.polishTranscript(raw, mode),
    };
    this.noteModeInferenceHost = {
      getFileFrontmatter: (file) => this.host.getFileFrontmatter(file),
      getTags: (frontmatter) => getFrontmatterTags(frontmatter),
      normalizeLabel: (label) => normalizeModeFromLabel(this.host.settings, label),
      isKnownMode: (mode) => isKnownPolishMode(this.host.settings, mode),
      inferFilename: (basename) => detectRecentModeFromFilename(this.host.settings, basename),
      getCleanFallbackMode: () => getEffectivePolishMode(
        this.host.settings,
        this.host.settings.polishMode === "off" ? "meeting" : this.host.settings.polishMode,
      ),
    };
    this.noteMergePreviousFlowHost = {
      getRecentNotes: (limit) => this.host.getRecentNotes(limit),
      findPrevious: (file) => this.findPreviousRecentNoteFile(file),
      confirm: (title, body, ctaText) => this.host.confirm(title, body, ctaText),
      mergeFiles: (files) => this.mergeMarkdownFilesAsNew(files),
    };
    this.noteTitleRenameFlowHost = {
      getAutoRenameWithTitle: () => this.host.settings.autoRenameWithTitle,
      getVault: () => this.host.vault,
      generateTitleTag: (polished, mode) => this.host.generateTitleTag(polished, mode),
      buildTargetPath: (path, mode, tag) => buildRenamedMarkdownPath(path, mode, tag, this.host.settings),
      findAvailableMarkdownPath: (target, current) => this.host.findAvailableMarkdownPath(target, current),
      renameFile: (file, path) => this.host.renameFile(file, path),
    };
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
    this.noteMergeFlowHost = {
      readSource: (file, offsetMs, startIndex) => this.readMergeSourceFromMarkdown(file, offsetMs, startIndex),
      getFallbackMode: () => getEffectivePolishMode(this.host.settings, this.host.settings.polishMode),
      getMarkdownFolder: () => this.host.settings.mdFolder,
      getNoteFileNameFormat: () => this.host.settings.noteFileNameFormatNew,
      getMoment: () => (window as unknown as { moment?: NoteMergeMoment | null }).moment,
      ensureFolder: (path) => this.host.ensureFolder(path),
      findAvailableMarkdownPath: (path) => this.host.findAvailableMarkdownPath(path),
      getVault: () => this.host.vault,
      mergeAndPolish: (segments, mode, meta) => this.host.mergeAndPolish(segments, mode, meta),
      rewrite: (session, polished) => this.rewriteConsolidated(session, polished),
      clearCheckpoint: (meta) => this.host.clearCommittedBriefingCheckpoint(meta),
      rename: async (path, polished, mode) => {
        const renamed = await this.renameMarkdownWithGeneratedTitle(path, polished, mode);
        return renamed instanceof obsidian.TFile ? renamed : null;
      },
      appendMetadata: (file, metadata) => this.appendMergeMetadataBlock(file, metadata),
      refreshIndex: async (file, meetingDate) => {
        await this.host.noteIndex.refreshNoteIndexSafely(file, { meetingDate, reason: "merge-notes" });
      },
      openFile: (file) => this.host.openFile(file),
      getFallbackPrefix: () => getModeMeta({}, "synthesis").prefix,
      getFallbackFilename: () => "合并纪要",
    };
    this.outlineNoteStoreHost = { getVault: () => this.host.vault };
    this.noteMergeMetadataStoreHost = { getVault: () => this.host.vault };
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

  renameMarkdownWithGeneratedTitle(
    fileOrPath: unknown,
    polished: string,
    mode: string,
  ): Promise<obsidian.TFile | null> {
    return renameMarkdownWithGeneratedTitleFlow(this.noteTitleRenameFlowHost, fileOrPath, polished, mode);
  }
  polishEditor(editor: NotePolishEditor): Promise<void> {
    return polishEditorFlow(this.noteEditorPolishFlowHost, editor);
  }
  detectModeFromMarkdown(file: unknown): string | null {
    return detectModeFromMarkdownFlow(this.noteModeInferenceHost, file);
  }
  findPreviousRecentNoteFile(file: unknown): obsidian.TFile | null {
    return findPreviousRecentNoteFileFlow(this.noteMergePreviousFlowHost, file);
  }
  readMergeSourceFromMarkdown(file: unknown, offsetMs: number, startIndex: number): Promise<NoteMergeSource> {
    return readMergeSourceFlow(this.noteMergeSourceFlowHost, file, offsetMs, startIndex);
  }
  mergeMarkdownFileWithPrevious(file: unknown): Promise<void> {
    return mergeMarkdownFileWithPreviousFlow(this.noteMergePreviousFlowHost, file);
  }
  mergeMarkdownFilesAsNew(files: Iterable<unknown> | null | undefined): Promise<void> {
    return mergeMarkdownFilesAsNewFlow(this.noteMergeFlowHost, files);
  }
  appendMergeMetadataBlock(
    file: unknown,
    sources: readonly NoteMergeSourceMetadata[] | null | undefined,
  ): Promise<void> {
    return writeMergeMetadataBlock(this.noteMergeMetadataStoreHost, file, sources);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
