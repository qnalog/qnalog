import { decodeAudioBlob, transcribeAudio } from "./transcribe";
import {
  MAX_SPEAKER_CHANNELS,
  clampSpeakerChannelCount,
  speakerIdForChannel,
  speakerLabelForChannel,
  type SpeakerId,
} from "../audio/channel-speakers";

const OUTPUT_SAMPLE_RATE = 16000;

export interface SpeakerAudioSpan {
  speakerId: SpeakerId;
  channel: number;
  startMs: number;
  endMs: number;
  peakRms: number;
}

export interface SpeakerTranscriptPart extends SpeakerAudioSpan {
  text: string;
}

export interface ChannelTranscriptionResult {
  text: string;
  actualChannelCount: number;
  processedChannelCount: number;
  usedMultichannel: boolean;
  separation: AudioChannelAnalysis["separation"] | "unknown";
  parts: SpeakerTranscriptPart[];
  deduplicatedParts: number;
  errors: string[];
}

export interface AudioChannelLevel {
  channel: number;
  rms: number;
  peak: number;
  active: boolean;
}

export interface AudioChannelPairAnalysis {
  leftChannel: number;
  rightChannel: number;
  correlation: number;
}

export interface AudioChannelAnalysis {
  channelCount: number;
  durationMs: number;
  channels: AudioChannelLevel[];
  pairs: AudioChannelPairAnalysis[];
  separation: "single" | "separated" | "duplicated" | "inconclusive";
}

type TranscriptionPlugin = Parameters<typeof transcribeAudio>[0];

function frameRms(samples: Float32Array, start: number, end: number): number {
  let sum = 0;
  const safeStart = Math.max(0, start);
  const safeEnd = Math.min(samples.length, end);
  for (let i = safeStart; i < safeEnd; i++) sum += samples[i] * samples[i];
  return safeEnd > safeStart ? Math.sqrt(sum / (safeEnd - safeStart)) : 0;
}

function channelPeak(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i] || 0));
  return peak;
}

function absoluteCorrelation(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  if (length <= 1) return 1;
  const stride = Math.max(1, Math.floor(length / 48_000));
  let dot = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let i = 0; i < length; i += stride) {
    const a = left[i] || 0;
    const b = right[i] || 0;
    dot += a * b;
    leftEnergy += a * a;
    rightEnergy += b * b;
  }
  if (leftEnergy <= 1e-12 || rightEnergy <= 1e-12) return 0;
  return Math.min(1, Math.abs(dot / Math.sqrt(leftEnergy * rightEnergy)));
}

export function analyzeAudioBufferChannels(audioBuffer: AudioBuffer): AudioChannelAnalysis {
  const channelCount = Math.max(1, Math.min(MAX_SPEAKER_CHANNELS, audioBuffer.numberOfChannels || 1));
  const samples = Array.from({ length: channelCount }, (_item, index) => audioBuffer.getChannelData(index));
  const rawLevels = samples.map((channelSamples, index) => ({
    channel: index + 1,
    rms: frameRms(channelSamples, 0, channelSamples.length),
    peak: channelPeak(channelSamples),
  }));
  const loudestRms = Math.max(...rawLevels.map((item) => item.rms), 0);
  const activeThreshold = Math.max(0.0015, loudestRms * 0.06);
  const channels: AudioChannelLevel[] = rawLevels.map((item) => ({
    ...item,
    active: item.rms >= activeThreshold && item.peak >= 0.006,
  }));
  const pairs: AudioChannelPairAnalysis[] = [];
  for (let left = 0; left < channelCount; left++) {
    for (let right = left + 1; right < channelCount; right++) {
      if (!channels[left].active || !channels[right].active) continue;
      pairs.push({
        leftChannel: left + 1,
        rightChannel: right + 1,
        correlation: absoluteCorrelation(samples[left], samples[right]),
      });
    }
  }

  let separation: AudioChannelAnalysis["separation"] = "inconclusive";
  if (channelCount <= 1) {
    separation = "single";
  } else if (channels.filter((item) => item.active).length >= 2 && pairs.length) {
    if (pairs.some((pair) => pair.correlation <= 0.96)) separation = "separated";
    else if (pairs.every((pair) => pair.correlation >= 0.995)) separation = "duplicated";
  }

  return {
    channelCount,
    durationMs: Math.max(0, Math.round((audioBuffer.duration || 0) * 1000)),
    channels,
    pairs,
    separation,
  };
}

export async function analyzeRecordedAudioChannels(blob: Blob): Promise<AudioChannelAnalysis> {
  return analyzeAudioBufferChannels(await decodeAudioBlob(blob));
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio)))] || 0;
}

export function planSpeakerAudioSpans(
  channels: Float32Array[],
  sampleRate: number,
  options: { frameMs?: number; mergeGapMs?: number; maxSpanMs?: number } = {},
): SpeakerAudioSpan[] {
  const count = Math.max(1, Math.min(MAX_SPEAKER_CHANNELS, channels.length));
  const frameMs = Math.max(100, Number(options.frameMs) || 250);
  const frameSize = Math.max(1, Math.floor(sampleRate * frameMs / 1000));
  const frameCount = Math.ceil(Math.max(...channels.slice(0, count).map((samples) => samples.length), 0) / frameSize);
  const levels = Array.from({ length: count }, () => new Array<number>(frameCount).fill(0));
  for (let channel = 0; channel < count; channel++) {
    for (let frame = 0; frame < frameCount; frame++) {
      levels[channel][frame] = frameRms(channels[channel], frame * frameSize, (frame + 1) * frameSize);
    }
  }
  const noiseFloors = levels.map((items) => percentile(items, 0.2));
  const peaks = levels.map((items) => Math.max(...items, 0));
  const masks = Array.from({ length: count }, () => new Array<boolean>(frameCount).fill(false));
  for (let frame = 0; frame < frameCount; frame++) {
    const frameMax = Math.max(...levels.map((items) => items[frame] || 0), 0);
    for (let channel = 0; channel < count; channel++) {
      const level = levels[channel][frame] || 0;
      const threshold = Math.max(0.0025, noiseFloors[channel] * 2.4, peaks[channel] * 0.055);
      masks[channel][frame] = level >= threshold && (frameMax <= 0 || level >= frameMax * 0.42);
    }
  }

  const mergeGapFrames = Math.max(1, Math.ceil((Number(options.mergeGapMs) || 1600) / frameMs));
  const maxSpanFrames = Math.max(2, Math.floor((Number(options.maxSpanMs) || 45000) / frameMs));
  const spans: SpeakerAudioSpan[] = [];
  for (let channel = 0; channel < count; channel++) {
    let start = -1;
    let lastActive = -1;
    const flush = (endFrame: number) => {
      if (start < 0 || lastActive < start) return;
      let cursor = Math.max(0, start - 1);
      const finalFrame = Math.min(frameCount, Math.max(endFrame, lastActive + 2));
      while (cursor < finalFrame) {
        const spanEnd = Math.min(finalFrame, cursor + maxSpanFrames);
        const peakRms = Math.max(...levels[channel].slice(cursor, spanEnd), 0);
        if ((spanEnd - cursor) * frameMs >= 500) {
          spans.push({
            speakerId: speakerIdForChannel(channel + 1),
            channel: channel + 1,
            startMs: Math.round(cursor * frameMs),
            endMs: Math.round(spanEnd * frameMs),
            peakRms,
          });
        }
        cursor = spanEnd;
      }
      start = -1;
      lastActive = -1;
    };
    for (let frame = 0; frame < frameCount; frame++) {
      if (masks[channel][frame]) {
        if (start < 0) start = frame;
        lastActive = frame;
      } else if (start >= 0 && frame - lastActive > mergeGapFrames) {
        flush(lastActive + 2);
      }
    }
    flush(frameCount);
  }
  return spans.sort((a, b) => a.startMs - b.startMs || a.channel - b.channel);
}

// 同声道相邻段的间隔超过此值就不再合并：否则会把中间的静音和对方发言一起吞进同一段，
// 既破坏逐句时间线，也可能让单次送 ASR 的音频过长。
export const SPEAKER_SPAN_MERGE_MAX_GAP_MS = 20000;
// 长录音的分段配额按时长放大，避免一场 30 分钟的会被压成几个巨块。
export const SPEAKER_SPAN_JOBS_PER_MINUTE = 3;

export function limitSpeakerAudioSpans(
  spans: SpeakerAudioSpan[],
  maxJobs = 8,
): SpeakerAudioSpan[] {
  const result = spans
    .filter((span) => span && span.endMs > span.startMs)
    .map((span) => ({ ...span }))
    .sort((a, b) => a.startMs - b.startMs || a.channel - b.channel);
  if (!result.length) return result;
  const durationMinutes = Math.max(1, result[result.length - 1].endMs / 60000);
  const baseLimit = Math.max(MAX_SPEAKER_CHANNELS, Math.floor(Number(maxJobs) || 8));
  const limit = Math.max(baseLimit, Math.ceil(durationMinutes * SPEAKER_SPAN_JOBS_PER_MINUTE));
  while (result.length > limit) {
    // 只在同一声道的「相邻」两段之间合并，并优先合并间隔最小的一对。
    // 按 startMs 排序后，同声道最近的一对必然相邻出现，一次线性扫描即可找到。
    let leftIndex = -1;
    let rightIndex = -1;
    let smallestGap = Number.POSITIVE_INFINITY;
    const lastIndexByChannel = new Map<number, number>();
    for (let index = 0; index < result.length; index++) {
      const channel = result[index].channel;
      const previous = lastIndexByChannel.get(channel);
      if (previous !== undefined) {
        const gap = Math.max(0, result[index].startMs - result[previous].endMs);
        if (gap < smallestGap) {
          smallestGap = gap;
          leftIndex = previous;
          rightIndex = index;
        }
      }
      lastIndexByChannel.set(channel, index);
    }
    // 没有可合并的相邻对，或最近的一对也隔得太远 → 宁可超出配额，也不生成跨静音的巨块。
    if (leftIndex < 0 || rightIndex < 0 || smallestGap > SPEAKER_SPAN_MERGE_MAX_GAP_MS) break;
    const left = result[leftIndex];
    const right = result[rightIndex];
    result[leftIndex] = {
      ...left,
      startMs: Math.min(left.startMs, right.startMs),
      endMs: Math.max(left.endMs, right.endMs),
      peakRms: Math.max(left.peakRms, right.peakRms),
    };
    // 合并只扩大 endMs、不改变 startMs，排序键不变，无需重新排序。
    result.splice(rightIndex, 1);
  }
  return result;
}

function resampleLinear(samples: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) return samples.slice();
  const outputLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(samples.length - 1, left + 1);
    const mix = sourceIndex - left;
    output[i] = (samples[left] || 0) * (1 - mix) + (samples[right] || 0) * mix;
  }
  return output;
}

function encodeMonoWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return buffer;
}

function encodeMultichannelWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const channelCount = Math.max(1, Math.min(MAX_SPEAKER_CHANNELS, channels.length));
  const frameCount = Math.max(1, ...channels.slice(0, channelCount).map((samples) => samples.length));
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const value = Math.max(-1, Math.min(1, channels[channel][frame] || 0));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

export function renderMultichannelAudioBufferSliceToWav(
  audioBuffer: AudioBuffer,
  startMs: number,
  endMs: number,
  requestedChannelCount = MAX_SPEAKER_CHANNELS,
): Blob {
  const channelCount = Math.max(1, Math.min(
    clampSpeakerChannelCount(requestedChannelCount),
    clampSpeakerChannelCount(audioBuffer.numberOfChannels),
  ));
  const start = Math.max(0, Math.floor(Math.max(0, Number(startMs) || 0) * audioBuffer.sampleRate / 1000));
  const requestedEnd = Math.ceil(Math.max(Number(endMs) || 0, Number(startMs) || 0) * audioBuffer.sampleRate / 1000);
  const end = Math.min(audioBuffer.length, Math.max(start + 1, requestedEnd));
  const channels = Array.from({ length: channelCount }, (_item, index) => {
    const sliced = audioBuffer.getChannelData(index).slice(start, end);
    return resampleLinear(sliced, audioBuffer.sampleRate, OUTPUT_SAMPLE_RATE);
  });
  return new Blob([encodeMultichannelWav(channels, OUTPUT_SAMPLE_RATE)], { type: "audio/wav" });
}

function renderSpeakerSpan(audioBuffer: AudioBuffer, span: SpeakerAudioSpan): Blob {
  const samples = audioBuffer.getChannelData(span.channel - 1);
  const start = Math.max(0, Math.floor(span.startMs * audioBuffer.sampleRate / 1000));
  const end = Math.min(samples.length, Math.ceil(span.endMs * audioBuffer.sampleRate / 1000));
  const sliced = samples.slice(start, Math.max(start + 1, end));
  const resampled = resampleLinear(sliced, audioBuffer.sampleRate, OUTPUT_SAMPLE_RATE);
  return new Blob([encodeMonoWav(resampled, OUTPUT_SAMPLE_RATE)], { type: "audio/wav" });
}

function cleanChannelTranscript(value: string): string {
  return String(value || "")
    .replace(/^\s*\[(?:说话人\s*\d+|speaker[_\s-]*\d+|spk[_\s-]*\d+)\]\s*/gim, "")
    .trim();
}

export function formatChannelTranscript(parts: SpeakerTranscriptPart[]): string {
  const merged: SpeakerTranscriptPart[] = [];
  for (const part of parts.filter((item) => item.text.trim()).sort((a, b) => a.startMs - b.startMs || a.channel - b.channel)) {
    const previous = merged[merged.length - 1];
    if (previous && previous.speakerId === part.speakerId && part.startMs - previous.endMs <= 2500) {
      previous.text = `${previous.text} ${part.text}`.replace(/\s+/g, " ").trim();
      previous.endMs = Math.max(previous.endMs, part.endMs);
    } else {
      merged.push({ ...part });
    }
  }
  return merged.map((part) => [
    `<!-- lexvoice-speaker:${part.speakerId} -->`,
    `**${speakerLabelForChannel(part.channel)}：** ${part.text.trim()}`,
  ].join("\n")).join("\n\n");
}

function normalizeTranscriptForComparison(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/<!--[^>]*-->/g, "")
    .replace(/\*\*[^*]{0,24}[：:]\*\*/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function textBigrams(text: string): string[] {
  if (text.length < 2) return text ? [text] : [];
  const grams: string[] = [];
  for (let index = 0; index < text.length - 1; index++) grams.push(text.slice(index, index + 2));
  return grams;
}

function bigramDice(left: string, right: string): number {
  const leftGrams = textBigrams(left);
  const rightGrams = textBigrams(right);
  if (!leftGrams.length || !rightGrams.length) return left === right ? 1 : 0;
  const remaining = new Map<string, number>();
  for (const gram of rightGrams) remaining.set(gram, (remaining.get(gram) || 0) + 1);
  let matches = 0;
  for (const gram of leftGrams) {
    const count = remaining.get(gram) || 0;
    if (count <= 0) continue;
    matches += 1;
    remaining.set(gram, count - 1);
  }
  return (2 * matches) / (leftGrams.length + rightGrams.length);
}

function timeOverlapRatio(left: SpeakerTranscriptPart, right: SpeakerTranscriptPart): number {
  const overlap = Math.max(0, Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs));
  const shorter = Math.max(1, Math.min(left.endMs - left.startMs, right.endMs - right.startMs));
  return overlap / shorter;
}

function isLikelyCrosstalkDuplicate(left: SpeakerTranscriptPart, right: SpeakerTranscriptPart): boolean {
  if (left.channel === right.channel || timeOverlapRatio(left, right) < 0.55) return false;
  const leftText = normalizeTranscriptForComparison(left.text);
  const rightText = normalizeTranscriptForComparison(right.text);
  const shorterLength = Math.min(leftText.length, rightText.length);
  if (shorterLength < 6) return false;
  if (leftText === rightText) return true;
  const longerLength = Math.max(leftText.length, rightText.length);
  const contained = shorterLength >= 8
    && (leftText.includes(rightText) || rightText.includes(leftText))
    && shorterLength / longerLength >= 0.55;
  return contained || bigramDice(leftText, rightText) >= 0.72;
}

// 判定为串扰后，用声道音量决定「谁是主声道」。8% 的差值噪声就能翻转，
// 这里要求主声道明显更响（相对差 ≥ 25%）才凭音量裁决，否则退回文本长度/声道序号。
const CROSSTALK_DOMINANT_LEVEL_MARGIN = 0.25;

function pickDominantCrosstalkPart(
  left: SpeakerTranscriptPart,
  right: SpeakerTranscriptPart,
): SpeakerTranscriptPart {
  const louder = Math.max(left.peakRms, right.peakRms);
  const levelDifference = Math.abs(left.peakRms - right.peakRms);
  if (louder > 0 && levelDifference / louder > CROSSTALK_DOMINANT_LEVEL_MARGIN) {
    return left.peakRms > right.peakRms ? left : right;
  }
  const leftLength = normalizeTranscriptForComparison(left.text).length;
  const rightLength = normalizeTranscriptForComparison(right.text).length;
  if (Math.abs(leftLength - rightLength) >= 4) return leftLength > rightLength ? left : right;
  return left.channel <= right.channel ? left : right;
}

export function deduplicateOverlappingSpeakerParts(
  parts: SpeakerTranscriptPart[],
): { parts: SpeakerTranscriptPart[]; removed: number } {
  const ordered = parts
    .filter((part) => part && String(part.text || "").trim())
    .map((part) => ({ ...part }))
    .sort((left, right) => left.startMs - right.startMs || left.channel - right.channel);
  const removed = new Set<number>();
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex++) {
    if (removed.has(leftIndex)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex++) {
      if (removed.has(rightIndex)) continue;
      const left = ordered[leftIndex];
      const right = ordered[rightIndex];
      if (right.startMs >= left.endMs) break;
      if (!isLikelyCrosstalkDuplicate(left, right)) continue;
      const dominant = pickDominantCrosstalkPart(left, right);
      if (dominant === left) {
        removed.add(rightIndex);
      } else {
        removed.add(leftIndex);
        break;
      }
    }
  }
  return {
    parts: ordered.filter((_part, index) => !removed.has(index)),
    removed: removed.size,
  };
}

export async function transcribeAudioByChannels(
  plugin: TranscriptionPlugin,
  blob: Blob,
  mime: string,
  expectedChannelCount = 1,
  options: { requireSeparatedChannels?: boolean } = {},
): Promise<ChannelTranscriptionResult> {
  let decoded: AudioBuffer;
  try {
    decoded = await decodeAudioBlob(blob);
  } catch {
    const text = await transcribeAudio(plugin, blob, mime);
    return { text, actualChannelCount: 1, processedChannelCount: 1, usedMultichannel: false, separation: "unknown", parts: [], deduplicatedParts: 0, errors: [] };
  }
  const actualChannelCount = clampSpeakerChannelCount(decoded.numberOfChannels);
  const processedChannelCount = Math.min(actualChannelCount, clampSpeakerChannelCount(expectedChannelCount));
  if (actualChannelCount <= 1 || processedChannelCount <= 1) {
    const text = await transcribeAudio(plugin, blob, mime);
    return { text, actualChannelCount, processedChannelCount: 1, usedMultichannel: false, separation: "single", parts: [], deduplicatedParts: 0, errors: [] };
  }
  const channels = Array.from({ length: processedChannelCount }, (_item, index) => decoded.getChannelData(index));
  const analysis = analyzeAudioBufferChannels(decoded);
  if (analysis.separation === "duplicated") {
    const text = await transcribeAudio(plugin, blob, mime);
    return { text, actualChannelCount, processedChannelCount, usedMultichannel: false, separation: "duplicated", parts: [], deduplicatedParts: 0, errors: [] };
  }
  if (options.requireSeparatedChannels && analysis.separation !== "separated") {
    const text = await transcribeAudio(plugin, blob, mime);
    return {
      text,
      actualChannelCount,
      processedChannelCount,
      usedMultichannel: false,
      separation: analysis.separation,
      parts: [],
      deduplicatedParts: 0,
      errors: [],
    };
  }
  const redundantChannels = new Set<number>();
  for (const pair of analysis.pairs) {
    if (pair.correlation >= 0.995 && !redundantChannels.has(pair.leftChannel)) {
      redundantChannels.add(pair.rightChannel);
    }
  }
  let spans = limitSpeakerAudioSpans(
    planSpeakerAudioSpans(channels, decoded.sampleRate),
    8,
  ).filter((span) => !redundantChannels.has(span.channel));
  if (!spans.length) {
    const peaks = channels.map((samples) => frameRms(samples, 0, samples.length));
    const loudest = peaks.indexOf(Math.max(...peaks));
    spans = [{
      speakerId: speakerIdForChannel(loudest + 1),
      channel: loudest + 1,
      startMs: 0,
      endMs: Math.round(decoded.duration * 1000),
      peakRms: peaks[loudest] || 0,
    }];
  }
  const parts: SpeakerTranscriptPart[] = [];
  const errors: string[] = [];
  for (const span of spans) {
    try {
      const spanBlob = renderSpeakerSpan(decoded, span);
      const text = cleanChannelTranscript(await transcribeAudio(plugin, spanBlob, spanBlob.type));
      if (text) parts.push({ ...span, text });
    } catch (error) {
      errors.push(`CH${span.channel} ${Math.round(span.startMs / 1000)}s：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!parts.length && errors.length) throw new Error(`分声道转写失败：${errors[0]}`);
  const deduplicated = deduplicateOverlappingSpeakerParts(parts);
  return {
    text: formatChannelTranscript(deduplicated.parts),
    actualChannelCount,
    processedChannelCount,
    usedMultichannel: true,
    separation: analysis.separation,
    parts: deduplicated.parts,
    deduplicatedParts: deduplicated.removed,
    errors,
  };
}
