// 思考档：default（默认，不动请求）/ reasoning（推理，显式开）/ fast（快速，关思维链省 token）。
// 「能不能改」按 endpoint 主机 + 模型判定——只对已核实关思考参数的服务返回 capability，其它返回 null（UI 灰掉、不可选）。
// 三大已核实的参数家族（OpenAI 兼容 body，顶层字段；QnALog 是裸 fetch 直接拼 body，不走 SDK 的 extra_body）：
//   · enable_thinking: false/true        —— 小米 MiMo / 硅基流动 / 阿里百炼(Qwen3)
//   · thinking: { type: "disabled"|"enabled" } —— DeepSeek / 火山方舟 Doubao / 智谱 GLM
//   · reasoning_effort: "low"|"high"     —— OpenAI(gpt-5/o系) / Gemini-2.5 / xAI(grok-mini/4) / Groq(推理模型)
// 纯函数、无外部依赖，可独立单测。

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Thinking controls mutate OpenAI-compatible request payloads whose shape varies by provider. */
function hostOf(endpoint) {
  const raw = String(endpoint == null ? "" : endpoint).trim();
  try { return new URL(raw).hostname.toLowerCase(); } catch { return raw.toLowerCase(); }
}

function isTokenPlanEndpoint(endpoint) {
  return /token-plan/i.test(String(endpoint || ""));
}

// 返回 { family, service } 或 null（null = 当前服务不支持调节思考档 → UI 应灰掉）。
export function getThinkingControl(endpoint, model) {
  const host = hostOf(endpoint);
  const m = String(model == null ? "" : model).toLowerCase();
  if (isTokenPlanEndpoint(endpoint)) return null;
  // enable_thinking 家族
  if (host.includes("xiaomimimo.com")) return { family: "enable_thinking", service: "小米 MiMo" };
  if (host.includes("siliconflow")) return { family: "enable_thinking", service: "硅基流动" };
  if (host.includes("dashscope")) return { family: "enable_thinking", service: "阿里百炼" };
  // thinking:{type} 家族
  if (host.includes("deepseek.com")) return { family: "thinking_type", service: "DeepSeek" };
  if (host.includes("volces.com")) return { family: "thinking_type", service: "火山方舟" };
  if (host.includes("bigmodel.cn")) return { family: "thinking_type", service: "智谱 GLM" };
  // reasoning_effort 家族——仅当模型确为推理模型时才可控（否则对非推理模型发该参数会 400）
  if (host.includes("api.openai.com") && /(gpt-5|\bo1|\bo3|\bo4)/.test(m)) return { family: "reasoning_effort", service: "OpenAI" };
  if (host.includes("x.ai") && /grok-(3-mini|4)/.test(m)) return { family: "reasoning_effort", service: "xAI" };
  if (host.includes("generativelanguage.googleapis.com") && /gemini-2\.5/.test(m)) return { family: "reasoning_effort", service: "Gemini" };
  if (host.includes("groq.com") && /(qwen3|deepseek-r1|gpt-oss|reasoning)/.test(m)) return { family: "reasoning_effort", service: "Groq" };
  return null;
}

// 把思考档参数注入请求体（就地修改 payload 并返回它）。mode=default 或服务不可控时不动 payload。
export function applyThinkingParam(payload, mode, endpoint, model) {
  if (!payload || (mode !== "fast" && mode !== "reasoning")) return payload;
  const ctrl = getThinkingControl(endpoint, model);
  if (!ctrl) return payload;
  const on = mode === "reasoning";
  if (ctrl.family === "enable_thinking") {
    payload.enable_thinking = on;
  } else if (ctrl.family === "thinking_type") {
    payload.thinking = { type: on ? "enabled" : "disabled" };
  } else if (ctrl.family === "reasoning_effort") {
    payload.reasoning_effort = on ? "high" : "low";
  }
  return payload;
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- end of dynamic-typing region */
