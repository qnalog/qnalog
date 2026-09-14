/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// @ts-nocheck
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：纪要生成提示词与输出预算

import { legacyPromptFieldForMode } from "../notes/recording-issues";

import { getAudioTimeLink, getSegmentAudioLinkOffsetMs } from "../notes/audio-refs";

import { getCustomPromptModeTemplate } from "../shared/mode-meta";


import { logLlmRequestDiagnostic } from "../llm/core";

import { classifyBriefingLength } from "../llm/config";

import { FRONTMATTER_SCHEMA } from "../shared/catalog-modes";

import { formatElapsed } from "../shared/util-common";

import { diagnosticError } from "../shared/util-key-diag";

import { MODE_BODIES } from "./mode-bodies";

import { SHARED_DISCIPLINE, STRUCTURE_LEVEL_INSTRUCTIONS } from "./discipline";

import { BriefingCheckpointStore } from "../briefing/checkpoint-store";

import { getBriefingPartTargetChars } from "../briefing/pipeline";

import { buildSynthesisPartInstruction } from "../briefing/synthesis-policy";

// 结构化程度三档 —— 控制主体内容的层级深度
// QnALog 视图（.base 文件）—— 默认创建到资料库的视图目录，可在设置里修改。
export function buildStructureLevelInstruction(level) {
  return STRUCTURE_LEVEL_INSTRUCTIONS[level] || STRUCTURE_LEVEL_INSTRUCTIONS.balanced;
}

// 各模式的 YAML frontmatter schema —— LLM 必须按此 schema 输出
// Frontmatter schema —— 字段名优先用中文（除 mode 程序识别 / tags Obsidian 约定）
// 角色相关字段（受访者 / 访问者 / 参会人 / 当事人 / 参谋 / 候选人 / 面试官）
// 用户后期可手动改成"代号 → 真名"形式，触发"重新整理"时插件会按映射替换正文里的代号

export function buildPrompt(modeBody, isMerged, modeKey) {
  const inputDesc = isMerged
    ? `分段转写（含 \`===SEG N (MM:SS-MM:SS)===\` 分隔符，请先合并并抹平段切点处的断句）`
    : `原始转写文本`;
  const fmSchema = FRONTMATTER_SCHEMA[modeKey] || "";
  const frontmatterSection = fmSchema
    ? `**输出文件必须以 YAML frontmatter 开头**，仅包含以下精简字段（不要添加任何其他字段——\`mode\`/\`time\`/\`时长\`/\`状态\`/\`tags\`/\`人物\` 由插件自动注入，**LLM 不要输出**；也不要输出 \`date\`/\`日期\`/\`location\`/\`decision\`/\`decisions\`/\`todos\`/\`type\`/\`status\`/\`people\`）：

\`\`\`yaml
---
${fmSchema}
---
\`\`\`

填入真实值；转写未提及的字段写 "未提及"，不要编造。frontmatter 后空一行，再开始 Markdown 内容。

**末尾必须输出两条机器注释**（不会渲染显示，供插件回写 frontmatter）：先输出人员、再输出标签；如果后面还有其它机器块，放在这两条之后：

\`\`\`html
<!-- lexvoice-people: 张三, 李四 -->
<!-- lexvoice-tags: 主题/招聘流程, 主题/AI转型, 项目/晋升提名, 公司/示例科技, 行业/HR -->
\`\`\`

**lexvoice-people**：本纪要中**确实出现或被点名**的关键人名（真实姓名或明确角色称呼），逗号分隔，0–6 个；只写转写里真实出现的，不带任何前缀，会写进独立的 \`人物\` 属性。⚠️**上面示例里的"张三/李四"只是占位格式，绝对不要照抄进结果；转写里没有明确人名时，这条注释整行留空（\`<!-- lexvoice-people: -->\`）或不输出——宁可没有，也不要编造或套用任何示例名。**

**lexvoice-tags**：多维度中文 nested 标签，每个用「中文前缀 + 斜杠 + 具体词」，让 Obsidian 标签面板按维度自动分组。维度只剩 4 个（**人物已单列到 lexvoice-people，这里绝不要再写 \`人物/x\`**）：

- **主题** ✅ 必填（3–5 个）：核心议题或讨论领域。例 \`主题/招聘流程\`、\`主题/AI转型\`、\`主题/组织设计\`、\`主题/晋升机制\`
- **项目**（按需，0–3 个）：转写中明确出现的专有项目名。例 \`项目/晋升提名\`、\`项目/Q2交付\`
- **公司**（按需，0–2 个）：公司或组织名（必须明确出现）。例 \`公司/示例科技\`、\`公司/示例集团\`
- **行业**（可选，0–1 个）：行业或职能领域。例 \`行业/HR\`、\`行业/游戏\`

**硬性要求**：

- lexvoice-tags 总数 4–9 个，主题维度至少 3 个
- 每个 tag 的"具体词"部分 ≤6 个汉字，避免空格和标点（"AI转型" 而非 "AI 转型"）
- 不要重复 mode 字段语义（**禁止** 输出 \`主题/招聘面试\`、\`主题/会议\`、\`主题/访谈\` 这类与 mode 重复的词）
- 转写中**没明确出现**的项目/公司/人物**一律不写**，不要编造
- 优先具体词（"招聘漏斗指标" 而非 "招聘"；"晋升提名项目" 而非 "项目"）
- 系统标签 \`lexvoice/<mode>\` 由代码自动注入，**不要在标签建议里重复**
`
    : "";
  return `你是录音整理助手。输入是一段${inputDesc}。按下方规则生成纪要。

**【最高优先级 · 忠实还原】**：本工具第一职责是"还原"——把录音里真实说过的信息完整、准确地整理出来。下面所有关于"提炼/概括/精炼/结构化/合并"的要求，都只是让纪要更易读的手段，任何时候都不得凌驾于"还原"之上。当"写得更短/更结构化"与"保留某条具体信息"冲突时，一律保留信息；拿不准某内容是否重要时，保留而非删除。不编造与不缺漏同等重要，二者都是不可逾越的底线。

**篇幅原则**：所有句数、字数、条数都只是常规材料的写作基准，不是上限。请根据录音时长、信息密度和主题数量机动扩展；宁可让主体内容更完整，也不要为了凑短摘要而漏掉关键事实、论证、概念、决策、待办或风险。顶部摘要保持可扫读，主体内容必须覆盖完整材料，不要只整理开头或少数高频片段。

${frontmatterSection}**整体结构原则**：顶部用 callout 做结构化速览（摘要、必要时的决策清单/录用建议），**主体内容贴近原文按实际推进顺序展开**——用三级标题 + 散文段落叙述，不强行套"讨论要点 / 分歧 / 暂行结论"等模板框。关键判断引用用普通 \`> \` blockquote 即可，不要为每个话题再套 callout。

**待办任务语法**：凡是正文中出现待办 / 行动项 / 下一步，请统一使用 Markdown todo 任务列表，不要用表格、普通项目符号或 \`TODO:\` 前缀。格式以事项为主：\`- [ ] 事项：<具体动作>\`；只有明确出现时再补 \`责任人：<人>\` 和 \`截止：<时间>\`。如果位于 callout 内，保留引用前缀写成 \`> - [ ] ...\`。无法判断责任人或截止时间时**直接省略该字段**（不写「未提及」），也不要编造。

**回听锚点**：如果输入分段标题中出现形如 \`[[音频文件|时间]]\` 的 Obsidian 音频链接，可以把对应链接复制到主要小节标题或关键原话后面，作为回听入口。只在内容明显来自该分段时添加；不确定就不加。不要编造音频文件名、时间或链接；每个主要小节最多放 1 个锚点，避免满屏链接。

**Callout 使用纪律**（仅以下场景用 callout，其他一律散文叙述）：
- \`> [!info]\` 仅在具体模式模板已经给出信息卡时使用；工作纪要模式不要新增元数据卡片
- \`> [!abstract]\` 顶部摘要散文
- \`> [!success]\` / \`> [!important]\` 顶部决策清单或一句话定调（仅必要时）
- \`> [!summary]\` 招聘模式专属置顶「面试评价」
- \`> [!ai-eval]\` 招聘模式专属 AI 评价
- \`> [!check]\` 招聘模式专属「重点考核项核验」（仅当上下文标注了特殊关注点时）
- \`> [!tip]\` 模式不匹配的软建议
- \`> [!question]\` 悬而未决/待澄清（仅在出现时）
- 其他正文一律不用 callout
- 连续 callout 之间必须用**一个普通空行**隔开：上一个 callout 结束后直接空一行（**行首不要写 \`>\`**），再写下一个 \`> [!type]\`；**不要**用 \`>\` 空引用行去分隔——那样 Obsidian 会把它们当作同一个引用块、合并成一个 callout 显示

**主体内容写作要求**（**还原优先，提炼为辅**——结构化是为了让人读懂，不是为了变短）：
- 把讨论的逻辑层级**结构化**呈现：议题/主论点 → 支撑（事实、案例、数据、异议）→ 关键细节
- 按讨论实际推进的脉络组织（不预设议程），但每个话题内部要做层级提炼
- 关键判断或具有信号量的原话用 \`> "<原话>"\` 引用
- **只做无损整理**：可以去口头禅、去语气词、把同一句话的重复表述合并为一次；但凡承载事实、数字、判断、立场、例子、时间、人名、待办或风险的内容，一律保留，**不得以"概括""提炼""合并"为名删除任何一条具体信息**
- 拿不准是否重要的内容，**一律保留**而不是删除——宁可让纪要长一点，也不要让用户觉得有遗漏
- 议题间存在归并关系时，用一句话 cross-reference，不重复叙述

{{STRUCTURE_INSTRUCTION}}

${modeBody}

${SHARED_DISCIPLINE}

---

转写：
{{TRANSCRIPT}}`;
}

export const POLISH_PROMPTS = {
  synthesis: buildPrompt(MODE_BODIES.synthesis, false, "synthesis"),
  learning: buildPrompt(MODE_BODIES.learning, false, "learning"),
  interview: buildPrompt(MODE_BODIES.interview, false, "interview"),
  meeting: buildPrompt(MODE_BODIES.meeting, false, "meeting"),
  seminar: buildPrompt(MODE_BODIES.seminar, false, "seminar"),
  huddle: buildPrompt(MODE_BODIES.huddle, false, "huddle"),
  monologue: buildPrompt(MODE_BODIES.monologue, false, "monologue"),
};

export const MERGE_PROMPTS = {
  synthesis: buildPrompt(MODE_BODIES.synthesis, true, "synthesis"),
  learning: buildPrompt(MODE_BODIES.learning, true, "learning"),
  interview: buildPrompt(MODE_BODIES.interview, true, "interview"),
  meeting: buildPrompt(MODE_BODIES.meeting, true, "meeting"),
  seminar: buildPrompt(MODE_BODIES.seminar, true, "seminar"),
  huddle: buildPrompt(MODE_BODIES.huddle, true, "huddle"),
  monologue: buildPrompt(MODE_BODIES.monologue, true, "monologue"),
};

// 最终纪要被 max_tokens 截断时，正文顶部插显式告警——把"静默残缺"变成"用户可见"。守住"不缺漏"底线。
export const BRIEFING_TRUNCATION_WARNING = "> [!warning] 本纪要可能未完整\n> AI 整理在写到输出长度上限时被截断，后半段内容可能缺失。完整原文已保留在本笔记底部的原始转写区；如需完整纪要，可点「重新整理」重试，或把超长录音分段后再整理。";

// 超长文本导入预压缩告警：原文先被分段摘要再整理，纪要为"摘要的整理"，具体数字/原话以底部原文为准。
export const BRIEFING_PRESUMMARY_NOTICE = "> [!info] 本纪要基于自动摘要稿生成\n> 导入文本过长，已先分段摘要再整理，部分原文细节（具体数字、原话、边角事实）可能未进入纪要。完整原文见本笔记底部折叠区，关键信息请以原文为准。";

export function buildSessionMetaPrefix(meta, mode, options = {}) {
  const sections = [];
  if (meta && meta.startedAt) {
    const m = window.moment(meta.startedAt);
    const date = m.format("YYYY-MM-DD");
    const time = m.format("HH:mm");
    const duration = meta.duration || "";
    const lines = [
      "## 会话元信息（**直接填入 frontmatter 对应字段，不要推断、不要修改**）",
      "",
      "- 日期: " + date,
      "- 时间: " + time,
    ];
    if (duration) lines.push("- 时长: " + duration);
    if (mode) lines.push("- mode: " + mode);
    lines.push("");
    lines.push("frontmatter 的「日期」「时间」「时长」「mode」字段必须照搬上面给定的值；其他字段（主题、参会人等）根据转写内容推断。");
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n---\n\n");
}

export function buildAdaptiveBriefingLengthInstruction(mode, stats) {
  // 长度分档与 token 配额共用同一判定（src/llm/config.ts classifyBriefingLength），
  // 确保"给多少篇幅指令"和"给多少 max_tokens"始终在同一档位，不会一个说超长、另一个只给短配额。
  const tier = classifyBriefingLength(stats);
  const isUltraLong = tier === "ultra";
  const isLong = isUltraLong || tier === "long";
  const isMediumLong = isLong || tier === "medium";
  if (mode === "synthesis") {
    const lines = [
      "## 综合纪要的信息尺度",
      "",
      "- 综合纪要不是逐字稿，也不是短摘要。先理解整场会议围绕哪些主要议题推进，再把散落在不同时间和不同发言中的同一议题归并到一起。",
      "- 开头先写全场梗概；正文按真实成立的主要议题编号展开，通常为 3–6 个，简单材料可以更少，复杂长会可以更多。编号代表讨论结构，不代表内部处理分段。",
      "- 每个议题保留理解结论所需的背景、事实、数字、正反案例、因果链、分歧、决定和行动；合并口头重复、过程性绕回和没有新增信息的附和。",
      "- 以事情为主语。只有关键判断、明确分歧、责任承诺或很有价值的原话才注明提出者，不按发言轮次机械复述。",
      "- 篇幅随议题数量和证据密度增长，不设置相对原文的固定字数比例。不能漏掉后半程和具体证据，也不要为了显得完整把每句话换一种说法再写一遍。",
      "- 全程只是一场会议。任何内部窗口、分段请求和阶段性草稿都不能出现在成品结构里。",
    ];
    if (isUltraLong || isLong) {
      lines.push("- 当前材料较长：先保证所有主要议题从开头到结尾都被纳入，再为高信息密度、存在分歧或形成决定的议题分配更多篇幅。");
    } else if (isMediumLong) {
      lines.push("- 当前材料有一定长度：避免把多个独立议题挤成一两段，也避免重复背景占用正文。");
    }
    return lines.join("\n");
  }
  const lines = [
    "## 篇幅与信息密度策略",
    "",
    "- 【还原而非摘要】你的任务是「重建」这场录音的完整内容，不是「概括」它。原文里出现的每一个事实、数字、人名、判断、立场、案例、待办、风险都要在纪要里有对应落点；用户要的是结构化的完整还原，不是形式上的精简。",
    "- 【禁止偷懒式压缩】严禁用「此外还讨论了 X」「双方还交流了 Y 等话题」这类一句话带过一整段讨论。凡原文实际展开过的内容，纪要也必须实际展开，而不是只留一个标题或一句概述。「更结构化」指层次更清晰，绝不等于「更简略」。",
    "- 内置模板里的句数、字数和条数是常规材料的起步基准，不是封顶线；请按录音时长、信息密度和主题数量自动扩展。",
    "- 顶部摘要要便于快速扫读，但主体内容不能因为摘要短而缩水；必须覆盖开头、中段、结尾和所有主要主题。",
    "- 如果模型上下文或输出能力有限，优先保证全篇覆盖：宁可每个主题略短，也不要只整理前半段或少数高频片段。",
    "- 注意：上面这些「扩展/完整」要求针对的是原文真实存在的内容；不得为凑长度编造原文没有的事实、人名或数字（这与忠实还原同等重要）。",
  ];
  if (isUltraLong) {
    lines.push("- 当前材料属于超长录音或多文件合并材料。请先按时间顺序建立全景章节，再逐章整理，覆盖从开头到结尾的每一段。");
    lines.push("- 【篇幅自管理·重要】你的单次输出长度有限。务必把篇幅预算分配到全程：宁可每个章节写得更紧凑，也必须一路覆盖到录音结尾——绝不允许前半段写得很充分、却在中途用尽篇幅导致后半段缺失。先确保「全程都到了」，再在余量内加深细节。");
  } else if (isLong) {
    lines.push("- 当前材料属于长录音。请按主题/章节展开，不要压缩成普通短会纪要；每个主要章节都要有独立标题、核心观点和必要支撑。");
    lines.push("- 每个被实际讨论过的主题，至少展开成一段完整叙述（背景 → 展开 → 结论或分歧），不要把一个详细讨论过的主题压成单句。一小时以上的会议，主体通常应有多个三级标题、整体篇幅明显长于短会纪要。");
    lines.push("- 篇幅自管理：注意把篇幅分配到全程，确保覆盖到录音结尾，不要前段冗长、后段缺失。");
  } else if (isMediumLong) {
    lines.push("- 当前材料偏长。摘要仍保持清晰，但主体应比短录音更充分，避免把多个主题合并成过粗的一两段。");
  }
  if (mode === "learning") {
    lines.push("- 学习笔记尤其要随材料长度扩展：学习要点、概念术语、可收纳卡片和追问问题都应跟随内容密度增加；长课程优先按章节输出全景学习笔记。");
  } else if (mode === "meeting" || mode === "seminar" || mode === "huddle") {
    lines.push("- 会议/研讨类内容应随议题数量扩展：主要议题、观点谱系、决策、风险、待办和悬而未决问题都要按实际出现情况保留，不要为保持短小而合并掉关键差异。");
  } else if (mode === "interview") {
    lines.push("- 访谈类内容应随问题数量和证据密度扩展：保留每个关键问题、回答证据和判断依据，不要只输出总评。");
  } else if (mode === "monologue") {
    lines.push("- 个人口述应随思路分叉扩展：保留所有有信息量的判断、问题和延伸方向，不要把长独白压成一段摘要。");
  }
  return lines.join("\n");
}

// 把 prompt 里的 {{STRUCTURE_INSTRUCTION}} 占位符替换为用户当前选择的结构化程度指令
export function applyStructureLevelInstruction(prompt, settings, overrideLevel) {
  const level = overrideLevel || (settings && settings.briefingStructureLevel) || "balanced";
  const block = buildStructureLevelInstruction(level);
  return prompt.replace("{{STRUCTURE_INSTRUCTION}}", block);
}

export const REPOLISH_PREFERENCE_PRESETS = {
  detailed: {
    label: "更详细",
    detailLevel: "detailed",
    structureLevel: "balanced",
    fidelity: "faithful",
    description: "主体内容更充分，保留更多事实、论证、例子和上下文。",
  },
  concise: {
    label: "更精炼",
    detailLevel: "concise",
    structureLevel: "balanced",
    fidelity: "faithful",
    description: "压缩重复表达，保留结论、依据、待办和关键分歧。",
  },
  structured: {
    label: "更结构化",
    detailLevel: "balanced",
    structureLevel: "strict",
    fidelity: "faithful",
    description: "强化标题、层级、论点—支撑—证据关系，适合复杂讨论。",
  },
  natural: {
    label: "更自然",
    detailLevel: "balanced",
    structureLevel: "loose",
    fidelity: "faithful",
    description: "减少框架感，用更连贯的散文段落呈现。",
  },
  markdown: {
    label: "MD 强化",
    detailLevel: "balanced",
    structureLevel: "balanced",
    fidelity: "expanded",
    markdownEnhanced: true,
    description: "更多使用 Markdown 高亮、下划线和少量 callout，让重点更容易扫读。",
  },
  detailedExpanded: {
    label: "详细拓展",
    detailLevel: "detailed",
    structureLevel: "balanced",
    fidelity: "expanded",
    markdownEnhanced: true,
    description: "在更完整保留上下文的同时，补充概念、疑问和分歧视角。",
  },
  structuredExpanded: {
    label: "结构拓展",
    detailLevel: "balanced",
    structureLevel: "strict",
    fidelity: "expanded",
    markdownEnhanced: true,
    description: "在更清晰的结构里加入必要的 AI 补充和 Markdown 标记。",
  },
  faithful: {
    label: "忠于原文",
    detailLevel: "balanced",
    structureLevel: "balanced",
    fidelity: "faithful",
    description: "不主动外推，只整理录音中明确出现的内容。",
  },
  expanded: {
    label: "适度拓展",
    detailLevel: "balanced",
    structureLevel: "balanced",
    fidelity: "expanded",
    description: "在不编造事实的前提下，补足背景、逻辑关系和可执行建议。",
  },
};

export function getRepolishPreferencePreset(key) {
  const preset = REPOLISH_PREFERENCE_PRESETS[key];
  return preset ? Object.assign({ key }, preset) : null;
}

export function buildRepolishPreferenceInstruction(options) {
  const opt = options && typeof options === "object" ? options : {};
  const lines = [];
  if (opt.label || opt.description) {
    lines.push(`【本次重新整理的最高优先级要求 ——「${opt.label || "自定义"}」。当它和模板里的默认篇幅/排版/尺度相冲突时一律以这里为准，必须让成品和其它偏好的产出明显不同、一眼能看出区别。】`);
    if (opt.description) lines.push(`目标：${opt.description}`);
  }
  if (opt.detailLevel === "detailed") {
    lines.push("- 篇幅与详略：**显著加长、写透每一处**。每个主题都展开成「背景/起因 → 核心判断 → 支撑依据 → 关键例子或数据 → 影响 → 下一步」；原文出现的例子、数字、各方立场、反对意见、风险都要保留。长录音按主题分章逐章展开，整体篇幅应明显多于常规版，**绝不压成短摘要**。");
  } else if (opt.detailLevel === "concise") {
    lines.push("- 篇幅与详略：**大幅压缩、只留干货**。每个主题尽量 2-4 句，直给结论 + 关键依据；砍掉所有铺垫、寒暄、重复和过程性细节。待办/风险/分歧用最短的列表点出。整体篇幅应明显短于常规版。但有一条铁律高于「短」：**每个承载独立事实/数字/判断/立场/待办的信息点都必须保留至少一次——可以变短，不能变少**；某主题确有 5 条以上独立要点时，宁可超过 2-4 句也要全部点到，绝不为压缩而丢信息。");
  }
  if (opt.structureLevel === "strict") {
    lines.push("- 排版结构：**高度结构化、强骨架**。全篇用清晰的二级/三级标题切分主题；每个论点尽量走「结论 → 依据 → 影响/待办」固定顺序；可对比的信息（多个方案/候选/指标）优先用 Markdown 表格呈现；要点用列表但最多 3 级、不过度嵌套。成品应一眼看上去层级分明、骨架清楚。");
  } else if (opt.structureLevel === "loose") {
    lines.push("- 排版结构：**去框架、散文化**。以连贯的自然段落叙述讨论脉络，读起来像一篇通顺文章而非要点清单；**除待办/清单这类天然是列表的内容外，尽量不要用项目符号**；少用标题、不要把内容切成碎片。成品应一眼看上去是成段的文字。");
  }
  if (opt.fidelity === "faithful") {
    lines.push("- 处理尺度：**严格忠于原文，只增不减地保真**。不补充录音里没出现的新事实、数据或结论；同时不得删除录音中已出现的任何具体事实、数字、判断、立场或待办——精炼只能压缩「表达方式」，不能压缩「信息条数」。");
  } else if (opt.fidelity === "expanded") {
    lines.push("- 处理尺度：**主动适度拓展**（基于原文推导，绝不编造事实/数据/人名/责任人/结论）。在恰当处用下面这些 callout 补出一层分析，让成品明显比「忠于原文」版多出 AI 视角：");
    lines.push("  - `> [!question] AI 补充：疑问与待澄清` —— 原文里未闭合的问题，写清为何重要、影响什么、下一步该确认什么（2-5 条）；");
    lines.push("  - `> [!tip] AI 补充：概念背景` —— 关键概念/术语/方法论的解释、上下位关系、常见误区；");
    lines.push("  - `> [!warning] AI 观察：争议与分歧` —— 分歧集中时概括争议焦点、各方关切和未解决风险（不臆测情绪动机）；");
    lines.push("  - 所有 AI 补充必须写在 callout 标题里、与原始记录区分；没足够依据宁可不补。");
  }
  if (opt.markdownEnhanced) {
    lines.push("- Markdown 表达：适度用 `==重点==` 标最值得回看的结论/风险、`<u>关键概念</u>` 标需关注的术语；克制，每小节最多 2-4 处，不整段高亮。");
  }
  if (!lines.length) return "";
  return lines.join("\n");
}

export function applyRepolishPreferenceInstruction(prompt, options, settings) {
  let block = buildRepolishPreferenceInstruction(options);
  const addendum = String(settings && settings.repolishPreferencePromptAddendum || "").trim();
  if (addendum && options) {
    block = [block, "## 用户自定义重新整理偏好", addendum].filter(Boolean).join("\n");
  }
  return block ? block + "\n\n---\n\n" + prompt : prompt;
}

// 解析活跃 prompt 模板：优先用户在管理页选中的活跃模板，
// 然后是该模板自定义的 prompt 文本（非空覆盖内置），最后回退到内置 POLISH_PROMPTS / MERGE_PROMPTS
export function resolveTemplatePromptForMode(plugin, mode, isMerged) {
  const builtins = isMerged ? MERGE_PROMPTS : POLISH_PROMPTS;
  const customMode = getCustomPromptModeTemplate(plugin.settings, mode);
  const baseMode = customMode && customMode.baseMode && builtins[customMode.baseMode] ? customMode.baseMode : "learning";
  const fallback = builtins[mode] || builtins[baseMode] || builtins.interview;
  const tpls = plugin.settings.promptTemplates || {};
  const activeId = (plugin.settings.activeTemplateByMode || {})[mode];
  const tpl = activeId ? tpls[activeId] : customMode;
  if (tpl && typeof tpl.prompt === "string" && tpl.prompt.trim()) return tpl.prompt;
  const legacyKey = legacyPromptFieldForMode(mode);
  const legacy = legacyKey ? plugin.settings[legacyKey] : "";
  if (legacy && typeof legacy === "string" && legacy.trim()) return legacy;
  return fallback;
}

export function formatMergeSegmentForPrompt(seg, fallbackIndex) {
  const safeIndex = Number.isFinite(Number(seg && seg.index)) ? Number(seg.index) : fallbackIndex;
  const start = Number(seg && seg.startOffsetMs) || 0;
  const end = Number(seg && seg.endOffsetMs) || 0;
  const segmentAnchor = seg && seg.audioName
    ? getAudioTimeLink(seg.audioName, getSegmentAudioLinkOffsetMs(seg))
    : "";
  const anchor = segmentAnchor ? ` ${segmentAnchor}` : "";
  const tag = `===SEG ${safeIndex + 1} (${formatElapsed(start)}-${formatElapsed(end)})${anchor}===`;
  // 转写失败段只向模型说明时间范围缺失。技术错误留在任务中心和诊断日志，
  // 不进入长期文档，也不消耗模型上下文去解释网络故障。
  const text = String((seg && seg.text) || "").trim();
  if (!text && seg && seg.error) {
    return `${tag}\n_[此时间段（${formatElapsed(start)}–${formatElapsed(end)}）尚未完成转写；如需引用该时段内容，请标注“待补转写”，不要推测或补写。]_`;
  }
  return `${tag}\n${text || "_[此段无内容]_"}`;
}

// 把段按累计字符数贪心切成若干组，边界落在段边界（不切碎单段），每组 ~targetChars。
export function splitSegmentsIntoGroups(segments, targetChars) {
  const groups = [];
  let cur = [];
  let curChars = 0;
  for (const seg of (segments || [])) {
    const segChars = String((seg && seg.text) || "").length;
    if (cur.length && curChars + segChars > targetChars) {
      groups.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(seg);
    curChars += segChars;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export function buildBriefingFidelityContract(assessment, profile, segmentCount, mode) {
  if (mode === "synthesis") {
    const detailClause = profile === "detailed"
      ? "背景、论证过程、正反案例、数字、分歧、影响与后续动作要保留得更充分，但同一意思的重复发言仍应归并。"
      : profile === "concise"
        ? "压缩重复过程，但每个独立的关键事实、判断、数字、立场、例子、待办和风险至少保留一次。"
        : "保留理解各议题所需的背景、事实、论证、例子、分歧、结论和行动，避免退化成逐字复述或只有结论的短摘要。";
    return `【本窗口证据覆盖要求】
- 原始转写约 ${assessment.sourceChars} 字，包含 ${Math.max(1, Number(segmentCount) || 1)} 个时间分段。
- 不按原文字数比例决定成品长度。完整性的判断标准是主要议题及其关键证据是否有落点，而不是正文是否接近原文字数。
- ${detailClause}
- 必须检查每个 \`===SEG N===\` 的新增信息。纯静音、完全重复、口头填充或明确失败的转写可以略去；事实、数字、案例、分歧、决定与行动不能因为压缩而消失。`;
  }
  const detailClause = profile === "detailed"
    ? "逐项展开背景、推理过程、例子、异议、数字、影响与后续动作；原文反复讨论但角度不同的内容，不得粗暴合并成一句。"
    : profile === "concise"
      ? "可以压缩重复口语，但每个独立事实、判断、数字、立场、例子、待办和风险仍须至少出现一次。"
      : "保留支撑结论所需的事实、论证、例子、分歧与上下文，不要只剩结论清单。";
  return `【本部分完整度合同】
- 原始转写约 ${assessment.sourceChars} 字，包含 ${Math.max(1, Number(segmentCount) || 1)} 个时间分段。
- 可见正文目标约 ${assessment.targetOutputChars} 字，原则上不得少于 ${assessment.minimumOutputChars} 字。该范围是防止摘要化的完整度下限，不是让你复述口头禅或用空话凑字数。
- ${detailClause}
- 必须逐个处理输入中的 \`===SEG N===\`。只有纯静音、完全重复或明确标注未完成转写的分段可以不展开；其余每段的新增信息都要在正文里找到对应落点。
- 如果某个主题跨多个分段延续，可以合并到同一章节，但必须保留后续分段新增的事实、例子、转折和结论。`;
}

export function mergeBriefingUsage(...items) {
  return items.reduce((total, item) => ({
    promptTokens: total.promptTokens + Math.max(0, Number(item && item.promptTokens) || 0),
    completionTokens: total.completionTokens + Math.max(0, Number(item && item.completionTokens) || 0),
    reasoningTokens: total.reasoningTokens + Math.max(0, Number(item && item.reasoningTokens) || 0),
    totalTokens: total.totalTokens + Math.max(0, Number(item && item.totalTokens) || 0),
  }), { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 });
}

export function buildBriefingPartExpansionPrompt(joinedChunk, currentBody, timeRange, fidelityContract, groundingContract = "") {
  return `当前纪要正文相对原始转写不够完整，可能过短，也可能遗漏了可核验的数字、术语或关键原话。请对照原始转写，返回一份**完整替换版正文**。

这是同一场会议中的一个内部时间窗口，不是独立会议，也不是独立文档。内部切片仅用于控制请求体量，最终会按时间顺序合并为一篇纪要。

${fidelityContract}

${groundingContract}

修订规则：
- 保留当前稿里已经正确呈现的内容，并补回遗漏的事实、推理链、案例、数字、分歧、风险、上下文和行动依据。
- 重点检查每个 \`===SEG N===\` 是否有新增信息被遗漏，不能只增加形容词或重复已有结论。
- 按讨论实际推进顺序重组，使用实际议题名称作为二级/三级标题和自然段；不要用“第 N 部分”“时间窗口 N”“分段 N”作为标题。
- 不要重新介绍会议背景，不要输出独立会议的总标题、全局摘要或全局结论；跨窗口延续的议题直接续写，不强行在本窗口收束。
- 不要输出修订说明、前言、YAML 或代码围栏。
- 待办只在原文确有动作时使用 Markdown todo；责任人和截止时间不明确就省略。
- 必须用 \`<!-- lexvoice-part-body-start -->\` 和 \`<!-- lexvoice-part-body-end -->\` 包住可见正文；正文之外只保留三条完整 HTML 注释：\`lexvoice-people\`、\`lexvoice-tags\`、\`lexvoice-part-summary\`。不得输出裸文本标记。

【时间范围】
${timeRange}

【原始转写】
${joinedChunk}

【当前过短稿】
${currentBody}`;
}

// 统一整理流水线的「正文部分」提示词。全局议题图只负责保持跨时段关系，正文事实仍以当前原始转写为准。
export function buildChunkMergePrompt(joinedChunk, partIndex, partTotal, timeRange, topicMap, modeGuidance, fidelityContract, mode, detailLevel) {
  const topLevelRule = partTotal > 1
    ? "- 只整理当前内部时间窗口的新内容，不复述其它窗口；不要写 YAML frontmatter、文档总标题、顶部总览、摘要 callout 或全局结论（这些由程序统一处理）。"
    : "- 这是唯一正文部分：按本模式要求输出完整成品正文；不要写 YAML frontmatter（由程序统一生成）。";
  const contentPriority = mode === "synthesis"
    ? "【最高优先级·议题归并】完整覆盖当前窗口出现的主要议题和关键证据，但不要按发言轮次逐句改写。把同一问题的重复讨论合并，把新增事实、数字、案例、分歧、决定与行动放回对应议题。"
    : "【最高优先级·忠实还原】本部分出现的所有事实、数字、判断、立场、待办、风险、关键原话一律保留，宁可写长也不要漏；只做无损整理（去口头禅、合并重复表述），不得以\"概括/精炼\"为名删除任何一条具体信息。禁止用\"还讨论了 X\"\"此外提到 Y\"这类一句话带过本部分实际展开过的内容——该展开的要展开成完整段落。";
  const synthesisPartInstruction = mode === "synthesis"
    ? buildSynthesisPartInstruction({ partIndex, partTotal, detailLevel })
    : "";
  return `你正在整理**同一场会议**中的一个内部时间窗口（处理进度 ${partIndex}/${partTotal}，时间约 ${timeRange}）。请把当前窗口的分段转写整理成可连续拼入同一篇 Markdown 纪要的正文。

【连续性硬约束】内部窗口只用于控制请求体量，不代表会议被拆成多场，也不是最终文档章节。严禁把当前窗口写成独立会议、独立纪要或“第 N 部分”。若议题从上一窗口延续，直接承接该议题；若议题还会继续，不要为了窗口结束而强行总结或下结论。

${contentPriority}

${synthesisPartInstruction}

【全局校正】实时分段只是草稿。请结合下方全程议题图统一同一人物、产品、组织和专业术语的写法；明显属于同一实体的局部 ASR 误写可以按完整上下文校正。无法可靠判断的词保留原表述并标注“待核对”，不得擅自补造。

【组织主轴·以事为中心】按议题或事项的发展脉络组织：问题如何提出、背景和证据如何补充、观点如何演进或发生分歧、最终形成什么判断与动作。明确保留讨论中的正例、反例、类比和失败经验，并说明它们支撑或限制了什么判断。不要按说话人轮次机械写成「A 说……B 说……」；只有关键观点、独特判断、明确分歧和责任承诺需要注明提出者。

${fidelityContract}

【硬性要求】
${topLevelRule}
- 用二级/三级标题组织本部分议题；按讨论实际推进顺序展开。
- 标题必须使用真实议题名称，不得使用“第 N 部分”“时间窗口 N”“分段 N”或时间范围作为标题。本文的连续性规则高于下方模式模板中的文档级标题、全局摘要和结论要求。
- 待办用 \`- [ ] 事项：<动作>\`，能确定时再补 \`责任人：<人>\` 和 \`截止：<时间>\`；无法判断就直接省略该字段，不要写"未提及"。
- 转写里没出现的人名/公司/数字一律不写，不编造。
- 直接输出本部分正文 Markdown，无前言、无解释、无代码围栏。正文必须以 \`<!-- lexvoice-part-body-start -->\` 开始，以 \`<!-- lexvoice-part-body-end -->\` 结束。
- 正文结束标记之后追加三条完整 HTML 注释（不渲染显示）：\`<!-- lexvoice-people: 本部分确实出现的人名，逗号分隔，没有就留空 -->\`、\`<!-- lexvoice-tags: 主题/xx 等多维标签，没有就留空 -->\`、\`<!-- lexvoice-part-summary: 本部分一句话小结 -->\`。禁止把 \`lexvoice-people\`、\`lexvoice-tags\`、\`lexvoice-part-summary\` 作为普通文本或引用块输出。

【全程议题图·只用于理解跨时段关系】
${topicMap || "（未生成；请严格按当前时段原始转写整理）"}

【本模式的输出要求】
${modeGuidance || "忠实、完整、结构清晰地整理当前时段。"}

【当前窗口转写】
${joinedChunk}`;
}

export function getBriefingCheckpointStore(plugin) {
  if (!plugin._briefingCheckpointStore) {
    plugin._briefingCheckpointStore = new BriefingCheckpointStore(
      plugin.app.vault.adapter,
      plugin.app.vault.configDir,
      String(plugin.manifest && plugin.manifest.id || "lexvoice"),
    );
  }
  return plugin._briefingCheckpointStore;
}

export async function clearCommittedBriefingCheckpoint(plugin, meta) {
  const id = String(meta && meta._briefingCheckpointId || "").trim();
  if (!id) return;
  try {
    await getBriefingCheckpointStore(plugin).remove(id);
    delete meta._briefingCheckpointId;
  } catch (error) {
    await logLlmRequestDiagnostic(plugin, "warn", "llm.briefing_checkpoint_cleanup_failed", "纪要已写入，但整理检查点未能清理", {
      jobId: id,
      error: diagnosticError(error),
    });
  }
}

export function getBriefingEffectiveDetailLevel(mode, repolishOptions) {
  const explicit = String(repolishOptions && repolishOptions.detailLevel || "").trim();
  if (explicit) return explicit;
  return "balanced";
}

export function getBriefingPipelineTargetChars(plugin, mode, repolishOptions) {
  return getBriefingPartTargetChars({
    mode,
    detailLevel: getBriefingEffectiveDetailLevel(mode, repolishOptions),
    structureLevel: repolishOptions && repolishOptions.structureLevel || plugin.settings.briefingStructureLevel,
  });
}

export function buildBriefingPipelineOptionsKey(plugin, mode, repolishOptions) {
  return JSON.stringify({
    pipeline: 2,
    mode,
    promptTemplate: String(plugin.settings.activeTemplateByMode && plugin.settings.activeTemplateByMode[mode] || ""),
    structureLevel: String(repolishOptions && repolishOptions.structureLevel || plugin.settings.briefingStructureLevel || "balanced"),
    detailLevel: getBriefingEffectiveDetailLevel(mode, repolishOptions),
    fidelity: String(repolishOptions && repolishOptions.fidelity || "faithful"),
    language: String(plugin.settings.briefingTranslationMode || "off") + ":" + String(plugin.settings.briefingTargetLanguage || ""),
  });
}

export function getBriefingTaskActivityId(computedMeta) {
  return String(computedMeta && computedMeta._taskActivityId || "").trim();
}

export function createBriefingLlmActivityOptions(plugin, computedMeta, patch) {
  const taskId = getBriefingTaskActivityId(computedMeta);
  const taskMeter = computedMeta && computedMeta._taskMeter || null;
  if (!taskId || !plugin || typeof plugin.tasks.patchTaskActivity !== "function") {
    return taskMeter ? { taskMeter } : {};
  }
  const basePatch = Object.assign({
    status: "running",
    deadlineAt: 0,
  }, patch || {});
  let lastHeartbeatAt = 0;
  const heartbeat = (detail) => {
    const now = Date.now();
    if (now - lastHeartbeatAt < 1500) return;
    lastHeartbeatAt = now;
    plugin.tasks.patchTaskActivity(taskId, Object.assign({}, basePatch, {
      detail: detail || basePatch.detail || "模型正在返回内容",
    }));
  };
  return {
    priority: "interactive",
    taskMeter,
    onQueued: () => plugin.tasks.patchTaskActivity(taskId, Object.assign({}, basePatch, {
      stage: "llm-queued",
      stageLabel: "等待 AI 服务",
      detail: "前面的模型任务完成后会自动开始",
    })),
    onStart: () => plugin.tasks.patchTaskActivity(taskId, basePatch),
    onActivity: () => heartbeat("模型正在返回内容"),
  };
}

export function reportBriefingPartProgress(plugin, computedMeta, checkpoint, currentPart) {
  const total = Math.max(1, checkpoint.parts.length);
  const completed = checkpoint.parts.filter(part => part.status === "complete").length;
  const taskId = getBriefingTaskActivityId(computedMeta);
  if (taskId && plugin && typeof plugin.tasks.patchTaskActivity === "function") {
    const finished = completed >= total;
    plugin.tasks.patchTaskActivity(taskId, {
      status: "running",
      stage: finished ? "assembling" : "llm",
      stageLabel: finished
        ? "正在组装纪要"
        : total > 1 ? `AI 整理 · 第 ${Math.min(total, Math.max(1, currentPart || completed + 1))}/${total} 部分` : "AI 正在整理正文",
      detail: finished
        ? `${total} 个部分均已生成，正在按时间顺序合并`
        : total > 1 ? `已完成 ${completed}/${total} 部分；每部分完成后都会立即保存` : "模型正在根据原始转写生成正文",
      progress: finished ? 88 : Math.min(84, 12 + Math.round((completed / total) * 72)),
      deadlineAt: 0,
    });
  }
  const session = plugin && plugin.session;
  if (!session || typeof plugin.recording.setSessionWorkProgress !== "function") return;
  if (computedMeta && computedMeta.startedAt && session.startedAt && computedMeta.startedAt !== session.startedAt) return;
  plugin.recording.setSessionWorkProgress(session, {
    stage: "llm-merge",
    label: total > 1 ? `AI 整理 · ${completed}/${total} 部分` : "AI 整理中",
    percent: Math.min(86, 48 + Math.round((completed / total) * 38)),
    detail: total > 1
      ? `正在整理第 ${Math.min(total, Math.max(1, currentPart || completed + 1))}/${total} 部分；已完成部分会立即保存`
      : "正在生成纪要正文",
  });
  try { plugin.shell.refreshOutlineView(); } catch { /* progress rendering must not block briefing */ }
}

export function buildEmptyLlmOutputFallback() {
  return "> [!warning] AI 整理未完成\n> 未获得可用的整理正文；原始转写仍保留在当前笔记中，可以稍后从处理进度中重试。";
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
