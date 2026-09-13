import { describe, expect, it } from "vitest";
import { applyThinkingParam, getThinkingControl } from "../src/llm/thinking";

describe("getThinkingControl", () => {
  it("detects enable_thinking providers", () => {
    expect(getThinkingControl("https://api.xiaomimimo.com/v1", "mimo-v2.5-pro")?.family).toBe("enable_thinking");
    expect(getThinkingControl("https://api.siliconflow.cn/v1/chat/completions", "Qwen/Qwen3-32B")?.family).toBe("enable_thinking");
    expect(getThinkingControl("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3-235b")?.family).toBe("enable_thinking");
  });

  it("detects thinking type providers", () => {
    expect(getThinkingControl("https://api.deepseek.com", "deepseek-reasoner")?.family).toBe("thinking_type");
    expect(getThinkingControl("https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-1-6")?.family).toBe("thinking_type");
    expect(getThinkingControl("https://open.bigmodel.cn/api/paas/v4", "glm-4.6")?.family).toBe("thinking_type");
  });

  it("detects reasoning_effort providers only for reasoning models", () => {
    expect(getThinkingControl("https://api.openai.com/v1", "gpt-5.5")?.family).toBe("reasoning_effort");
    expect(getThinkingControl("https://api.openai.com/v1", "o3")?.family).toBe("reasoning_effort");
    expect(getThinkingControl("https://api.openai.com/v1", "gpt-4o")).toBeNull();
  });

  it("does not expose thinking controls for unknown services", () => {
    expect(getThinkingControl("https://api.example.com/v1", "some-model")).toBeNull();
    expect(getThinkingControl("", "")).toBeNull();
  });

  it("does not expose MiMo thinking controls through token-plan gateway", () => {
    expect(getThinkingControl("https://token-plan-cn.xiaomimimo.com/v1", "mimo-v2.5-pro")).toBeNull();
  });
});

describe("applyThinkingParam", () => {
  const mimo = "https://api.xiaomimimo.com/v1";
  const ds = "https://api.deepseek.com";
  const oai = "https://api.openai.com/v1";

  it("injects enable_thinking params", () => {
    expect(applyThinkingParam({}, "fast", mimo, "mimo-v2.5-pro")).toEqual({ enable_thinking: false });
    expect(applyThinkingParam({}, "reasoning", mimo, "mimo-v2.5-pro")).toEqual({ enable_thinking: true });
  });

  it("injects thinking type params", () => {
    expect(applyThinkingParam({}, "fast", ds, "deepseek-chat")).toEqual({ thinking: { type: "disabled" } });
    expect(applyThinkingParam({}, "reasoning", ds, "deepseek-reasoner")).toEqual({ thinking: { type: "enabled" } });
  });

  it("injects reasoning_effort params", () => {
    expect(applyThinkingParam({}, "fast", oai, "gpt-5.5")).toEqual({ reasoning_effort: "low" });
    expect(applyThinkingParam({}, "reasoning", oai, "gpt-5.5")).toEqual({ reasoning_effort: "high" });
  });

  it("does not change payload in auto mode", () => {
    expect(applyThinkingParam({ model: "x" }, "auto", mimo, "mimo-v2.5-pro")).toEqual({ model: "x" });
    expect(applyThinkingParam({ model: "x" }, undefined as any, mimo, "mimo-v2.5-pro")).toEqual({ model: "x" });
  });

  it("does not change payload when the service is not controllable", () => {
    expect(applyThinkingParam({ model: "x" }, "fast", oai, "gpt-4o")).toEqual({ model: "x" });
    expect(applyThinkingParam({ model: "x" }, "fast", "https://api.example.com/v1", "foo")).toEqual({ model: "x" });
    expect(applyThinkingParam({ model: "x" }, "fast", "https://token-plan-cn.xiaomimimo.com/v1", "mimo-v2.5-pro")).toEqual({ model: "x" });
  });
});
