/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：笔记内的 details 区块构造与面板数据提取

import { hasMeetingWorkbenchContent, isImageMeetingMaterial, normalizeMeetingWorkbench } from "./meeting-workbench";

import { collectLexVoiceAudioRefs, getAudioTimeLink, getSessionMasterAudioName } from "./audio-refs";

import { detectRecentNoteMode } from "../recent/recent-notes";

import { isTextImportSession } from "./note-markdown";

import { extractSedimentPreExtractionBlock } from "../sediment";

import { formatElapsed, stripHtmlText } from "../shared/util-common";

import { escapeHtmlText } from "../shared/util-markdown";

import { extractSpeakerIdsFromMarkdown, normalizeSpeakerMappings } from "../audio/channel-speakers";

export function buildMeetingWorkbenchDetails(session) {
  const workbench = normalizeMeetingWorkbench(session && session.meetingWorkbench);
  if (!hasMeetingWorkbenchContent(workbench)) return "";
  const lines = [];
  if (workbench.notes) {
    lines.push("#### 会中零散记录", "", workbench.notes, "");
  }
  if (workbench.entries.length) {
    lines.push("#### 用户补充", "");
    for (const entry of workbench.entries) {
      const text = entry.text ? ` ${entry.text}` : "";
      lines.push(`- ${formatElapsed(entry.atMs || 0)}${text}`);
      if (entry.interaction && entry.interaction.response) {
        lines.push(`  - AI：${String(entry.interaction.response).replace(/\r?\n/g, "\n    ")}`);
      }
      for (const item of entry.materials || []) {
        const name = item.name || item.path.split("/").pop() || item.path;
        const kind = item.kind ? ` · ${item.kind}` : "";
        if (isImageMeetingMaterial(item)) {
          lines.push(`  - [[${item.path}|${name}]]${kind}`, `  ![[${item.path}]]`);
        } else {
          lines.push(`  - [[${item.path}|${name}]]${kind}`);
        }
      }
    }
    lines.push("");
  }
  if (workbench.materials.length) {
    lines.push("#### 补充材料", "");
    for (const item of workbench.materials) {
      const name = item.name || item.path.split("/").pop() || item.path;
      const kind = item.kind ? ` · ${item.kind}` : "";
      if (isImageMeetingMaterial(item)) {
        lines.push(`- [[${item.path}|${name}]]${kind}`, `![[${item.path}]]`, "");
      } else {
        lines.push(`- [[${item.path}|${name}]]${kind}`);
      }
    }
    lines.push("");
  }
  return [
    "<details>",
    "<summary>会中补充材料</summary>",
    "",
    lines.join("\n").trim(),
    "",
    "</details>",
  ].join("\n");
}

// 回听时间轴模块（保留函数与样式做向后兼容；新纪要不再注入）。
// 大纲一级条目本身已挂回听锚点 [[file|HH:MM]]，逐段时间戳列表对用户冗余 —— 关闭。
// 不删函数体里的 session-segments 处理与 details 渲染：老笔记里已存在的回听时间轴
// 由侧边栏 panel 渲染（renderRecentDetail 等），仍能正常显示；
// 这里只关闭"新写入"的注入点。
export function buildPlaybackTimelineDetails(session) {
  // 显式关闭：返回空串 → 后续 lines 拼接里 `|| null` 自动跳过这一块
  // 若以后想恢复，把下一行删掉即可；底层渲染逻辑完整保留
  return "";
  // eslint-disable-next-line no-unreachable -- intentionally disabled feature; unreachable code retained for easy restore
  const segments = (session && Array.isArray(session.segments)) ? session.segments : [];
  if (!segments.length) return "";
  const lines = [];
  for (const s of segments) {
    if (!s || !s.audioName) continue;
    const audioName = String(s.audioName || "").trim();
    const start = formatElapsed(s.startOffsetMs || 0);
    const end = formatElapsed(s.endOffsetMs || 0);
    const label = `${start}–${end}`;
    const n = Number.isFinite(s.index) ? s.index + 1 : lines.length + 1;
    const pillCls = s.error ? "lexvoice-playback-timeline-pill is-error" : "lexvoice-playback-timeline-pill";
    const metaCls = s.error ? "lexvoice-playback-timeline-index is-error" : "lexvoice-playback-timeline-index";
    const state = s.error ? "重试" : `段 ${n}`;
    lines.push(
      `<span class="${pillCls}">` +
      `<a class="internal-link lexvoice-time-link" data-href="${escapeHtmlText(audioName)}" href="${escapeHtmlText(audioName)}">${escapeHtmlText(label)}</a>` +
      `<span class="${metaCls}">${escapeHtmlText(state)}</span>` +
      `</span>`
    );
  }
  if (!lines.length) return "";
  return [
    "<details>",
    `<summary>回听时间轴（${lines.length} 个节点）</summary>`,
    "",
    '<div class="lexvoice-playback-timeline">',
    lines.join(""),
    "</div>",
    "",
    "</details>",
  ].join("\n");
}

export function extractLexVoiceDetailsBody(markdown, summaryPattern) {
  const text = String(markdown || "");
  const re = /<details>\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*?)<\/details>/gi;
  let match;
  while ((match = re.exec(text))) {
    const summary = stripHtmlText(match[1]);
    if (summaryPattern.test(summary)) return String(match[2] || "").trim();
  }
  return "";
}

export function extractLexVoiceNotePanelData(plugin, file, markdown) {
  const text = String(markdown || "");
  const sedimentPreExtraction = extractSedimentPreExtractionBlock(text);
  const hasMarker = /<!--\s*lexvoice-session(?::|\s*--)/.test(text)
    || /<!--\s*lexvoice-segments-start/.test(text);
  const outlineRaw = extractLexVoiceDetailsBody(text, /录音中实时大纲/);
  const outline = outlineRaw
    .replace(/^>\s*基于录音过程中已完成的分段自动生成[^\n]*\n?/m, "")
    .trim();
  const timeline = extractLexVoiceDetailsBody(text, /回听时间轴/);
  if (!hasMarker && !outline && !timeline) return null;
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/m, "");
  const h1 = body.match(/^#\s+(.+?)\s*$/m);
  const audioRefs = collectLexVoiceAudioRefs(text);
  const frontmatter = plugin && plugin.app && file
    ? (((plugin.app.metadataCache.getFileCache(file) || {}).frontmatter) || {})
    : {};
  const mode = plugin && file ? detectRecentNoteMode(plugin, file, frontmatter) : "";
  const speakerIds = extractSpeakerIdsFromMarkdown(text);
  const speakerMappings = normalizeSpeakerMappings(frontmatter.lexvoice_speakers, speakerIds);
  return {
    file,
    title: h1 ? h1[1].trim() : (file && file.basename ? file.basename : "QnALog 纪要"),
    mode,
    outline,
    timeline,
    audioRefs,
    hasMarker,
    preExtractedSediment: sedimentPreExtraction.objects,
    hasPreExtractedSediment: !!sedimentPreExtraction.objects,
    speakerIds,
    speakerMappings,
  };
}

export function buildRecordingInfoDetails(info) {
  const lines = [];
  if (info && info.startedAt && window.moment) {
    lines.push(`- 时间：${window.moment(info.startedAt).format("YYYY-MM-DD HH:mm:ss")}`);
  }
  if (info && info.totalMs != null) lines.push(`- 时长：${formatElapsed(info.totalMs)}`);
  if (info && info.modeLabel) lines.push(`- 模式：${info.modeLabel}`);
  if (info && info.segmentText) lines.push(`- 分段：${info.segmentText}`);
  else if (info && info.segmentCount != null) lines.push(`- 分段：${info.segmentCount}`);
  if (info && info.model) lines.push(`- 模型：${info.model}`);
  if (!lines.length) return "";
  return [
    "<details>",
    "<summary>录音信息</summary>",
    "",
    lines.join("\n"),
    "",
    "</details>",
  ].join("\n");
}

export function buildMasterAudioDetails(session, totalMs) {
  const audioName = getSessionMasterAudioName(session);
  if (!audioName) return "";
  return [
    "<details>",
    `<summary>原始音频（完整录音，${formatElapsed(totalMs || 0)}）</summary>`,
    "",
    `![[${audioName}]]`,
    "",
    `回听：${getAudioTimeLink(audioName, 0)}`,
    "",
    "</details>",
  ].join("\n");
}

export function buildTextImportInfoDetails(session, modeLabel, model) {
  if (!isTextImportSession(session)) return "";
  const lines = [];
  if (session.startedAt && window.moment) lines.push(`- 时间：${window.moment(session.startedAt).format("YYYY-MM-DD HH:mm:ss")}`);
  if (modeLabel) lines.push(`- 模式：${modeLabel}`);
  const sources = Array.isArray(session.textImportSources) ? session.textImportSources : [];
  lines.push(`- 来源文件：${sources.length || (session.segments || []).length || 1}`);
  if (model) lines.push(`- 模型：${model}`);
  if (sources.length) {
    lines.push("", "来源：");
    for (const item of sources) {
      const name = item.name || (item.path ? item.path.split("/").pop() : "") || "未命名文本";
      lines.push(`- ${item.path ? `[[${item.path}|${name}]]` : name}`);
    }
  }
  return [
    "<details>",
    "<summary>导入文本信息</summary>",
    "",
    lines.join("\n"),
    "",
    "</details>",
  ].join("\n");
}

export function buildTextImportSourceDetails(session) {
  if (!isTextImportSession(session)) return "";
  const segments = Array.isArray(session.segments) ? session.segments : [];
  if (!segments.length) return "";
  const lines = [];
  segments.forEach((seg, i) => {
    const name = seg.sourceName || `文本 ${i + 1}`;
    const path = seg.sourcePath || "";
    const link = path ? `[[${path}|${name}]]` : name;
    const body = String(seg.rawText || seg.text || "").trim() || "_[此文本来源为空]_";
    lines.push(`### ${i + 1}. ${link}`, "", body, "");
  });
  return [
    "<details>",
    `<summary>导入文本原文（${segments.length} 个来源）</summary>`,
    "",
    lines.join("\n").trim(),
    "",
    "</details>",
  ].join("\n");
}

// ============================================================
// DashScope Paraformer Realtime 流式客户端（WebSocket）
// 协议：wss://dashscope.aliyuncs.com/api-ws/v1/inference
// 鉴权：Authorization: bearer <api_key> —— 在 Electron 渲染进程通过
//   require("ws") 走 Node 端 WebSocket 以支持自定义 header（浏览器原生 WebSocket 不支持）
// ============================================================

// ============================================================
// OpenAI Realtime · gpt-realtime-whisper（流式 ASR）
// 端点：wss://api.openai.com/v1/realtime
// 协议：session.update 设 session.type="transcription" → input_audio_buffer.append（base64 PCM 24kHz）
//       → conversation.item.input_audio_transcription.delta / .completed
// ============================================================

// ============================================================
// OpenAI Realtime · gpt-realtime-translate（流式语音翻译，仅取文字）
// 端点：wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate
// 协议：session.update 设 session.audio.output.language="zh"
//       session.input_audio_buffer.append（base64 PCM 24kHz）
//       → session.input_transcript.delta / .completed（原文）
//       → session.output_transcript.delta / .completed（译文）
//       output_audio.delta 直接丢弃
// ============================================================

export function buildExternalAudioSourceDetails(session) {
  const source = session && session.externalAudioSource;
  const name = String(source && source.name || "").trim();
  if (!name) return "";
  return [
    "<details>",
    "<summary>导入来源</summary>",
    "",
    `文件：${name}`,
    "",
    "源音频保留在同步文件夹中，未复制到当前知识库。",
    "",
    "</details>",
  ].join("\n");
}

export function renderLongSessionRawFallbackGroup(group, partIndex) {
  const list = Array.isArray(group) ? group : [];
  const start = formatElapsed(Number(list[0] && list[0].startOffsetMs) || 0);
  const end = formatElapsed(Number(list[list.length - 1] && list[list.length - 1].endOffsetMs) || 0);
  const segments = list.map((seg, index) => {
    const segStart = Math.max(0, Number(seg && seg.startOffsetMs) || 0);
    const segEnd = Math.max(segStart, Number(seg && seg.endOffsetMs) || segStart);
    const audioOffset = Math.max(0, Number(seg && seg.audioStartOffsetMs) || segStart);
    const anchor = seg && seg.audioName ? ` ${getAudioTimeLink(seg.audioName, audioOffset)}` : "";
    const text = String((seg && seg.text) || "").trim() || "（本段未获得可用转写内容）";
    return `### 段落 ${index + 1} · ${formatElapsed(segStart)}–${formatElapsed(segEnd)}${anchor}\n\n${text}`;
  }).join("\n\n");
  return `## 第 ${partIndex} 部分 · ${start}–${end}（原始转写保底）\n\n${segments || "（本部分没有可保留的原始转写片段）"}`;
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
