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

const ASR_FAMILY_RE = /asr|audio|whisper|stt|speech|transcri|sensevoice|paraformer/i;

const DIARIZATION_EXTRAS: Record<string, string[]> = {
  openrouter: ["microsoft/mai-transcribe-2"],
  bailian: ["qwen-audio-3.0-asr-flash-filetrans", "paraformer-v2"],
};

/** 平台目录 → 某分类的候选；筛空回退全量，diarization 不走目录（原样返回）。 */
export function filterModelsForCategory(ids: string[], category: WizardModelCategory): string[] {
  const all = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id) : [];
  if (category === "asr") {
    const asr = all.filter((id) => ASR_FAMILY_RE.test(id));
    return asr.length ? asr : all.slice();
  }
  if (category === "llm") {
    const llm = all.filter((id) => !ASR_FAMILY_RE.test(id));
    return llm.length ? llm : all.slice();
  }
  return all.slice();
}

/**
 * 说话人分离模型候选：预设默认排最前，再补该平台仓库内已验证的候选。
 * 预设没有导入服务的平台（小米 MiMo）不会走到这里；即便走到也只回默认值。
 */
export function diarizationModelCandidates(providerId: string, presetDefault: string): string[] {
  const out: string[] = [];
  const push = (model: string) => {
    const value = String(model || "").trim();
    if (value && !out.includes(value)) out.push(value);
  };
  push(presetDefault);
  for (const model of DIARIZATION_EXTRAS[providerId] || []) push(model);
  return out;
}
