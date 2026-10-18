import { afterEach, describe, expect, it } from "vitest";
import { formatAutomaticRetryHint, latestAutomaticRetryAt } from "../src/shared/retry-hint";
import { UI_LANGUAGES, setActiveUiLanguage } from "../src/shared/i18n";

const NOW = Date.parse("2026-10-17T04:00:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const zh = UI_LANGUAGES.find((l) => l.id === "zh")!;
const en = UI_LANGUAGES.find((l) => l.id === "en")!;

afterEach(() => {
  setActiveUiLanguage(en);
});

describe("待处理任务的自动重试提示", () => {
  it("nextRetryAt 为空、缺失或不是有效日期时不显示", () => {
    setActiveUiLanguage(zh);
    expect(formatAutomaticRetryHint("", NOW)).toBe("");
    expect(formatAutomaticRetryHint(undefined, NOW)).toBe("");
    expect(formatAutomaticRetryHint(null, NOW)).toBe("");
    expect(formatAutomaticRetryHint("not a date", NOW)).toBe("");
  });

  it("时间已过或正好到点时不显示", () => {
    setActiveUiLanguage(zh);
    expect(formatAutomaticRetryHint(at(-1000), NOW)).toBe("");
    expect(formatAutomaticRetryHint(at(0), NOW)).toBe("");
  });

  it("不足 60 秒显示「不到 1 分钟」", () => {
    setActiveUiLanguage(zh);
    expect(formatAutomaticRetryHint(at(1), NOW)).toBe("不到 1 分钟后自动重试");
    expect(formatAutomaticRetryHint(at(59_999), NOW)).toBe("不到 1 分钟后自动重试");
  });

  it("满 60 秒起按分钟向上取整", () => {
    setActiveUiLanguage(zh);
    expect(formatAutomaticRetryHint(at(60_000), NOW)).toBe("约 1 分钟后自动重试");
    expect(formatAutomaticRetryHint(at(60_001), NOW)).toBe("约 2 分钟后自动重试");
    expect(formatAutomaticRetryHint(at(4 * 60_000 + 30_000), NOW)).toBe("约 5 分钟后自动重试");
  });

  it("60 分钟边界", () => {
    setActiveUiLanguage(zh);
    expect(formatAutomaticRetryHint(at(60 * 60_000), NOW)).toBe("约 60 分钟后自动重试");
    expect(formatAutomaticRetryHint(at(60 * 60_000 + 1), NOW)).toBe("约 61 分钟后自动重试");
  });

  it("英文界面使用英文文案", () => {
    setActiveUiLanguage(en);
    expect(formatAutomaticRetryHint(at(5 * 60_000), NOW)).toBe("Automatic retry in about 5 min");
    expect(formatAutomaticRetryHint(at(30_000), NOW)).toBe("Automatic retry in under 1 min");
    expect(formatAutomaticRetryHint("", NOW)).toBe("");
  });
});

describe("转写任务的自动重试时间（任务时间与服务熔断取较晚者）", () => {
  it("只有任务自身的 nextRetryAt 时，取该时间", () => {
    expect(latestAutomaticRetryAt(at(120_000), 0, NOW)).toBe(at(120_000));
  });

  it("只有熔断未结束时，取熔断恢复时间（任务没有 nextRetryAt）", () => {
    expect(latestAutomaticRetryAt(undefined, NOW + 300_000, NOW)).toBe(at(300_000));
    expect(latestAutomaticRetryAt("", NOW + 300_000, NOW)).toBe(at(300_000));
  });

  it("两者都有且都未到点时，取较晚的一个", () => {
    expect(latestAutomaticRetryAt(at(120_000), NOW + 300_000, NOW)).toBe(at(300_000));
    expect(latestAutomaticRetryAt(at(400_000), NOW + 300_000, NOW)).toBe(at(400_000));
  });

  it("熔断已结束时不计入，只用任务时间", () => {
    expect(latestAutomaticRetryAt(at(120_000), NOW - 1, NOW)).toBe(at(120_000));
    expect(latestAutomaticRetryAt(at(120_000), NOW, NOW)).toBe(at(120_000));
  });

  it("熔断未开启且任务没有 nextRetryAt 时返回空字符串", () => {
    expect(latestAutomaticRetryAt(undefined, 0, NOW)).toBe("");
    expect(latestAutomaticRetryAt(undefined, NOW - 1, NOW)).toBe("");
  });

  it("两个时间都已过去或无效时返回空字符串", () => {
    expect(latestAutomaticRetryAt(at(-1000), NOW - 1000, NOW)).toBe("");
    expect(latestAutomaticRetryAt("not a date", 0, NOW)).toBe("");
    expect(latestAutomaticRetryAt("not a date", Number.NaN, NOW)).toBe("");
  });

  it("组合结果交给 formatAutomaticRetryHint 时显示熔断剩余分钟", () => {
    setActiveUiLanguage(zh);
    expect(formatAutomaticRetryHint(latestAutomaticRetryAt(undefined, NOW + 4 * 60_000 + 30_000, NOW), NOW)).toBe("约 5 分钟后自动重试");
  });
});

