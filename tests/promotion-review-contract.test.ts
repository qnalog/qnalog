import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const modes = readFileSync(new URL("../src/shared/catalog-modes.ts", import.meta.url), "utf8");
const modeMeta = readFileSync(new URL("../src/shared/mode-meta.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const body = readFileSync(new URL("../src/prompts/mode-bodies.ts", import.meta.url), "utf8");
const settingsTab = readFileSync(new URL("../src/ui/settings-tab.ts", import.meta.url), "utf8");

describe("promotion review runtime contract", () => {
  it("正式注册模式、frontmatter 和最终提示词", () => {
    expect(modes).toContain('"promotion-review": { prefix: "晋升评审"');
    expect(modes).toContain('"promotion-review": `主题: <一句话主题>');
    expect(modeMeta).toContain('"promotion-review"');
    expect(main).toContain('"promotion-review": buildPrompt(MODE_BODIES["promotion-review"]');
    expect(main).toContain('"promotion-review": ["主题", "被评审人", "岗位", "当前职级", "目标职级"');
    expect(body).toContain('"promotion-review": `## §0 场景目标');
  });

  it("与招聘共用五次点击进阶后的隐藏开关", () => {
    expect(modeMeta).not.toContain('STANDARD_POLISH_MODES = ["synthesis", "meeting", "seminar", "interview", "monologue", "learning", "promotion-review"]');
    expect(modeMeta).toContain('HR_GATED_POLISH_MODES = new Set(["promotion-review", "recruit", "recruit-needs"])');
    expect(settingsTab).toContain("if (this._advancedTapCount < 5) return;");
    expect(settingsTab).toContain('new obsidian.Notice("招聘与晋升评审已启用"');
    expect(main).toContain('new obsidian.Notice("晋升评审功能未解锁")');
  });

  it("提供三输入、晋升初审和开始答辩录音", () => {
    expect(main).toContain('makeGroup("任职要求")');
    expect(main).toContain('makeGroup("晋升提名材料")');
    expect(main).toContain('makeGroup("重点考核能力", true)');
    expect(main).toContain('generatePromotionPreReview(this.plugin, saved)');
    expect(main).toContain('primary.createSpan({ text: "开始答辩录音" })');
  });

  it("录音会话冻结上下文，并将初审写入笔记和最终原始材料", () => {
    expect(main).toContain('promotionReviewContext: this._currentPromotionReviewContext || null');
    expect(main).toContain('promotionReviewPhase: "presentation"');
    expect(main).toContain('lexvoice-promotion-pre-review-start');
    expect(main).toContain('const promotionPreReviewBlock = buildPromotionPreReviewDetails(session)');
    expect(main).toContain('promotionReviewContext: session.promotionReviewContext || null');
  });

  it("长答辩分部提取证据后统一生成一份全局报告", () => {
    expect(main).toContain("buildPromotionReviewPartContextPrefix");
    expect(main).toContain("buildPromotionReviewPartInstruction");
    expect(main).toContain("buildPromotionReviewConsolidationPrompt");
    expect(main).toContain('(mode === "synthesis" || mode === "promotion-review") && partPlans.length > 1');
    expect(main).toContain('purpose: mode === "promotion-review" ? "promotion-review-consolidation"');
  });

  it("述职阶段走普通大纲，问答阶段只保留评委和候选人对话", () => {
    expect(main).toContain('detectPromotionReviewPhase(session.promotionReviewPhase, windowed.newSegments)');
    expect(main).toContain('modeKey === "promotion-review" && opts.promotionQa');
    expect(main).toContain('不要输出 XML、JSON、Markdown、图标、编号、AI评价、建议追问');
    expect(main).toContain('if (isPromotionReview) return;');
    expect(main).toContain('isPromotionReview ? "评委" : "面试官"');
  });

  it("问答颜色完全由主题变量控制", () => {
    expect(styles).not.toContain("#2563eb");
    expect(styles).not.toContain("#4f46e5");
    expect(styles).not.toContain("#c2410c");
    expect(styles).toContain("color: var(--interactive-accent)");
    expect(styles).toContain("color: var(--text-accent)");
  });
});
