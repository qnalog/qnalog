import { readFileSync } from "node:fs";
import { pluginSourceText } from "./plugin-source";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
// 实现已拆分到多个模块；只断言"字符串存在于插件源码中"的用例改用全文，
// 避免断言因文件位置变化而失效（强度不变：字符串仍须真实存在）。
const pluginSource = pluginSourceText();
// 合并流水线已抽到独立模块：需要断言"同一文件内先后顺序"的用例读该文件本身。
const mergePipelineSource = readFileSync(new URL("../src/briefing/merge-pipeline.ts", import.meta.url), "utf8");

describe("release runtime contracts", () => {
  it("does not retain calls to the excluded video time-link helper", () => {
    expect(mainSource).not.toMatch(/\bgetSegmentTimeLink\s*\(/);
  });

  it("builds realtime-outline and merge anchors from the existing audio helpers", () => {
    expect(pluginSource).toContain(
      "getAudioTimeLink(s.audioName, getSegmentAudioLinkOffsetMs(s))",
    );
    expect(pluginSource).toContain(
      "getAudioTimeLink(segment && segment.audioName, getSegmentAudioLinkOffsetMs(segment))",
    );
    expect(pluginSource).toContain(
      "getAudioTimeLink(seg.audioName, getSegmentAudioLinkOffsetMs(seg))",
    );
  });

  it("keeps failed transcription tasks anchored to their exact note segments", () => {
    // 段落标记的生成与回填现在分处 main.ts 与笔记写入模块，按本文件约定改用全文断言。
    expect(pluginSource).toContain(
      "segmentRecord.queueTaskId ? `<!-- lexvoice-transcribe-task:${segmentRecord.queueTaskId} -->`",
    );
    expect(pluginSource).toContain(
      "const marker = s.queueTaskId ? `<!-- lexvoice-transcribe-task:${s.queueTaskId} -->\\n` : \"\";",
    );
    expect(pluginSource).toContain(
      "retryTask ? `<!-- lexvoice-transcribe-task:${retryTask.id} -->` : \"\"",
    );
    expect(pluginSource).toContain("const legacySegmentPattern = new RegExp(");
    expect(pluginSource).toContain("cur.replace(legacySegmentPattern, `$1${taskMarker}\\n${text}`)");
  });

  it("refreshes the recent-note folder view after external file changes", () => {
    expect(pluginSource).toContain('this.app.vault.on("create"');
    expect(pluginSource).toContain('this.app.vault.on("rename"');
    expect(pluginSource).toContain('this.app.vault.on("delete"');
    expect(pluginSource).toContain('this.app.metadataCache.on("changed"');
    expect(pluginSource).toContain("queueRecentVaultRefresh(delayMs = 180)");
  });

  it("connects repolish work to visible pipeline progress", () => {
    expect(pluginSource).toContain("createBriefingLlmActivityOptions(plugin, computedMeta, patch)");
    expect(pluginSource).toContain("_taskActivityId: taskId");
    expect(pluginSource).toContain('stageLabel: "正在生成新版本"');
    expect(pluginSource).toContain('stageLabel: "正在完成文件处理"');
  });

  it("separates synthesis coverage from source-scaled detail repair", () => {
    expect(pluginSource).toContain("buildBriefingFidelityContract");
    expect(pluginSource).toContain('return "balanced"');
    expect(pluginSource).toContain("assessBriefingPartFidelity(plan.chars, parsed.body, fidelityInput)");
    expect(pluginSource).toContain('"llm.briefing_part_under_detailed"');
    expect(pluginSource).toContain('purpose: "briefing-part-detail-repair"');
    expect(pluginSource).toContain("buildSynthesisConsolidationPrompt");
    expect(pluginSource).toContain('purpose: "briefing-synthesis-consolidation"');
    expect(pluginSource).toContain("checkpoint.consolidationStatus");
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
    expect(pluginSource).toContain('scheduleTaskQueueRetry(1500, mergeError instanceof BriefingPipelineIncompleteError');
    expect(pluginSource).toContain('? "briefing-partial"');
    expect(pluginSource).toContain('scheduleTaskQueueRetry(1500, "briefing-write-failure")');
  });

  it("keeps long-meeting chunks internal and presents one continuous meeting", () => {
    expect(pluginSource).toContain("同一场会议中的一个内部时间窗口");
    expect(pluginSource).toContain("内部窗口只用于控制请求体量，不代表会议被拆成多场");
    expect(pluginSource).toContain("text: body,");
    expect(pluginSource).not.toContain("const wrappedBody = partPlans.length > 1");
    expect(pluginSource).not.toContain("summaries.map((summary, index)");
  });

  it("keeps hidden sediment extraction out of the primary briefing response", () => {
    expect(mainSource).not.toContain("appendSedimentPreExtractionInstruction");
    expect(pluginSource).toContain("if (this.host.settings.sedimentAutoExtract) void this.host.noteIndex.autoExtractSedimentAfterFinalize");
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
    expect(pluginSource).toContain('detail: "整文件提交，不切分为多个 ASR 任务"');
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
