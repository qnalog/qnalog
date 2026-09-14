/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：历史数据迁移与清理：旧版笔记属性补全、默认目录迁移、空白短录音清理

import * as obsidian from "obsidian";
import { qnalogConfirm, trashVaultFileRef } from "../ui/helpers";
import { parseVocabularyGroups, isStructuredVocabularyMarkdown, formatVocabularyMarkdown } from "../vocabulary";
import { DEFAULT_LIBRARY_PATHS, DEFAULT_SETTINGS, LEGACY_DEFAULT_LIBRARY_PATHS } from "../shared/defaults";
import { LEGACY_VOCABULARY_FILE } from "../shared/settings-io";
import type { PluginSettings, RecordingSession } from "../shared/types";
import { isRecord, pickDefined, formatElapsed } from "../shared/util-common";
import { resolveAudioFileRef } from "../notes/audio-refs";
import { analyzeEmptyShortNote, formatYamlDateTime, inferNoteStartedAtIso, inferModeFromLegacyNote, inferTopicFromFilename } from "../notes/note-markdown";
import { TaskQueue } from "../queue/task-queue";
import { ensureVaultFolder } from "../shared/util-vault";

/** MigrationService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface MigrationHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  queue: TaskQueue | null;
  saveAll(): Promise<void>;
  session: RecordingSession | null;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
}

export class MigrationService {
  declare host: MigrationHost;
  constructor(host) {
    this.host = host;
  }

  // 历史笔记迁移：扫描 mdFolder 下所有 .md，给没有 frontmatter 的老纪要补全 mode/日期/主题/tags
  // 已有 mode 字段的跳过；无法识别模式的也跳过；其他都补全（写入最小 frontmatter）
  async migrateLegacyNotes() {
    const folderPath = obsidian.normalizePath(this.host.settings.mdFolder || "LexVoice/转写纪要");
    const folder = this.host.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof obsidian.TFolder)) {
      throw new Error("笔记文件夹不存在：" + folderPath);
    }
    const files = [];
    const walk = (f) => {
      if (f instanceof obsidian.TFolder) for (const c of f.children) walk(c);
      else if (f instanceof obsidian.TFile && f.extension === "md") files.push(f);
    };
    walk(folder);

    let migrated = 0, skipped = 0, noMode = 0, failed = 0;
    const failedFiles = [];

    for (const file of files) {
      try {
        const content = await this.host.app.vault.read(file);
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
        if (fmMatch) {
          try {
            const fm = obsidian.parseYaml(fmMatch[1]);
            if (fm && fm.mode) { skipped++; continue; }
          } catch { /* intentionally empty */ }
        }
        const mode = inferModeFromLegacyNote(file.name, content);
        if (!mode) { noMode++; continue; }

        const dateMatch = file.name.match(/^(\d{4}-\d{2}-\d{2})/);
        const date = dateMatch ? dateMatch[1] : "";
        const durationMatch = content.match(/时长\s*[:：]\s*([\d:]+)/);
        const duration = durationMatch ? durationMatch[1] : "";
        const topic = inferTopicFromFilename(file.name);

        const fmObj: Record<string, string | string[]> = { mode };
        // 统一用 time（ISO datetime），不再写 日期；从文件名日期 + ctime 兜底推断，保证非空、跨模式一致。
        const tval = formatYamlDateTime(inferNoteStartedAtIso(file, date ? { "日期": date } : {}));
        if (tval) fmObj.time = tval;
        if (duration) fmObj["时长"] = duration;
        if (topic) fmObj["主题"] = topic; // 统一主键为 主题（含 huddle，不再写 议题）
        fmObj["状态"] = "已整理";
        fmObj["tags"] = ["lexvoice/" + mode, "lexvoice/legacy"];

        let yamlBlock;
        try { yamlBlock = obsidian.stringifyYaml(fmObj); }
        catch {
          yamlBlock = Object.entries(fmObj).map(([k, v]) =>
            Array.isArray(v) ? k + ":\n" + v.map(x => "  - " + x).join("\n") : k + ": " + v
          ).join("\n") + "\n";
        }

        let newContent;
        if (fmMatch) newContent = "---\n" + yamlBlock + "---\n" + content.slice(fmMatch[0].length);
        else newContent = "---\n" + yamlBlock + "---\n\n" + content;

        await this.host.app.vault.modify(file, newContent);
        migrated++;
      } catch (e) {
        console.error("[QnALog] migrate failed:", file.path, e);
        failedFiles.push(file.path);
        failed++;
      }
    }
    return { migrated, skipped, noMode, failed, failedFiles, total: files.length };
  }

  async cleanupEmptyShortRecordings() {
    const folderPath = obsidian.normalizePath(this.host.settings.mdFolder || DEFAULT_SETTINGS.mdFolder);
    const folder = this.host.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof obsidian.TFolder)) {
      new obsidian.Notice(`转写纪要文件夹不存在：${folderPath}`, 8000);
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
      new obsidian.Notice("没有发现符合条件的空白短录音");
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

    new obsidian.Notice(`清理完成：纪要 ${noteDeleted} 篇，录音 ${audioDeleted} 个，队列移除 ${queueRemoved} 条${failed ? `，失败 ${failed} 项` : ""}`, 10000);
  }
  async migrateDefaultVocabularyFileLocation(savedData) {
    const saved = isRecord(savedData) ? savedData : {};
    const raw = isRecord(saved.settings) ? saved.settings : saved;
    const vocabulary = isRecord(raw.vocabulary) ? raw.vocabulary : {};
    const savedPath = pickDefined(vocabulary.notePath, raw.vocabularyFile, "");
    const normSaved = obsidian.normalizePath(savedPath || "");
    const usesLegacyDefault = !normSaved || normSaved.toLowerCase() === LEGACY_VOCABULARY_FILE.toLowerCase();
    if (!usesLegacyDefault) return false;

    const oldPath = obsidian.normalizePath(LEGACY_VOCABULARY_FILE);
    const newPath = obsidian.normalizePath(DEFAULT_SETTINGS.vocabularyFile);
    let changed = this.host.settings.vocabularyFile !== newPath;
    this.host.settings.vocabularyFile = newPath;

    const oldFile = this.host.app.vault.getAbstractFileByPath(oldPath);
    const newFile = this.host.app.vault.getAbstractFileByPath(newPath);
    if (oldFile instanceof obsidian.TFile && !(newFile instanceof obsidian.TFile)) {
      const folderPath = newPath.includes("/") ? newPath.slice(0, newPath.lastIndexOf("/")) : "";
      if (folderPath) await ensureVaultFolder(this.host.app, folderPath);
      await this.host.app.fileManager.renameFile(oldFile, newPath);
      changed = true;
    }
    const targetFile = this.host.app.vault.getAbstractFileByPath(newPath);
    if (targetFile instanceof obsidian.TFile) {
      const content = await this.host.app.vault.cachedRead(targetFile);
      if (!isStructuredVocabularyMarkdown(content)) {
        await this.host.app.vault.modify(targetFile, formatVocabularyMarkdown(parseVocabularyGroups(content), this.host.settings.industryProfile));
        changed = true;
      }
    }
    return changed;
  }

  async migrateDefaultLibraryLayout(savedVersion) {
    if (Number(savedVersion) >= 4) return false;
    let changed = false;
    const migrations = [
      ["peopleDirectoryFolder", LEGACY_DEFAULT_LIBRARY_PATHS.peopleDirectoryFolder, DEFAULT_LIBRARY_PATHS.peopleDirectoryFolder],
      ["todoCardsFolder", LEGACY_DEFAULT_LIBRARY_PATHS.todoCardsFolder, DEFAULT_LIBRARY_PATHS.todoCardsFolder],
      ["basesFolder", LEGACY_DEFAULT_LIBRARY_PATHS.basesFolder, DEFAULT_LIBRARY_PATHS.basesFolder],
      ["peopleBaseFile", LEGACY_DEFAULT_LIBRARY_PATHS.peopleBaseFile, DEFAULT_LIBRARY_PATHS.peopleBaseFile],
      ["vocabularyFile", LEGACY_DEFAULT_LIBRARY_PATHS.vocabularyFile, DEFAULT_LIBRARY_PATHS.vocabularyFile],
      ["diagnosticsLogFolder", LEGACY_DEFAULT_LIBRARY_PATHS.diagnosticsLogFolder, DEFAULT_LIBRARY_PATHS.diagnosticsLogFolder],
    ];
    for (const [settingKey, legacyValue, nextValue] of migrations) {
      const current = obsidian.normalizePath(String(this.host.settings[settingKey] || ""));
      const legacyPath = obsidian.normalizePath(legacyValue);
      const nextPath = obsidian.normalizePath(nextValue);
      if (current.toLowerCase() !== legacyPath.toLowerCase()) continue;
      const legacyEntry = this.host.app.vault.getAbstractFileByPath(legacyPath);
      const nextEntry = this.host.app.vault.getAbstractFileByPath(nextPath);
      if (legacyEntry && nextEntry) {
        console.warn(`[QnALog] default library migration skipped because both paths exist: ${legacyPath} -> ${nextPath}`);
        continue;
      }
      if (legacyEntry && !nextEntry) {
        const parentPath = nextPath.includes("/") ? nextPath.slice(0, nextPath.lastIndexOf("/")) : "";
        if (parentPath) await ensureVaultFolder(this.host.app, parentPath);
        await this.host.app.fileManager.renameFile(legacyEntry, nextPath);
      }
      this.host.settings[settingKey] = nextPath;
      changed = true;
    }

    const legacyArchiveFolder = obsidian.normalizePath(LEGACY_DEFAULT_LIBRARY_PATHS.archiveFolder);
    const nextArchiveFolder = obsidian.normalizePath(DEFAULT_LIBRARY_PATHS.archiveFolder);
    const legacyArchiveFolderEntry = this.host.app.vault.getAbstractFileByPath(legacyArchiveFolder);
    const nextArchiveFolderEntry = this.host.app.vault.getAbstractFileByPath(nextArchiveFolder);
    if (legacyArchiveFolderEntry && !nextArchiveFolderEntry) {
      const parentPath = nextArchiveFolder.slice(0, nextArchiveFolder.lastIndexOf("/"));
      await ensureVaultFolder(this.host.app, parentPath);
      await this.host.app.fileManager.renameFile(legacyArchiveFolderEntry, nextArchiveFolder);
      changed = true;
    } else {
      const legacyArchive = obsidian.normalizePath(LEGACY_DEFAULT_LIBRARY_PATHS.duplicatePeopleArchiveFolder);
      const nextArchive = obsidian.normalizePath(DEFAULT_LIBRARY_PATHS.duplicatePeopleArchiveFolder);
      const legacyArchiveEntry = this.host.app.vault.getAbstractFileByPath(legacyArchive);
      const nextArchiveEntry = this.host.app.vault.getAbstractFileByPath(nextArchive);
      if (legacyArchiveEntry && !nextArchiveEntry) {
        await ensureVaultFolder(this.host.app, nextArchiveFolder);
        await this.host.app.fileManager.renameFile(legacyArchiveEntry, nextArchive);
        changed = true;
      }
    }
    return changed;
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
