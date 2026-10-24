/**
 * Node stand-ins for the two browser audio classes the plugin's chunker uses
 * (AudioContext.decodeAudioData and OfflineAudioContext), backed by ffmpeg.
 *
 * The plugin cuts long audio in src/asr/transcribe.ts (decodeAudioBlob,
 * renderAudioBufferSliceToWav). The runner keeps that code and replaces only the
 * browser classes, so chunk boundaries, WAV encoding, silence detection and size
 * checks are the plugin's own.
 *
 * Differences from a browser that can change the audio sent to the service:
 * - decodeAudioData here keeps the file's own sample rate and channel count; a
 *   browser resamples to the audio device rate (44.1 or 48 kHz) first.
 * - The slice renderer mixes channels by averaging and resamples to 16 kHz with a
 *   box filter (mean of the input samples covered by each output sample). A browser
 *   uses its own mixer and resampler. Sample values differ slightly; length, rate
 *   and WAV layout do not.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface NodeAudioBuffer {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  duration: number;
  getChannelData(channel: number): Float32Array;
}

export function createAudioBuffer(channels: Float32Array[], sampleRate: number): NodeAudioBuffer {
  const length = channels[0]?.length ?? 0;
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length,
    duration: sampleRate > 0 ? length / sampleRate : 0,
    getChannelData: (channel: number) => channels[channel] ?? new Float32Array(0),
  };
}

/** Mean of all channels, sample by sample. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const length = channels[0]?.length ?? 0;
  const mixed = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) mixed[i] += channel[i] / channels.length;
  return mixed;
}

/** Box-filter average when lowering the rate, linear interpolation when raising it. */
export function resampleMono(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const outLength = Math.max(1, Math.round(samples.length * toRate / fromRate));
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    if (ratio > 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += samples[j];
      out[i] = sum / (end - start);
    } else {
      const position = i * ratio;
      const index = Math.floor(position);
      const next = Math.min(samples.length - 1, index + 1);
      const fraction = position - index;
      out[i] = samples[Math.min(index, samples.length - 1)] * (1 - fraction) + samples[next] * fraction;
    }
  }
  return out;
}

function run(command: string, args: string[]): Buffer {
  const result = spawnSync(command, args, { maxBuffer: 2 * 1024 * 1024 * 1024 });
  if (result.error) throw new Error(`${command} could not start (is it installed?): ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.toString().trim().split("\n").slice(-3).join(" ")}`);
  return result.stdout;
}

/** Decodes encoded audio bytes with ffmpeg into float channels at the file's own rate. */
export function decodeWithFfmpeg(bytes: ArrayBuffer): NodeAudioBuffer {
  const directory = mkdtempSync(path.join(tmpdir(), "qnalog-accuracy-audio-"));
  try {
    const file = path.join(directory, "input");
    writeFileSync(file, new Uint8Array(bytes));
    const probe = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels,sample_rate", "-of", "json", file]).toString()) as { streams?: Array<{ channels?: number; sample_rate?: string }> };
    const stream = probe.streams?.[0];
    const channelCount = Number(stream?.channels) || 0;
    const sampleRate = Number(stream?.sample_rate) || 0;
    if (channelCount < 1 || sampleRate < 1) throw new Error("ffprobe found no audio stream.");
    const raw = run("ffmpeg", ["-v", "error", "-i", file, "-vn", "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"]);
    const interleaved = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength - (raw.byteLength % 4)));
    const frames = Math.floor(interleaved.length / channelCount);
    const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i++) for (let c = 0; c < channelCount; c++) channels[c][i] = interleaved[i * channelCount + c];
    return createAudioBuffer(channels, sampleRate);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Duration in milliseconds from ffprobe, for the progress estimate only; it is not sent to any service. */
export function probeDurationMs(file: string): number {
  const seconds = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

class NodeAudioContext {
  async decodeAudioData(data: ArrayBuffer): Promise<NodeAudioBuffer> { return decodeWithFfmpeg(data); }
  async close(): Promise<void> { /* nothing to release */ }
}

interface SliceSource {
  buffer: NodeAudioBuffer | null;
  offsetSec: number;
  durationSec: number;
  connect(destination: unknown): void;
  start(when?: number, offset?: number, duration?: number): void;
}

class NodeOfflineAudioContext {
  readonly destination = {};
  private readonly source: SliceSource;
  constructor(private readonly channelCount: number, private readonly frameCount: number, private readonly sampleRate: number) {
    this.source = {
      buffer: null, offsetSec: 0, durationSec: 0,
      connect: () => { /* the only destination is this context */ },
      start: (_when?: number, offset?: number, duration?: number) => { this.source.offsetSec = offset ?? 0; this.source.durationSec = duration ?? 0; },
    };
  }
  createBufferSource(): SliceSource { return this.source; }
  async startRendering(): Promise<NodeAudioBuffer> {
    const { buffer, offsetSec, durationSec } = this.source;
    if (!buffer) throw new Error("No audio buffer was attached to the slice renderer.");
    const startFrame = Math.min(buffer.length, Math.round(offsetSec * buffer.sampleRate));
    const endFrame = Math.min(buffer.length, startFrame + Math.round(durationSec * buffer.sampleRate));
    const slice = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).subarray(startFrame, endFrame));
    const mono = resampleMono(mixToMono(slice), buffer.sampleRate, this.sampleRate);
    const padded = new Float32Array(this.frameCount);
    padded.set(mono.subarray(0, this.frameCount));
    return createAudioBuffer(Array.from({ length: this.channelCount }, () => padded), this.sampleRate);
  }
}

/** Makes `window` the Node global object and installs the audio classes the plugin looks up on it. */
export function installNodeAudioGlobals(): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.window = globalThis;
  scope.AudioContext = NodeAudioContext;
  scope.OfflineAudioContext = NodeOfflineAudioContext;
}
