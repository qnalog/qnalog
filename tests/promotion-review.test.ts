import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  requestUrl: vi.fn(),
  normalizePath: (path: string) => path,
}));

import {
  buildPromotionReviewConsolidationPrompt,
  buildPromotionPreReviewPrompt,
  buildPromotionReviewContextPrefix,
  buildPromotionReviewPartContextPrefix,
  buildPromotionReviewPartInstruction,
  detectPromotionReviewPhase,
  extractPromotionReviewMetadata,
  normalizePromotionReviewContext,
} from "../src/promotion";

describe("promotion review context", () => {
  it("从提名材料提取评审对象、岗位和职级", () => {
    const result = extractPromotionReviewMetadata(`
姓名：候选人甲
岗位：资深组织发展
岗位序列：组织发展
当前职级：P7
目标职级：P8
`);
    expect(result).toEqual({
      revieweeName: "候选人甲",
      position: "资深组织发展",
      jobSequence: "组织发展",
      currentLevel: "P7",
      targetLevel: "P8",
    });
  });

  it("兼容 PDF 复制后相邻字段粘连的姓名与岗位", () => {
    const result = extractPromotionReviewMetadata("姓名：候选人乙最高学历：本科所在部门：组织发展部\n岗位：资深组织发展年龄：32司龄：5.9\n当前职级：P7 目标职级：P8");
    expect(result.revieweeName).toBe("候选人乙");
    expect(result.position).toBe("资深组织发展");
    expect(result.currentLevel).toBe("P7");
    expect(result.targetLevel).toBe("P8");
  });

  it("归一化时保留用户输入并自动补齐元信息", () => {
    const context = normalizePromotionReviewContext({
      requirements: "  P8 与 P9 任职要求  ",
      nominationMaterial: "姓名：候选人丙\n岗位：主策\n当前职级：P8\n目标职级：P9",
      focusCapabilities: " 独立决策 ",
    });
    expect(context.requirements).toBe("P8 与 P9 任职要求");
    expect(context.revieweeName).toBe("候选人丙");
    expect(context.position).toBe("主策");
    expect(context.currentLevel).toBe("P8");
    expect(context.targetLevel).toBe("P9");
    expect(context.focusCapabilities).toBe("独立决策");
  });

  it("初审提示词不做资格门槛复筛，并强制回应重点能力", () => {
    const prompt = buildPromotionPreReviewPrompt({
      requirements: "P8：负责复杂模块。P9：独立承担关键方向。",
      nominationMaterial: "姓名：候选人丙\n岗位：主策\n负责项目交付。",
      focusCapabilities: "与制作人的决策边界",
    });
    expect(prompt.user).toContain("不输出匹配百分比");
    expect(prompt.user).toContain("材料未提到");
    expect(prompt.user).toContain("重点考核能力");
    expect(prompt.user).toContain("与制作人的决策边界");
    expect(prompt.system).toContain("不复核绩效");
  });

  it("最终上下文包含两级任职要求、提名材料、重点能力和初审", () => {
    const prefix = buildPromotionReviewContextPrefix({
      requirements: "P7/P8 任职要求",
      nominationMaterial: "姓名：候选人丁\n岗位：组织发展",
      focusCapabilities: "系统思维",
      preReview: "初审结论仅作待验证假设",
    });
    expect(prefix).toContain("当前职级与目标职级任职要求");
    expect(prefix).toContain("晋升提名材料");
    expect(prefix).toContain("用户指定的重点考核能力");
    expect(prefix).toContain("会前初审");
  });

  it("长答辩分部只携带必要评审标尺，不重复提名材料和会前初审", () => {
    const context = {
      requirements: "P7/P8 任职要求",
      nominationMaterial: "候选人甲的完整提名材料",
      focusCapabilities: "系统思维",
      preReview: "会前初审待现场验证",
    };
    const prefix = buildPromotionReviewPartContextPrefix(context);
    const instruction = buildPromotionReviewPartInstruction({ partIndex: 2, partTotal: 3 });

    expect(prefix).toContain("P7/P8 任职要求");
    expect(prefix).toContain("系统思维");
    expect(prefix).not.toContain("候选人甲的完整提名材料");
    expect(prefix).not.toContain("会前初审待现场验证");
    expect(instruction).toContain("第 2/3 个内部窗口");
    expect(instruction).toContain("不生成独立评审报告");
  });

  it("多分部最终只生成一份全局晋升评审报告", () => {
    const prompt = buildPromotionReviewConsolidationPrompt({
      context: {
        requirements: "P7/P8 任职要求",
        nominationMaterial: "候选人甲的提名材料",
        preReview: "初审假设",
      },
      modeGuidance: "输出双画像差异和证据矩阵",
      duration: "01:20:00",
      parts: [
        { index: 0, timeRange: "00:00-40:00", summary: "述职", body: "项目证据" },
        { index: 1, timeRange: "40:00-01:20:00", summary: "问答", body: "问答证据" },
      ],
    });

    expect(prompt).toContain("候选人甲的提名材料");
    expect(prompt).toContain("初审假设");
    expect(prompt).toContain("项目证据");
    expect(prompt).toContain("问答证据");
    expect(prompt).toContain("不能生成多份彼此割裂的小报告");
    expect(prompt).toContain("lexvoice-part-body-start");
  });
});

describe("promotion review realtime phase", () => {
  it("默认保持述职阶段，普通疑问句不会切换", () => {
    expect(detectPromotionReviewPhase(undefined, [{ text: "我当时思考，为什么项目会延期？随后重新拆解了流程。" }])).toBe("presentation");
  });

  it("明确宣布进入提问后切换为问答", () => {
    expect(detectPromotionReviewPhase("presentation", [{ text: "我的述职完毕，欢迎各位评委提问。" }])).toBe("qa");
  });

  it("识别标注明确的一问一答，并且切换后不回退", () => {
    expect(detectPromotionReviewPhase("presentation", [{ text: "评委：这个结果如何归因？\n候选人：我负责方案判断与资源协调。" }])).toBe("qa");
    expect(detectPromotionReviewPhase("qa", [{ text: "下面我继续补充项目背景。" }])).toBe("qa");
  });
});
