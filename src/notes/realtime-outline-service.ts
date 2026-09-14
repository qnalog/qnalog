/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：实时大纲：调度与执行、增量生成、收尾补全

import * as obsidian from "obsidian";
import { advanceRealtimeOutlineCursor, parseRealtimeOutlineStateFromMarkdown, selectIncrementalRealtimeOutlineSegments, repairRealtimeOutlineAnchors, mergeStableRealtimeOutlineNodes, normalizeOutlineMarkdownForDisplay, validateRealtimeOutlineMarkdown } from "../outline-text";
import { drainRealtimeOutlineBacklog } from "../outline-finalizer";
import { getModeMeta } from "../shared/mode-meta";
import { buildBriefingLanguageInstruction, getSegmentsDurationMs } from "../shared/util-text";
import { callLlm } from "../llm/core";
import type { LexVoiceSettings, RecordingSession } from "../shared/types";
import { primitiveText, getErrorMessage } from "../shared/util-common";
import { isLocalLlmEndpoint } from "../shared/util-llm-endpoint";
import { diagnosticError } from "../shared/util-key-diag";
import { RealtimeOutlineCoordinator, runInOutlineSessionTail } from "../outline-coordinator";
import { classifyRecordingIssue } from "../notes/recording-issues";
import { REALTIME_OUTLINE_FINAL_BATCH_MAX_ATTEMPTS, REALTIME_OUTLINE_FINAL_MAX_BATCHES, REALTIME_OUTLINE_FINAL_MAX_TOKENS, REALTIME_OUTLINE_FINAL_TIMEOUT_MS, REALTIME_OUTLINE_LOOKBACK_SEGMENTS, REALTIME_OUTLINE_MANUAL_TIMEOUT_MS, REALTIME_OUTLINE_MAX_MEMORY_CHARS, REALTIME_OUTLINE_MAX_NO_CHANGE_REJECTIONS, REALTIME_OUTLINE_MAX_PREVIOUS_CHARS, REALTIME_OUTLINE_MAX_SEGMENTS, REALTIME_OUTLINE_MAX_TRANSCRIPT_CHARS, REALTIME_OUTLINE_MIN_NEW_SEGMENTS, REALTIME_OUTLINE_MIN_SEMANTIC_DELTA_CHARS, REALTIME_OUTLINE_SILENT_MAX_TOKENS, REALTIME_OUTLINE_SILENT_TIMEOUT_MS, buildOutlinePrompt, buildRealtimeOutlineAnchorSources, buildRealtimeOutlineTranscript, buildRollingOutlineContext, clipRealtimeContextText, getRealtimeOutlineNewSegmentCount, getRealtimeOutlineQueuedDelayMs, getRealtimeOutlineTimeoutMs, hasRealtimeOutlineRunnableBacklog, isRealtimeOutlineBackoffActive, isRealtimeOutlineCurrent, isRealtimeOutlineSilentIntervalActive, markRealtimeOutlineFailure, markRealtimeOutlineSuccess, normalizeRealtimeOutlineState, parseRealtimeOutlineResponse, renderRealtimeOutlineStateMarkdown, shouldRunRealtimeOutline, updateRealtimeOutlineCoverage } from "../notes/realtime-outline";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";

/** 实时大纲的调度与生成参数；四个入口共用同一套可选项。 */
export interface RealtimeOutlineRequestOptions {
  /** 请求的防抖延迟（毫秒）；缺省按设置的 realtimeOutlineDebounceMs。 */
  delayMs?: number;
  /** 调度原因，写入诊断与协调器状态。 */
  reason?: string;
  /** 静默轮：不阻塞用户侧操作，失败也不提示。 */
  silent?: boolean;
  /** 强制生成，跳过「内容未变/退避中」等前置判断。 */
  force?: boolean;
  /** 收尾轮：用更大的输出上限，且失败不自动重试。 */
  final?: boolean;
  /** 本地模型端点：静默间隔与优先级按本地口径调整。 */
  local?: boolean;
  /** 交回协调器的超时（毫秒）。 */
  timeoutMs?: number;
  /** 输出 token 上限。 */
  maxTokens?: number;
  /** 取消信号；已中止时直接抛 AbortError。 */
  signal?: AbortSignal;
  /** 上一次因输出结构不合格被拒后的格式修复重试。 */
  formatRetry?: boolean;
}

/** RealtimeOutlineService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface RealtimeOutlineHost {
  diagnostics: DiagnosticsService;
  /** 实时大纲的调度器：防抖、串行、退避。 */
  outlineCoordinator: RealtimeOutlineCoordinator | null;
  /** 视图外壳服务：大纲更新后刷新侧边栏。 */
  shell: { refreshOutlineView(): void };
  session: RecordingSession | null;
  /** 录音采集服务：把大纲进度写进会话。 */
  recording: { setSessionWorkProgress(session: RecordingSession, patch: unknown): void; setRecordingIssue(kind: string, patch?: unknown): void; clearRecordingIssue(kind: string): void };
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: LexVoiceSettings;
}

export class RealtimeOutlineService {
  declare host: RealtimeOutlineHost;
  constructor(host) {
    this.host = host;
  }

  scheduleRealtimeOutline(opts: RealtimeOutlineRequestOptions = {}) {
    const session = this.host.session;
    if (!session || !session.id) return;
    const requestedDelay = Number(opts && opts.delayMs);
    const delay = Number.isFinite(requestedDelay) && requestedDelay >= 0
      ? Math.max(250, Math.round(requestedDelay))
      : Math.max(2500, this.host.settings.realtimeOutlineDebounceMs || 1500);
    this.host.outlineCoordinator.schedule({
      sessionId: session.id,
      silent: true,
      reason: (opts && opts.reason) || "segment",
      delayMs: delay,
      local: isLocalLlmEndpoint(this.host.settings.llmEndpoint),
    });
  }

  ensureRealtimeOutlineProgress(session = this.host.session, reason = "progress-check") {
    if (!session || session !== this.host.session || !session.id) return false;
    if (!this.host.settings.enableRealtimeOutline) return false;
    if (!hasRealtimeOutlineRunnableBacklog(session)) return false;
    const local = isLocalLlmEndpoint(this.host.settings.llmEndpoint);
    this.scheduleRealtimeOutline({
      delayMs: getRealtimeOutlineQueuedDelayMs(session, { local }),
      reason,
    });
    return true;
  }

  async refreshRealtimeOutlineInBackground(opts: RealtimeOutlineRequestOptions = {}) {
    const session = this.host.session;
    if (!session || !session.id || !session.segments || !session.segments.length) return "";
    const local = isLocalLlmEndpoint(this.host.settings.llmEndpoint);
    return await this.host.outlineCoordinator.request({
      sessionId: session.id,
      silent: !!opts.silent,
      force: !!opts.force,
      final: !!opts.final,
      reason: opts.reason || (opts.force ? "manual-refresh" : "background"),
      timeoutMs: opts.timeoutMs,
      maxTokens: opts.maxTokens,
      local,
    });
  }

  getRealtimeOutlineCoordinatorState() {
    return this.host.outlineCoordinator
      ? this.host.outlineCoordinator.getState()
      : { phase: "idle", sessionId: "", runId: 0, queued: 0, reason: "", startedAt: 0, nextRunAt: 0, lastError: "" };
  }

  isRealtimeOutlineRunning(session = this.host.session) {
    const state = this.getRealtimeOutlineCoordinatorState();
    return !!(session && state.phase === "running" && state.sessionId === session.id);
  }

  cancelRealtimeOutline(sessionId) {
    if (this.host.outlineCoordinator) this.host.outlineCoordinator.cancel(sessionId);
  }

  evaluateRealtimeOutlineRequest(request) {
    const session = this.host.session;
    if (!session || session.id !== request.sessionId) {
      return { ready: false, retry: false, reason: "stale-session" };
    }
    if (!this.host.settings.enableRealtimeOutline) {
      return { ready: false, retry: false, reason: "disabled" };
    }
    const local = !!request.local || isLocalLlmEndpoint(this.host.settings.llmEndpoint);
    if (shouldRunRealtimeOutline(session, {
      silent: !!request.silent,
      force: !!request.force,
      final: !!request.final,
      local,
    })) {
      return { ready: true };
    }
    if (!request.silent || !hasRealtimeOutlineRunnableBacklog(session)) {
      return { ready: false, retry: false, reason: "no-runnable-backlog" };
    }
    let reason = "waiting";
    if (Number(session.activeSegmentJobs || 0) > 0) reason = "asr-busy";
    else if (isRealtimeOutlineBackoffActive(session)) reason = "failure-backoff";
    else if (isRealtimeOutlineSilentIntervalActive(session, { local })) reason = "minimum-interval";
    return {
      ready: false,
      retry: true,
      delayMs: getRealtimeOutlineQueuedDelayMs(session, { local }),
      reason,
    };
  }

  getRealtimeOutlineRetryDecision(request) {
    const session = this.host.session;
    if (!request.silent || !session || session.id !== request.sessionId) {
      return { retry: false, reason: "failed" };
    }
    if (!hasRealtimeOutlineRunnableBacklog(session)) {
      return { retry: false, reason: "no-runnable-backlog" };
    }
    const local = !!request.local || isLocalLlmEndpoint(this.host.settings.llmEndpoint);
    return {
      retry: true,
      delayMs: getRealtimeOutlineQueuedDelayMs(session, { local }),
      reason: "failure-backoff",
    };
  }

  async executeRealtimeOutlineRequest(request) {
    const session = this.host.session;
    if (!session || session.id !== request.sessionId) return "";
    const local = !!request.local || isLocalLlmEndpoint(this.host.settings.llmEndpoint);
    const explicitTimeout = Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : 0;
    const baseTimeout = request.silent ? REALTIME_OUTLINE_SILENT_TIMEOUT_MS : REALTIME_OUTLINE_MANUAL_TIMEOUT_MS;
    const effectiveTimeout = explicitTimeout || baseTimeout;
    try {
      const result = await this.generateRealtimeOutlineForSession(session, {
        timeoutMs: local ? effectiveTimeout * 2 : effectiveTimeout,
        silent: !!request.silent,
        force: !!request.force,
        final: !!request.final,
        maxTokens: request.maxTokens || REALTIME_OUTLINE_SILENT_MAX_TOKENS,
        local,
        signal: request.signal,
      });
      markRealtimeOutlineSuccess(session);
      this.host.recording.clearRecordingIssue("network");
      this.host.recording.clearRecordingIssue("service");
      await this.host.diagnostics.logDiagnostic("info", "outline.generate_succeeded", "实时大纲生成完成", {
        silent: !!request.silent,
        force: !!request.force,
        reason: request.reason || "",
        segmentCount: session.segments.length,
        committedSegmentCount: session.realtimeOutlineSegmentCount || 0,
        remainingSegmentCount: getRealtimeOutlineNewSegmentCount(session),
        outputChars: String(session.realtimeOutline || "").length,
        window: session.realtimeOutlineWindow || null,
        mode: session.mode,
      });
      this.host.shell.refreshOutlineView();
      if (request.silent && hasRealtimeOutlineRunnableBacklog(session)) {
        this.scheduleRealtimeOutline({
          delayMs: getRealtimeOutlineQueuedDelayMs(session, { local }),
          reason: "backlog",
        });
      }
      return result;
    } catch (e) {
      if (request.signal && request.signal.aborted) throw e;
      console.error("[QnALog] realtime outline failed", e);
      markRealtimeOutlineFailure(session);
      const retryInMs = request.silent && hasRealtimeOutlineRunnableBacklog(session)
        ? getRealtimeOutlineQueuedDelayMs(session, { local })
        : 0;
      await this.host.diagnostics.logDiagnostic("error", "outline.generate_failed", "实时大纲生成失败", {
        silent: !!request.silent,
        force: !!request.force,
        reason: request.reason || "",
        local,
        errorCount: session.realtimeOutlineFailureCount || 0,
        segmentCount: session.segments.length,
        lastOutlineSegmentCount: session.realtimeOutlineSegmentCount || 0,
        memoryChars: String(session.realtimeOutlineMemory || "").length,
        window: session.realtimeOutlineWindow || null,
        mode: session.mode,
        captureMode: session.captureMode,
        retryInMs,
        error: diagnosticError(e),
      });
      if (!request.silent) {
        this.host.recording.setRecordingIssue(classifyRecordingIssue(e), {
          source: "outline",
          message: getErrorMessage(e),
          startedAtMs: getSegmentsDurationMs(session.segments),
        });
        new obsidian.Notice(`大纲生成失败：${(e && e.message) || e}`);
      } else if (Number(session.realtimeOutlineFailureCount || 0) === 1) {
        new obsidian.Notice("实时大纲暂时未更新，转写仍在继续，稍后会自动重试。", 7000);
      }
      throw e;
    }
  }

  async generateRealtimeOutlineForSession(session, opts: RealtimeOutlineRequestOptions = {}) {
    if (!session) return "";
    // Strict per-session promise tail. Never bypass or reset this tail: allowing a second
    // read-modify-write after an arbitrary lock timeout can overwrite a newer outline.
    return await runInOutlineSessionTail(session, async () => {
        if (opts.signal && opts.signal.aborted) {
          const error = new Error("实时大纲生成已取消");
          error.name = "AbortError";
          throw error;
        }
        return await this._genOutlineInner(session, opts);
      });
  }

  async _genOutlineInner(session, opts: RealtimeOutlineRequestOptions = {}) {
    if (!session || !session.segments || !session.segments.length) return "";
    const processedSegmentCount = session.segments.length;
    const committedSegmentCount = Math.min(
      processedSegmentCount,
      Math.max(0, Number(session.realtimeOutlineSegmentCount) || 0)
    );
    // 只处理最早一批尚未提交的转写，并带一段只读回看保持语义连续。
    // 关键不是“从尾部截最近 N 段”，而是按顺序消费 backlog；否则窗口封顶时会直接跳过中间内容。
    const windowed = selectIncrementalRealtimeOutlineSegments(session.segments, {
      sinceCount: committedSegmentCount,
      lookbackSegments: committedSegmentCount > 0 ? REALTIME_OUTLINE_LOOKBACK_SEGMENTS : 0,
      maxSegments: REALTIME_OUTLINE_MAX_SEGMENTS,
      maxChars: REALTIME_OUTLINE_MAX_TRANSCRIPT_CHARS,
    });
    const attemptedSegmentCount = windowed.commitThroughCount;
    session.realtimeOutlineAttemptedSegmentCount = attemptedSegmentCount;
    session.realtimeOutlineAttemptedAt = new Date().toISOString();
    updateRealtimeOutlineCoverage(session, "processing", {
      attemptedSegmentCount,
      rejectedReason: "",
    });
    const workbenchSignature = "";
    const transcript = buildRealtimeOutlineTranscript(windowed.segments);
    if (windowed.newUsedCount === 0 || !transcript.trim()) {
      // 没有未提交正文时绝不调用 LLM。回看段只负责给真正的新段落补上下文，不能单独触发重复计费。
      // 失败/静音段不改变大纲，但可以安全确认，避免同一批空段反复触发。
      session.realtimeOutlineSegmentCount = advanceRealtimeOutlineCursor(
        committedSegmentCount,
        attemptedSegmentCount,
        processedSegmentCount
      );
      session.realtimeOutlineWindow = {
        usedCount: windowed.usedCount,
        newUsedCount: 0,
        omittedBeforeCount: windowed.omittedBeforeCount || 0,
        totalTextCount: windowed.totalTextCount || 0,
        approxChars: windowed.approxChars || 0,
        memoryChars: String(session.realtimeOutlineMemory || "").length,
        committedSegmentCount: attemptedSegmentCount,
        attemptedSegmentCount,
        totalSegmentCount: processedSegmentCount,
        workbenchChars: 0,
        acknowledgedWithoutLlm: true,
      };
      updateRealtimeOutlineCoverage(session, "processing", {
        attemptedSegmentCount,
        acknowledgedWithoutLlm: true,
      });
      return session.realtimeOutline || "";
    }
    const meta = getModeMeta(this.host.settings, session.mode);
    const sys = "你是结构化思考助手。任务不是复述，而是把零散的发言归并到共同的上一级概念之下。层级深度由材料决定，不预设。克制——不堆砌符号、不强加分析维度、不过度抽象。";
    const local = !!opts.local || isLocalLlmEndpoint(this.host.settings && this.host.settings.llmEndpoint);
    // 每轮只把“旧大纲 + 最早未提交转写批次”交给模型，输出仍走冻结合并。
    // 这保留了富子要点，同时不再重复付费处理整段近期窗口。
    const rollingContext = buildRollingOutlineContext(
      session.realtimeOutlineMemory,
      session.realtimeOutline,
      windowed,
      { programOwnedMemory: false }
    );
    // 前缀缓存优化：语种指令前置进稳定块（不再追加到转写之后），转写严格放最后。
    const langInstruction = buildBriefingLanguageInstruction(this.host.settings);
    let user = buildOutlinePrompt(
      meta.prefix,
      session.mode,
      rollingContext + transcript,
      session.captureMode,
      langInstruction,
      { incremental: windowed.isIncremental }
    );
    if (opts.formatRetry) {
      user += [
            "",
            "【格式修复重试】",
            "上一次同一批内容因输出结构不合格被程序拒绝。请重新整理本批内容；不要解释原因。",
            "必须保留 <lexvoice-memory> 与 <lexvoice-outline> 两个完整标签。",
            "<lexvoice-outline> 内每个一级条目必须以 `- ` 开头，每个子要点必须以两个空格加 `- ` 开头。",
          ].join("\n");
    }
    const inputMetrics = {
      fullTranscript: false,
      systemChars: sys.length,
      userChars: user.length,
      totalChars: sys.length + user.length,
      rollingContextChars: rollingContext.length,
      transcriptChars: transcript.length,
      previousOutlineChars: clipRealtimeContextText(session.realtimeOutline, REALTIME_OUTLINE_MAX_PREVIOUS_CHARS).length,
      memoryChars: clipRealtimeContextText(session.realtimeOutlineMemory, REALTIME_OUTLINE_MAX_MEMORY_CHARS).length,
      maxTranscriptChars: REALTIME_OUTLINE_MAX_TRANSCRIPT_CHARS,
    };
    session.realtimeOutlineInput = inputMetrics;
    session.realtimeOutlineWindow = {
      usedCount: windowed.usedCount,
      newUsedCount: windowed.newUsedCount,
      omittedBeforeCount: windowed.omittedBeforeCount,
      totalTextCount: windowed.totalTextCount,
      approxChars: windowed.approxChars,
      committedSegmentCount,
      attemptedSegmentCount,
      totalSegmentCount: processedSegmentCount,
      input: inputMetrics,
      preflight: true,
    };
    // 本地档：未传 timeoutMs 时由 getRealtimeOutlineTimeoutMs 内部 ×2；
    // opts.local 由上层调用方根据 isLocalLlmEndpoint(settings.llmEndpoint) 透传进来
    const timeoutMs = Number(opts.timeoutMs) > 0
      ? Math.round(Number(opts.timeoutMs))
      : getRealtimeOutlineTimeoutMs(windowed, { local });
    const maxTokens = Math.max(600, Math.round(Number(opts.maxTokens) || (opts.final ? REALTIME_OUTLINE_FINAL_MAX_TOKENS : REALTIME_OUTLINE_SILENT_MAX_TOKENS)));
    const raw = await callLlm(this.host, sys, user, {
      timeoutMs,
      payload: { max_tokens: maxTokens },
      priority: opts.final ? "normal" : "background",
      noRetry: !opts.final,
      signal: opts.signal,
      // 实时大纲是"快速结构化抽取"，强制关思维链（无视全局思考档）：更快、更省，且避免推理内容/前言污染输出踩软失败。
      thinkingMode: "fast",
    });
    if (opts.signal && opts.signal.aborted) {
      const error = new Error("实时大纲生成已取消");
      error.name = "AbortError";
      throw error;
    }
    const parsed = parseRealtimeOutlineResponse(raw, session.realtimeOutline, session.realtimeOutlineMemory);
    let repaired = repairRealtimeOutlineAnchors(parsed.outline, {
      previousOutline: session.realtimeOutline,
      anchorSources: buildRealtimeOutlineAnchorSources(windowed.newSegments),
    });
    // 时间是程序拥有的近似导航元数据，不是 LLM 输出协议。若某轮没有可用音频锚点，
    // 仍保留无时间的顶层结构，不能因时间缺失把话题降级或整轮判废。
    let result = normalizeOutlineMarkdownForDisplay(repaired.outline, { preserveUntimedTopLevel: true });
    let validation;
    if (parsed.outlineWasFallback && windowed.newUsedCount > 0) {
      validation = { ok: false, reason: "fallback_outline_only" };
    } else if (!result.trim() && windowed.newUsedCount > 0) {
      validation = { ok: false, reason: "empty_generated_outline" };
    } else {
      validation = validateRealtimeOutlineMarkdown(result, {
        previousOutline: session.realtimeOutline,
        allowUntimedTopLevel: true,
        deltaOnly: windowed.isIncremental,
        maxNewTopLevel: windowed.isIncremental ? 6 : 8,
      });
    }
    const existingOutlineState = normalizeRealtimeOutlineState(
      session.realtimeOutlineState,
      session.realtimeOutline,
      session.realtimeOutlineMemory
    );
    let freshOutlineNodes = parseRealtimeOutlineStateFromMarkdown(result);
    let mergedOutlineNodes = mergeStableRealtimeOutlineNodes(existingOutlineState.nodes, freshOutlineNodes);
    const existingRenderedOutline = normalizeOutlineMarkdownForDisplay(
      renderRealtimeOutlineStateMarkdown(existingOutlineState)
    );
    let mergedRenderedOutline = normalizeOutlineMarkdownForDisplay(
      renderRealtimeOutlineStateMarkdown({ version: 1, nodes: mergedOutlineNodes })
    );
    const newTranscriptChars = (Array.isArray(windowed.newSegments) ? windowed.newSegments : [])
      .reduce((sum, segment) => sum + primitiveText(segment && segment.text).trim().length, 0);
    let semanticChanged = existingRenderedOutline !== mergedRenderedOutline;
    const requiresSemanticDelta = !opts.final
      && !opts.force
      && !!windowed.isIncremental
      && windowed.newUsedCount >= REALTIME_OUTLINE_MIN_NEW_SEGMENTS
      && newTranscriptChars >= REALTIME_OUTLINE_MIN_SEMANTIC_DELTA_CHARS;
    let noChangeRetryCount = 0;
    let noChangeAcknowledged = false;
    if (validation.ok && requiresSemanticDelta && !semanticChanged) {
      const sameCommittedCursor = Number(session.realtimeOutlineNoChangeCommittedCount) === committedSegmentCount;
      noChangeRetryCount = sameCommittedCursor
        ? Math.max(0, Number(session.realtimeOutlineNoChangeRetryCount) || 0) + 1
        : 1;
      session.realtimeOutlineNoChangeCommittedCount = committedSegmentCount;
      session.realtimeOutlineNoChangeRetryCount = noChangeRetryCount;
      if (noChangeRetryCount <= REALTIME_OUTLINE_MAX_NO_CHANGE_REJECTIONS) {
        validation = { ok: false, reason: "no_incremental_outline_change" };
      } else {
        // One strict retry is enough. A genuinely repetitive discussion can
        // produce no new structure; after that retry, acknowledge the batch so
        // the ordered backlog cannot be blocked forever by this guard.
        noChangeAcknowledged = true;
      }
    } else if (semanticChanged) {
      session.realtimeOutlineNoChangeCommittedCount = -1;
      session.realtimeOutlineNoChangeRetryCount = 0;
    }
    if (!validation.ok) {
      session.realtimeOutlineWindow = {
        usedCount: windowed.usedCount,
        newUsedCount: windowed.newUsedCount,
        omittedBeforeCount: windowed.omittedBeforeCount,
        totalTextCount: windowed.totalTextCount,
        approxChars: windowed.approxChars,
        memoryChars: String(session.realtimeOutlineMemory || "").length,
        committedSegmentCount,
        attemptedSegmentCount,
        totalSegmentCount: processedSegmentCount,
        workbenchChars: workbenchSignature.length,
        rejectedReason: validation.reason,
        repairedAnchorCount: repaired.repairedCount,
        replacedModelAnchorCount: repaired.replacedCount,
        unresolvedAnchorCount: repaired.unresolvedCount,
        freshNodeCount: freshOutlineNodes.length,
        mergedNodeCount: mergedOutlineNodes.length,
        newTranscriptChars,
        semanticChanged,
        noChangeRetryCount,
        input: inputMetrics,
      };
      try {
        await this.host.diagnostics.logDiagnostic("warn", "outline.soft_rejected", "实时大纲本轮判废", {
          reason: validation.reason,
          force: !!opts.force,
          mode: session.mode,
          segmentCount: session.segments.length,
          committedSegmentCount,
          attemptedSegmentCount,
          newUsedCount: windowed.newUsedCount,
          repairedAnchorCount: repaired.repairedCount,
          replacedModelAnchorCount: repaired.replacedCount,
          unresolvedAnchorCount: repaired.unresolvedCount,
          freshNodeCount: freshOutlineNodes.length,
          mergedNodeCount: mergedOutlineNodes.length,
          newTranscriptChars,
          semanticChanged,
          noChangeRetryCount,
          hasOld: !!(session.realtimeOutline && String(session.realtimeOutline).trim()),
        });
      } catch { /* intentionally empty */ }
      updateRealtimeOutlineCoverage(session, "partial", {
        attemptedSegmentCount,
        rejectedReason: validation.reason,
      });
      // 判废只记录“尝试到哪里”，绝不推进已提交游标，也不污染主题记忆。
      // 外层统一进入退避重试；手动刷新也不能把不合格结果强行写进时间轴。
      throw new Error(`实时大纲输出格式不合格：${validation.reason}`);
    }
    // 冻结合并：本轮通过验证的增量节点并入已有状态——历史话题冻结、
    // 只给同名历史话题补充子要点，并追加真正的新话题。大纲因此全部内容稳定存在、单调增量生长；
    // 单轮模型抽风（连排 / 漏拆 / 改写）最多影响末尾，碰不到已定稿的历史。
    const mergedOutlineState = normalizeRealtimeOutlineState({
      version: 1,
      nodes: mergedOutlineNodes,
      memory: parsed.memory || existingOutlineState.memory || "",
    });
    session.realtimeOutline = normalizeOutlineMarkdownForDisplay(renderRealtimeOutlineStateMarkdown(mergedOutlineState));
    session.realtimeOutlineMemory = mergedOutlineState.memory;
    session.realtimeOutlineState = mergedOutlineState;
    session.realtimeOutlineSegmentCount = advanceRealtimeOutlineCursor(
      committedSegmentCount,
      attemptedSegmentCount,
      processedSegmentCount
    );
    session.realtimeOutlineAttemptedSegmentCount = attemptedSegmentCount;
    session.realtimeOutlineWorkbenchSignature = workbenchSignature;
    session.realtimeOutlineUpdatedAt = new Date().toISOString();
    updateRealtimeOutlineCoverage(session, "processing", {
      attemptedSegmentCount,
      rejectedReason: "",
      degradedBatchCount: Math.max(0, Number(session.realtimeOutlineDegradedBatchCount) || 0),
    });
    session.realtimeOutlineWindow = {
      usedCount: windowed.usedCount,
      newUsedCount: windowed.newUsedCount,
      omittedBeforeCount: windowed.omittedBeforeCount,
      totalTextCount: windowed.totalTextCount,
      approxChars: windowed.approxChars,
      memoryChars: String(session.realtimeOutlineMemory || "").length,
      committedSegmentCount: attemptedSegmentCount,
      attemptedSegmentCount,
      totalSegmentCount: processedSegmentCount,
      hasRemainingText: windowed.hasRemainingText,
      repairedAnchorCount: repaired.repairedCount,
      replacedModelAnchorCount: repaired.replacedCount,
      restoredAnchorCount: repaired.restoredCount,
      unresolvedAnchorCount: repaired.unresolvedCount,
      freshNodeCount: freshOutlineNodes.length,
      mergedNodeCount: mergedOutlineNodes.length,
      newTranscriptChars,
      semanticChanged,
      noChangeAcknowledged,
      noChangeRetryCount,
      workbenchChars: workbenchSignature.length,
      input: inputMetrics,
    };
    if (noChangeAcknowledged) {
      try {
        await this.host.diagnostics.logDiagnostic("warn", "outline.no_change_acknowledged", "实时大纲增量连续无结构变化，已确认该批次以避免队列停滞", {
          mode: session.mode,
          committedSegmentCount,
          attemptedSegmentCount,
          newUsedCount: windowed.newUsedCount,
          newTranscriptChars,
          noChangeRetryCount,
        });
      } catch { /* intentionally empty */ }
    }
    session.realtimeOutlineNoChangeCommittedCount = -1;
    session.realtimeOutlineNoChangeRetryCount = 0;
    return session.realtimeOutline || result;
  }

  // 收尾前把整场转写补齐成最终大纲（分批追赶，失败的分部由原始转写保底）。
  async ensureRealtimeOutlineForFinalNote(session) {
    if (!this.host.settings.enableRealtimeOutline) return;
    if (!session || !session.segments || !session.segments.length) return;
    const hasTranscript = session.segments.some(s => s && s.text && String(s.text).trim());
    if (!hasTranscript) return;
    if (isRealtimeOutlineCurrent(session)) {
      updateRealtimeOutlineCoverage(session, "complete");
      return;
    }

    const totalSegmentCount = session.segments.length;
    const initialCommittedCount = Math.max(0, Number(session.realtimeOutlineSegmentCount) || 0);
    const remainingSegmentCount = Math.max(0, totalSegmentCount - initialCommittedCount);
    // 正常一批最多消费 9 个新分段（另留 1 个回看段）。按每批至少 4
    // 个新分段保守估算，再加两批余量；同时硬封顶 16，避免异常模型放大费用。
    const maxBatches = Math.min(
      REALTIME_OUTLINE_FINAL_MAX_BATCHES,
      Math.max(1, Math.ceil(remainingSegmentCount / 4) + 2)
    );
    updateRealtimeOutlineCoverage(session, "processing");

    const drainResult = await drainRealtimeOutlineBacklog({
      totalSegmentCount,
      getCommittedCount: () => Math.max(0, Number(session.realtimeOutlineSegmentCount) || 0),
      isComplete: () => isRealtimeOutlineCurrent(session),
      maxAttemptsPerBatch: REALTIME_OUTLINE_FINAL_BATCH_MAX_ATTEMPTS,
      maxBatches,
      shouldRetryAttempt: ({ error }) => /实时大纲输出格式不合格/.test(
        getErrorMessage(error)
      ),
      runBatch: async ({ attemptIndex }) => {
        await this.generateRealtimeOutlineForSession(session, {
          timeoutMs: REALTIME_OUTLINE_FINAL_TIMEOUT_MS,
          force: true,
          final: true,
          formatRetry: attemptIndex > 0,
          maxTokens: REALTIME_OUTLINE_FINAL_MAX_TOKENS,
        });
      },
      onAttemptFailed: async ({ batchIndex, attemptIndex, beforeCommittedCount, error }) => {
        try {
          await this.host.diagnostics.logDiagnostic("warn", "outline.final_batch_retry", "最终大纲批次失败", {
            batchIndex,
            attempt: attemptIndex + 1,
            maxAttempts: REALTIME_OUTLINE_FINAL_BATCH_MAX_ATTEMPTS,
            segmentCount: totalSegmentCount,
            committedSegmentCount: beforeCommittedCount,
            willRetry: attemptIndex + 1 < REALTIME_OUTLINE_FINAL_BATCH_MAX_ATTEMPTS
              && /实时大纲输出格式不合格/.test(getErrorMessage(error)),
            mode: session.mode,
            error: diagnosticError(error),
          });
        } catch { /* diagnostics must never interrupt finalization */ }
      },
      onBatchCompleted: async ({ committedSegmentCount }) => {
        const coveragePercent = totalSegmentCount
          ? Math.round((committedSegmentCount / totalSegmentCount) * 100)
          : 0;
        updateRealtimeOutlineCoverage(session, "processing");
        this.host.recording.setSessionWorkProgress(session, {
          stage: "outline",
          label: `补齐大纲 ${committedSegmentCount}/${totalSegmentCount} 段`,
          percent: Math.min(58, 32 + Math.round(coveragePercent * 0.26)),
          detail: `已覆盖 ${coveragePercent}% 的转写内容`,
        });
        this.host.shell.refreshOutlineView();
      },
    });

    if (drainResult.complete) {
      markRealtimeOutlineSuccess(session);
      updateRealtimeOutlineCoverage(session, "complete", {
        completedBatches: drainResult.completedBatches,
        retryCount: drainResult.retryCount,
      });
      await this.host.diagnostics.logDiagnostic("info", "outline.final_completed", "最终大纲已覆盖全部转写", {
        segmentCount: totalSegmentCount,
        committedSegmentCount: drainResult.committedSegmentCount,
        completedBatches: drainResult.completedBatches,
        attemptCount: drainResult.attemptCount,
        retryCount: drainResult.retryCount,
        mode: session.mode,
      });
      return drainResult;
    }

    markRealtimeOutlineFailure(session);
    updateRealtimeOutlineCoverage(session, "partial", {
      stopReason: drainResult.reason,
      completedBatches: drainResult.completedBatches,
      retryCount: drainResult.retryCount,
      error: drainResult.lastError ? diagnosticError(drainResult.lastError) : null,
    });
    this.host.recording.setSessionWorkProgress(session, {
      stage: "outline",
      label: "大纲未完全补齐",
      percent: 58,
      detail: `已覆盖 ${drainResult.committedSegmentCount}/${totalSegmentCount} 段；最终纪要仍会使用全部转写`,
    });
    new obsidian.Notice(
      `大纲仅覆盖 ${drainResult.committedSegmentCount}/${totalSegmentCount} 段，最终纪要将继续基于完整转写生成。`
    );
    console.error("[QnALog] final realtime outline incomplete", drainResult.lastError);
    await this.host.diagnostics.logDiagnostic("warn", "outline.final_incomplete", "最终大纲未覆盖全部转写", {
      segmentCount: totalSegmentCount,
      committedSegmentCount: drainResult.committedSegmentCount,
      mode: session.mode,
      captureMode: session.captureMode,
      stopReason: drainResult.reason,
      completedBatches: drainResult.completedBatches,
      attemptCount: drainResult.attemptCount,
      retryCount: drainResult.retryCount,
      error: drainResult.lastError ? diagnosticError(drainResult.lastError) : null,
    });
    return drainResult;
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
