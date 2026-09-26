/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：会中工作台：互动排队与执行、实时转写块写入

import * as obsidian from "obsidian";
import { callLlm } from "../llm/core";
import { formatElapsed } from "../shared/util-common";
import { diagnosticError } from "../shared/util-key-diag";
import { clipRealtimeContextText, hasRealtimeOutlineRunnableBacklog } from "../notes/realtime-outline";
import { MEETING_INTERACTION_MEMORY_MAX_CHARS, MEETING_INTERACTION_OUTLINE_MAX_CHARS, MEETING_INTERACTION_TIMEOUT_MS, MEETING_METADATA_KINDS, clipMeetingInteractionSegmentLine, getMeetingInteractionMaxTokens, normalizeMeetingWorkbench } from "../notes/meeting-workbench";
import { RecorderService } from "../audio/recorder-service";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { isAsrTransportError } from "../shared/util-audio";
import { NS_LIVE_MARKER_END, NS_LIVE_MARKER_START, nsMarker, nsMarkerLegacyVariants } from "../shared/namespace";
import type { RecordingSession } from "../shared/types";

/** MeetingWorkbenchService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface MeetingWorkbenchHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  diagnostics: DiagnosticsService;
  /** 实时大纲服务：协调器状态与进度（窄面：装配层绑定到 RealtimeOutlineService）。 */
  realtimeOutline: {
    getRealtimeOutlineCoordinatorState(): { phase: string; sessionId: string };
    ensureRealtimeOutlineProgress(session: RecordingSession | null, reason?: string): boolean;
  };
  recorder: RecorderService | null;
  /** 装配层转发：互动结果写回后请求刷新侧边栏（调用 ViewShellService.refreshOutlineView）。 */
  requestOutlineRefresh(): void;
}

/** 会中互动是否可运行的选项。force=true 时跳过「正在录音/转写」等前置判断，由调用方自行保证安全。 */
export interface MeetingWorkbenchRunOptions {
  force?: boolean;
}

export class MeetingWorkbenchService {
  declare host: MeetingWorkbenchHost;
  /** 互动排队定时器与运行标志：同一时刻只跑一个互动。 */
  declare _meetingWorkbenchInteractionTimer;
  declare _meetingWorkbenchInteractionRunning;

  constructor(host) {
    this.host = host;
    this._meetingWorkbenchInteractionTimer = null;
    this._meetingWorkbenchInteractionRunning = null;
  }

  updateMeetingWorkbenchEntry(session, entryId, updater) {
    if (!session || !entryId || typeof updater !== "function") return false;
    const current = normalizeMeetingWorkbench(session.meetingWorkbench);
    let changed = false;
    const entries = current.entries.map((item) => {
      if (item.id !== entryId) return item;
      changed = true;
      return Object.assign({}, item, updater(Object.assign({}, item)) || {});
    });
    if (!changed) return false;
    session.meetingWorkbench = normalizeMeetingWorkbench(Object.assign({}, current, { entries }));
    this.host.requestOutlineRefresh();
    return true;
  }

  buildMeetingWorkbenchInteractionContext(session, entry) {
    const atMs = Number(entry && entry.atMs) || 0;
    const before = [];
    const after = [];
    for (const s of (Array.isArray(session && session.segments) ? session.segments : [])) {
      if (!s || !s.text) continue;
      const start = Number(s.startOffsetMs) || 0;
      const end = Number(s.endOffsetMs ?? s.startOffsetMs) || start;
      const line = clipMeetingInteractionSegmentLine(`[${formatElapsed(start)}-${formatElapsed(end)}] ${String(s.text || "").trim()}`);
      if (end <= atMs) before.push(line);
      else if (start >= atMs) after.push(line);
    }
    return [
      session && session.realtimeOutline ? `【当前实时大纲】\n${clipRealtimeContextText(String(session.realtimeOutline).trim(), MEETING_INTERACTION_OUTLINE_MAX_CHARS)}` : "",
      session && session.realtimeOutlineMemory ? `【主题记忆】\n${clipRealtimeContextText(String(session.realtimeOutlineMemory).trim(), MEETING_INTERACTION_MEMORY_MAX_CHARS)}` : "",
      before.length ? `【该记录前的转写片段】\n${before.slice(-3).join("\n")}` : "",
      after.length ? `【该记录后的转写片段】\n${after.slice(0, 1).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
  }

  hasActiveRecordingOrTranscription(session) {
    if (session && Number(session.activeSegmentJobs || 0) > 0) return true;
    return false;
  }

  canRunMeetingWorkbenchInteraction(session, opts: MeetingWorkbenchRunOptions = {}) {
    if (!session) return false;
    if (opts.force) return true;
    if (this.hasActiveRecordingOrTranscription(session)) return false;
    const outlineState = this.host.realtimeOutline.getRealtimeOutlineCoordinatorState();
    if (
      outlineState.sessionId === session.id
      && (outlineState.phase === "running" || outlineState.phase === "scheduled")
      && hasRealtimeOutlineRunnableBacklog(session)
    ) return false;
    const rec = this.host.recorder;
    if (rec && rec.state === "recording") {
      const info = rec.getInfo ? rec.getInfo() : null;
      const nextCutAt = Number(rec.nextCutAtElapsed);
      if (Number.isFinite(nextCutAt)) {
        const timeToNextCut = nextCutAt - (Number(info && info.elapsed) || 0);
        if (timeToNextCut > 0 && timeToNextCut < 8000) return false;
      }
    }
    return true;
  }

  scheduleMeetingWorkbenchInteraction(session, entryId) {
    if (!session || !entryId) return;
    const queue = Array.isArray(session.pendingMeetingWorkbenchInteractions)
      ? session.pendingMeetingWorkbenchInteractions
      : [];
    if (!queue.includes(entryId)) queue.push(entryId);
    session.pendingMeetingWorkbenchInteractions = queue;
    if (!this.canRunMeetingWorkbenchInteraction(session)) {
      this.host.requestOutlineRefresh();
      if (this._meetingWorkbenchInteractionTimer) window.clearTimeout(this._meetingWorkbenchInteractionTimer);
      this._meetingWorkbenchInteractionTimer = window.setTimeout(() => {
        this._meetingWorkbenchInteractionTimer = 0;
        this.processPendingMeetingWorkbenchInteractions(session).catch(e => console.error("[QnALog] meeting workbench queue retry failed", e));
      }, 3000);
      return;
    }
    if (this._meetingWorkbenchInteractionTimer) window.clearTimeout(this._meetingWorkbenchInteractionTimer);
    this._meetingWorkbenchInteractionTimer = window.setTimeout(() => {
      this._meetingWorkbenchInteractionTimer = 0;
      this.processPendingMeetingWorkbenchInteractions(session).catch(e => console.error("[QnALog] meeting workbench queue failed", e));
    }, 1000);
  }

  async processPendingMeetingWorkbenchInteractions(session, opts: MeetingWorkbenchRunOptions = {}) {
    if (!session) return;
    if (!this.canRunMeetingWorkbenchInteraction(session, opts)) {
      if (!opts.force) this.scheduleMeetingWorkbenchInteraction(session, (session.pendingMeetingWorkbenchInteractions || [])[0]);
      return;
    }
    if (this._meetingWorkbenchInteractionRunning) return;
    this._meetingWorkbenchInteractionRunning = true;
    try {
      const workbench = normalizeMeetingWorkbench(session.meetingWorkbench);
      const queued = Array.isArray(session.pendingMeetingWorkbenchInteractions)
        ? session.pendingMeetingWorkbenchInteractions.slice()
        : [];
      const ids = queued.length
        ? queued
        : workbench.entries
            .filter(entry => entry.interaction && entry.interaction.kind && (!entry.interaction.status || entry.interaction.status === "pending" || entry.interaction.status === "error"))
            .map(entry => entry.id);
      session.pendingMeetingWorkbenchInteractions = [];
      for (const entryId of ids) {
        if (!opts.force && !this.canRunMeetingWorkbenchInteraction(session)) {
          const rest = ids.slice(ids.indexOf(entryId));
          session.pendingMeetingWorkbenchInteractions = Array.from(new Set([...(session.pendingMeetingWorkbenchInteractions || []), ...rest]));
          this.scheduleMeetingWorkbenchInteraction(session, entryId);
          break;
        }
        await this.processMeetingWorkbenchInteraction(session, entryId);
      }
    } finally {
      this._meetingWorkbenchInteractionRunning = false;
      // User annotations and instant answers have their own state. Whether they
      // succeed or fail, they cannot own or strand the outline cursor.
      this.host.realtimeOutline.ensureRealtimeOutlineProgress(session, "workbench-finished");
    }
  }

  async processMeetingWorkbenchInteraction(session, entryId) {
    if (!session || !entryId) return;
    const workbench = normalizeMeetingWorkbench(session.meetingWorkbench);
    const entry = workbench.entries.find(item => item.id === entryId);
    if (!entry || !entry.interaction || !entry.interaction.kind) return;
    // 元数据 kinds（assignee / todo）不走 AI 助理
    if (MEETING_METADATA_KINDS.has(entry.interaction.kind)) return;
    if (entry.interaction.status === "running" || entry.interaction.status === "done") return;
    this.updateMeetingWorkbenchEntry(session, entryId, (item) => ({
      interaction: Object.assign({}, item.interaction, { status: "running", error: "", updatedAt: new Date().toISOString() }),
    }));
    try {
      const latest = normalizeMeetingWorkbench(session.meetingWorkbench).entries.find(item => item.id === entryId) || entry;
      const context = this.buildMeetingWorkbenchInteractionContext(session, latest);
      const kind = latest.interaction.kind;
      const label = kind === "concept" ? "概念解释" : (kind === "question" ? "问题回答" : "重点处理");
      const system = "你是 Q&A Log 的会中即时助理。只回答用户这条会中记录，不改写实时大纲，不生成完整纪要。回答要短、具体、可直接挂在这条记录下面。";
      const user = [
        `会中记录时间：${formatElapsed(latest.atMs || 0)}`,
        `触发类型：${label}`,
        `用户原文：${latest.text || latest.interaction.query}`,
        "",
        context || "当前还没有足够转写上下文，请主要根据用户问题本身作答。",
        "",
        "回答规则：",
        "- #概念：给出定义、怎么使用、上下位概念、在当前语境里的意义；最多 5 条短句。",
        "- ?问题：直接回答问题，并结合当前大纲/转写上下文；最多 5 条短句。",
        "- !重点：说明这条重点为什么要保留、最终纪要应如何处理；最多 4 条短句。",
        "- 不要写“未提及”“待确认”这类空字段；信息不足时直接说“现有上下文不足以判断”。",
        "- 不要声称做了声纹识别，不要编造人物责任。",
      ].join("\n");
      const raw = await callLlm(this.host, system, user, {
        timeoutMs: MEETING_INTERACTION_TIMEOUT_MS,
        payload: { max_tokens: getMeetingInteractionMaxTokens(kind) },
        priority: "user",
        noRetry: true,
      });
      const response = String(raw || "").trim();
      this.updateMeetingWorkbenchEntry(session, entryId, (item) => ({
        interaction: Object.assign({}, item.interaction, {
          status: "done",
          response: response || "现有上下文不足以判断。",
          error: "",
          updatedAt: new Date().toISOString(),
        }),
      }));
    } catch (e) {
      console.error("[QnALog] meeting workbench interaction failed", e);
      this.updateMeetingWorkbenchEntry(session, entryId, (item) => ({
        interaction: Object.assign({}, item.interaction, {
          status: "error",
          error: (e && e.message) || String(e),
          updatedAt: new Date().toISOString(),
        }),
      }));
      await this.host.diagnostics.logDiagnostic("warn", "meeting_workbench.interaction_failed", "会中记录 AI 互动失败", {
        entryId,
        mode: session.mode,
        error: diagnosticError(e),
      });
    }
  }
  makeStreamingNoteUpdater(session) {
    let scheduled = false;
    let lastWritten = "";
    const flush = async () => {
      scheduled = false;
      if (!session || session.finalized) return;
      const text = session.streamingFullText || "";
      if (text === lastWritten) return;
      lastWritten = text;
      try {
        await this.upsertLiveTranscriptBlock(session.mdPath, session.id, text);
      } catch (e) { console.error("[QnALog] live update failed", e); }
    };
    return () => {
      if (scheduled) return;
      scheduled = true;
      window.setTimeout(() => { void flush(); }, 1500);
    };
  }

  async upsertLiveTranscriptBlock(mdPath, sessionId, text) {
    const file = this.host.app.vault.getAbstractFileByPath(mdPath);
    if (!(file instanceof obsidian.TFile)) return;
    const startMarker = nsMarker(NS_LIVE_MARKER_START, sessionId);
    const endMarker = nsMarker(NS_LIVE_MARKER_END, sessionId);
    const safe = (text || "").trim().split("\n").map(l => "> " + l).join("\n");
    const body = safe || "> _（等待说话…）_";
    const block = `${startMarker}\n> [!quote]+ 实时转写中…\n${body}\n${endMarker}`;
    const cur = await this.host.app.vault.read(file);
    const startIdx = cur.indexOf(startMarker);
    const endIdx = cur.indexOf(endMarker);
    if (startIdx >= 0 && endIdx > startIdx) {
      const next = cur.slice(0, startIdx) + block + cur.slice(endIdx + endMarker.length);
      if (next !== cur) await this.host.app.vault.modify(file, next);
      return;
    }
    const segEnd = nsMarker("segments-end", sessionId);
    const segIdx = cur.indexOf(segEnd);
    if (segIdx >= 0) {
      const next = cur.slice(0, segIdx) + block + "\n" + cur.slice(segIdx);
      await this.host.app.vault.modify(file, next);
    }
  }

  async removeLiveTranscriptBlock(mdPath, sessionId) {
    const file = this.host.app.vault.getAbstractFileByPath(mdPath);
    if (!(file instanceof obsidian.TFile)) return;
    const startMarker = nsMarker(NS_LIVE_MARKER_START, sessionId);
    const endMarker = nsMarker(NS_LIVE_MARKER_END, sessionId);
    const cur = await this.host.app.vault.read(file);
    // 1.0.0 写的是 `lv-live-*`。两种都找，否则升级前中断的录音会在笔记里
    // 留下一个再也不会被清理的"实时转写中…"引用块。
    const findMarker = (primary, legacyName) => {
      const at = cur.indexOf(primary);
      if (at >= 0) return at;
      for (const candidate of nsMarkerLegacyVariants(legacyName, sessionId)) {
        const legacyAt = cur.indexOf(candidate);
        if (legacyAt >= 0) return legacyAt;
      }
      return -1;
    };
    const startIdx = findMarker(startMarker, NS_LIVE_MARKER_START);
    const endIdx = findMarker(endMarker, NS_LIVE_MARKER_END);
    if (startIdx < 0 || endIdx < 0) return;
    const next = cur.slice(0, startIdx).replace(/\n+$/, "") + cur.slice(endIdx + endMarker.length).replace(/^\n+/, "\n");
    await this.host.app.vault.modify(file, next);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
