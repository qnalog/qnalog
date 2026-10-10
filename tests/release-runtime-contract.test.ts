import { readFileSync } from "node:fs";
import { pluginSourceText } from "./plugin-source";
import { describe, expect, it, vi } from "vitest";
import { mergeAndPolishLongSession } from "../src/briefing/merge-pipeline";
import { assessBriefingPartFidelity, getBriefingFidelityPolicy, planBriefingParts } from "../src/briefing/pipeline";
import { buildBriefingFidelityContract } from "../src/prompts/briefing-prompts";
const briefingContractState = vi.hoisted(() => ({
  calls: [] as Array<{ mode: string; purpose: string; system: string; prompt: string }>,
  diagnostics: [] as string[],
  responseOverride: null as string | null,
  responseSequence: [] as string[],
}));
vi.mock("../src/llm/core", () => ({
  callBriefingMergeLlm: vi.fn(async (_plugin: unknown, system: string, prompt: string, _options: unknown, context: { mode: string; purpose: string }) => {
    briefingContractState.calls.push({ mode: context.mode, purpose: context.purpose, system, prompt });
    const body = briefingContractState.responseSequence.shift() ?? briefingContractState.responseOverride ?? (context.purpose === "briefing-part-detail-repair"
      ? `## 事实\n${"原文细节".repeat(1800)}`
      : context.purpose === "briefing-part" && context.mode === "meeting"
        ? "短稿"
        : `## 事实\n${"讨论内容".repeat(1600)}`);
    return { text: body, finishReason: "stop", truncated: false, usage: {} };
  }),
  stripModeSuggestionBlocks: (text: string) => text,
  callLlm: vi.fn(),
  logLlmRequestDiagnostic: vi.fn(async (_plugin: unknown, _level: string, key: string) => {
    briefingContractState.diagnostics.push(key);
  }),
}));
vi.mock("../src/people", () => ({
  buildPeopleContextForLlm: vi.fn(async () => ""),
  getPeopleNameHotwordTerms: vi.fn(() => []),
  loadPeopleDirectory: vi.fn(async () => []),
}));
vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  TFile: class {},
  TFolder: class {},
}));


const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
// 实现已拆分到多个模块；只断言"字符串存在于插件源码中"的用例改用全文，
// 避免断言因文件位置变化而失效（强度不变：字符串仍须真实存在）。
const pluginSource = pluginSourceText();
// 合并流水线已抽到独立模块：需要断言"同一文件内先后顺序"的用例读该文件本身。
const mergePipelineSource = readFileSync(new URL("../src/briefing/merge-pipeline.ts", import.meta.url), "utf8");

describe("release runtime contracts", () => {
  it("separates synthesis coverage from source-scaled detail repair", async () => {
    const originalObsidian = (globalThis as typeof globalThis & { obsidian?: unknown }).obsidian;
    const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
    vi.stubGlobal("obsidian", {
      parseYaml: () => ({}),
      stringifyYaml: (value: Record<string, unknown>) => Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`).join("\n"),
    });
    vi.stubGlobal("window", { moment: undefined });

    const segments = Array.from({ length: 3 }, (_, index) => ({
      index,
      startOffsetMs: index * 60_000,
      endOffsetMs: (index + 1) * 60_000,
      text: "讨论内容".repeat(1750),
    }));
    const run = async (mode: string, runSegments = segments, responseOverride: string | null = null, responses: string[] = []) => {
      const files = new Map<string, string>();
      const folders = new Set<string>();
      const adapter = {
        exists: async (path: string) => files.has(path) || folders.has(path),
        mkdir: async (path: string) => { folders.add(path); },
        write: async (path: string, value: string) => { files.set(path, value); },
        read: async (path: string) => {
          const value = files.get(path);
          if (value === undefined) throw new Error("missing");
          return value;
        },
        remove: async (path: string) => { files.delete(path); },
        rename: async (from: string, to: string) => {
          const value = files.get(from);
          if (value === undefined) throw new Error("missing");
          files.set(to, value);
          files.delete(from);
        },
      };
      const plugin = {
        settings: {
          llmModel: "contract-test",
          briefingStructureLevel: "balanced",
          briefingTranslationMode: "off",
          activeTemplateByMode: {},
          promptTemplates: {},
        },
        manifest: { id: "qnalog" },
        app: { vault: { adapter, configDir: ".obsidian" } },
        getCurrentSession: () => null,
      };
      briefingContractState.calls.length = 0;
      briefingContractState.diagnostics.length = 0;
      briefingContractState.responseOverride = responseOverride;
      briefingContractState.responseSequence.splice(0, briefingContractState.responseSequence.length, ...responses);
      let result: string;
      try {
        result = await mergeAndPolishLongSession(plugin, runSegments, mode, null, null, null, 4000);
      } finally {
        briefingContractState.responseOverride = null;
        briefingContractState.responseSequence.length = 0;
      }
      return { result, calls: [...briefingContractState.calls], diagnostics: [...briefingContractState.diagnostics], files };
    };

    try {
      const general = await run("general");
      const generalParts = general.calls.filter(call => call.purpose === "briefing-part");
      const generalConsolidation = general.calls.find(call => call.purpose === "briefing-general-consolidation");
      expect(generalParts.length).toBeGreaterThan(1);
      expect(generalConsolidation).toBeDefined();
      expect(generalConsolidation?.prompt).toContain("开头先写 `> [!abstract] 概要`");
      expect(generalConsolidation?.prompt).toContain("## 详情");
      expect([...general.files.values()].map(value => JSON.parse(value)).some(checkpoint => checkpoint.consolidationStatus === "complete")).toBe(true);
      const chineseInstruction = "输出语言：中文。待办勾选行使用「事项：」「责任人：」「截止：」。";
      expect(generalParts[0]?.prompt).toContain(chineseInstruction);
      expect(generalConsolidation?.prompt).toContain(chineseInstruction);
      expect(generalParts[0]?.prompt.match(/输出语言：中文/g)).toHaveLength(1);
      expect(generalConsolidation?.prompt).toContain("输入共 3 个分段（SEG 1…SEG 3）");


      const synthesis = await run("synthesis");
      const synthesisConsolidation = synthesis.calls.find(call => call.purpose === "briefing-synthesis-consolidation");
      expect(synthesisConsolidation).toBeDefined();
      expect(synthesisConsolidation?.prompt).toContain("会议梗概");
      expect([...synthesis.files.values()].map(value => JSON.parse(value)).some(checkpoint => checkpoint.consolidationStatus === "complete")).toBe(true);

      const meeting = await run("meeting");
      const firstMeetingPart = meeting.calls.find(call => call.purpose === "briefing-part");
      const repair = meeting.calls.find(call => call.purpose === "briefing-part-detail-repair");
      const parts = planBriefingParts(segments, 6000);
      const assessment = assessBriefingPartFidelity(parts[0].chars, "", { mode: "meeting", detailLevel: "balanced" });
      const policy = getBriefingFidelityPolicy({ mode: "meeting", detailLevel: "balanced" });
      const fidelityContract = buildBriefingFidelityContract(assessment, policy.profile, parts[0].segments.length, "meeting");
      expect(firstMeetingPart?.prompt).toContain(fidelityContract);
      expect(repair).toBeDefined();
      expect(meeting.diagnostics).toContain("llm.briefing_part_under_detailed");
      const languageProbe = async (text: string, expected: string, unexpected: string) => {
        const runResult = await run("general", [{ index: 0, startOffsetMs: 0, endOffsetMs: 15_000, text }]);
        const part = runResult.calls.find(call => call.purpose === "briefing-part");
        const messages = `${part?.system}\n${part?.prompt}`;
        expect(part?.prompt).toContain(expected);
        expect(messages).not.toContain(unexpected);
        const marker = expected.startsWith("输出语言") ? "输出语言：中文" : expected.includes("same language") ? "Output language: the same language" : "Output language: English";
        if (!expected.startsWith("输出语言")) expect(part?.system).not.toMatch(/[\u3400-\u9fff]/);
        expect(part?.prompt).toContain(expected);
        expect(part?.system).not.toContain("SYSTEM LANGUAGE REQUIREMENT");
        return runResult;
      };
      await languageProbe(
        "提醒一下，周五之前要把季度报告初稿发给李明评审。",
        "输出语言：中文。待办勾选行使用「事项：」「责任人：」「截止：」。",
        "Output language: English.",
      );
      await languageProbe(
        "I suggest replacing the case in next week's presentation with last month's refund flow.",
        'Output language: English. Use the labels "Task:", "Owner:", "Due:" for action items.',
        "输出语言：中文",
      );
      await languageProbe(
        "这个 sprint 要把 onboarding 的转化漏斗再看一遍。",
        "输出语言：中文。待办勾选行使用「事项：」「责任人：」「截止：」。",
        "Output language: English.",
      );
      const sameLanguageInstruction = "Output language: the same language as the transcript. Keep action-item labels short and in that language.";
      await languageProbe(
        "La próxima semana revisaré el flujo de devoluciones del mes pasado.",
        sameLanguageInstruction,
        "Output language: English.",
      );
      await languageProbe(
        "来週の共有会では、返金の流れを見直します。",
        sameLanguageInstruction,
        "Output language: English.",
      );

      const chineseTaskReply = "> [!abstract] 概要\n> 周五前把季度报告初稿发给李明评审。\n\n- [ ] 事项：把初稿发给李明评审";
      const chineseTask = await run("general", [{
        index: 0,
        startOffsetMs: 0,
        endOffsetMs: 15_000,
        text: "提醒一下，周五之前要把季度报告初稿发给李明评审。",
      }], chineseTaskReply);
      expect(chineseTask.result).toContain("- [ ] 事项：把初稿发给李明评审");
      expect(chineseTask.result).not.toContain("- [ ] Task:");
      const coverageSegments = [
        { index: 0, startOffsetMs: 0, endOffsetMs: 10_000, text: "登录页改版上线，转化率从百分之三点二涨到三点八，注册流程从五步减到三步，王芳两周内出方案。" },
        { index: 1, startOffsetMs: 10_000, endOffsetMs: 20_000, text: "上个月四成投诉和退款有关，李明周五前出一页纸统一话术。" },
        { index: 2, startOffsetMs: 20_000, endOffsetMs: 30_000, text: "物流报价涨了百分之八，赵强先去谈判，谈不拢再换供应商。" },
      ];
      const missingThirdTopic = "> [!abstract] 概要\n> - 登录页改版上线，转化率升至百分之三点八，注册流程减至三步；王芳两周内出方案。\n> - 上个月四成投诉和退款有关；李明周五前整理一页纸统一话术。";
      const completeTopics = `${missingThirdTopic}\n> - 物流报价上涨百分之八；赵强先谈判，谈不拢再换供应商。`;
      const repaired = await run("general", coverageSegments, null, [missingThirdTopic, completeTopics]);
      expect(repaired.calls.find(call => call.purpose === "briefing-part")?.prompt).toContain("输入共 3 个分段（SEG 1…SEG 3）");
      expect(repaired.calls.filter(call => call.purpose === "briefing-part-detail-repair")).toHaveLength(1);
      const coverageRepair = repaired.calls.find(call => call.purpose === "briefing-part-detail-repair");
      expect(coverageRepair?.prompt).toContain(`===SEG 3===\n${coverageSegments[2].text}`);
      expect(coverageRepair?.prompt).toContain("返回完整替换版，不得只输出补充内容：保留初稿已覆盖的全部事实");
      expect(repaired.result).toContain("物流报价上涨百分之八");
      expect(coverageRepair?.prompt).toContain("逐一核对所有原始分段，每个话题都要有落点");
      expect(repaired.diagnostics).toContain("llm.briefing_segment_coverage_repair_started");
      expect(repaired.diagnostics).toContain("llm.briefing_segment_coverage_repaired");

      const alreadyComplete = await run("general", coverageSegments, null, [completeTopics]);
      expect(alreadyComplete.calls.filter(call => call.purpose === "briefing-part-detail-repair")).toHaveLength(0);

      const stillMissing = await run("general", coverageSegments, null, [
        missingThirdTopic,
        "> [!abstract] 概要\n> 修复候选改写仍只涉及登录页和退款投诉。",
      ]);
      expect(stillMissing.calls.filter(call => call.purpose === "briefing-part-detail-repair")).toHaveLength(1);
      expect(stillMissing.result).toContain("王芳两周内出方案");
      expect(stillMissing.result).not.toContain("修复候选改写");
      expect(stillMissing.diagnostics).toContain("llm.briefing_segment_coverage_repair_failed_preserved");
    } finally {
      vi.stubGlobal("window", originalWindow);
      vi.stubGlobal("obsidian", originalObsidian);
    }
  });

  it("does not retain calls to the excluded video time-link helper", () => {
    expect(mainSource).not.toMatch(/\bgetSegmentTimeLink\s*\(/);
  });



  it("refreshes the recent-note folder view after external file changes", () => {
    expect(pluginSource).toContain('this.app.vault.on("create"');
    expect(pluginSource).toContain('this.app.vault.on("rename"');
    expect(pluginSource).toContain('this.app.vault.on("delete"');
    expect(pluginSource).toContain('this.app.metadataCache.on("changed"');
    expect(pluginSource).toContain("queueRecentVaultRefresh(delayMs = 180)");
  });



  it("persists a usable briefing draft before optional detail repair", () => {
    const initialDraft = mergePipelineSource.indexOf("const initialBody = normalizeBriefingPartBody");
    const initialCheckpoint = mergePipelineSource.indexOf("await store.save(checkpoint);", initialDraft);
    const optionalRepair = mergePipelineSource.indexOf('purpose: "briefing-part-detail-repair"', initialDraft);
    const preservedFallback = mergePipelineSource.indexOf('"llm.briefing_part_repair_failed_preserved"', optionalRepair);

    expect(initialDraft).toBeGreaterThan(-1);
    expect(initialCheckpoint).toBeGreaterThan(initialDraft);
    expect(optionalRepair).toBeGreaterThan(initialCheckpoint);
    expect(preservedFallback).toBeGreaterThan(optionalRepair);
  });

  it("actively schedules bounded retries after merge and note-write failures", () => {
    // 重排期调用点随合并重试实现一起搬到了队列模块，用全文断言调用形状与间隔不变。
    expect(pluginSource).toContain('requestTaskQueueRetry(1500, mergeError instanceof BriefingPipelineIncompleteError');
    expect(pluginSource).toContain('? "briefing-partial"');
    expect(pluginSource).toContain('requestTaskQueueRetry(1500, "briefing-write-failure")');
  });

  it("keeps long-meeting chunks internal and presents one continuous meeting", () => {
    expect(pluginSource).toContain("同一场会议中的一个内部时间窗口");
    expect(pluginSource).toContain("内部窗口只用于控制请求体量，不代表会议被拆成多场");
    expect(pluginSource).toContain("text: body,");
    expect(pluginSource).not.toContain("const wrappedBody = partPlans.length > 1");
    expect(pluginSource).not.toContain("summaries.map((summary, index)");
  });


  it("keeps whole-file audio import and progress updates connected at runtime", () => {
    // 导入流程已抽到 src/imports/import-service.ts，按本文件约定用全文断言字符串存在。
    // 与同文件其它断言同口径是字符串契约；用正则容忍参数上的默认值/类型标注，
    // 避免补类型时反复失配。
    expect(pluginSource).toMatch(/openAudioImportOptions\(paths,\s*modeOverride(\s*:\s*\w+)?(\s*=\s*[^)]+)?\)/);
    // 断言「方法存在且 patch 可省略」；用正则容忍参数上的类型标注，避免钉死具体类型名。
    expect(pluginSource).toMatch(/updateImportActivity\(patch(\s*:\s*\w+)?\s*=\s*\{\}\)/);
    expect(pluginSource).toContain("resolveImportTranscribeProvider(this.host)");
    expect(pluginSource).toContain("transcribeImportedAudio(this.host, blob, mime");
    expect(pluginSource).toContain("wholeFileImport: true");
    expect(pluginSource).toContain('detail: t("Submitted as a whole file; not split into multiple ASR tasks.")');
    expect(pluginSource).toContain('phase: "organize"');
  });

  it("does not advance an all-failed audio import into AI organization", () => {
    expect(pluginSource).toContain("let successfulTranscriptions = 0;");
    expect(pluginSource).toContain("successfulTranscriptions++;");
    expect(pluginSource).toContain("if (successfulTranscriptions === 0)");
    expect(pluginSource).toContain('phase: "transcribe"');
    expect(pluginSource).toContain("语音转写未完成；音频已保留，可在处理进度中重试");
  });
});
