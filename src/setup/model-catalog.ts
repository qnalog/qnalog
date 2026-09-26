// 配置向导的模型候选：平台模型目录的分类过滤 + 说话人分离的仓库内已验证候选。
//
// 分类过滤是启发式：三个平台的 /models 目录都不带「用途」字段，只能按模型 id 的
// 命名族筛选（含 asr/audio/whisper/transcri 等词根的算转写，其余算大模型）。
// 筛空则回退全量——宁可多列也不留空列表。各平台目录的真实内容需带 API Key 实测
// （无 Key 时 MiMo 与百炼返回 401，见交付说明的验证清单）。
//
// 说话人分离不走目录：该分类能用哪些模型由分离协议决定，列错模型会让分离静默失效。
// 候选只列仓库里有依据的：openrouter-diarize 的分离参数只对特定上游生效
// （src/llm/config.ts 注释），dashscope-filetrans 收 DashScope 异步 ASR 模型
// （qwen-audio filetrans 与 paraformer 系列按该协议工作，MAINTAINING §11.1）。

export type WizardModelCategory = "asr" | "llm" | "diarization";

const ASR_FAMILY_RE = /asr|whisper|stt|speech|transcri|sensevoice|paraformer/i;

const DIARIZATION_EXTRAS: Record<string, string[]> = {
  openrouter: ["microsoft/mai-transcribe-2"],
  bailian: ["qwen-audio-3.0-asr-flash-filetrans", "paraformer-v2"],
};

/** 转写模型的平台特例清单。
 * OpenRouter 的 `GET /models` 结构性不列转写模型（architecture.modality 为
 * audio->transcription 的独立注册表；试遍 supported_parameters/category 等参数
 * 均 0 命中），无法枚举——下列 id 于 2026-09-26 经 `/models/{id}/endpoints`
 * 逐个实测 200（whisper / gpt-*-transcribe / qwen3-asr 系）。目录能枚举的
 * 平台（百炼、小米）不放清单，靠命名族实时命中，避免清单过期。 */
const ASR_EXTRAS: Record<string, string[]> = {
  openrouter: [
    "openai/gpt-4o-transcribe",
    "openai/gpt-4o-mini-transcribe",
    "openai/whisper-large-v3",
    "openai/whisper-large-v3-turbo",
    "openai/whisper-1",
    "qwen/qwen3-asr-1.7b",
  ],
};

/** 该平台的转写特例清单（目录枚举不到的已实测 id）。 */
export function asrModelCandidates(providerId: string): string[] {
  return (ASR_EXTRAS[providerId] || []).slice();
}

/** 目录条目：字符串（纯 id）或带分类信息的条目（百炼带 type/模态/描述，OpenRouter 带模态/描述）。 */
type CatalogItem = string | { id: string; type?: string; outputModalities?: string[]; description?: string };

function toEntries(items: CatalogItem[]): Array<Exclude<CatalogItem, string>> {
  const out: Array<Exclude<CatalogItem, string>> = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item === "string") {
      const id = item.trim();
      if (id && !seen.has(id)) { seen.add(id); out.push({ id }); }
    } else if (item && typeof item.id === "string" && item.id.trim()) {
      const id = item.id.trim();
      if (!seen.has(id)) { seen.add(id); out.push({ ...item, id }); }
    }
  }
  return out;
}

/** 转写能力的两个信号：id 命名族、平台 type。
 * 不用「输入含 audio」——那只是理解型 chat 模型的属性，实测把 OpenRouter 的
 * 49 个文本模型全放进了转写列表；也不认 type=audio/speech——语音合成模型会挂这类值。 */
function isAsrFamily(entry: { id: string; type?: string }): boolean {
  if (ASR_FAMILY_RE.test(entry.id)) return true;
  return !!entry.type && /asr|stt|transcri/i.test(entry.type);
}

/** AI 整理要的是纯文本聊天模型：输出模态含 image/video/audio 的是生成类模型
 *（文生图/文生视频/TTS），即使同时输出 text 也排除；没有模态信息的平台条目放行。 */
function isTextChatModel(entry: { outputModalities?: string[] }): boolean {
  const modalities = entry.outputModalities;
  if (!modalities || !modalities.length) return true;
  return modalities.includes("text") && !modalities.some((m) => m === "image" || m === "video" || m === "audio");
}

/** 非聊天族 id（即便模态信息缺失也要排除）：向量、重排、语音合成。 */
const NON_CHAT_ID_RE = /embed|rerank|tts|cosyvoice|sambert/i;

/** 说话人分离能力写在平台描述里：中英文关键词 + 同时具备转写能力（防误收描述里顺带提「说话人」的大模型）。 */
const DIARIZATION_DESC_RE = /说话人|语者|分离|diariz|speaker/i;

/** 平台目录 → 某分类的候选；asr 看命名族/类型/输入模态三信号，llm 排除转写族、
 * 生成类与向量/重排/合成族，筛空回退全量。 */
export function filterModelsForCategory(items: CatalogItem[], category: WizardModelCategory): string[] {
  const entries = toEntries(items);
  const ids = entries.map((entry) => entry.id);
  if (category === "asr") {
    return mergeModelCandidates(entries.filter(isAsrFamily).map((entry) => entry.id));
  }
  if (category === "llm") {
    const llm = entries
      .filter((entry) => !ASR_FAMILY_RE.test(entry.id) && !NON_CHAT_ID_RE.test(entry.id) && isTextChatModel(entry))
      .map((entry) => entry.id);
    return llm.length ? llm : ids.slice();
  }
  return ids;
}

/** 多组合并：保序去重，第一组通常是「框里当前值」，保证它一定在候选里。 */
export function mergeModelCandidates(...groups: string[][]): string[] {
  const out: string[] = [];
  for (const group of groups) {
    for (const id of group) {
      const value = String(id || "").trim();
      if (value && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

/**
 * 说话人分离模型候选：预设默认排最前，再补该平台仓库内已验证的候选，
 * 最后从平台目录里捞「描述写明说话人分离、且具备转写能力」的模型
 *（两个条件同时满足才收，防误收描述里顺带提「说话人」的大模型）。
 * 预设没有导入服务的平台（小米 MiMo）不会走到这里；目录拉取失败时传空数组即可。
 */
export function diarizationModelCandidates(providerId: string, presetDefault: string, catalog: CatalogItem[] = []): string[] {
  const out: string[] = [];
  const push = (model: string) => {
    const value = String(model || "").trim();
    if (value && !out.includes(value)) out.push(value);
  };
  push(presetDefault);
  for (const model of DIARIZATION_EXTRAS[providerId] || []) push(model);
  if (catalog.length) {
    const discovered = toEntries(catalog)
      .filter((entry) => DIARIZATION_DESC_RE.test(entry.description || "") && isAsrFamily(entry))
      .map((entry) => entry.id);
    for (const id of discovered) push(id);
  }
  return out;
}
