import { beforeEach, describe, expect, it, vi } from "vitest";

// 特征测试：锁住一次纪要整理发给模型的提示词由哪些设置层组成、按什么顺序拼接。
// 模式与提示词简化（模板、结构化程度、重新整理偏好、语言策略）改动前后用它确认只改了打算改的部分。

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  parseYaml: () => ({}),
  Notice: class Notice {},
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

const calls: { system: string; user: string }[] = [];
class StopAfterCapture extends Error {}
// 截获第一次模型调用后抛出，流水线不再继续；测试只检查这次调用的提示词。

vi.mock("../src/llm/core", () => ({
  callBriefingMergeLlm: vi.fn(async (_plugin: unknown, system: string, user: string) => {
    calls.push({ system, user });
    throw new StopAfterCapture("captured");
  }),
  callLlm: vi.fn(async () => { throw new StopAfterCapture("captured"); }),
  logLlmRequestDiagnostic: vi.fn(async () => undefined),
}));

vi.mock("../src/people", () => ({
  buildPeopleContextForLlm: vi.fn(async () => ""),
  getPeopleNameHotwordTerms: vi.fn(() => []),
  loadPeopleDirectory: vi.fn(async () => []),
}));

import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { mergeAndPolish } from "../src/briefing/merge-pipeline";

const segments = [
  { index: 1, text: "我们讨论了下季度的发布计划，决定先做移动端录音恢复。", startOffsetMs: 0, endOffsetMs: 60_000 },
  { index: 2, text: "张三负责测试，下周五之前给出结论，风险是安卓后台限制。", startOffsetMs: 60_000, endOffsetMs: 120_000 },
];

type SettingsPatch = Record<string, unknown>;

async function firstPrompt(mode: string, patch: SettingsPatch = {}, repolishOptions: Record<string, unknown> | null = null, meta: Record<string, unknown> = {}) {
  calls.length = 0;
  const settings = { ...structuredClone(DEFAULT_SETTINGS), llmApiKey: "test-key", llmModel: "stub-model", ...patch };
  const plugin = {
    settings,
    manifest: { id: "qnalog" },
    app: { vault: { adapter: {}, configDir: ".obsidian" } },
    _briefingCheckpointStore: { load: async () => null, save: async () => undefined, remove: async () => undefined },
    logDiagnostic: async () => undefined,
    getCurrentSession: () => null,
  };
  try {
    await mergeAndPolish(plugin, segments, mode, { duration: "02:00", _freshBriefing: true, ...meta }, {}, repolishOptions);
  } catch (error) {
    // 流水线会把模型调用失败包装成「分部未完成」；只要已截获第一次调用即可。
    if (!calls.length) throw error;
  }
  expect(calls.length).toBeGreaterThan(0);
  return calls[0].user;
}

/** 依次查找各标记的位置；全部出现且严格递增时返回 true，便于断言层的先后顺序。 */
function inOrder(text: string, markers: readonly string[]): boolean {
  let last = -1;
  for (const marker of markers) {
    const at = text.indexOf(marker, last + 1);
    if (at < 0 || at <= last) return false;
    last = at;
  }
  return true;
}

describe("organize prompt assembly (characterization)", () => {
  beforeEach(() => { calls.length = 0; });

  it("meeting mode with defaults: no preference, language or errata layers", async () => {
    const prompt = await firstPrompt("meeting");
    expect(prompt).toContain("张三负责测试");
    expect(prompt).not.toContain("本次重新整理的最高优先级要求");
    expect(prompt).not.toContain("纪要语言与翻译策略");
    expect(prompt).not.toContain("用户勘误");
  });

  it("structure level changes the mode guidance", async () => {
    const loose = await firstPrompt("meeting", { briefingStructureLevel: "loose" });
    const strict = await firstPrompt("meeting", { briefingStructureLevel: "strict" });
    expect(loose).not.toBe(strict);
  });

  it("re-organize preference is placed before the mode guidance, custom addendum included", async () => {
    const prompt = await firstPrompt("meeting", { repolishPreferencePromptAddendum: "请把待办放在最前面。" }, { label: "精简", detailLevel: "concise" });
    expect(inOrder(prompt, ["本次重新整理的最高优先级要求", "用户自定义重新整理偏好", "请把待办放在最前面。"])).toBe(true);
  });

  it("the custom addendum is ignored when not re-organizing", async () => {
    const prompt = await firstPrompt("meeting", { repolishPreferencePromptAddendum: "请把待办放在最前面。" });
    expect(prompt).not.toContain("请把待办放在最前面。");
  });

  it("language strategy follows the preference block for non-general modes", async () => {
    const prompt = await firstPrompt("meeting", { briefingTranslationMode: "translate", briefingTargetLanguage: "en", briefingLanguageInstruction: "保留货币单位。" }, { label: "精简", detailLevel: "concise" });
    expect(inOrder(prompt, ["本次重新整理的最高优先级要求", "纪要语言与翻译策略", "额外要求：保留货币单位。"])).toBe(true);
  });

  it("general mode does not add the language strategy block", async () => {
    const prompt = await firstPrompt("general", { briefingTranslationMode: "translate", briefingTargetLanguage: "en" });
    expect(prompt).not.toContain("纪要语言与翻译策略");
  });

  it("errata come after the mode guidance and before the transcript window", async () => {
    const prompt = await firstPrompt("meeting", {}, null, { _errata: "【用户勘误（已由用户确认，优先于转写原文）】\n替换：\n- 「安卓」应写作「Android」" });
    expect(inOrder(prompt, ["本模式的输出要求", "## §0 适用判断", "「安卓」应写作「Android」", "【当前窗口转写】"])).toBe(true);
  });

  it("keeps the full layer order: preference, addendum, mode body, language, errata, transcript", async () => {
    const prompt = await firstPrompt(
      "meeting",
      { briefingTranslationMode: "translate", briefingTargetLanguage: "en", repolishPreferencePromptAddendum: "请把待办放在最前面。" },
      { label: "精简", detailLevel: "concise" },
      { _errata: "【用户勘误（已由用户确认，优先于转写原文）】\n说明：\n- 测试勘误" },
    );
    expect(inOrder(prompt, [
      "本模式的输出要求",
      "本次重新整理的最高优先级要求",
      "用户自定义重新整理偏好",
      "## §0 适用判断",
      "纪要语言与翻译策略",
      "测试勘误",
      "【当前窗口转写】",
    ])).toBe(true);
  });

  it("a selected user template replaces the built-in mode body", async () => {
    const marker = "这是用户自己写的会议模板正文。";
    const prompt = await firstPrompt("meeting", {
      promptTemplates: { ...structuredClone(DEFAULT_SETTINGS.promptTemplates), "user-meeting": { id: "user-meeting", mode: "meeting", name: "我的", prompt: `${marker}\n{{TRANSCRIPT}}`, isBuiltin: false } },
      activeTemplateByMode: { ...structuredClone(DEFAULT_SETTINGS.activeTemplateByMode), meeting: "user-meeting" },
    });
    expect(prompt).toContain(marker);
  });

  it("a legacy per-mode prompt is still used when the built-in template is empty", async () => {
    const marker = "旧版设置里的会议提示词。";
    const prompt = await firstPrompt("meeting", { polishPromptMeeting: `${marker}\n{{TRANSCRIPT}}` });
    expect(prompt).toContain(marker);
  });
});
