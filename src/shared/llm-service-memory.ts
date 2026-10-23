// 各 AI 整理服务的「上次使用配置」：读回时的清洗。
// 存储位置 composer.serviceMemory；其中的 apiKey 字段与其它密钥一样由 api-key-storage 按路径写入 SecretStorage。

import type { LlmServiceMemoryEntry } from "./types";

const SERVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 只保留 id 合法、三个字段为字符串的条目；其余丢弃。结果是新对象。 */
export function normalizeLlmServiceMemory(input: unknown): Record<string, LlmServiceMemoryEntry> {
  const out: Record<string, LlmServiceMemoryEntry> = {};
  if (!isRecord(input)) return out;
  for (const id of Object.keys(input)) {
    if (!SERVICE_ID_RE.test(id) || id === "__proto__" || id === "constructor" || id === "prototype") continue;
    const item = input[id];
    if (!isRecord(item)) continue;
    out[id] = {
      endpoint: typeof item.endpoint === "string" ? item.endpoint.trim() : "",
      apiKey: typeof item.apiKey === "string" ? item.apiKey : "",
      model: typeof item.model === "string" ? item.model.trim() : "",
    };
  }
  return out;
}
