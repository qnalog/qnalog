import { readFileSync } from "node:fs";
import { pluginSourceText } from "./plugin-source";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
// 实现已拆分到多个模块；只断言"字符串存在于插件源码中"的用例改用全文，
// 避免断言因文件位置变化而失效（强度不变：字符串仍须真实存在）。
const pluginSource = pluginSourceText();

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
    expect(mainSource).toContain(
      "segmentRecord.queueTaskId ? `<!-- lexvoice-transcribe-task:${segmentRecord.queueTaskId} -->`",
    );
    expect(mainSource).toContain(
      "const marker = s.queueTaskId ? `<!-- lexvoice-transcribe-task:${s.queueTaskId} -->\\n` : \"\";",
    );
    expect(mainSource).toContain(
      "retryTask ? `<!-- lexvoice-transcribe-task:${retryTask.id} -->` : \"\"",
    );
    expect(mainSource).toContain("const legacySegmentPattern = new RegExp(");
    expect(mainSource).toContain("cur.replace(legacySegmentPattern, `$1${taskMarker}\\n${text}`)");
  });

  it("refreshes the recent-note folder view after external file changes", () => {
    expect(mainSource).toContain('this.app.vault.on("create"');
    expect(mainSource).toContain('this.app.vault.on("rename"');
    expect(mainSource).toContain('this.app.vault.on("delete"');
    expect(mainSource).toContain('this.app.metadataCache.on("changed"');
    expect(mainSource).toContain("queueRecentVaultRefresh(delayMs = 180)");
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
    expect(pluginSource).toContain("buildPromotionReviewConsolidationPrompt");
    expect(pluginSource).toContain(
      'mode === "promotion-review" ? "promotion-review-consolidation" : "briefing-synthesis-consolidation"',
    );
    expect(pluginSource).toContain("checkpoint.consolidationStatus");
  });

  it("persists a usable briefing draft before optional detail repair", () => {
    const initialDraft = mainSource.indexOf("const initialBody = normalizeBriefingPartBody");
    const initialCheckpoint = mainSource.indexOf("await store.save(checkpoint);", initialDraft);
    const optionalRepair = mainSource.indexOf('purpose: "briefing-part-detail-repair"', initialDraft);
    const preservedFallback = mainSource.indexOf('"llm.briefing_part_repair_failed_preserved"', optionalRepair);

    expect(initialDraft).toBeGreaterThan(-1);
    expect(initialCheckpoint).toBeGreaterThan(initialDraft);
    expect(optionalRepair).toBeGreaterThan(initialCheckpoint);
    expect(preservedFallback).toBeGreaterThan(optionalRepair);
  });

  it("actively schedules bounded retries after merge and note-write failures", () => {
    expect(mainSource).toContain('this.scheduleTaskQueueRetry(1500, mergeError instanceof BriefingPipelineIncompleteError');
    expect(mainSource).toContain('? "briefing-partial"');
    expect(mainSource).toContain('this.scheduleTaskQueueRetry(1500, "briefing-write-failure")');
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
    expect(mainSource).toContain("if (this.settings.sedimentAutoExtract) void this.autoExtractSedimentAfterFinalize");
  });

  it("keeps whole-file audio import and progress updates connected at runtime", () => {
    expect(mainSource).toContain("openAudioImportOptions(paths, modeOverride)");
    expect(mainSource).toContain("updateImportActivity(patch = {})");
    expect(mainSource).toContain("resolveImportTranscribeProvider(this)");
    expect(mainSource).toContain("transcribeImportedAudio(this, blob, mime");
    expect(mainSource).toContain("wholeFileImport: true");
    expect(mainSource).toContain('detail: "整文件提交，不切分为多个 ASR 任务"');
    expect(mainSource).toContain('phase: "organize"');
  });

  it("does not advance an all-failed audio import into AI organization", () => {
    expect(mainSource).toContain("let successfulTranscriptions = 0;");
    expect(mainSource).toContain("successfulTranscriptions++;");
    expect(mainSource).toContain("if (successfulTranscriptions === 0)");
    expect(mainSource).toContain('phase: "transcribe"');
    expect(mainSource).toContain("语音转写未完成；音频已保留，可在处理进度中重试");
  });
});
