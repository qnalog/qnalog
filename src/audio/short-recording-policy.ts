// 短录音的分级判定：录完之后按总时长决定是丢弃、只留音频，还是正常整理。
//
// 抽成纯函数的原因：录音服务（决定要不要落盘音频、要不要转写）与收尾服务（决定要不要删结尾创建的纪要）
// 必须得到同一套结论，各写一份判据迟早会不一致。判据只取「总时长」与会话的既有状态，
// 与录音设备、转写服务、知识库无关，因此可以脱离宿主直接测。

import { SHORT_RECORDING_FILTER_MS, SHORT_RECORDING_SKIP_NOTE_MS } from "../shared/limits";

/** 一场录音按长度得到的处理级别。 */
export type ShortRecordingTier =
  /** 丢弃：不保存音频，结尾创建的纪要一并删除。 */
  | "discard"
  /** 只留音频：音频写入录音目录，不建纪要、不转写。 */
  | "keep-audio"
  /** 正常整理。 */
  | "process";

export interface ShortRecordingFacts {
  /** 本次录音的总时长（毫秒）；只有最后一个切片才有终值。 */
  durationMs: number;
  /** 是否为最后一个切片：总时长在此之前尚未确定，提前判定会把长录音误判成短录音。 */
  isFinal: boolean;
  /** 会话里是否已有切片：已有切片说明录音长度已经越过第一个切点，不再按时长判定。 */
  hasSegments: boolean;
  /** 短录音保护开关；关闭后短录音与普通录音一样走完整流程。 */
  filterShortRecordings: boolean;
  /** 是否为导入音频：用户已经指定了这个文件要转写，不适用短录音规则。 */
  isImported: boolean;
  /** 是否续录到既有纪要：目标笔记本来就存在，用户是明确指定了要追加进去。 */
  isContinuation: boolean;
}

/**
 * 按总时长给出处理级别。
 *
 * 两个阈值都在 `shared/limits.ts`：低于 `SHORT_RECORDING_FILTER_MS` 直接丢弃，
 * 低于 `SHORT_RECORDING_SKIP_NOTE_MS` 只保留音频。两者都以「整场长度不足」为前提，
 * 所以只对最后一个切片判定。
 *
 * 续录到既有纪要的录音只豁免「只留音频」这一级：3 秒以内的误触仍按原行为丢弃，
 * 更长一点但不足 10 秒的片段要并入原纪要——用户显式点了「续录到这篇」，
 * 目标笔记也已存在，丢掉追加内容会让他什么也没得到。
 */
export function classifyShortRecording(facts: ShortRecordingFacts): ShortRecordingTier {
  if (!facts || !facts.isFinal) return "process";
  if (facts.isImported || facts.hasSegments) return "process";
  if (!facts.filterShortRecordings) return "process";
  const durationMs = Math.max(0, Number(facts.durationMs) || 0);
  if (durationMs < SHORT_RECORDING_FILTER_MS) return "discard";
  if (facts.isContinuation) return "process";
  if (durationMs < SHORT_RECORDING_SKIP_NOTE_MS) return "keep-audio";
  return "process";
}
