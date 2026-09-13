import { callLlm, stripModeSuggestionBlocks } from "../llm/core";
import { truncateForLlmPrompt } from "../shared/util-text";
import type { PromotionReviewContext, Segment } from "../shared/types";

export const EMPTY_PROMOTION_REVIEW_CONTEXT: PromotionReviewContext = {
  requirements: "",
  nominationMaterial: "",
  focusCapabilities: "",
  preReview: "",
  revieweeName: "",
  position: "",
  jobSequence: "",
  currentLevel: "",
  targetLevel: "",
  savedAt: null,
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstMatch(text: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = clean(match?.[1]).replace(/[｜|，,；;].*$/, "").trim();
    if (value) return value;
  }
  return "";
}

export function extractPromotionReviewMetadata(
  nominationMaterial: string,
  requirements = "",
): Pick<PromotionReviewContext, "revieweeName" | "position" | "jobSequence" | "currentLevel" | "targetLevel"> {
  const material = String(nominationMaterial || "");
  const combined = `${material}\n${String(requirements || "")}`;
  const revieweeName = firstMatch(material, [
    /姓名\s*[：:]\s*([\u4e00-\u9fa5·]{2,12})(?=最高学历|所在部门|岗位|年龄|司龄|\s|$)/m,
    /(?:^|\n)\s*姓名\s*[：:]\s*([^\n]+)/m,
    /(?:^|\n)\s*(?:候选人|被评审人|述职人)\s*[：:]\s*([^\n]+)/m,
  ]);
  const position = firstMatch(material, [
    /岗位\s*[：:]\s*([^\n]{1,40}?)(?=年龄|司龄|提名信息|当前职级|晋升年份|目标职级|\s{2,}|$)/m,
    /(?:^|\n)\s*岗位\s*[：:]\s*([^\n]+)/m,
    /(?:^|\n)\s*职位\s*[：:]\s*([^\n]+)/m,
  ]);
  const jobSequence = firstMatch(combined, [
    /(?:岗位)?序列\s*[：:]\s*([^\n]+)/m,
    /([^\n，,；;]{1,20}序列)\s*(?:P|M)\d+/i,
  ]);
  let currentLevel = firstMatch(material, [
    /当前职级\s*[：:]?\s*((?:P|M)\s*\d+(?:\s*\/\s*(?:P|M)\s*\d+)?)/i,
    /晋升前职级\s*[：:]?\s*((?:P|M)\s*\d+)/i,
  ]).replace(/\s+/g, "");
  let targetLevel = firstMatch(material, [
    /目标职级\s*[：:]?\s*((?:P|M)\s*\d+(?:\s*\/\s*(?:P|M)\s*\d+)?)/i,
    /晋升(?:至|后)\s*[：:]?\s*((?:P|M)\s*\d+)/i,
  ]).replace(/\s+/g, "");
  if (!currentLevel || !targetLevel) {
    const transition = /((?:P|M)\s*\d+)(?:\s*\/\s*((?:P|M)\s*\d+))?\s*(?:→|->|—|–|至|升到|晋升)\s*((?:P|M)\s*\d+)(?:\s*\/\s*((?:P|M)\s*\d+))?/i.exec(combined);
    if (transition) {
      if (!currentLevel) currentLevel = [transition[1], transition[2]].filter(Boolean).join("/").replace(/\s+/g, "");
      if (!targetLevel) targetLevel = [transition[3], transition[4]].filter(Boolean).join("/").replace(/\s+/g, "");
    }
  }
  if (!currentLevel || !targetLevel) {
    const levels = Array.from(combined.matchAll(/\b([PM])\s*(\d{1,2})\b/gi))
      .map(match => `${match[1].toUpperCase()}${match[2]}`);
    const unique = levels.filter((value, index) => levels.indexOf(value) === index);
    if (!currentLevel && unique[0]) currentLevel = unique[0];
    if (!targetLevel && unique[1]) targetLevel = unique[1];
  }
  return { revieweeName, position, jobSequence, currentLevel, targetLevel };
}

export function normalizePromotionReviewContext(value: Partial<PromotionReviewContext> | null | undefined): PromotionReviewContext {
  const raw = value || {};
  const requirements = clean(raw.requirements);
  const nominationMaterial = clean(raw.nominationMaterial);
  const extracted = extractPromotionReviewMetadata(nominationMaterial, requirements);
  return {
    requirements,
    nominationMaterial,
    focusCapabilities: clean(raw.focusCapabilities),
    preReview: clean(raw.preReview),
    revieweeName: clean(raw.revieweeName) || extracted.revieweeName,
    position: clean(raw.position) || extracted.position,
    jobSequence: clean(raw.jobSequence) || extracted.jobSequence,
    currentLevel: clean(raw.currentLevel) || extracted.currentLevel,
    targetLevel: clean(raw.targetLevel) || extracted.targetLevel,
    savedAt: typeof raw.savedAt === "string" && raw.savedAt ? raw.savedAt : null,
  };
}

export function hasPromotionReviewContextContent(value: Partial<PromotionReviewContext> | null | undefined): boolean {
  const context = normalizePromotionReviewContext(value);
  return Boolean(context.requirements || context.nominationMaterial || context.focusCapabilities);
}

export function buildPromotionReviewContextPrefix(value: Partial<PromotionReviewContext> | null | undefined): string {
  const context = normalizePromotionReviewContext(value);
  if (!hasPromotionReviewContextContent(context)) return "";
  const meta = [
    context.revieweeName ? `被评审人：${context.revieweeName}` : "",
    context.position ? `岗位：${context.position}` : "",
    context.jobSequence ? `岗位序列：${context.jobSequence}` : "",
    context.currentLevel ? `当前职级：${context.currentLevel}` : "",
    context.targetLevel ? `目标职级：${context.targetLevel}` : "",
  ].filter(Boolean).join("\n");
  const focus = context.focusCapabilities
    ? `\n\n## 用户指定的重点考核能力\n${truncateForLlmPrompt(context.focusCapabilities, 3000)}\n\n必须在总报告顶部逐项回应这些能力，但仍需覆盖正式目标职级要求。`
    : "";
  const preReview = context.preReview
    ? `\n\n## 会前初审（仅作待验证假设，必须允许现场证据修正）\n${truncateForLlmPrompt(context.preReview, 6000)}`
    : "";
  return `# 本次晋升评审上下文\n\n${meta || "评审对象信息待从材料识别"}\n\n## 当前职级与目标职级任职要求\n${truncateForLlmPrompt(context.requirements, 10000)}\n\n## 晋升提名材料\n${truncateForLlmPrompt(context.nominationMaterial, 12000)}${focus}${preReview}`;
}

export function buildPromotionReviewPartContextPrefix(value: Partial<PromotionReviewContext> | null | undefined): string {
  const context = normalizePromotionReviewContext(value);
  if (!hasPromotionReviewContextContent(context)) return "";
  const meta = [
    context.revieweeName ? `被评审人：${context.revieweeName}` : "",
    context.position ? `岗位：${context.position}` : "",
    context.jobSequence ? `岗位序列：${context.jobSequence}` : "",
    context.currentLevel ? `当前职级：${context.currentLevel}` : "",
    context.targetLevel ? `目标职级：${context.targetLevel}` : "",
  ].filter(Boolean).join("\n");
  const focus = context.focusCapabilities
    ? `\n\n## 重点考核能力\n${truncateForLlmPrompt(context.focusCapabilities, 2000)}`
    : "";
  return `# 晋升评审分部证据上下文\n\n${meta || "评审对象信息待从材料识别"}\n\n## 当前职级与目标职级任职要求\n${truncateForLlmPrompt(context.requirements, 8000)}${focus}\n\n提名材料和会前初审将在全局成文时统一提供。本窗口只提取现场述职与问答证据，不重复生成最终结论。`;
}

export function buildPromotionReviewPartInstruction(input: {
  partIndex: number;
  partTotal: number;
}): string {
  const partTotal = Math.max(1, Math.floor(Number(input.partTotal) || 1));
  const partIndex = Math.min(partTotal, Math.max(1, Math.floor(Number(input.partIndex) || 1)));
  if (partTotal <= 1) return "";
  return `【晋升评审内部证据整理】
- 当前是同一场晋升答辩的第 ${partIndex}/${partTotal} 个内部窗口。这里只整理供全局报告使用的现场证据，不生成独立评审报告。
- 区分候选人述职、候选人问答和评委观点；评委陈述不能写成候选人事实。
- 对每项证据写清具体事迹、本人角色、关键判断、行动、结果、结果归因、责任边界，以及它对应的任职要求。
- 材料没有覆盖只能记为“证据待补”，不得在当前窗口判定候选人不具备某项能力。
- 不输出总评价、双画像、最终证据矩阵、晋升建议或评委结论；这些由全部窗口完成后的全局成文统一生成。`;
}

type PromotionReviewPartDraft = {
  index: number;
  timeRange: string;
  summary?: string;
  body: string;
};

function renderPromotionReviewPartDrafts(parts: PromotionReviewPartDraft[]): string {
  return parts
    .map((part) => [
      `### 内部现场材料 ${part.index + 1} · ${clean(part.timeRange) || "时间未知"}`,
      clean(part.summary) ? `窗口小结：${clean(part.summary)}` : "",
      clean(part.body),
    ].filter(Boolean).join("\n\n"))
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function buildPromotionReviewConsolidationPrompt(input: {
  context: Partial<PromotionReviewContext> | null | undefined;
  parts: PromotionReviewPartDraft[];
  modeGuidance?: string;
  duration?: string;
}): string {
  const context = buildPromotionReviewContextPrefix(input.context);
  const guidance = clean(input.modeGuidance);
  const duration = clean(input.duration) || "未知";
  return `请把下面同一场晋升答辩的全部内部现场材料归并成一份完整的晋升评审报告。内部窗口只是处理手段，不能在成品中出现，也不能生成多份彼此割裂的小报告。

## 全局成文纪律
- 完整执行晋升评审模式的输出结构，以候选人当前画像、目标岗位画像、两者差异和证据强度为主轴。
- 合并跨窗口重复出现的项目和问答；后续材料只有补充新证据、修正判断或形成反证时才单独保留。
- 区分提名材料、候选人述职、候选人问答和评委观点。没有证据只能写证据不足，不得虚构事实或替评委作决定。
- 全文不得出现“第 N 部分”“内部窗口”“分段报告”等实现细节。
- 不要 YAML frontmatter、代码围栏、前言或解释。
- 可见正文必须放在 \`<!-- lexvoice-part-body-start -->\` 与 \`<!-- lexvoice-part-body-end -->\` 之间。
- 正文结束后追加三条完整 HTML 注释：\`lexvoice-people\`、\`lexvoice-tags\`、\`lexvoice-part-summary\`。

## 材料规模
- 答辩时长：${duration}
- 内部现场材料：${input.parts.length} 份

${context ? `## 评审上下文\n${context}\n\n` : ""}${guidance ? `## 晋升评审模式要求\n${guidance}\n\n` : ""}## 全部内部现场材料
${renderPromotionReviewPartDrafts(input.parts)}`;
}

export function buildPromotionPreReviewPrompt(value: Partial<PromotionReviewContext> | null | undefined): { system: string; user: string } {
  const context = normalizePromotionReviewContext(value);
  const system = "你是晋升评审的会前分析助手。你依据公司提供的具体岗位、当前职级和目标职级任职要求整理证据并设计评委问题。你不复核绩效、价值观、职级停留等资格门槛，不替评委作最终晋升决定。";
  const focusBlock = context.focusCapabilities
    ? `\n\n## 重点考核能力（用户指定，必须单列并优先分析）\n${context.focusCapabilities}`
    : "";
  const user = `请根据下面的任职要求和晋升提名材料生成一份会前“晋升初审”。

## 分析纪律
- 必须结合具体岗位名称、岗位序列、当前职级和目标职级；信息缺失时写“材料未明确”，不要编造。
- 先比较当前与目标职级的能力性质变化，不要只写工作量、项目数量或项目体量变化。
- 区分候选人做过什么、本人承担的角色、关键判断、行动、结果、结果归因和责任边界。
- “材料未提到”只能写“证据不足/答辩待验证”，不能判断“不具备”。
- 不用通用 P8/P9 模板替代用户提供的任职要求。
- 不输出匹配百分比、分数、通过/不通过或晋升建议。
- 重点问题必须绑定“目标职级要求 × 候选人具体事迹或证据缺口”。
- 直接输出 Markdown，不要代码围栏或前言。

## 输出结构
# 晋升初审

## 评审对象
用一行输出：姓名｜岗位/岗位序列｜当前职级 → 目标职级。无法识别的项写“材料未明确”。

## 当前职级到目标职级的关键变化
列出 3-6 个真正决定晋级的能力变化，每项写清当前要求、目标要求和分水岭。

## 目标岗位人才画像
围绕该岗位和目标职级，描述专业能力、复杂问题处理、独立判断、责任范围、结果责任、领导力或专业影响力。

## 候选人初始能力画像
只根据提名材料总结已展现的能力，并标明主要事迹依据和当前能力边界。

## 书面证据与待验证项
分为“已有较充分证据”“部分证据”“证据不足”“潜在差距或反证”；没有内容的类别可省略。
${context.focusCapabilities ? "\n## 重点考核能力\n逐项说明书面证据、当前无法判断的部分和答辩验证方向。\n" : ""}
## 评委重点提问大纲
按优先级给出 6-8 个问题。每题包含：为什么要问、主问题、2-3 个追问、观察要点、任职要求依据、材料依据/缺口。问题要短、具体，逼近事实、取舍、边界、失败和结果归因。

## 任职要求
${truncateForLlmPrompt(context.requirements, 10000)}

## 晋升提名材料
${truncateForLlmPrompt(context.nominationMaterial, 12000)}${focusBlock}`;
  return { system, user };
}

export async function generatePromotionPreReview(plugin: unknown, value: Partial<PromotionReviewContext> | null | undefined): Promise<string> {
  const context = normalizePromotionReviewContext(value);
  if (!context.requirements || !context.nominationMaterial) return "";
  const prompt = buildPromotionPreReviewPrompt(context);
  const text = await callLlm(plugin, prompt.system, prompt.user, { timeoutMs: 90000 });
  return stripModeSuggestionBlocks(String(text || ""))
    .replace(/^```(?:markdown|md)?\s*\r?\n?/i, "")
    .replace(/\r?\n?```\s*$/i, "")
    .trim();
}

const PROMOTION_QA_TRANSITION_PATTERNS = [
  /下面(?:进入|开始).{0,8}(?:问答|提问|答辩)/,
  /接下来.{0,8}(?:请|由).{0,8}(?:评委|各位).{0,8}提问/,
  /请各位评委提问/,
  /(?:我的|以上)述职.{0,6}(?:完毕|结束)/,
  /欢迎.{0,6}(?:提问|指正)/,
  /有没有.{0,6}问题/,
];

export function detectPromotionReviewPhase(
  previousPhase: "presentation" | "qa" | undefined,
  segments: Pick<Segment, "text">[],
): "presentation" | "qa" {
  if (previousPhase === "qa") return "qa";
  const text = segments.map(segment => String(segment.text || "")).join("\n");
  if (PROMOTION_QA_TRANSITION_PATTERNS.some(pattern => pattern.test(text))) return "qa";
  const labeledQuestions = (text.match(/(?:评委|主持人|提问)\s*[：:][^\n]{2,100}[？?]/g) || []).length;
  const labeledAnswers = (text.match(/(?:候选人|述职人|答)\s*[：:]/g) || []).length;
  return labeledQuestions >= 1 && labeledAnswers >= 1 ? "qa" : "presentation";
}
