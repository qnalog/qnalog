import { collectAudioRefs, getDurationMs } from "./audio-refs";
import { extractTranscriptSegments } from "./note-transcript-ledger";
import { QNALOG_EMPTY_SHORT_LIMIT_MS } from "../shared/limits";
import { NS_SEGMENTS_START_RE, NS_SESSION_RE } from "../shared/namespace";

export interface EmptyShortNoteCandidate<F> {
  file: F;
  durationMs: number;
  audioRefs: string[];
}

export function stripEmptyPlaceholders(text: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve the existing String(x || "") behavior for persisted text
  return String(text || "")
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/_?\[(?:此段无内容|无输出|转写失败|等待后台转写|此段尚未完成转写|合并润色失败|No content in this segment|No output|Transcription failed|Waiting for background transcription|This segment is not fully transcribed yet|Merge failed)[^\]\n]*\]_?/g, "")
    // 下两行是历史中文 LLM 的空结果自述（无对应英文写入方、也不在标签目录内），维持中文匹配。
    .replace(/^(?:没有|暂无)(?:可整理内容|有效内容|实际内容|可用内容)[。.!！]*$/gm, "")
    .replace(/^转写(?:为空|返回为空|无内容)[。.!！]*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hasMeaningfulTranscript(text: unknown): boolean {
  return stripEmptyPlaceholders(text).trim().length > 0;
}

export function isStandaloneGeneratedNote(markdown: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve the existing String(x || "") behavior for persisted text
  const body = String(markdown || "").replace(/^---\n[\s\S]*?\n---\n?/m, "");
  const firstLine = (body.split(/\r?\n/).find((line) => line.trim()) || "").trim();
  return /^#\s+.+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+·\s+/.test(firstLine);
}

export function getMeaningfulRemainder(markdown: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve the existing String(x || "") behavior for persisted text
  let text = String(markdown || "");
  text = text
    .replace(/^---\n[\s\S]*?\n---\n?/m, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<summary>[\s\S]*?<\/summary>/gi, "")
    .replace(/<\/?details>/gi, "")
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^>\s*\[!info\].*$/gm, "")
    .replace(/^>\s*(?:开始|时间|合并自|Time)[：:].*$/gm, "")
    .replace(/^>\s*.*(?:时长|模式|分段|模型|Duration|Mode|Segments|Model).*$/gm, "")
    .replace(/^\s*---\s*$/gm, "");
  text = stripEmptyPlaceholders(text);
  return text.replace(/^\s*$/gm, "").trim();
}

export function analyzeEmptyShortNote<F>(file: F, markdown: unknown): EmptyShortNoteCandidate<F> | null {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve the existing String(x || "") behavior for persisted text
  const text = String(markdown || "");
  const hasMarkerNames = NS_SESSION_RE.test(text) || NS_SEGMENTS_START_RE.test(text);
  if (!hasMarkerNames) return null;
  if (!isStandaloneGeneratedNote(text)) return null;

  const durationMs = getDurationMs(text);
  if (!(durationMs > 0 && durationMs <= QNALOG_EMPTY_SHORT_LIMIT_MS)) return null;

  const segments = extractTranscriptSegments(text);
  if (segments.some((seg) => hasMeaningfulTranscript(seg.text))) return null;
  if (hasMeaningfulTranscript(getMeaningfulRemainder(text))) return null;

  const audioRefs = collectAudioRefs(text);
  return { file, durationMs, audioRefs };
}
