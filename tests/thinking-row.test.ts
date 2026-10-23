import { describe, expect, it } from "vitest";
import { normalizeThinkingModeValue, shouldShowThinkingRow } from "../src/llm/thinking-row";

describe("shouldShowThinkingRow", () => {
  it("is true for services with a verified thinking parameter", () => {
    expect(shouldShowThinkingRow("https://api.deepseek.com", "deepseek-chat")).toBe(true);
    expect(shouldShowThinkingRow("https://api.openai.com/v1", "gpt-5.5")).toBe(true);
    expect(shouldShowThinkingRow("https://api.openai.com/v1", "gpt-6-luna")).toBe(true);
    expect(shouldShowThinkingRow("https://api.openai.com/v1", "gpt-6.1-sol")).toBe(true);
  });

  it("is false for unsupported services, models and a gpt-6 name on another host", () => {
    expect(shouldShowThinkingRow("https://api.openai.com/v1", "gpt-4.1-mini")).toBe(false);
    expect(shouldShowThinkingRow("https://api.example.com/v1", "gpt-6-luna")).toBe(false);
    expect(shouldShowThinkingRow("https://token-plan-cn.xiaomimimo.com/v1", "mimo-v2.5-pro")).toBe(false);
    expect(shouldShowThinkingRow("", "")).toBe(false);
  });
});

describe("normalizeThinkingModeValue", () => {
  it("keeps fast and reasoning, maps anything else to auto", () => {
    expect(normalizeThinkingModeValue("fast")).toBe("fast");
    expect(normalizeThinkingModeValue("reasoning")).toBe("reasoning");
    expect(normalizeThinkingModeValue("auto")).toBe("auto");
    expect(normalizeThinkingModeValue("x")).toBe("auto");
    expect(normalizeThinkingModeValue(undefined)).toBe("auto");
  });
});
