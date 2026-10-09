import * as obsidian from "obsidian";
import type { AsrTranscriptResult } from "../asr/transcript-result";
import type { AudioChannelMode, Segment, TranscribeQueueTaskPayload } from "../shared/types";
import { MAX_SPEAKER_CHANNELS, initialAudioChannelRuntimeMode, normalizeAudioChannelMode } from "../audio/channel-speakers";
import { diagnosticError } from "../shared/util-key-diag";
import { escapeRegExp, formatElapsed } from "../shared/util-common";
import { getAudioTimeLink } from "../notes/audio-reference-text";
import { ensureTranscriptBlocks } from "../notes/note-transcript-ledger";
import { getSourceIdFromMarkdown } from "../notes/note-source-metadata";
import { findNoteMarkerOffset } from "../notes/note-document";
import { nsMarker, nsRe } from "../shared/namespace";
import { labelPattern, labelText } from "../shared/note-labels";
import { t } from "../shared/i18n";
import { attachTranscriptResult } from "../transcript/session-transcript";
import { readTranscriptBlocks, replaceTranscriptBlock, serializeTranscriptBlock } from "../transcript/transcript-markdown";
import type { AudioBlobSource } from "./transcribe-audio-source";

export type TranscribeRetryTask = TranscribeQueueTaskPayload & { id?: string };

export interface QueueTranscribeRetryPort {
  getVault(): Pick<obsidian.Vault, "getAbstractFileByPath" | "read" | "process">;
  runOnTarget<T>(target: obsidian.TFile, operation: () => Promise<T>): Promise<T>;
  readTaskAudio(task: TranscribeRetryTask): Promise<AudioBlobSource>;
  describeSegmentRetryUnavailable(): string;
  getAudioChannelMode(): AudioChannelMode | undefined;
  transcribeSegment(blob: Blob, mime: string): Promise<AsrTranscriptResult>;
  transcribeChannels(blob: Blob, mime: string, expectedChannelCount: number, options: { requireSeparatedChannels: boolean }): Promise<AsrTranscriptResult | null>;
  transcribeWhole(blob: Blob, mime: string, options: { providerId?: string; diarization: boolean; speakerCount?: number; fileName: string }): Promise<AsrTranscriptResult>;
  logDiagnostic(level: "warn" | "error", code: string, message: string, data: Record<string, unknown>): Promise<unknown>;
  refreshNoteIndex(file: obsidian.TFile, options: { reason: string }): Promise<unknown>;
  deleteSegmentCache(audioPath: string, taskId?: string, ephemeral?: boolean): Promise<unknown>;
  insertBeforeSegmentsEnd(mdPath: string, block: string, sessionId: string): Promise<unknown>;
  confirmSpeakerNames(session: { id: string; mdPath: string; source: string; importTranscribeProviderId?: string }, segments: { text: string }[]): Promise<unknown>;
  getQueueTasks(): readonly { id?: string; type?: string; mdPath?: string; continuation?: unknown; sessionId?: string }[];
  detectMode(file: obsidian.TFile): string | undefined;
  getDefaultPolishMode(): string;
  repolish(file: obsidian.TFile, mode: string): Promise<void>;
}

export async function retryTranscribeTask(port: QueueTranscribeRetryPort, task: TranscribeRetryTask): Promise<void> {
  const target = port.getVault().getAbstractFileByPath(task.mdPath);
  if (!(target instanceof obsidian.TFile)) return retryTranscribeTaskImpl(port, task);
  return port.runOnTarget(target, () => retryTranscribeTaskImpl(port, task));
}

async function retryTranscribeTaskImpl(port: QueueTranscribeRetryPort, task: TranscribeRetryTask): Promise<void> {
  const mdFile = port.getVault().getAbstractFileByPath(task.mdPath);
  const legacyFailMark = /_\[等待后台转写：[^\]]*\]_|_\[转写失败（空结果，已进入重试队列）\]_|_\[转写失败(?:（已进入重试队列）)?：[^\]]*\]_/;
  const failMark = new RegExp(`${labelPattern("waitingBackground").source}|${labelPattern("notFullyTranscribed").source}|${legacyFailMark.source}`);
  const taskMarker = task.id ? nsMarker("transcribe-task", task.id) : "";
  const taskPattern = taskMarker ? new RegExp(`${escapeRegExp(taskMarker)}\\s*(?:${failMark.source})`) : null;
  const segmentNumber = Math.max(0, Number(task.segmentIndex) || 0) + 1;
  const segmentStart = formatElapsed(Math.max(0, Number(task.startOffsetMs) || 0));
  const segmentEnd = formatElapsed(Math.max(Number(task.startOffsetMs) || 0, Number(task.endOffsetMs) || 0));
  const legacySegmentPattern = new RegExp(`((?:^|\\n)###\\s+(?:段落|Segment)\\s+${segmentNumber}\\s+\\(${escapeRegExp(segmentStart)}[–-]${escapeRegExp(segmentEnd)}\\)[^\\n]*\\n(?:\\s*\\n)?(?:<!--\\s*${nsRe("transcribe-task")}:[^>]+-->\\s*)?)(?:${failMark.source})`);
  const currentMarkdown = mdFile instanceof obsidian.TFile ? await port.getVault().read(mdFile) : "";
  const sourceId = String(task.sessionId || (mdFile instanceof obsidian.TFile ? getSourceIdFromMarkdown(currentMarkdown, mdFile) : task.mdPath || "note"));
  const sourceSegmentIndex = Math.max(0, Number(task.segmentIndex) || 0);
  const parentSegmentId = `seg:${encodeURIComponent(sourceId)}:${sourceSegmentIndex}`;
  const existingTranscriptBlocks = readTranscriptBlocks(currentMarkdown);
  const matchingTranscriptBlocks = existingTranscriptBlocks.filter((block) => block.segment.transcript?.id === parentSegmentId);
  if (matchingTranscriptBlocks.length > 1) throw new Error(`Multiple transcript blocks match source ${parentSegmentId}`);
  const existingTranscriptBlock = matchingTranscriptBlocks[0] || null;
  if (existingTranscriptBlock && !existingTranscriptBlock.segment.error && !failMark.test(existingTranscriptBlock.visibleBlock)) {
    if (mdFile instanceof obsidian.TFile) await port.refreshNoteIndex(mdFile, { reason: "transcript-retry-idempotent" });
    await port.deleteSegmentCache(task.audioPath, task.id);
    return;
  }
  if (!existingTranscriptBlock && taskMarker && currentMarkdown.includes(taskMarker) && !(taskPattern && taskPattern.test(currentMarkdown))) {
    if (mdFile instanceof obsidian.TFile) {
      const migrated = await port.getVault().process(mdFile, (latest) => ensureTranscriptBlocks(latest, sourceId, { reconcileEditedText: false }));
      if (migrated !== currentMarkdown) await port.refreshNoteIndex(mdFile, { reason: "transcript-retry-legacy-upgrade" });
    }
    await port.deleteSegmentCache(task.audioPath, task.id);
    return;
  }
  const audio = await port.readTaskAudio(task);
  let text = "";
  let transcriptionResult: AsrTranscriptResult | null = null;
  if (!task.wholeFileImport) {
    const streamingIssue = port.describeSegmentRetryUnavailable();
    if (streamingIssue) throw new Error(streamingIssue);
  }
  if (task.wholeFileImport) {
    const result = await port.transcribeWhole(audio.blob, audio.blob.type || "audio/wav", {
      providerId: task.providerId,
      diarization: task.speakerDiarization !== false,
      speakerCount: task.speakerCount,
      fileName: task.sourceAudioName || task.audioName || "import-audio",
    });
    transcriptionResult = result;
    text = result.text;
  } else {
    const reportedChannelCount = Math.max(1, Number(task.audioChannelCount) || 1);
    const channelMode = normalizeAudioChannelMode(task.audioChannelMode || port.getAudioChannelMode());
    const runtimeChannelMode = task.audioChannelRuntimeMode || initialAudioChannelRuntimeMode(channelMode, reportedChannelCount);
    const inspectRecordedChannels = task.captureMode === "mic" && runtimeChannelMode !== "mono";
    const expectedChannelCount = inspectRecordedChannels ? MAX_SPEAKER_CHANNELS : reportedChannelCount;
    const channelTranscription = inspectRecordedChannels
      ? await port.transcribeChannels(audio.blob, audio.blob.type || "audio/wav", expectedChannelCount, { requireSeparatedChannels: channelMode === "auto" && runtimeChannelMode === "probing" })
      : null;
    if (channelTranscription) {
      transcriptionResult = channelTranscription;
      text = channelTranscription.text;
    } else {
      transcriptionResult = await port.transcribeSegment(audio.blob, audio.blob.type || "audio/wav");
      text = transcriptionResult.text;
    }
  }
  if (!String(text || "").trim()) {
    await port.logDiagnostic("warn", "queue.transcribe_empty_result", t("Transcription retry returned empty text; treating it as a failure and re-queuing"), {
      mdPath: task.mdPath || "", audioName: task.audioName || "", startOffsetMs: task.startOffsetMs, endOffsetMs: task.endOffsetMs,
    });
    throw new Error(t("Transcription retry returned an empty result (the service responded HTTP 200 with no text)"));
  }
  if (!transcriptionResult) throw new Error(t("Transcription retry returned no structured result"));
  const segmentIndex = sourceSegmentIndex;
  const startOffsetMs = Math.max(0, Number(task.startOffsetMs) || 0);
  const endOffsetMs = Math.max(startOffsetMs, Number(task.endOffsetMs) || startOffsetMs);
  const sourceAudioName = String(task.masterAudioName || task.sourceAudioName || task.audioName || "");
  const masterAudioPath = String(task.masterAudioPath || task.sourceAudioPath || "");
  const discardClipPath = !!task.ephemeralAudio || !!audio.recovered;
  let replaced = false;
  let alreadyCommitted = false;
  let writtenSegment: Segment | null = null;
  const makeUpdatedSegment = (base: Segment | null): Segment => {
    const retainedBaseAudio = base?.audioPath && base.audioPath !== task.audioPath ? base.audioPath : "";
    const audioPath = masterAudioPath || retainedBaseAudio || (discardClipPath ? "" : base?.audioPath || task.audioPath || "");
    const segmentAudioPath = discardClipPath ? "" : base?.segmentAudioPath || task.audioPath || "";
    const segment: Segment = {
      ...(base || {}), index: base?.index ?? segmentIndex, startOffsetMs, endOffsetMs,
      audioStartOffsetMs: base?.audioStartOffsetMs ?? task.audioStartOffsetMs,
      audioEndOffsetMs: base?.audioEndOffsetMs ?? task.audioEndOffsetMs,
      audioName: audioPath ? (base?.audioName || sourceAudioName || task.audioName || "") : "", audioPath,
      segmentAudioName: segmentAudioPath ? (base?.segmentAudioName || task.audioName || "") : "", segmentAudioPath,
      text, error: null, isFinal: task.isFinal ?? base?.isFinal, source: base?.source || task.source || "recording", queueTaskId: task.id || base?.queueTaskId,
    };
    return attachTranscriptResult(segment, sourceId, transcriptionResult, "asr");
  };
  const makeTranscriptBlock = (segment: Segment): string => {
    const linkOffsetMs = masterAudioPath ? Math.max(0, Number(task.audioStartOffsetMs) || 0) : 0;
    const heading = [`### ${labelText("segment", segmentNumber)} (${formatElapsed(startOffsetMs)}–${formatElapsed(endOffsetMs)}) ${getAudioTimeLink(sourceAudioName, linkOffsetMs)}`, taskMarker].filter(Boolean).join("\n\n");
    return `\n${serializeTranscriptBlock(segment, heading, text)}\n`;
  };
  const findTarget = (blocks: ReturnType<typeof readTranscriptBlocks>) => {
    const matches = blocks.filter((block) => block.segment.transcript?.id === parentSegmentId || (!!task.id && block.segment.queueTaskId === task.id));
    if (matches.length > 1) throw new Error(`Multiple transcript blocks match source ${parentSegmentId}`);
    if (matches.length === 1 && matches[0].segment.transcript?.id !== parentSegmentId) throw new Error(`Transcript task ${task.id} points to a different source ID`);
    return matches[0] || null;
  };
  if (mdFile instanceof obsidian.TFile) {
    await port.getVault().process(mdFile, (latest) => {
      const latestBlocks = readTranscriptBlocks(latest);
      let target = findTarget(latestBlocks);
      if (target && !target.segment.error && !failMark.test(target.visibleBlock)) { alreadyCommitted = true; return latest; }
      let candidate = latest;
      if (!target) {
        if (taskPattern && taskPattern.test(candidate)) candidate = candidate.replace(taskPattern, () => `${taskMarker}\n${text}`);
        else {
          const legacyMatch = legacySegmentPattern.exec(candidate);
          if (legacyMatch) {
            const prefix = legacyMatch[1];
            const addMarker = taskMarker && !prefix.includes(taskMarker) ? `${taskMarker}\n` : "";
            candidate = candidate.replace(legacySegmentPattern, () => `${prefix}${addMarker}${text}`);
          }
        }
        if (candidate !== latest) { candidate = ensureTranscriptBlocks(candidate, sourceId, { reconcileEditedText: false }); target = findTarget(readTranscriptBlocks(candidate)); }
      }
      const updated = makeUpdatedSegment(target?.segment || null);
      writtenSegment = updated;
      replaced = true;
      if (target) return replaceTranscriptBlock(candidate, target, updated, text);
      const block = makeTranscriptBlock(updated);
      const endMarker = task.sessionId ? nsMarker("segments-end", task.sessionId) : nsMarker("segments-end");
      const endAt = findNoteMarkerOffset(candidate, endMarker, "last");
      return endAt >= 0 ? `${candidate.slice(0, endAt)}${block}${candidate.slice(endAt)}` : `${candidate.trimEnd()}\n\n${block.trim()}\n`;
    });
  } else {
    const recoveredSegment = makeUpdatedSegment(null);
    writtenSegment = recoveredSegment;
    await port.insertBeforeSegmentsEnd(task.mdPath, makeTranscriptBlock(recoveredSegment), task.sessionId);
    replaced = true;
  }
  if (alreadyCommitted) { await port.deleteSegmentCache(task.audioPath, task.id); if (mdFile instanceof obsidian.TFile) await port.refreshNoteIndex(mdFile, { reason: "transcript-retry-idempotent" }); return; }
  if (replaced && mdFile instanceof obsidian.TFile) await port.refreshNoteIndex(mdFile, { reason: "transcript-retry" });
  if (!audio.recovered && (!task.wholeFileImport || task.ephemeralAudio)) await port.deleteSegmentCache(task.audioPath, task.id, !!task.ephemeralAudio);
  if (replaced && task.wholeFileImport && task.speakerDiarization !== false) {
    await port.confirmSpeakerNames({ id: task.sessionId, mdPath: task.mdPath, source: "import", importTranscribeProviderId: task.providerId }, writtenSegment ? [writtenSegment] : [{ text }]);
  }
  if (replaced) maybeAutoRepolish(port, task, mdFile);
}

function maybeAutoRepolish(port: QueueTranscribeRetryPort, task: TranscribeRetryTask, mdFile: obsidian.TAbstractFile | null): void {
  if (!(mdFile instanceof obsidian.TFile)) return;
  const mdNorm = obsidian.normalizePath(String(task.mdPath || ""));
  if (!mdNorm) return;
  const tasks = port.getQueueTasks();
  const remaining = tasks.filter((item) => item && item.type === "transcribe" && item.id !== task.id && obsidian.normalizePath(String(item.mdPath || "")) === mdNorm);
  if (remaining.length) return;
  if (tasks.some((item) => item && item.type === "merge" && item.continuation && item.sessionId === task.sessionId)) return;
  new obsidian.Notice(t("\"{0}\" All failed segments are transcribed; re-organizing the body...").replace("{0}", mdFile.basename), 8000);
  const mode = port.detectMode(mdFile) || port.getDefaultPolishMode();
  void (async () => {
    try { await port.repolish(mdFile, mode); }
    catch (error) {
      try { await port.logDiagnostic("error", "queue.auto_repolish_failed", t("Automatic re-organization after backfilling transcription failed"), { mdPath: mdNorm, error: diagnosticError(error) }); }
      catch { /* intentionally empty */ }
    }
  })();
}
