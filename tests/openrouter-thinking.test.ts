import { describe, expect, it } from "vitest";
import { getThinkingControl, applyThinkingParam } from "../src/llm/thinking";

describe("OpenRouter 思考档", () => {
  it("已核实的模型可调；未列入的不可调（下拉灰掉）", () => {
    const ep = "https://openrouter.ai/api/v1";
    expect(getThinkingControl(ep, "deepseek/deepseek-v4.1-flash")?.family).toBe("reasoning_openrouter");
    // 冒号变体（:batch / :free）同样认
    expect(getThinkingControl(ep, "deepseek/deepseek-v4.1-flash:batch")?.family).toBe("reasoning_openrouter");
    // reasoning.mandatory 为 true 的模型不能关，不给控件
    expect(getThinkingControl(ep, "deepseek/deepseek-r1")).toBeNull();
    expect(getThinkingControl(ep, "openai/gpt-5")).toBeNull();
    // 非推理模型
    expect(getThinkingControl(ep, "openai/gpt-4o-mini")).toBeNull();
  });

  it("fast 关思考、reasoning 开思考；auto 不动请求体", () => {
    const ep = "https://openrouter.ai/api/v1";
    const model = "deepseek/deepseek-v4.1-flash";
    expect(applyThinkingParam({ messages: [] }, "fast", ep, model)).toEqual({ messages: [], reasoning: { effort: "none" } });
    expect(applyThinkingParam({ messages: [] }, "reasoning", ep, model)).toEqual({ messages: [], reasoning: { enabled: true } });
    expect(applyThinkingParam({ messages: [] }, "auto", ep, model)).toEqual({ messages: [] });
    // 不可调的模型：即使选了 fast 也不注入，避免 400
    expect(applyThinkingParam({ messages: [] }, "fast", ep, "deepseek/deepseek-r1")).toEqual({ messages: [] });
  });
});
