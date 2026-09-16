/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：笔记正文写入：整合版重写与追加、分段标记插入、重新整理、合并历史笔记

import * as obsidian from "obsidian";
import { qnalogConfirm } from "../ui/helpers";
import { isKnownPolishMode, getModeMeta, getEffectivePolishMode } from "../shared/mode-meta";
import { splitOutSedimentBlock } from "../sediment";
import { NoteIndexService } from "./note-index-service";
import { formatLlmFailureIssue, stripModeSuggestionBlocks } from "../llm/core";
import type { PluginSettings } from "../shared/types";
import { genId, formatElapsed } from "../shared/util-common";
import { getTranscribeSegmentPlaceholder } from "../shared/util-audio";
import { splitLeadingFrontmatter } from "../version-content";
import { buildEmptyLlmOutputFallback, clearCommittedBriefingCheckpoint } from "../prompts/briefing-prompts";
import { buildRealtimeOutlineDetails } from "../notes/realtime-outline";
import { normalizeMeetingWorkbench } from "../notes/meeting-workbench";
import { buildExternalAudioSourceDetails, buildMasterAudioDetails, buildMeetingWorkbenchDetails, buildPlaybackTimelineDetails, buildRecordingInfoDetails, buildTextImportInfoDetails, buildTextImportSourceDetails } from "../notes/detail-blocks";
import { getAudioSegmentListItem, getAudioTimeLink, getDurationMs, getSegmentsDurationMs, getSegmentAudioLinkOffsetMs } from "../notes/audio-refs";
import { buildRenamedMarkdownPath, extractAllRawBlocksFromText, extractTranscriptSegments, generateTitleTag, inferNoteStartedAtIso, isTextImportSession, normalizeSegmentsForMergedNote } from "../notes/note-markdown";
import { detectRecentModeFromFilename, getRecentNotes } from "../recent/recent-notes";
import { mergeAndPolish, polishTranscript } from "../briefing/merge-pipeline";
import { ensureVaultFolder, findAvailableMarkdownPath } from "../shared/util-vault";
import { NS_MERGE_BLOCK_RE, NS_TAG, nsMarker } from "../shared/namespace";

import { t } from "../shared/i18n";
/** NoteWriter 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface NoteWriterHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  /** 笔记索引与当日概要服务。 */
  noteIndex: NoteIndexService;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
}

export class NoteWriter {
  declare host: NoteWriterHost;
  constructor(host) {
    this.host = host;
  }

  async appendRepolishBlock(file, polished, mode, segments) {
    const meta = getModeMeta(this.host.settings, mode);
    const stamp = window.moment ? window.moment().format("YYYY-MM-DD HH:mm:ss") : new Date().toISOString();
    const cur = await this.host.app.vault.read(file);

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
      (polishedFrontmatter || beforeParts.frontmatter) ? "" : null,
      titleBlock ? titleBlock.trimEnd() : null,
      titleBlock ? "" : null,
      `## 当前纪要（${meta.prefix} · ${stamp}）`,
      "",
      `> [!info] 基于本文底部的原始转写重新生成 · 段数：${segments.length} · 模型：${this.host.settings.llmModel}`,
      "",
      polishedBody,
      "",
      "---",
      "",
      "<details>",
      `<summary>上一版纪要（重新整理前 · ${stamp}）</summary>`,
      "",
      previousBody || "_（上一版为空）_",
      "",
      "</details>",
      "",
      rawTail ? rawTail.trimEnd() : "",
      "",
    ].filter(v => v !== null).join("\n");

    await this.host.app.vault.modify(file, currentBlock.replace(/\n{4,}/g, "\n\n\n"));
  }
  async rewriteConsolidated(session, polished) {
    const file = this.host.app.vault.getAbstractFileByPath(session.mdPath);
    if (!(file instanceof obsidian.TFile)) return;
    const meta = getModeMeta(this.host.settings, session.mode);
    const moment = window.moment;
    const startedAt = moment(session.startedAt);
    const totalMs = session.segments.length ? session.segments[session.segments.length - 1].endOffsetMs : 0;
    const textImport = isTextImportSession(session);
    const externalAudioImport = !!session.externalAudioSource;
    const retainAudio = !textImport && !externalAudioImport;
    const masterAudioBlock = retainAudio && !session.multiSourceAudio ? buildMasterAudioDetails(session, totalMs) : "";
    const audioRow = masterAudioBlock || session.segments.map((s, i) => getAudioSegmentListItem(s, i)).filter(Boolean).join("\n");
    const realtimeOutlineBlock = buildRealtimeOutlineDetails(session);
    const playbackTimelineBlock = retainAudio ? buildPlaybackTimelineDetails(session) : "";
    const meetingWorkbenchBlock = buildMeetingWorkbenchDetails(session);
    const recordingInfoBlock = textImport ? buildTextImportInfoDetails(session, meta.prefix, this.host.settings.llmModel) : buildRecordingInfoDetails({
      startedAt: session.startedAt,
      totalMs,
      modeLabel: meta.prefix,
      segmentCount: session.segments.length,
      model: this.host.settings.llmModel,
    });
    const textImportSourceBlock = textImport ? buildTextImportSourceDetails(session) : "";
    const externalAudioSourceBlock = externalAudioImport ? buildExternalAudioSourceDetails(session) : "";

    const rawBlocks = textImport ? "" : session.segments.map(s => {
      const n = s.index + 1;
      const head = `### 段落 ${n} (${formatElapsed(s.startOffsetMs)}–${formatElapsed(s.endOffsetMs)}) ${getAudioTimeLink(s.audioName, getSegmentAudioLinkOffsetMs(s))}${s.isFinal ? " · 结束" : ""}`;
      const marker = s.queueTaskId ? `${nsMarker("transcribe-task", s.queueTaskId)}\n` : "";
      const body = s.error
        ? getTranscribeSegmentPlaceholder(s.error, { retryable: !!s.queueTaskId })
        : (s.text || "_[此段无内容]_");
      return `${head}\n\n${marker}${body}\n`;
    }).join("\n");

    const emptyBriefingFallback = buildEmptyLlmOutputFallback();
    const polishedParts = splitLeadingFrontmatter(polished || emptyBriefingFallback);
    const polishedFrontmatter = polishedParts.frontmatter ? polishedParts.frontmatter.trimEnd() : "";
    // 把沉淀元数据注释从正文末尾拆出来，稍后挪到整篇笔记最末尾（不再夹在正文与原始材料之间）。
    const sediment = splitOutSedimentBlock(polishedParts.body);
    const polishedBody = sediment.body.trim() || emptyBriefingFallback;

    const content = [
      polishedFrontmatter || null,
      polishedFrontmatter ? "" : null,
      `# ${startedAt.format("YYYY-MM-DD HH:mm")} · ${meta.prefix}`,
      "",
      polishedBody,
      "",
      "---",
      "",
      "## 原始材料",
      "",
      recordingInfoBlock || null,
      recordingInfoBlock ? "" : null,
      externalAudioSourceBlock || null,
      externalAudioSourceBlock ? "" : null,
      meetingWorkbenchBlock || null,
      meetingWorkbenchBlock ? "" : null,
      realtimeOutlineBlock || null,
      realtimeOutlineBlock ? "" : null,
      textImport ? textImportSourceBlock || null : playbackTimelineBlock || null,
      textImport ? (textImportSourceBlock ? "" : null) : (playbackTimelineBlock ? "" : null),
      retainAudio ? (masterAudioBlock ? null : "<details>") : null,
      retainAudio ? (masterAudioBlock ? null : `<summary>原始音频（${session.segments.length} 段，${formatElapsed(totalMs)}）</summary>`) : null,
      retainAudio ? "" : null,
      retainAudio ? audioRow : null,
      retainAudio ? "" : null,
      retainAudio ? (masterAudioBlock ? null : "</details>") : null,
      retainAudio ? "" : null,
      textImport ? null : "<details>",
      textImport ? null : `<summary>分段原始转写（${session.segments.length} 段）</summary>`,
      textImport ? null : "",
      textImport ? null : rawBlocks,
      textImport ? null : "</details>",
      textImport ? null : "",
      nsMarker("session", session.id),
      "",
      // 沉淀元数据放最末尾（HTML 注释，阅读视图隐藏；挪到此处后编辑模式也不再夹在正文中间）。
      sediment.block || null,
      sediment.block ? "" : null,
    ].filter(v => v !== null).join("\n");

    await this.host.app.vault.modify(file, content);
  }
  async appendPolishBlock(session, polished, mergeError, nonRetryableMergeError = false) {
    const file = this.host.app.vault.getAbstractFileByPath(session.mdPath);
    if (!(file instanceof obsidian.TFile)) return;
    const totalMs = session.segments.length ? session.segments[session.segments.length - 1].endOffsetMs : 0;
    const meta = getModeMeta(this.host.settings, session.mode);
    const emptyBriefingFallback = buildEmptyLlmOutputFallback();
    const polishedParts = splitLeadingFrontmatter(polished || emptyBriefingFallback);
    const polishedFrontmatter = polishedParts.frontmatter ? polishedParts.frontmatter.trimEnd() : "";
    // 沉淀元数据从正文拆出，挪到本块最末尾，避免夹在正文与原始材料之间。
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
      modeLabel: meta.prefix,
      segmentCount: session.segments.length,
      model: this.host.settings.llmModel,
    });
    const textImportSourceBlock = textImport ? buildTextImportSourceDetails(session) : "";
    const externalAudioSourceBlock = externalAudioImport ? buildExternalAudioSourceDetails(session) : "";
    const masterAudioBlock = retainAudio && !session.multiSourceAudio ? buildMasterAudioDetails(session, totalMs) : "";
    const meetingWorkbenchBlock = buildMeetingWorkbenchDetails(session);
    const failureText = mergeError
      ? (nonRetryableMergeError
        ? `_[AI 整理失败：${formatLlmFailureIssue(mergeError.message || mergeError)}]_`
        : `_[合并润色失败（已加入重试队列）：${mergeError.message || mergeError}]_`)
      : "";
    const block = [
      "",
      `## 整合版（${this.host.settings.llmModel} · ${meta.prefix}）`,
      "",
      mergeError ? failureText : polishedBody,
      "",
      recordingInfoBlock || null,
      recordingInfoBlock ? "" : null,
      externalAudioSourceBlock || null,
      externalAudioSourceBlock ? "" : null,
      textImport ? textImportSourceBlock || null : masterAudioBlock || null,
      textImport ? (textImportSourceBlock ? "" : null) : (masterAudioBlock ? "" : null),
      meetingWorkbenchBlock || null,
      meetingWorkbenchBlock ? "" : null,
      realtimeOutlineBlock || null,
      realtimeOutlineBlock ? "" : null,
      textImport ? null : playbackTimelineBlock || null,
      textImport ? null : (playbackTimelineBlock ? "" : null),
      "---",
      "",
      // 沉淀元数据放本整合块最末尾（HTML 注释，阅读视图隐藏）。
      sediment.block || null,
      sediment.block ? "" : null,
    ].filter(v => v !== null).join("\n");
    let cur = await this.host.app.vault.read(file);
    if (polishedFrontmatter && !mergeError) {
      const currentParts = splitLeadingFrontmatter(cur);
      cur = polishedFrontmatter + "\n\n" + currentParts.body.replace(/^\n+/, "");
    }
    const sep = cur.endsWith("\n") ? "" : "\n";
    let next = cur + sep + block;
    // 标题占位 `（录音中…）` 用全角括号；旧 regex 的 `\)?` 是半角，匹配不到全角 `）`，
    // 导致只替换"录音中…"留下原 `）` + 新拼的 `）` → 双括号 `（19:44））`。
    // 用 [)）]? 同时吃掉半/全角收尾括号，替换后只补一个全角 `）`。
    if (!textImport) next = next.replace(/录音中…[)）]?/g, `${formatElapsed(totalMs)}）`);
    await this.host.app.vault.modify(file, next);
  }
  async appendToNote(path, content) {
    const existing = this.host.app.vault.getAbstractFileByPath(path);
    if (existing instanceof obsidian.TFile) {
      const cur = await this.host.app.vault.read(existing);
      const sep = cur.endsWith("\n") ? "" : "\n";
      await this.host.app.vault.modify(existing, cur + sep + content);
    } else {
      await this.host.app.vault.create(path, content);
    }
  }
  // 把内容插到 segments-start marker 之前（即分段转写区上方），用于录音期把会中生成的提纲放在段落之上。
  async insertBeforeSegmentsStart(path, content, sessionId) {
    const file = this.host.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof obsidian.TFile)) return this.appendToNote(path, content);
    const cur = await this.host.app.vault.read(file);
    const marker = nsMarker("segments-start", sessionId || undefined);
    const idx = cur.indexOf(marker);
    if (idx >= 0) {
      const next = cur.slice(0, idx) + content + "\n" + cur.slice(idx);
      await this.host.app.vault.modify(file, next);
      return;
    }
    await this.appendToNote(path, content);
  }
  async insertBeforeSegmentsEnd(path, content, sessionId) {
    const file = this.host.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof obsidian.TFile)) return this.appendToNote(path, content);
    const cur = await this.host.app.vault.read(file);
    const specific = sessionId ? nsMarker("segments-end", sessionId) : null;
    if (specific && cur.includes(specific)) {
      const next = cur.replace(specific, `${content}\n${specific}`);
      await this.host.app.vault.modify(file, next);
      return;
    }
    const legacy = nsMarker("segments-end");
    const lastIdx = cur.lastIndexOf(legacy);
    if (lastIdx >= 0) {
      const next = cur.slice(0, lastIdx) + content + "\n" + cur.slice(lastIdx);
      await this.host.app.vault.modify(file, next);
      return;
    }
    await this.appendToNote(path, content);
  }
  async removeEmptySessionBlock(session) {
    const file = this.host.app.vault.getAbstractFileByPath(session.mdPath);
    if (!(file instanceof obsidian.TFile)) return;
    const cur = await this.host.app.vault.read(file);
    const sessMarker = nsMarker("session", session.id);
    const endMarker = nsMarker("segments-end", session.id);
    const sessIdx = cur.indexOf(sessMarker);
    const endIdx = cur.indexOf(endMarker);
    if (sessIdx < 0 || endIdx < sessIdx) return;
    const headerLineIdx = cur.lastIndexOf("\n## ", sessIdx);
    const h1LineIdx = cur.lastIndexOf("\n# ", sessIdx);
    const startIdx = Math.max(headerLineIdx, h1LineIdx);
    const blockStart = startIdx >= 0 ? startIdx + 1 : 0;
    const blockEnd = endIdx + endMarker.length;
    const before = cur.slice(0, blockStart).replace(/\n+$/, "\n");
    const after = cur.slice(blockEnd).replace(/^\n+/, "");
    const next = before + (after ? "\n" + after : "");
    if (next !== cur) await this.host.app.vault.modify(file, next);
  }

  async renameMarkdownWithGeneratedTitle(fileOrPath, polished, mode) {
    if (!this.host.settings.autoRenameWithTitle || !polished || mode === "off") return null;
    const file = typeof fileOrPath === "string"
      ? this.host.app.vault.getAbstractFileByPath(fileOrPath)
      : fileOrPath;
    if (!(file instanceof obsidian.TFile)) return null;
    try {
      const tag = await generateTitleTag(this.host, polished, mode);
      if (!tag) return file;
      const target = buildRenamedMarkdownPath(file.path, mode, tag, this.host.settings);
      const newPath = findAvailableMarkdownPath(this.host.app, target, file.path);
      if (!newPath || obsidian.normalizePath(newPath) === obsidian.normalizePath(file.path)) return file;
      await this.host.app.fileManager.renameFile(file, newPath);
      const renamed = this.host.app.vault.getAbstractFileByPath(newPath);
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
      const polished = await polishTranscript(this.host, raw, mode, null, null, null);
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
    const cache = (this.host.app.metadataCache.getFileCache(file) || {}).frontmatter;
    if (!cache) {
      const fallbackMode = detectRecentModeFromFilename(this.host.settings, file.basename);
      return fallbackMode && fallbackMode !== "off" ? fallbackMode : null;
    }
    const m = cache.mode;
    if (typeof m === "string" && isKnownPolishMode(this.host.settings, m)) return m;
    const typeStr = String(cache["类型"] || cache.type || "").trim();
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
    const recents = getRecentNotes(this.host, 240);
    const current = recents.find((item) => item && item.file && obsidian.normalizePath(item.file.path) === currentPath);
    if (!current) return null;
    const older = recents
      .filter((item) => item && item.file && obsidian.normalizePath(item.file.path) !== currentPath && item.timestamp < current.timestamp)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    return older && older.file instanceof obsidian.TFile ? older.file : null;
  }
  async readMergeSourceFromMarkdown(file, offsetMs, startIndex) {
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") {
      throw new Error("只能合并 Q&A Log Markdown 纪要");
    }
    const content = await this.host.app.vault.read(file);
    const rawSegments = extractTranscriptSegments(content);
    if (!rawSegments.length) {
      throw new Error(`「${file.basename}」没有找到原始转写分段`);
    }
    const frontmatter = ((this.host.app.metadataCache.getFileCache(file) || {}).frontmatter) || {};
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
      new obsidian.Notice(t("No most recent Q&A Log summary before this one was found."), 6000);
      return;
    }
    const ok = await qnalogConfirm(this.host.app, "合并纪要", `将生成一篇新的合并纪要，源文件会保留。\n\n来源：\n1. ${previous.basename}\n2. ${file.basename}\n\n继续合并？`, "合并");
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
    await ensureVaultFolder(this.host.app, this.host.settings.mdFolder);
    const moment = window.moment;
    const startedAtIso = sources[0].startedAt || new Date().toISOString();
    const startedAt = moment ? moment(startedAtIso) : null;
    const stamp = startedAt && startedAt.isValid && startedAt.isValid()
      ? startedAt.format(this.host.settings.noteFileNameFormatNew)
      : (moment ? moment().format(this.host.settings.noteFileNameFormatNew) : "合并纪要");
    const targetPath = findAvailableMarkdownPath(this.host.app, obsidian.normalizePath(`${this.host.settings.mdFolder}/${stamp} · 合并.md`));
    if (!targetPath) throw new Error("无法生成合并纪要路径");

    new obsidian.Notice(`${t("Q&A Log: merging ")}${sources.length}${t(" minutes notes...")}`, 8000);
    await this.host.app.vault.create(targetPath, "");
    const session = {
      id: genId(),
      sessionStamp: moment ? moment().format("YYYYMMDD-HHmmss") : String(Date.now()),
      mdPath: targetPath,
      mode,
      startedAt: startedAtIso,
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
    const polished = await mergeAndPolish(this.host, segments.map((s) => ({
      index: s.index,
      startOffsetMs: s.startOffsetMs,
      endOffsetMs: s.endOffsetMs,
      text: s.text,
      audioName: s.audioName,
      audioStartOffsetMs: s.audioStartOffsetMs,
      audioEndOffsetMs: s.audioEndOffsetMs,
      sourceName: s.sourceName,
      sourcePath: s.sourcePath,
      sourceUrl: s.sourceUrl,
      rawText: s.rawText,
    })), mode, null, sessionMeta);
    await this.rewriteConsolidated(session, polished);
    await clearCommittedBriefingCheckpoint(this.host, sessionMeta);
    let finalFile = this.host.app.vault.getAbstractFileByPath(session.mdPath);
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
      try { await this.host.app.workspace.getLeaf(false).openFile(finalFile); } catch { /* intentionally empty */ }
    }
    try { await this.host.noteIndex.appendDailyMeetingOverview(session, polished); }
    catch (e) { console.error("[QnALog] daily overview after merge notes failed", e); }
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
    const cur = await this.host.app.vault.read(file);
    if (NS_MERGE_BLOCK_RE.test(cur)) {
      await this.host.app.vault.modify(file, cur.replace(NS_MERGE_BLOCK_RE, block));
    } else {
      await this.host.app.vault.modify(file, cur.replace(/\s*$/, "\n\n" + block + "\n"));
    }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
