/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：实时大纲：状态机、提示词与增量判据

import { cleanRealtimeLlmText } from "./recording-issues";

import { getAudioTimeLink, getSegmentAudioLinkOffsetMs } from "./audio-refs";

import { cleanRealtimeOutlineItemText, makeRealtimeOutlineNode, normalizeRealtimeOutlineList, parseRealtimeOutlineStateFromMarkdown } from "../outline-text";

import { normalizeAudioInputMode } from "../ui/helpers";



import { formatElapsed } from "../shared/util-common";
import { NS_VIEW_OUTLINE } from "../shared/namespace";


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

export function buildRollingOutlineContext(previousMemory, previousOutline, windowed, opts: { programOwnedMemory?: boolean } = {}) {
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
      "- <qnalog-outline> **只返回本轮增量**，不要复制【当前可见大纲参考】中的任何未变化条目。",
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

export function buildRealtimeOutlineEnvelopeInstruction(opts: { incremental?: boolean } = {}) {
  const incremental = !!(opts && opts.incremental);
  return [
    "【输出协议】",
    "请严格输出两个 XML 风格块，不要前言、不要解释、不要代码围栏：",
    "",
    "<qnalog-memory>",
    "写给后续轮次使用的主题记忆 / 滚动摘要。",
    "</qnalog-memory>",
    "",
    "<qnalog-outline>",
    "写给用户看的实时大纲 Markdown 列表。",
    "</qnalog-outline>",
    "",
    "【主题记忆写法】",
    "- 这是隐藏的长期上下文，不是最终纪要，不要写成漂亮文章。",
    "- 记录会议/课程主线、已出现的重要对象、待追踪问题、用户用 # / ？ / ！ / TODO / @ 标记过的意图和大致时间。",
    "- 长录音可以逐步增长，但要压缩；优先保留能帮助后续理解的话题脉络，而不是抄原文。",
    "- 控制在 600 字以内；如果信息变多，合并同类项，不要线性增长。",
    "- 不要写“未提及”“待确认”这类空字段。",
    "",
    "【可见大纲写法】",
    "- <qnalog-outline> 内只能放用户可读的大纲列表。",
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
    .replace(/<qnalog-memory\b[^>]*>[\s\S]*?<\/qnalog-memory>/gi, "")
    .replace(/<qnalog-outline\b[^>]*>[\s\S]*?<\/qnalog-outline>/gi, "")
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
  let memory = extractRealtimeTaggedBlock(cleaned, "qnalog-memory");
  let outline = extractRealtimeTaggedBlock(cleaned, "qnalog-outline");
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

export function normalizeRealtimeOutlineState(value, fallbackMarkdown = undefined, fallbackMemory = undefined) {
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

export function buildProgramOwnedOutlineAnchorInstruction() {
  return `【回听位置】
你只负责判断主题和组织要点，不负责生成时间戳。
- 不要输出、复制或校对 \`[[音频文件|HH:MM]]\`。
- QnALog 会在收到结构后，根据真实转写分段为一级节点挂上近似回听位置。
- 具体秒数不参与内容质量判断；即使无法挂载时间，也要完整输出合格的大纲结构。`;
}


// 前缀缓存优化：所有稳定指令（含语种指令）放在前面，变化的「转写上下文」严格放最后。
// 这样 DeepSeek 等支持自动前缀缓存的服务商，每轮能命中"从头到 实时整理上下文："的稳定前缀，
// 只对变化的转写部分重新计算 —— 纯降本提速，不改输出质量。
// languageInstruction 由调用方传入并前置（不要再用 applyBriefingLanguageInstruction 追加到末尾，
// 否则语种指令会落在变化内容之后、进入不可缓存的尾巴）。
export function buildOutlinePrompt(modeLabel, modeKey, transcript, captureMode, languageInstruction, opts: { incremental?: boolean } = {}) {
  const langBlock = languageInstruction ? `\n\n${String(languageInstruction).trim()}` : "";
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
- <qnalog-outline> 内使用纯 Markdown 列表，缩进表达层级
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
  const hasPriorOutput = !!(session && session.realtimeOutline);
  if (!hasPriorOutput) {
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

export function getRealtimeOutlineQueuedDelayMs(session, opts: { local?: boolean } = {}) {
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

export function shouldRunRealtimeOutline(session, opts: { force?: boolean; final?: boolean; silent?: boolean; local?: boolean } = {}) {
  if (!session || !Array.isArray(session.segments) || !session.segments.length) return false;
  if (opts.force || opts.final) return true;
  if (isRealtimeOutlineCurrent(session)) return false;
  // 转写任务仍在飞时，静默轮先不跑：拿到的转写不完整，生成的大纲容易被随后的分段推翻。
  if (opts.silent && Number(session.activeSegmentJobs || 0) > 0) return false;
  if (opts.silent && isRealtimeOutlineBackoffActive(session)) return false;
  const hasPriorRealtimeOutput = !!session.realtimeOutline;
  if (opts.silent && !hasPriorRealtimeOutput) {
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

export const VIEW_TYPE_OUTLINE = NS_VIEW_OUTLINE;

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
