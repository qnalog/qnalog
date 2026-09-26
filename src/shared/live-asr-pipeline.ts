// 实时转写管线端口：SessionFinalizeService 对录音服务 live-ASR 状态的全部依赖面。
// 设计原因：这两个服务互相需要对方的能力，直接互持具体类会在服务依赖图里成环；
// 这里声明成纯接口后，录音服务实现它（implements 在编译期校验缺方法），会话收尾
// 服务只依赖接口。成员集合以 session-finalize-service.ts 的实际调用为准。
import type { QueueTask } from "./types";
import type { RecordingSession } from "./types";
import type { LiveAsrBacklogSummary, LiveAsrJob } from "../asr/live-segment-policy";

export interface LiveAsrPipeline {
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
}
