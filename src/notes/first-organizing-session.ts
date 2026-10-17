import { NS_FM, NS_TAG_PREFIX, hasNamespaceFrontmatter } from "../shared/namespace";

/** 可选的整理模式：值为模式标识，label 为界面显示名（与「录音信息」里的模式行对应）。 */
export interface SessionModeOption {
  value: string;
  label: string;
}

/**
 * 从笔记内容读回的录音会话字段。取不到的字段为 null，不做猜测。
 * - mode：优先取 frontmatter 的 `qnalog/<模式>` 标签（首次整理写入的系统标签），其次取「录音信息」的模式行。
 * - time：「录音信息」的时间行，格式 `YYYY-MM-DD HH:mm:ss`，转为 frontmatter 使用的 `YYYY-MM-DDTHH:mm:ss`。
 * - duration：「录音信息」的时长行，例如 `00:09`。
 * - audioLink：正文中第一个音频嵌入的文件名（Obsidian 链接形式，不含目录）。
 */
export interface SessionFieldsFromNote {
  mode: string | null;
  time: string | null;
  duration: string | null;
  audioLink: string | null;
}

/** 写入 frontmatter 的会话字段值；audioPath 为库内完整路径。 */
export interface SessionFieldValues {
  mode: string | null;
  time: string | null;
  duration: string | null;
  audioPath: string | null;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const TAG_ITEM_RE = /^\s*-\s*['"]?([^\s'"]+)['"]?\s*$/;
const RECORDING_INFO_RE = /<summary>(?:录音信息|Recording info)<\/summary>([\s\S]*?)<\/details>/;
const INFO_TIME_RE = /^-\s*(?:时间|Time)[:：]\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*$/m;
const INFO_DURATION_RE = /^-\s*(?:时长|Duration)[:：]\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*$/m;
const INFO_MODE_RE = /^-\s*(?:模式|Mode)[:：]\s*(\S.*?)\s*$/m;
const AUDIO_EMBED_RE = /!\[\[([^\]|#]+?\.(?:m4a|mp3|wav|webm|ogg|flac|aac|opus|mp4))(?:[|#][^\]]*)?\]\]/i;

/**
 * 读取笔记里保存的录音会话字段。只做文本匹配，不解析 YAML，以便在任何宿主下行为一致。
 * 字段缺失时对应值为 null，调用方决定是否回退。
 */
export function readSessionFieldsFromNote(content: string, modes: readonly SessionModeOption[]): SessionFieldsFromNote {
  const text = String(content || "").replace(/\r\n/g, "\n");
  const frontmatter = FRONTMATTER_RE.exec(text)?.[1] || "";
  const tagValues = frontmatter.split("\n")
    .map((line) => TAG_ITEM_RE.exec(line)?.[1] || "")
    .filter((tag) => tag.startsWith(NS_TAG_PREFIX))
    .map((tag) => tag.slice(NS_TAG_PREFIX.length));
  const info = RECORDING_INFO_RE.exec(text)?.[1] || "";
  const knownModes = new Set(modes.map((mode) => mode.value));
  const modeFromTag = tagValues.find((value) => knownModes.has(value)) || null;
  const modeLabel = INFO_MODE_RE.exec(info)?.[1] || "";
  const modeFromLabel = modeLabel ? modes.find((mode) => mode.label === modeLabel)?.value || null : null;
  const time = INFO_TIME_RE.exec(info);
  const duration = INFO_DURATION_RE.exec(info);
  const audio = AUDIO_EMBED_RE.exec(text);
  return {
    mode: modeFromTag || modeFromLabel,
    time: time ? `${time[1]}T${time[2]}` : null,
    duration: duration ? duration[1] : null,
    audioLink: audio ? audio[1].trim() : null,
  };
}

/**
 * 只为 frontmatter 中尚不存在的会话键生成字段；已有键（含旧别名）一律不覆盖。
 * 返回的键顺序与首次整理一致：qnalog_mode、qnalog_time、qnalog_duration、qnalog_audio、qnalog_status。
 */
export function buildAbsentSessionFrontmatter(existing: Record<string, unknown>, values: SessionFieldValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (field: "mode" | "time" | "duration" | "audio" | "status", value: string | null): void => {
    if (value && !hasNamespaceFrontmatter(existing, field)) out[NS_FM[field]] = value;
  };
  put("mode", values.mode);
  put("time", values.time);
  put("duration", values.duration);
  put("audio", values.audioPath);
  put("status", "organized");
  return out;
}
