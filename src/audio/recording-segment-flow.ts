import { LIVE_ASR_TASK_STATUS } from "../asr/live-segment-policy";
import type { PreparedLiveSegment, QueueTask, RecorderSegmentPayload, RecordingSession } from "../shared/types";
import { diagnosticError } from "../shared/util-key-diag";
import { t } from "../shared/i18n";
import { classifyShortRecording } from "./short-recording-policy";

export interface RecordingSegmentHost {
  getFilterShortRecordings(): boolean;
  startMasterAudioSave(session: RecordingSession, seg: RecorderSegmentPayload): Promise<unknown>;
  beginSessionSegmentWork(session: RecordingSession): void;
  prepareLiveSegmentDescriptor(session: RecordingSession, seg: RecorderSegmentPayload): PreparedLiveSegment;
  queueLiveSegmentPersistence(session: RecordingSession, descriptor: PreparedLiveSegment, blob: Blob): NonNullable<PreparedLiveSegment["spoolPromise"]>;
  getQueueTask(id: string): Pick<QueueTask, "status"> | undefined;
  keepLiveSegmentQueueTaskForRetry(session: RecordingSession, descriptor: PreparedLiveSegment, error: unknown): Promise<unknown>;
  markSessionAsrJobsDeferred(session: RecordingSession): void;
  finishSessionSegmentWork(session: RecordingSession, jobId: string | undefined, reason: "completed"): void;
  scheduleMeetingWorkbenchInteraction(session: RecordingSession, interaction: unknown): void;
  logDiagnostic(level: "error", code: string, message: string, data: Record<string, unknown>): Promise<unknown>;
  processRecordedSegment(session: RecordingSession, seg: PreparedLiveSegment): Promise<void>;
  finalizeRecordedSession(session: RecordingSession): Promise<void>;
}

export function handleRecordedSegment(
  host: RecordingSegmentHost,
  session: RecordingSession | null | undefined,
  seg: RecorderSegmentPayload,
): Promise<void> | undefined {
  if (!session) return;

  const tier = classifyShortRecording({
    durationMs: seg && seg.isFinal ? Number(seg.endOffsetMs) || 0 : 0,
    isFinal: !!(seg && seg.isFinal),
    hasSegments: !!(session && session.segments && session.segments.length),
    filterShortRecordings: host.getFilterShortRecordings(),
    isImported: !!(session && (session.source === "import" || session.source === "text-import")),
    isContinuation: !!(session && session.continuationSourcePath),
  });

  let preparedSeg: PreparedLiveSegment;
  if (tier !== "process") {
    // 短录音不转写。丢弃级别不落盘音频；只留音频级别把整场音频写进录音目录。
    // 分级函数只在最后一个切片上返回短录音级别，所以这里的 isFinal 必为真。
    session.shortRecordingTier = tier;
    session.shortRecordingDurationMs = Math.max(0, Number(seg && seg.endOffsetMs) || 0);
    preparedSeg = {
      isFinal: true,
      endOffsetMs: session.shortRecordingDurationMs,
      masterAudioSavePromise: tier === "discard" ? Promise.resolve() : host.startMasterAudioSave(session, seg),
    };
    host.beginSessionSegmentWork(session);
  } else if (seg && seg.masterOnly) {
    const masterAudioSavePromise = host.startMasterAudioSave(session, seg);
    preparedSeg = {
      isFinal: !!seg.isFinal,
      masterOnly: true,
      endOffsetMs: Math.max(0, Number(seg.endOffsetMs) || 0),
      masterAudioSavePromise,
    };
    host.beginSessionSegmentWork(session);
  } else {
    const descriptor = host.prepareLiveSegmentDescriptor(session, seg);
    const masterAudioSavePromise = host.startMasterAudioSave(session, seg);
    preparedSeg = {
      ...descriptor,
      masterAudioSavePromise,
      spoolPromise: host.queueLiveSegmentPersistence(session, descriptor, seg.blob),
    };
  }

  session.writeQueue = Promise.resolve(session.writeQueue).catch((error: unknown) => {
    console.error("[QnALog] recovered rejected write chain before next segment", error);
  }).then(async () => {
    try {
      await host.processRecordedSegment(session, preparedSeg);
    } catch (error: unknown) {
      // 本段异常不能毒化后续写入链；processSegment 已尽力保留缓存并加入后台重试。
      console.error("[QnALog] processSegment failed (swallowed to protect write chain)", error);
      try {
        const task = preparedSeg.queueTaskId && host.getQueueTask(preparedSeg.queueTaskId);
        if (preparedSeg.segmentAudioPath && (!task || task.status === LIVE_ASR_TASK_STATUS || task.status === "running")) {
          await host.keepLiveSegmentQueueTaskForRetry(session, preparedSeg, error);
          host.markSessionAsrJobsDeferred(session);
        }
      } catch (queueError: unknown) {
        console.error("[QnALog] preserve live segment task after processing failure failed", queueError);
      }
      try {
        await host.logDiagnostic("error", "segment.process_failed", t("Segment processing error (swallowed to avoid poisoning the write chain)"), {
          mode: session.mode,
          isFinal: !!preparedSeg.isFinal,
          error: diagnosticError(error),
        });
      } catch { /* intentionally empty */ }
    } finally {
      host.finishSessionSegmentWork(session, preparedSeg.jobId, "completed");
      if (!preparedSeg.isFinal && session.pendingMeetingWorkbenchInteractions && session.pendingMeetingWorkbenchInteractions.length) {
        host.scheduleMeetingWorkbenchInteraction(session, session.pendingMeetingWorkbenchInteractions[0]);
      }
    }
  });

  if (preparedSeg.isFinal) {
    // 双分支：无论前序链 fulfilled 还是 rejected，finalizeSession 都必须跑。
    session.writeQueue = session.writeQueue.then(
      () => host.finalizeRecordedSession(session),
      (error: unknown) => {
        console.error("[QnALog] write chain rejected before finalize", error);
        return host.finalizeRecordedSession(session);
      },
    );
  }

  // 录音中的普通切段只等音频安全落盘，不应继续 await 慢速 ASR 链。
  // 否则每个 cutSegment 异步栈都会持有原 Blob，等于从队列外侧把内存积压重新引回来。
  // 最终段仍等待完整收尾，保持“停止录音完成后才允许下一场”的既有会话语义。
  if (preparedSeg.isFinal) return session.writeQueue;
  const releasePromises: Promise<unknown>[] = [];
  if (preparedSeg.spoolPromise != null) releasePromises.push(preparedSeg.spoolPromise);
  if (preparedSeg.masterAudioSavePromise != null) releasePromises.push(preparedSeg.masterAudioSavePromise);
  if (releasePromises.length) return Promise.all(releasePromises).then(() => undefined);
  return session.writeQueue;
}
