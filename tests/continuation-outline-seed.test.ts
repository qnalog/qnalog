import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
  Menu: class {}, Notice: class {},
}));

// 续录会话的实时大纲种子：旧场次大纲必须作为 session.realtimeOutline /
// realtimeOutlineState 的初值，否则增量管线从零开始，笔记里的大纲 details
// 永远停在旧场次内容（vitest 无法起 Obsidian 宿主，这里锁定纯函数行为与
// 源码装配点，防回归）。
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  mergeStableRealtimeOutlineNodes,
  parseRealtimeOutlineStateFromMarkdown,
  normalizeOutlineMarkdownForDisplay,
  validateRealtimeOutlineMarkdown,
} from "../src/outline-text";
import { normalizeRealtimeOutlineState, renderRealtimeOutlineStateMarkdown, shouldRunRealtimeOutline } from "../src/notes/realtime-outline";

const PRIOR_OUTLINE = [
  "- [[qnalog-20260917-115635.m4a|00:00]] AI视频工作流的标准化规范",
  "  - 解决风格漂移问题：建立坐标系以维持画面一致性",
  "  - 统一视觉元素规范：明确字体、字形、字号及展示位置",
].join("\n");

describe("续录会话的实时大纲种子", () => {
  it("normalizeRealtimeOutlineState 能把旧大纲文本解析成冻结节点状态", () => {
    const state = normalizeRealtimeOutlineState(undefined, PRIOR_OUTLINE, "");
    expect(state.nodes.length).toBe(1);
    expect(state.nodes[0].title).toContain("AI视频工作流的标准化规范");
    expect(state.nodes[0].anchor).toBe("[[qnalog-20260917-115635.m4a|00:00]]");
    expect(state.nodes[0].children.length).toBe(2);
    // 回渲染应逐行保留旧大纲
    const rendered = normalizeOutlineMarkdownForDisplay(renderRealtimeOutlineStateMarkdown(state));
    expect(rendered).toContain("AI视频工作流的标准化规范");
    expect(rendered).toContain("qnalog-20260917-115635.m4a");
  });

  it("新话题的 fresh 节点合并到旧节点之后，旧节点冻结保留", () => {
    const existing = parseRealtimeOutlineStateFromMarkdown(PRIOR_OUTLINE);
    const fresh = parseRealtimeOutlineStateFromMarkdown([
      "- [[qnalog-20260921-100922.m4a|03:56]] Hyper Frames 的局限与新挑战",
      "  - 文字堆叠导致成片 PPT 化",
    ].join("\n"));
    const merged = mergeStableRealtimeOutlineNodes(existing, fresh);
    expect(merged.length).toBe(2);
    expect(merged[0].anchor).toBe("[[qnalog-20260917-115635.m4a|00:00]]");
    expect(merged[0].children.length).toBe(2); // 旧子要点不丢
    expect(merged[1].title).toContain("Hyper Frames");
  });

  it("增量轮（deltaOnly）只限制本轮新增顶层项，种子行数不参与判废", () => {
    const fresh = [
      "- [[qnalog-20260921-100922.m4a|03:56]] 追加场次的独立话题",
      "  - 要点一",
    ].join("\n");
    const validation = validateRealtimeOutlineMarkdown(fresh, {
      previousOutline: PRIOR_OUTLINE,
      allowUntimedTopLevel: true,
      deltaOnly: true,
      maxNewTopLevel: 8,
    });
    expect(validation.ok).toBe(true);
  });

  it("shouldRunRealtimeOutline：续录会话（种子在场）1 段 160 字的静默轮可被放行", () => {
    const session = {
      segments: [
        { text: "x".repeat(160) },
      ],
      realtimeOutline: PRIOR_OUTLINE,
      realtimeOutlineSegmentCount: 0,
      activeSegmentJobs: 0,
      realtimeOutlineFailureCount: 0,
      realtimeOutlineNextAllowedAt: 0,
      realtimeOutlineAttemptedAt: "",
      realtimeOutlineUpdatedAt: "",
      continuationSourcePath: "QnALog/转写纪要/旧纪要.md",
    };
    expect(shouldRunRealtimeOutline(session, { silent: true })).toBe(true);
  });

  it("shouldRunRealtimeOutline：非续录会话同量新段仍按 2 段/200 字门槛拦下", () => {
    const session = {
      segments: [
        { text: "x".repeat(160) },
      ],
      realtimeOutline: PRIOR_OUTLINE,
      realtimeOutlineSegmentCount: 0,
      activeSegmentJobs: 0,
      realtimeOutlineFailureCount: 0,
      realtimeOutlineNextAllowedAt: 0,
      realtimeOutlineAttemptedAt: "",
      realtimeOutlineUpdatedAt: "",
    };
    expect(shouldRunRealtimeOutline(session, { silent: true })).toBe(false);
  });

  it("recording-service 装配点：续录会话把旧大纲写进种子字段", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/audio/recording-service.ts"), "utf8");
    expect(src).toContain("realtimeOutline: continuationInfo ? (continuationInfo.priorOutline || \"\") : \"\"");
    expect(src).toContain("normalizeRealtimeOutlineState(undefined, continuationInfo.priorOutline, \"\")");
  });
});
