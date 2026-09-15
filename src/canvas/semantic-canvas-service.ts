/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 ui/outline-view.ts 抽出（P2 界面与业务分层，纯搬迁、零行为改动）：语义 Canvas 的读取、生成与排版迁移。
//
// 视图层只保留渲染与交互（按钮、菜单、进度文案）；这里是它们背后的数据与文件操作。
// 重建 DOM 由视图自己决定：需要重绘的时机通过 SemanticCanvasRepaint 回调交给视图，服务不直接碰视图。

import * as obsidian from "obsidian";
import { callLlm, formatLlmConfigIssue, getLlmConfigIssue } from "../llm/core";
import {
  buildSemanticBranchExpansionPrompt,
  buildSemanticCanvasDocument,
  buildSemanticOutlinePrompt,
  extractSemanticSourceSections,
  getSemanticCanvasPath,
  getSemanticGenerationPolicy,
  normalizeJsonCanvasDocument,
  parseSemanticBranchExpansion,
  parseSemanticOutlineGraph,
  replaceSemanticBranch,
  semanticCanvasNeedsRelayout,
} from "../canvas/semantic-outline-canvas";
import type { SemanticCanvasLayoutMode } from "../canvas/semantic-outline-canvas";
import { inferSemanticCanvasSourcePath, parseSemanticCanvasSourcePath } from "../canvas/source-note";
import { parseRealtimeOutlineStateFromMarkdown } from "../outline-text";
import { diagnosticError } from "../shared/util-key-diag";
import type { PluginSettings } from "../shared/types";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { NoteIndexService } from "../notes/note-index-service";
import { readSemanticMeta } from "../shared/namespace";
import type { QnALogSemanticDocumentMeta } from "./semantic-outline-canvas";

/** SemanticCanvasService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface SemanticCanvasHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  diagnostics: DiagnosticsService;
  /** 纪要索引刷新：生成成功后更新语义 Canvas 路径。 */
  noteIndex: NoteIndexService;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
}

/** 语义 Canvas 生成模式：full 重建整张图，branch/drill 更新单条主线，layout 只重新排版。 */
export type SemanticCanvasMode = "full" | "branch" | "drill" | "layout";

export interface SemanticCanvasOptions {
  mode?: SemanticCanvasMode;
  branchKey?: string;
  layoutMode?: string;
}

export interface SemanticCanvasProgress {
  phase: string;
  label: string;
  current: number;
  total: number;
}

/**
 * 视图提供的重绘入口。
 *
 * 原实现里三种重绘时机各不相同，搬迁时按原样保留，不用一个回调统一代替：
 * - `throttled`：`scheduleUpdate()`，签名未变时只更新计时文本；
 * - `forced`：清空 `_lastSig` 后 `scheduleUpdate()`，强制走完整重建（下一帧）；
 * - `immediate`：`render()`，立即重建 DOM（生成任务的进度态不在渲染签名里，必须立即重绘才能显示）。
 */
export interface SemanticCanvasRepaint {
  throttled?: () => void;
  forced?: () => void;
  immediate?: () => void;
}

export class SemanticCanvasService {
  declare host: SemanticCanvasHost;
  /** 正在生成语义 Canvas 的纪要路径；同一篇纪要同时只跑一个生成任务。 */
  runningPaths: Set<string>;
  /** 各纪要的生成进度，供侧边栏按钮显示当前阶段。 */
  progressByPath: Map<string, SemanticCanvasProgress>;
  /** 当前打开的 Canvas 及其对应纪要：打开 .canvas 时侧边栏要切到它引用的纪要。 */
  activeCanvasSource: { canvasPath: string; sourcePath: string };
  /** 递增序号，用于丢弃过期的异步解析结果（用户快速切换文件时）。 */
  activeCanvasSourceSeq: number;

  constructor(host) {
    this.host = host;
    this.runningPaths = new Set();
    this.progressByPath = new Map();
    this.activeCanvasSource = { canvasPath: "", sourcePath: "" };
    this.activeCanvasSourceSeq = 0;
  }

  /** 显示用：当前 Canvas 与来源纪要的标识，参与视图的渲染签名。 */
  getActiveCanvasSourceSignature() {
    return this.activeCanvasSource
      ? `${this.activeCanvasSource.canvasPath}:${this.activeCanvasSource.sourcePath}`
      : "";
  }

  /** 某个 .canvas 路径对应的纪要文件；不是当前激活的 Canvas 或未解析出纪要时返回 null。 */
  getCanvasSourceFileFor(canvasPath) {
    const normalized = obsidian.normalizePath(String(canvasPath || ""));
    if (!this.activeCanvasSource || this.activeCanvasSource.canvasPath !== normalized) return null;
    const sourcePath = obsidian.normalizePath(this.activeCanvasSource.sourcePath || "");
    if (!sourcePath) return null;
    const sourceFile = this.host.app.vault.getAbstractFileByPath(sourcePath);
    return sourceFile instanceof obsidian.TFile && sourceFile.extension === "md" ? sourceFile : null;
  }

  /**
   * 跟踪当前激活的文件：若为 .canvas，解析出它引用的纪要并记录。
   * 解析结果只在仍是同一个 Canvas 时生效（序号比对），避免快速切换文件时写回过期结果。
   *
   * 三种重绘时机的区分见 SemanticCanvasRepaint。
   */
  async syncActiveCanvasSourceNote(repaint: SemanticCanvasRepaint = {}) {
    const throttled = () => { if (repaint.throttled) repaint.throttled(); };
    const forced = () => { if (repaint.forced) repaint.forced(); };
    const active = this.host.app.workspace.getActiveFile();
    const sequence = ++this.activeCanvasSourceSeq;
    if (!(active instanceof obsidian.TFile) || active.extension !== "canvas") {
      this.activeCanvasSource = { canvasPath: "", sourcePath: "" };
      throttled();
      return;
    }
    const canvasPath = obsidian.normalizePath(active.path);
    this.activeCanvasSource = { canvasPath, sourcePath: "" };
    throttled();
    let sourcePath = "";
    try {
      sourcePath = parseSemanticCanvasSourcePath(await this.host.app.vault.cachedRead(active), canvasPath);
    } catch (error) {
      console.warn("[QnALog] read semantic canvas source failed", error);
    }
    if (sequence !== this.activeCanvasSourceSeq) return;
    const current = this.host.app.workspace.getActiveFile();
    if (!(current instanceof obsidian.TFile) || obsidian.normalizePath(current.path) !== canvasPath) return;
    let sourceFile = sourcePath ? this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(sourcePath)) : null;
    if (!(sourceFile instanceof obsidian.TFile)) {
      const inferredPath = inferSemanticCanvasSourcePath(canvasPath);
      sourceFile = inferredPath ? this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(inferredPath)) : null;
    }
    this.activeCanvasSource = {
      canvasPath,
      sourcePath: sourceFile instanceof obsidian.TFile && sourceFile.extension === "md" ? sourceFile.path : "",
    };
    if (sourceFile instanceof obsidian.TFile && sourceFile.extension === "md") {
      await this.migrateSemanticCanvasLayoutIfNeeded(active, sourceFile);
    }
    forced();
  }

  /** 旧版语义 Canvas 的排版升级；不满足条件或失败时返回 false，不影响打开。 */
  async migrateSemanticCanvasLayoutIfNeeded(canvasFile, sourceFile) {
    if (!(canvasFile instanceof obsidian.TFile) || !(sourceFile instanceof obsidian.TFile)) return false;
    if (this.runningPaths.has(sourceFile.path)) return false;
    let existing;
    try {
      existing = normalizeJsonCanvasDocument(JSON.parse(await this.host.app.vault.cachedRead(canvasFile)));
    } catch (error) {
      console.warn("[QnALog] inspect semantic canvas layout failed", error);
      return false;
    }
    const existingMeta = readSemanticMeta<QnALogSemanticDocumentMeta>(existing);
    if (!existingMeta?.graph || !semanticCanvasNeedsRelayout(existing)) return false;

    this.runningPaths.add(sourceFile.path);
    try {
      const sourceMarkdown = await this.host.app.vault.cachedRead(sourceFile);
      const sourceSections = extractSemanticSourceSections(sourceMarkdown);
      const document = buildSemanticCanvasDocument(existingMeta.graph, {
        sourcePath: sourceFile.path,
        sourceTitle: sourceFile.basename,
        sourceSections,
        existing,
        policy: existingMeta.policy || getSemanticGenerationPolicy(sourceSections),
        forceRelayout: true,
        layoutMode: existingMeta.layoutMode || "adaptive",
      });
      await this.host.app.vault.modify(canvasFile, `${JSON.stringify(document, null, 2)}\n`);
      await this.host.diagnostics.logDiagnostic("info", "canvas.semantic_layout_migrated", "旧版语义 Canvas 已更新排版", {
        sourcePath: sourceFile.path,
        canvasPath: canvasFile.path,
      });
      return true;
    } catch (error) {
      console.warn("[QnALog] migrate semantic canvas layout failed", error);
      await this.host.diagnostics.logDiagnostic("warn", "canvas.semantic_layout_migration_failed", "旧版语义 Canvas 排版更新失败", {
        sourcePath: sourceFile.path,
        canvasPath: canvasFile.path,
        error: diagnosticError(error),
      });
      return false;
    } finally {
      this.runningPaths.delete(sourceFile.path);
    }
  }

  /** 读取纪要对应的语义 Canvas；文件不存在或无法解析时 existing 为 null。 */
  async readSemanticCanvas(sourceFile) {
    const canvasPath = obsidian.normalizePath(getSemanticCanvasPath(sourceFile.path));
    const canvasFile = this.host.app.vault.getAbstractFileByPath(canvasPath);
    if (!(canvasFile instanceof obsidian.TFile)) return { canvasPath, canvasFile: null, existing: null };
    try {
      const existing = normalizeJsonCanvasDocument(JSON.parse(await this.host.app.vault.read(canvasFile)));
      return { canvasPath, canvasFile, existing };
    } catch {
      return { canvasPath, canvasFile, existing: null };
    }
  }

  /** 打开主线来源的小节；定位不到小节时退回打开整篇纪要。 */
  async openSemanticSourceSection(sourceFile, sourceSectionId) {
    const markdown = await this.host.app.vault.cachedRead(sourceFile);
    const section = extractSemanticSourceSections(markdown).find((item) => item.id === sourceSectionId);
    if (!section) {
      await this.host.app.workspace.getLeaf(false).openFile(sourceFile);
      return;
    }
    await this.host.app.workspace.openLinkText(`${sourceFile.path}#${section.heading}`, sourceFile.path, false);
  }

  /**
   * 生成或更新语义 Canvas。
   *
   * repaint.immediate 对应原实现进入/离开运行态时的 `this.render()`：
   * 进度态不在视图的渲染签名里，因此必须立即重建 DOM 才能显示「正在生成」。
   */
  async generateSemanticCanvas(sourceFile, outlineMarkdown, options: SemanticCanvasOptions = { mode: "full" }, repaint: SemanticCanvasRepaint = {}) {
    if (!(sourceFile instanceof obsidian.TFile) || this.runningPaths.has(sourceFile.path)) return;
    const outlineNodes = parseRealtimeOutlineStateFromMarkdown(outlineMarkdown);
    if (options.mode === "full" && outlineNodes.length < 2) {
      new obsidian.Notice("当前大纲内容太少，暂时无法生成语义图。", 5000);
      return;
    }
    const llmIssue = options.mode !== "layout" ? getLlmConfigIssue(this.host.settings) : null;
    if (llmIssue) {
      new obsidian.Notice(`生成语义图前需要先完成大模型配置：${formatLlmConfigIssue(llmIssue)}`, 9000);
      return;
    }

    this.runningPaths.add(sourceFile.path);
    this.progressByPath.set(sourceFile.path, { label: "正在读取纪要", phase: "prepare", current: 0, total: 1 });
    if (repaint.immediate) repaint.immediate();
    const progressNotice = new obsidian.Notice("正在读取纪要…", 300000);
    const updateProgress = async (phase, label, current = 0, total = 1) => {
      this.progressByPath.set(sourceFile.path, { phase, label, current, total });
      progressNotice.setMessage(total > 1 ? `${label}（${current}/${total}）` : label);
      await this.host.diagnostics.logDiagnostic("info", "canvas.semantic_phase", label, {
        sourcePath: sourceFile.path,
        phase,
        current,
        total,
        mode: options.mode,
        branchKey: options.branchKey || "",
      });
    };
    try {
      const sourceMarkdown = await this.host.app.vault.cachedRead(sourceFile);
      const sourceSections = extractSemanticSourceSections(sourceMarkdown);
      const policy = getSemanticGenerationPolicy(sourceSections);
      const state = await this.readSemanticCanvas(sourceFile);
      if (state.canvasFile && !state.existing) throw new Error("已有语义 Canvas 文件无法解析，请先检查文件内容");
      let graph = readSemanticMeta<QnALogSemanticDocumentMeta>(state.existing)?.graph || null;

      if (options.mode === "full") {
        await updateProgress("overview", "正在提取中心命题与内容主线");
        const prompt = buildSemanticOutlinePrompt(sourceFile.basename, outlineNodes, sourceSections, policy);
        const raw = await callLlm(this.host, prompt.system, prompt.user, {
          timeoutMs: 150000,
          payload: { max_tokens: Math.min(7600, 2800 + policy.maxNodes * 90) },
          priority: "user",
          thinkingMode: "fast",
        });
        graph = parseSemanticOutlineGraph(raw, outlineNodes, sourceSections, policy);
        if (!graph) throw new Error("模型没有返回可用的语义关系结构");
        if (policy.expandBranches) {
          const overview = graph;
          for (const [index, branch] of overview.branches.entries()) {
            await updateProgress("expand", `正在展开主线：${branch.title}`, index + 1, overview.branches.length);
            try {
              const branchPrompt = buildSemanticBranchExpansionPrompt(
                sourceFile.basename,
                branch,
                sourceSections,
                outlineNodes,
                policy,
              );
              const branchRaw = await callLlm(this.host, branchPrompt.system, branchPrompt.user, {
                timeoutMs: 150000,
                payload: { max_tokens: Math.min(6200, 2200 + policy.branchNodeBudget * 260) },
                priority: "user",
                thinkingMode: "fast",
              });
              const expanded = parseSemanticBranchExpansion(branchRaw, branch, outlineNodes, sourceSections, policy);
              if (expanded) graph = replaceSemanticBranch(graph, branch.key, expanded);
              else await this.host.diagnostics.logDiagnostic("warn", "canvas.semantic_branch_invalid", "主线展开结果无法解析，已保留概览结构", {
                sourcePath: sourceFile.path,
                branchKey: branch.key,
              });
            } catch (branchError) {
              await this.host.diagnostics.logDiagnostic("warn", "canvas.semantic_branch_failed", "主线展开失败，已保留概览结构", {
                sourcePath: sourceFile.path,
                branchKey: branch.key,
                error: diagnosticError(branchError),
              });
            }
          }
        }
      } else if (options.mode === "branch" || options.mode === "drill") {
        if (!graph) throw new Error("现有语义图缺少可更新的结构数据，请先更新整张语义图");
        const branch = graph.branches.find((item) => item.key === options.branchKey);
        if (!branch) throw new Error("找不到需要更新的内容主线");
        await updateProgress(options.mode, options.mode === "drill" ? `正在继续下钻：${branch.title}` : `正在更新主线：${branch.title}`);
        const branchPrompt = buildSemanticBranchExpansionPrompt(
          sourceFile.basename,
          branch,
          sourceSections,
          outlineNodes,
          policy,
          options.mode === "drill",
        );
        const branchRaw = await callLlm(this.host, branchPrompt.system, branchPrompt.user, {
          timeoutMs: 150000,
          payload: { max_tokens: Math.min(6800, 2400 + policy.branchNodeBudget * 290) },
          priority: "user",
          thinkingMode: "fast",
        });
        const replacement = parseSemanticBranchExpansion(branchRaw, branch, outlineNodes, sourceSections, policy);
        if (!replacement) throw new Error("模型没有返回可用的主线结构");
        graph = replaceSemanticBranch(graph, branch.key, replacement);
      } else if (options.mode === "layout") {
        if (!graph) throw new Error("现有语义图缺少结构数据，无法重新排版");
        await updateProgress("layout", "正在重新排版");
      }
      if (!graph) throw new Error("没有可写入的语义结构");

      await updateProgress("write", "正在写入语义 Canvas");
      const document = buildSemanticCanvasDocument(graph, {
        sourcePath: sourceFile.path,
        sourceTitle: sourceFile.basename,
        sourceSections,
        existing: state.existing,
        policy,
        forceRelayout: options.mode === "layout",
        layoutMode: (options.layoutMode || readSemanticMeta<QnALogSemanticDocumentMeta>(state.existing)?.layoutMode || "adaptive") as SemanticCanvasLayoutMode,
      });
      const content = `${JSON.stringify(document, null, 2)}\n`;
      let canvasFile = state.canvasFile;
      if (canvasFile instanceof obsidian.TFile) {
        await this.host.app.vault.modify(canvasFile, content);
      } else {
        try {
          canvasFile = await this.host.app.vault.create(state.canvasPath, content);
        } catch (error) {
          const raced = this.host.app.vault.getAbstractFileByPath(state.canvasPath);
          if (!(raced instanceof obsidian.TFile)) throw error;
          canvasFile = raced;
          await this.host.app.vault.modify(canvasFile, content);
        }
      }
      await this.host.diagnostics.logDiagnostic("info", "canvas.semantic_generated", "语义 Canvas 已生成", {
        sourcePath: sourceFile.path,
        canvasPath: state.canvasPath,
        mode: options.mode,
        outlineNodeCount: outlineNodes.length,
        sourceSectionCount: sourceSections.length,
        branchCount: graph.branches.length,
        semanticNodeCount: (() => {
          const count = (nodes) => nodes.reduce((total, node) => total + 1 + count(node.children || []), 0);
          return count(graph.branches);
        })(),
      });
      await this.host.noteIndex.refreshNoteIndexSafely(sourceFile, { reason: "semantic-canvas" });
      if (canvasFile instanceof obsidian.TFile) await this.host.app.workspace.getLeaf(true).openFile(canvasFile);
      progressNotice.hide();
      new obsidian.Notice(options.mode === "layout" ? "语义 Canvas 已重新排版。" : "语义 Canvas 已更新。", 4000);
    } catch (error) {
      console.error("[QnALog] generate semantic canvas failed", error);
      await this.host.diagnostics.logDiagnostic("warn", "canvas.semantic_failed", "语义 Canvas 生成失败", {
        sourcePath: sourceFile.path,
        error: diagnosticError(error),
      });
      progressNotice.hide();
      new obsidian.Notice(`语义 Canvas 生成失败：${(error && error.message) || error}`, 9000);
    } finally {
      this.runningPaths.delete(sourceFile.path);
      this.progressByPath.delete(sourceFile.path);
      if (repaint.immediate) repaint.immediate();
    }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
