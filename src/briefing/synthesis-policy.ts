export type SynthesisPartDraft = {
  index: number;
  timeRange: string;
  summary?: string;
  body: string;
};

function cleanText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).trim();
  }
  return "";
}

function normalizeDetailLevel(value: unknown): "concise" | "balanced" | "detailed" {
  const normalized = cleanText(value).toLowerCase();
  if (normalized === "concise" || normalized === "detailed") return normalized;
  return "balanced";
}

function detailInstruction(value: unknown): string {
  const detailLevel = normalizeDetailLevel(value);
  if (detailLevel === "detailed") {
    return "保留更完整的背景、论证过程、正反案例、数字、分歧和影响，但仍按议题归并，不按发言轮次复述。";
  }
  if (detailLevel === "concise") {
    return "压缩重复过程，保留主要议题、关键依据、结论、分歧、风险和行动；任何独立的关键事实与数字至少出现一次。";
  }
  return "完整呈现主要议题及其必要背景、论证、案例、结论和行动；合并重复表达，避免退化成逐字稿或只有结论的短摘要。";
}

export function buildSynthesisPartInstruction(input: {
  partIndex: number;
  partTotal: number;
  detailLevel?: string;
}): string {
  const partTotal = Math.max(1, Math.floor(Number(input.partTotal) || 1));
  if (partTotal <= 1) return "";
  const partIndex = Math.min(partTotal, Math.max(1, Math.floor(Number(input.partIndex) || 1)));
  return `【综合纪要内部证据整理】
- 当前是同一场会议的第 ${partIndex}/${partTotal} 个内部窗口。这里的输出是供全局归并使用的议题材料，不是最终纪要，也不能把当前窗口写成一场独立会议。
- 按真实议题归档本窗口的新信息。每个议题写清：背景或问题、事实与数字、讨论脉络、正反案例、判断或分歧、形成的决定与行动。没有的项目不要硬补。
- 同一意思的多轮发言合并表达；后续发言只有在补充新证据、改变判断或形成转折时才单独保留。
- 以事情为主语。只有关键观点、明确分歧、责任承诺或必须追溯来源的内容才注明说话人。
- 不要写顶部梗概、全局结论、文档总标题或按时间命名的章节；这些由全局成文阶段统一完成。
- ${detailInstruction(input.detailLevel)}`;
}

function renderPartDrafts(parts: SynthesisPartDraft[]): string {
  return parts
    .map((part) => {
      const summary = cleanText(part.summary);
      return [
        `### 内部材料 ${part.index + 1} · ${cleanText(part.timeRange) || "时间未知"}`,
        summary ? `窗口小结：${summary}` : "",
        cleanText(part.body),
      ].filter(Boolean).join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function buildSynthesisConsolidationPrompt(input: {
  topicMap?: string;
  parts: SynthesisPartDraft[];
  modeGuidance?: string;
  detailLevel?: string;
  duration?: string;
  transcriptChars?: number;
}): string {
  const topicMap = cleanText(input.topicMap) || "（没有可用的全局议题图，请从全部内部材料中自行识别。）";
  const modeGuidance = cleanText(input.modeGuidance);
  const duration = cleanText(input.duration) || "未知";
  const transcriptChars = Math.max(0, Math.floor(Number(input.transcriptChars) || 0));
  return `请把下面同一场会议的议题材料归并成一篇完整的「综合纪要」。这是最终成文阶段，不是继续按内部窗口拼接。

【成品结构】
1. 开头必须是一个 \`> [!abstract] 会议梗概\`，用 2–4 个连贯段落说明会议背景、核心问题、讨论如何推进、形成了什么结论以及当前状态。不要写“已按顺序整理”等过程说明。
2. 梗概之后，识别全场真正成立的主要议题。通常归并为 3–6 个；材料简单可以更少，复杂长会可以更多。用 \`## 1. 议题名称\`、\`## 2. 议题名称\` 连续编号。
3. 每个议题内部沿“问题或背景 → 讨论脉络 → 事实/数字/正反案例 → 判断、分歧或结果”展开。并列内容才用列表，不要把整篇写成清单。
4. 最后仅在材料确有内容时增加 \`## 关键结论与分歧\`、\`## 待办与未决问题\`。待办使用 Markdown 任务语法；责任人和截止时间无法确认时省略字段。

【归并规则】
- 内部材料只是处理窗口。相同议题即使出现在不同时间，也必须合并到同一个章节，消除重复标题、重复背景和重复结论。
- 以事情为主轴，不按“谁先说、谁后说”复述。只有关键判断、明确分歧、责任承诺或很有价值的原话才注明提出者。
- 保留支撑理解和决策所需的事实、数字、案例、反例、因果链、风险、决定和行动；删除口头重复、过程性绕回和没有新增信息的附和。
- ${detailInstruction(input.detailLevel)}
- 篇幅随议题数量和证据密度增长，不追求固定压缩比例。不能为了变短丢掉后半程或具体证据，也不能为了显得完整逐句改写原始发言。
- 全文只能呈现为一场会议。不得出现“第 N 部分”“内部窗口”“分段纪要”等实现细节。
- 不编造材料中没有的人名、事实、数字、责任人和结论。

【输出协议】
- 不要 YAML frontmatter、代码围栏、前言或解释。
- 可见正文必须放在 \`<!-- lexvoice-part-body-start -->\` 与 \`<!-- lexvoice-part-body-end -->\` 之间。
- 正文结束后追加三条完整 HTML 注释：\`lexvoice-people\`、\`lexvoice-tags\`、\`lexvoice-part-summary\`。摘要注释只写一句全场小结。

【材料规模】
- 会议时长：${duration}
- 原始转写约：${transcriptChars} 字
- 内部材料：${input.parts.length} 份

【全局议题图】
${topicMap}

${modeGuidance ? `【综合纪要模式要求】\n${modeGuidance}\n\n` : ""}【全部内部议题材料】
${renderPartDrafts(input.parts)}`;
}
