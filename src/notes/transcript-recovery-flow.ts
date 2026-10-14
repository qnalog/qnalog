import * as obsidian from "obsidian";
import type { AsrTranscriptResult } from "../asr/transcript-result";
import { AUDIO_EXT } from "../shared/catalog-import";
import { NS_AUDIO_ALT, readNamespaceFrontmatter } from "../shared/namespace";
import { formatElapsed } from "../shared/util-common";
import { labelText } from "../shared/note-labels";
import { t } from "../shared/i18n";
import type { Segment } from "../shared/types";
import { attachTranscriptResult } from "../transcript/session-transcript";
import { serializeTranscriptBlock } from "../transcript/transcript-markdown";
import { getAudioTimeLink } from "./audio-reference-text";
import { getSourceIdFromMarkdown } from "./note-source-metadata";

/** 笔记里的原始转写丢失后，用对应录音重新转写并写回笔记所需的能力。 */
export interface TranscriptRecoveryPort {
  getVault(): Pick<obsidian.Vault, "read" | "process">;
  getCachedFrontmatter(file: obsidian.TFile): Record<string, unknown> | null | undefined;
  getAudioFiles(): obsidian.TFile[];
  pickAudioFile(files: obsidian.TFile[]): Promise<obsidian.TFile | null>;
  confirm(title: string, body: string, ctaText: string): Promise<boolean>;
  readAudio(file: obsidian.TFile): Promise<Blob>;
  transcribeWhole(blob: Blob, mime: string, options: { diarization: boolean; fileName: string }): Promise<AsrTranscriptResult>;
  refreshNoteIndex(file: obsidian.TFile, options: { reason: string }): Promise<unknown>;
  /** 备份文件所在的专用目录（不存在时由 createBackupFile 创建）。 */
  getBackupFolder(): string;
  /** 在专用目录里创建备份文件；同名时由实现取一个不冲突的路径。 */
  createBackupFile(path: string, content: string): Promise<obsidian.TFile>;
}

const TIME_RE = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/;
const RAW_HEADING_RE = /^##\s+(?:📁\s*)?(?:原始材料|Original material)\s*$/m;
const RECORDING_STEM_RE = new RegExp(`^${NS_AUDIO_ALT}-(\\d{8})-(\\d{6})$`, "i");

function scalarText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 19);
  return typeof value === "number" ? String(value) : "";
}

function isAudio(file: obsidian.TFile): boolean {
  return AUDIO_EXT.has(String(file.extension || "").toLowerCase());
}

/**
 * 找出笔记对应的录音文件：先看 frontmatter 记录的路径，再按录音时间与文件名里的时间戳匹配。
 * 分段临时文件（-segNN）不算候选。
 */
export function findRecoveryAudioCandidates(
  frontmatter: Record<string, unknown> | null | undefined,
  files: readonly obsidian.TFile[],
): obsidian.TFile[] {
  const audioFiles = files.filter(isAudio);
  const recorded = scalarText(readNamespaceFrontmatter(frontmatter, "audio"));
  if (recorded) {
    const path = obsidian.normalizePath(recorded.replace(/^\[\[|\]\]$/g, ""));
    const direct = audioFiles.filter((file) => obsidian.normalizePath(file.path) === path || file.name === path);
    if (direct.length) return direct;
  }
  const time = TIME_RE.exec(scalarText(readNamespaceFrontmatter(frontmatter, "time")));
  if (!time) return [];
  const date = `${time[1]}${time[2]}${time[3]}`;
  const clock = `${time[4]}${time[5]}${time[6]}`;
  return audioFiles.filter((file) => {
    const stem = RECORDING_STEM_RE.exec(file.basename);
    return !!stem && stem[1] === date && stem[2] === clock;
  });
}

function mimeOf(file: obsidian.TFile): string {
  const ext = String(file.extension || "").toLowerCase();
  const map: Record<string, string> = { m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg", mpeg: "audio/mpeg", wav: "audio/wav", webm: "audio/webm", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", aac: "audio/aac" };
  return map[ext] || "audio/mpeg";
}

export function insertRecoveredTranscript(markdown: string, block: string, backupLink = ""): string {
  const body = [backupLink ? `> ${t("Original transcript backup: ")}${backupLink}` : "", block.trim()].filter(Boolean).join("\n\n");
  const heading = RAW_HEADING_RE.exec(markdown);
  if (!heading) return `${markdown.trimEnd()}\n\n---\n\n## ${labelText("originalMaterial")}\n\n${body}\n`;
  const insertAt = heading.index + heading[0].length;
  return `${markdown.slice(0, insertAt)}\n\n${body}\n${markdown.slice(insertAt)}`;
}

function wikiLink(file: obsidian.TFile): string {
  return `[[${file.path.replace(/\.md$/i, "")}|${file.basename}]]`;
}

/**
 * 原始转写丢失时的恢复：确认录音 → 整段转写 → 写回「原始材料」区。
 * 返回 true 表示已写回新的转写；用户取消或找不到录音时返回 false，笔记不变。
 */
export async function recoverOriginalTranscript(port: TranscriptRecoveryPort, file: obsidian.TFile): Promise<boolean> {
  const frontmatter = port.getCachedFrontmatter(file) || null;
  const files = port.getAudioFiles();
  const candidates = findRecoveryAudioCandidates(frontmatter, files);
  let audio: obsidian.TFile | null = null;
  if (candidates.length === 1) {
    const ok = await port.confirm(
      t("Original transcript is missing"),
      t("This note no longer contains its original transcript. Transcribe the recording \"{0}\" again and write the result back to the note? This uses the transcription service and may take a while.").replace("{0}", candidates[0].path),
      t("Transcribe again"),
    );
    if (!ok) return false;
    audio = candidates[0];
  } else {
    const ok = await port.confirm(
      t("Original transcript is missing"),
      candidates.length > 1
        ? t("This note no longer contains its original transcript, and several recordings match its start time. Choose the recording to transcribe again.")
        : t("This note no longer contains its original transcript, and no recording matching its start time was found. Choose the recording to transcribe again."),
      t("Choose recording"),
    );
    if (!ok) return false;
    audio = await port.pickAudioFile(candidates.length ? candidates : files.filter(isAudio));
    if (!audio) return false;
  }

  new obsidian.Notice(t("Transcribing the recording again…"), 6000);
  const blob = await port.readAudio(audio);
  const result = await port.transcribeWhole(blob, mimeOf(audio), { diarization: true, fileName: audio.name });
  const text = String(result.text || "").trim();
  if (!text) throw new Error(t("Whole-file transcription returned an empty result."));

  const content = await port.getVault().read(file);
  const sourceId = getSourceIdFromMarkdown(content, file);
  const endOffsetMs = result.units.reduce((max, unit) => Math.max(max, Number(unit.endMs) || 0), 0);
  const base: Segment = {
    index: 0, startOffsetMs: 0, endOffsetMs,
    audioStartOffsetMs: 0, audioEndOffsetMs: endOffsetMs,
    audioName: audio.name, audioPath: audio.path,
    text, error: null, isFinal: true, source: "recording",
  };
  const segment = attachTranscriptResult(base, sourceId, result, "asr");
  const heading = `### ${labelText("segment", 1)} (${formatElapsed(0)}–${formatElapsed(endOffsetMs)}) ${getAudioTimeLink(audio.name, 0)}`;
  const block = serializeTranscriptBlock(segment, heading, text);

  // 先把转写结果存成备份文件，用户确认后才改动笔记。
  const backupName = `${t("[Original transcript]")}${file.basename}.md`.replace(/[\\/:*?"<>|#^[\]]/g, " ");
  const backupContent = [
    "---",
    `qnalog_source_path: ${JSON.stringify(file.path)}`,
    `qnalog_audio: ${JSON.stringify(audio.path)}`,
    "---",
    `# ${t("Original transcript backup")} · ${file.basename}`,
    "",
    `> ${t("Organized note: ")}${wikiLink(file)}`,
    "",
    block.trim(),
    "",
  ].join("\n");
  const backup = await port.createBackupFile(`${port.getBackupFolder()}/${backupName}`, backupContent);
  const proceed = await port.confirm(
    t("Transcription finished"),
    t("The new original transcript was saved as a backup: {0}. Write it back to the note and continue reorganizing?").replace("{0}", backup.path),
    t("Write back and reorganize"),
  );
  if (!proceed) {
    new obsidian.Notice(`${t("The note was not changed. Backup kept at: ")}${backup.path}`, 8000);
    return false;
  }
  await port.getVault().process(file, (latest) => insertRecoveredTranscript(latest, block, wikiLink(backup)));
  await port.refreshNoteIndex(file, { reason: "transcript-recovery" });
  return true;
}
