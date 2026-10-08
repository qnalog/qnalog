/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：笔记内的 details 区块构造与面板数据提取


import { collectAudioRefs } from "./audio-refs";
import { getAudioTimeLink } from "./audio-reference-text";

import { detectRecentNoteMode } from "../recent/recent-notes";

import { extractTranscriptSegments } from "./note-markdown";
import { buildNoteAudioTimeline } from "./note-audio-timeline";
import { stripArchivedOutlineSections } from "./outline-text";

import { extractSedimentPreExtractionBlock } from "../sediment";
import { readCurrentOutlineBlock } from "./outline-storage";

import { formatElapsed, stripHtmlText } from "../shared/util-common";

import { escapeHtmlText } from "../shared/util-markdown";
import { t } from "../shared/i18n";
import { iterateNoteDetailsBlocks } from "./note-document";


import { extractSpeakerIdsFromMarkdown, normalizeSpeakerMappings, readSpeakerMappings } from "../audio/channel-speakers";
import { NS_SEGMENTS_START_RE, NS_SESSION_RE } from "../shared/namespace";
import { labelPattern, labelText } from "../shared/note-labels";


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
    const pillCls = s.error ? "qnalog-playback-timeline-pill is-error" : "qnalog-playback-timeline-pill";
    const metaCls = s.error ? "qnalog-playback-timeline-index is-error" : "qnalog-playback-timeline-index";
    const state = s.error ? "重试" : `段 ${n}`;
    lines.push(
      `<span class="${pillCls}">` +
      `<a class="internal-link qnalog-time-link" data-href="${escapeHtmlText(audioName)}" href="${escapeHtmlText(audioName)}">${escapeHtmlText(label)}</a>` +
      `<span class="${metaCls}">${escapeHtmlText(state)}</span>` +
      `</span>`
    );
  }
  if (!lines.length) return "";
  return [
    "<details>",
    `<summary>${labelText("playbackTimeline")}（${lines.length} 个节点）</summary>`,
    "",
    '<div class="qnalog-playback-timeline">',
    lines.join(""),
    "</div>",
    "",
    "</details>",
  ].join("\n");
}


export function extractDetailsBody(markdown, summaryPattern) {
  const text = String(markdown || "");
  for (const range of iterateNoteDetailsBlocks(text)) {
    const summary = stripHtmlText(text.slice(range.summaryStart, range.summaryEnd));
    if (summaryPattern.test(summary)) return text.slice(range.bodyStart, range.bodyEnd).trim();
  }
  return "";
}

export function extractNotePanelData(plugin, file, markdown) {
  const text = String(markdown || "");
  const sedimentPreExtraction = extractSedimentPreExtractionBlock(text);
  const hasMarker = NS_SESSION_RE.test(text)
    || NS_SEGMENTS_START_RE.test(text);
  const currentOutline = readCurrentOutlineBlock(text);
  const outline = stripArchivedOutlineSections(currentOutline?.outline || "");
  const timeline = extractDetailsBody(text, labelPattern("playbackTimeline"));
  if (!hasMarker && !outline && !timeline) return null;
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/m, "");
  const h1 = body.match(/^#\s+(.+?)\s*$/m);
  const audioRefs = collectAudioRefs(text);
  const audioSegments = extractTranscriptSegments(text);
  const audioTimelineComplete = audioSegments.length > 0 && audioSegments.every(segment =>
    Number.isFinite(segment.startOffsetMs) && Number.isFinite(segment.endOffsetMs)
    && Number.isFinite(segment.audioStartOffsetMs) && Number.isFinite(segment.audioEndOffsetMs)
    && segment.endOffsetMs > segment.startOffsetMs
    && segment.audioEndOffsetMs > segment.audioStartOffsetMs
    && !!String(segment.audioPath || segment.sourcePath || "").trim()
    && !!String(segment.audioName || segment.sourceName || "").trim(),
  );
  const audioTimeline = audioTimelineComplete ? buildNoteAudioTimeline(audioSegments) : [];
  const frontmatter = plugin && plugin.app && file
    ? (((plugin.app.metadataCache.getFileCache(file) || {}).frontmatter) || {})
    : {};
  const mode = plugin && file ? detectRecentNoteMode(plugin, file, frontmatter) : "";
  const speakerIds = extractSpeakerIdsFromMarkdown(text);
  const speakerMappings = normalizeSpeakerMappings(readSpeakerMappings(frontmatter), speakerIds);
  return {
    file,
    title: h1 ? h1[1].trim() : (file && file.basename ? file.basename : t("QnALog minutes")),
    mode,
    outline,
    timeline,
    audioRefs,
    audioTimeline,
    audioTimelineComplete,
    hasMarker,
    preExtractedSediment: sedimentPreExtraction.objects,
    hasPreExtractedSediment: !!sedimentPreExtraction.objects,
    speakerIds,
    speakerMappings,
  };
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


export function renderLongSessionRawFallbackGroup(group, partIndex) {
  const list = Array.isArray(group) ? group : [];
  const start = formatElapsed(Number(list[0] && list[0].startOffsetMs) || 0);
  const end = formatElapsed(Number(list[list.length - 1] && list[list.length - 1].endOffsetMs) || 0);
  const segments = list.map((seg, index) => {
    const segStart = Math.max(0, Number(seg && seg.startOffsetMs) || 0);
    const segEnd = Math.max(segStart, Number(seg && seg.endOffsetMs) || segStart);
    const audioOffset = Math.max(0, Number(seg && seg.audioStartOffsetMs) || segStart);
    const anchor = seg && seg.audioName ? ` ${getAudioTimeLink(seg.audioName, audioOffset)}` : "";
    const text = String((seg && seg.text) || "").trim() || labelText("noUsableTranscript");
    return `### ${labelText("segment", index + 1)} · ${formatElapsed(segStart)}–${formatElapsed(segEnd)}${anchor}\n\n${text}`;
  }).join("\n\n");
  return `## ${labelText("rawFallbackPart", partIndex, start, end)}\n\n${segments || labelText("noRawSegmentsInPart")}`;
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
