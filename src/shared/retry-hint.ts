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
