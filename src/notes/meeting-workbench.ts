/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// @ts-nocheck
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：会中补充材料与交互

import * as obsidian from "obsidian";
import { formatElapsed } from "../shared/util-common";

export const MEETING_INTERACTION_OUTLINE_MAX_CHARS = 1200;

export const MEETING_INTERACTION_MEMORY_MAX_CHARS = 800;

export const MEETING_INTERACTION_SEGMENT_MAX_CHARS = 700;

export const MEETING_INTERACTION_TIMEOUT_MS = 35000;

// 即时问答 max_tokens 按触发符分档（按总纲："够用不截"）：
// - ?问题：直接回答，短句 5 条；轻度放宽
// - !重点：说明保留理由 + 在最终纪要中如何处理；中档
// - #概念：定义 + 用法 + 上下位 + 在当前讨论里的意义；最容易被截断，最大档
export const MEETING_INTERACTION_MAX_TOKENS = 320;

export const MEETING_INTERACTION_CONCEPT_MAX_TOKENS = 700;

export const MEETING_INTERACTION_IMPORTANT_MAX_TOKENS = 500;

// 最终纪要（merge）max_tokens：按材料体量计算需求；只有明确识别为旧模型时才钳制。
// 新模型、网关模型和本地模型不再套用历史 8K 默认值，服务端若拒绝会由 llm/core.ts 有界降档。

export function normalizeMeetingMaterials(materials, limit = 30) {
  const normalized = [];
  const seen = new Set();
  for (const item of (Array.isArray(materials) ? materials : [])) {
    if (!item || typeof item !== "object") continue;
    const path = obsidian.normalizePath(item.path || "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    normalized.push({
      path,
      name: String(item.name || path.split("/").pop() || "").trim(),
      kind: String(item.kind || item.type || "").trim(),
      addedAt: String(item.addedAt || ""),
    });
  }
  return normalized.slice(-limit);
}

export function normalizeMeetingWorkbench(value) {
  const raw = value && typeof value === "object" ? value : {};
  const entries = [];
  for (const item of (Array.isArray(raw.entries) ? raw.entries : [])) {
    if (!item || typeof item !== "object") continue;
    const text = String(item.text || "").trim();
    const materials = normalizeMeetingMaterials(item.materials, 12);
    if (!text && !materials.length) continue;
    const createdAt = String(item.createdAt || item.addedAt || "");
    const atMs = Math.max(0, Number(item.atMs ?? item.offsetMs ?? 0) || 0);
    const rawInteraction = item.interaction && typeof item.interaction === "object" ? item.interaction : null;
    const interaction = rawInteraction ? {
      kind: String(rawInteraction.kind || "").trim(),
      query: String(rawInteraction.query || "").trim(),
      status: String(rawInteraction.status || "").trim(),
      response: String(rawInteraction.response || "").trim(),
      error: String(rawInteraction.error || "").trim(),
      updatedAt: String(rawInteraction.updatedAt || ""),
    } : null;
    entries.push({
      id: String(item.id || `meeting-entry-${entries.length}-${atMs}-${createdAt || "time"}`),
      atMs,
      createdAt,
      source: String(item.source || (materials.length && !text ? "material" : "manual")),
      text,
      materials,
      interaction,
    });
  }
  return {
    notes: String(raw.notes || "").trim(),
    draft: String(raw.draft || ""),
    materials: normalizeMeetingMaterials(raw.materials, 30),
    entries: entries.slice(-100),
  };
}

// 元数据型符号（不触发 AI 即时助理，只用于结构化标注 + 传给 merge prompt）
export const MEETING_METADATA_KINDS = new Set(["assignee", "todo"]);

export function detectMeetingWorkbenchInteraction(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  // ---------- AI 触发型（concept / question / focus） ----------
  let match = value.match(/^[#＃]\s*(.+)$/);
  if (match && String(match[1] || "").trim()) {
    return { kind: "concept", query: String(match[1] || "").trim() };
  }
  match = value.match(/^[?？]\s*(.+)$/);
  if (match && String(match[1] || "").trim()) {
    return { kind: "question", query: String(match[1] || "").trim() };
  }
  match = value.match(/^[!！]\s*(.+)$/);
  if (match && String(match[1] || "").trim()) {
    return { kind: "focus", query: String(match[1] || "").trim() };
  }
  // ---------- 元数据型（assignee / todo） ----------
  // @xxx [任务内容]：指派给某人；assignee 取首个空白前的 token，余下作为任务说明
  match = value.match(/^[@＠]\s*(\S+)(?:\s+(.+))?$/);
  if (match && String(match[1] || "").trim()) {
    return {
      kind: "assignee",
      assignee: String(match[1] || "").trim(),
      task: String(match[2] || "").trim(),
    };
  }
  // /任务内容：创建待办；可在任务文本里再用 @xxx 标注负责人
  match = value.match(/^[/／]\s*(.+)$/);
  if (match && String(match[1] || "").trim()) {
    const raw = String(match[1] || "").trim();
    const innerAssignee = raw.match(/[@＠](\S+)/);
    return {
      kind: "todo",
      task: innerAssignee ? raw.replace(/\s*[@＠]\S+\s*/g, " ").trim() : raw,
      assignee: innerAssignee ? String(innerAssignee[1] || "").trim() : "",
    };
  }
  return null;
}

export function clipMeetingInteractionSegmentLine(line) {
  const text = String(line || "").trim();
  if (text.length <= MEETING_INTERACTION_SEGMENT_MAX_CHARS) return text;
  return text.slice(0, MEETING_INTERACTION_SEGMENT_MAX_CHARS - 1).trimEnd() + "…";
}

export function getMeetingInteractionMaxTokens(kind) {
  const raw = String(kind || "").toLowerCase();
  if (raw === "concept") return MEETING_INTERACTION_CONCEPT_MAX_TOKENS;
  if (raw === "focus" || raw === "important") return MEETING_INTERACTION_IMPORTANT_MAX_TOKENS;
  return MEETING_INTERACTION_MAX_TOKENS;
}

export function hasMeetingWorkbenchContent(value) {
  const workbench = normalizeMeetingWorkbench(value);
  return !!(workbench.notes || workbench.materials.length || workbench.entries.length);
}

export function isImageMeetingMaterial(item) {
  const path = String((item && item.path) || "").toLowerCase();
  const kind = String((item && item.kind) || "").toLowerCase();
  return kind === "image" || /\.(png|jpe?g|webp|gif|bmp|svg)$/.test(path);
}

export function buildMeetingWorkbenchPrompt(value) {
  const workbench = normalizeMeetingWorkbench(value);
  if (!hasMeetingWorkbenchContent(workbench)) return "";
  const lines = [
    "## 会中补充材料（用户在 QnALog 侧边栏手动提供）",
    "",
    "这些内容不是音频转写原文，而是用户在会议过程中补充的背景、零散想法或演示资料。整理纪要时请作为辅助上下文使用：",
    "- 音频转写仍然是事实主线；补充材料用于识别议题、PPT 结构、上下文和用户特别关注点。",
    "- 如果补充材料和转写冲突，以转写中明确出现的讨论为准，并避免把未讨论的材料硬写成会议结论。",
    "- 如果用户上传的是 PPT、图片或 PDF，当前只提供文件名和链接；可以基于文件名、用户备注和转写内容判断关联主题，不要虚构图片/PPT 里的具体文字。",
    "",
  ];
  if (workbench.notes) {
    lines.push("### 用户零散记录", workbench.notes, "");
  }
  if (workbench.entries.length) {
    // 把元数据 kinds 单独拎出来，让 merge LLM 能直接识别"指派"和"待办"两类结构化标注
    const assigneeEntries = workbench.entries.filter(e => e.interaction && e.interaction.kind === "assignee");
    const todoEntries = workbench.entries.filter(e => e.interaction && e.interaction.kind === "todo");
    if (assigneeEntries.length) {
      lines.push("### 用户指派（@ 符号）—— 视为权威的角色归属，正文应据此署名");
      for (const entry of assigneeEntries) {
        const time = formatElapsed(entry.atMs || 0);
        const who = entry.interaction.assignee || "未指定";
        const task = entry.interaction.task ? `：${entry.interaction.task}` : "";
        lines.push(`- [${time}] @${who}${task}`);
      }
      lines.push("");
    }
    if (todoEntries.length) {
      lines.push("### 用户标记的待办（/ 符号）—— 必须写入最终纪要的待办区，不要遗漏");
      for (const entry of todoEntries) {
        const time = formatElapsed(entry.atMs || 0);
        const task = entry.interaction.task || entry.text || "未命名待办";
        const who = entry.interaction.assignee ? ` 责任人：${entry.interaction.assignee}` : "";
        lines.push(`- [${time}] ${task}${who}`);
      }
      lines.push("");
    }
    // 其他普通 / AI 触发型补充
    const otherEntries = workbench.entries.filter(e => !e.interaction || !MEETING_METADATA_KINDS.has(e.interaction.kind));
    if (otherEntries.length) {
      lines.push("### 用户补充");
      for (const entry of otherEntries) {
        const time = formatElapsed(entry.atMs || 0);
        const text = entry.text ? ` ${entry.text}` : "";
        lines.push(`- [${time}]${text}`);
        if (entry.interaction && entry.interaction.response) {
          lines.push(`  - AI 补充：${String(entry.interaction.response).replace(/\r?\n/g, "；")}`);
        }
        for (const item of entry.materials || []) {
          const name = item.name || item.path.split("/").pop() || item.path;
          const kind = item.kind ? ` · ${item.kind}` : "";
          lines.push(`  - 附件：[[${item.path}|${name}]]${kind}`);
        }
      }
      lines.push("");
    }
  }
  if (workbench.materials.length) {
    lines.push("### 用户补充附件");
    for (const item of workbench.materials) {
      const name = item.name || item.path.split("/").pop() || item.path;
      const kind = item.kind ? ` · ${item.kind}` : "";
      lines.push(`- [[${item.path}|${name}]]${kind}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
