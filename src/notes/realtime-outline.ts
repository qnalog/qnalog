/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// @ts-nocheck
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：实时大纲：状态机、提示词与增量判据

import { cleanRealtimeLlmText } from "./recording-issues";

import { getAudioTimeLink, getSegmentAudioLinkOffsetMs } from "./audio-refs";

import { buildRecruitRealtimeOutlineMemory, cleanRealtimeOutlineItemText, makeRealtimeOutlineNode, mergeCoverageNoRegress, normalizeRealtimeOutlineList, parseRealtimeOutlineStateFromMarkdown } from "../outline-text";

import { normalizeAudioInputMode } from "../ui/helpers";

import { JOBPORTRAIT_DIMENSIONS } from "../recruit";

import { stripModeSuggestionBlocks } from "../llm/core";

import { formatElapsed } from "../shared/util-common";

import { extractJsonObject } from "../shared/util-json";

// 实时大纲：归并到共同上层概念，层级由内容涌现，不强加结构
export const REALTIME_OUTLINE_MAX_SEGMENTS = 10;

export const REALTIME_OUTLINE_MAX_TRANSCRIPT_CHARS = 6000;

export const REALTIME_OUTLINE_MAX_PREVIOUS_CHARS = 1200;

export const REALTIME_OUTLINE_MAX_MEMORY_CHARS = 800; // 程序维护的长期记忆上限，避免长会上下文随轮次膨胀

export const REALTIME_OUTLINE_LOOKBACK_SEGMENTS = 1;

export const REALTIME_OUTLINE_MIN_NEW_SEGMENTS = 2;

export const REALTIME_OUTLINE_MIN_NEW_CHARS = 200;

// A sizeable incremental batch must produce at least one visible structural
// change. Otherwise the model may silently echo saturated history while the
// committed cursor advances past real discussion.
export const REALTIME_OUTLINE_MIN_SEMANTIC_DELTA_CHARS = 500;

export const REALTIME_OUTLINE_MAX_NO_CHANGE_REJECTIONS = 1;

export const REALTIME_OUTLINE_INITIAL_MIN_SEGMENTS = 2;

export const REALTIME_OUTLINE_INITIAL_MIN_CHARS = 120;

export const REALTIME_OUTLINE_MIN_SILENT_INTERVAL_MS = 30000;

export const REALTIME_OUTLINE_SILENT_TIMEOUT_MS = 35000;

export const REALTIME_OUTLINE_MANUAL_TIMEOUT_MS = 45000;

export const REALTIME_OUTLINE_FINAL_TIMEOUT_MS = 45000;

export const REALTIME_OUTLINE_FINAL_BATCH_MAX_ATTEMPTS = 2;

export const REALTIME_OUTLINE_FINAL_MAX_BATCHES = 16;

export const REALTIME_OUTLINE_RETRY_GUARD_MS = 300;

export const REALTIME_OUTLINE_BUSY_RETRY_MS = 2000;

// 大纲 max_tokens 分档（按总纲："最终那次该说完不为省钱截断"）：
// - silent：控制延迟，保持适度上限；长会真正需要内容时由 manual / final 那次补足
// - final / manual：用户停止录音后那一次，必须把完整大纲跑全，不被实时档预算连累
// silent 提到 1600：全窗口重新综合 + 每个 L1 带 2-4 子要点需要更多输出空间，
// 1000 会让模型在子要点处被截断、退化成只剩一级标题（丢灵魂）。
export const REALTIME_OUTLINE_SILENT_MAX_TOKENS = 1600;

export const REALTIME_OUTLINE_FINAL_MAX_TOKENS = 2400;

export const REALTIME_OUTLINE_FAILURE_BACKOFF_BASE_MS = 30000;

export const REALTIME_OUTLINE_FAILURE_BACKOFF_MAX_MS = 5 * 60 * 1000;

export function buildSourceAwareOutlineInstruction(captureMode, modeKey) {
  const mode = normalizeAudioInputMode(captureMode || "mic");
  if (mode === "mic") {
    return `【来源标记】
当前只录麦克风。大纲不需要额外标来源。
`;
  }
  if (mode === "virtualCable") {
    return `【来源标记】
当前只录电脑音频。若一级条目明显来自播放的视频、课程、会议远端声音，可在该一级条目前加 \`[电脑音频]\`；不要给二级条目重复标记。
`;
  }
  // mix-virtual：HR/招聘模式下，麦克风/电脑音频 直接对应 面试官/候选人，应主动打标
  if (modeKey === "recruit") {
    return `【来源标记 · 线上面试 · 主动标记】
当前录音同时包含麦克风和电脑音频。在线上面试场景里：
- \`[麦克风]\` = **面试官端**（本机说话的人，即用户自己）
- \`[电脑音频]\` = **候选人端**（远端入会的对方）

请尽量给每个一级条目前加上对应的来源标记，方便后续按角色归类。判断依据优先级：
1. 该条目主要说话角色（提问/陈述自己经历）显然来自哪一端 → 直接标
2. 内容功能（提问/追问 → 多半是面试官；陈述经历/技能/项目细节 → 多半是候选人）
3. 实在交织（两端同时说话/打断）才不标，并在条目末尾加一句 \`（双端交织）\`

不要给二级条目重复标记，也不要为了凑标记而改写事实。
`;
  }
  return `【来源标记 · 谨慎使用】
当前录音同时包含麦克风和电脑音频，但转写文本是混合后的结果。请只在内容特征明显时给一级条目前加来源标记：
- \`[麦克风]\`：用户对着麦克风说的评论、测试、提问、补充说明。
- \`[电脑音频]\`：视频、课程、播客、会议远端或电脑正在播放的内容。
无法判断、两路内容交织或只是泛化主题时，不要标记。不要给二级条目重复标记，也不要为了标记而改写事实。
`;
}

export function buildRealtimeOutlineTranscript(segments) {
  const validSegments = (segments || [])
    .filter((s) => s && s.text && String(s.text).trim())
    .map((s, i) => Object.assign({ _validIndex: i }, s));
  if (!validSegments.length) return "";
  return validSegments
    .map((s, i) => {
      const n = Number.isFinite(s.index) ? s.index + 1 : (Number(s._validIndex) || 0) + 1;
      const start = formatElapsed(s.startOffsetMs || 0);
      const end = formatElapsed(s.endOffsetMs || 0);
      const anchor = getAudioTimeLink(s.audioName, getSegmentAudioLinkOffsetMs(s));
      const meta = anchor
        ? `【段落 ${n}｜${start}-${end}｜回听 ${anchor}】`
        : `【段落 ${n}｜${start}-${end}】`;
      return `${meta}\n${String(s.text || "").trim()}`;
    })
    .join("\n\n");
}

export function buildRealtimeOutlineAnchorSources(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment, index) => ({
      anchor: getAudioTimeLink(segment && segment.audioName, getSegmentAudioLinkOffsetMs(segment)),
      text: String((segment && segment.text) || "").trim(),
      // The source segment is the time interval. Several outline topics may
      // intentionally receive the same start anchor; exact seconds are not a
      // content identity and must not be fabricated for uniqueness.
      index: Math.max(0, Number(segment && segment.startOffsetMs) || index),
    }))
    .filter((item) => item.anchor && item.text);
}

export function getRealtimeOutlineTimeoutMs(windowed, opts) {
  const chars = Math.max(0, Number(windowed && windowed.approxChars) || 0);
  let base;
  if (chars >= 5000) base = 45000;
  else if (chars >= 2500) base = 35000;
  else base = 25000;
  // 本地模型档：所有阈值 ×2。本地慢、单线程，给它充足时间把大纲跑完，
  // 不为省 token 截断（总纲："最终那次该说完"），也不让它在 45 秒内被强行 abort。
  if (opts && opts.local) base = base * 2;
  return base;
}

export function clipRealtimeContextText(text, maxChars) {
  const cleaned = String(text || "").trim();
  const max = Math.max(800, Number(maxChars) || 0);
  if (cleaned.length <= max) return cleaned;
  const marker = "\n\n……（中间内容已压缩，后续以主题记忆为准）……\n\n";
  const head = Math.max(300, Math.floor((max - marker.length) * 0.58));
  const tail = Math.max(300, max - marker.length - head);
  return cleaned.slice(0, head).trimEnd() + marker + cleaned.slice(-tail).trimStart();
}

export function buildRollingOutlineContext(previousMemory, previousOutline, windowed, opts = {}) {
  const memory = clipRealtimeContextText(previousMemory, REALTIME_OUTLINE_MAX_MEMORY_CHARS);
  const outline = clipRealtimeContextText(previousOutline, REALTIME_OUTLINE_MAX_PREVIOUS_CHARS);
  const omittedBeforeCount = Math.max(0, Number(windowed && windowed.omittedBeforeCount) || 0);
  const isIncremental = !!(windowed && windowed.isIncremental);
  const programOwnedMemory = !!(opts && opts.programOwnedMemory);
  const lines = [];
  if (programOwnedMemory) {
    lines.push("【已提交大纲记忆 / 程序维护】");
    if (memory) {
      lines.push(
        "下面是 QnALog 根据已提交大纲确定性压缩的长期状态，只用于避免重复和保持连续性。不要复述、改写或输出这段记忆；本轮只处理新增转写。",
        "",
        memory
      );
    } else {
      lines.push("当前还没有已提交的大纲记忆。无需创建或输出记忆字段。");
    }
  } else {
    lines.push("【主题记忆 / 滚动摘要】");
    if (memory) {
      lines.push(
        "下面是此前较早内容压缩后的长期记忆。它用于承接主线，不直接面向用户展示；请在本轮处理后更新它。",
        "",
        memory
      );
    } else {
      lines.push("暂无主题记忆。请根据本轮转写建立第一版主题记忆。");
    }
  }
  if (outline) {
    lines.push(
      "",
      "【当前可见大纲参考 · 程序已冻结保存】",
      isIncremental
        ? "下面只用于判断新增内容是否延续已有话题。完整历史由程序保存和合并；不要复制、重写、删减或重排这里的条目。回听链接也由程序维护。"
        : "下面是侧边栏当前显示的大纲。它只用于保持连续性；请保留仍然重要的主线，合并重复或过细的旧节点。",
      "",
      outline
    );
  }
  if (isIncremental) {
    lines.push(
      "",
      "【自上次大纲以来的新增转写 · 增量输入】",
      omittedBeforeCount
        ? `这些是上次大纲之后新转写出来的段落。较早内容已经在【当前可见大纲】里有归属，不要再为它们生成 L1。`
        : `这些是上次大纲之后新转写出来的段落。请只为这些新段落生成新的一级或子条目，老一级条目原样保留。`,
      "",
      "**输出要求（增量模式）**：",
      "- <lexvoice-outline> **只返回本轮增量**，不要复制【当前可见大纲参考】中的任何未变化条目。",
      "- 新话题按讨论顺序输出新的一级条目。当前批次通常 1-6 个一级条目；历史已有多少节点都不影响本轮提炼。",
      "- 如果新增转写明显延续某个历史话题，请复用该历史一级标题，并且只输出本轮新增的子要点；程序会把它们并回原节点。",
      "- 同一大话题出现新的分支、结论、案例或讨论阶段时，使用更具体的新一级标题，不要把很长一段讨论无限塞进旧节点。",
      "- 只要新增转写包含实质讨论，至少输出 1 个一级条目，并保留能区分本轮内容的具体子要点。",
      "- 严禁改写、合并、重排或删除历史条目。不要生成或校对时间戳。",
      ""
    );
  } else {
    lines.push(
      "",
      "【最近转写窗口】",
      omittedBeforeCount
        ? `为控制长录音上下文，较早的 ${omittedBeforeCount} 段已由主题记忆承接；下面只提供最近窗口的转写和会中补充。`
        : "下面是当前可用的最近转写和会中补充。",
      ""
    );
  }
  return lines.join("\n");
}

export function buildRealtimeOutlineEnvelopeInstruction(opts = {}) {
  const incremental = !!(opts && opts.incremental);
  return [
    "【输出协议】",
    "请严格输出两个 XML 风格块，不要前言、不要解释、不要代码围栏：",
    "",
    "<lexvoice-memory>",
    "写给后续轮次使用的主题记忆 / 滚动摘要。",
    "</lexvoice-memory>",
    "",
    "<lexvoice-outline>",
    "写给用户看的实时大纲 Markdown 列表。",
    "</lexvoice-outline>",
    "",
    "【主题记忆写法】",
    "- 这是隐藏的长期上下文，不是最终纪要，不要写成漂亮文章。",
    "- 记录会议/课程主线、已出现的重要对象、待追踪问题、用户用 # / ？ / ！ / TODO / @ 标记过的意图和大致时间。",
    "- 长录音可以逐步增长，但要压缩；优先保留能帮助后续理解的话题脉络，而不是抄原文。",
    "- 控制在 600 字以内；如果信息变多，合并同类项，不要线性增长。",
    "- 不要写“未提及”“待确认”这类空字段。",
    "",
    "【可见大纲写法】",
    "- <lexvoice-outline> 内只能放用户可读的大纲列表。",
    ...(incremental ? [
      "- 本轮是增量更新：只输出新增转写对应的新节点或补充节点，不要复制历史大纲。",
      "- 当前批次通常控制在 1-6 个一级节点；这是单批次约束，不是整场会议的总节点上限。",
    ] : [
      "- 本轮是首轮整理：只整理当前提供的转写，通常控制在 1-8 个一级节点。",
      "- 合并当前批次中的重复节点；保留能帮助用户回忆现场的关键词和层级。",
    ]),
    "- **每个一级节点必须带 2-4 个子要点**，提炼该话题下的关键论点、事实、数据、人名或结论。话题确实只有一句话时至少给 1 个子要点。",
    "- 每个一级节点必须是一个具体章节/话题；不要输出「课程结构」「本节包括」「四个部分」这类横跨全局的总述行。",
    "- 顶层格式只能是：`- 章节标题`。子项格式只能是两个空格缩进：`  - 子要点`。",
    "- 不要生成、复制或校对 `[[音频文件|HH:MM]]`；QnALog 会根据真实音频分段自动挂上近似回听位置。",
    "",
    "【换行铁律 · 最重要】",
    "- 每个条目必须独占一行，用真正的换行符分隔。",
    "- 严禁把多个条目用 ` - `（空格-连字符-空格）串在同一行，例如 `- A - B - C` 是错误的，必须写成三行：`- A` / `- B` / `- C`。",
    "- 一行里只能有一个 `- ` 开头；子项缩进两个空格后另起一行。",
    "",
    "【合格示例】",
    "- 商业化思维的四个问题",
    "  - 解决什么问题",
    "  - 正确商业化思维",
    "  - 感受量化手段",
    "",
    "【不合格示例，禁止输出】",
    "- 课程结构与开场四问：课程四部分、四个场景、寻找手段",
    "- 课程结构 - 课程四部分 - 四个场景 - 学员A - 学员B（错误：多条目连排一行）",
    "- 1.解决什么问题 2.正确商业化思维 3.感受量化手段",
  ].join("\n");
}

export function extractRealtimeTaggedBlock(text, tagName) {
  const tag = String(tagName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = re.exec(String(text || ""));
  return match ? String(match[1] || "").trim() : "";
}

export function stripRealtimeTaggedBlocks(text) {
  return String(text || "")
    .replace(/<lexvoice-memory\b[^>]*>[\s\S]*?<\/lexvoice-memory>/gi, "")
    .replace(/<lexvoice-outline\b[^>]*>[\s\S]*?<\/lexvoice-outline>/gi, "")
    .trim();
}

// 兜底修复 DeepSeek 等模型把列表条目连排成 "- A - B - C" 单行不换行的问题。
// 中文大纲内容里几乎不会出现 " - "（空格-ASCII连字符-空格）作为正文，所以把它当作被折叠的
// 条目分隔符拆开是安全的；时间锚点 [[x|HH:MM]] 和箭头 → 等都不含这个模式。
//
// 关键：拆开时要**恢复层级**，不能全平铺成无锚点顶层兄弟——否则那些无锚点的段会被
// normalizeOutlineMarkdownForDisplay 当作"总述行"丢弃，导致大纲只剩光秃秃一级标题。
// 规则（仅对顶层连排行）：带时间锚点的段 = 一级条目；其后的无锚点段 = 挂到该一级条目下的子要点（缩进两格）。
export function parseRealtimeOutlineResponse(raw, fallbackOutline, fallbackMemory) {
  const cleaned = cleanRealtimeLlmText(raw);
  let memory = extractRealtimeTaggedBlock(cleaned, "lexvoice-memory");
  let outline = extractRealtimeTaggedBlock(cleaned, "lexvoice-outline");
  if (!outline) outline = stripRealtimeTaggedBlocks(cleaned);
  outline = cleanRealtimeLlmText(outline);
  outline = normalizeRealtimeOutlineList(outline);  // 兜底拆行
  const outlineWasFallback = !outline;
  memory = cleanRealtimeLlmText(memory);
  if (!outline) outline = String(fallbackOutline || "").trim();
  if (!memory) memory = String(fallbackMemory || "").trim();
  return {
    outline,
    memory: clipRealtimeContextText(memory, REALTIME_OUTLINE_MAX_MEMORY_CHARS),
    outlineWasFallback,
  };
}

export function normalizeRealtimeOutlineState(value, fallbackMarkdown, fallbackMemory) {
  const raw = value && typeof value === "object" ? value : {};
  const nodes = [];
  for (const item of (Array.isArray(raw.nodes) ? raw.nodes : [])) {
    const node = makeRealtimeOutlineNode(
      item && item.anchor,
      item && item.title,
      item && item.children,
      nodes.length
    );
    if (node) {
      node.id = String((item && item.id) || node.id);
      nodes.push(node);
    }
  }
  if (!nodes.length) nodes.push(...parseRealtimeOutlineStateFromMarkdown(fallbackMarkdown));
  return {
    version: 1,
    nodes,
    memory: clipRealtimeContextText(raw.memory || fallbackMemory || "", REALTIME_OUTLINE_MAX_MEMORY_CHARS),
  };
}

export function refreshProgramOwnedRecruitOutlineMemory(session) {
  if (!session || session.mode !== "recruit") return String(session && session.realtimeOutlineMemory || "");
  const state = normalizeRealtimeOutlineState(
    session.realtimeOutlineState,
    session.realtimeOutline,
    ""
  );
  const memory = buildRecruitRealtimeOutlineMemory(state.nodes, {
    maxChars: REALTIME_OUTLINE_MAX_MEMORY_CHARS,
  });
  state.memory = memory;
  session.realtimeOutlineState = state;
  session.realtimeOutlineMemory = memory;
  return memory;
}

export function renderRealtimeOutlineStateMarkdown(state) {
  const normalized = normalizeRealtimeOutlineState(state);
  const lines = [];
  for (const node of normalized.nodes) {
    const title = cleanRealtimeOutlineItemText(node.title, 90);
    if (!title) continue;
    const prefix = node.anchor ? `${node.anchor} ` : "";
    lines.push(`- ${prefix}${title}`);
    for (const child of (Array.isArray(node.children) ? node.children : [])) {
      const text = cleanRealtimeOutlineItemText(child, 120);
      if (text) lines.push(`  - ${text}`);
    }
  }
  return lines.join("\n").trim();
}

export function buildEvidenceAudioAnchorInstruction() {
  return `【回听锚点 · 极其重要 · 时间戳钉死规则】
转写内容按段落提供，并在段落信息里带有 Obsidian 音频回听链接，例如 \`[[音频文件.webm|12:34]]\`。

**时间戳来源的唯一合法路径**：
1. **老一级条目（在【当前可见大纲参考】里已经存在的）→ 100% 原样保留它原有的 \`[[...|HH:MM]]\` 链接**，包括文件名和时间。这是钉死规则：哪怕该段已经滚出最近转写窗口，也不要换、不要删、不要"看着不在窗口里就去窗口里抓一个最近的"。老条目的时间戳是历史事实。
2. **新一级条目（本轮新提炼出来的）→ 只能用【最近转写窗口】里实际出现的链接**复制 1 个最接近的；窗口里没有就**留空**，不要从老大纲里挪一个、也不要编造。
3. 子条目通常不重复放链接；除非它是关键原话或独立证据点。

**严禁行为**：
- 把【最近转写窗口】里的时间戳赋给【当前可见大纲参考】里的老一级条目（这会让用户点击跳转跑到错误位置）。
- 编造不在输入里的文件名或时间。
- 一个段落的链接同时复用到多个相邻一级条目（同一个时间戳出现在两个连续 L1 上，几乎一定是 bug）。
- 因为某条老一级条目的原始段落不在当前窗口而把它的链接换成窗口里的某个近邻时间。

**会中批注**：\`【会中批注】\` 是用户手动补充，不是音频转写原文；不要用它的时间戳作为大纲回听锚点。
`;
}

export function buildProgramOwnedOutlineAnchorInstruction() {
  return `【回听位置】
你只负责判断主题和组织要点，不负责生成时间戳。
- 不要输出、复制或校对 \`[[音频文件|HH:MM]]\`。
- QnALog 会在收到结构后，根据真实转写分段为一级节点挂上近似回听位置。
- 具体秒数不参与内容质量判断；即使无法挂载时间，也要完整输出合格的大纲结构。`;
}

// 招聘需求挖掘 · 会中 coverage-scan prompt（spec §5.2.B）：整场转写 → 14 维覆盖状态 JSON。
// system 用 JOBPORTRAIT_SYSTEM_PROMPT。languageInstruction 前置（前缀缓存）。
export function buildCoverageScanPrompt(transcript, languageInstruction) {
  const lang = languageInstruction ? String(languageInstruction).trim() + "\n\n" : "";
  return `${lang}任务：这是一场"招聘需求沟通会"（HRBP 与业务方沟通某岗位招人标准）的**实时进行中**转写。请扫描截至目前的全部转写，判断下面 14 个岗位画像维度各自的"覆盖状态"，输出严格 JSON。这是会中实时进度追踪，不是会后总结——只依据已出现的对话，未谈到就如实标 missing。

【先判断场景】若截至目前的对话明显不是在沟通某岗位招人标准（更像研讨、闲聊或其它会议），所有维度如实标 missing 即可，不要为了凑覆盖率把无关内容硬塞进某一维。

${buildEvidenceAudioAnchorInstruction()}

【14 个维度（key 固定，不可增删改）】
硬性要求(hard)：years（年限）/ education（学历）/ industry（行业）/ must_have（必须经验）/ salary（期望薪酬）
软能力·冰山下(soft)：business_sense（业务感）/ resilience（抗挫折）/ learning（学习能力）/ values（价值观）/ communication（软技能·沟通协作）
风险信号(risk)：job_hopping（跳槽频率）/ education_suspicious（学历可疑）
文化匹配(culture)：dept_style（部门风格）/ supervisor_pref（上级偏好）

【三态判定标准（严格按此，宁缺勿滥）】
- covered（已覆盖）：业务方对该维度给出**明确标准/具体要求**，且——硬性维度有可执行的数值或硬条件（如"5 年以上""本科起""薪资 30-40K""必须做过 To B"）；软能力维度有业务方**原话证据** + 至少一个具体场景或反例（不能只是"要有责任心"这种空泛标签）。必须能定位到一段转写原话。
- partial（部分覆盖）：提到了但**不够实——只有模糊词没有量化/场景**（如"经验丰富点""学习能力强""能扛事"），或缺反例/场景，或一句带过。
- missing（未涉及）：转写里业务方**根本没谈到**。

【evidence_anchor 规则】仅 covered/partial 需要：从转写中复制**最能支撑该判定**那段所带的 \`[[音频文件.webm|HH:MM]]\` 链接，原样照抄（文件名+时间不许改）；没有可用链接或 missing → 留空串 ""。严禁编造。

【missing_what 规则】partial/missing 必填：一句话写"还缺什么、下次该追问什么"（如"只说要 To B 经验，没给年限和行业"）——这是给 HRBP 的行动提示，最有价值。covered 时留空串 ""。

【followup_question 规则】partial/missing 必填：一句"该怎么问"的具体追问话术，针对本场上下文、业务语言、可直接照着问、≤30 字（如"您说的'抗压'，能举一个去年扛住压力的具体例子吗？"）。**不得含双引号或换行**（避免把 JSON 写崩）。covered 留空串 ""。

【vague_hits 规则】若该维转写里出现模糊/对冲词（如"差不多 / 比较强 / 有一定经验 / 看情况 / 视情况 / 挺好的 / 大概 / 综合素质 / 踏实 / 靠谱"等空泛说法），把命中的词原样列进字符串数组 vague_hits（最多 3 个）；没有则空数组 []。注意"优先""最好"这类在给硬性标准时是正常用词，不算模糊。

【输出 · 只输出一个 JSON 对象，无前言无解释无代码围栏】
{
  "dims": [
    { "key": "years", "name": "年限", "status": "covered|partial|missing", "evidence_anchor": "", "missing_what": "", "followup_question": "", "vague_hits": [] },
    ... 必须**恰好 14 条，key 与上面一一对应，不可遗漏/重复**，顺序不限 ...
    { "key": "supervisor_pref", "name": "上级偏好", "status": "...", "evidence_anchor": "...", "missing_what": "...", "followup_question": "...", "vague_hits": [] }
  ]
}

【克制】转写不完整很正常，未覆盖坦诚标 missing，不要为好看硬判 covered；不引用候选人/简历内容；status 只能是 covered/partial/missing；evidence_anchor/missing_what/followup_question 缺省一律空串、vague_hits 缺省空数组 []，绝不输出 null。

【实时转写】
${transcript}`;
}

// 前缀缓存优化：所有稳定指令（含语种指令）放在前面，变化的「转写上下文」严格放最后。
// 这样 DeepSeek 等支持自动前缀缓存的服务商，每轮能命中"从头到 实时整理上下文："的稳定前缀，
// 只对变化的转写部分重新计算 —— 纯降本提速，不改输出质量。
// languageInstruction 由调用方传入并前置（不要再用 applyBriefingLanguageInstruction 追加到末尾，
// 否则语种指令会落在变化内容之后、进入不可缓存的尾巴）。
export function buildRecruitRealtimeOutlineProtocolInstruction(opts = {}) {
  const maxTopics = opts && opts.incremental ? 6 : 8;
  return `【逐行输出协议】
不要输出 XML、JSON、Markdown、图标、编号、代码围栏、前言或结语。
只使用下面五种行前缀；每行表达一件事，内容里不要换行：

主题：本轮问答的主题，4-8 字
问题：面试官的核心提问
回答：候选人的一个回答要点（可以重复多行）
评价：基于已出现证据的具体观察（没有足够证据就省略）
追问：下一步可直接提出的事实型追问（没有必要就省略）

每个新主题必须从“主题：”开始，其后的问题、回答、评价和追问归属于该主题。
本批最多输出 ${maxTopics} 个主题。即使转写不完整，也要输出“主题：转写不清，待复核”，并用“回答：”保留听清的原话。
时间、层级、图标、长期记忆和最终 Markdown 均由 QnALog 生成。不要输出“记忆：”或改写历史大纲。`;
}

export function buildPromotionReviewQaProtocolInstruction(opts = {}) {
  const maxTopics = opts && opts.incremental ? 6 : 8;
  return `【逐行输出协议】
不要输出 XML、JSON、Markdown、图标、编号、AI评价、建议追问、前言或结语。
只使用下面三种行前缀；每行表达一件事，内容里不要换行：

主题：本轮问答的主题，4-10 字
问题：评委提出的核心问题或追问
回答：候选人的一个回答要点（可以重复多行）

每个新主题必须从“主题：”开始，其后的问题和回答归属于该主题。本批最多输出 ${maxTopics} 个主题。转写不清时用“主题：问答片段待复核”，并尽量保留听清的原话。`;
}

export function buildOutlinePrompt(modeLabel, modeKey, transcript, captureMode, languageInstruction, opts = {}) {
  const langBlock = languageInstruction ? `\n\n${String(languageInstruction).trim()}` : "";
  // 招聘面试模式：大纲严格按"问题 → 回答 → AI 评价"组织
  if (modeKey === "recruit") {
    return `下面是一段${modeLabel}录音的实时整理上下文。请只整理本批新增内容的面试实时大纲。

${buildSourceAwareOutlineInstruction(captureMode, modeKey)}

${buildProgramOwnedOutlineAnchorInstruction()}

${buildRecruitRealtimeOutlineProtocolInstruction(opts)}

【结构 · 每个面试主题为一个节点】
把每一轮"面试官提问 → 候选人回答"归到一个主题下：主题是 4-8 字概括，不是原话问题；问题、回答要点、评价和追问各自独立成行。

【合格示例】
\`\`\`
主题：跨境项目经验
问题：请介绍一次跨境劳动争议项目
回答：候选人负责证据整理和外部律师协同
回答：最终方案由集团法务负责人审批
评价：有项目参与证据，但独立决策程度尚不明确
追问：哪一个关键决定由你本人作出？
\`\`\`

【节点标题（主题）要求】
- 4-8 字，概括这一轮聊的主题/能力项，如"社招体系搭建""跨部门协作""离职原因"
- 不要把原话问题塞进标题，问题另写“问题：”

【评价行的写作要求】
- 简评要"具体"——不要"回答得不错""逻辑清晰"这种空话
- 必须能给面试官**实际启发**：例如"用了STAR结构但S和T一笔带过""数据来源未追问就接受""避谈失败案例"等

【追问行的要求】
- 追问要"挖到事实层"，不要"能不能再说说"这种泛问
- 例：候选人说"提升了 20%"，追问写成"追问：这 20% 的基线值是多少？参与人员只有他一个吗？"

【克制】
- 候选人回答还没出现的问题，不要预生成评价
- 转写不完整就只整理已出现的问答对
- 没听清楚的，写"主题：转写不清，待复核"，不要硬猜

【输出】
- 严格使用逐行协议；不要前言、不要总评（综合评价留给最终整合，不在大纲里出现）${langBlock}

实时整理上下文：
${transcript}`;
  }

  if (modeKey === "promotion-review" && opts.promotionQa) {
    return `下面是一段晋升答辩评委问答的实时转写。请只整理本批新增内容，把评委问题和候选人回答按主题归组。

${buildProgramOwnedOutlineAnchorInstruction()}

${buildPromotionReviewQaProtocolInstruction(opts)}

【要求】
- 只记录实际发生的问答，不生成评价、评分、证据状态或追问建议。
- 问题包括评委首次提问和后续追问；候选人的长回答可拆成多个“回答：”要点。
- 不要把评委陈述的观点改写为候选人的回答。
- 不输出总评；完整职级分析在答辩结束后的总报告中生成。${langBlock}

实时整理上下文：
${transcript}`;
  }

  // 通用：归并到共同上层概念
  return `下面是一段${modeLabel}录音的实时整理上下文。请更新实时大纲和主题记忆。

${buildSourceAwareOutlineInstruction(captureMode, modeKey)}

${buildProgramOwnedOutlineAnchorInstruction()}

${buildRealtimeOutlineEnvelopeInstruction(opts)}

【方法 · 归并】
找到讨论中可以归并的"共同上一级概念"。
- 通读全部内容，识别零散的具体观点 / 事实 / 任务（叶子）
- 把可以共用同一个上层概念的叶子聚到一起，写出那个上层概念作为父节点
- 如果多个父节点又共享更大的母题，再向上归并一层
- **层级深度由材料决定，不预设**——
  - 材料同质或简单 → 1 层即可
  - 材料丰富 → 2 层
  - 真正多议题、多分支 → 3 层或更多
- 不要为了凑层级把孤立观点强行嵌套；也不要把本可归类的扁平铺开

【克制】
- 不堆砌符号 / callout / 模板字段
- 不预设"决议 / 行动 / 假设 / 缺口"等维度——只有材料里真有，才出现
- 不复述发言原话，但也别过度抽象成空话；保留能让人回忆起讨论内容的关键词
- 讨论本身可能没那么深刻，那就让大纲也朴素一点

【输出】
- <lexvoice-outline> 内使用纯 Markdown 列表，缩进表达层级
- 每条简短，不解释、不前言、不结语；一级条目不要写时间戳或回听链接
- 转写不完整时只整理已出现的内容${langBlock}

实时整理上下文：
${transcript}`;
}

export function buildRealtimeOutlineDetails(session) {
  const outline = String(session && session.realtimeOutline ? session.realtimeOutline : "").trim();
  if (!outline) return "";
  const coverage = session && session.realtimeOutlineCoverage;
  const totalSegmentCount = Math.max(0, Number(coverage && coverage.totalSegmentCount) || 0);
  const committedSegmentCount = Math.min(
    totalSegmentCount,
    Math.max(0, Number(coverage && coverage.committedSegmentCount) || 0)
  );
  const coverageNotice = totalSegmentCount > 0 && committedSegmentCount < totalSegmentCount
    ? `> 大纲仅覆盖 ${committedSegmentCount}/${totalSegmentCount} 个转写分段，未覆盖部分仍已用于正文纪要。可在侧边栏刷新大纲后补齐。`
    : "";
  return [
    "<details>",
    "<summary>录音中实时大纲（草稿）</summary>",
    "",
    "> 基于录音过程中已完成的分段自动生成，正文纪要以最终整理为准。时间标记可用于快速回听对应片段。",
    ...(coverageNotice ? ["", coverageNotice] : []),
    "",
    outline,
    "",
    "</details>",
  ].join("\n");
}

export function isRealtimeOutlineCurrent(session) {
  if (!session || !session.realtimeOutline) return false;
  const segmentCount = Array.isArray(session.segments) ? session.segments.length : 0;
  const processedCount = Number(session.realtimeOutlineSegmentCount) || 0;
  return processedCount >= segmentCount;
}

export function getRealtimeOutlineNewSegmentCount(session) {
  if (!session) return 0;
  const segmentCount = Array.isArray(session.segments) ? session.segments.length : 0;
  const processedCount = Number(session.realtimeOutlineSegmentCount) || 0;
  return Math.max(0, segmentCount - processedCount);
}

export function updateRealtimeOutlineCoverage(session, status, extra = {}) {
  if (!session) return null;
  const totalSegmentCount = Array.isArray(session.segments) ? session.segments.length : 0;
  const committedSegmentCount = Math.min(
    totalSegmentCount,
    Math.max(0, Number(session.realtimeOutlineSegmentCount) || 0)
  );
  const attemptedSegmentCount = Math.min(
    totalSegmentCount,
    Math.max(committedSegmentCount, Number(session.realtimeOutlineAttemptedSegmentCount) || 0)
  );
  const complete = totalSegmentCount > 0 && committedSegmentCount >= totalSegmentCount;
  session.realtimeOutlineCoverage = Object.assign({}, session.realtimeOutlineCoverage || {}, extra || {}, {
    status: complete ? "complete" : String(status || "partial"),
    complete,
    totalSegmentCount,
    committedSegmentCount,
    attemptedSegmentCount,
    coveragePercent: totalSegmentCount
      ? Math.round((committedSegmentCount / totalSegmentCount) * 100)
      : 0,
    updatedAt: new Date().toISOString(),
  });
  return session.realtimeOutlineCoverage;
}

export function getRealtimeOutlineNewTextChars(session) {
  if (!session || !Array.isArray(session.segments)) return 0;
  const processedCount = Math.max(0, Number(session.realtimeOutlineSegmentCount) || 0);
  return session.segments.slice(processedCount).reduce((sum, s) => {
    return sum + String((s && s.text) || "").trim().length;
  }, 0);
}

export function hasRealtimeOutlineRunnableBacklog(session) {
  const newSegments = getRealtimeOutlineNewSegmentCount(session);
  if (newSegments <= 0) return false;
  const newChars = getRealtimeOutlineNewTextChars(session);
  if (newChars <= 0) return false;
  const hasPriorOutput = session && session.mode === "recruit-needs"
    ? !!(session.jobPortraitCoverage && session.jobPortraitCoverage.updatedAt)
    : !!(session && session.realtimeOutline);
  if (!hasPriorOutput) {
    if (session && session.mode === "recruit-needs") return true;
    return newSegments >= REALTIME_OUTLINE_INITIAL_MIN_SEGMENTS
      || newChars >= REALTIME_OUTLINE_INITIAL_MIN_CHARS;
  }
  return newSegments >= REALTIME_OUTLINE_MIN_NEW_SEGMENTS || newChars >= REALTIME_OUTLINE_MIN_NEW_CHARS;
}

export function getRealtimeOutlineUpdatedAtMs(session) {
  const value = session && session.realtimeOutlineUpdatedAt;
  if (!value) return 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getRealtimeOutlineMinSilentIntervalMs(opts) {
  // 本地模型档：把最小间隔从 30s 拉到 90s。
  // 理由（总纲：堵工程缺陷不为省钱）：本地模型慢、单线程，6000 字输入跑不完一个 30s 间隔
  // 容易触发"超时-退避-沉默"循环；拉长间隔让它有完整窗口跑完，体感稳定。
  return opts && opts.local
    ? REALTIME_OUTLINE_MIN_SILENT_INTERVAL_MS * 3
    : REALTIME_OUTLINE_MIN_SILENT_INTERVAL_MS;
}

export function isRealtimeOutlineSilentIntervalActive(session, opts) {
  const updatedAt = getRealtimeOutlineUpdatedAtMs(session);
  return !!(updatedAt && Date.now() - updatedAt < getRealtimeOutlineMinSilentIntervalMs(opts));
}

export function getRealtimeOutlineFailureDelayMs(session) {
  const failures = Math.max(1, Number(session && session.realtimeOutlineFailureCount) || 1);
  return Math.min(
    REALTIME_OUTLINE_FAILURE_BACKOFF_MAX_MS,
    REALTIME_OUTLINE_FAILURE_BACKOFF_BASE_MS * Math.pow(2, Math.min(4, failures - 1))
  );
}

export function markRealtimeOutlineSuccess(session) {
  if (!session) return;
  session.realtimeOutlineFailureCount = 0;
  session.realtimeOutlineNextAllowedAt = 0;
}

export function markRealtimeOutlineFailure(session) {
  if (!session) return;
  const failures = Math.max(0, Number(session.realtimeOutlineFailureCount) || 0) + 1;
  session.realtimeOutlineFailureCount = failures;
  session.realtimeOutlineNextAllowedAt = Date.now() + getRealtimeOutlineFailureDelayMs(session);
}

export function isRealtimeOutlineBackoffActive(session) {
  return !!(session && Number(session.realtimeOutlineNextAllowedAt) > Date.now());
}

export function getRealtimeOutlineQueuedDelayMs(session, opts = {}) {
  const now = Date.now();
  const backoffUntil = Math.max(0, Number(session && session.realtimeOutlineNextAllowedAt) || 0);
  const updatedAt = getRealtimeOutlineUpdatedAtMs(session);
  const intervalUntil = updatedAt
    ? updatedAt + getRealtimeOutlineMinSilentIntervalMs({ local: !!opts.local })
    : 0;
  const deadlineWait = Math.max(backoffUntil - now, intervalUntil - now, 0);
  const floor = Number(session && session.activeSegmentJobs || 0) > 0
    ? REALTIME_OUTLINE_BUSY_RETRY_MS
    : 1000;
  // 定时器可能比目标时刻提前数毫秒触发。留出 guard，避免刚好仍在退避期时
  // shouldRun=false 后丢掉整条重试链。
  return Math.max(floor, deadlineWait > 0 ? deadlineWait + REALTIME_OUTLINE_RETRY_GUARD_MS : 0);
}

export function shouldRunRealtimeOutline(session, opts = {}) {
  if (!session || !Array.isArray(session.segments) || !session.segments.length) return false;
  if (opts.force || opts.final) return true;
  if (isRealtimeOutlineCurrent(session)) return false;
  // recruit-needs 首扫豁免：短会场景下转写 job 常仍在飞，会把会中第一份 coverage 挡掉。
  // 仅"recruit-needs 且尚无既有覆盖产出"时放行首扫，其它模式/后续轮不受影响。
  const isRecruitFirstScan = session.mode === "recruit-needs"
    && !(session.jobPortraitCoverage && session.jobPortraitCoverage.updatedAt);
  if (opts.silent && !isRecruitFirstScan && Number(session.activeSegmentJobs || 0) > 0) return false;
  if (opts.silent && isRealtimeOutlineBackoffActive(session)) return false;
  // recruit-needs 不写 realtimeOutline 内容，用 jobPortraitCoverage.updatedAt 作"已有产出"门槛；
  // 节流用的游标(realtimeOutlineSegmentCount/UpdatedAt)由 coverage-scan 同步写，故内层间隔/新增检查照常生效。
  const hasPriorRealtimeOutput = session.mode === "recruit-needs"
    ? !!(session.jobPortraitCoverage && session.jobPortraitCoverage.updatedAt)
    : !!session.realtimeOutline;
  if (opts.silent && !hasPriorRealtimeOutput && !isRecruitFirstScan) {
    const newSegments = getRealtimeOutlineNewSegmentCount(session);
    const newChars = getRealtimeOutlineNewTextChars(session);
    if (newSegments < REALTIME_OUTLINE_INITIAL_MIN_SEGMENTS
      && newChars < REALTIME_OUTLINE_INITIAL_MIN_CHARS) return false;
  }
  if (opts.silent && hasPriorRealtimeOutput) {
    if (isRealtimeOutlineSilentIntervalActive(session, { local: !!opts.local })) return false;
    const newSegments = getRealtimeOutlineNewSegmentCount(session);
    const newChars = getRealtimeOutlineNewTextChars(session);
    if (newSegments < REALTIME_OUTLINE_MIN_NEW_SEGMENTS && newChars < REALTIME_OUTLINE_MIN_NEW_CHARS) return false;
  }
  return true;
}

// 解析会中 coverage-scan 的 14 维 JSON（防御性）：按 baseline 兜底补全缺维、status 白名单过滤、
// 挡掉编造/格式错的 evidence 锚点、单维不回退合并（防长会尾窗截断导致已覆盖维度闪回 missing）。
export function parseCoverageScanModel(raw, prev, allowFreeze = true) {
  const parsedObj = extractJsonObject(stripModeSuggestionBlocks(String(raw || "")).trim());
  // parse 失败（模型把 JSON 写崩，常因 followup_question 里塞了未转义的引号/换行）→ 别逐维重建成全 missing
  // 把字段树清零；有 prev 时原样保留上一轮结果。扩 schema 抬高了整轮 JSON 崩的概率，这是"突然清零"的防线。
  if (!parsedObj && prev && prev.dims && Object.keys(prev.dims).length) {
    return prev;
  }
  const obj = parsedObj || {};
  const str = (v) => (v == null ? "" : String(v)).trim();
  const VALID = new Set(["covered", "partial", "missing"]);
  const anchorOk = (a) => /\[\[[^\]\n|]+\|\d{1,2}:\d{2}(?::\d{2})?\]\]/.test(String(a || ""));
  // 兼容 dims 是数组或对象两种形态
  const byKey = {};
  const rawDims = obj.dims;
  if (Array.isArray(rawDims)) {
    for (const d of rawDims) { if (d && d.key) byKey[str(d.key)] = d; }
  } else if (rawDims && typeof rawDims === "object") {
    for (const k of Object.keys(rawDims)) byKey[k] = Object.assign({ key: k }, rawDims[k]);
  }
  const fresh = {};
  for (const dim of JOBPORTRAIT_DIMENSIONS) {
    const d = byKey[dim.key] || {};
    let status = str(d.status);
    if (!VALID.has(status)) status = "missing";
    let anchor = str(d.evidence_anchor);
    if (!anchorOk(anchor)) anchor = ""; // 编造/格式错的锚点一律挡掉，避免渲成假可点链接
    fresh[dim.key] = {
      status,
      evidence_anchor: status === "missing" ? "" : anchor,
      missing_what: status === "covered" ? "" : str(d.missing_what),
      // Phase 3：覆盖扫描同轮顺带产出的"追问话术 + 命中模糊词"，寄生在 dim 上，不另起 LLM 调用。
      followup_question: status === "covered" ? "" : str(d.followup_question),
      vague_hits: Array.isArray(d.vague_hits) ? d.vague_hits.map(str).filter(Boolean).slice(0, 3) : [],
    };
  }
  const merged = mergeCoverageNoRegress(fresh, (prev && prev.dims) || {}, allowFreeze);
  const covered = Object.keys(merged).filter((k) => merged[k] && merged[k].status === "covered").length;
  return {
    version: 1,
    dims: merged,
    covered,
    total: JOBPORTRAIT_DIMENSIONS.length,
    updatedAt: new Date().toISOString(),
    segmentCount: (prev && prev.segmentCount) || 0,
  };
}

export const VIEW_TYPE_OUTLINE = "lexvoice-outline-view";

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
