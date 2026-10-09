import * as obsidian from "obsidian";
import { AUDIO_EXT } from "../shared/catalog-import";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { MAX_SPEAKER_CHANNELS, initialAudioChannelRuntimeMode, normalizeAudioChannelMode } from "../audio/channel-speakers";
import { NS_AUDIO_ALT } from "../shared/namespace";
import type { AudioChannelMode, TranscribeQueueTaskPayload } from "../shared/types";
import { mimeFromExt } from "../shared/util-audio";
import { t } from "../shared/i18n";

function coercePath(value: unknown): string {
  // Keep path/fallback coercion identical to the former queue service boundary.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve legacy String coercion for unknown queue values
  return String(value || "");
}

export interface AudioBlobSource {
  blob: Blob;
  sourcePath: string;
  sourceName: string;
  recovered: boolean;
}

export interface TranscribeAudioVault {
  getAbstractFileByPath(path: string): obsidian.TAbstractFile | null;
  readBinary(file: obsidian.TFile): Promise<ArrayBuffer>;
  getFiles?(): obsidian.TFile[];
  adapter?: { exists(path: string): Promise<boolean>; readBinary(path: string): Promise<ArrayBuffer> } | null;
}

export interface TranscribeAudioSourcePort {
  getVault(): TranscribeAudioVault;
  getAudioFolder(): string | undefined;
  getAudioChannelMode(): AudioChannelMode | undefined;
  decodeAudioBlob(blob: Blob): Promise<AudioBuffer>;
  renderMonoSlice(buffer: AudioBuffer, startMs: number, endMs: number): Promise<Blob>;
  renderMultichannelSlice(buffer: AudioBuffer, startMs: number, endMs: number, channelCount: number): Blob;
  logDiagnostic(level: "warn", code: string, message: string, data: Record<string, unknown>): Promise<void>;
}

export async function readVaultAudioBlob(port: TranscribeAudioSourcePort, path: unknown, fallbackName: unknown): Promise<AudioBlobSource | null> {
  const norm = obsidian.normalizePath(coercePath(path));
  if (!norm) return null;
  const file = port.getVault().getAbstractFileByPath(norm);
  let ab: ArrayBuffer | null = null;
  let sourceName = coercePath(fallbackName || norm.split("/").pop() || "");
  let sourcePath = norm;
  let ext = String(sourceName.split(".").pop() || "").toLowerCase();
  if (file instanceof obsidian.TFile) {
    ab = await port.getVault().readBinary(file);
    sourceName = file.name;
    sourcePath = file.path;
    ext = (file.extension || ext).toLowerCase();
  } else {
    // .cache 等点目录可能不会进入 Vault 的 TFile 索引，但 adapter 仍可稳定读写。
    const adapter = port.getVault().adapter;
    if (!adapter || !(await adapter.exists(norm))) return null;
    ab = await adapter.readBinary(norm);
  }
  return {
    blob: new Blob([ab], { type: mimeFromExt(ext) }),
    sourcePath,
    sourceName,
    recovered: false,
  };
}

export function resolveRetrySourceFile(port: TranscribeAudioSourcePort, task: TranscribeQueueTaskPayload): obsidian.TFile | null {
  const candidates: string[] = [];
  const push = (path: unknown) => {
    const norm = obsidian.normalizePath(coercePath(path).trim());
    if (norm && !candidates.includes(norm)) candidates.push(norm);
  };

  push(task.sourceAudioPath);
  push(task.masterAudioPath);

  const audioName = String(task.audioName || (task.audioPath || "").split("/").pop() || "");
  const match = audioName.match(new RegExp(`^(${NS_AUDIO_ALT}-\\d{8}-\\d{6})-seg\\d+\\.(\\w+)$`, "i"));
  if (match) {
    const folder = obsidian.normalizePath(port.getAudioFolder() || DEFAULT_SETTINGS.audioFolder || "");
    const stem = match[1];
    const ext = match[2] || "m4a";
    for (const candidateExt of Array.from(new Set([ext, "m4a", "mp4", "webm", "wav"]))) {
      push(folder ? `${folder}/${stem}.${candidateExt}` : `${stem}.${candidateExt}`);
    }
  }

  for (const path of candidates) {
    const file = port.getVault().getAbstractFileByPath(path);
    if (file instanceof obsidian.TFile && AUDIO_EXT.has(String(file.extension || "").toLowerCase())) return file;
  }

  if (match) {
    const stem = match[1];
    const folder = obsidian.normalizePath(port.getAudioFolder() || DEFAULT_SETTINGS.audioFolder || "");
    const files = port.getVault().getFiles?.() || [];
    return files.find(file => file instanceof obsidian.TFile
      && AUDIO_EXT.has(String(file.extension || "").toLowerCase())
      && file.basename === stem
      && (!folder || obsidian.normalizePath(file.path).startsWith(folder + "/"))) || null;
  }

  return null;
}

export async function recoverTaskAudioBlob(port: TranscribeAudioSourcePort, task: TranscribeQueueTaskPayload): Promise<AudioBlobSource | null> {
  const start = Number.isFinite(Number(task.audioStartOffsetMs)) ? Number(task.audioStartOffsetMs) : Number(task.startOffsetMs);
  const end = Number.isFinite(Number(task.audioEndOffsetMs)) ? Number(task.audioEndOffsetMs) : Number(task.endOffsetMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const sourceFile = resolveRetrySourceFile(port, task);
  if (!(sourceFile instanceof obsidian.TFile)) return null;

  const source = await readVaultAudioBlob(port, sourceFile.path, sourceFile.name);
  if (!source || !source.blob) return null;
  try {
    const audioBuffer = await port.decodeAudioBlob(source.blob);
    const reportedChannelCount = Math.max(1, Number(task.audioChannelCount) || 1);
    const channelMode = normalizeAudioChannelMode(task.audioChannelMode || port.getAudioChannelMode());
    const runtimeChannelMode = task.audioChannelRuntimeMode
      || initialAudioChannelRuntimeMode(channelMode, reportedChannelCount);
    const inspectRecordedChannels = task.captureMode === "mic" && runtimeChannelMode !== "mono";
    const requestedChannelCount = inspectRecordedChannels ? MAX_SPEAKER_CHANNELS : 1;
    const sliceBlob = requestedChannelCount > 1
      ? port.renderMultichannelSlice(audioBuffer, start, end, requestedChannelCount)
      : await port.renderMonoSlice(audioBuffer, start, end);
    return {
      blob: sliceBlob,
      sourcePath: sourceFile.path,
      sourceName: sourceFile.name,
      recovered: true,
    };
  } catch (e: unknown) {
    const message = e && typeof e === "object" && "message" in e ? e.message || e : e;
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve legacy error-value conversion
    throw new Error(t("Temporary clip missing; the full recording was found but cannot be re-sliced: {0}").replace("{0}", String(message)));
  }
}

export async function readTaskAudioBlob(port: TranscribeAudioSourcePort, task: TranscribeQueueTaskPayload): Promise<AudioBlobSource> {
  const direct = await readVaultAudioBlob(port, task.audioPath, task.audioName);
  if (direct) return direct;

  const recovered = await recoverTaskAudioBlob(port, task);
  if (recovered) {
    await port.logDiagnostic("warn", "queue.transcribe_audio_recovered", t("Transcription retry recovered a temporary clip from the full recording"), {
      audioName: task.audioName || "",
      sourceAudioName: recovered.sourceName || "",
      startOffsetMs: task.startOffsetMs,
      endOffsetMs: task.endOffsetMs,
    });
    return recovered;
  }

  throw new Error(t("Audio missing: {0}").replace("{0}", String(task.audioPath || task.audioName || t("Unknown audio"))));
}
