import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
}));
import { buildPriorSessionBlocks } from "../src/notes/note-writer";
import { extractPriorOutline } from "../src/audio/recording-service";

// 测试环境没有 Obsidian 注入的 window.moment；format 只用到 YYYY-MM-DD HH:mm:ss。
vi.stubGlobal("window", {
  moment: (v?: string | number | Date) => {
    const d = v == null ? new Date() : new Date(v);
    const p = (n: number) => String(n).padStart(2, "0");
    return {
      isValid: () => !Number.isNaN(d.getTime()),
      format: () => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    };
  },
});

// 续录重写笔记时，旧场次的原始材料（录音信息行、实时大纲草稿、原始音频引用）
// 必须按场次保留；普通会话三段都必须是空串，输出路径逐字节不变。
describe("buildPriorSessionBlocks 续录旧场次材料", () => {
  const baseSession = {
    continuationSourcePath: "QnALog/转写纪要/旧笔记.md",
    continuationSourceTitle: "旧笔记",
    continuationRecordedAt: "2026-09-17T03:56:35.000Z",
    continuationPriorRecordingInfo: "- 时间：2026-09-17 11:56:35\n- 时长：03:56\n- 模式：个人笔记\n- 分段：1",
    continuationPriorOutline: "- AI视频工作流的标准化规范\n  - 解决风格漂移问题",
    continuationPriorAudioNames: ["qnalog-20260917-115635.m4a"],
  };

  it("普通会话（无 continuationSourcePath）三段全部为空", () => {
    const blocks = buildPriorSessionBlocks({ segments: [] });
    expect(blocks.recordingInfoAppendix).toBe("");
    expect(blocks.outlineAppendix).toBe("");
    expect(blocks.audioAppendix).toBe("");
  });

  it("续录会话：录音信息含追加时间与旧场次信息", () => {
    const blocks = buildPriorSessionBlocks(baseSession);
    expect(blocks.recordingInfoAppendix).toContain("追加录音");
    expect(blocks.recordingInfoAppendix).toContain("旧笔记");
    expect(blocks.recordingInfoAppendix).toContain("- 时长：03:56");
  });

  it("续录会话：大纲附录保留旧大纲原文", () => {
    const blocks = buildPriorSessionBlocks(baseSession);
    expect(blocks.outlineAppendix).toContain("- AI视频工作流的标准化规范");
    expect(blocks.outlineAppendix).toContain("旧笔记");
  });

  it("续录会话：音频附录为每个旧音频产出嵌入与回听链接", () => {
    const blocks = buildPriorSessionBlocks(baseSession);
    expect(blocks.audioAppendix).toContain("![[qnalog-20260917-115635.m4a]]");
    expect(blocks.audioAppendix).toContain("[[qnalog-20260917-115635.m4a|00:00]]");
  });

  it("只有部分旧材料时对应段为空、其余照常", () => {
    const blocks = buildPriorSessionBlocks({
      continuationSourcePath: "QnALog/转写纪要/x.md",
      continuationPriorAudioNames: [],
    });
    expect(blocks.audioAppendix).toBe("");
    expect(blocks.outlineAppendix).toBe("");
    expect(blocks.recordingInfoAppendix).toBe(""); // 无 recordedAt 且无 priorInfo
  });
});

// extractPriorOutline：从既有纪要读回实时大纲草稿，剥掉引导行。
describe("extractPriorOutline 旧大纲读回", () => {
  it("读回 details 内的大纲并剥掉引导行", () => {
    const md = [
      "<details>",
      "<summary>录音中实时大纲（草稿）</summary>",
      "",
      "> 基于录音过程中已完成的分段自动生成，正文纪要以最终整理为准。时间标记可用于快速回听对应片段。",
      "",
      "- 大纲条目一",
      "  - 子条目",
      "",
      "</details>",
    ].join("\n");
    expect(extractPriorOutline(md)).toBe("- 大纲条目一\n  - 子条目");
  });

  it("没有该 details 时返回空串", () => {
    expect(extractPriorOutline("# 笔记\n\n正文")).toBe("");
  });
});
