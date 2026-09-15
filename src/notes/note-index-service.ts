/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：笔记索引与当日概要：索引刷新、当日日记概要与沉淀自动提取

import * as obsidian from "obsidian";
import { getSemanticCanvasPath } from "../canvas/semantic-outline-canvas";
import { buildNoteIndex, resolveNoteIndex, upsertNoteIndex } from "../indexing/note-index";
import { ensureTodayDailyNoteFile } from "../shared/util-note";
import { generateSedimentObjects, writeSedimentObjectCards } from "../sediment";
import type { PluginSettings } from "../shared/types";
import { diagnosticError } from "../shared/util-key-diag";
import { extractSessionId } from "../notes/note-markdown";
import { buildDailyMeetingOverviewEntry, upsertDailyMeetingOverview } from "../notes/daily-overview";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";

/** NoteIndexService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface NoteIndexHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  diagnostics: DiagnosticsService;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
}

/** 刷新纪要索引时可选的补充信息；调用方在少数场景才提供，两者都缺省为空串。 */
export interface RefreshNoteIndexOptions {
  /** 纪要的会议日期，写入索引块。 */
  meetingDate?: string;
  /** 触发原因，仅用于诊断日志。 */
  reason?: string;
}

export class NoteIndexService {
  declare host: NoteIndexHost;
  constructor(host) {
    this.host = host;
  }


  async refreshNoteIndex(fileOrPath, options: RefreshNoteIndexOptions = {}) {
    const file = typeof fileOrPath === "string"
      ? this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(fileOrPath))
      : fileOrPath;
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") return null;
    const current = await this.host.app.vault.read(file);
    const index = buildNoteIndex(current, {
      noteTitle: file.basename,
      meetingDate: options.meetingDate || "",
    });
    if (!index) return null;
    const next = upsertNoteIndex(current, index);
    if (next !== current) await this.host.app.vault.modify(file, next);
    const expectedCanvasPath = obsidian.normalizePath(getSemanticCanvasPath(file.path));
    const canvasFile = this.host.app.vault.getAbstractFileByPath(expectedCanvasPath);
    return resolveNoteIndex(
      index,
      file.path,
      canvasFile instanceof obsidian.TFile ? canvasFile.path : null,
    );
  }

  async refreshNoteIndexSafely(fileOrPath, options: RefreshNoteIndexOptions = {}) {
    try {
      return await this.refreshNoteIndex(fileOrPath, options);
    } catch (error) {
      const filePath = typeof fileOrPath === "string" ? fileOrPath : (fileOrPath && fileOrPath.path) || "";
      console.warn("[QnALog] note index refresh failed", error);
      try {
        await this.host.diagnostics.logDiagnostic("warn", "note.index_refresh_failed", "纪要索引更新失败，正文不受影响", {
          filePath,
          reason: options.reason || "",
          error: diagnosticError(error),
        });
      } catch { /* index diagnostics must never affect note delivery */ }
      return null;
    }
  }

  async appendDailyMeetingOverview(session, polished) {
    if (!this.host.settings.writeDailyMeetingOverview) return;
    if (!session || !polished) return;
    let dailyFile = null;
    try {
      dailyFile = await ensureTodayDailyNoteFile(this.host.app);
    } catch (e) {
      console.error("[QnALog] daily note ensure failed", e);
    }
    if (!(dailyFile instanceof obsidian.TFile)) return;
    if (obsidian.normalizePath(dailyFile.path) === obsidian.normalizePath(session.mdPath)) return;
    const entry = buildDailyMeetingOverviewEntry(session, polished, this.host.settings);
    const cur = await this.host.app.vault.read(dailyFile);
    const next = upsertDailyMeetingOverview(cur, session.id, entry, this.host.settings);
    if (next !== cur) await this.host.app.vault.modify(dailyFile, next);
  }

  async appendDailyMeetingOverviewForMarkdown(file, markdown, polished, mode, segments, sessionMeta) {
    if (!(file instanceof obsidian.TFile)) return;
    const startedAt = sessionMeta && sessionMeta.startedAt
      ? sessionMeta.startedAt
      : new Date(file.stat && file.stat.ctime ? file.stat.ctime : Date.now()).toISOString();
    const session = {
      id: extractSessionId(markdown, obsidian.normalizePath(file.path).replace(/[^A-Za-z0-9_-]+/g, "-")),
      mdPath: file.path,
      mode,
      startedAt,
      segments: Array.isArray(segments) ? segments : [],
    };
    await this.appendDailyMeetingOverview(session, polished);
  }
  // 转写完成后的自动沉淀（仅 settings.sedimentAutoExtract 开启时触发）：扫描纪要 → 待办自动入库。
  // 后台跑、try/catch 静默——绝不影响主流程；沉淀扫描已走续写拼接（callLlmWithContinuation），不会被输出上限截断。
  async autoExtractSedimentAfterFinalize(mdPath) {
    try {
      const file = this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(mdPath || ""));
      if (!(file instanceof obsidian.TFile)) return;
      const markdown = await this.host.app.vault.cachedRead(file);
      const objects = await generateSedimentObjects(this.host, file, markdown);
      await writeSedimentObjectCards(this.host, file, { todos: objects.todos || [] });
    } catch (e) { console.error("[QnALog] autoExtractSedimentAfterFinalize", e); }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
