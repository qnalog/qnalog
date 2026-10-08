import { describe, expect, it, vi } from "vitest";
import { getActiveUiLanguage, matchUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
}));
import { assembleRealtimeOutlineDetails, buildPriorSessionBlocks } from "../src/notes/note-writer";
import { extractPriorOutline } from "../src/session/continuation-service";
import { extractDetailsBody, extractNotePanelData } from "../src/notes/detail-blocks";
import { stripArchivedOutlineSections } from "../src/notes/realtime-outline";
import { buildOutlineCoverageMetadata, readCurrentOutlineBlock } from "../src/notes/outline-storage";

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

describe("extractDetailsBody 原文范围读取", () => {
  it("取首个匹配块的正文，保留 CRLF 并 trim；匹配的空正文不跳到后项", () => {
    const markdown = "<DETAILS><SUMMARY><b>Wanted</b></SUMMARY>\r\n A\r\nB \r\n</DETAILS>";
    expect(extractDetailsBody(markdown, /Wanted/)).toBe("A\r\nB");
    expect(markdown).toContain("\r\n");
    expect(extractDetailsBody("<details><summary>Wanted</summary></details><details><summary>Wanted</summary>later</details>", /Wanted/)).toBe("");
  });

  it("保留平面首闭合标签匹配，不修复嵌套或未闭合标记", () => {
    expect(extractDetailsBody("<details><summary>Wanted</summary>outer<details><summary>Inner</summary>inner</details>tail</details>", /Wanted/))
      .toBe("outer<details><summary>Inner</summary>inner");
    expect(extractDetailsBody("<details><summary>Wanted</summary>open", /Wanted/)).toBe("");
    expect(extractDetailsBody("<details open><summary>Wanted</summary>body</details>", /Wanted/)).toBe("");
  });
});

describe("extractNotePanelData 面板可见的大纲与时间轴", () => {
  it("读取中英文实时大纲与 timeline 正文，同时排除引导行及旧归档", () => {
    const fixtures = [
      {
        summary: "录音中实时大纲（草稿）",
        intro: "> 基于录音过程中已完成的分段自动生成，正文纪要以最终整理为准。时间标记可用于快速回听对应片段。",
        timeline: "回听时间轴",
      },
      {
        summary: "Live outline while recording (draft)",
        intro: "> Outline generated from the segments completed while recording; the final minutes take precedence. The time markers let you jump back to the matching parts.",
        timeline: "Playback timeline",
      },
    ];
    for (const fixture of fixtures) {
      const markdown = [
        `<details><summary>${fixture.summary}</summary>`,
        fixture.intro,
        "- Live outline",
        "> 以下为追加录音前场次（旧笔记）的实时大纲草稿。",
        "- Archived outline",
        "</details>",
        `<details><summary>${fixture.timeline}</summary>`,
        "00:00–00:05 [[audio.webm#t=0,5]]",
        "</details>",
        "<!-- qnalog-session:test -->",
      ].join("\n");
      const data = extractNotePanelData(null, null, markdown);
      expect(data?.outline).toBe("- Live outline");
      expect(data?.timeline).toBe("00:00–00:05 [[audio.webm#t=0,5]]");
      expect(extractPriorOutline(markdown)).toBe("- Live outline");
    }
  });
});
  it("reads the last current outline in append layout and never falls back through an empty latest block", () => {
    const block = (text: string) => [
      "<details>",
      "<summary>Live outline while recording (draft)</summary>",
      "> Outline generated from the segments completed while recording; the final minutes take precedence.",
      text,
      "</details>",
    ].join("\n");
    const old = block("- Old session outline");
    const latest = block("- Whole-note outline");
    const appended = `${old}\n\n${latest}\n\n<!-- qnalog-session:test -->`;
    expect(extractPriorOutline(appended)).toBe("- Whole-note outline");
    expect(extractNotePanelData(null, null, appended)?.outline).toBe("- Whole-note outline");

    const emptyLatest = `${old}\n\n${block("")}\n\n<!-- qnalog-session:test -->`;
    expect(extractPriorOutline(emptyLatest)).toBe("");
    expect(extractNotePanelData(null, null, emptyLatest)?.outline).toBe("");
  });

  it("does not leak coverage metadata or archived outline text into the current seed", () => {
    const proof = {
      version: 1 as const,
      outlineHash: "outline-hash",
      sourceHash: "source-hash",
      committedSegmentCount: 4,
      totalSegmentCount: 8,
    };
    const markdown = [
      "<details>",
      "<summary>录音中实时大纲（草稿）</summary>",
      "> 基于录音过程中已完成的分段自动生成，正文纪要以最终整理为准。",
      "- Current outline",
      buildOutlineCoverageMetadata(proof),
      "> 以下为追加录音前场次（旧笔记）的实时大纲草稿。",
      "- Archived outline",
      "</details>",
    ].join("\n");
    expect(readCurrentOutlineBlock(markdown)?.sourceCoverage).toEqual(proof);
    expect(extractPriorOutline(markdown)).toBe("- Current outline");
  });


// 追加大纲翻倍回归：种子/读回若把归档副本一并带回，rewriteConsolidated 就执行
// 「新体 = 旧体 + 横幅 + 旧体」——实测备份链 1→2→4→8 份、横幅 0→1→3→7 条（2^k−1）。
describe("实时大纲归档去重（防追加翻倍）", () => {
  const BANNER = "> 以下为追加录音前场次（旧笔记）的实时大纲草稿。";
  const LIVE = "- 浮窗外观优化\n  - 要点一";
  const liveBlock = (body: string) =>
    [
      "<details>",
      "<summary>录音中实时大纲（草稿）</summary>",
      "",
      "> 基于录音过程中已完成的分段自动生成，正文纪要以最终整理为准。时间标记可用于快速回听对应片段。",
      "",
      body,
      "",
      "</details>",
    ].join("\n");
  const corruptedDetails = liveBlock([LIVE, BANNER, LIVE, BANNER, LIVE].join("\n\n"));
  const appendixOf = (prior: string) => `\n${BANNER}\n\n${prior}\n`;

  it("stripArchivedOutlineSections：无横幅原样返回", () => {
    expect(stripArchivedOutlineSections(LIVE)).toBe(LIVE);
  });

  it("stripArchivedOutlineSections：从第一条横幅截断，只留实时部分", () => {
    const body = [LIVE, BANNER, LIVE, BANNER, LIVE].join("\n\n");
    expect(stripArchivedOutlineSections(body)).toBe(LIVE);
  });

  it("extractPriorOutline：读回时连归档一起剥掉（种子与附录只带实时部分）", () => {
    expect(extractPriorOutline(corruptedDetails)).toBe(LIVE);
  });

  it("assemble：实时已包含旧大纲（种子场景）→ 跳过 appendix，不翻倍", () => {
    const out = assembleRealtimeOutlineDetails({
      liveBlock: liveBlock(LIVE),
      liveText: LIVE,
      priorText: LIVE,
      appendix: appendixOf(LIVE),
    });
    expect(out).toBe(liveBlock(LIVE));
    expect(out).not.toContain(BANNER);
    expect(out.split(LIVE).length - 1).toBe(1);
  });

  it("assemble：空白差异不影响包含判定（渲染往返容忍）", () => {
    const out = assembleRealtimeOutlineDetails({
      liveBlock: liveBlock(LIVE),
      liveText: LIVE,
      priorText: LIVE.replace(/\n/g, "\n\n"),
      appendix: appendixOf(LIVE),
    });
    expect(out).not.toContain(BANNER);
  });

  it("assemble：大纲分叉 → 挂一条带标签的归档，历史可查且只有一条", () => {
    const fresh = "- 追加场次的新话题";
    const out = assembleRealtimeOutlineDetails({
      liveBlock: liveBlock(fresh),
      liveText: fresh,
      priorText: LIVE,
      appendix: appendixOf(LIVE),
    });
    expect(out).toContain(BANNER);
    expect(out).toContain(LIVE);
    expect(out).toContain(fresh);
    expect(out.split(BANNER).length - 1).toBe(1);
  });

  it("assemble：本场次没有实时大纲 → 单独用归档建块（summary 与横幅齐全）", () => {
    // summary/引导句随界面语言（labelText）：本断言锁 zh 写出的中文标签。
    const original = getActiveUiLanguage();
    setActiveUiLanguage(matchUiLanguage("zh") as never);
    try {
      const out = assembleRealtimeOutlineDetails({
        liveBlock: "",
        liveText: "",
        priorText: LIVE,
        appendix: appendixOf(LIVE),
      });
      expect(out).toContain("<summary>录音中实时大纲（草稿）</summary>");
      expect(out).toContain("> 基于录音过程中已完成的分段自动生成，正文纪要以最终整理为准。时间标记可用于快速回听对应片段。");
      expect(out).toContain(BANNER);
      expect(out).toContain(LIVE);
    } finally {
      setActiveUiLanguage(original);
    }
  });

  it("assemble（英文界面）：summary 与引导句写英文，归档同样齐全", () => {
    const original = getActiveUiLanguage();
    setActiveUiLanguage(matchUiLanguage("en") as never);
    try {
      const out = assembleRealtimeOutlineDetails({
        liveBlock: "",
        liveText: "",
        priorText: LIVE,
        appendix: appendixOf(LIVE),
      });
      expect(out).toContain("<summary>Live outline while recording (draft)</summary>");
      expect(out).toContain("> Outline generated from the segments completed while recording; the final minutes take precedence. The time markers let you jump back to the matching parts.");
      expect(out).not.toContain("录音中实时大纲");
      expect(out).toContain(BANNER);
      expect(out).toContain(LIVE);
      // 双语读回：英文 summary 的 details 仍能被 extractPriorOutline 认出，
      // 剥掉英文引导句；横幅之后的归档不回流，横幅前的实时部分原样读回。
      expect(extractPriorOutline(out)).toBe("");
      const withLive = out.replace(BANNER, `${LIVE}\n\n${BANNER}`);
      expect(extractPriorOutline(withLive)).toBe(LIVE);
    } finally {
      setActiveUiLanguage(original);
    }
  });

  it("两轮重写模拟：产出→读回→再重写，份数不增长（直接锁死翻倍回归）", () => {
    const first = assembleRealtimeOutlineDetails({
      liveBlock: liveBlock(LIVE),
      liveText: LIVE,
      priorText: LIVE,
      appendix: appendixOf(LIVE),
    });
    const prior2 = extractPriorOutline(first);
    const second = assembleRealtimeOutlineDetails({
      liveBlock: liveBlock(prior2),
      liveText: prior2,
      priorText: prior2,
      appendix: appendixOf(prior2),
    });
    expect(prior2).toBe(LIVE);
    expect(second.split(LIVE).length - 1).toBe(1);
    expect(second.split(BANNER).length - 1).toBe(0);
  });

  it("extractNotePanelData：面板只显实时部分（现有坏笔记无需重写即干净）", () => {
    const md = "---\nmode: monologue\n---\n\n# 标题\n\n" + corruptedDetails + "\n\n<!-- qnalog-session:test -->\n";
    const data = extractNotePanelData(null, null, md);
    expect(data).not.toBeNull();
    expect(data!.outline).toBe(LIVE);
    expect(data!.outline).not.toContain(BANNER);
  });
});
describe("实时大纲归档逐字写入", () => {
  it("把美元字符和 Unicode 附录当作原文追加", () => {
    const appendix = "\n> 旧稿：多行中文\n$&\n$` 与下划线\n$'\n$$\n";
    expect(assembleRealtimeOutlineDetails({
      liveBlock: "<details>\nLIVE\n</details>",
      liveText: "LIVE",
      priorText: "PRIOR",
      appendix,
    })).toBe(`<details>\nLIVE\n${appendix}</details>`);
  });
});
