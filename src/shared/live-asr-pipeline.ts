// 实时转写管线的共享消费者端口。
// 由独立的 ASR 管线服务实现，供收尾与其他消费者使用。
import type { QueueTask } from "./types";
import type { RecordingSession } from "./types";
import type { LiveAsrBacklogSummary, LiveAsrJob } from "../asr/live-segment-policy";

export interface LiveAsrPipeline {
  /** Initialize session-scoped transcription work state. */
  initializeSession(session: RecordingSession): void;
  /** Record one active segment's transcription work. */
  beginSessionSegmentWork(session: RecordingSession): void;
  /** Release one active segment's transcription work and update its backlog. */
  finishSessionSegmentWork(session: RecordingSession, jobId?: string, reason?: string): void;
  /** Mark that at least one segment must be retried from the background queue. */
  markSessionAsrJobsDeferred(session: RecordingSession): void;
  /** 整段音频落盘（收尾与切片完成时）。 */
  saveMasterAudio(session: RecordingSession, seg: unknown): Promise<void>;
  /** 停止流式通道并丢弃当前会话的流式状态。 */
  closeStreamingForDiscard(session: RecordingSession): Promise<void>;
  /** 丢弃过短录音的笔记与缓存。 */
  discardShortRecordingNote(session: RecordingSession): Promise<void>;
  /** 写入会话进度（面板进度条按 stage 渲染）。 */
  setSessionWorkProgress(session: RecordingSession, patch: unknown): void;
  /** 分段音频缓存目录（绝对路径，知识库内）。 */
  getSegmentCacheFolder(): string;
  /** 按需创建分段音频缓存目录。 */
  ensureSegmentCacheFolder(): Promise<unknown>;
  /** 把正在转写的切片任务标记为 running。 */
  markLiveSegmentQueueTaskRunning(descriptor: { queueTaskId?: string }): Promise<void>;
  /** 移除已完成的切片转写任务。 */
  removeLiveSegmentQueueTask(descriptor: { queueTaskId?: string }): Promise<void>;
  /** 转写失败后把切片任务改排为待重试，返回重排后的任务。 */
  keepLiveSegmentQueueTaskForRetry(session: RecordingSession, descriptor: unknown, error: unknown): Promise<QueueTask>;
  /** 清理可安全删除的分段音频文件。 */
  cleanupSuccessfulSegmentAudio(session: RecordingSession): Promise<unknown>;
  /** 当前会话的实时转写任务表。 */
  getLiveAsrJobs(session: RecordingSession | null): Map<string, LiveAsrJob>;
  /** 实时转写积压统计。 */
  getLiveAsrBacklogSummary(session: RecordingSession | null): LiveAsrBacklogSummary;
  /** 按积压统计更新会话的降级策略。 */
  updateLiveAsrBacklogPolicy(session: RecordingSession | null, reason?: string): void;
  /** 转写服务熔断是否处于打开状态。 */
  isAsrServiceCircuitOpen(): boolean;
  /** 记录一次实时转写尝试成功。 */
  recordLiveAsrAttemptSuccess(session: RecordingSession): void;
  /** 记录一次实时转写尝试失败。 */
  recordLiveAsrAttemptFailure(session: RecordingSession, error: unknown, descriptor: unknown): void;
  /** 记录录音问题（面板与悬浮气泡显示）。 */
  setRecordingIssue(kind: string, patch?: unknown): void;
  /** 清除录音问题。 */
  clearRecordingIssue(kind?: string): void;
  /** Snapshot of the pipeline's current recording issue. */
  getRecordingIssue(): unknown;
}
