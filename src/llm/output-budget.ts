// Runtime capability learning for OpenAI-compatible LLM endpoints.
// Model names are not a reliable contract: gateways often rename models or expose
// a different output parameter/limit. Keep the learned state in memory and only
// lower a request after the endpoint has explicitly rejected it.

export type LlmOutputParameter = "max_tokens" | "max_completion_tokens";

type LlmCapability = {
  maxOutputTokens?: number;
  outputParameter?: LlmOutputParameter;
};

const capabilities = new Map<string, LlmCapability>();

function normalizeEndpoint(endpoint: unknown) {
  return (typeof endpoint === "string" ? endpoint : "").trim().replace(/\/+$/, "").toLowerCase();
}

function normalizeModel(model: unknown) {
  return (typeof model === "string" ? model : "").trim().toLowerCase();
}

export function getLlmCapabilityKey(endpoint: unknown, model: unknown) {
  return `${normalizeEndpoint(endpoint)}\n${normalizeModel(model)}`;
}

export function getLearnedLlmCapability(endpoint: unknown, model: unknown): LlmCapability {
  const value = capabilities.get(getLlmCapabilityKey(endpoint, model));
  return value ? Object.assign({}, value) : {};
}

export function getLearnedLlmOutputCeiling(settings: unknown) {
  const source = settings && typeof settings === "object" ? settings as Record<string, unknown> : {};
  const value = getLearnedLlmCapability(source.llmEndpoint, source.llmModel).maxOutputTokens;
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : 0;
}

export function getLearnedLlmOutputParameter(settings: unknown): LlmOutputParameter {
  const source = settings && typeof settings === "object" ? settings as Record<string, unknown> : {};
  return getLearnedLlmCapability(source.llmEndpoint, source.llmModel).outputParameter || "max_tokens";
}

export function rememberLlmOutputCeiling(settings: unknown, maxOutputTokens: unknown) {
  const source = settings && typeof settings === "object" ? settings as Record<string, unknown> : {};
  const next = Number(maxOutputTokens);
  if (!Number.isFinite(next) || next <= 0) return;
  const key = getLlmCapabilityKey(source.llmEndpoint, source.llmModel);
  if (key === "\n") return;
  const current = capabilities.get(key) || {};
  const currentLimit = Number(current.maxOutputTokens);
  current.maxOutputTokens = Number.isFinite(currentLimit) && currentLimit > 0
    ? Math.min(Math.floor(currentLimit), Math.floor(next))
    : Math.floor(next);
  capabilities.set(key, current);
}

export function rememberLlmOutputParameter(settings: unknown, parameter: LlmOutputParameter) {
  const source = settings && typeof settings === "object" ? settings as Record<string, unknown> : {};
  if (parameter !== "max_tokens" && parameter !== "max_completion_tokens") return;
  const key = getLlmCapabilityKey(source.llmEndpoint, source.llmModel);
  if (key === "\n") return;
  const current = capabilities.get(key) || {};
  current.outputParameter = parameter;
  capabilities.set(key, current);
}

export function getLlmOutputBudgetFromOptions(options: unknown) {
  const source = options && typeof options === "object" ? options as Record<string, unknown> : {};
  const payload = source.payload && typeof source.payload === "object" ? source.payload as Record<string, unknown> : {};
  const raw = payload.max_completion_tokens ?? payload.max_tokens;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function getEffectiveLlmOutputBudget(settings: unknown, options: unknown) {
  const requested = getLlmOutputBudgetFromOptions(options);
  const learned = getLearnedLlmOutputCeiling(settings);
  if (!requested) return learned;
  return learned > 0 ? Math.min(requested, learned) : requested;
}

export function applyLearnedLlmCapability(settings: unknown, payload: Record<string, unknown>) {
  const next = Object.assign({}, payload || {});
  const parameter = getLearnedLlmOutputParameter(settings);
  if (parameter === "max_completion_tokens" && next.max_tokens != null && next.max_completion_tokens == null) {
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
  }
  const ceiling = getLearnedLlmOutputCeiling(settings);
  if (ceiling > 0) {
    for (const key of ["max_tokens", "max_completion_tokens"] as const) {
      if (next[key] == null) continue;
      const requested = Number(next[key]);
      if (Number.isFinite(requested) && requested > ceiling) next[key] = ceiling;
    }
  }
  return next;
}

export function resetLearnedLlmCapabilities() {
  capabilities.clear();
}
