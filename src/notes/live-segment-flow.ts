import * as obsidian from "obsidian";
import type { PluginSettings, PreparedLiveSegment, RecordingSession, Segment } from "../shared/types";
import type { AsrTranscriptResult, AsrTranscriptUnit } from "../asr/transcript-result";
import { createLiveAsrCircuitState, isLiveAsrCircuitOpen } from "../asr/live-segment-policy";
import { DEFAULT_SPEAKER_CHANNELS, MAX_SPEAKER_CHANNELS, buildSpeakerMappings, initialAudioChannelRuntimeMode, normalizeAudioChannelMode, resolveAudioChannelRuntimeMode } from "../audio/channel-speakers";
import { getErrorMessage, pad, formatElapsed } from "../shared/util-common";
import { mimeFromExt, getTranscribeSegmentPlaceholder, isTransientAsrError } from "../shared/util-audio";
import { diagnosticError } from "../shared/util-key-diag";
import { NS_AUDIO_PREFIX, nsMarker } from "../shared/namespace";
import { labelText } from "../shared/note-labels";
import { t } from "../shared/i18n";
import { attachTranscriptResult, splitTranscriptTextUnits } from "../transcript/session-transcript";
import { serializeTranscriptBlock } from "../transcript/transcript-markdown";
import { getAudioTimeLink } from "./audio-reference-text";
import type { FinalizeProgress } from "./session-finalize-run-flow";

const stringifyValue = String as (value: unknown) => string;

export type SegmentFailure = Error & { asrDeferred?: boolean; deferReason?: string };
export interface LiveSegmentProfile { id?: string; model?: string; transcribeMode?: string }
export interface LiveSegmentChannelResult extends AsrTranscriptResult {
  actualChannelCount: number; processedChannelCount: number; usedMultichannel: boolean;
  separation: string; deduplicatedParts: number; errors: string[];
}
export interface LiveSegmentPort {
  getSettings(): Pick<PluginSettings, "audioChannelMode" | "activeTranscribeProvider" | "enableRealtimeOutline">;
  getActiveProfile(): LiveSegmentProfile | null | undefined;
  getSegmentCacheFolder(): string;
  ensureSegmentCacheFolder(): Promise<unknown>;
  writeSegmentAudio(path: string, data: ArrayBuffer): Promise<unknown>;
  saveMasterAudio(session: RecordingSession, seg: PreparedLiveSegment): Promise<unknown>;
  closeStreamingForDiscard(session: RecordingSession): Promise<unknown>;
  markSegmentTaskRunning(seg: PreparedLiveSegment): Promise<unknown>;
  getLiveAsrJob(session: RecordingSession, jobId: string): { state?: string } | null | undefined;
  updateBacklogPolicy(session: RecordingSession, reason: string): void;
  isServiceCircuitOpen(): boolean;
  readVaultAudio(path: string, fallbackName: string): Promise<{ blob: Blob } | null>;
  loadVocabulary(): Promise<unknown>;
  applyVocabulary(text: string, groups: unknown): string;
  removeLiveTranscriptBlock(mdPath: string, sessionId: string): Promise<unknown>;
  transcribeAudio(blob: Blob, mime: string): Promise<AsrTranscriptResult>;
  transcribeChannels(blob: Blob, mime: string, expectedChannelCount: number, options: { requireSeparatedChannels: boolean }): Promise<LiveSegmentChannelResult>;
  recordAttemptFailure(session: RecordingSession, error: unknown, seg: PreparedLiveSegment): void;
  recordAttemptSuccess(session: RecordingSession): void;
  getBacklogDurationMs(session: RecordingSession): number;
  classifyIssue(error: unknown): string;
  setRecordingIssue(kind: string, patch: { source: string; message: string; startedAtMs: number }): void;
  clearRecordingIssue(kind: string): void;
  markSessionAsrJobsDeferred(session: RecordingSession): void;
  keepSegmentTaskForRetry(session: RecordingSession, descriptor: PreparedLiveSegment, error: unknown): Promise<{ id: string }>;
  removeLiveSegmentTask(seg: PreparedLiveSegment): Promise<unknown>;
  insertBeforeSegmentsEnd(mdPath: string, block: string, sessionId: string): Promise<unknown>;
  setProgress(session: RecordingSession, patch: Partial<FinalizeProgress>): void;
  logDiagnostic(level: string, code: string, message: string, data: unknown): Promise<unknown>;
  requestOutlineRefresh(): void;
  scheduleRealtimeOutline(): void;
}

export async function processLiveSegment(port: LiveSegmentPort, session: RecordingSession, seg: PreparedLiveSegment): Promise<void> {
  if (!session) return;
  if (seg && seg.isFinal && seg.masterOnly && !session.shortRecordingTier) {
    if (seg.masterAudioSavePromise != null) await seg.masterAudioSavePromise;
    else await port.saveMasterAudio(session, seg);
    port.setProgress(session, {
      stage: "transcribe-finalized", label: t("Finalizing transcription"), percent: null,
      detail: t("Segmented recording has stopped; the full recording has been kept; organizing the transcription collected so far"),
    });
    try {
      await port.logDiagnostic("warn", "recording.master_only_finalize", t("The last segment was unavailable; the full recording was saved and the transcription collected so far is being organized"), {
        mode: session.mode, segmentCount: Array.isArray(session.segments) ? session.segments.length : 0,
        endOffsetMs: Number(seg.endOffsetMs) || 0,
      });
    } catch { /* intentionally empty */ }
    port.requestOutlineRefresh();
    return;
  }
  if (session.shortRecordingTier) {
    if (seg && seg.masterAudioSavePromise != null) await seg.masterAudioSavePromise;
    await port.closeStreamingForDiscard(session);
    return;
  }
  const continuationOffsetMs = Math.max(0, Number(session.continuationOffsetMs) || 0);
  const baseSegmentCount = Array.isArray(session.continuationBaseSegments) ? session.continuationBaseSegments.length : 0;
  const segmentIndex = Number.isFinite(Number(seg.segmentIndex)) ? Number(seg.segmentIndex) : baseSegmentCount + (Array.isArray(session.segments) ? session.segments.length : 0);
  const segNumber = Number.isFinite(Number(seg.segNumber)) ? Number(seg.segNumber) : segmentIndex + 1;
  const displayStartOffsetMs = Number.isFinite(Number(seg.displayStartOffsetMs)) ? Number(seg.displayStartOffsetMs) : Math.max(0, Number(seg.startOffsetMs) || 0) + continuationOffsetMs;
  const displayEndOffsetMs = Number.isFinite(Number(seg.displayEndOffsetMs)) ? Number(seg.displayEndOffsetMs) : Math.max(displayStartOffsetMs, (Number(seg.endOffsetMs) || 0) + continuationOffsetMs);
  const segmentAudioName = seg.segmentAudioName || `${NS_AUDIO_PREFIX}-${session.sessionStamp}-seg${pad(segNumber)}.${seg.ext}`;
  const segmentAudioPath = seg.segmentAudioPath || obsidian.normalizePath(`${port.getSegmentCacheFolder()}/${segmentAudioName}`);
  const segmentDurationMs = Math.max(0, displayEndOffsetMs - displayStartOffsetMs);
  let spoolResult: { persisted?: boolean; fallbackBlob?: Blob | null; error?: unknown; queueTaskId?: string } | null = null;
  if (seg.spoolPromise != null) spoolResult = await seg.spoolPromise;
  else if (seg.blob) {
    try {
      await port.ensureSegmentCacheFolder();
      await port.writeSegmentAudio(segmentAudioPath, await seg.blob.arrayBuffer());
      spoolResult = { persisted: true, fallbackBlob: null, error: null };
    } catch (e) {
      spoolResult = { persisted: false, fallbackBlob: seg.blob, error: e };
      console.error(e);
      new obsidian.Notice(`${t(" segments")}${segNumber}${t(" audio write failed: ")}${stringifyValue((e as { message?: unknown } | null | undefined)?.message || e)}`);
    }
  }
  if (spoolResult && spoolResult.queueTaskId) seg.queueTaskId = spoolResult.queueTaskId;
  await port.markSegmentTaskRunning(seg);
  const liveJob = seg.jobId ? port.getLiveAsrJob(session, seg.jobId) : null;
  if (liveJob) liveJob.state = "transcribing";
  port.updateBacklogPolicy(session, "transcribing");
  if (seg.masterAudioSavePromise != null) await seg.masterAudioSavePromise;
  else if (seg.isFinal) await port.saveMasterAudio(session, seg);

  let text = "";
  let err: SegmentFailure | null = null;
  let transcribeBlob: Blob | null = null;
  let channelTranscription: LiveSegmentChannelResult | null = null;
  let asrResult: AsrTranscriptResult | null = null;
  let streamingRawText = "";
  let batchAsrAttempted = false;
  let batchAsrFailureRecorded = false;
  const activeProfile = port.getActiveProfile();
  const isStreamingProvider = activeProfile && activeProfile.transcribeMode === "streaming";
  port.setProgress(session, { stage: "transcribing", label: `${t("Transcript segment ")}${segNumber}${t(" segments")}`, percent: null, detail: t("Audio is being sent to the transcription service") });
  if (session.streamingClient) {
    try {
      if (session.pcmEncoder) { try { session.pcmEncoder.stop(); } catch { /* intentionally empty */ } session.pcmEncoder = null; }
      await session.streamingClient.finish();
      streamingRawText = session.streamingClient.getFullText() || session.streamingFullText || "";
      text = streamingRawText;
    } catch (e) {
      err = e as SegmentFailure;
      console.error("[QnALog] streaming finish failed", e);
      streamingRawText = session.streamingFullText || "";
      text = streamingRawText;
    }
    let vocabularyGroups: unknown = null;
    try { vocabularyGroups = await port.loadVocabulary(); text = port.applyVocabulary(text, vocabularyGroups); }
    catch { /* keep the service text when vocabulary storage is unavailable */ }
    if (!err) {
      const rawStreamText = streamingRawText;
      const units: AsrTranscriptUnit[] = splitTranscriptTextUnits(rawStreamText).map((rawText) => ({ rawText, normalizedText: vocabularyGroups ? port.applyVocabulary(rawText, vocabularyGroups) : rawText, speakerId: null, speakerName: null, startMs: null, endMs: null, timing: "unknown" }));
      asrResult = { text, rawText: rawStreamText, providerId: String(activeProfile && activeProfile.id || session.importTranscribeProviderId || port.getSettings().activeTranscribeProvider || ""), units };
    }
    try { await port.removeLiveTranscriptBlock(session.mdPath, session.id); } catch { /* intentionally empty */ }
    session.streamingClient = null;
  } else if (isStreamingProvider) {
    err = new Error(t("The streaming transcription connection could not be established. Check your API key and network, then record again."));
    console.error("[QnALog]", err.message);
  } else {
    const circuitOpen = isLiveAsrCircuitOpen(session.asrCircuitState || createLiveAsrCircuitState()) || port.isServiceCircuitOpen();
    if (session.asrDeferredMode || circuitOpen) {
      err = new Error(session.asrDeferredMode ? t("Realtime transcription backlog exceeded the safety threshold and has moved to the background queue") : t("The transcription service is in a brief cooldown; work has moved to the background queue"));
      err.asrDeferred = true;
      err.deferReason = session.asrDeferredMode ? "backlog-critical" : "circuit-open";
    } else {
      transcribeBlob = spoolResult && spoolResult.fallbackBlob ? spoolResult.fallbackBlob : null;
      if (!transcribeBlob && spoolResult && spoolResult.persisted) {
        const cachedAudio = await port.readVaultAudio(segmentAudioPath, segmentAudioName);
        transcribeBlob = cachedAudio && cachedAudio.blob;
      }
      if (!transcribeBlob && seg.blob) transcribeBlob = seg.blob;
      if (!transcribeBlob) err = new Error(t("The recorded segment cache could not be read; the background retry task has been kept"));
      else {
        batchAsrAttempted = true;
        try {
          const transcribeMime = transcribeBlob.type || seg.blobType || mimeFromExt(seg.ext);
          const reportedChannelCount = session.captureMode === "mic" ? Math.max(1, Number(session.audioChannelCount) || 1) : 1;
          const channelMode = normalizeAudioChannelMode(session.audioChannelMode || port.getSettings().audioChannelMode);
          const runtimeChannelMode = session.audioChannelRuntimeMode || initialAudioChannelRuntimeMode(channelMode, reportedChannelCount);
          const inspectRecordedChannels = session.captureMode === "mic" && runtimeChannelMode !== "mono" && activeProfile?.transcribeMode !== "whole-file";
          const expectedChannels = inspectRecordedChannels ? MAX_SPEAKER_CHANNELS : 1;
          if (inspectRecordedChannels) {
            channelTranscription = await port.transcribeChannels(transcribeBlob, transcribeMime, expectedChannels, { requireSeparatedChannels: channelMode === "auto" && runtimeChannelMode === "probing" });
            text = channelTranscription.text;
            asrResult = channelTranscription;
            session.audioChannelCount = channelTranscription.actualChannelCount;
            session.audioChannelRuntimeMode = resolveAudioChannelRuntimeMode({ channelMode, current: runtimeChannelMode, separation: channelTranscription.separation, usedMultichannel: channelTranscription.usedMultichannel });
            session.channelSeparationMode = channelTranscription.usedMultichannel ? "device-channels" : session.audioChannelRuntimeMode === "probing" ? "pending" : channelTranscription.separation === "duplicated" ? "duplicated-input" : channelTranscription.actualChannelCount <= 1 ? "single" : "encoder-downmix";
            session.speakerChannels = channelTranscription.usedMultichannel ? buildSpeakerMappings(channelTranscription.processedChannelCount, session.speakerChannels) : {};
            if (channelTranscription.usedMultichannel && !session._channelSpeakersNotified) {
              session._channelSpeakersNotified = true;
              new obsidian.Notice(t("Separated {0} speakers by channel. You can enter their names at the top of the note.").replace("{0}", String(channelTranscription.processedChannelCount)), 9000);
            }
            if (channelTranscription.deduplicatedParts > 0) {
              session.channelCrosstalkDeduplicated = Math.max(0, Number(session.channelCrosstalkDeduplicated) || 0) + channelTranscription.deduplicatedParts;
              await port.logDiagnostic("info", "asr.channel_crosstalk_deduplicated", t("Cross-channel duplicate transcription removed"), { segmentIndex, removedParts: channelTranscription.deduplicatedParts, totalRemovedParts: session.channelCrosstalkDeduplicated });
            }
            if (channelMode === "multichannel" && channelTranscription.separation === "duplicated" && !session._channelDuplicatedNotified) {
              session._channelDuplicatedNotified = true;
              new obsidian.Notice(t("All channels have identical content; transcribed as mono. Please change the receiver output to \"Stereo\" and try again."), 10000);
              await port.logDiagnostic("warn", "asr.channel_content_duplicated", t("Recording channels had duplicate content; fell back to mono transcription"), { actualChannelCount: channelTranscription.actualChannelCount, inputLabel: session.audioChannelLabel || "" });
            }
            const expectedHardwareChannels = channelMode === "multichannel" ? Math.max(reportedChannelCount, DEFAULT_SPEAKER_CHANNELS) : reportedChannelCount;
            if (channelMode === "multichannel" && expectedHardwareChannels > 1 && channelTranscription.actualChannelCount < expectedHardwareChannels && !session._channelDownmixNotified) {
              session._channelDownmixNotified = true;
              const actual = channelTranscription.actualChannelCount;
              new obsidian.Notice(actual > 1 ? t("Detected {0} available channel(s); speakers will be separated by channel.").replace("{0}", String(actual)) : t("The input device has multiple channels, but the recording file is mono; transcription will proceed in mono."), 9000);
              await port.logDiagnostic("warn", "asr.channel_encoder_downmix", t("The recording encoding kept fewer channels than the device input"), { expectedChannelCount: expectedHardwareChannels, actualChannelCount: actual, inputLabel: session.audioChannelLabel || "" });
            }
            if (channelTranscription.errors.length) await port.logDiagnostic("warn", "asr.channel_partial_failure", t("Some channels failed to transcribe; content from the other channels was kept"), { segmentIndex, channelCount: channelTranscription.actualChannelCount, errors: channelTranscription.errors });
          } else {
            asrResult = await port.transcribeAudio(transcribeBlob, transcribeMime);
            text = asrResult.text;
          }
        } catch (e) { err = e as SegmentFailure; batchAsrFailureRecorded = true; port.recordAttemptFailure(session, e, seg); console.error(e); }
      }
    }
  }
  if (!err && !String(text || "").trim() && segmentDurationMs >= 30 * 1000) {
    err = new Error(t("Transcription returned an empty result (the service responded but returned no text)"));
    asrResult = null;
    if (batchAsrAttempted && !batchAsrFailureRecorded) { batchAsrFailureRecorded = true; port.recordAttemptFailure(session, err, seg); }
    try { await port.logDiagnostic("warn", "asr.segment_empty", t("A recorded segment returned an empty transcription; it was kept as a soft failure and queued"), { segmentIndex, startOffsetMs: displayStartOffsetMs, endOffsetMs: displayEndOffsetMs, durationMs: segmentDurationMs, mode: session.mode }); } catch { /* intentionally empty */ }
  }
  if (!err && batchAsrAttempted) port.recordAttemptSuccess(session);
  if (err) {
    if (err.asrDeferred) await port.logDiagnostic("warn", "asr.segment_deferred", t("The recorded segment skipped the realtime request and moved to the background queue"), { segmentIndex, startOffsetMs: displayStartOffsetMs, endOffsetMs: displayEndOffsetMs, durationMs: segmentDurationMs, reason: err.deferReason || "deferred", pendingDurationMs: port.getBacklogDurationMs(session) });
    else {
      const issueKind = port.classifyIssue(err);
      port.setRecordingIssue(issueKind, { source: "asr", message: getErrorMessage(err), startedAtMs: displayStartOffsetMs });
      await port.logDiagnostic("error", "asr.segment_failed", t("Transcription failed for a recorded segment"), {
        provider: port.getSettings().activeTranscribeProvider,
        model: port.getActiveProfile() && port.getActiveProfile()?.model,
        mime: (transcribeBlob && transcribeBlob.type) || seg.blobType || "",
        size: (transcribeBlob && transcribeBlob.size) || seg.blobSize || 0,
        segmentIndex, startOffsetMs: displayStartOffsetMs, endOffsetMs: displayEndOffsetMs, mode: session.mode, error: diagnosticError(err),
      });
      new obsidian.Notice(isStreamingProvider
        ? t("Segment {0} failed to transcribe in streaming mode and cannot be retried offline; recording continues locally. Use \"Re-organize\" when the whole recording finishes, or record that segment again.").replace("{0}", String(segNumber))
        : (!String(text || "").trim() ? t("Segment {0} returned no text; the audio slice has been kept and queued for retry.").replace("{0}", String(segNumber)) : t("Segment {0} failed to transcribe; recording continues locally and it has been queued for retry.").replace("{0}", String(segNumber))), 7000);
    }
  } else if (!text || !String(text).trim()) {
    port.clearRecordingIssue("network");
    port.clearRecordingIssue("service");
    const hadAnyText = Array.isArray(session.segments) && session.segments.some((s) => s && s.text && String(s.text).trim());
    await port.logDiagnostic("warn", "asr.empty_result", t("This segment has no transcription"), { segmentIndex, mode: session.mode, hadAnyText });
    if (!hadAnyText && !session._emptyAsrNotified) {
      session._emptyAsrNotified = true;
      new obsidian.Notice(t("No speech detected in this segment. Go to \"Settings → General → Audio input\" to test the selected device."), 9000);
    }
  } else {
    port.clearRecordingIssue("network");
    port.clearRecordingIssue("service");
  }

  const playbackAudioName = session.masterAudioName || segmentAudioName;
  const playbackAudioPath = session.masterAudioPath || segmentAudioPath;
  let segmentRecord: Segment = {
    index: segmentIndex, startOffsetMs: displayStartOffsetMs, endOffsetMs: displayEndOffsetMs,
    audioStartOffsetMs: Math.max(0, Number(seg.startOffsetMs) || 0), audioEndOffsetMs: Math.max(0, Number(seg.endOffsetMs) || 0),
    audioName: playbackAudioName, audioPath: playbackAudioPath, segmentAudioName, segmentAudioPath,
    text, error: err ? (err.message || String(err)) : null, isFinal: !!seg.isFinal, source: (seg && seg.source) || session.captureMode || "mic",
  };
  const segmentArrayIndex = session.segments.length;
  session.segments.push(segmentRecord);
  if (err && !isStreamingProvider) {
    if (err.asrDeferred || isTransientAsrError(err)) port.markSessionAsrJobsDeferred(session);
    const retryTask = await port.keepSegmentTaskForRetry(session, Object.assign({}, seg, { segmentAudioPath, segmentAudioName, segmentIndex, displayStartOffsetMs, displayEndOffsetMs }), err);
    segmentRecord.queueTaskId = retryTask.id;
  }
  const visibleText = err ? getTranscribeSegmentPlaceholder(err, { streaming: !!isStreamingProvider, deferred: !!err.asrDeferred, retryable: !isStreamingProvider && (err.asrDeferred || isTransientAsrError(err)) }) : (text ? text : labelText("noContentSegment"));
  segmentRecord = attachTranscriptResult(segmentRecord, session.id, err ? null : asrResult, isStreamingProvider ? "streaming-transcript" : "asr");
  session.segments[segmentArrayIndex] = segmentRecord;
  const segTitle = `### ${labelText("segment", segNumber)} (${formatElapsed(displayStartOffsetMs)}–${formatElapsed(displayEndOffsetMs)}) ${getAudioTimeLink(playbackAudioName, Math.max(0, Number(seg.startOffsetMs) || 0))}${seg.isFinal ? " · 结束" : ""}`;
  const heading = [segTitle, segmentRecord.queueTaskId ? nsMarker("transcribe-task", segmentRecord.queueTaskId) : ""].filter(Boolean).join("\n\n");
  const block = `\n${serializeTranscriptBlock(segmentRecord, heading, visibleText)}\n`;
  await port.insertBeforeSegmentsEnd(session.mdPath, block, session.id);
  if (!err || isStreamingProvider) await port.removeLiveSegmentTask(seg);
  port.requestOutlineRefresh();
  port.setProgress(session, {
    stage: seg.isFinal ? "transcribe-finalized" : "transcribed",
    label: seg.isFinal ? t("Finalizing transcription") : (err && err.asrDeferred ? t("Cached {0} segments").replace("{0}", String(session.segments.length)) : t("Transcribed {0} segments").replace("{0}", String(session.segments.length))),
    percent: null,
    detail: seg.isFinal ? t("Starting AI organizing") : (err && err.asrDeferred ? t("Audio saved to disk; waiting for background transcription retry") : t("Segment transcriptions have been written to the note")),
  });
  if (!seg.isFinal && text && String(text).trim()) new obsidian.Notice(`${t(" segments ")}${segNumber}${t(" transcribed")}`);
  if (port.getSettings().enableRealtimeOutline && text && !err) port.scheduleRealtimeOutline();
}
