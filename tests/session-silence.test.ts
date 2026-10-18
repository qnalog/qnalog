import { describe, expect, it } from "vitest";
import { SESSION_SILENCE_MAX_VOICED_SHARE, SESSION_SILENCE_MIN_TICKS, isEssentiallySilentSession } from "../src/audio/session-silence";

describe("整场是否基本无声", () => {
  it("计数不足最少次数时不下结论，按有声处理", () => {
    expect(isEssentiallySilentSession(0, 0)).toBe(false);
    expect(isEssentiallySilentSession(0, SESSION_SILENCE_MIN_TICKS - 1)).toBe(false);
    expect(isEssentiallySilentSession(0, SESSION_SILENCE_MIN_TICKS)).toBe(true);
  });

  it("全部为无声计数时判定为无声", () => {
    expect(isEssentiallySilentSession(0, 6)).toBe(true);
    expect(isEssentiallySilentSession(0, 600)).toBe(true);
  });

  it("有声占比低于上限才判定为无声；达到上限即视为有声", () => {
    expect(SESSION_SILENCE_MAX_VOICED_SHARE).toBe(0.02);
    expect(isEssentiallySilentSession(1, 99)).toBe(true);
    expect(isEssentiallySilentSession(2, 98)).toBe(false);
    expect(isEssentiallySilentSession(1, 4)).toBe(false);
  });

  it("极短会话中的单次有声计数即视为有声", () => {
    expect(isEssentiallySilentSession(1, 5)).toBe(false);
    expect(isEssentiallySilentSession(1, 6)).toBe(false);
  });

  it("无效或负数计数按 0 处理", () => {
    expect(isEssentiallySilentSession(Number.NaN, 10)).toBe(true);
    expect(isEssentiallySilentSession(-3, 10)).toBe(true);
    expect(isEssentiallySilentSession(Number.POSITIVE_INFINITY, 10)).toBe(true);
    expect(isEssentiallySilentSession(undefined as unknown as number, 10)).toBe(true);
  });
});
