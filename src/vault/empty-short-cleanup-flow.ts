import * as obsidian from "obsidian";
import { analyzeEmptyShortNote, type EmptyShortNoteCandidate } from "../notes/empty-short-note";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { QueueTask } from "../shared/types";
import { formatElapsed } from "../shared/util-common";
import { t } from "../shared/i18n";

export interface EmptyShortCleanupPort {
  getMdFolder(): string;
  getVault(): Pick<obsidian.Vault, "getAbstractFileByPath" | "read">;
  getCurrentSessionPath(): string | null;
  resolveAudio(ref: string): obsidian.TFile | null;
  confirm(title: string, body: string, cta: string): Promise<unknown>;
  trash(file: obsidian.TFile): Promise<void>;
  getQueue(): { tasks: QueueTask[] } | null;
  save(): Promise<void>;
}

export async function runEmptyShortRecordingCleanup(port: EmptyShortCleanupPort): Promise<void> {
  const folderPath = obsidian.normalizePath(port.getMdFolder() || DEFAULT_SETTINGS.mdFolder);
  const folder = port.getVault().getAbstractFileByPath(folderPath);
  if (!(folder instanceof obsidian.TFolder)) {
    new obsidian.Notice(`${t("Transcript minutes folder not found: ")}${folderPath}`, 8000);
    return;
  }

  const files: obsidian.TFile[] = [];
  const walk = (item: obsidian.TAbstractFile): void => {
    if (item instanceof obsidian.TFolder) {
      for (const child of item.children) walk(child);
    } else if (item instanceof obsidian.TFile && item.extension === "md") {
      files.push(item);
    }
  };
  walk(folder);

  const sessionPath = port.getCurrentSessionPath();
  const currentPath = sessionPath ? obsidian.normalizePath(sessionPath) : "";
  const candidates: Array<EmptyShortNoteCandidate<obsidian.TFile> & { audioFiles: obsidian.TFile[] }> = [];
  for (const file of files) {
    if (currentPath && obsidian.normalizePath(file.path) === currentPath) continue;
    try {
      const content = await port.getVault().read(file);
      const candidate = analyzeEmptyShortNote(file, content);
      if (!candidate) continue;
      const audioFiles: obsidian.TFile[] = [];
      const seenAudio = new Set<string>();
      for (const ref of candidate.audioRefs) {
        const audioFile = port.resolveAudio(ref);
        if (audioFile && !seenAudio.has(audioFile.path)) {
          seenAudio.add(audioFile.path);
          audioFiles.push(audioFile);
        }
      }
      candidates.push({ ...candidate, audioFiles });
    } catch (error) {
      console.error("[QnALog] cleanup scan failed:", file.path, error);
    }
  }

  if (!candidates.length) {
    new obsidian.Notice(t("No blank short recordings matching the criteria were found"));
    return;
  }

  const uniqueAudioFiles: obsidian.TFile[] = [];
  const audioPaths = new Set<string>();
  for (const candidate of candidates) {
    for (const audioFile of candidate.audioFiles) {
      if (!audioPaths.has(audioFile.path)) {
        audioPaths.add(audioFile.path);
        uniqueAudioFiles.push(audioFile);
      }
    }
  }

  const preview = candidates
    .slice(0, 10)
    .map((candidate) => t("- {0} ({1}, {2} audio files)").replace("{0}", candidate.file.path).replace("{1}", formatElapsed(candidate.durationMs)).replace("{2}", String(candidate.audioFiles.length)))
    .join("\n");
  const more = candidates.length > 10 ? t("\n...and {0} more").replace("{0}", String(candidates.length - 10)) : "";
  const ok = await port.confirm(
    t("Clean up blank short recordings"),
    t("Found {0} blank short recordings.\n\nCriteria: no longer than 10 seconds and no valid transcript text.\nThe following will be moved to the system trash: {0} notes and {1} audio files.\n\n{2}{3}\n\nContinue cleanup?")
      .replace("{0}", String(candidates.length))
      .replace("{0}", String(candidates.length))
      .replace("{1}", String(uniqueAudioFiles.length))
      .replace("{2}", preview)
      .replace("{3}", more),
    t("Clean up"),
  );
  if (!ok) return;

  let noteDeleted = 0;
  let audioDeleted = 0;
  let failed = 0;
  const deletedNotePaths = new Set<string>();
  const deletedAudioPaths = new Set<string>();

  for (const candidate of candidates) {
    try {
      await port.trash(candidate.file);
      noteDeleted++;
      deletedNotePaths.add(obsidian.normalizePath(candidate.file.path));
    } catch (error) {
      failed++;
      console.error("[QnALog] cleanup note delete failed:", candidate.file.path, error);
    }
  }

  for (const audioFile of uniqueAudioFiles) {
    const current = port.getVault().getAbstractFileByPath(audioFile.path);
    if (!(current instanceof obsidian.TFile)) continue;
    try {
      await port.trash(current);
      audioDeleted++;
      deletedAudioPaths.add(obsidian.normalizePath(audioFile.path));
    } catch (error) {
      failed++;
      console.error("[QnALog] cleanup audio delete failed:", audioFile.path, error);
    }
  }

  const queue = port.getQueue();
  let queueRemoved = 0;
  if (queue) {
    const beforeQueue = queue.tasks.length;
    queue.tasks = queue.tasks.filter((task) => {
      const mdPath = task.mdPath ? obsidian.normalizePath(task.mdPath) : "";
      // audioPath 只存在于 transcribe 任务；其余任务没有音频可删，按空串处理（与原先读 undefined 的结果一致）。
      const audioPath = "audioPath" in task && task.audioPath ? obsidian.normalizePath(task.audioPath) : "";
      return !deletedNotePaths.has(mdPath) && !deletedAudioPaths.has(audioPath);
    });
    queueRemoved = beforeQueue - queue.tasks.length;
    if (queueRemoved > 0) await port.save();
  }

  new obsidian.Notice(
    `${t("Cleanup complete: minutes ")}${noteDeleted}${t(" notes, recording ")}${audioDeleted}${t(", removed from the queue ")}${queueRemoved}${failed ? t(", failed {0}").replace("{0}", String(failed)) : ""}`,
    10000,
  );
}
