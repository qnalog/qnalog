// 实时大纲纯函数层的回归测试。每个 describe 对应一个曾经真实发生过的 bug，
// 防止"改一处正则默默打穿另一个 case"。运行：npm test
import { describe, it, expect } from "vitest";
import {
  normalizeRealtimeOutlineList,
  normalizeRecruitRealtimeOutline,
  parseRecruitRealtimeOutlineProtocol,
  buildRecruitRealtimeOutlineFallback,
  buildRecruitRealtimeOutlineMemory,
  normalizeOutlineMarkdownForDisplay,
  validateRealtimeOutlineMarkdown,
  parseRealtimeOutlineStateFromMarkdown,
  selectIncrementalRealtimeOutlineSegments,
  repairRealtimeOutlineAnchors,
  mergeStableRealtimeOutlineNodes,
  advanceRealtimeOutlineCursor,
  cleanRealtimeOutlineItemText,
  makeRealtimeOutlineNode,
  mergeCoverageNoRegress,
  deriveFollowupCards,
  realtimeOutlineDedupKey,
  mergeOutlineChildrenMonotonic,
  findLowEvidenceEntities,
  extractMarkdownSection,
  serializeRequiredQualities,
  desensitizeResumeText,
  sanitizeProjectFolderName,
  hexToHue,
  reportHueDelta,
  recolorReportHtml,
  REPORT_BASE_ACCENT_HEX,
} from "../src/outline-text";

const countSubPoints = (md: string) => md.split("\n").filter((l) => /^ {2,}[-*+]\s/.test(l)).length;
const countTopBullets = (md: string) => md.split("\n").filter((l) => /^ {0,1}[-*+]\s/.test(l)).length;

describe("normalizeOutlineMarkdownForDisplay —— {0,3}→{0,1} 子要点误杀回归", () => {
  it("保留 2 空格缩进的子要点（曾因 {0,3} 把子要点当无锚点顶层丢掉 = 大纲只剩一级）", () => {
    const input = [
      "- [[rec.m4a|22:09]] 建模类比",
      "  - 目标指标类似股票评估",
      "  - 用多因子打分",
      "- [[rec.m4a|23:09]] 结构化数据优先导出",
      "  - 先导结构化字段",
    ].join("\n");
    const out = normalizeOutlineMarkdownForDisplay(input);
    expect(countSubPoints(out)).toBe(3);
    expect(out).toContain("目标指标类似股票评估");
  });
  it("仍丢弃真正的无锚点顶层总览行（课程结构泄露）", () => {
    const input = ["- 课程总览：四个部分", "- [[rec.m4a|01:00]] 主题A", "  - 子要点"].join("\n");
    const out = normalizeOutlineMarkdownForDisplay(input);
    expect(out).not.toContain("课程总览");
    expect(out).toContain("主题A");
    expect(countSubPoints(out)).toBe(1);
  });
  it("无时间锚点的大纲原样返回（非时间轴模式不乱拆）", () => {
    const input = "- 普通条目A\n- 普通条目B";
    expect(normalizeOutlineMarkdownForDisplay(input)).toBe(input);
  });
});

describe("validateRealtimeOutlineMarkdown —— 富大纲不被误杀", () => {
  it("3 个 L1 + 多个子要点 通过（曾因把子要点算成顶层而判 too_many/too_many_untimed）", () => {
    const md = [
      "- [[r|01:00]] A",
      "  - a1",
      "  - a2",
      "- [[r|02:00]] B",
      "  - b1",
      "- [[r|03:00]] C",
      "  - c1",
    ].join("\n");
    expect(validateRealtimeOutlineMarkdown(md, { previousOutline: "- [[r|00:30]] 旧" }).ok).toBe(true);
  });
  it("顶层 >10 判 too_many_top_level_bullets", () => {
    const md = Array.from({ length: 11 }, (_, i) => `- [[r|0${i}:00]] T${i}`).join("\n");
    expect(validateRealtimeOutlineMarkdown(md).reason).toBe("too_many_top_level_bullets");
  });
  it("增量响应按本轮节点计数，不再减去历史节点数", () => {
    const previous = Array.from({ length: 12 }, (_, i) => `- [[r|${i}:00]] 旧${i}`).join("\n");
    const delta = Array.from({ length: 7 }, (_, i) => `- 新${i}`).join("\n");
    expect(validateRealtimeOutlineMarkdown(delta, {
      previousOutline: previous,
      allowUntimedTopLevel: true,
      deltaOnly: true,
      maxNewTopLevel: 6,
    }).reason).toBe("too_many_top_level_bullets");
  });
  it("有历史锚点但本轮全丢锚点 → lost_all_time_anchors", () => {
    expect(
      validateRealtimeOutlineMarkdown("- 无锚点A\n- 无锚点B", { previousOutline: "- [[r|00:30]] 旧" }).reason
    ).toBe("lost_all_time_anchors");
  });
  it("空大纲 + 有历史 → empty_outline；空大纲 + 无历史 → ok", () => {
    expect(validateRealtimeOutlineMarkdown("", { previousOutline: "- [[r|0:30]] 旧" }).reason).toBe("empty_outline");
    expect(validateRealtimeOutlineMarkdown("").ok).toBe(true);
  });
});

describe("selectIncrementalRealtimeOutlineSegments —— 已提交游标与 backlog 顺序", () => {
  const segment = (index: number, text = `段落${index}`) => ({ index, text });

  it("窗口封顶时从最早未提交段开始，不从尾部截断，也只提交本轮实际覆盖的段", () => {
    const source = Array.from({ length: 15 }, (_, index) => segment(index));
    const selected = selectIncrementalRealtimeOutlineSegments(source, {
      sinceCount: 3,
      lookbackSegments: 1,
      maxSegments: 4,
      maxChars: 6000,
    });
    expect(selected.segments.map((item: any) => item.index)).toEqual([2, 3, 4, 5]);
    expect(selected.newSegments.map((item: any) => item.index)).toEqual([3, 4, 5]);
    expect(selected.commitThroughCount).toBe(6);
    expect(selected.hasRemainingText).toBe(true);
  });

  it("游标按原始 segments 下标计算，空段不会造成 valid 数组错位", () => {
    const source = [segment(0, "已有"), segment(1, ""), segment(2, "新增")];
    const selected = selectIncrementalRealtimeOutlineSegments(source, {
      sinceCount: 1,
      maxSegments: 10,
      maxChars: 6000,
    });
    expect(selected.newSegments.map((item: any) => item.index)).toEqual([2]);
    expect(selected.commitThroughCount).toBe(3);
  });

  it("尾部只有空段时无需调用 LLM，也可安全确认到末尾", () => {
    const selected = selectIncrementalRealtimeOutlineSegments(
      [segment(0, "已有"), segment(1, ""), segment(2, "")],
      { sinceCount: 1, maxSegments: 10, maxChars: 6000 }
    );
    expect(selected.newUsedCount).toBe(0);
    expect(selected.commitThroughCount).toBe(3);
  });
});

describe("招聘实时大纲 —— 非标准问答恢复与游标兜底", () => {
  it("逐行协议不依赖 XML、Markdown 层级、图标或记忆字段", () => {
    const parsed = parseRecruitRealtimeOutlineProtocol([
      "主题：跨境项目经验",
      "问题：请介绍一次跨境劳动争议项目",
      "回答：候选人负责证据整理和外部律师协同",
      "评价：有项目参与证据，但独立决策程度尚不明确",
      "追问：哪一个关键决定由你本人作出？",
    ].join("\n"));
    expect(parsed.protocolMatched).toBe(true);
    expect(parsed.memory).toBe("");
    expect(parsed.outline).toContain("- 跨境项目经验");
    expect(parsed.outline).toContain("  - ❓ 请介绍一次跨境劳动争议项目");
    expect(parsed.outline).toContain("  - 💬 候选人负责证据整理和外部律师协同");
  });

  it("仍能读取旧版记忆字段，但只作为兼容数据返回", () => {
    const parsed = parseRecruitRealtimeOutlineProtocol([
      "记忆：旧版模型生成的摘要",
      "主题：岗位动机",
      "回答：希望更贴近业务",
    ].join("\n"));
    expect(parsed.memory).toBe("旧版模型生成的摘要");
    expect(parsed.outline).toContain("- 岗位动机");
  });

  it("响应中途截断时保留已经完成的逐行记录", () => {
    const parsed = parseRecruitRealtimeOutlineProtocol([
      "T: 团队管理",
      "Q: 如何处理低绩效成员？",
      "A: 候选人先明确目标并安排阶段复盘",
      "E:",
    ].join("\n"));
    expect(parsed.protocolMatched).toBe(true);
    expect(parsed.outline).toContain("- 团队管理");
    expect(parsed.outline).toContain("  - 💬 候选人先明确目标并安排阶段复盘");
    expect(parseRealtimeOutlineStateFromMarkdown(parsed.outline)).toHaveLength(1);
  });

  it("把标题和标签段落恢复为稳定的两级列表", () => {
    const raw = [
      "<lexvoice-memory>候选人有跨境法务经历</lexvoice-memory>",
      "<lexvoice-outline>",
      "### 面试主题：岗位动机与迁移",
      "问题：为什么从集团岗位转向本岗位？",
      "候选人回答：希望回到更贴近业务的一线岗位。",
      "AI 评价：动机基本清楚，但稳定性证据不足。",
      "建议追问：未来三年的职业计划是什么？",
      "</lexvoice-outline>",
    ].join("\n");
    const outline = normalizeRecruitRealtimeOutline(raw);
    expect(outline).toContain("- 岗位动机与迁移");
    expect(outline).toContain("  - ❓ 为什么从集团岗位转向本岗位？");
    expect(outline).toContain("  - 💬 希望回到更贴近业务的一线岗位。");
    expect(outline).toContain("  - 🤖 动机基本清楚，但稳定性证据不足。");
    expect(outline).toContain("  - ⛏ 未来三年的职业计划是什么？");
    expect(parseRealtimeOutlineStateFromMarkdown(outline)).toHaveLength(1);
  });

  it("不把没有结构信号的解释性前言误当大纲", () => {
    expect(normalizeRecruitRealtimeOutline(
      "下面是我对这场面试的分析。由于信息不足，我暂时无法生成结构化大纲。"
    )).toBe("");
  });

  it("模型持续输出坏格式时，用本批原始转写生成可提交的待复核节点", () => {
    const segments = Array.from({ length: 8 }, (_, offset) => ({
      index: offset + 7,
      text: offset === 0
        ? "候选人介绍了海外劳动争议项目，并说明自己负责证据整理和外部律师协同。"
        : `面试问答原文 ${offset + 2}`,
    }));
    const fallback = buildRecruitRealtimeOutlineFallback(segments);
    const repaired = repairRealtimeOutlineAnchors(fallback, {
      anchorSources: segments.map((segment, offset) => ({
        anchor: `[[interview.webm|${String(21 + offset * 3).padStart(2, "0")}:00]]`,
        index: segment.index,
      })),
    });
    expect(countTopBullets(fallback)).toBeLessThanOrEqual(6);
    expect(fallback).toContain("面试片段 14-15（待复核）");
    expect(repaired.outline).toContain("💬 候选人介绍了海外劳动争议项目");
    expect(repaired.outline).toContain("💬 面试问答原文 8");
    expect(validateRealtimeOutlineMarkdown(repaired.outline, {
      allowUntimedTopLevel: true,
      deltaOnly: true,
      maxNewTopLevel: 6,
    }).ok).toBe(true);
  });
});

describe("buildRecruitRealtimeOutlineMemory —— 招聘记忆由已提交大纲确定性维护", () => {
  const nodes = parseRealtimeOutlineStateFromMarkdown([
    "- [[interview.webm|00:10]] 岗位动机",
    "  - ❓ 为什么考虑这个岗位？",
    "  - 💬 希望回到更贴近业务的一线岗位",
    "  - 🤖 动机基本清楚，但稳定性证据不足",
    "  - ⛏ 未来三年的职业计划是什么？",
    "- [[interview.webm|03:00]] 团队管理",
    "  - 💬 会先明确目标并安排阶段复盘",
    "  - 🤖 有管理动作，结果指标尚未说明",
  ].join("\n"));

  it("只从提交节点提取主题、回答、判断和待追问，不带时间锚点", () => {
    const memory = buildRecruitRealtimeOutlineMemory(nodes);
    expect(memory).toContain("岗位动机");
    expect(memory).toContain("答：希望回到更贴近业务的一线岗位");
    expect(memory).toContain("判：动机基本清楚，但稳定性证据不足");
    expect(memory).toContain("待问：未来三年的职业计划是什么？");
    expect(memory).toContain("团队管理");
    expect(memory).not.toContain("interview.webm");
    expect(memory).not.toContain("[[");
  });

  it("相同已提交状态得到完全相同的记忆，并严格受长度上限约束", () => {
    const first = buildRecruitRealtimeOutlineMemory(nodes, { maxChars: 180 });
    const second = buildRecruitRealtimeOutlineMemory(nodes, { maxChars: 180 });
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(180);
  });

  it("长会把较早主题压成索引，把最近主题保留为证据摘要", () => {
    const longNodes = Array.from({ length: 10 }, (_, index) => ({
      title: `主题${index + 1}`,
      children: [
        `💬 回答${index + 1}`,
        `🤖 判断${index + 1}`,
        `⛏ 追问${index + 1}`,
      ],
    }));
    const memory = buildRecruitRealtimeOutlineMemory(longNodes, {
      maxChars: 260,
      recentDetailCount: 3,
    });
    expect(memory).toContain("较早已讨论");
    expect(memory).toContain("主题1");
    expect(memory).toContain("主题10");
    expect(memory).toContain("答：回答10");
    expect(memory.length).toBeLessThanOrEqual(260);
  });
});

describe("repairRealtimeOutlineAnchors —— LLM 漏时间链接的确定性修复", () => {
  it("同名旧主题恢复历史锚点，新主题按新增转写顺序补锚点", () => {
    const previous = "- [[rec.webm|00:10]] 旧主题\n  - 旧证据";
    const fresh = "- 旧主题\n  - 新补充\n- 新主题\n  - 新证据";
    const repaired = repairRealtimeOutlineAnchors(fresh, {
      previousOutline: previous,
      anchorSources: [{ anchor: "[[rec.webm|03:00]]", index: 3 }],
    });
    expect(repaired.outline).toContain("- [[rec.webm|00:10]] 旧主题");
    expect(repaired.outline).toContain("- [[rec.webm|03:00]] 新主题");
    expect(repaired.restoredCount).toBe(1);
    expect(repaired.unresolvedCount).toBe(0);
    expect(validateRealtimeOutlineMarkdown(repaired.outline, { previousOutline: previous }).ok).toBe(true);
  });

  it("首轮全漏锚点时，可由本轮转写锚点恢复为合法时间轴", () => {
    const repaired = repairRealtimeOutlineAnchors("- 主题甲\n- 主题乙", {
      anchorSources: [
        { anchor: "[[rec.webm|01:00]]", index: 1 },
        { anchor: "[[rec.webm|02:00]]", index: 2 },
      ],
    });
    expect(repaired.repairedCount).toBe(2);
    expect(repaired.unresolvedCount).toBe(0);
    expect(validateRealtimeOutlineMarkdown(repaired.outline).ok).toBe(true);
  });

  it("没有可用转写锚点时保持未解决状态，交给上层判废而不是伪造时间", () => {
    const repaired = repairRealtimeOutlineAnchors("- 新主题", { anchorSources: [] });
    expect(repaired.repairedCount).toBe(0);
    expect(repaired.unresolvedCount).toBe(1);
    expect(repaired.outline).toBe("- 新主题");
  });

  it("不信任模型时间：旧主题恢复历史锚点，新主题替换为真实分段锚点", () => {
    const previous = "- [[rec.webm|00:10]] 旧主题\n  - 旧证据";
    const fresh = "- [[fake.webm|99:99]] 旧主题\n- [[fake.webm|88:88]] 新主题";
    const repaired = repairRealtimeOutlineAnchors(fresh, {
      previousOutline: previous,
      anchorSources: [{ anchor: "[[rec.webm|03:00]]", index: 3 }],
    });
    expect(repaired.outline).toContain("- [[rec.webm|00:10]] 旧主题");
    expect(repaired.outline).toContain("- [[rec.webm|03:00]] 新主题");
    expect(repaired.outline).not.toContain("fake.webm");
    expect(repaired.replacedCount).toBe(2);
  });

  it("多个新主题按真实候选位置单调分布，不采用模型重复时间", () => {
    const fresh = ["甲", "乙", "丙", "丁"]
      .map((title) => `- [[fake.webm|09:09]] ${title}`)
      .join("\n");
    const repaired = repairRealtimeOutlineAnchors(fresh, {
      anchorSources: [
        { anchor: "[[rec.webm|01:00]]", index: 1 },
        { anchor: "[[rec.webm|01:30]]", index: 2 },
        { anchor: "[[rec.webm|02:00]]", index: 3 },
        { anchor: "[[rec.webm|02:30]]", index: 4 },
      ],
    });
    const nodes = parseRealtimeOutlineStateFromMarkdown(repaired.outline);
    expect(nodes.map((node) => node.time)).toEqual(["01:00", "01:30", "02:00", "02:30"]);
    expect(new Set(nodes.map((node) => node.anchor)).size).toBe(4);
  });

  it("主题多于真实分段时允许共享区间起点，不伪造额外秒数", () => {
    const repaired = repairRealtimeOutlineAnchors("- 甲\n- 乙\n- 丙\n- 丁", {
      anchorSources: [
        { anchor: "[[rec.webm|00:00]]", index: 0 },
        { anchor: "[[rec.webm|03:00]]", index: 1 },
      ],
    });
    const nodes = parseRealtimeOutlineStateFromMarkdown(repaired.outline);
    expect(nodes.map((node) => node.time)).toEqual(["00:00", "00:00", "03:00", "03:00"]);
  });

  it("没有真实来源时移除模型伪造时间，但结构仍可按宽松模式验收", () => {
    const repaired = repairRealtimeOutlineAnchors("- [[fake.webm|09:09]] 新主题", { anchorSources: [] });
    expect(repaired.outline).toBe("- 新主题");
    expect(repaired.unresolvedCount).toBe(1);
    expect(validateRealtimeOutlineMarkdown(repaired.outline, {
      previousOutline: "- [[rec.webm|00:10]] 旧主题",
      allowUntimedTopLevel: true,
    }).ok).toBe(true);
  });
});

describe("normalizeRealtimeOutlineList —— 连排拆行 + 全 Unicode 破折号 + 锚点硬切", () => {
  const dashCases: Array<[string, string]> = [
    ["ASCII -", "-"],
    ["hyphen ‐ U+2010", "‐"],
    ["nb-hyphen ‑ U+2011", "‑"],
    ["en – U+2013", "–"],
    ["em — U+2014", "—"],
    ["minus − U+2212", "−"],
  ];
  for (const [name, d] of dashCases) {
    it(`用 ${name} 当分隔符也能拆回层级`, () => {
      const line = `- [[rec.m4a|02:00]] 建模类比 ${d} 目标指标 ${d} 多因子打分 ${d} [[rec.m4a|03:00]] 结构化导出 ${d} 先导结构化`;
      const out = normalizeRealtimeOutlineList(line);
      expect(countSubPoints(out)).toBe(3); // 目标指标/多因子打分 挂A，先导结构化 挂B
      expect(countTopBullets(out)).toBe(2); // 两个带锚点的一级
    });
  }
  it("锚点之间完全没破折号也能靠锚点硬切成多个一级", () => {
    const line = "- [[r|01:00]] A标题 子内容 [[r|02:00]] B标题 [[r|03:00]] C标题";
    const out = normalizeRealtimeOutlineList(line);
    expect(countTopBullets(out)).toBe(3);
  });
  it("中文破折号 ——（无空格）不被误拆", () => {
    const line = "- [[r|01:00]] 这是一个例子——用于说明，不应被拆";
    expect(normalizeRealtimeOutlineList(line).split("\n").length).toBe(1);
  });
  it("规范多行输入原样保留（不破坏已正确的格式）", () => {
    const md = "- [[r|01:00]] A\n  - a1\n  - a2";
    expect(normalizeRealtimeOutlineList(md)).toBe(md);
  });
});

describe("mergeStableRealtimeOutlineNodes —— 历史冻结 + 末尾增量 + 抗抽风", () => {
  const node = (anchor: string, title: string, children: string[] = []) => ({ anchor, title, children });
  const titles = (ns: any[]) => ns.map((n) => `${n.title}[${n.children.length}]`).join("|");

  it("空历史 → 直接返回新节点", () => {
    const r = mergeStableRealtimeOutlineNodes([], [node("a1", "A"), node("a2", "B")]);
    expect(r.length).toBe(2);
  });
  it("历史冻结、末尾更新、新话题追加；模型抽风（乱改A/丢D）碰不到历史", () => {
    let state = mergeStableRealtimeOutlineNodes([], [node("a1", "A", ["a1"]), node("a2", "B"), node("a3", "C", ["c1"])]);
    state = mergeStableRealtimeOutlineNodes(state, [node("a3", "C", ["c1", "c2", "c3"]), node("a4", "D"), node("a5", "E")]);
    expect(titles(state)).toBe("A[1]|B[0]|C[3]|D[0]|E[0]"); // C(末尾)更新成3子, D/E新增, A/B冻结
    state = mergeStableRealtimeOutlineNodes(state, [node("a1", "A被乱改", ["x"]), node("a5", "E", ["e1"]), node("a6", "F")]);
    expect(state.find((n) => n.anchor === "a1").title).toBe("A"); // A 冻结，没被乱改
    expect(state.some((n) => n.anchor === "a4")).toBe(true); // D 没丢
    expect(state.some((n) => n.anchor === "a6")).toBe(true); // F 新增
  });
  it("重复输出老话题（同锚点）不产生重复", () => {
    const state = mergeStableRealtimeOutlineNodes(
      [node("a1", "A"), node("a2", "B")],
      [node("a1", "A"), node("a2", "B")]
    );
    expect(state.length).toBe(2);
  });
  it("同一时间区间的不同主题全部保留，时间不再充当唯一键", () => {
    const state = mergeStableRealtimeOutlineNodes(
      [node("a1", "主题甲")],
      [node("a1", "主题甲", ["补充"]), node("a1", "主题乙"), node("a1", "主题丙")]
    );
    expect(state.map((item) => item.title)).toEqual(["主题甲", "主题乙", "主题丙"]);
    expect(state[0].children).toEqual(["补充"]);
  });
  it("同区间多个历史主题按标题各自补充，不串写 children", () => {
    const state = mergeStableRealtimeOutlineNodes(
      [node("a1", "主题甲", ["甲旧"]), node("a1", "主题乙", ["乙旧"])],
      [node("a1", "主题甲", ["甲新"]), node("a1", "主题乙", ["乙新"])]
    );
    expect(state[0].children).toEqual(["甲旧", "甲新"]);
    expect(state[1].children).toEqual(["乙旧", "乙新"]);
  });
  it("历史达到 8 个节点后仍可继续追加，不把 8 当整场上限", () => {
    const history = Array.from({ length: 8 }, (_, i) => node(`a${i}`, `历史${i}`));
    const delta = Array.from({ length: 4 }, (_, i) => node(`b${i}`, `新增${i}`, [`要点${i}`]));
    const state = mergeStableRealtimeOutlineNodes(history, delta);
    expect(state).toHaveLength(12);
    expect(state.slice(-4).map((item) => item.title)).toEqual(["新增0", "新增1", "新增2", "新增3"]);
  });
  it("长会超过 60 个节点后仍保留最早内容并继续追加", () => {
    const history = Array.from({ length: 70 }, (_, i) => node(`a${i}`, `历史${i}`, [`证据${i}`]));
    const state = mergeStableRealtimeOutlineNodes(history, [node("a70", "新增70", ["证据70"])]);

    expect(state).toHaveLength(71);
    expect(state[0]).toEqual(node("a0", "历史0", ["证据0"]));
    expect(state.at(-1)).toEqual(node("a70", "新增70", ["证据70"]));
  });
  it("历史非末尾节点被新话题挤下后，后续同锚点轮仍能补子要点（单调、title 冻结）", () => {
    // A 在轮 k 只有 1 个子要点，随后 B 追加把 A 挤下末尾
    let state = mergeStableRealtimeOutlineNodes([], [node("a1", "A", ["a1"]), node("a2", "B")]);
    // 轮 k+1：fresh 给同锚点 A 带 2 个新子要点 —— A 已非末尾，但应能被补全
    state = mergeStableRealtimeOutlineNodes(state, [node("a1", "A被乱改", ["a1", "新点2", "新点3"]), node("a2", "B")]);
    const A = state.find((n) => n.anchor === "a1");
    expect(A.title).toBe("A");                 // title 冻结，没被乱改
    expect(A.children.length).toBe(3);          // 子要点从 1 补到 3（历史也能变厚）
    expect(A.children).toContain("新点2");
  });
  it("children 单调：fresh 漏给某子要点不删旧的", () => {
    let state = mergeStableRealtimeOutlineNodes([], [node("a1", "A", ["x1", "x2"]), node("a2", "B")]);
    state = mergeStableRealtimeOutlineNodes(state, [node("a1", "A", []), node("a2", "B")]); // fresh A 无子要点
    expect(state.find((n) => n.anchor === "a1").children).toEqual(["x1", "x2"]); // 旧子要点不丢
  });
  it("children 近义（仅标点/空白差异）不重复堆叠", () => {
    let state = mergeStableRealtimeOutlineNodes([], [node("a1", "A", ["商业化思路"]), node("a2", "B")]);
    state = mergeStableRealtimeOutlineNodes(state, [node("a1", "A", ["商业化，思路", "真新点"]), node("a2", "B")]);
    expect(state.find((n) => n.anchor === "a1").children.length).toBe(2); // 近义合一 + 真新点
  });
});

describe("招聘实时大纲持久状态 —— 全程覆盖与游标单调", () => {
  it("从 Markdown 恢复时不再丢弃 60 个节点以前的历史", () => {
    const markdown = Array.from({ length: 75 }, (_, i) => {
      const minute = String(i).padStart(2, "0");
      return `- [[recording.webm|${minute}:00]] 主题${i}\n  - 证据${i}`;
    }).join("\n");
    const nodes = parseRealtimeOutlineStateFromMarkdown(markdown);

    expect(nodes).toHaveLength(75);
    expect(nodes[0].title).toBe("主题0");
    expect(nodes.at(-1)?.title).toBe("主题74");
  });

  it("提交游标只前进不后退，并限制在实际分段总数内", () => {
    expect(advanceRealtimeOutlineCursor(20, 18, 50)).toBe(20);
    expect(advanceRealtimeOutlineCursor(20, 24, 50)).toBe(24);
    expect(advanceRealtimeOutlineCursor(48, 80, 50)).toBe(50);
    expect(advanceRealtimeOutlineCursor(-2, 3, 50)).toBe(3);
  });
});

describe("realtimeOutlineDedupKey —— 措辞微改归一（只折叠标点/空白/大小写，不归虚词）", () => {
  it("标点 / 空白 / 大小写差异 → 同键", () => {
    const k = realtimeOutlineDedupKey("商业化思路");
    expect(realtimeOutlineDedupKey("商业化，思路")).toBe(k);
    expect(realtimeOutlineDedupKey("商业化 思路")).toBe(k);
    expect(realtimeOutlineDedupKey("商业化思路。")).toBe(k);
  });
  it("真正不同的话题 → 不同键", () => {
    expect(realtimeOutlineDedupKey("预算")).not.toBe(realtimeOutlineDedupKey("排期"));
  });
  it("虚词差异不归一（避免误并）：商业化思路 ≠ 商业化的思路", () => {
    expect(realtimeOutlineDedupKey("商业化思路")).not.toBe(realtimeOutlineDedupKey("商业化的思路"));
  });
});

describe("mergeOutlineChildrenMonotonic —— 单调并集 + 去重 + 截断", () => {
  it("existing 在前、fresh 补尾、去重", () => {
    expect(mergeOutlineChildrenMonotonic(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });
  it("漏给不删旧的（单调）", () => {
    expect(mergeOutlineChildrenMonotonic(["a", "b"], [])).toEqual(["a", "b"]);
  });
  it("近义（标点差异）合一", () => {
    expect(mergeOutlineChildrenMonotonic(["商业化思路"], ["商业化，思路"]).length).toBe(1);
  });
  it("截断到 MAX_CHILDREN(5)", () => {
    expect(mergeOutlineChildrenMonotonic(["1", "2", "3", "4", "5"], ["6", "7"]).length).toBe(5);
  });
});

describe("normalizeOutlineMarkdownForDisplay attachUntimed —— 无锚点延续行挂靠 vs 丢弃", () => {
  const sub = (md: string) => md.split("\n").filter((l) => /^ {2,}[-*+]\s/.test(l)).length;
  it("attachUntimed=true：带锚点 L1 之后的无锚点顶层行 → 挂靠为子项（不丢）", () => {
    const input = "- [[r|01:00]] 主题A\n  - 子要点\n- 这是无锚点延续讨论";
    const out = normalizeOutlineMarkdownForDisplay(input, { attachUntimed: true });
    expect(sub(out)).toBe(2);                      // 原子要点 + 挂靠进来的延续行
    expect(out).toContain("这是无锚点延续讨论");
  });
  it("attachUntimed=false（默认，state 渲染那次）：带锚点之后的无锚点行仍丢，不改写历史", () => {
    const input = "- [[r|01:00]] 主题A\n  - 子要点\n- 这是无锚点延续讨论";
    const out = normalizeOutlineMarkdownForDisplay(input);
    expect(out).not.toContain("这是无锚点延续讨论");
  });
  it("attachUntimed=true 时，顶部（首个带锚点之前）的无锚点总览行仍丢弃", () => {
    const input = "- 课程总览：四个部分\n- [[r|01:00]] 主题A";
    const out = normalizeOutlineMarkdownForDisplay(input, { attachUntimed: true });
    expect(out).not.toContain("课程总览");
    expect(out).toContain("主题A");
  });
  it("P2+P3 协同：挂靠产生的子项经 parse→单调合并 后留存", () => {
    const md = normalizeOutlineMarkdownForDisplay("- [[r|01:00]] A\n- 延续讨论一", { attachUntimed: true });
    const nodes = parseRealtimeOutlineStateFromMarkdown(md);
    const state = mergeStableRealtimeOutlineNodes([], nodes);
    const A = state.find((n) => n.anchor === "[[r|01:00]]");
    expect(A).toBeTruthy();
    expect(A.children).toContain("延续讨论一");
  });
});

describe("parseRealtimeOutlineStateFromMarkdown + cleanRealtimeOutlineItemText", () => {
  it("解析 L1 + 子要点，锚点分离到 anchor 字段、标题去锚点", () => {
    const md = "- [[rec.m4a|12:34]] 标题甲\n  - 子要点1\n  - 子要点2\n- [[rec.m4a|13:00]] 标题乙\n  - 子要点3";
    const nodes = parseRealtimeOutlineStateFromMarkdown(md);
    expect(nodes.length).toBe(2);
    expect(nodes[0].anchor).toBe("[[rec.m4a|12:34]]");
    expect(nodes[0].title).toBe("标题甲");
    expect(nodes[0].time).toBe("12:34");
    expect(nodes[0].children).toEqual(["子要点1", "子要点2"]);
  });
  it("cleanRealtimeOutlineItemText 剥离锚点/列表符/编号", () => {
    expect(cleanRealtimeOutlineItemText("- 1. [[a|01:00]] 文字 内容")).toBe("文字 内容");
  });
  it("cleanRealtimeOutlineItemText 剥掉行尾未闭合的残缺锚点，不误伤完整锚点/文中方括号", () => {
    // 残缺锚点（模型截断/流式半写）：整条就是半个锚点 → 清空
    expect(cleanRealtimeOutlineItemText("[[lex-202")).toBe("");
    expect(cleanRealtimeOutlineItemText("- [[lex-2026...|53:02")).toBe("");
    // 正文尾部跟半个锚点 → 只剥残缺部分，保留正文
    expect(cleanRealtimeOutlineItemText("方向选择 [[lex-202")).toBe("方向选择");
    // 完整锚点照常被剥、正文保留（不因新规则误伤）
    expect(cleanRealtimeOutlineItemText("文字 [[a|01:00]]")).toBe("文字");
    // 正文里合法的成对方括号（有闭合）不动
    expect(cleanRealtimeOutlineItemText("引用 [[概念]] 说明")).toBe("引用 [[概念]] 说明");
  });
  it("makeRealtimeOutlineNode 对「只剩残缺锚点」的标题返回 null（丢弃乱码节点）", () => {
    expect(makeRealtimeOutlineNode("", "[[lex-202", [], 0)).toBeNull();
  });
  it("makeRealtimeOutlineNode 空标题返回 null，子要点上限截断", () => {
    expect(makeRealtimeOutlineNode("[[a|01:00]]", "", [], 0)).toBeNull();
    const n = makeRealtimeOutlineNode("[[a|01:00]]", "T", ["1", "2", "3", "4", "5", "6", "7"], 0);
    expect(n.children.length).toBeLessThanOrEqual(5);
  });
});

describe("mergeCoverageNoRegress —— recruit-needs 覆盖态单维不回退（长会尾窗截断防倒退）", () => {
  const dim = (status: string, anchor = "") => ({ status, evidence_anchor: anchor, missing_what: "" });
  const merge = (a: any, b: any): any => mergeCoverageNoRegress(a, b);
  it("本轮掉 missing 但 prev 有证据 → 保留 prev（防进度条倒退）", () => {
    const fresh = { years: dim("missing") };
    const prev = { years: dim("covered", "[[r|01:00]]") };
    expect(merge(fresh, prev).years.status).toBe("covered");
    expect(merge(fresh, prev).years.evidence_anchor).toBe("[[r|01:00]]");
  });
  it("prev 也是 missing（无证据）→ 用本轮 missing", () => {
    expect(merge({ x: dim("missing") }, { x: dim("missing") }).x.status).toBe("missing");
  });
  it("本轮升到 covered → 本轮赢（允许只增）", () => {
    expect(merge({ x: dim("covered", "[[r|02:00]]") }, { x: dim("missing") }).x.status).toBe("covered");
  });
  it("covered→partial（业务方改口澄清）允许，不被冻结", () => {
    expect(merge({ x: dim("partial") }, { x: dim("covered", "[[r|01:00]]") }).x.status).toBe("partial");
  });
  it("prev 非 missing 即单调冻结：即便无 evidence_anchor 也不退回 missing（根治字段树忽有忽无）", () => {
    expect(merge({ x: dim("missing") }, { x: dim("partial", "") }).x.status).toBe("partial");
    expect(merge({ x: dim("missing") }, { x: dim("covered", "") }).x.status).toBe("covered");
  });
  it("空 prev / 非对象入参不崩", () => {
    expect(merge({ x: dim("covered", "[[r|01:00]]") }, null).x.status).toBe("covered");
    expect(merge(null, null)).toEqual({});
  });
  it("freeze=false（早期轮）允许 covered/partial 退回 missing，让早期误判自我纠正", () => {
    const mergeF = (a: any, b: any, freeze: any): any => mergeCoverageNoRegress(a, b, freeze);
    expect(mergeF({ x: dim("missing") }, { x: dim("covered", "[[r|01:00]]") }, false).x.status).toBe("missing");
    expect(mergeF({ x: dim("missing") }, { x: dim("partial", "[[r|01:00]]") }, false).x.status).toBe("missing");
    // freeze 默认 true 时仍冻结（成熟轮防闪回）
    expect(merge({ x: dim("missing") }, { x: dim("covered", "[[r|01:00]]") }).x.status).toBe("covered");
  });
});

describe("deriveFollowupCards —— Phase3 追问卡：派生/排序/去重/反馈压制/节奏控制", () => {
  // 模拟 14 维里取一小撮做规则与维度序
  const dimOrder = [
    { key: "years", name: "年限", group: "hard" },
    { key: "salary", name: "期望薪酬", group: "hard" },
    { key: "resilience", name: "抗挫折", group: "soft" },
    { key: "dept_style", name: "部门风格", group: "culture" },
  ];
  const rules = {
    years: { fallback: "几年起步？", priority: 5 },
    salary: { fallback: "薪资区间？", priority: 5 },
    resilience: { fallback: "举个抗压例子？", priority: 4 },
    dept_style: { fallback: "团队什么风格？", priority: 2 },
  };
  const cell = (status, extra = {}) => Object.assign({ status, evidence_anchor: "", missing_what: "", followup_question: "", vague_hits: [] }, extra);
  const derive = (dims: any, opts: any = {}) => deriveFollowupCards(dims, Object.assign({ rules, dimOrder, maxCards: 10 }, opts));

  it("covered 维不产卡；missing/partial 产卡", () => {
    const cards = derive({ years: cell("covered"), salary: cell("missing"), resilience: cell("partial"), dept_style: cell("covered") });
    expect(cards.map((c) => c.key)).toEqual(["salary", "resilience"]);
  });
  it("排序：priority 降序 → missing 先于 partial → dimOrder 原序（vague_hits 不影响排序）", () => {
    const cards = derive({
      years: cell("partial"),                       // prio5 partial
      salary: cell("missing"),                      // prio5 missing → 同 prio 下排 years 前
      resilience: cell("missing", { vague_hits: ["挺好的", "差不多"] }), // prio4，即便有模糊词也排在 prio5 之后
      dept_style: cell("missing"),                  // prio2 最后
    });
    expect(cards.map((c) => c.key)).toEqual(["salary", "years", "resilience", "dept_style"]);
  });
  it("K 截断：maxCards 限制同时显示张数", () => {
    const cards = derive(
      { years: cell("missing"), salary: cell("missing"), resilience: cell("missing"), dept_style: cell("missing") },
      { maxCards: 2 }
    );
    expect(cards.length).toBe(2);
    expect(cards.map((c) => c.key)).toEqual(["years", "salary"]); // 两张 prio5 先出
  });
  it("反馈压制：suppressed 里的维（已问/忽略）本场不再产卡", () => {
    const cards = derive(
      { years: cell("missing"), salary: cell("missing"), resilience: cell("missing") },
      { suppressed: new Set(["years"]) }
    );
    expect(cards.map((c) => c.key)).toEqual(["salary", "resilience"]);
  });
  it("question 回落：模型给了 followup_question 用模型的，空则用 rules.fallback", () => {
    const cards = derive({
      years: cell("missing", { followup_question: "贵司这岗位卡几年？" }),
      salary: cell("missing"),
    });
    expect(cards.find((c) => c.key === "years").question).toBe("贵司这岗位卡几年？");
    expect(cards.find((c) => c.key === "salary").question).toBe("薪资区间？");
  });
  it("reason：missing_what 优先，否则用命中模糊词，否则按状态给默认语", () => {
    const cards = derive({
      years: cell("partial", { missing_what: "只说要资深没给年限" }),
      salary: cell("partial", { vague_hits: ["差不多"] }),
      resilience: cell("missing"),
    });
    expect(cards.find((c) => c.key === "years").reason).toBe("只说要资深没给年限");
    expect(cards.find((c) => c.key === "salary").reason).toContain("差不多");
    expect(cards.find((c) => c.key === "resilience").reason).toBe("尚未谈到");
  });
  it("非对象入参 / 空维度不崩", () => {
    expect(deriveFollowupCards(null, { rules, dimOrder })).toEqual([]);
    expect(deriveFollowupCards({}, {})).toEqual([]);
  });
});

// 回归场景：岗位画像曾把全场只零星出现的某称呼指认为一号位并贯穿全文（凭空的实体-角色绑定，此处用占位名复现）。
// 本探测找"产出高频引用 vs 转写低频出现"的倒挂实体作软提示。
describe("findLowEvidenceEntities（人物指认幻觉机械探测）", () => {
  const transcript = "今天聊聊团队。张三上次说过授权的事。后来又提到张三。李四今天也在，李四说李四的事，李四又说，李四补充，李四最后总结。";
  it("产出高频引用、转写低频出现的实体被标记", () => {
    const output = "一号位（张三）的风格如何。张三期待抓手。张三希望有人疏通。嵌入张三团队。<!-- lexvoice-people: 张三, 李四 -->";
    const findings = findLowEvidenceEntities(["张三", "李四"], output, transcript);
    expect(findings.length).toBe(1);
    expect(findings[0].name).toBe("张三");
    expect(findings[0].outputCount).toBeGreaterThanOrEqual(3);
    expect(findings[0].transcriptCount).toBe(2);
  });
  it("转写中证据充分的实体不报（李四 6 次）", () => {
    const output = "李四的问题。李四没结果。李四敏感。李四销声匿迹。<!-- lexvoice-people: 李四 -->";
    expect(findLowEvidenceEntities(["李四"], output, transcript)).toEqual([]);
  });
  it("产出引用不足 3 次不报（偶尔提一句不算核心锚点）", () => {
    const output = "提到过张三一次。<!-- lexvoice-people: 张三 -->";
    expect(findLowEvidenceEntities(["张三"], output, transcript)).toEqual([]);
  });
  it("产出与转写次数持平（不倒挂）不报", () => {
    const out2 = "张三甲。张三乙。"; // 2 次，转写也 2 次
    expect(findLowEvidenceEntities(["张三"], out2, transcript, { minOutputMentions: 2 })).toEqual([]);
  });
  it("单字名与空名跳过（子串误命中率太高）", () => {
    const output = "扣扣扣扣扣扣。<!-- lexvoice-people: 扣 -->";
    expect(findLowEvidenceEntities(["扣", "", "  "], output, "无")).toEqual([]);
  });
  it("重复名只算一次；空输入不崩", () => {
    expect(findLowEvidenceEntities(["张三", "张三"], "张三张三张三张三", "")).toHaveLength(1);
    expect(findLowEvidenceEntities([], "", "")).toEqual([]);
    expect(findLowEvidenceEntities(null as any, null as any, null as any)).toEqual([]);
  });
});

describe("extractMarkdownSection —— JD 章节抽取", () => {
  const jd = [
    "---", "职位名: x", "---", "",
    "## 岗位描述", "负责海外发行。", "要求3年经验。", "",
    "## 统一面试提纲", "（空）",
  ].join("\n");
  it("抽到下一个同级标题为止", () => {
    expect(extractMarkdownSection(jd, "## 岗位描述")).toBe("负责海外发行。\n要求3年经验。");
  });
  it("抽到文件尾", () => {
    expect(extractMarkdownSection(jd, "## 统一面试提纲")).toBe("（空）");
  });
  it("找不到标题返回空串", () => {
    expect(extractMarkdownSection(jd, "## 不存在")).toBe("");
  });
  it("不被更深级（###）标题截断，遇同级（##）才停", () => {
    const md = "## A\n正文\n### 子标题\n子正文\n## B\n别的";
    expect(extractMarkdownSection(md, "## A")).toBe("正文\n### 子标题\n子正文");
  });
});

describe("serializeRequiredQualities —— 必要素质清单序列化", () => {
  it("格式化为带序号清单，序号即核验表行号", () => {
    const q = [
      { 素质: "聪明", 定义: "举一反三", 信号: "追问时自行展开" },
      { 素质: "自驱", 定义: "无人推动仍推进", 信号: "" },
    ];
    expect(serializeRequiredQualities(q)).toBe(
      "【必要素质清单】\n1. 聪明：举一反三（信号：追问时自行展开）\n2. 自驱：无人推动仍推进"
    );
  });
  it("跳过无名项；全空/非数组返回空串", () => {
    expect(serializeRequiredQualities([{ 定义: "x" }, null, {}])).toBe("");
    expect(serializeRequiredQualities([])).toBe("");
    expect(serializeRequiredQualities(null as any)).toBe("");
  });
});

describe("desensitizeResumeText —— 简历脱敏", () => {
  it("替换手机号 / 邮箱", () => {
    expect(desensitizeResumeText("电话 13812345678，邮箱 a.b+c@example.com")).toBe("电话 [手机号]，邮箱 [邮箱]");
  });
  it("替换身份证，且不被手机号正则吃掉出生年份段", () => {
    expect(desensitizeResumeText("身份证 110101199003078515 备案")).toBe("身份证 [身份证] 备案");
    expect(desensitizeResumeText("11010119900307851X")).toBe("[身份证]");
  });
  it("手机号有数字边界，不吃长串数字的子段", () => {
    expect(desensitizeResumeText("订单号 1381234567890000")).toBe("订单号 1381234567890000");
  });
});

describe("sanitizeProjectFolderName —— 项目名净化", () => {
  it("替换非法字符为短横", () => {
    expect(sanitizeProjectFolderName("海外发行/AI:负责人?")).toBe("海外发行-AI-负责人-");
  });
  it("去首尾点和空白，空名兜底", () => {
    expect(sanitizeProjectFolderName("  ..名字..  ")).toBe("名字");
    expect(sanitizeProjectFolderName("   ")).toBe("未命名项目");
    expect(sanitizeProjectFolderName("...")).toBe("未命名项目");
  });
});

describe("报告改色 hue-rotate", () => {
  it("hexToHue 识别基准橙与常见色，灰阶返回 0", () => {
    expect(Math.round(hexToHue(REPORT_BASE_ACCENT_HEX))).toBe(17);  // #E85F28 ≈ 17°
    expect(Math.round(hexToHue("#2F6BD8"))).toBeGreaterThan(200);   // 蓝
    expect(hexToHue("#FFFFFF")).toBe(0);
    expect(hexToHue("#808080")).toBe(0);
    expect(hexToHue("乱码")).toBeNull();
  });
  it("reportHueDelta 取最短旋转方向 [-180,180]，默认橙=0", () => {
    expect(reportHueDelta("#E85F28")).toBe(0);          // 同色相
    expect(Math.abs(reportHueDelta("#2F6BD8"))).toBeGreaterThan(0);   // 橙→蓝最短方向为负，取绝对值
    expect(Math.abs(reportHueDelta("#2F6BD8"))).toBeLessThanOrEqual(180);
    expect(reportHueDelta("非法")).toBe(0);
  });
  it("recolorReportHtml：默认橙原样；换色注入 hue-rotate 到 </head> 前", () => {
    const html = "<html><head><style>x</style></head><body>报告</body></html>";
    expect(recolorReportHtml(html, "#E85F28")).toBe(html);          // 同色相不改
    const out = recolorReportHtml(html, "#2F6BD8");
    expect(out).toContain("filter:hue-rotate(");
    expect(out.indexOf("hue-rotate")).toBeLessThan(out.indexOf("</head>"));  // 在 head 内
    expect(out).toContain("<body>报告</body>");                      // 正文不动
  });
  it("无 head 时也能注入；空输入安全", () => {
    expect(recolorReportHtml("<body>x</body>", "#2F6BD8")).toContain("hue-rotate");
    expect(recolorReportHtml("", "#2F6BD8")).toBe("");
  });
});
