import { BLANK_RECORDING_DISCARD_LIMIT_MS } from "../shared/limits";

export type BlankRecordingDisposition = "discard" | "keep" | "not-applicable";

export interface BlankRecordingFacts {
  durationMs: number;
  isOrdinaryRecording: boolean;
  segments: readonly { text?: string | null; error?: string | null }[];
}

/** 判断整场转写是否全部成功且为空，再按时长与来源选择收尾方式。 */
export function classifyBlankRecording(facts: BlankRecordingFacts): BlankRecordingDisposition {
  if (!facts || !facts.segments || facts.segments.length === 0) return "not-applicable";
  const allSuccessfullyBlank = facts.segments.every((segment) => !segment.error && !String(segment.text || "").trim());
  if (!allSuccessfullyBlank) return "not-applicable";
  if (!facts.isOrdinaryRecording) return "keep";
  const durationMs = Math.max(0, Number(facts.durationMs) || 0);
  return durationMs < BLANK_RECORDING_DISCARD_LIMIT_MS ? "discard" : "keep";
}
