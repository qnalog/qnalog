/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。
import { NS_ID_PREFIX } from "./namespace";

/** 判为字符串键的对象；用作类型谓词，让调用方收窄 unknown 后可直接取属性。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function primitiveText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

export function getErrorMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return primitiveText(error);
}

export function pickDefined<T>(...args: (T | undefined)[]): T | undefined {
  for (const value of args) {
    if (value !== undefined) return value;
  }
  return undefined;
}

export function genId(): string {
  return NS_ID_PREFIX + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}


export function pad(n: number): string { return n < 10 ? "0" + n : "" + n; }

export function formatElapsed(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function sanitizeFilename(s: unknown): string {
  if (!s) return "";
  return primitiveText(s)
    .replace(/["“”‘’`]/g, "")
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/[｜：？＊＜＞＂＃＾「」『』【】、，。；！]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
}

export function escapeRegExp(s: unknown): string {
  return primitiveText(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripHtmlText(text: unknown): string {
  return primitiveText(text)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export function safeDecodeUriText(text: unknown): string {
  try { return decodeURIComponent(primitiveText(text)); }
  catch { return primitiveText(text); }
}

export function normalizeAudioLinkTarget(linkPath: unknown): string {
  let target = primitiveText(linkPath).split("#")[0].split("|")[0].trim();
  if (!target) return "";
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
      const url = new URL(target);
      target = url.searchParams.get("file")
        || url.searchParams.get("path")
        || url.searchParams.get("target")
        || url.pathname;
    }
  } catch { /* intentionally empty */ }
  target = safeDecodeUriText(target).replace(/^\/+/, "").trim();
  return target;
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
