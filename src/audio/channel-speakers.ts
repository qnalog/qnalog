import { NS_FM_SPEAKERS, nsMarker, nsRe } from "../shared/namespace";
import { updateTranscriptSpeakerName } from "../transcript/transcript-markdown";
import { convertInlineSpeakerRefs, noteBodyMentionBrackets, renameSpeakerMentions, wrapSpeakerMentions } from "./speaker-mentions";
export const MAX_SPEAKER_CHANNELS = 4;
export const DEFAULT_SPEAKER_CHANNELS = 2;

export type SpeakerId = `spk-${number}`;
export type AudioChannelMode = "auto" | "mono" | "multichannel";
export type AudioChannelRuntimeMode = "mono" | "probing" | "multichannel";

export interface AudioChannelInfo {
  channelCount: number;
  maxChannelCount: number;
  label: string;
  deviceId: string;
  negotiated: boolean;
}
export interface SpeakerMapping {
  id: SpeakerId;
  channel: number;
  label: string;
  personName?: string;
  personPath?: string;
}

type ExtendedTrackCapabilities = MediaTrackCapabilities & {
  channelCount?: { min?: number; max?: number };
};

type ExtendedTrackSettings = MediaTrackSettings & {
  channelCount?: number;
};

function finiteChannelCount(value: unknown, fallback = 1): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : fallback;
}

function optionalString(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

export function normalizeAudioChannelMode(value: unknown): AudioChannelMode {
  const mode = optionalString(value).toLowerCase();
  if (mode === "mono" || mode === "multichannel") return mode;
  return "auto";
}

export function buildMicrophoneAudioConstraints(options: {
  deviceId?: string;
  channelMode?: AudioChannelMode;
  mobile?: boolean;
  targetChannels?: number;
} = {}): MediaTrackConstraints {
  const mode = normalizeAudioChannelMode(options.channelMode);
  const deviceId = String(options.deviceId || "").trim();
  const mobile = !!options.mobile;
  const targetChannels = Math.max(1, Math.min(
    MAX_SPEAKER_CHANNELS,
    finiteChannelCount(options.targetChannels, DEFAULT_SPEAKER_CHANNELS),
  ));
  const deviceConstraint = deviceId && !mobile ? { deviceId: { exact: deviceId } } : {};
  if (!mobile && mode === "auto") {
    // Auto mode must not turn every ordinary microphone into a multichannel source.
    // Acquire the device using its native/default format, then decide from the
    // negotiated track and the recorded audio whether channel separation is real.
    return deviceConstraint;
  }
  const preserveChannels = !mobile && mode === "multichannel";
  return {
    ...deviceConstraint,
    channelCount: { ideal: preserveChannels ? targetChannels : 1 },
    echoCancellation: !preserveChannels,
    noiseSuppression: !preserveChannels,
    autoGainControl: !preserveChannels,
  };
}

export function clampSpeakerChannelCount(value: unknown): number {
  return Math.max(1, Math.min(MAX_SPEAKER_CHANNELS, finiteChannelCount(value)));
}

export function speakerIdForChannel(channel: number): SpeakerId {
  return `spk-${clampSpeakerChannelCount(channel)}`;
}

export function speakerLabelForChannel(channel: number): string {
  return `说话人${clampSpeakerChannelCount(channel)}`;
}

export function readAudioTrackChannelInfo(track: MediaStreamTrack | null | undefined): AudioChannelInfo {
  const settings: ExtendedTrackSettings = track && typeof track.getSettings === "function"
    ? track.getSettings()
    : {};
  let capabilities: ExtendedTrackCapabilities = {};
  try {
    capabilities = track && typeof track.getCapabilities === "function"
      ? track.getCapabilities()
      : {};
  } catch {
    capabilities = {};
  }
  const channelCount = clampSpeakerChannelCount(settings.channelCount);
  const maxChannelCount = clampSpeakerChannelCount(capabilities.channelCount?.max || channelCount);
  return {
    channelCount,
    maxChannelCount,
    label: String(track?.label || ""),
    deviceId: String(settings.deviceId || ""),
    negotiated: false,
  };
}

export async function negotiateAudioTrackChannels(
  track: MediaStreamTrack | null | undefined,
  maxChannels = MAX_SPEAKER_CHANNELS,
): Promise<AudioChannelInfo> {
  const before = readAudioTrackChannelInfo(track);
  if (!track || typeof track.applyConstraints !== "function") return before;
  const target = Math.max(1, Math.min(clampSpeakerChannelCount(maxChannels), before.maxChannelCount));
  if (target <= 1) return before;
  try {
    await track.applyConstraints({
      channelCount: { ideal: target },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    return { ...readAudioTrackChannelInfo(track), negotiated: true };
  } catch {
    return before;
  }
}

export async function configureMicrophoneTrackChannels(
  track: MediaStreamTrack | null | undefined,
  channelMode: AudioChannelMode,
  targetChannels = DEFAULT_SPEAKER_CHANNELS,
): Promise<AudioChannelInfo> {
  const mode = normalizeAudioChannelMode(channelMode);
  if (mode === "mono") return readAudioTrackChannelInfo(track);
  if (mode === "auto") {
    let info = readAudioTrackChannelInfo(track);
    if (!track || typeof track.applyConstraints !== "function") return info;
    try {
      if (info.channelCount > 1) {
        // Keep the device's negotiated channel count. Do not request extra channels:
        // many normal Windows microphones advertise a stereo maximum even though
        // both channels contain the same signal.
        await track.applyConstraints({
          channelCount: { ideal: info.channelCount },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        });
      } else {
        await track.applyConstraints({
          channelCount: { ideal: 1 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
      }
      info = readAudioTrackChannelInfo(track);
    } catch {
      // Some drivers expose channel metadata but reject processing constraints.
      // Keep the stream that was already acquired.
    }
    return info;
  }
  let info = await negotiateAudioTrackChannels(track, targetChannels);
  return info;
}

export function initialAudioChannelRuntimeMode(
  channelMode: unknown,
  reportedChannelCount: unknown,
): AudioChannelRuntimeMode {
  const mode = normalizeAudioChannelMode(channelMode);
  if (mode === "mono") return "mono";
  if (mode === "multichannel") return "multichannel";
  return clampSpeakerChannelCount(reportedChannelCount) > 1 ? "probing" : "mono";
}

export function resolveAudioChannelRuntimeMode(options: {
  channelMode?: unknown;
  current?: unknown;
  separation?: unknown;
  usedMultichannel?: boolean;
}): AudioChannelRuntimeMode {
  const mode = normalizeAudioChannelMode(options.channelMode);
  if (mode === "mono") return "mono";
  if (mode === "multichannel") return "multichannel";
  if (options.usedMultichannel && optionalString(options.separation) === "separated") {
    return "multichannel";
  }
  const separation = optionalString(options.separation);
  if (separation === "single" || separation === "duplicated") return "mono";
  // Auto mode should only switch to multichannel on explicit evidence.
  // Inconclusive/ambiguous results are treated as provisional to avoid
  // forcing all subsequent segments into channel-separated transcription.
  return "probing";
}

export function buildSpeakerMappings(
  channelCount: unknown,
  raw: unknown = {},
): Record<SpeakerId, SpeakerMapping> {
  const count = clampSpeakerChannelCount(channelCount);
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const mappings = {} as Record<SpeakerId, SpeakerMapping>;
  for (let channel = 1; channel <= count; channel++) {
    const id = speakerIdForChannel(channel);
    const item = source[id] && typeof source[id] === "object"
      ? source[id] as Record<string, unknown>
      : {};
    mappings[id] = {
      id,
      channel,
      label: speakerLabelForChannel(channel),
      personName: optionalString(item.personName) || optionalString(item.name) || undefined,
      personPath: optionalString(item.personPath) || optionalString(item.path) || undefined,
    };
  }
  return mappings;
}

export function extractSpeakerIdsFromMarkdown(markdown: string): SpeakerId[] {
  const text = String(markdown || "");
  const found = new Set<SpeakerId>();
  for (const match of text.matchAll(new RegExp(`<!--\\s*${nsRe("speaker")}(?:-ref)?:(spk-(\\d+))\\s*-->`, "gi"))) {
    found.add(speakerIdForChannel(Number(match[2])));
  }
  for (const match of text.matchAll(/(?:\[|\*\*)说话人\s*(\d+)(?:\]|\s*[：:]\*\*)/g)) {
    found.add(speakerIdForChannel(Number(match[1])));
  }
  // Mention markers in the organized body (audio/speaker-mentions.ts).
  for (const match of text.matchAll(/『说话人\s*(\d+)』|\[[Ss]peaker[ \t]+(\d+)\]/g)) {
    found.add(speakerIdForChannel(Number(match[1] || match[2])));
  }
  return Array.from(found).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}

/**
 * 读取说话人映射（frontmatter 键 `qnalog_speakers`）。
 * 两处都存在时以新键为准（迁移尚未执行的库里旧键仍有效）。
 */
export function readSpeakerMappings(frontmatter: unknown): unknown {
  if (!frontmatter || typeof frontmatter !== "object") return null;
  const fm = frontmatter as Record<string, unknown>;
  return fm[NS_FM_SPEAKERS] ?? null;
}

export function normalizeSpeakerMappings(
  raw: unknown,
  speakerIds: SpeakerId[],
): Record<SpeakerId, SpeakerMapping> {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const filtered: Record<SpeakerId, SpeakerMapping> = {};
  for (const id of speakerIds) {
    const channel = Math.max(1, Number(id.slice(4)) || 1);
    const item = source[id] && typeof source[id] === "object"
      ? source[id] as Record<string, unknown>
      : {};
    const personName = typeof item.personName === "string" ? item.personName.trim() : "";
    const personPath = typeof item.personPath === "string" ? item.personPath.trim() : "";
    filtered[id] = {
      id,
      channel,
      label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : `说话人${channel}`,
      ...(personName ? { personName } : {}),
      ...(personPath ? { personPath } : {}),
    };
  }
  return filtered;
}

const ANCHOR_OPEN = "(?:<|&lt;)!--";
const ANCHOR_CLOSE = "--(?:>|&gt;)";

/** 「原始材料」标题：之后是原始转写等材料，之前是整理正文。 */
const ORIGINAL_MATERIAL_HEADING_RE = /^##[ \t]+(?:📁[ \t]*)?(?:原始材料|Original material)[ \t]*$/m;

/**
 * 改写某个说话人的显示名。
 * - 原始转写（锚点后的 `**姓名：**`、旧版 `[说话人N]` 行）改为新名字，并补稳定锚点；
 * - 可见正文里的提及写成提及标记（`『姓名』` / `[Name]`，见 audio/speaker-mentions.ts）：
 *   标记形式的旧名字、编号标签（带或不带空格、带或不带标记）改为新名字；旧版行内
 *   speaker-ref 注释标记与其他未加标记的编号标签一并换成标记形式，正文不再写入行内注释。
 * `knownPreviousNames` 是调用方已知的旧名字（如说话人映射里的旧姓名），正文提及只凭标记与映射识别。
 */
export function replaceSpeakerDisplayName(
  markdown: string,
  speakerId: SpeakerId,
  personName: string,
  knownPreviousNames: readonly string[] = [],
): { markdown: string; replacements: number } {
  // Hardware capture currently exposes at most four channels, but ASR
  // diarization can return more speakers. Do not clamp those stable IDs here.
  const channel = Math.max(1, Math.floor(Number(speakerId.slice(4))) || 1);
  const safeName = String(personName || "").replace(/[\r\n]+/g, " ").trim();
  if (!safeName) return { markdown: String(markdown || ""), replacements: 0 };
  const original = String(markdown || "");
  const previousNames = new Set<string>([`说话人${channel}`, `说话人 ${channel}`]);
  for (const name of knownPreviousNames) if (String(name || "").trim()) previousNames.add(String(name).trim());
  // Inside transcript blocks the anchor comment is stored HTML-escaped (`&lt;!-- ... --&gt;`); accept both forms.
  const anchoredNames = new RegExp(`${ANCHOR_OPEN}\\s*${nsRe("speaker")}:${speakerId}\\s*${ANCHOR_CLOSE}\\s*\\n?\\s*(?:\\[[^\\]]+\\]\\s*)?\\*\\*([^*\\n]{1,80})[：:]\\*\\*`, "gi");
  for (const match of original.matchAll(anchoredNames)) previousNames.add(match[1]);
  const inlineNames = new RegExp(`<!--\\s*${nsRe("speaker-ref")}:${speakerId}\\s*-->([^<\\n]*?)<!--\\s*${nsRe("speaker-ref-end")}:${speakerId}\\s*-->`, "gi");
  for (const match of original.matchAll(inlineNames)) previousNames.add(match[1].replace(/^[『[]|[』\]]$/g, ""));
  const anchored = new RegExp(
    `(${ANCHOR_OPEN}\\s*${nsRe("speaker")}:${speakerId}\\s*${ANCHOR_CLOSE}\\s*\\n?\\s*)(\\[[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\\]\\s*)?\\*\\*[^*\\n]{1,80}[：:]\\*\\*`,
    "gi",
  );
  let replacements = 0;
  let next = original.replace(anchored, (_match, prefix: string, timePrefix = "") => {
    replacements += 1;
    return `${prefix}${timePrefix}**${safeName}：**`;
  });
  // Older diarization notes may contain generic labels without a stable anchor.
  // Add the anchor during the first rename so later corrections can still find
  // the same speaker after the visible label has changed to a real name.
  // With an original-material heading these line forms belong to the raw material
  // after it; the organized body before it uses mention markers instead.
  const heading = ORIGINAL_MATERIAL_HEADING_RE.exec(next);
  const lineFormsFrom = heading ? heading.index : 0;
  const bold = new RegExp(`(^|\\n)([ \\t]*)\\*\\*说话人\\s*${channel}[：:]\\*\\*`, "g");
  const bracket = new RegExp(`(^|\\n)([ \\t]*)(\\[[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\\]\\s*)?\\[说话人\\s*${channel}\\]\\s*`, "g");
  let lineForms = next.slice(lineFormsFrom).replace(bold, (_match, lineStart: string, indent: string) => {
    replacements += 1;
    return `${lineStart}${indent}${nsMarker("speaker", speakerId)}\n${indent}**${safeName}：**`;
  });
  lineForms = lineForms.replace(bracket, (_match, lineStart: string, indent: string, timePrefix = "") => {
    replacements += 1;
    return `${lineStart}${indent}${nsMarker("speaker", speakerId)}\n${indent}${timePrefix}**${safeName}：** `;
  });
  next = next.slice(0, lineFormsFrom) + lineForms;

  // Visible prose: legacy inline comment markers become mention markers, then every
  // mention of this speaker takes the new name, and other numbered labels get a marker.
  // With a heading only the organized body before it is prose; without one (older notes
  // that mix transcript lines and prose) the line labels above are left to the line rules.
  const proseEnd = heading ? heading.index : next.length;
  const scope = { protectLineLabels: !heading };
  const brackets = noteBodyMentionBrackets(next);
  const prose = next.slice(0, proseEnd);
  const converted = convertInlineSpeakerRefs(prose, brackets, { speakerId, name: safeName }, scope);
  replacements += converted.replacements;
  const prewrapped = wrapSpeakerMentions(converted.markdown, [...previousNames], brackets, scope);
  const renamed = renameSpeakerMentions(prewrapped, channel, [...previousNames], safeName, brackets, scope);
  replacements += renamed.replacements;
  if (prewrapped !== converted.markdown && !renamed.replacements) replacements += 1;
  next = renamed.markdown + next.slice(proseEnd);

  next = replacements
    ? updateTranscriptSpeakerName(next, speakerId, safeName, [...previousNames])
    : next;
  const result = { markdown: next, replacements };
  return result;
}
