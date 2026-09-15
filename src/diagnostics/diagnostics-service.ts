/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：诊断日志与诊断报告：jsonl 落盘、内存与队列快照、脱敏报告

import * as obsidian from "obsidian";
import { getDesktopProcess } from "../shared/desktop-runtime";
import { audioInputModeLabel } from "../ui/helpers";
import { normalizeAsrConcurrency } from "../asr/transcribe";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { createLiveAsrCircuitState, isLiveAsrCircuitOpen, summarizeLiveAsrJobs } from "../asr/live-segment-policy";
import { redactDiagnosticText, sanitizeDiagnosticData, diagnosticError } from "../shared/util-key-diag";
import type { LiveAsrBacklogSummary } from "../asr/live-segment-policy";
import type { PluginSettings, RecordingSession, RealtimeOutlineInputStats } from "../shared/types";
import type { PluginBuildInfo } from "../shared/build-info";
import type { TaskQueue } from "../queue/task-queue";
import type { RecorderService } from "../audio/recorder-service";
import { ensureVaultFolder } from "../shared/util-vault";

/** 实时大纲输入统计的空值；字段与 RealtimeOutlineInputStats 一致。 */
function createEmptyRealtimeOutlineInputStats(): RealtimeOutlineInputStats {
  return {
    fullTranscript: false,
    systemChars: 0,
    userChars: 0,
    totalChars: 0,
    rollingContextChars: 0,
    transcriptChars: 0,
    previousOutlineChars: 0,
    memoryChars: 0,
    maxTranscriptChars: 0,
  };
}

/** DiagnosticsService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface DiagnosticsHost {
  /** 知识库访问（读插件目录、读写日记式 jsonl 文件）。 */
  app: obsidian.App;
  /** 设置对象本身，不拷贝；服务读 diagnosticsLogEnabled / diagnosticsLogFolder 等字段。 */
  settings: PluginSettings;
  /** manifest 版本号，写进每条日志。 */
  manifest?: { version?: string };
  /** 安装时写入的构建信息，报告里区分正式发布与开发版。 */
  buildInfo: PluginBuildInfo | null;
  /** 任务队列，报告里统计各状态任务数。 */
  queue: TaskQueue | null;
  /** 当前录音会话，报告里读熔断状态与实时大纲输入量。 */
  session: RecordingSession | null;
  /** 录音器，报告里读状态。 */
  recorder: RecorderService | null;
  /** 界面上显示的版本串。 */
  getDisplayVersion(): string;
  /** 当前构建的来源描述。 */
  getBuildSourceLabel(): string;
  /** 会话的实时转写积压统计。 */
  recording: { getLiveAsrBacklogSummary(session: RecordingSession | null): LiveAsrBacklogSummary; getRecorderBufferSummary(): { masterChunkCount: number; masterChunkBytes: number; currentSegmentChunkCount: number; currentSegmentChunkBytes: number } };
  /** 录音器当前缓存的内存块统计。 */
}

export class DiagnosticsService {
  declare host: DiagnosticsHost;
  /** 诊断日志写入串行链的两端：保证并发调用不互相覆盖。 */
  declare _diagnosticWriteTail;
  constructor(host) {
    this.host = host;
    this._diagnosticWriteTail = null;
  }

  getDiagnosticsFolder() {
    return obsidian.normalizePath(this.host.settings.diagnosticsLogFolder || DEFAULT_SETTINGS.diagnosticsLogFolder);
  }
  async logDiagnostic(level, code, message, data) {
    if (this.host.settings.diagnosticsLogEnabled === false) return;
    const write = async () => {
      const folder = this.getDiagnosticsFolder();
      await ensureVaultFolder(this.host.app, folder);
      const moment = window.moment;
      const day = moment ? moment().format("YYYY-MM-DD") : new Date().toISOString().slice(0, 10);
      const path = obsidian.normalizePath(`${folder}/${day}.jsonl`);
      const entry = {
        ts: new Date().toISOString(),
        level: level || "info",
        code: code || "event",
        version: this.host.manifest && this.host.manifest.version,
        message: redactDiagnosticText(message || ""),
        data: sanitizeDiagnosticData(data || {}),
      };
      const line = JSON.stringify(entry) + "\n";
      const file = this.host.app.vault.getAbstractFileByPath(path);
      if (file instanceof obsidian.TFile) {
        const cur = await this.host.app.vault.read(file);
        await this.host.app.vault.modify(file, cur + line);
      } else {
        await this.host.app.vault.create(path, line);
      }
    };
    // 多个 ASR/LLM 任务会并发记录日志。串行化读改写，避免两个调用都读取旧内容后
    // 后写者覆盖先写者，导致最关键的故障证据恰好丢失。
    const previous = this._diagnosticWriteTail || Promise.resolve();
    const current = previous.catch(() => undefined).then(write);
    this._diagnosticWriteTail = current;
    try {
      await current;
    } catch (e) {
      console.warn("[QnALog] diagnostic log failed", e);
    } finally {
      if (this._diagnosticWriteTail === current) this._diagnosticWriteTail = null;
    }
  }
  async readRecentDiagnosticLines(limit = 80) {
    try {
      const folder = this.host.app.vault.getAbstractFileByPath(this.getDiagnosticsFolder());
      if (!(folder instanceof obsidian.TFolder)) return [];
      const files = folder.children
        .filter((f): f is obsidian.TFile => f instanceof obsidian.TFile && /jsonl$/i.test(f.extension || ""))
        .sort((a, b) => b.stat.mtime - a.stat.mtime)
        .slice(0, 3);
      const lines = [];
      for (const file of files.reverse()) {
        const text = await this.host.app.vault.read(file);
        for (const line of text.split("\n")) {
          if (line.trim()) lines.push(redactDiagnosticText(line));
        }
      }
      return lines.slice(-limit);
    } catch (e) {
      console.warn("[QnALog] read diagnostics failed", e);
      return [];
    }
  }
  async getRuntimeMemorySummary() {
    const result = {
      jsHeapUsedBytes: 0,
      jsHeapTotalBytes: 0,
      rendererPrivateBytes: 0,
      rendererResidentBytes: 0,
    };
    try {
      const memory = activeWindow.performance && activeWindow.performance["memory"];
      result.jsHeapUsedBytes = Math.max(0, Number(memory && memory.usedJSHeapSize) || 0);
      result.jsHeapTotalBytes = Math.max(0, Number(memory && memory.totalJSHeapSize) || 0);
    } catch { /* unsupported runtime */ }
    try {
      const processApi = getDesktopProcess();
      if (processApi && typeof processApi.getProcessMemoryInfo === "function") {
        const info = await processApi.getProcessMemoryInfo();
        // Electron 返回 KB；诊断统一换算为 bytes。
        result.rendererPrivateBytes = Math.max(0, Number(info && info.private) || 0) * 1024;
        result.rendererResidentBytes = Math.max(0, Number(info && info.residentSet) || 0) * 1024;
      }
    } catch { /* unsupported runtime */ }
    return result;
  }
  async buildDiagnosticReport() {
    const activeId = this.host.settings.activeTranscribeProvider || "";
    const provider = (this.host.settings.transcribeProviders || {})[activeId] || {};
    const queueItems = this.host.queue && Array.isArray(this.host.queue.tasks) ? this.host.queue.tasks : [];
    const counts = queueItems.reduce((acc, task) => {
      const key = task.status || "pending";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const lines = await this.readRecentDiagnosticLines(100);
    const activeSession = this.host.session;
    const liveBacklog = activeSession ? this.host.recording.getLiveAsrBacklogSummary(activeSession) : summarizeLiveAsrJobs([]);
    const recorderBuffer = this.host.recording.getRecorderBufferSummary();
    const runtimeMemory = await this.getRuntimeMemorySummary();
    const circuit = activeSession && activeSession.asrCircuitState ? activeSession.asrCircuitState : createLiveAsrCircuitState();
    const outlineInput = activeSession && activeSession.realtimeOutlineInput || createEmptyRealtimeOutlineInputStats();
    const mib = (bytes) => (Math.max(0, Number(bytes) || 0) / (1024 * 1024)).toFixed(1);
    return [
      "# Q&A Log 诊断报告",
      "",
      "## 环境",
      `- Q&A Log: ${this.host.getDisplayVersion()}${this.host.buildInfo && this.host.buildInfo.channel === "dev" ? `（${this.host.getBuildSourceLabel()}）` : ""}`,
      `- Obsidian API: ${obsidian.apiVersion || "unknown"}`,
      `- 平台: ${redactDiagnosticText(obsidian.Platform.isMacOS ? "macOS" : obsidian.Platform.isWin ? "Windows" : obsidian.Platform.isLinux ? "Linux" : obsidian.Platform.isIosApp ? "iOS" : obsidian.Platform.isAndroidApp ? "Android" : "unknown")}`,
      "",
      "## 当前配置摘要",
      `- 转写服务: ${redactDiagnosticText(activeId)} / ${redactDiagnosticText(provider.name || "")}`,
      `- 转写模型: ${redactDiagnosticText(provider.model || this.host.settings.transcribeModel || "")}`,
      `- 转写端点: ${redactDiagnosticText(provider.endpoint || this.host.settings.transcribeEndpoint || "")}`,
      `- ASR 并发数: ${normalizeAsrConcurrency(this.host.settings.asrConcurrency)}`,
      `- 音频输入: ${audioInputModeLabel(this.host.settings.captureMode || "mic")}`,
      `- 分段间隔: ${this.host.settings.segmentIntervalMinutes} 分钟`,
      `- 队列: ${JSON.stringify(counts)}`,
      "",
      "## 录音与实时转写状态",
      `- 录音状态: ${this.host.recorder && this.host.recorder.state || "idle"}`,
      `- 完整录音内存块: ${recorderBuffer.masterChunkCount} 块 / ${mib(recorderBuffer.masterChunkBytes)} MiB`,
      `- 当前分段内存块: ${recorderBuffer.currentSegmentChunkCount} 块 / ${mib(recorderBuffer.currentSegmentChunkBytes)} MiB`,
      `- 等待实时转写: ${liveBacklog.count} 段 / ${(liveBacklog.totalDurationMs / 60000).toFixed(1)} 分钟 / ${mib(liveBacklog.totalBytes)} MiB`,
      `- 最久等待: ${(liveBacklog.oldestAgeMs / 1000).toFixed(1)} 秒`,
      `- 积压保护: ${activeSession && activeSession.asrDeferredMode ? "已转后台" : (activeSession && activeSession.asrBacklogLevel || "normal")}`,
      `- 转写熔断: ${isLiveAsrCircuitOpen(circuit) ? "冷却中" : "关闭"} / 连续失败 ${circuit.consecutiveFailures || 0} 次`,
      `- JS Heap: ${mib(runtimeMemory.jsHeapUsedBytes)} / ${mib(runtimeMemory.jsHeapTotalBytes)} MiB`,
      `- Renderer 内存: private ${mib(runtimeMemory.rendererPrivateBytes)} MiB / resident ${mib(runtimeMemory.rendererResidentBytes)} MiB`,
      "",
      "## 最近一次实时大纲输入",
      `- 输入模式: ${outlineInput.fullTranscript ? "整场转写" : "增量窗口"}`,
      `- 总输入字符: ${Math.max(0, Number(outlineInput.totalChars) || 0)}`,
      `- 新增转写字符: ${Math.max(0, Number(outlineInput.transcriptChars) || 0)}`,
      `- 旧大纲字符: ${Math.max(0, Number(outlineInput.previousOutlineChars) || 0)}`,
      `- 主题记忆字符: ${Math.max(0, Number(outlineInput.memoryChars) || 0)}`,
      "",
      "## 最近日志",
      lines.length ? lines.join("\n") : "暂无诊断日志。",
      "",
      "> 说明：诊断报告已自动隐藏常见 API Key、Token、用户目录和知识库路径；不会包含音频、转写正文或 Prompt 全文。",
    ].join("\n");
  }
  async copyDiagnosticReport() {
    const report = await this.buildDiagnosticReport();
    try {
      await navigator.clipboard.writeText(report);
      new obsidian.Notice("Q&A Log 诊断报告已复制，可发给开发者排查。", 6000);
    } catch (e) {
      await this.logDiagnostic("error", "diagnostics.copy_failed", "复制诊断报告失败", { error: diagnosticError(e) });
      new obsidian.Notice(`诊断报告复制失败：${(e && e.message) || e}`, 8000);
    }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
