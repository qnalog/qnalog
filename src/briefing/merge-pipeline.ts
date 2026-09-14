/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：纪要合并入口：预压缩、分部整理、截断续写与失败回退

import { applyBriefingLanguageInstruction, getSegmentsDurationMs, getSessionMetaDurationMs, truncateForLlmPrompt } from "../shared/util-text";



import { buildPeopleContextForLlm, mergeUniqueStrings } from "../people";

import { appendSedimentPreExtractionBlock, extractSedimentPreExtractionBlock } from "../sediment";

import { callBriefingMergeLlm, callLlm, isLlmContextLimitError, logLlmRequestDiagnostic } from "../llm/core";

import { getBriefingMergeMaxTokens } from "../llm/config";

import { getLearnedLlmOutputCeiling } from "../llm/output-budget";

import { formatElapsed, getErrorMessage } from "../shared/util-common";

import { diagnosticError } from "../shared/util-key-diag";

import { CLEAN_TRANSCRIPT_SYSTEM, buildCleanTranscriptChunkPrompt, buildKnownSpeakerClause } from "../prompts/clean-transcript";

import { BriefingPipelineIncompleteError, assembleBriefingParts, assessBriefingPartFidelity, assessBriefingPartGrounding, buildBriefingPartSummaryMap, buildProgrammaticTopicMap, createBriefingJobId, getBriefingFidelityPolicy, normalizeBriefingPartBody, planBriefingParts, reconcileBriefingCheckpoint, shouldAutoRepairBriefingPart } from "./pipeline";

import { buildSynthesisConsolidationPrompt } from "./synthesis-policy";


import { mergeBriefingSedimentObjects, resolveKnownSpeakerLabels } from "../notes/recording-issues";

import { BRIEFING_PRESUMMARY_NOTICE, BRIEFING_TRUNCATION_WARNING, applyRepolishPreferenceInstruction, applyStructureLevelInstruction, buildAdaptiveBriefingLengthInstruction, buildBriefingFidelityContract, buildBriefingPartExpansionPrompt, buildBriefingPipelineOptionsKey, buildChunkMergePrompt, buildEmptyLlmOutputFallback, buildSessionMetaPrefix, createBriefingLlmActivityOptions, formatMergeSegmentForPrompt, getBriefingCheckpointStore, getBriefingEffectiveDetailLevel, getBriefingPipelineTargetChars, mergeBriefingUsage, reportBriefingPartProgress, resolveTemplatePromptForMode, splitSegmentsIntoGroups } from "../prompts/briefing-prompts";

import { buildMeetingWorkbenchPrompt } from "../notes/meeting-workbench";

import { renderLongSessionRawFallbackGroup } from "../notes/detail-blocks";

import { appendEntityEvidenceWarning, frontmatterBaseModeKey, maybePreSummarizeTextImportForMerge, parseBriefingPartResponse, postProcessBriefingOutput } from "../notes/note-markdown";

export async function polishTranscript(plugin, transcript, mode, sessionMeta, originalFrontmatter, repolishOptions) {
  if (!transcript || !transcript.trim()) return "";
  if (mode === "off") return transcript;
  const tpl = resolveTemplatePromptForMode(plugin, mode, false);
  const sys = "你是一位专业的文字编辑助手，擅长整理访谈、会议与口述的录音转写。";
  let userPrompt = applyStructureLevelInstruction(tpl, plugin.settings, repolishOptions && repolishOptions.structureLevel).replace("{{TRANSCRIPT}}", transcript);
  userPrompt = applyRepolishPreferenceInstruction(userPrompt, repolishOptions, plugin.settings);
  userPrompt = applyBriefingLanguageInstruction(userPrompt, plugin.settings);
  userPrompt = userPrompt.replace("{{STRUCTURE_INSTRUCTION}}", "");
  const adaptiveLength = buildAdaptiveBriefingLengthInstruction(mode, {
    durationMs: getSessionMetaDurationMs(sessionMeta),
    transcriptChars: transcript.length,
    segmentCount: 1,
  });
  if (adaptiveLength) userPrompt = adaptiveLength + "\n\n---\n\n" + userPrompt;
  // 自适应 max_tokens：长材料能产出更长纪要，不被 API 默认上限（~4096）一刀切。
  const briefingMergeMaxTokens = getBriefingMergeMaxTokens({
    durationMs: getSessionMetaDurationMs(sessionMeta),
    transcriptChars: transcript.length,
    segmentCount: 1,
  }, plugin.settings, getLearnedLlmOutputCeiling(plugin.settings));
  const metaPrefix = buildSessionMetaPrefix(sessionMeta, mode);
  if (metaPrefix) userPrompt = metaPrefix + "\n\n---\n\n" + userPrompt;
  const meetingWorkbenchPrompt = buildMeetingWorkbenchPrompt(sessionMeta && sessionMeta.meetingWorkbench);
  if (meetingWorkbenchPrompt) userPrompt = meetingWorkbenchPrompt + "\n\n---\n\n" + userPrompt;
  const peopleContext = await buildPeopleContextForLlm(plugin);
  if (peopleContext) userPrompt = peopleContext + "\n\n---\n\n" + userPrompt;
  // 流式：merge 是最长、最贵、跑一次的调用。流式 + 空闲超时确保服务端只要在持续输出就不会被
  // 客户端总超时 abort，避免"扣了钱却因超时拿不到结果"的浪费（符合总纲：不因工程缺陷浪费）。
  const raw = await callLlm(plugin, sys, userPrompt, { stream: true, payload: { max_tokens: briefingMergeMaxTokens } });
  const sedimentPreExtraction = extractSedimentPreExtractionBlock(raw);
  const polished = postProcessBriefingOutput(sedimentPreExtraction.cleaned, mode, sessionMeta, originalFrontmatter, frontmatterBaseModeKey(plugin, mode));
  return sedimentPreExtraction.objects ? appendSedimentPreExtractionBlock(polished, sedimentPreExtraction.objects) : polished;
}

// 清稿：把母本 raw 分段转写整理成高保真可读稿（非纪要、不以缩短为目标）。
// 清稿的输出体量接近有效原文，因此输入块必须给输出留足空间；块过大会在逐块整理时截断并真实丢失内容。
export async function cleanTranscript(plugin, segments, ceiling) {
  const list = Array.isArray(segments) ? segments.filter(s => s && String(s.text || "").trim()) : [];
  if (!list.length) return { text: "", truncated: false };
  const modelCeiling = Number(ceiling) || 0;
  const inputChars = list.reduce((sum, segment) => sum + String((segment && segment.text) || "").length, 0);
  // 未知/新模型不再回退到 2048/8000；按本次清稿输入体量给出需求值，真实拒绝时再由请求层降档。
  const safeCeiling = modelCeiling > 0
    ? Math.max(2048, modelCeiling)
    : Math.min(32000, Math.max(12000, Math.ceil(inputChars / 2)));
  const targetChars = Math.min(18_000, Math.max(5_000, Math.floor(safeCeiling * 1.15)));
  const groups = splitSegmentsIntoGroups(list, targetChars);
  const runGroup = async (g, partIndex, partTotal) => {
    const joined = g.map((s, j) => formatMergeSegmentForPrompt(s, j)).join("\n\n");
    const start = formatElapsed(Number(g[0] && g[0].startOffsetMs) || 0);
    const end = formatElapsed(Number(g[g.length - 1] && g[g.length - 1].endOffsetMs) || 0);
    let up = buildCleanTranscriptChunkPrompt(joined, partIndex, partTotal, `${start}–${end}`, resolveKnownSpeakerLabels(joined, null));
    up = applyBriefingLanguageInstruction(up, plugin.settings);
    const { text, truncated } = await callBriefingMergeLlm(
      plugin, CLEAN_TRANSCRIPT_SYSTEM, up,
      { stream: true, thinkingMode: "fast", payload: { max_tokens: safeCeiling } },
      { mode: "cleanscript", chunked: partTotal > 1, part: partIndex, partTotal },
    );
    return { text: String(text || "").trim(), truncated: !!truncated };
  };
  if (groups.length < 2) {
    return await runGroup(list, 1, 1);
  }
  const parts = [];
  let anyTruncated = false;
  for (let i = 0; i < groups.length; i++) {
    const r = await runGroup(groups[i], i + 1, groups.length);
    if (r.truncated) anyTruncated = true;
    parts.push(r.text || renderLongSessionRawFallbackGroup(groups[i], i + 1));
  }
  return { text: parts.join("\n\n"), truncated: anyTruncated };
}

// 普通纪要统一走同一条可恢复流水线：短会是一部分，长会是多部分。每个部分完成后立即持久化，
// 后续失败只重试未完成部分；最终正文由程序按时间顺序拼装，不再让模型重写整篇并再次引入截断风险。
export async function mergeAndPolishLongSession(plugin, segments, mode, computedMeta, originalFrontmatter, repolishOptions, ceiling, forceChunk = false) {
  const list = Array.isArray(segments) ? segments.filter(segment => segment && String(segment.text || "").trim()) : [];
  if (!list.length) return null;
  const fullJoined = list.map((segment, index) => formatMergeSegmentForPrompt(segment, index)).join("\n\n");
  const preferredTargetChars = forceChunk
    ? Math.min(16000, getBriefingPipelineTargetChars(plugin, mode, repolishOptions))
    : getBriefingPipelineTargetChars(plugin, mode, repolishOptions);
  const targetChars = Number(ceiling) > 0
    ? Math.min(preferredTargetChars, Math.max(4000, Math.floor(Number(ceiling) * 1.5)))
    : preferredTargetChars;
  const partPlans = planBriefingParts(list, targetChars);
  if (!partPlans.length) return null;
  const requiresGlobalConsolidation = mode === "synthesis" && partPlans.length > 1;

  const identity = createBriefingJobId({
    segments: list,
    mode,
    model: String(plugin.settings.llmModel || ""),
    optionsKey: buildBriefingPipelineOptionsKey(plugin, mode, repolishOptions),
  });
  const store = getBriefingCheckpointStore(plugin);
  const checkpointInput = {
    id: identity.id,
    sourceHash: identity.sourceHash,
    optionsHash: identity.optionsHash,
    mode,
    model: String(plugin.settings.llmModel || ""),
    parts: partPlans,
  };
  let checkpoint = reconcileBriefingCheckpoint(await store.load(identity.id), checkpointInput);
  if (computedMeta && typeof computedMeta === "object") computedMeta._briefingCheckpointId = identity.id;
  await store.save(checkpoint);

  const tpl = resolveTemplatePromptForMode(plugin, mode, true);
  let modeGuidance = applyStructureLevelInstruction(tpl, plugin.settings, repolishOptions && repolishOptions.structureLevel)
    .replace("{{TRANSCRIPT}}", "（原始转写会按时间分部提供，请只执行模板规则，不要补写占位内容。）")
    .replace("{{STRUCTURE_INSTRUCTION}}", "");
  modeGuidance = applyRepolishPreferenceInstruction(modeGuidance, repolishOptions, plugin.settings);
  modeGuidance = applyBriefingLanguageInstruction(modeGuidance, plugin.settings);
  const adaptiveLength = buildAdaptiveBriefingLengthInstruction(mode, {
    durationMs: getSegmentsDurationMs(list) || getSessionMetaDurationMs(computedMeta),
    transcriptChars: fullJoined.length,
    segmentCount: list.length,
  });
  if (adaptiveLength) modeGuidance = `${adaptiveLength}\n\n---\n\n${modeGuidance}`;
  modeGuidance = truncateForLlmPrompt(modeGuidance, 12000);
  const fidelityInput = {
    mode,
    detailLevel: getBriefingEffectiveDetailLevel(mode, repolishOptions),
    structureLevel: repolishOptions && repolishOptions.structureLevel || plugin.settings.briefingStructureLevel,
  };
  const fidelityPolicy = getBriefingFidelityPolicy(fidelityInput);
  const partModeGuidance = modeGuidance;

  if (!String(checkpoint.topicMap || "").trim()) {
    checkpoint.topicMap = buildProgrammaticTopicMap(partPlans, formatElapsed);
    checkpoint.topicMapSource = "timeline";
    checkpoint.topicMapFinishReason = partPlans.length === 1 ? "not-needed" : "programmatic";
    checkpoint.topicMapUsage = undefined;
    await store.save(checkpoint);
  }

  const peopleContext = await buildPeopleContextForLlm(plugin);
  const metaPrefix = buildSessionMetaPrefix(computedMeta, mode);
  const meetingWorkbenchPrompt = buildMeetingWorkbenchPrompt(computedMeta && computedMeta.meetingWorkbench);
  const system = mode === "synthesis" && partPlans.length > 1
    ? "你是综合纪要的议题证据编辑。请从当前内部窗口提取并归并可核验的议题材料，供下一阶段统一成文；不要把窗口写成独立会议。"
    : "你是一位专业的文字编辑助手。请把当前时段原始转写忠实整理为完整、可读的 Markdown 正文。第一职责是还原信息，不得为了精炼而遗漏事实。";
  for (const plan of partPlans) {
    const part = checkpoint.parts[plan.index];
    if (part && part.status === "complete" && String(part.text || "").trim()) continue;
    part.status = "running";
    part.attempts = Math.max(0, Number(part.attempts) || 0) + 1;
    part.error = "";
    await store.save(checkpoint);
    reportBriefingPartProgress(plugin, computedMeta, checkpoint, plan.index + 1);

    const joinedChunk = plan.segments.map((segment, index) => formatMergeSegmentForPrompt(segment, index)).join("\n\n");
    const start = formatElapsed(plan.startOffsetMs);
    const end = formatElapsed(plan.endOffsetMs);
    let fidelity = assessBriefingPartFidelity(plan.chars, "", fidelityInput);
    const fidelityContract = buildBriefingFidelityContract(fidelity, fidelityPolicy.profile, plan.segments.length, mode);
    const currentPartGuidance = partModeGuidance;
    let prompt = buildChunkMergePrompt(joinedChunk, plan.index + 1, partPlans.length, `${start}–${end}`, checkpoint.topicMap, currentPartGuidance, fidelityContract, mode, fidelityInput.detailLevel);
    const speakerClause = buildKnownSpeakerClause(resolveKnownSpeakerLabels(joinedChunk, originalFrontmatter));
    const sharedContext = [peopleContext, metaPrefix, meetingWorkbenchPrompt, speakerClause].filter(Boolean).join("\n\n---\n\n");
    if (sharedContext) prompt = sharedContext + "\n\n---\n\n" + prompt;
    const requestedPartTokens = Math.max(8192, Math.ceil(plan.chars * 1.2), Math.ceil(fidelity.targetOutputChars * 1.5));
    const partMaxTokens = Number(ceiling) > 0 ? Math.min(Math.max(2048, Number(ceiling)), requestedPartTokens) : requestedPartTokens;

    try {
      let response = await callBriefingMergeLlm(
        plugin,
        system,
        prompt,
        Object.assign(
          { stream: true, thinkingMode: "fast", payload: { max_tokens: partMaxTokens } },
          createBriefingLlmActivityOptions(plugin, computedMeta, {
            stage: "llm",
            stageLabel: partPlans.length > 1 ? `AI 整理 · 第 ${plan.index + 1}/${partPlans.length} 部分` : "AI 正在整理正文",
            detail: partPlans.length > 1
              ? `正在生成第 ${plan.index + 1}/${partPlans.length} 部分`
              : "正在根据原始转写生成正文",
            progress: Math.min(84, 12 + Math.round((plan.index / partPlans.length) * 72)),
          }),
        ),
        { purpose: "briefing-part", mode, jobId: identity.id, part: plan.index + 1, partTotal: partPlans.length, transcriptChars: joinedChunk.length },
      );
      let parsed = parseBriefingPartResponse(response.text);
      fidelity = assessBriefingPartFidelity(plan.chars, parsed.body, fidelityInput);
      let grounding = assessBriefingPartGrounding(joinedChunk, parsed.body);
      let combinedUsage = mergeBriefingUsage(response.usage);
      let repairAttempts = 0;
      const initialBody = normalizeBriefingPartBody(parsed.body, { fragmentMode: partPlans.length > 1 });
      if (initialBody && !response.truncated) {
        // The first usable draft is a paid result and a recovery boundary. Persist it
        // before optional quality repair so a repair timeout cannot erase the draft.
        Object.assign(part, {
          status: "complete",
          text: initialBody,
          summary: parsed.summary,
          people: parsed.people,
          tags: parsed.tags,
          sedimentObjects: parsed.sedimentObjects,
          finishReason: String(response.finishReason || ""),
          usage: combinedUsage,
          sourceChars: fidelity.sourceChars,
          outputChars: fidelity.outputChars,
          outputRatio: Number(fidelity.outputRatio.toFixed(4)),
          minimumOutputChars: fidelity.minimumOutputChars,
          targetOutputChars: fidelity.targetOutputChars,
          qualityStatus: fidelity.needsExpansion ? "under-detailed" : (grounding.needsRepair ? "under-grounded" : "ok"),
          repairAttempts,
          error: "",
          updatedAt: new Date().toISOString(),
        });
        await store.save(checkpoint);
      }
      if (initialBody && !response.truncated && shouldAutoRepairBriefingPart(fidelity)) {
        repairAttempts = 1;
        await logLlmRequestDiagnostic(plugin, "warn", "llm.briefing_part_under_detailed", fidelity.needsExpansion ? "纪要分部明显短于原始材料，正在对照原文补回细节" : "纪要分部缺少多项可核验信息，正在对照原文重新整理", {
          mode,
          jobId: identity.id,
          part: plan.index + 1,
          partTotal: partPlans.length,
          profile: fidelityPolicy.profile,
          sourceChars: fidelity.sourceChars,
          outputChars: fidelity.outputChars,
          minimumOutputChars: fidelity.minimumOutputChars,
          targetOutputChars: fidelity.targetOutputChars,
          outputRatio: Number(fidelity.outputRatio.toFixed(3)),
          groundingAnchors: grounding.anchors.length,
          groundingMatched: grounding.matchedAnchors,
          groundingRatio: Number(grounding.ratio.toFixed(3)),
          repairReason: fidelity.needsExpansion && grounding.needsRepair
            ? "detail-and-grounding"
            : (fidelity.needsExpansion ? "detail" : "grounding"),
        });
        const groundingContract = grounding.needsRepair
          ? `【必须核对的原文锚点】上一版遗漏较多可核验信息。请在语义正确的位置保留或解释这些原文锚点；如完整上下文能确认是 ASR 误写，可统一为正确写法，但不得直接丢弃：\n- ${grounding.missingAnchors.slice(0, 24).join("\n- ")}`
          : "";
        try {
          const repair = await callBriefingMergeLlm(
            plugin,
            "你是纪要保真编辑。你的任务是对照原始转写补回被摘要掉的信息，并返回完整替换稿；不得用空话凑长度，也不得编造原文没有的内容。",
            buildBriefingPartExpansionPrompt(joinedChunk, parsed.body, `${start}–${end}`, fidelityContract, groundingContract),
            Object.assign(
              { stream: true, thinkingMode: "fast", payload: { max_tokens: partMaxTokens } },
              createBriefingLlmActivityOptions(plugin, computedMeta, {
                stage: "llm-detail-repair",
                stageLabel: partPlans.length > 1 ? `补充细节 · 第 ${plan.index + 1}/${partPlans.length} 部分` : "正在补充遗漏细节",
                detail: `当前正文 ${fidelity.outputChars} 字，正在对照原始转写补全`,
                progress: Math.min(86, 18 + Math.round((plan.index / partPlans.length) * 68)),
              }),
            ),
            { purpose: "briefing-part-detail-repair", mode, jobId: identity.id, part: plan.index + 1, partTotal: partPlans.length, transcriptChars: joinedChunk.length },
          );
          const repaired = parseBriefingPartResponse(repair.text);
          const repairedFidelity = assessBriefingPartFidelity(plan.chars, repaired.body, fidelityInput);
          const repairedGrounding = assessBriefingPartGrounding(joinedChunk, repaired.body);
          combinedUsage = mergeBriefingUsage(combinedUsage, repair.usage);
          const repairedScore = repairedFidelity.outputChars + repairedGrounding.matchedAnchors * 120;
          const currentScore = fidelity.outputChars + grounding.matchedAnchors * 120;
          if (repaired.body && !repair.truncated && repairedScore > currentScore) {
            response = repair;
            parsed = repaired;
            fidelity = repairedFidelity;
            grounding = repairedGrounding;
          }
          const repairStillWeak = fidelity.needsExpansion || grounding.needsRepair;
          await logLlmRequestDiagnostic(plugin, repairStillWeak ? "warn" : "info", "llm.briefing_part_detail_repaired", repairStillWeak ? "纪要分部补充后仍需复核，已保留信息更完整的版本" : "纪要分部已对照原文补回细节", {
            mode,
            jobId: identity.id,
            part: plan.index + 1,
            partTotal: partPlans.length,
            profile: fidelityPolicy.profile,
            sourceChars: fidelity.sourceChars,
            outputChars: fidelity.outputChars,
            minimumOutputChars: fidelity.minimumOutputChars,
            targetOutputChars: fidelity.targetOutputChars,
            outputRatio: Number(fidelity.outputRatio.toFixed(3)),
            groundingAnchors: grounding.anchors.length,
            groundingMatched: grounding.matchedAnchors,
            groundingRatio: Number(grounding.ratio.toFixed(3)),
          });
        } catch (repairError) {
          await logLlmRequestDiagnostic(plugin, "warn", "llm.briefing_part_repair_failed_preserved", "补充细节未完成，已保留本部分首版可用正文", {
            mode,
            jobId: identity.id,
            part: plan.index + 1,
            partTotal: partPlans.length,
            outputChars: fidelity.outputChars,
            qualityStatus: fidelity.needsExpansion ? "under-detailed" : "under-grounded",
            error: diagnosticError(repairError),
          });
        }
      }
      const body = normalizeBriefingPartBody(parsed.body, { fragmentMode: partPlans.length > 1 });
      const partStatus = body && !response.truncated ? "complete" : (body ? "partial" : "failed");
      Object.assign(part, {
        status: partStatus,
        text: body,
        summary: parsed.summary,
        people: parsed.people,
        tags: parsed.tags,
        sedimentObjects: parsed.sedimentObjects,
        finishReason: String(response.finishReason || ""),
        usage: combinedUsage,
        sourceChars: fidelity.sourceChars,
        outputChars: fidelity.outputChars,
        outputRatio: Number(fidelity.outputRatio.toFixed(4)),
        minimumOutputChars: fidelity.minimumOutputChars,
        targetOutputChars: fidelity.targetOutputChars,
        qualityStatus: fidelity.needsExpansion ? "under-detailed" : (grounding.needsRepair ? "under-grounded" : "ok"),
        repairAttempts,
        error: body
          ? (response.truncated ? "本部分在续写后仍被输出上限截断" : "")
          : "本部分没有返回可见正文",
        updatedAt: new Date().toISOString(),
      });
      if (partStatus !== "complete") {
        checkpoint.status = "partial";
        await store.save(checkpoint);
        await logLlmRequestDiagnostic(plugin, "warn", "llm.briefing_part_incomplete", "纪要分部未完整生成，已保存检查点等待精确重试", {
          mode, jobId: identity.id, part: plan.index + 1, partTotal: partPlans.length,
          finishReason: part.finishReason, outputChars: body.length, usage: part.usage,
        });
        throw new BriefingPipelineIncompleteError(
          `纪要整理部分完成：${checkpoint.parts.filter(item => item.status === "complete").length}/${partPlans.length} 部分已完成；第 ${plan.index + 1} 部分需要重试`,
          checkpoint.parts.filter(item => item.status === "complete").length,
          partPlans.length,
          [plan.index],
        );
      }
      await store.save(checkpoint);
      reportBriefingPartProgress(plugin, computedMeta, checkpoint, plan.index + 2);
    } catch (error) {
      if (error instanceof BriefingPipelineIncompleteError) throw error;
      part.status = "failed";
      part.error = getErrorMessage(error);
      part.updatedAt = new Date().toISOString();
      checkpoint.status = "partial";
      await store.save(checkpoint);
      await logLlmRequestDiagnostic(plugin, "warn", "llm.briefing_part_failed", "纪要分部生成失败，已保存此前结果等待精确重试", {
        mode, jobId: identity.id, part: plan.index + 1, partTotal: partPlans.length,
        completedParts: checkpoint.parts.filter(item => item.status === "complete").length,
        error: diagnosticError(error),
      });
      throw new BriefingPipelineIncompleteError(
        `纪要整理部分完成：${checkpoint.parts.filter(item => item.status === "complete").length}/${partPlans.length} 部分已完成；第 ${plan.index + 1} 部分失败：${getErrorMessage(error)}`,
        checkpoint.parts.filter(item => item.status === "complete").length,
        partPlans.length,
        [plan.index],
      );
    }
  }

  const assembledParts = assembleBriefingParts(checkpoint.parts);
  checkpoint.topicMap = buildBriefingPartSummaryMap(checkpoint.parts, formatElapsed);
  checkpoint.topicMapSource = "part-summaries";
  checkpoint.topicMapFinishReason = "programmatic";
  checkpoint.topicMapUsage = undefined;
  await store.save(checkpoint);
  const synthesisParts = checkpoint.parts.map((part) => ({
    index: part.index,
    timeRange: `${formatElapsed(part.startOffsetMs)}–${formatElapsed(part.endOffsetMs)}`,
    summary: part.summary,
    body: part.text,
  }));
  let finalVisibleBody = assembledParts;
  let consolidatedPeople = [];
  let consolidatedTags = [];
  if (requiresGlobalConsolidation) {
    if (checkpoint.consolidationStatus === "complete" && String(checkpoint.consolidationBody || "").trim()) {
      finalVisibleBody = checkpoint.consolidationBody;
    } else {
      checkpoint.consolidationStatus = "running";
      checkpoint.consolidationAttempts = Math.max(0, Number(checkpoint.consolidationAttempts) || 0) + 1;
      checkpoint.consolidationError = "";
      checkpoint.status = "running";
      await store.save(checkpoint);
      const durationMs = getSegmentsDurationMs(list) || getSessionMetaDurationMs(computedMeta);
      const consolidationMaxTokens = getBriefingMergeMaxTokens({
        durationMs,
        transcriptChars: fullJoined.length,
        segmentCount: list.length,
      }, plugin.settings, Number(ceiling) || 0);
      try {
        const consolidationPrompt = buildSynthesisConsolidationPrompt({
          topicMap: checkpoint.topicMap,
          parts: synthesisParts,
          modeGuidance,
          detailLevel: fidelityInput.detailLevel,
          duration: computedMeta && computedMeta.duration || formatElapsed(durationMs),
          transcriptChars: fullJoined.length,
        });
        const consolidation = await callBriefingMergeLlm(
          plugin,
          "你是综合纪要的总编辑。请把同一场会议的内部议题材料归并为一篇结构清晰、证据充分、以事情为中心的最终纪要。",
          consolidationPrompt,
          Object.assign(
            { stream: true, thinkingMode: "fast", payload: { max_tokens: consolidationMaxTokens } },
            createBriefingLlmActivityOptions(plugin, computedMeta, {
              stage: "consolidate",
              stageLabel: "归并全场议题",
              detail: "正在把各时段材料整理成一篇综合纪要",
              progress: 88,
            }),
          ),
          { purpose: "briefing-synthesis-consolidation", mode, jobId: identity.id, partTotal: partPlans.length, transcriptChars: fullJoined.length },
        );
        const parsed = parseBriefingPartResponse(consolidation.text);
        const body = normalizeBriefingPartBody(parsed.body, { fragmentMode: false });
        if (!body || consolidation.truncated) {
          throw new Error(body ? "全局成文在续写后仍被输出上限截断" : "全局成文没有返回可见正文");
        }
        finalVisibleBody = body;
        consolidatedPeople = parsed.people;
        consolidatedTags = parsed.tags;
        Object.assign(checkpoint, {
          consolidationStatus: "complete",
          consolidationBody: body,
          consolidationFinishReason: String(consolidation.finishReason || ""),
          consolidationUsage: consolidation.usage,
          consolidationError: "",
          status: "assembled",
          updatedAt: new Date().toISOString(),
        });
        await store.save(checkpoint);
      } catch (error) {
        checkpoint.consolidationStatus = "failed";
        checkpoint.consolidationError = getErrorMessage(error);
        checkpoint.status = "partial";
        checkpoint.updatedAt = new Date().toISOString();
        await store.save(checkpoint);
        await logLlmRequestDiagnostic(plugin, "warn", "llm.briefing_consolidation_failed", "分部材料已保留，全局成文未完成，可从该步骤重试", {
          mode,
          jobId: identity.id,
          partTotal: partPlans.length,
          attempts: checkpoint.consolidationAttempts,
          error: diagnosticError(error),
        });
        throw new BriefingPipelineIncompleteError(
          `纪要分部已完成 ${partPlans.length}/${partPlans.length}；全局成文需要重试：${getErrorMessage(error)}`,
          partPlans.length,
          partPlans.length,
          [],
        );
      }
    }
  } else {
    checkpoint.consolidationStatus = "complete";
    checkpoint.consolidationBody = finalVisibleBody;
    checkpoint.consolidationFinishReason = "not-needed";
  }
  let people = mergeUniqueStrings([], checkpoint.parts.flatMap(part => part.people || []).concat(consolidatedPeople));
  let tags = mergeUniqueStrings([], checkpoint.parts.flatMap(part => part.tags || []).concat(consolidatedTags)).filter(tag => tag && !/^lexvoice\//.test(tag)).slice(0, 9);
  const writeAssembledBody = () => {
    const machine = `\n\n<!-- lexvoice-people: ${people.join(", ")} -->\n<!-- lexvoice-tags: ${tags.join(", ")} -->`;
    checkpoint.assembledBody = appendEntityEvidenceWarning(finalVisibleBody + machine, fullJoined);
  };
  writeAssembledBody();
  checkpoint.status = "assembled";
  await store.save(checkpoint);

  if (checkpoint.auditStatus !== "complete") {
    // Parts and consolidation already have durable completion checkpoints. A second
    // full-document LLM audit rereads the same material and can spuriously trigger
    // another full rewrite, so completeness is closed deterministically here.
    checkpoint.auditStatus = "complete";
    checkpoint.auditText = "pipeline-complete";
    checkpoint.auditFinishReason = "deterministic-checkpoint";
    checkpoint.auditUsage = undefined;
    await store.save(checkpoint);
  }

  await logLlmRequestDiagnostic(plugin, "info", "llm.briefing_pipeline_completed", "纪要整理流水线已完成并保存检查点", {
    mode,
    jobId: identity.id,
    partTotal: partPlans.length,
    topicMapSource: checkpoint.topicMapSource,
    partUsage: checkpoint.parts.map(part => ({
      part: part.index + 1,
      finishReason: part.finishReason,
      sourceChars: Number(part.sourceChars) || 0,
      outputChars: Number(part.outputChars) || part.text.length,
      outputRatio: Number(part.outputRatio) || 0,
      minimumOutputChars: Number(part.minimumOutputChars) || 0,
      targetOutputChars: Number(part.targetOutputChars) || 0,
      qualityStatus: part.qualityStatus || "unchecked",
      repairAttempts: Number(part.repairAttempts) || 0,
      usage: part.usage,
    })),
    consolidationFinishReason: checkpoint.consolidationFinishReason,
    consolidationAttempts: checkpoint.consolidationAttempts,
    consolidationUsage: checkpoint.consolidationUsage,
    auditFinishReason: checkpoint.auditFinishReason,
    auditUsage: checkpoint.auditUsage,
  });
  const polished = postProcessBriefingOutput(checkpoint.assembledBody, mode, computedMeta, originalFrontmatter, frontmatterBaseModeKey(plugin, mode), "");
  const sedimentObjects = mergeBriefingSedimentObjects(checkpoint.parts);
  return sedimentObjects ? appendSedimentPreExtractionBlock(polished, sedimentObjects) : polished;
}

export async function mergeAndPolish(plugin, segments, mode, sessionMeta, originalFrontmatter, repolishOptions = null) {
  if (!segments || segments.length === 0) return "";
  if (mode === "off") return segments.map(s => s.text).join("\n\n");
  const segmentsForMerge = await maybePreSummarizeTextImportForMerge(plugin, segments, mode, sessionMeta);
  // 引用不同 = 触发了超长文本预压缩（原文被分段摘要替换）。最终纪要顶部要据此告知用户"基于摘要稿"。
  const preSummarized = segmentsForMerge !== segments;
  segments = segmentsForMerge;
  const joined = segments.map((s, i) => formatMergeSegmentForPrompt(s, i)).join("\n\n");
  let computedMeta = sessionMeta || null;
  if (!computedMeta && segments.length > 0) {
    // 兜底：mergeAndPolish 没传 sessionMeta 时，从 segments 推 duration（startedAt 仍需调用方传）
    const last = segments[segments.length - 1];
    computedMeta = { duration: formatElapsed(last.endOffsetMs || 0) };
  }
  // 自适应 max_tokens：让长会真正能产出更长纪要，而不是被 API 默认上限（~4096）一刀切。
  const runtimeCeiling = getLearnedLlmOutputCeiling(plugin.settings);
  const briefingMergeMaxTokens = getBriefingMergeMaxTokens({
    durationMs: getSegmentsDurationMs(segments) || getSessionMetaDurationMs(computedMeta),
    transcriptChars: joined.length,
    segmentCount: segments.length,
  }, plugin.settings, runtimeCeiling);
  const mergeCeiling = runtimeCeiling;
  // 普通纪要无论长短都走同一条可恢复流水线；文本导入若已做过预摘要也不再二次分部，避免重复有损压缩。
  if (!preSummarized) {
    const pipelined = await mergeAndPolishLongSession(
      plugin,
      segments,
      mode,
      computedMeta,
      originalFrontmatter,
      repolishOptions,
      mergeCeiling,
      false,
    );
    if (pipelined != null) return pipelined;
  }
  const tpl = resolveTemplatePromptForMode(plugin, mode, true);
  const sys = "你是一位专业的文字编辑助手，擅长把分段录音转写合并为连续、干净、忠实原意、结构清晰的 Markdown 文档。";
  let userPrompt = applyStructureLevelInstruction(tpl, plugin.settings, repolishOptions && repolishOptions.structureLevel).replace("{{TRANSCRIPT}}", joined);
  userPrompt = applyRepolishPreferenceInstruction(userPrompt, repolishOptions, plugin.settings);
  userPrompt = applyBriefingLanguageInstruction(userPrompt, plugin.settings);
  userPrompt = userPrompt.replace("{{STRUCTURE_INSTRUCTION}}", "");
  const adaptiveLength = buildAdaptiveBriefingLengthInstruction(mode, {
    durationMs: sessionMeta && sessionMeta.source === "text-import"
      ? getSessionMetaDurationMs(sessionMeta)
      : (getSegmentsDurationMs(segments) || getSessionMetaDurationMs(sessionMeta)),
    transcriptChars: joined.length,
    segmentCount: segments.length,
  });
  if (adaptiveLength) userPrompt = adaptiveLength + "\n\n---\n\n" + userPrompt;
  // 多声道分离出的说话人是既定事实：注入硬约束，覆盖各模式里「弱化/不强制标注说话人」的规则。
  const knownSpeakerClause = buildKnownSpeakerClause(
    resolveKnownSpeakerLabels(joined, originalFrontmatter),
  );
  if (knownSpeakerClause) userPrompt = knownSpeakerClause + "\n\n---\n\n" + userPrompt;
  const metaPrefix = buildSessionMetaPrefix(computedMeta, mode);
  if (metaPrefix) userPrompt = metaPrefix + "\n\n---\n\n" + userPrompt;
  const meetingWorkbenchPrompt = buildMeetingWorkbenchPrompt(computedMeta && computedMeta.meetingWorkbench);
  if (meetingWorkbenchPrompt) userPrompt = meetingWorkbenchPrompt + "\n\n---\n\n" + userPrompt;
  const peopleContext = await buildPeopleContextForLlm(plugin);
  if (peopleContext) userPrompt = peopleContext + "\n\n---\n\n" + userPrompt;
  // 流式：merge 是最长、最贵、跑一次的调用。流式 + 空闲超时确保服务端只要在持续输出就不会被
  // 客户端总超时 abort，避免"扣了钱却因超时拿不到结果"的浪费（符合总纲：不因工程缺陷浪费）。
  let mergeResult;
  try {
    mergeResult = await callBriefingMergeLlm(plugin, sys, userPrompt, Object.assign(
      {
        stream: true,
        thinkingMode: "fast",
        payload: { max_tokens: briefingMergeMaxTokens },
      },
      createBriefingLlmActivityOptions(plugin, computedMeta, {
        stage: "llm",
        stageLabel: "AI 正在整理正文",
        detail: "模型正在根据原始转写生成纪要",
        progress: 18,
      }),
    ), { mode, segmentCount: segments.length, transcriptChars: joined.length });
  } catch (e) {
    // 上下文限制不是普通网络重试问题：把同一份超长 prompt 再发一遍只会重复失败或重复计费。
    // 第一次明确收到上下文超限后，立即切换到时间分段路径；分段失败的部分由原始转写保底。
    if (isLlmContextLimitError(e) && segments.length >= 2) {
      await logLlmRequestDiagnostic(plugin, "warn", "llm.merge_context_chunk_retry", "单次整理上下文超限，已切换为分段整理", {
        mode,
        segmentCount: segments.length,
        transcriptChars: joined.length,
        error: diagnosticError(e),
      });
      const chunked = await mergeAndPolishLongSession(plugin, segments, mode, computedMeta, originalFrontmatter, repolishOptions, runtimeCeiling, true);
      if (chunked != null) return chunked;
    }
    throw e;
  }
  const { text: raw, truncated } = mergeResult;
  if (!String(raw || "").trim()) {
    const fallback = renderLongSessionRawFallbackGroup(segments, 1);
    const warning = buildEmptyLlmOutputFallback();
    await logLlmRequestDiagnostic(plugin, "warn", "llm.merge_raw_transcript_fallback", "AI 整理没有正文，已保留原始转写", {
      mode,
      segmentCount: segments.length,
      transcriptChars: joined.length,
    });
    const fallbackOutput = postProcessBriefingOutput(fallback, mode, computedMeta, originalFrontmatter, frontmatterBaseModeKey(plugin, mode), warning);
    return fallbackOutput;
  }
  const sedimentPreExtraction = extractSedimentPreExtractionBlock(raw);
  const auditedOutput = appendEntityEvidenceWarning(sedimentPreExtraction.cleaned, joined);
  // 截断告警 + 文本导入预压缩告警合并成顶部 notice（都属"纪要可能不完整/有损"，一起提示）。
  const topNotices = [];
  if (truncated) topNotices.push(BRIEFING_TRUNCATION_WARNING);
  if (preSummarized) topNotices.push(BRIEFING_PRESUMMARY_NOTICE);
  const polished = postProcessBriefingOutput(auditedOutput, mode, computedMeta, originalFrontmatter, frontmatterBaseModeKey(plugin, mode), topNotices.join("\n\n"));
  return sedimentPreExtraction.objects ? appendSedimentPreExtractionBlock(polished, sedimentPreExtraction.objects) : polished;
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
