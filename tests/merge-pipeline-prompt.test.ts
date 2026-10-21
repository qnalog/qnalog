import { beforeEach, describe, expect, it, vi } from "vitest";

const llm = vi.hoisted(() => ({ callLlm: vi.fn(async () => "polished body") }));

vi.mock("obsidian", () => ({
  TFile: class TFile {},
  TFolder: class TFolder {},
  Notice: class Notice {},
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
}));
// 人员通讯录与本用例无关，桩为空上下文，避免读取真实宿主状态。
vi.mock("../src/people", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/people")>()),
  buildPeopleContextForLlm: async () => "",
}));
vi.mock("../src/llm/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/core")>()),
  callLlm: llm.callLlm,
}));

import { polishTranscript } from "../src/briefing/merge-pipeline";
import { POLISH_PROMPTS } from "../src/prompts/briefing-prompts";

// 后处理读取 window.moment；vitest 跑在 Node 环境，这里只提供空对象。
beforeEach(() => {
  llm.callLlm.mockClear();
  vi.stubGlobal("window", { moment: null });
});

describe("transcript prompt substitution", () => {
  it("inserts a transcript containing $ patterns exactly once and duplicates no template text", async () => {
    const transcript = "First line costs $& and $` and $' then $$ and 100% sure.";
    const plugin = { settings: { briefingStructureLevel: "balanced" } };
    await polishTranscript(plugin, transcript, "meeting", { durationMs: 60_000 }, {}, null);
    expect(llm.callLlm).toHaveBeenCalledTimes(1);
    const userPrompt = String(llm.callLlm.mock.calls[0][2]);
    expect(userPrompt.split(transcript).length - 1).toBe(1);
    expect(userPrompt).not.toContain("{{TRANSCRIPT}}");
    // 模板开头的固定文字只能出现一次：字符串替换若把 $ 序列展开，模板会被整段重复。
    const templateHead = POLISH_PROMPTS.meeting.slice(0, 30);
    expect(templateHead).not.toMatch(/\{\{/);
    expect(userPrompt.split(templateHead).length - 1).toBe(1);
  });
});
