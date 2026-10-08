import { afterEach, describe, expect, it } from "vitest";
import { formatLlmConfigIssue, formatLlmFailureIssue } from "../src/llm/failure-presentation";
import { getActiveUiLanguage, matchUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

const originalLanguage = getActiveUiLanguage();
afterEach(() => setActiveUiLanguage(originalLanguage));

describe("LLM failure guidance", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["false", false],
    ["zero", 0],
    ["empty", ""],
    ["whitespace", " \n\t "],
  ])("returns empty guidance for %s", (_name, issue) => {
    expect(formatLlmConfigIssue(issue)).toBe("");
    expect(formatLlmFailureIssue(issue)).toBe("");
  });

  it.each([
    ["en", "LLM model name is not configured. Please complete it under Settings → API → AI organizing service, then test the connection."],
    ["zh", "LLM model name is not configured。请到「设置 → API → AI 整理服务」补齐后先测试连接。"],
  ])("formats configuration and service guidance in %s", (language, configExpected) => {
    setActiveUiLanguage(matchUiLanguage(language)!);
    expect(formatLlmConfigIssue("  LLM model name is not configured  ")).toBe(configExpected);
    expect(formatLlmFailureIssue("LLM model name is not configured")).toBe(configExpected);
    expect(formatLlmFailureIssue("no available account")).toBe(language === "en"
      ? "no available account. This is a problem returned by the LLM service or account pool, not caused by text length, ASR, or the text-import path; switch the model/endpoint, or retry manually later."
      : "no available account。这是大模型服务端或账号池返回的问题，不是文本长度、ASR 或文本导入路径导致的；请切换模型/端点，或稍后手动重试。");
    expect(formatLlmFailureIssue("LLM model name is not configured; no available account"))
      .toBe(language === "en"
        ? "LLM model name is not configured; no available account. Please complete it under Settings → API → AI organizing service, then test the connection."
        : "LLM model name is not configured; no available account。请到「设置 → API → AI 整理服务」补齐后先测试连接。");
  });

  it.each([
    ["en", "Settings → API"],
    ["zh", "请到「设置"],
  ])("does not duplicate existing configuration guidance in %s", (language, marker) => {
    setActiveUiLanguage(matchUiLanguage(language)!);
    expect(formatLlmConfigIssue(`  ${marker} is already present  `)).toBe(`${marker} is already present`);
    expect(formatLlmFailureIssue(`LLM model name is not configured. ${marker} is already present`))
      .toBe(`LLM model name is not configured. ${marker} is already present`);
  });

  it("retains String conversion semantics without reading message fields", () => {
    expect(formatLlmFailureIssue("  temporary failure  ")).toBe("temporary failure");
    expect(formatLlmFailureIssue(new Error("no available account"))).toContain("Error: no available account. This is a problem returned");
    expect(formatLlmFailureIssue({ message: "no available account" })).toBe("[object Object]");
    expect(formatLlmFailureIssue({ toString: () => "no available account" })).toContain("This is a problem returned by the LLM service");

    const messageGetter = Object.defineProperty({}, "message", { get: () => { throw new Error("message read"); } });
    expect(formatLlmFailureIssue(messageGetter)).toBe("[object Object]");
    const conversionFailure = new Error("conversion failed");
    expect(() => formatLlmFailureIssue({ toString: () => { throw conversionFailure; } })).toThrow(conversionFailure);
  });

  it("uses the active language at each call", () => {
    setActiveUiLanguage(matchUiLanguage("en")!);
    expect(formatLlmFailureIssue("no available account")).toContain("This is a problem returned");
    setActiveUiLanguage(matchUiLanguage("zh")!);
    expect(formatLlmFailureIssue("no available account")).toContain("这是大模型服务端或账号池返回的问题");
  });
});
