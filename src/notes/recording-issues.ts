/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：录音问题分类与运行模式归一

import * as obsidian from "obsidian";
import { normalizeAudioInputMode } from "../ui/helpers";

import { isLexVoiceMobileRuntime } from "../shared/util-platform";

import { normalizeKnowledgeExtractionHistory } from "../shared/util-knowledge";

import { normalizeSedimentExtractionModel } from "../sediment";

import { DashScopeStreamingClient, OpenAIRealtimeTranscriptionClient, OpenAIRealtimeTranslationClient } from "../asr/clients";

import { getErrorMessage } from "../shared/util-common";

import { extractSpeakerIdsFromMarkdown, normalizeSpeakerMappings, speakerLabelForChannel } from "../audio/channel-speakers";
import type { SpeakerId } from "../audio/channel-speakers";

export function knowledgeExtractionRecordForFile(file) {
  return {
    mtime: file && file.stat ? Number(file.stat.mtime) || 0 : 0,
    size: file && file.stat ? Number(file.stat.size) || 0 : 0,
    scannedAt: new Date().toISOString(),
  };
}

export function isKnowledgeSourceAlreadyScanned(settings, kind, file) {
  const history = normalizeKnowledgeExtractionHistory(settings && settings.knowledgeExtractionHistory);
  const bucket = history[kind] || {};
  const record = bucket[obsidian.normalizePath(file && file.path || "")];
  if (!record || !file || !file.stat) return false;
  const mtime = Number(file.stat.mtime) || 0;
  const size = Number(file.stat.size) || 0;
  return Number(record.mtime) === mtime && Number(record.size) === size;
}

// 已保存 LLM 配置库的读写辅助
// 规范化转写快照（API 方案里可选携带的转写 provider 配置）。无 providerId 视为无快照。

// API 方案是否「一个 Key 通用」：带转写快照、且转写与 LLM 同一把 Key、同一 host（如 MiMo 两边都 api.xiaomimimo.com）。

// 把工作字段（llmEndpoint/llmApiKey/llmModel）的当前值回写到指定配置

// 抓当前激活转写 provider 的配置成快照（用于存进 API 方案的 asr）。

// 转写字段变更时，把当前激活转写 provider 快照回写进**已激活且本就带转写快照**的方案。
// 只更新已是「完整方案（含 asr）」的激活方案，不给「仅 LLM 旧方案」凭空塞 asr。

// 把指定配置灌进工作字段；若方案带转写快照，同时切换转写服务。

export function resolveRuntimeAudioInputMode(mode) {
  const normalized = normalizeAudioInputMode(mode || "mic");
  return isLexVoiceMobileRuntime() ? "mic" : normalized;
}

// 更新源固定指向官方仓库。曾是设置项，但 normalize 始终把它们重置为默认值（用户值从未生效），
// 实为常量装成设置，故收编为模块常量；自定义更新源如有真实需求应连同 UI 一起正式设计。

// 用户面内置业务意图。内部 key 保留旧字符串以避免迁移破坏老笔记 / tag / base 文件；
// huddle 是 meeting 的子风格，不再单列在新建录音下拉，但老 huddle 笔记仍能被识别和打开。

// 新建录音下拉里出现的公开意图 + 1 个彩蛋；huddle 不出现（仅旧笔记兜底使用）

export function legacyPromptFieldForMode(mode) {
  const map = {
    interview: "polishPromptInterview",
    meeting: "polishPromptMeeting",
    huddle: "polishPromptHuddle",
    seminar: "polishPromptSeminar",
    monologue: "polishPromptMonologue",
    learning: "polishPromptLearning",
  };
  return map[mode] || "";
}

export function cleanRealtimeLlmText(text) {
  return String(text || "").trim()
    .replace(/^```(?:xml|markdown|md|text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

// 深度遍历对象，对所有名字以 apiKey 结尾的字符串字段应用 fn（落盘混淆 / 读取还原），路径无关。
// 覆盖：apiKey / llmApiKey / transcribeApiKey / compatApiKey 以及 providers[].apiKey、profiles[].apiKey 等嵌套。
export function transformApiKeyFieldsDeep(obj, fn, depth = 0) {
  const d = depth || 0;
  if (!obj || typeof obj !== "object" || d > 10) return;
  if (Array.isArray(obj)) {
    for (const item of obj) transformApiKeyFieldsDeep(item, fn, d + 1);
    return;
  }
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "string" && /apikey$/i.test(key)) {
      obj[key] = fn(val);
    } else if (val && typeof val === "object") {
      transformApiKeyFieldsDeep(val, fn, d + 1);
    }
  }
}

// 轻量文本输入弹窗，返回 Promise<string|null>（取消返回 null）

// 检测同步冲突文件名（坚果云/Dropbox/OneDrive 等）
// 坚果云：xxx (冲突 from device YYYY-MM-DD HH:MM).m4a
// Dropbox：xxx (USERNAME's conflicted copy YYYY-MM-DD).m4a
// OneDrive：xxx-DESKTOP-XYZ.m4a 较难识别，仅匹配显式 conflict 字样
// 通用：包含 (冲突…) (…conflicted…) (conflict…) 字样的文件
export function isSyncConflictName(name) {
  if (!name) return false;
  // 全角/半角括号 + 冲突/conflict/conflicted copy 字样
  return /[(（][^)）]*?(冲突|conflict|conflicted\s*copy)[^(（]*[)）]/i.test(name);
}

// 从源纪要 frontmatter 取"人物"维度的人名：同时认 ① 新独立属性 人物（people 别名兼容）
// ② 旧笔记里 tags 的 人物/x 前缀。是"人物单列后"所有消费源纪要人物处的单一收口点。

// 把正文里那段沉淀元数据 HTML 注释「原样」拆出来，返回 { body, block }。
// 用途：写最终纪要时，把这坨机器可读 JSON 从"正文与原始材料之间"挪到笔记最末尾，
// 编辑模式下不再夹在中间难看（阅读视图本就因 HTML 注释而隐藏）。保留原始匹配文本不重排，
// 避免 JSON 轻微不规范时反序列化丢数据。

// ============================================================
// 流式转写客户端工厂：根据 profile.streamProtocol 返回对应实现
// 所有客户端遵守相同接口：connect / sendAudioFrame / finish / getFullText
// 回调：onPartial(text, isFinal) / onError(err) / onClosed(info)
// ============================================================
export function createStreamingTranscriptionClient(profile, provider, callbacks) {
  const opts = Object.assign({}, callbacks || {}, {
    endpoint: provider.endpoint,
    apiKey: provider.apiKey,
    model: provider.model,
    language: provider.language,
    targetLanguage: provider.targetLanguage,
  });
  switch (profile.streamProtocol) {
    case "openai-realtime-transcription":
      return new OpenAIRealtimeTranscriptionClient(opts);
    case "openai-realtime-translation":
      return new OpenAIRealtimeTranslationClient(opts);
    case "dashscope-ws":
    default:
      return new DashScopeStreamingClient(opts);
  }
}

// ============================================================
// PCM 实时编码器：MediaStream → PCM 16-bit mono 帧（默认 16kHz，可设 24kHz）
// 用 ScriptProcessorNode（已废弃但 Electron 下兼容性最好）
// ============================================================

export function isNetworkLikeError(error) {
  const message = getErrorMessage(error);
  if (!message) return false;
  return /failed to fetch|networkerror|fetch failed|err_internet_disconnected|err_network|dns|enotfound|econn(?:reset|refused|aborted)|etimedout|net::/i.test(message);
}

export function classifyRecordingIssue(error) {
  return isNetworkLikeError(error) ? "network" : "service";
}

// 官方限额（usage-guide 2026-06-02 + 实测）：单块 base64 编码字符串 ≤ 10MB（≈7.5MB 原始音频）。
// 留 0.5MB 余量防双方对"10MB"的口径差异。base64 长度 = ceil(bytes/3)*4。
// MiMo 服务端只收 wav / mp3（实测发 audio/mp4 返回 400："mime type must be one of:
// audio/wav, audio/mp3, audio/mpeg"）。其余格式（m4a/flac/ogg/webm…）一律本机解码转 WAV。
// 转码切块时长：16kHz 单声道 16-bit WAV ≈ 1.92MB/分钟，3 分钟 ≈ 5.8MB 原始（base64 ≈ 7.7MB），
// 安全低于 10MB 上限。
// 切块数量上限：160 块 ≈ 8 小时。注意它防的是失控的转码渲染循环——
// 解码（decodeAudioBlob）本身是全量进内存的，超长音频会先在解码处失败，与导入路径行为一致。

// base64 编码后约占原始字节的 4/3。

// 原生格式 → data URL 用的 MIME 前缀（MiMo 靠 MIME 识别格式，不读 format 字段）。
// 服务端白名单仅 audio/wav / audio/mp3 / audio/mpeg，其余 MIME 一律 400。

// 确定性失败：换个时间重试同样必败（格式/解码/超限/4xx 拒绝），标上 nonRetryable 让队列不再空转重试。

// 返回一个或多个待转写块（每块 base64 ≤ 10MB）。
// MiMo 服务端只收 wav/mp3（实测 audio/mp4 直接 400），所以仅这两种且未超限才原样直发；
// 其余格式（webm/m4a/flac/ogg…）或超限块需解码后按时长切 16k 单声道 WAV。
// 注意：Electron 的 decodeAudioData 解不了 mp4/AAC——录音侧已配合（选 MiMo 时录 WebM/Opus），
// 但用其它服务录的旧 m4a 段拿来重转写仍会在此失败，错误信息引导改用 SiliconFlow。

// 单块请求：把一个 ≤10MB(base64) 的 prepared 块发给 MiMo，返回原始文本（不做热词修正，留给上层对全文统一修）。

// 解析一行 SSE "data: {...}"，把 delta/message 文本累加到 state.content。返回是否累加了内容。
// 同时捕获 finish_reason：用于检测"撞 max_tokens 被截断"（finish_reason==="length"），
// 否则半截纪要会被当成完整输出静默落盘，是"用户觉得纪要有错漏"的头号来源。

// 流式读取 LLM 响应：每收到一个 chunk 调一次 onActivity（用于重置空闲超时计时器），
// 边收边累加文本。设计目标——只要 token 还在流动就永不被超时误杀；真中断（如空闲 abort）
// 时也返回已累计内容，不浪费服务端已经生成并计费的部分。
// 返回 { content, finishReason }：finishReason 用于上层检测截断（"length"）。中断场景下若已有内容也带上。

// 兜底：若没解析出任何 SSE 内容，但端点其实返回的是普通 JSON（忽略了 stream 参数），按普通响应取内容。
// 统一返回 { content, finishReason }。

// 拉取 OpenAI 兼容服务的可用模型列表（GET {base}/models）。用 obsidian.requestUrl 绕过 CORS。
// 让「获取可用模型」对 Poe / OpenRouter / MiMo / 硅基 / 本地 等都通用、永不过期，免去手敲 bot 名。

// 简易搜索 + 点选 Modal：从一串字符串里选一个。onPick(选中值) 在点击后调用。

// finish_reason 提取：流式经 requestLlmChatCompletion 透传，普通 JSON 直接来自 API。
// "length" = 撞 max_tokens 截断；"aborted" = 流被空闲超时/网络中断。两者都意味着输出可能不完整。

// 返回 { text, finishReason }——给最终纪要 merge 用，需要据 finishReason 检测截断并告警。

export function mergeBriefingSedimentObjects(parts) {
  const merged = { people: [], hotwords: {}, todos: [] };
  let found = false;
  for (const part of (parts || [])) {
    if (!part || !part.sedimentObjects) continue;
    found = true;
    const normalized = normalizeSedimentExtractionModel(part.sedimentObjects);
    merged.people.push(...(normalized.people || []));
    merged.todos.push(...(normalized.todos || []));
    for (const [key, values] of Object.entries(normalized.hotwords || {})) {
      if (!Array.isArray(merged.hotwords[key])) merged.hotwords[key] = [];
      merged.hotwords[key].push(...(Array.isArray(values) ? values : []));
    }
  }
  return found ? normalizeSedimentExtractionModel(merged) : null;
}

// 从转写正文或已保存映射中读取说话人。已确认姓名时返回「说话人N = 姓名」，
// 让提示词既保留可核验的 ASR 标签，又明确告诉模型应该使用哪个真实姓名。
export function resolveKnownSpeakerLabels(transcript, frontmatter) {
  let ids = extractSpeakerIdsFromMarkdown(String(transcript || ""));
  const raw = frontmatter && typeof frontmatter === "object" ? frontmatter.lexvoice_speakers : null;
  if (!ids.length && raw && typeof raw === "object") {
    ids = Object.keys(raw).filter((id): id is SpeakerId => /^spk-\d+$/.test(id));
  }
  if (!ids.length) return [];
  const mappings = normalizeSpeakerMappings(raw || {}, ids);
  return ids.map((id) => {
    const mapped = mappings[id];
    const label = mapped && mapped.label ? String(mapped.label).trim() : speakerLabelForChannel(Number(String(id).replace(/^spk-/, "")) || 1);
    const personName = mapped && mapped.personName ? String(mapped.personName).trim() : "";
    return personName ? `${label} = ${personName}` : label;
  });
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
