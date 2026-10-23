import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (p: string) => String(p || ""), TFile: class {}, TFolder: class {} }));
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { PluginSettings } from "../src/shared/types";
import { applyBailianModelPlan, planBailianModelSelection } from "../src/setup/bailian-model-route";

function fresh(active = "dashscope-flash"): PluginSettings {
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as PluginSettings;
  s.activeTranscribeProvider = active;
  s.transcribeProviders[active].apiKey = "sk-bailian";
  return s;
}

describe("百炼录音转写：按模型选路线", () => {
  it("同一路线的模型只改当前 provider，不切换", () => {
    const s = fresh();
    const plan = planBailianModelSelection(s, "fun-asr-flash");
    expect(plan.kind).toBe("select");
    if (plan.kind !== "select") return;
    expect(plan.providerId).toBe("dashscope-flash");
    expect(plan.switched).toBe(false);
    expect(plan.provider.model).toBe("fun-asr-flash");
    expect(plan.provider.apiKey).toBe("sk-bailian");
  });

  it("流式模型切到 dashscope，沿用当前 provider 的密钥，原 provider 不被修改", async () => {
    const s = fresh();
    const before = JSON.stringify(s.transcribeProviders["dashscope-flash"]);
    const plan = planBailianModelSelection(s, "paraformer-realtime-v2");
    expect(plan.kind).toBe("select");
    if (plan.kind !== "select") return;
    expect(plan.providerId).toBe("dashscope");
    expect(plan.switched).toBe(true);
    expect(plan.provider.apiKey).toBe("sk-bailian");
    expect(plan.provider.protocol).toBe("dashscope-ws");
    expect(plan.provider.endpoint).toMatch(/^wss:\/\/dashscope\.aliyuncs\.com\//);

    const save = vi.fn(async () => undefined);
    await applyBailianModelPlan(s, plan, save);
    expect(save).toHaveBeenCalledTimes(1);
    expect(s.activeTranscribeProvider).toBe("dashscope");
    expect(s.transcribeProviders.dashscope.model).toBe("paraformer-realtime-v2");
    expect(JSON.stringify(s.transcribeProviders["dashscope-flash"])).toBe(before);
  });

  it("旧版 Chat 模型切到 dashscope-chat", () => {
    const plan = planBailianModelSelection(fresh(), "qwen3-asr-flash");
    expect(plan.kind === "select" && plan.providerId).toBe("dashscope-chat");
  });

  it("整文件模型与未登记模型不能用于录音转写，不产生任何写入", () => {
    const s = fresh();
    expect(planBailianModelSelection(s, "qwen-audio-3.1-asr-flash-filetrans")).toEqual({ kind: "unusable", reason: "no-protocol" });
    expect(planBailianModelSelection(s, "some-unknown-model")).toEqual({ kind: "unusable", reason: "no-protocol" });
  });

  it("地址无法映射时报告不可用，而不是猜一个地址", () => {
    const s = fresh();
    s.transcribeProviders["dashscope-flash"].endpoint = "https://dashscope.aliyuncs.com/unknown/path";
    expect(planBailianModelSelection(s, "paraformer-realtime-v2")).toEqual({ kind: "unusable", reason: "unmapped-endpoint" });
  });

  it("非百炼服务不处理，由调用方只写模型字符串", () => {
    const s = fresh("siliconflow");
    expect(planBailianModelSelection(s, "paraformer-realtime-v2")).toEqual({ kind: "not-bailian" });
  });

  it("保存失败时恢复写入前的 provider 与当前服务", async () => {
    const s = fresh();
    const flashBefore = JSON.stringify(s.transcribeProviders["dashscope-flash"]);
    const streamBefore = JSON.stringify(s.transcribeProviders.dashscope);
    const plan = planBailianModelSelection(s, "paraformer-realtime-v2");
    if (plan.kind !== "select") throw new Error("expected select");
    await expect(applyBailianModelPlan(s, plan, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(s.activeTranscribeProvider).toBe("dashscope-flash");
    expect(JSON.stringify(s.transcribeProviders["dashscope-flash"])).toBe(flashBefore);
    expect(JSON.stringify(s.transcribeProviders.dashscope)).toBe(streamBefore);
  });
});
