import { describe, expect, it } from "vitest";
import { formatRecentDurationText, formatRecentMetaParts, formatRecentMetaTime } from "../src/recent/recent-meta-format";

const english = (key: string) => key;
const chinese = (key: string) => ({
  "{0}s": "{0} 秒",
  "{0}m {1}s": "{0} 分 {1} 秒",
  "{0}h {1}m": "{0} 小时 {1} 分",
  "Today {0}": "今天 {0}",
  "Yesterday {0}": "昨天 {0}",
}[key] || key);

describe("recent metadata formatters", () => {
  it("formats durations in English with seconds, minutes, and hours", () => {
    const cases: Array<[number, string]> = [
      [0, "0s"],
      [42_000, "42s"],
      [59_000, "59s"],
      [60_000, "1m 0s"],
      [15 * 60_000 + 53_000, "15m 53s"],
      [59 * 60_000 + 59_000, "59m 59s"],
      [60 * 60_000, "1h 00m"],
      [65 * 60_000 + 30_000, "1h 05m"],
    ];
    for (const [ms, expected] of cases) expect(formatRecentDurationText(ms, english)).toBe(expected);
    expect(formatRecentDurationText(Number.NaN, english)).toBe("");
    expect(formatRecentDurationText(-1, english)).toBe("");
    expect(formatRecentDurationText(Number.POSITIVE_INFINITY, english)).toBe("");
  });

  it("formats durations in Chinese with the same boundaries", () => {
    const cases: Array<[number, string]> = [
      [0, "0 秒"],
      [42_000, "42 秒"],
      [59_000, "59 秒"],
      [60_000, "1 分 0 秒"],
      [15 * 60_000 + 53_000, "15 分 53 秒"],
      [59 * 60_000 + 59_000, "59 分 59 秒"],
      [60 * 60_000, "1 小时 00 分"],
      [65 * 60_000 + 30_000, "1 小时 05 分"],
    ];
    for (const [ms, expected] of cases) expect(formatRecentDurationText(ms, chinese)).toBe(expected);
  });

  it("formats today, yesterday, dates, midnight boundaries, and date-only names", () => {
    const now = new Date(2026, 8, 18, 0, 5).getTime();
    const format = (date: Date, hasTime = true) => formatRecentMetaTime(date.getTime(), now, {
      includeDate: true,
      hasTime,
      translate: chinese,
    });
    expect(format(new Date(2026, 8, 18, 0, 1))).toBe("今天 00:01");
    expect(format(new Date(2026, 8, 17, 23, 55))).toBe("昨天 23:55");
    expect(format(new Date(2026, 8, 9, 19, 34))).toBe("09-09 19:34");
    expect(format(new Date(2025, 8, 17, 19, 34))).toBe("2025-09-17 19:34");
    expect(format(new Date(2026, 8, 17, 15, 0), false)).toBe("昨天");
    expect(format(new Date(2026, 8, 18, 0, 0), false)).toBe("今天");
  });

  it("keeps time-group rows compact and returns empty for invalid timestamps", () => {
    const options = { includeDate: false, hasTime: true, translate: chinese };
    expect(formatRecentMetaTime(new Date(2026, 8, 18, 19, 34).getTime(), Date.now(), options)).toBe("19:34");
    expect(formatRecentMetaTime(new Date(2026, 8, 18).getTime(), Date.now(), { ...options, hasTime: false })).toBe("09-18");
    expect(formatRecentMetaTime(Number.NaN, Date.now(), options)).toBe("");
  });

  it("omits empty duration metadata without leaving a separator", () => {
    const parts = formatRecentMetaParts("19:34", "综合纪要", "");
    expect(parts.map((part) => part.value).join(" · ")).toBe("19:34 · 综合纪要");
    expect(formatRecentMetaParts("19:34", "综合纪要", "15 分 53 秒").map((part) => part.value).join(" · "))
      .toBe("19:34 · 综合纪要 · 15 分 53 秒");
  });
});
