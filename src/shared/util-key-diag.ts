import { NS_LEGACY_KEY_OBFUSCATION_MARKER, NS_LEGACY_KEY_OBFUSCATION_SALT } from "./namespace";
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。

const stringifyDiagnosticValue = String as (value: unknown) => string;

function readDiagnosticField(
  value: unknown,
  field: "name" | "message" | "stack" | "status" | "statusDetail" | "nonRetryable",
): unknown {
  if (!value) return value;
  if (typeof value === "object" || typeof value === "function") return Reflect.get(value, field);
  return undefined;
}

function base64ToUtf8(value: string): string {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}


/**
 * 解混淆。两种输入：
 * - 带 marker 前缀：用 salt 解出明文。
 * - 无 marker：视为明文（用户手填），原样返回。
 *
 * 前缀不匹配时不返回原文：无法识别的串按「解不出来」处理，让用户重填，
 * 避免把一段无关文本当成 API Key 发出去。
 */
export function deobfuscateApiKey(stored: unknown): string {
  const s = stringifyDiagnosticValue(stored == null ? "" : stored);
  if (!s.startsWith(NS_LEGACY_KEY_OBFUSCATION_MARKER)) return s;
  try {
    return qnalogXorTransform(base64ToUtf8(s.slice(NS_LEGACY_KEY_OBFUSCATION_MARKER.length)));
  } catch { return s; }
}

// 仅用于读取旧 data.json 中的混淆密钥；新密钥由 Obsidian SecretStorage 管理。


export function redactDiagnosticText(value: unknown): string {
  return stringifyDiagnosticValue(value == null ? "" : value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*['"]?[^'"\s,;]+/gi, "$1=<redacted>")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]+)\b/g, "<redacted-token>")
    .replace(/C:\\Users\\[^\\\s]+/gi, "C:\\Users\\<user>")
    .replace(/\/Users\/[^/\s]+/gi, "/Users/<user>")
    .replace(/\/home\/[^/\s]+/gi, "/home/<user>")
    .replace(/\b(?!C:\\Users\\<user>)[A-Z]:\\[^\\\r\n]+(?:\\[^\\\r\n\s]+){1,}/g, "<local-path>")
    .slice(0, 1200);
}

export function sanitizeDiagnosticData(data: unknown, depth = 0): unknown {
  if (data == null) return data;
  if (depth > 3) return "[depth-limit]";
  if (typeof data === "string") return redactDiagnosticText(data);
  if (typeof data === "number" || typeof data === "boolean") return data;
  if (data instanceof Error) return diagnosticError(data);
  if (Array.isArray(data)) {
    const items: unknown[] = data;
    return items.slice(0, 20).map(value => sanitizeDiagnosticData(value, depth + 1));
  }
  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).slice(0, 40)) {
      if (/apiKey|authorization|token|secret|password|prompt|transcript|text|content/i.test(key)) {
        out[key] = "<redacted>";
      } else if (/path$/i.test(key)) {
        out[key] = diagnosticPathLabel(record[key]);
      } else {
        out[key] = sanitizeDiagnosticData(record[key], depth + 1);
      }
    }
    return out;
  }
  return redactDiagnosticText(stringifyDiagnosticValue(data));
}

export function qnalogXorTransform(text: string): string {
  const salt = NS_LEGACY_KEY_OBFUSCATION_SALT;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    out += String.fromCharCode(text.charCodeAt(i) ^ salt.charCodeAt(i % salt.length));
  }
  return out;
}

export function diagnosticPathLabel(path: unknown): string {
  const text = stringifyDiagnosticValue(path || "").replace(/\\/g, "/");
  return redactDiagnosticText(text.split("/").pop() || text);
}

export function diagnosticError(error: unknown): Record<string, unknown> {
  const e = error || {};
  const out: Record<string, unknown> = {
    name: redactDiagnosticText(readDiagnosticField(e, "name") || "Error"),
    message: redactDiagnosticText(readDiagnosticField(e, "message") || stringifyDiagnosticValue(error || "")),
    stack: readDiagnosticField(e, "stack")
      ? redactDiagnosticText(stringifyDiagnosticValue(readDiagnosticField(e, "stack")).split("\n").slice(0, 4).join("\n"))
      : "",
  };
  if (readDiagnosticField(e, "status") !== undefined) out.status = readDiagnosticField(e, "status");
  if (readDiagnosticField(e, "statusDetail") !== undefined) {
    out.statusDetail = redactDiagnosticText(readDiagnosticField(e, "statusDetail"));
  }
  if (readDiagnosticField(e, "nonRetryable") !== undefined) {
    out.nonRetryable = !!readDiagnosticField(e, "nonRetryable");
  }
  return out;
}
