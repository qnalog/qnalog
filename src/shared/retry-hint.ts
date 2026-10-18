import { t } from "./i18n";

const MS_PER_MINUTE = 60 * 1000;

/**
 * 待处理任务的「自动重试」提示文案。
 *
 * - `nextRetryAt` 为空、不是有效日期，或不在 `now` 之后时返回空字符串，界面不显示提示。
 * - 剩余不足 60 秒：返回「不到 1 分钟后自动重试」。
 * - 其余情况：剩余时间向上取整到分钟（最少 1 分钟），返回「约 N 分钟后自动重试」。
 *
 * `now` 由调用方传入（毫秒时间戳），便于测试固定时间。
 */
export function formatAutomaticRetryHint(nextRetryAt: string | null | undefined, now: number): string {
  if (!nextRetryAt) return "";
  const retryAt = Date.parse(String(nextRetryAt));
  if (!Number.isFinite(retryAt)) return "";
  const remainingMs = retryAt - now;
  if (remainingMs <= 0) return "";
  if (remainingMs < MS_PER_MINUTE) return t("Automatic retry in under 1 min");
  const minutes = Math.ceil(remainingMs / MS_PER_MINUTE);
  return t("Automatic retry in about {0} min").replace("{0}", String(minutes));
}

/**
 * 转写任务的自动重试时间：取任务自身的 `nextRetryAt` 与转写服务熔断的 `openUntilMs` 中较晚的一个，
 * 只计入尚未到点的时间（熔断已结束时 `openUntilMs` 不计入）。两者都已过或无效时返回空字符串。
 * 熔断只约束转写任务，其它任务类型由调用方传入 0。返回 ISO 时间，供 `formatAutomaticRetryHint` 使用。
 */
export function latestAutomaticRetryAt(nextRetryAt: string | null | undefined, circuitOpenUntilMs: number, now: number): string {
  const candidates: number[] = [];
  if (nextRetryAt) {
    const taskRetryMs = Date.parse(String(nextRetryAt));
    if (Number.isFinite(taskRetryMs)) candidates.push(taskRetryMs);
  }
  const circuitMs = Number(circuitOpenUntilMs);
  if (Number.isFinite(circuitMs) && circuitMs > 0) candidates.push(circuitMs);
  const upcoming = candidates.filter((ms) => ms > now);
  if (!upcoming.length) return "";
  return new Date(Math.max(...upcoming)).toISOString();
}
