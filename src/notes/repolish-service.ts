/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：重新整理：按说话人姓名重排当前纪要、生成清稿

import * as obsidian from "obsidian";
import { getModeMeta } from "../shared/mode-meta";
import { getSessionMetaDurationMs } from "../shared/util-text";
import { stripModeSuggestionBlocks } from "../llm/core";
import type { PluginSettings } from "../shared/types";
import { getLearnedLlmOutputCeiling } from "../llm/output-budget";
import { splitVersionPayload } from "../version-content";
import { getTaskErrorMessage } from "../shared/task-activity";
import { buildEmptyLlmOutputFallback, clearCommittedBriefingCheckpoint } from "../prompts/briefing-prompts";
import { getSegmentsDurationMs } from "../notes/audio-refs";
import { ROLE_MAPPING_FIELDS, applyRoleMappingToSegments, extractTranscriptSegments, extractRoleMappingFromFrontmatter, getSourceIdFromMarkdown, parseRoleMapItem } from "../notes/note-markdown";
import { detectRecentNoteMode } from "../recent/recent-notes";
import { cleanTranscript, mergeAndPolish } from "../briefing/merge-pipeline";
import { TaskActivityService } from "../tasks/task-activity-service";
import { VersionStore } from "../versions/version-store";
import { NoteIndexService } from "../notes/note-index-service";
import { isDerivedVersionType } from "../shared/namespace";

/** RepolishService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface RepolishHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  noteIndex: NoteIndexService;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
  tasks: TaskActivityService;
  versions: VersionStore;
}

export class RepolishService {
  declare host: RepolishHost;
  /** 同一篇笔记的重新整理串行化标记。 */
  declare _repolishInFlight;
  constructor(host) {
    this.host = host;
    this._repolishInFlight = null;
  }

  async repolishMarkdownFile(file, mode, repolishOptions = null) {
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") return;
    const meta = getModeMeta(this.host.settings, mode);
    let taskMeter = null;
    // 重新整理必须按来源纪要单飞。否则用户连续切换模式/重复点击时，两个
    // LLM 任务会同时写同一个版本缓存文件，Obsidian 会把后到的 create 请求
    // 拒绝为 "File already exists."，并留下一个看起来仍在运行的重复任务。
    let taskId = `repolish:${file.path}`;
    let taskStarted = false;
    let repolishLockAcquired = false;
    try {
      const content = await this.host.app.vault.read(file);
      const sourceId = getSourceIdFromMarkdown(content, file);
      taskId = `repolish:${sourceId || file.path}`;
      let segments = extractTranscriptSegments(content);
      if (!segments.length) {
        new obsidian.Notice("未找到 QnALog 原始转写。请在包含「分段原始转写」或录音段落的纪要 Markdown 上使用。", 8000);
        return;
      }

      // 从 frontmatter 解析角色映射（"代号 → 真名" 形式的条目）
      const fmCache = (this.host.app.metadataCache.getFileCache(file) || {}).frontmatter || null;
      const roleMapping = extractRoleMappingFromFrontmatter(fmCache);
      if (roleMapping.length) {
        segments = applyRoleMappingToSegments(segments, roleMapping);
      }

      // 从 frontmatter 取插件已注入的 time，作为 sessionMeta（避免 LLM 重新推断，保持时间不变）
      let sessionMeta = null;
      if (fmCache) {
        const fullTimeStr = fmCache.time || "";
        const durationStr = fmCache["时长"] || fmCache.duration || "";
        if (fullTimeStr) {
          const m = window.moment ? window.moment(fullTimeStr, [window.moment.ISO_8601, "YYYY-MM-DDTHH:mm:ss", "YYYY-MM-DD HH:mm:ss"], true) : null;
          if (m && m.isValid && m.isValid()) {
            sessionMeta = { startedAt: m.toDate().toISOString(), duration: String(durationStr || "").trim() };
          }
        } else {
          // 兼容旧笔记：早期版本可能写入"日期"和"时间"两个字段；重新整理后会迁移为 time。
          const dateStr = fmCache["日期"] || fmCache.date || "";
          const timeStr = fmCache["时间"] || "";
          if (dateStr) {
            const composed = String(dateStr).trim() + (timeStr ? "T" + String(timeStr).trim() : "");
            const m = window.moment ? window.moment(composed, ["YYYY-MM-DDTHH:mm", "YYYY-MM-DD", "YYYY-MM-DDTHH:mm:ss"], true) : null;
            if (m && m.isValid && m.isValid()) {
              sessionMeta = { startedAt: m.toDate().toISOString(), duration: String(durationStr || "").trim() };
            }
          }
        }
      }

      if (!this._repolishInFlight) this._repolishInFlight = new Set();
      if (this._repolishInFlight.has(taskId)) {
        new obsidian.Notice("这篇纪要正在重新整理，请等待当前任务完成。", 5000);
        return;
      }
      this._repolishInFlight.add(taskId);
      repolishLockAcquired = true;

      const preferenceLabel = repolishOptions && repolishOptions.label ? ` · ${repolishOptions.label}` : "";
      const mapNotice = roleMapping.length
        ? `QnALog：应用 ${roleMapping.length} 条角色映射后按${meta.prefix}模式重新整理${preferenceLabel}…`
        : `QnALog：正在按${meta.prefix}模式重新整理${preferenceLabel}…`;
      new obsidian.Notice(mapNotice);
      // 把笔记原 frontmatter 传给 mergeAndPolish，post-process 阶段会作为 base 保留用户改动
      // （包括用户已应用的角色映射变更，仅 system 字段被覆盖、tags 被 merge）
      const originalFmForRegen = fmCache ? Object.assign({}, fmCache) : null;
      // 在 originalFm 里应用角色映射的"压平"，避免 base 里仍然带 → 形式
      if (originalFmForRegen && roleMapping.length) {
        for (const f of ROLE_MAPPING_FIELDS) {
          const v = originalFmForRegen[f];
          if (Array.isArray(v)) {
            originalFmForRegen[f] = v.map(item => {
              const m = parseRoleMapItem(item);
              return m ? m.to : item;
            });
          } else if (typeof v === "string") {
            const m = parseRoleMapItem(v);
            if (m) originalFmForRegen[f] = m.to;
          }
        }
      }
      this.host.tasks._busyLabel = `重新整理中（${meta.prefix}）…`;
      const sourceMode = detectRecentNoteMode(this.host, file, fmCache);
      const sourceModeLabel = sourceMode && sourceMode !== "off"
        ? ((getModeMeta(this.host.settings, sourceMode) || {}).label || sourceMode)
        : "未标注";
      this.host.tasks._busyContext = {
        kind: "重新整理",
        sourceFile: file.basename,
        sourceFolder: file.parent && file.parent.path ? file.parent.path : "知识库根目录",
        durationMs: getSegmentsDurationMs(segments) || getSessionMetaDurationMs(sessionMeta),
        sourceModeLabel,
        targetModeLabel: [meta.label || meta.prefix, repolishOptions && repolishOptions.label]
          .filter(Boolean)
          .join(" · "),
      };
      taskStarted = true;
      this.host.tasks.startTaskActivity({
        id: taskId,
        kind: "repolish",
        title: `重新整理 · ${meta.prefix}`,
        subject: file.path,
        status: "running",
        stage: "llm",
        stageLabel: "AI 重新整理",
        detail: preferenceLabel ? `正在准备原始转写 · ${preferenceLabel.replace(/^\s*·\s*/, "")}` : "正在准备原始转写",
        progress: 3,
        actions: [],
      });
      this.host.tasks.updateBusyStatus();
      taskMeter = this.host.tasks.beginTaskMeter();
      sessionMeta = Object.assign({}, sessionMeta || {}, { _taskActivityId: taskId, _taskMeter: taskMeter });
      const polished = await mergeAndPolish(this.host, segments, mode, sessionMeta, originalFmForRegen, repolishOptions);
      this.host.tasks.patchTaskActivity(taskId, {
        stage: "writing",
        stageLabel: "正在生成新版本",
        detail: "AI 正文已经完成，正在写入 Markdown",
        progress: 94,
        deadlineAt: 0,
      });

      // 重新整理只生成派生纪要，不重命名、不修改母本。角色映射只作为本次
      // LLM 输入使用，原始转写和用户已经保存的 YAML 必须保持可追溯。
      const dailyTargetFile = file;
      const latestSourceContent = await this.host.app.vault.read(dailyTargetFile);
      const versionLabel = `${meta.prefix}${preferenceLabel}`;
      const versionStyle = repolishOptions && repolishOptions.label ? repolishOptions.label : "";
      const versionBody = stripModeSuggestionBlocks(polished || buildEmptyLlmOutputFallback()).trim();
      const versionParts = splitVersionPayload(versionBody);
      const fallbackVersion = {
        body: versionParts.body.trim() || buildEmptyLlmOutputFallback(),
        frontmatter: versionParts.frontmatter || "",
        meta: {
          sourceId: getSourceIdFromMarkdown(latestSourceContent, dailyTargetFile),
          createdAt: window.moment ? window.moment().format("YYYY-MM-DD HH:mm:ss") : new Date().toISOString(),
        },
      };

      // 可见副本是用户交付物，必须先落盘；版本缓存/manifest 只是索引，
      // 即使索引写入异常，也不能阻断新纪要生成。
      const derivedFile = await this.host.versions.createDerivedNote(
        dailyTargetFile,
        latestSourceContent,
        fallbackVersion,
        versionLabel,
        mode,
        versionStyle,
      );
      this.host.tasks.patchTaskActivity(taskId, {
        stage: "postprocess",
        stageLabel: "正在完成文件处理",
        detail: derivedFile instanceof obsidian.TFile ? derivedFile.path : "新版本已经写入",
        progress: 98,
        deadlineAt: 0,
      });
      await clearCommittedBriefingCheckpoint(this.host, sessionMeta);
      let versionCacheError = "";
      try {
        await this.host.versions.saveVersion(dailyTargetFile, latestSourceContent, segments, {
          kind: "minutes",
          label: versionLabel,
          mode,
          style: versionStyle,
          idLabel: `${meta.prefix}${versionStyle ? "-" + versionStyle : ""}`,
          body: versionBody,
          activate: false,
        });
      } catch (cacheError) {
        versionCacheError = getTaskErrorMessage(cacheError);
        console.warn("[QnALog] derived note created but version cache update failed", cacheError);
      }
      try {
        const dailyFile = derivedFile instanceof obsidian.TFile ? derivedFile : dailyTargetFile;
        const dailyContent = await this.host.app.vault.read(dailyFile);
        await this.host.noteIndex.appendDailyMeetingOverviewForMarkdown(dailyFile, dailyContent, polished, mode, segments, sessionMeta);
      } catch (e) {
        console.error("[QnALog] daily overview after repolish failed", e);
      }
      const outputPath = derivedFile instanceof obsidian.TFile ? derivedFile.path : dailyTargetFile.path;
      new obsidian.Notice(`QnALog：已生成${meta.prefix}派生纪要${preferenceLabel}${roleMapping.length ? `（角色映射 ${roleMapping.length} 条已应用）` : ""}${versionCacheError ? "（版本索引稍后可重建）" : ""}`);
      const completedTaskMeter = taskMeter ? this.host.tasks.endTaskMeter(taskMeter) : null;
      taskMeter = null;
      try { this.host.tasks.logCompletedWork(`重新整理完成 · ${meta.prefix}`, (file && file.path) || "", completedTaskMeter); } catch { /* intentionally empty */ }
      this.host.tasks.completeTaskActivity(taskId, {
        stage: "done",
        stageLabel: "新版本已生成",
        detail: versionCacheError ? `${outputPath} · 版本索引未同步：${versionCacheError}` : outputPath,
        subject: outputPath,
        progress: 100,
        actions: [
          { id: "open-task-note", label: "打开纪要", primary: true },
          { id: "dismiss-task", label: "关闭记录" },
        ],
      });
    } catch (e) {
      console.error("[QnALog] repolish markdown failed", e);
      if (taskStarted) {
        this.host.tasks.failTaskActivity(taskId, e, {
          stage: "failed",
          stageLabel: "重新整理未完成",
          detail: getTaskErrorMessage(e),
          subject: file.path,
          actions: [
            { id: "open-task-note", label: "打开原始材料", primary: true },
            { id: "dismiss-task", label: "关闭记录" },
          ],
        });
      }
      new obsidian.Notice(`重新整理失败：${(e && e.message) || e}`, 8000);
    } finally {
      if (repolishLockAcquired && this._repolishInFlight) this._repolishInFlight.delete(taskId);
      if (taskMeter) this.host.tasks.endTaskMeter(taskMeter);
      this.host.tasks._busyLabel = null;
      this.host.tasks._busyContext = null;
      this.host.tasks.updateBusyStatus();
    }
  }
  // 生成清稿（派生版本·只读快照）：从母本逐字稿忠实清理成可读稿，写成独立文件、双链回指母本。
  // 永远从母本 raw 读（在派生上触发会先跳回母本）；清稿不含 raw、不参与「重新整理」回写。
  async generateCleanScript(file) {
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") return;
    let taskMeter = null;
    let taskId = `clean:${file.path}`;
    let taskStarted = false;
    try {
      // 在派生文件上触发 → 先跳回母本（派生 contains_raw:false，本身没有 raw 可读）。
      let sourceFile = file;
      let content = await this.host.app.vault.read(file);
      const fm = ((this.host.app.metadataCache.getFileCache(file) || {}).frontmatter) || {};
      if (isDerivedVersionType(fm["类型"]) || fm.contains_raw === false) {
        const srcPath = fm.source_path ? obsidian.normalizePath(String(fm.source_path)) : "";
        const resolved = srcPath ? this.host.app.vault.getAbstractFileByPath(srcPath) : null;
        if (resolved instanceof obsidian.TFile) {
          sourceFile = resolved;
          content = await this.host.app.vault.read(resolved);
        } else {
          new obsidian.Notice("这是派生版本，但来源笔记已被改名或移动。请在原始录音笔记中生成清稿。", 8000);
          return;
        }
      }
      const segments = extractTranscriptSegments(content);
      if (!segments.length) {
        new obsidian.Notice("未找到原始转写（逐字稿）。请在含「分段原始转写」的录音母本上生成清稿。", 8000);
        return;
      }
      const baseTitle = sourceFile.basename;
      taskId = `clean:${sourceFile.path}`;
      this.host.tasks._busyLabel = "清稿生成中…";
      const sourceFm = ((this.host.app.metadataCache.getFileCache(sourceFile) || {}).frontmatter) || {};
      const sourceMode = detectRecentNoteMode(this.host, sourceFile, sourceFm);
      this.host.tasks._busyContext = {
        kind: "生成清稿",
        sourceFile: sourceFile.basename,
        sourceFolder: sourceFile.parent && sourceFile.parent.path ? sourceFile.parent.path : "知识库根目录",
        durationMs: getSegmentsDurationMs(segments),
        sourceModeLabel: sourceMode && sourceMode !== "off"
          ? ((getModeMeta(this.host.settings, sourceMode) || {}).label || sourceMode)
          : "未标注",
        targetModeLabel: "清稿",
      };
      taskStarted = true;
      this.host.tasks.startTaskActivity({
        id: taskId,
        kind: "clean-transcript",
        title: "生成清稿",
        subject: sourceFile.path,
        status: "running",
        stage: "llm",
        stageLabel: "整理逐字稿",
        detail: "去除口语赘词并保留原始事实，不覆盖母本",
        progress: null,
        actions: [],
      });
      this.host.tasks.updateBusyStatus();
      new obsidian.Notice("QnALog：正在从母本逐字稿生成清稿…");
      taskMeter = this.host.tasks.beginTaskMeter();
      const { text: cleaned, truncated } = await cleanTranscript(this.host, segments, getLearnedLlmOutputCeiling(this.host.settings));
      if (!cleaned) throw new Error("模型没有返回可用清稿");
      const warn = truncated
        ? "> [!warning] 清稿可能被截断：部分内容或因模型输出上限未完整。建议换更大输出上限的模型后重新生成。\n\n"
        : "";
      const noteBody = `# [清稿] ${baseTitle}\n\n> [!note] 从母本逐字稿忠实清理的可读稿（非纪要、不摘要）。母本（事实源 / 逐字稿）：[[${baseTitle}]]\n\n${warn}${cleaned}`;
      const version = await this.host.versions.saveVersion(sourceFile, content, segments, {
        kind: "clean",
        label: "清稿",
        mode: "cleanscript",
        style: "",
        idLabel: "清稿",
        body: noteBody,
      });
      await this.host.versions.applyVersionToSource(sourceFile, version.meta, version.body, version.frontmatter);
      new obsidian.Notice("QnALog：清稿已生成并设为当前显示版本", 6000);
      const completedTaskMeter = taskMeter ? this.host.tasks.endTaskMeter(taskMeter) : null;
      taskMeter = null;
      try { this.host.tasks.logCompletedWork("生成清稿", sourceFile.path || "", completedTaskMeter); } catch { /* intentionally empty */ }
      this.host.tasks.completeTaskActivity(taskId, {
        stage: "done",
        stageLabel: "清稿已生成",
        detail: sourceFile.path,
        actions: [
          { id: "open-task-note", label: "打开母本", primary: true },
          { id: "dismiss-task", label: "关闭记录" },
        ],
      });
      try { await this.host.app.workspace.getLeaf(false).openFile(sourceFile); } catch { /* intentionally empty */ }
    } catch (e) {
      console.error("[QnALog] generate clean script failed", e);
      if (taskStarted) {
        this.host.tasks.failTaskActivity(taskId, e, {
          stage: "failed",
          stageLabel: "清稿未生成",
          detail: getTaskErrorMessage(e),
          actions: [
            { id: "open-task-note", label: "打开母本", primary: true },
            { id: "dismiss-task", label: "关闭记录" },
          ],
        });
      }
      new obsidian.Notice(`清稿生成失败：${(e && e.message) || e}`, 8000);
    } finally {
      if (taskMeter) this.host.tasks.endTaskMeter(taskMeter);
      this.host.tasks._busyLabel = null;
      this.host.tasks._busyContext = null;
      this.host.tasks.updateBusyStatus();
    }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
