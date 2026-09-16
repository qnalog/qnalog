/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 知识库清理：删除符合条件的历史文件（空白短录音及其音频）。
// 由 main.ts 抽出（模块化拆解，纯搬迁）。

import * as obsidian from "obsidian";
import { qnalogConfirm, trashVaultFileRef } from "../ui/helpers";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { PluginSettings, RecordingSession } from "../shared/types";
import { formatElapsed } from "../shared/util-common";
import { resolveAudioFileRef } from "../notes/audio-refs";
import { analyzeEmptyShortNote } from "../notes/note-markdown";
import { TaskQueue } from "../queue/task-queue";

import { t } from "../shared/i18n";
/** CleanupService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface CleanupHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  queue: TaskQueue | null;
  saveAll(): Promise<void>;
  session: RecordingSession | null;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
}

export class CleanupService {
  declare host: CleanupHost;
  constructor(host: CleanupHost) {
    this.host = host;
  }

  async cleanupEmptyShortRecordings() {
    const folderPath = obsidian.normalizePath(this.host.settings.mdFolder || DEFAULT_SETTINGS.mdFolder);
    const folder = this.host.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof obsidian.TFolder)) {
      new obsidian.Notice(`${t("Transcript minutes folder not found: ")}${folderPath}`, 8000);
      return;
    }

    const files = [];
    const walk = (item) => {
      if (item instanceof obsidian.TFolder) {
        for (const child of item.children) walk(child);
      } else if (item instanceof obsidian.TFile && item.extension === "md") {
        files.push(item);
      }
    };
    walk(folder);

    const currentPath = this.host.session && this.host.session.mdPath ? obsidian.normalizePath(this.host.session.mdPath) : "";
    const candidates = [];
    for (const file of files) {
      if (currentPath && obsidian.normalizePath(file.path) === currentPath) continue;
      try {
        const content = await this.host.app.vault.read(file);
        const candidate = analyzeEmptyShortNote(file, content, this.host.settings);
        if (!candidate) continue;
        const audioFiles = [];
        const seenAudio = new Set();
        for (const ref of candidate.audioRefs) {
          const audioFile = resolveAudioFileRef(this.host.app, this.host.settings, ref);
          if (audioFile && !seenAudio.has(audioFile.path)) {
            seenAudio.add(audioFile.path);
            audioFiles.push(audioFile);
          }
        }
        candidate.audioFiles = audioFiles;
        candidates.push(candidate);
      } catch (e) {
        console.error("[QnALog] cleanup scan failed:", file.path, e);
      }
    }

    if (!candidates.length) {
      new obsidian.Notice(t("No blank short recordings matching the criteria were found"));
      return;
    }

    const uniqueAudioFiles = [];
    const audioPaths = new Set();
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
      .map((c) => `- ${c.file.path}（${formatElapsed(c.durationMs)}，录音 ${c.audioFiles.length} 个）`)
      .join("\n");
    const more = candidates.length > 10 ? `\n...另有 ${candidates.length - 10} 条` : "";
    const ok = await qnalogConfirm(
      this.host.app,
      "清理空白短录音",
      `发现 ${candidates.length} 条空白短录音。\n\n条件：时长不超过 10 秒，且没有有效转写文本。\n将移入系统废纸篓：${candidates.length} 篇纪要、${uniqueAudioFiles.length} 个录音文件。\n\n${preview}${more}\n\n继续清理吗？`,
      "清理"
    );
    if (!ok) return;

    let noteDeleted = 0;
    let audioDeleted = 0;
    let failed = 0;
    const deletedNotePaths = new Set();
    const deletedAudioPaths = new Set();

    for (const candidate of candidates) {
      try {
        await trashVaultFileRef(this.host.app, candidate.file);
        noteDeleted++;
        deletedNotePaths.add(obsidian.normalizePath(candidate.file.path));
      } catch (e) {
        failed++;
        console.error("[QnALog] cleanup note delete failed:", candidate.file.path, e);
      }
    }

    for (const audioFile of uniqueAudioFiles) {
      const current = this.host.app.vault.getAbstractFileByPath(audioFile.path);
      if (!(current instanceof obsidian.TFile)) continue;
      try {
        await trashVaultFileRef(this.host.app, current);
        audioDeleted++;
        deletedAudioPaths.add(obsidian.normalizePath(audioFile.path));
      } catch (e) {
        failed++;
        console.error("[QnALog] cleanup audio delete failed:", audioFile.path, e);
      }
    }

    const beforeQueue = this.host.queue.tasks.length;
    this.host.queue.tasks = this.host.queue.tasks.filter((task) => {
      const mdPath = task.mdPath ? obsidian.normalizePath(task.mdPath) : "";
      // audioPath 只存在于 transcribe 任务；其余任务没有音频可删，按空串处理（与原先读 undefined 的结果一致）。
      const audioPath = "audioPath" in task && task.audioPath ? obsidian.normalizePath(task.audioPath) : "";
      return !deletedNotePaths.has(mdPath) && !deletedAudioPaths.has(audioPath);
    });
    const queueRemoved = beforeQueue - this.host.queue.tasks.length;
    if (queueRemoved > 0) await this.host.saveAll();

    new obsidian.Notice(
      `${t("Cleanup complete: minutes ")}${noteDeleted}${t(" notes, recording ")}${audioDeleted}${t(", removed from the queue ")}${queueRemoved}${failed ? t(", failed {0}").replace("{0}", String(failed)) : ""}`,
      10000,
    );
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
