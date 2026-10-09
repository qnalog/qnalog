/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：笔记 Markdown 的解析与生成（版本块、frontmatter 后处理、逐字稿区块、标题与文件名、邮件草稿）——这几个关注点相互引用，合并为一个模块以避免循环导入

import { collectAudioRefs, getAudioLinkTarget, getDurationMs } from "./audio-refs";

import { QNALOG_ACTIVE_VERSION_END, QNALOG_ACTIVE_VERSION_START, QNALOG_EMPTY_SHORT_LIMIT_MS, TEXT_IMPORT_PRE_SUMMARY_MAX_CHUNKS, TEXT_IMPORT_PRE_SUMMARY_THRESHOLD_CHARS } from "../shared/limits";

import { normalizeCallouts } from "./callout-normalize";

import { buildEmptyLlmOutputFallback, formatMergeSegmentForPrompt } from "../prompts/briefing-prompts";

import * as obsidian from "obsidian";
import { findLowEvidenceEntities, hashRealtimeOutlineText } from "./outline-text";


import { getCustomPromptModeTemplate, getCustomPromptModeTemplates, getModeMeta, getModePrefix } from "../shared/mode-meta";

import { TEXT_IMPORT_PRE_SUMMARY_CHUNK_CHARS, parseElapsedMsToken, splitLongTextForLlm } from "../shared/util-text";


import { mergeUniqueStrings, normalizePersonLookupText, normalizePersonNameForEmail, parsePeopleFromOutput, splitPersonFieldValue } from "../people";

import { extractSedimentPreExtractionBlock } from "../sediment";
import { stripSedimentPreExtractionBlocks } from "../sediment/text-blocks";
import { removeNoteIndex } from "../indexing/note-index";

import { callLlm, logLlmRequestDiagnostic, stripModeSuggestionBlocks } from "../llm/core";

import { DEFAULT_SETTINGS } from "../shared/defaults";
import { labelText, labelPattern } from "../shared/note-labels";
import { NS_FM, NS_FM_SPEAKERS, NS_TAG, NS_SEDIMENT_LINE_BEGIN_RE, NS_MACHINE_SHELL_RE, NS_SEGMENTS_START_RE, NS_SESSION_RE, NS_TAGS_RE, NS_TAG_PREFIX, hasNamespaceFrontmatter, nsMarkerGlobalRe, nsRe, readNamespaceFrontmatter } from "../shared/namespace";
import type { NamespaceFrontmatterField } from "../shared/namespace";

import { MODE_META, MODE_PREFIX_EN_TO_KEY, MODE_PREFIX_TO_KEY } from "../shared/catalog-modes";

import { escapeRegExp, formatElapsed, primitiveText, sanitizeFilename } from "../shared/util-common";

import { diagnosticError } from "../shared/util-key-diag";

import { sanitizeActiveVersionBody } from "../versions/version-content";
import { extractAllRawBlocksFromText, extractSessionId, findNoteDelimitedBlock, iterateNoteHeadingBlocks, replaceExistingActiveVersionBlock, splitLeadingFrontmatter, stripFrontmatterSimple } from "./note-document";
import type { Segment } from "../shared/types";
import { attachTextTranscript } from "../transcript/session-transcript";
import { readTranscriptBlocks, replaceTranscriptBlock, serializeTranscriptBlock } from "../transcript/transcript-markdown";

import { readSpeakerMappings, speakerLabelForChannel } from "../audio/channel-speakers";

import { extractBriefingPartEnvelope } from "../briefing/pipeline";

import { getActiveUiLanguage, t } from "../shared/i18n";
import { parseSessionKnowledgeResponse, stripSessionKnowledgeBlocks } from "../briefing/session-knowledge";
const LEGACY_TRANSCRIPT_HEADING_RE = /^###\s+(?:(?:段落|Segment|Audio(?: source)?|Text source|音频|文本来源)\s+(\d+)([^\n]*)|(\d+)[.、]\s*([^\n]*))$/gm;
export function isTimeLabel(text) {
  const time = "(?:\\d{1,2}:)?\\d{1,2}:\\d{2}";
  return new RegExp("^" + time + "(?:\\s*[–-]\\s*" + time + ")?$").test(String(text || "").trim());
}

export function stripAutoTitleSuffix(stem, settings) {
  // 中英两种前缀都要剥：同一篇笔记可能在不同语言下被重命名过，
  // 只认一种会让另一种残留，后缀越叠越长。
  const prefixes = Object.values(MODE_META)
    .flatMap(m => [sanitizeFilename(m && m.prefix), sanitizeFilename(m && m.label)])
    .concat(getCustomPromptModeTemplates(settings || {}).map(t => sanitizeFilename(t.name)))
    .filter(Boolean);
  const unique = Array.from(new Set(prefixes)).sort((a, b) => b.length - a.length);
  if (!unique.length) return String(stem || "").trim();
  const re = new RegExp("\\s*·\\s*(?:" + unique.map(escapeRegExp).join("|") + ")-[^·/\\\\]+$");
  return String(stem || "").replace(re, "").trim();
}

/**
 * 去掉标题开头的模板名前缀（含历史别名与另一种语言的前缀），保留其后的主题标签。
 *
 * 与 stripAutoTitleSuffix 的区别：后者连主题一起剥掉，用于重命名前取回纯日期 stem；
 * 这里只剥前缀，用于「日期 · 主题」这类标题显示。
 */
export function stripModePrefixFromTitle(title, settings) {
  let out = String(title || "").trim();
  const prefixes = Object.entries(MODE_PREFIX_TO_KEY).map(([prefix]) => prefix)
    .concat(Object.keys(MODE_PREFIX_EN_TO_KEY))
    .concat(getCustomPromptModeTemplates(settings || {}).map(t => t.name))
    .map(p => String(p || "").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  // 前缀可能出现在行首，也可能跟在一个分隔符之后（`2026-09-16 0852 · 个人笔记-主题`）。
  for (const p of prefixes) {
    const atStart = new RegExp("^" + escapeRegExp(p) + "[-·\\s]+");
    const afterSep = new RegExp("(\\s*[·•]\\s*)" + escapeRegExp(p) + "[-·\\s]*");
    if (atStart.test(out)) { out = out.replace(atStart, "").trim(); break; }
    if (afterSep.test(out)) { out = out.replace(afterSep, "$1"); break; }
  }
  return out;
}

export function buildRenamedMarkdownPath(currentPath, mode, titleTag, settings) {
  const norm = obsidian.normalizePath(String(currentPath || ""));
  const slash = norm.lastIndexOf("/");
  const dir = slash >= 0 ? norm.slice(0, slash) : "";
  const name = slash >= 0 ? norm.slice(slash + 1) : norm;
  const stem = stripAutoTitleSuffix(name.replace(/\.md$/i, ""), settings);
  const meta = getModeMeta(settings, mode);
  // 文件名与界面标题一致，随界面语言；两种前缀在读取时都能解析回同一 mode。
  const modePrefix = sanitizeFilename(getModePrefix(meta) || "自定义") || "自定义";
  const tag = sanitizeFilename(titleTag) || "";
  if (!stem || !tag) return "";
  const nextName = `${stem} · ${modePrefix}-${tag}.md`;
  return obsidian.normalizePath(dir ? `${dir}/${nextName}` : nextName);
}

export function getSourceIdFromMarkdown(markdown, file) {
  const text = String(markdown || "");
  const sessionId = extractSessionId(text, "");
  if (sessionId) return sanitizeFilename(sessionId) || sessionId;
  const basis = `${file && file.path || "note"}:${file && file.stat && file.stat.ctime || ""}`;
  return `note-${hashRealtimeOutlineText(basis)}`;
}

export function buildSegmentStatusList(segments) {
  return (segments || []).map((seg, i) => {
    const text = String(seg && seg.text || "").trim();
    const start = Number(seg && seg.startOffsetMs) || 0;
    const end = Number(seg && seg.endOffsetMs) || start;
    return {
      id: `seg-${String(i + 1).padStart(4, "0")}`,
      index: i,
      startOffsetMs: start,
      endOffsetMs: end,
      status: text ? "done" : "pending",
      textHash: text ? hashRealtimeOutlineText(text) : "",
    };
  });
}

export function getVersionStoreFolder(settings, sourceId) {
  const base = obsidian.normalizePath(String(settings && settings.mdFolder || DEFAULT_SETTINGS.mdFolder || "QnALog"));
  const safeId = sanitizeFilename(sourceId) || "unknown-session";
  return obsidian.normalizePath(`${base}/.versions/${safeId}`);
}

export function normalizeVersionId(label) {
  const stamp = window.moment ? window.moment().format("YYYYMMDD-HHmmss") : new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const safe = sanitizeFilename(label) || "version";
  return `${stamp}-${safe}`;
}

export function buildActiveVersionBlock(versionMeta, body) {
  const label = String(versionMeta && versionMeta.label || versionMeta && versionMeta.kind || labelText("currentVersion"));
  const created = String(versionMeta && versionMeta.createdAt || "");
  const sourceHash = String(versionMeta && versionMeta.sourceHash || "");
  // label 已含模式前缀与整理偏好，不再拼内部 mode 键（monologue 这类键直接见了用户）。
  // 折叠默认收起：版本卡是元数据，正文摘要应当先被看到。
  const metaLines = [
    `> [!info]- ${labelText("currentDisplayedVersionLabel")}${label}`,
    created ? `> ${labelText("versionGeneratedAtLabel")}${created}` : "",
    sourceHash ? `> ${labelText("sourceTranscriptFingerprintLabel")}${sourceHash}` : "",
  ].filter(Boolean).join("\n");
  return [
    QNALOG_ACTIVE_VERSION_START,
    metaLines,
    "",
    sanitizeActiveVersionBody(body),
    QNALOG_ACTIVE_VERSION_END,
  ].join("\n").replace(/\n{4,}/g, "\n\n\n");
}

export function replaceActiveVersionBlock(markdown, versionMeta, body) {
  const text = String(markdown || "");
  const block = buildActiveVersionBlock(versionMeta, body);
  const replaced = replaceExistingActiveVersionBlock(text, block);
  if (replaced !== null) return replaced;
  // First adoption of the version model compacts the mother note:
  // keep only frontmatter, H1, active display block, and raw/source metadata.
  // The previous rendered minutes/clean text is already persisted in the version store.
  const extracted = extractAllRawBlocksFromText(text);
  const parts = splitLeadingFrontmatter(extracted.withoutRaw);
  const bodyText = parts.body || "";
  const titleMatch = bodyText.match(/^#\s+[^\n]+\n*/);
  const rawTail = extracted.tail ? `\n\n---\n\n${extracted.tail.trimEnd()}\n` : "\n";
  if (titleMatch) {
    const titleBlock = titleMatch[0].trimEnd();
    return [
      parts.frontmatter ? parts.frontmatter.trimEnd() : "",
      titleBlock,
      "",
      block,
    ].filter(Boolean).join("\n") + rawTail;
  }
  return [
    parts.frontmatter ? parts.frontmatter.trimEnd() : "",
    block,
  ].filter(Boolean).join("\n") + rawTail;
}



export function clampProgress(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// 折叠壳剥离模式（中英双语，`<summary>` 后的标签词中英任一即整块剥除）：
// 目录 labelPattern 可直接嵌入的（导入文本信息/回听时间轴）从目录取；目录项带
// （N 个来源）/（草稿）/（N 段）后缀的按裸前缀写中英分支，避免收窄旧笔记的匹配面。
const IMPORT_APPENDIX_DETAILS_RES = [
  new RegExp(`<details>\\s*<summary>\\s*(?:${labelPattern("importedTextInfo").source})[\\s\\S]*?<\\/details>`, "gi"),
  /<details>\s*<summary>\s*(?:导入文本原文|Imported text \()[\s\S]*?<\/details>/gi,
  /<details>\s*<summary>\s*(?:录音中实时大纲|Live outline while recording)[\s\S]*?<\/details>/gi,
  new RegExp(`<details>\\s*<summary>\\s*(?:${labelPattern("playbackTimeline").source})[\\s\\S]*?<\\/details>`, "gi"),
  /<details>\s*<summary>\s*(?:分段原始转写|Segmented raw transcript)[\s\S]*?<\/details>/gi,
];

export function stripImportAppendices(text) {
  // 索引块（标记+折叠壳）整块剥掉：后面喂提示词的路径未必再剥 HTML 注释。
  let out = removeNoteIndex(stripSedimentPreExtractionBlocks(String(text || "")))
    .replace(NS_MACHINE_SHELL_RE, "\n");
  for (const re of IMPORT_APPENDIX_DETAILS_RES) out = out.replace(re, "\n");
  return out;
}

export function cleanImportedTextForPrompt(text) {
  return String(text || "")
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractIntegratedBriefing(text) {
  const source = String(text || "");
  const matches = [...source.matchAll(new RegExp(`^##\\s+(?:✨\\s*)?(?:${labelPattern("mergedVersion").source})[^\\n]*$`, "gm"))];
  if (!matches.length) return "";
  const match = matches[matches.length - 1];
  const start = (match.index || 0) + match[0].length;
  const tail = source.slice(start);
  const stopPatterns = [
    new RegExp(`\\n<details>\\s*<summary>\\s*(?:${labelPattern("importedTextInfo").source})`, "i"),
    /\n<details>\s*<summary>\s*(?:导入文本原文|Imported text \()/i,
    NS_SEDIMENT_LINE_BEGIN_RE,
  ];
  const stop = stopPatterns
    .map((re) => {
      const m = re.exec(tail);
      return m ? m.index : -1;
    })
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0];
  return cleanImportedTextForPrompt(stop >= 0 ? tail.slice(0, stop) : tail);
}

export function extractRawTranscriptForImport(text) {
  const segments = extractTranscriptSegments(text);
  if (!segments.length) return "";
  return segments
    .map((seg, i) => {
      const label = Number.isFinite(seg.index) ? seg.index + 1 : i + 1;
      return [`### 原始转写 ${label}`, "", String(seg.text || "").trim()].join("\n");
    })
    .filter((block) => block.trim())
    .join("\n\n");
}

export function stripImportedTextSource(text) {
  const withoutFrontmatter = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .trim();
  if (!withoutFrontmatter) return "";

  const withoutAppendices = stripImportAppendices(withoutFrontmatter);
  const hasMarkerNames = NS_SESSION_RE.test(withoutFrontmatter)
    || NS_SEGMENTS_START_RE.test(withoutFrontmatter)
    || new RegExp(`##\\s+(?:✨\\s*)?(?:${labelPattern("mergedVersion").source})`).test(withoutFrontmatter);
  if (hasMarkerNames) {
    const integrated = extractIntegratedBriefing(withoutAppendices);
    if (integrated) return integrated;
    const rawTranscript = extractRawTranscriptForImport(withoutFrontmatter);
    if (rawTranscript) return rawTranscript;
  }

  return cleanImportedTextForPrompt(withoutAppendices);
}

export function markdownQuoteBlock(text) {
  const value = String(text || "").trim();
  if (!value) return "> ";
  return value.split(/\r?\n/).map(line => `> ${line}`).join("\n");
}

export function buildImportedTextSegment(source, index) {
  const file = source && source.file;
  const name = source && source.name ? source.name : (file && file.name) || `文本 ${index + 1}`;
  const path = source && source.path ? source.path : (file && file.path) || "";
  const link = path ? `[[${path}|${name}]]` : name;
  const body = String(source && source.text || "").trim();
  return [`【${labelText("textSource", index + 1)}${link}】`, "", body].join("\n");
}

export function splitImportedTextIntoNormalSegments(sources) {
  const result = [];
  let offsetMs = 0;
  const virtualSegmentMs = 5 * 60 * 1000;
  for (const source of sources || []) {
    const text = buildImportedTextSegment(source, result.length);
    if (!text.trim()) continue;
    result.push({
      index: result.length,
      startOffsetMs: offsetMs,
      endOffsetMs: offsetMs + virtualSegmentMs,
      audioName: "",
      audioPath: "",
      sourceName: source.name,
      sourcePath: source.path,
      rawText: source.text,
      text,
      error: null,
      isFinal: false,
    });
    offsetMs += virtualSegmentMs;
  }
  if (result.length) result[result.length - 1].isFinal = true;
  return result;
}


// canonical 属性与历史中文/英文属性都接受，写入只输出 canonical 形式。
export const EMAIL_ATTENDEE_FIELDS = [
  NS_FM.participants, NS_FM.interviewee, NS_FM.interviewer, NS_FM.decisionMaker,
  NS_FM.advisors, NS_FM.people, NS_FM.relatedPeople,
  "参会人", "与会人", "参与者", "出席人", "受访者", "访问者", "面试官", "候选人",
  "当事人", "参谋", "相关人员", "人员", "人物", "participants", "people",
];

export function normalizeEmailAddressList(value) {
  const raw = Array.isArray(value) ? value.flatMap(normalizeEmailAddressList) : String(value || "").split(/[，,、;；\s]+/);
  const emails = [];
  for (const item of raw) {
    const text = String(item || "").trim().replace(/^<|>$/g, "");
    if (!text) continue;
    const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (match) emails.push(match[0]);
  }
  return Array.from(new Set(emails.map(e => e.toLowerCase())));
}

export function extractMeetingAttendeeNames(frontmatter) {
  if (!frontmatter || typeof frontmatter !== "object") return [];
  const raw = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      const direct = value[NS_FM.name] || value["姓名"] || value.name || value["人员"] || value.person || value.label;
      if (direct) raw.push(direct);
      else Object.values(value).forEach(walk);
    } else if (value != null) {
      raw.push(...splitPersonFieldValue(value));
    }
  };
  for (const key of EMAIL_ATTENDEE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) walk(frontmatter[key]);
  }
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const name = normalizePersonNameForEmail(item);
    const key = normalizePersonLookupText(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function utf8ToBase64(value) {
  const text = String(value || "");
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, i + size));
  }
  return btoa(binary);
}

export function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  let binary = "";
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + size)));
  }
  return btoa(binary);
}

export function wrapBase64Lines(value) {
  return String(value || "").replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

export function encodeMailHeader(value) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").trim();
  return /[^\x20-\x7E]/.test(text) ? `=?UTF-8?B?${utf8ToBase64(text)}?=` : text;
}

export function sanitizeMailHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

export function guessEmailAttachmentMime(file) {
  const ext = String(file && file.extension || "").toLowerCase();
  if (ext === "md") return "text/markdown; charset=utf-8";
  if (ext === "pdf") return "application/pdf";
  if (ext === "html" || ext === "htm") return "text/html; charset=utf-8";
  return "application/octet-stream";
}

export function buildEmailDraftContent({ to = [], subject = "", body = "", attachments = [] }) {
  const boundary = `----=_QnALog_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const lines = [
    `To: ${to.map(sanitizeMailHeader).join(", ")}`,
    `Subject: ${encodeMailHeader(subject || "QnALog 会议纪要")}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "X-Unsent: 1",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64Lines(utf8ToBase64(body || "")),
    "",
  ];
  for (const attachment of attachments) {
    const name = attachment.name || "attachment";
    const encodedName = encodeMailHeader(name);
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mime || "application/octet-stream"}; name="${encodedName}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${encodedName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "",
      wrapBase64Lines(attachment.base64 || ""),
      "",
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

export function stripMarkdownForEmailBrief(markdown) {
  let text = stripFrontmatterSimple(String(markdown || ""));
  text = text.replace(/<details[\s\S]*?<\/details>/gi, "\n");
  text = text.replace(/<!--[\s\S]*?-->/g, "\n");
  const rawSplit = text.split(/\n(?=#{1,6}\s+(?:📁\s*)?(?:原始材料|原始转写|逐字稿|录音原文|回听时间轴|录音中实时大纲|Original material|Raw transcript|Verbatim transcript|Recording transcript|Playback timeline|Live outline while recording)(?!\w))/);
  return (rawSplit[0] || text).trim();
}

export function cleanEmailMarkdownLine(line) {
  let s = String(line || "").trim();
  if (!s) return "";
  if (/^```/.test(s)) return "";
  s = s.replace(/^>\s?/, "").trim();
  s = s.replace(/^\[![^\]]+\][+-]?\s*/i, "").trim();
  s = s.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim();
  if (!s || /^(录音信息|回听时间轴|原始材料|原始转写|逐字稿|录音原文|Recording info|Playback timeline|Original material|Raw transcript|Verbatim transcript|Recording transcript)$/i.test(s)) return "";
  if (/^!\[\[.+?\]\]$/.test(s) || /^!\[[^\]]*\]\([^)]+\)$/.test(s)) return "";
  s = s.replace(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "");
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
  s = s.replace(/\[\[([^\]]+)\]\]/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/<[^>]+>/g, "").trim();
  return s;
}

export function normalizeEmailBullet(line) {
  let s = cleanEmailMarkdownLine(line);
  if (!s) return "";
  if (/^[-*+]\s+\[[ xX]\]\s+/.test(s)) return s.replace(/^[-*+]\s+/, "- ");
  s = s.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
  return s ? `- ${s}` : "";
}

export function pushUniqueEmailLine(target, line, limit) {
  const value = cleanEmailMarkdownLine(line);
  if (!value || target.includes(value)) return;
  if (limit && target.length >= limit) return;
  target.push(value);
}

export function pushUniqueEmailBullet(target, line, limit) {
  const value = normalizeEmailBullet(line);
  if (!value || target.includes(value)) return;
  if (limit && target.length >= limit) return;
  target.push(value);
}

export function categorizeEmailBriefSection(title) {
  const t = String(title || "").replace(/\s+/g, "");
  if (!t) return "";
  if (/摘要|概要|核心摘要|研讨摘要|学习摘要|整体综述|主要内容/.test(t)) return "summary";
  if (/决策|决议|结论|定调|共识/.test(t)) return "decisions";
  if (/待办|行动项|下一步|后续动作|TODO|ToDo/i.test(t)) return "todos";
  if (/悬而未决|未决|待澄清|待确认|会后跟进|跟进|风险|开放问题|问题清单/.test(t)) return "pending";
  return "";
}

export function addEmailBriefLines(result, category, lines) {
  const list = Array.isArray(lines) ? lines : [];
  if (category === "summary") {
    for (const line of list) pushUniqueEmailLine(result.summary, line, 8);
    return;
  }
  if (category === "decisions") {
    for (const line of list) pushUniqueEmailBullet(result.decisions, line, 12);
    return;
  }
  if (category === "todos") {
    for (const line of list) pushUniqueEmailBullet(result.todos, line, 14);
    return;
  }
  if (category === "pending") {
    for (const line of list) pushUniqueEmailBullet(result.pending, line, 12);
  }
}

export function extractEmailCalloutBlocks(text, result) {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i] || "";
    if (!/^\s*>\s*\[!/.test(first)) continue;
    const block = [];
    let j = i;
    while (j < lines.length && (/^\s*>/.test(lines[j]) || !String(lines[j] || "").trim())) {
      block.push(lines[j]);
      j++;
    }
    const marker = first.match(/\[!([a-zA-Z-]+)\][+-]?\s*(.*)$/);
    const type = marker ? marker[1].toLowerCase() : "";
    const title = marker ? marker[2] : first;
    let category = categorizeEmailBriefSection(title);
    if (!category) {
      if (/abstract|summary|note/.test(type)) category = "summary";
      else if (/success|important|check|done/.test(type)) category = "decisions";
      else if (/todo|tip/.test(type)) category = "todos";
      else if (/question|warning|danger|caution|failure/.test(type)) category = "pending";
    }
    if (category) addEmailBriefLines(result, category, block.slice(1));
    i = Math.max(i, j - 1);
  }
}

export function extractEmailHeadingBlocks(text, result) {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = String(lines[i] || "").match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const category = categorizeEmailBriefSection(match[2]);
    if (!category) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s{0,3}#{1,6}\s+/.test(lines[j] || "")) break;
      body.push(lines[j]);
    }
    addEmailBriefLines(result, category, body);
  }
}

export function extractEmailTodoLines(text, result) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*>?\s*[-*+]\s+\[[ xX]\]\s+/.test(line || "")) {
      pushUniqueEmailBullet(result.todos, line, 14);
    }
  }
}

export function extractEmailFallbackSummary(text, result) {
  if (result.summary.length) return;
  const lines = String(text || "").split(/\r?\n/)
    .map(cleanEmailMarkdownLine)
    .filter(line => line && !/^[-*+]\s+/.test(line) && line.length >= 12);
  for (const line of lines.slice(0, 3)) pushUniqueEmailLine(result.summary, line, 3);
}

export function extractEmailBriefing(markdown) {
  const source = stripMarkdownForEmailBrief(markdown);
  const result = { summary: [], decisions: [], todos: [], pending: [] };
  extractEmailCalloutBlocks(source, result);
  extractEmailHeadingBlocks(source, result);
  extractEmailTodoLines(source, result);
  extractEmailFallbackSummary(source, result);
  return result;
}

export function buildEmailSection(title, lines) {
  const list = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (!list.length) return [];
  return [title, ...list, ""];
}

export function buildMeetingEmailBody({ file, markdown, attendeeNames = [], attachmentsCount = 0 }) {
  const brief = extractEmailBriefing(markdown);
  const body = [
    "你好，",
    "",
    "以下是本次纪要的简要同步，完整 Markdown、PDF 及已生成的报告已随邮件附上。",
    "",
    `纪要：${file && file.basename ? file.basename : "QnALog 会议纪要"}.md`,
    `自动匹配参会人：${attendeeNames.length ? attendeeNames.join("、") : "未识别到可匹配人员"}`,
    `附件数量：${attachmentsCount}`,
    "",
  ];
  const sections = [
    buildEmailSection("一、摘要", brief.summary),
    buildEmailSection("二、决策", brief.decisions),
    buildEmailSection("三、待办", brief.todos),
    buildEmailSection("四、会后跟进 / 悬而未决", brief.pending),
  ].flat();
  if (sections.length) {
    body.push(...sections);
  } else {
    body.push("本篇纪要未识别到可直接写入邮件正文的摘要、决策、待办或悬而未决事项，请以附件中的完整纪要为准。", "");
  }
  body.push("此邮件草稿由 QnALog 在本地生成。发送前请确认收件人、正文和附件是否正确。");
  return body.join("\n");
}

// 纯白弥散报告（seminar 研讨）：大模型按提取提示词只产出 DATA JSON，注入固定模板的哨兵段。
// 模型碰不到 CSS/版式（最省 token、最稳）。公司名由 reportBrandName 设置注入（默认空 → 沿用纪要「公司/」标签）；报告不含 logo。

// 报告生成前的配色选择器：预设或自定义颜色 → 返回 hex（取消/关闭返回 null）。报告按所选色相整体重着色。

export function cleanTranscriptBlock(block) {
  return String(block || "")
    .replace(/<!--[^>]*-->/g, "")
    .replace(/<summary>[\s\S]*?<\/summary>/gi, "")
    .replace(/<\/?details>/gi, "")
    .replace(/^###\s+(?:段落|Segment)\s+\d+[^\n]*$/gm, "")
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/^_\[(?:转写失败|等待后台转写|此段尚未完成转写|Transcription failed|Waiting for background transcription|This segment is not fully transcribed yet)[^\n]*$/gm, "")
    .replace(new RegExp(`^(?:${labelPattern("noContentSegment").source})$`, "gm"), "")
    .replace(/^\s*---\s*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitTranscriptSections(markdown) {
  const text = String(markdown || "");
  const sections = [];
  let searchFrom = 0;
  while (true) {
    const sectionLabels = ["分段原始转写", "Segmented raw transcript", "导入文本来源", "导入文本原文", "Text import sources", "Text import source"];
    const labelIndexes = sectionLabels.map((label) => text.indexOf(label, searchFrom)).filter((index) => index >= 0);
    const labelIdx = labelIndexes.length ? Math.min(...labelIndexes) : -1;
    if (labelIdx < 0) break;
    const range = findNoteDelimitedBlock(text, /<\/summary>/g, /<\/details>/g, labelIdx);
    if (range) {
      sections.push(text.slice(range.bodyStart, range.bodyEnd));
      searchFrom = range.end;
    } else {
      searchFrom = labelIdx + 1;
    }
  }

  let markerSearchFrom = 0;
  while (true) {
    const range = findNoteDelimitedBlock(
      text,
      nsMarkerGlobalRe("segments-start"),
      nsMarkerGlobalRe("segments-end"),
      markerSearchFrom,
    );
    if (!range) break;
    sections.push(text.slice(range.bodyStart, range.bodyEnd));
    markerSearchFrom = range.bodyStart;
  }

  if (!sections.length) {
    // 兜底老格式「原始转写：…」/「Raw transcript: …」：取两者中靠后的一处。
    const zhRawIdx = text.lastIndexOf("原始转写：");
    const enRawIdx = text.lastIndexOf("Raw transcript:");
    if (zhRawIdx >= 0 || enRawIdx >= 0) {
      const useZh = zhRawIdx >= enRawIdx;
      const rawIdx = useZh ? zhRawIdx : enRawIdx;
      sections.push(text.slice(rawIdx + (useZh ? "原始转写：".length : "Raw transcript:".length)));
    }
  }
  return sections;
}

export function extractTranscriptSegments(markdown) {
  const source = String(markdown || "");
  const transcriptBlocks = readTranscriptBlocks(source);
  let legacyMarkdown = source;
  for (const block of [...transcriptBlocks].sort((left, right) => right.start - left.start)) {
    legacyMarkdown = legacyMarkdown.slice(0, block.start) + legacyMarkdown.slice(block.end);
  }
  const sortedBlocks = [...transcriptBlocks].sort((left, right) => left.start - right.start);
  const toSourceOffset = (offset) => {
    let removedLength = 0;
    for (const block of sortedBlocks) {
      const maskedStart = block.start - removedLength;
      if (offset < maskedStart) break;
      removedLength += block.end - block.start;
    }
    return offset + removedLength;
  };
  const entries = transcriptBlocks.map((block) => ({ segment: block.segment, position: block.start }));
  const sections = splitTranscriptSections(legacyMarkdown);
  let sectionSearchFrom = 0;
  for (const section of sections) {
    const foundAt = legacyMarkdown.indexOf(section, sectionSearchFrom);
    const sectionStart = foundAt >= 0 ? foundAt : sectionSearchFrom;
    sectionSearchFrom = sectionStart + section.length;
    let hadHeading = false;
    for (const range of iterateNoteHeadingBlocks(section, LEGACY_TRANSCRIPT_HEADING_RE)) {
      hadHeading = true;
      const heading = range.match;
      const rawBlock = section.slice(range.bodyStart, range.bodyEnd);
      const body = cleanTranscriptBlock(rawBlock);
      if (!body) continue;
      const tail = String(heading[2] || heading[4] || "");
      const textSource = heading[3] !== undefined || /(?:Text source|文本来源)/.test(heading[0]);
      const timeMatch = tail.match(/\(([^)]+?)[–-]([^)]+?)\)/);
      const startOffsetMs = timeMatch ? parseElapsedMsToken(timeMatch[1]) : 0;
      const endOffsetMs = timeMatch ? parseElapsedMsToken(timeMatch[2]) : startOffsetMs;
      const audioMatch = rawBlock.match(/!\[\[([^\]]+)\]\]/);
      const wikiMatch = tail.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
      const linkTarget = audioMatch ? audioMatch[1] : wikiMatch?.[1] || "";
      const target = linkTarget ? getAudioLinkTarget(linkTarget) : "";
      const name = textSource ? (wikiMatch?.[2] || target.split("/").pop() || target) : (target.split("/").pop() || target);
      const taskMatch = rawBlock.match(new RegExp(`<!--\\s*${nsRe("transcribe-task")}:([^>\\s]+)\\s*-->`));
      entries.push({
        segment: {
          index: entries.length,
          startOffsetMs,
          endOffsetMs,
          audioName: textSource ? "" : name,
          audioPath: textSource ? "" : target,
          sourceName: textSource ? name : "",
          sourcePath: textSource ? target : "",
          rawText: textSource ? body : undefined,
          source: textSource ? "text-import" : "",
          queueTaskId: taskMatch?.[1],
          text: body,
        },
        position: toSourceOffset(sectionStart + range.start),
      });
    }
    if (!hadHeading) {
      const text = cleanTranscriptBlock(section);
      if (text) entries.push({ segment: { index: entries.length, startOffsetMs: 0, endOffsetMs: 0, text }, position: toSourceOffset(sectionStart) });
    }
  }
  entries.sort((left, right) => left.position - right.position);
  return entries.map((entry, index) => ({ ...entry.segment, index }));
}

export function inferNoteStartedAtIso(file, frontmatter) {
  const moment = window.moment;
  const fm = frontmatter || {};
  const candidates = [
    readNamespaceFrontmatter(fm, "time"),
    fm["日期"] && fm["时间"] ? `${fm["日期"]}T${fm["时间"]}` : "",
    fm["日期"] || fm.date || "",
  ].map(v => String(v || "").trim()).filter(Boolean);
  if (moment) {
    for (const value of candidates) {
      const parsed = moment(value, [
        moment.ISO_8601,

        "YYYY-MM-DDTHH:mm:ss",
        "YYYY-MM-DD HH:mm:ss",
        "YYYY-MM-DDTHH:mm",
        "YYYY-MM-DD HH:mm",
        "YYYY-MM-DD",
      ], true);
      if (parsed && parsed.isValid && parsed.isValid()) return parsed.toDate().toISOString();
    }
    const m = String(file && file.basename || "").match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{4}))?/);
    if (m) {
      const parsed = moment(m[2] ? `${m[1]} ${m[2]}` : m[1], m[2] ? "YYYY-MM-DD HHmm" : "YYYY-MM-DD", true);
      if (parsed && parsed.isValid && parsed.isValid()) return parsed.toDate().toISOString();
    }
  }
  return new Date(file && file.stat && file.stat.ctime ? file.stat.ctime : Date.now()).toISOString();
}
/** Persist source records before an active reorganization pays for a model response. */
export function ensureTranscriptBlocks(
  markdown: string,
  sourceId: string,
  options: { reconcileEditedText?: boolean } = {},
): string {
  let next = String(markdown || "");
  const originalBlocks = readTranscriptBlocks(next);
  for (const block of [...originalBlocks].filter((item) => options.reconcileEditedText !== false && item.drifted).sort((left, right) => right.start - left.start)) {
    const record = block.segment.transcript;
    const current = record.revisions.find((revision) => revision.revision === record.currentRevision);
    const editedText = block.visibleBlock
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/!\[\[[^\]]+\]\]/g, "");
    const edited = attachTextTranscript({ ...block.segment, text: editedText, rawText: undefined }, record.sourceId || sourceId, "edited-transcript");
    const contextText = String(block.segment.text || "");
    const previousUnitText = current.utterances.map((unit) => unit.normalizedText).join("");
    const updatedText = previousUnitText && contextText.includes(previousUnitText)
      ? contextText.replace(previousUnitText, editedText)
      : editedText;
    next = replaceTranscriptBlock(next, block, { ...edited, text: updatedText }, block.visibleBlock);
  }

  const currentBlocks = readTranscriptBlocks(next);
  let legacyMarkdown = next;
  for (const block of [...currentBlocks].sort((left, right) => right.start - left.start)) {
    legacyMarkdown = legacyMarkdown.slice(0, block.start) + legacyMarkdown.slice(block.end);
  }
  const orderedBlocks = [...currentBlocks].sort((left, right) => left.start - right.start);
  const toSourceOffset = (offset: number): number => {
    let removedLength = 0;
    for (const block of orderedBlocks) {
      if (offset < block.start - removedLength) break;
      removedLength += block.end - block.start;
    }
    return offset + removedLength;
  };
  const sections = splitTranscriptSections(legacyMarkdown);
  const legacyEntries: Array<{
    segment: Segment;
    position: number;
    start: number;
    end: number;
    heading: string;
    visibleText: string;
  }> = [];
  const seenRanges = new Set<string>();
  let sectionSearchFrom = 0;
  for (const section of sections) {
    const foundAt = legacyMarkdown.indexOf(section, sectionSearchFrom);
    const sectionStart = foundAt >= 0 ? foundAt : sectionSearchFrom;
    sectionSearchFrom = sectionStart + section.length;
    let hadHeading = false;
    for (const range of iterateNoteHeadingBlocks(section, LEGACY_TRANSCRIPT_HEADING_RE)) {
      hadHeading = true;
      const headingMatch = range.match;
      const rawBlock = section.slice(range.bodyStart, range.bodyEnd);
      const body = cleanTranscriptBlock(rawBlock);
      if (!body) continue;
      const start = toSourceOffset(sectionStart + range.start);
      const end = toSourceOffset(sectionStart + range.bodyEnd);
      const key = `${start}:${end}`;
      if (seenRanges.has(key)) continue;
      seenRanges.add(key);
      const tail = String(headingMatch[2] || headingMatch[4] || "");
      const textSource = headingMatch[3] !== undefined || /(?:Text source|文本来源)/.test(headingMatch[0]);
      const timeMatch = tail.match(/\(([^)]+?)[–-]([^)]+?)\)/);
      const startOffsetMs = timeMatch ? parseElapsedMsToken(timeMatch[1]) : 0;
      const endOffsetMs = timeMatch ? parseElapsedMsToken(timeMatch[2]) : startOffsetMs;
      const audioMatch = rawBlock.match(/!\[\[([^\]]+)\]\]/);
      const wikiMatch = tail.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
      const linkTarget = audioMatch ? audioMatch[1] : wikiMatch?.[1] || "";
      const target = linkTarget ? getAudioLinkTarget(linkTarget) : "";
      const name = textSource ? (wikiMatch?.[2] || target.split("/").pop() || target) : (target.split("/").pop() || target);
      const taskMatch = rawBlock.match(new RegExp(`<!--\\s*${nsRe("transcribe-task")}:([^>\\s]+)\\s*-->`));
      legacyEntries.push({
        segment: {
          index: -1,
          startOffsetMs,
          endOffsetMs,
          audioStartOffsetMs: !textSource && target ? startOffsetMs : undefined,
          audioEndOffsetMs: !textSource && target ? endOffsetMs : undefined,
          audioName: textSource ? "" : name,
          audioPath: textSource ? "" : target,
          source: textSource ? "text-import" : "",
          sourceName: textSource ? name : "",
          sourcePath: textSource ? target : "",
          rawText: textSource ? body : undefined,
          queueTaskId: taskMatch?.[1],
          text: body,
        },
        position: start,
        start,
        end,
        heading: headingMatch[0],
        visibleText: rawBlock,
      });
    }
    if (!hadHeading) {
      const body = cleanTranscriptBlock(section);
      if (!body) continue;
      const start = toSourceOffset(sectionStart);
      const end = toSourceOffset(sectionStart + section.length);
      const key = `${start}:${end}`;
      if (seenRanges.has(key)) continue;
      seenRanges.add(key);
      legacyEntries.push({ segment: { index: -1, startOffsetMs: 0, endOffsetMs: 0, text: body }, position: start, start, end, heading: "", visibleText: section });
    }
  }
  if (!legacyEntries.length) return next;

  const orderedEntries: Array<{ position: number; id: string; legacy: (typeof legacyEntries)[number] | null }> = [
    ...currentBlocks.map((block) => ({ position: block.start, id: block.segment.transcript.id, legacy: null })),
    ...legacyEntries.map((entry) => ({ position: entry.position, id: "", legacy: entry })),
  ].sort((left, right) => left.position - right.position);
  const usedIds = new Set(orderedEntries.map((entry) => entry.id).filter(Boolean));
  const replacements: Array<{ start: number; end: number; block: string }> = [];
  for (let index = 0; index < orderedEntries.length; index += 1) {
    const entry = orderedEntries[index];
    if (!entry.legacy) continue;
    let segmentIndex = index;
    while (usedIds.has(`seg:${encodeURIComponent(sourceId)}:${segmentIndex}`)) segmentIndex += 1;
    const origin = entry.legacy.segment.source === "text-import" ? "text-import" : "legacy-transcript";
    const segment = attachTextTranscript({ ...entry.legacy.segment, index: segmentIndex }, sourceId, origin);
    usedIds.add(segment.transcript.id);
    const block = serializeTranscriptBlock(segment, entry.legacy.heading, entry.legacy.visibleText);
    let cursor = entry.legacy.start;
    let firstGap = true;
    for (const protectedBlock of orderedBlocks) {
      if (protectedBlock.end <= cursor) continue;
      if (protectedBlock.start >= entry.legacy.end) break;
      const gapEnd = Math.min(protectedBlock.start, entry.legacy.end);
      if (gapEnd > cursor) {
        replacements.push({
          start: cursor,
          end: gapEnd,
          block: firstGap ? block : "",
        });
        firstGap = false;
      }
      cursor = Math.max(cursor, protectedBlock.end);
      if (cursor >= entry.legacy.end) break;
    }
    if (cursor < entry.legacy.end) {
      replacements.push({
        start: cursor,
        end: entry.legacy.end,
        block: firstGap ? block : "",
      });
    }
  }
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    next = next.slice(0, replacement.start) + replacement.block + next.slice(replacement.end);
  }
  return next;
}

export function normalizeSegmentsForMergedNote(segments, offsetMs, startIndex, sourceFile) {
  const offset = Math.max(0, Number(offsetMs) || 0);
  const baseIndex = Math.max(0, Number(startIndex) || 0);
  const sourceName = sourceFile && sourceFile.basename ? sourceFile.basename : "";
  const sourcePath = sourceFile && sourceFile.path ? sourceFile.path : "";
  return (segments || []).map((seg, i) => {
    const rawStart = Math.max(0, Number(seg && seg.startOffsetMs) || 0);
    const rawEnd = Math.max(rawStart, Number(seg && seg.endOffsetMs) || 0);
    const start = rawStart + offset;
    const end = Math.max(start, rawEnd + offset);
    const localStart = Number(seg && seg.audioStartOffsetMs);
    const localEnd = Number(seg && seg.audioEndOffsetMs);
    return Object.assign({}, seg || {}, {
      index: baseIndex + i,
      startOffsetMs: start,
      endOffsetMs: end,
      audioStartOffsetMs: Number.isFinite(localStart) && localStart >= 0 ? localStart : rawStart,
      audioEndOffsetMs: Number.isFinite(localEnd) && localEnd >= 0 ? localEnd : rawEnd,
      sourceName: (seg && seg.sourceName) || sourceName,
      sourcePath: (seg && seg.sourcePath) || sourcePath,
    });
  });
}

export function stripEmptyPlaceholders(text) {
  return String(text || "")
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/_?\[(?:此段无内容|无输出|转写失败|等待后台转写|此段尚未完成转写|合并润色失败|No content in this segment|No output|Transcription failed|Waiting for background transcription|This segment is not fully transcribed yet|Merge failed)[^\]\n]*\]_?/g, "")
    // 下两行是历史中文 LLM 的空结果自述（无对应英文写入方、也不在标签目录内），维持中文匹配。
    .replace(/^(?:没有|暂无)(?:可整理内容|有效内容|实际内容|可用内容)[。.!！]*$/gm, "")
    .replace(/^转写(?:为空|返回为空|无内容)[。.!！]*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hasMeaningfulTranscript(text) {
  return stripEmptyPlaceholders(text).trim().length > 0;
}

export function isStandaloneGeneratedNote(markdown) {
  const body = String(markdown || "").replace(/^---\n[\s\S]*?\n---\n?/m, "");
  const firstLine = (body.split(/\r?\n/).find((line) => line.trim()) || "").trim();
  return /^#\s+.+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+·\s+/.test(firstLine);
}

export function getMeaningfulRemainder(markdown) {
  let text = String(markdown || "");
  text = text
    .replace(/^---\n[\s\S]*?\n---\n?/m, "")
    .replace(/<!--[^>]*-->/g, "")
    .replace(/<summary>[\s\S]*?<\/summary>/gi, "")
    .replace(/<\/?details>/gi, "")
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^>\s*\[!info\].*$/gm, "")
    .replace(/^>\s*(?:开始|时间|合并自|Time)[：:].*$/gm, "")
    .replace(/^>\s*.*(?:时长|模式|分段|模型|Duration|Mode|Segments|Model).*$/gm, "")
    .replace(/^\s*---\s*$/gm, "");
  text = stripEmptyPlaceholders(text);
  return text.replace(/^\s*$/gm, "").trim();
}

export function analyzeEmptyShortNote(file, markdown, settings) {
  const text = String(markdown || "");
  const hasMarkerNames = NS_SESSION_RE.test(text) || NS_SEGMENTS_START_RE.test(text);
  if (!hasMarkerNames) return null;
  if (!isStandaloneGeneratedNote(text)) return null;

  const durationMs = getDurationMs(text);
  if (!(durationMs > 0 && durationMs <= QNALOG_EMPTY_SHORT_LIMIT_MS)) return null;

  const segments = extractTranscriptSegments(text);
  if (segments.some((seg) => hasMeaningfulTranscript(seg.text))) return null;
  if (hasMeaningfulTranscript(getMeaningfulRemainder(text))) return null;

  const audioRefs = collectAudioRefs(text);
  return { file, durationMs, audioRefs, audioFiles: [] };
}

// 解析 frontmatter 角色字段中的"代号 → 真名"映射
// 用户在 yaml 里把 `参会人:` 数组的某项改成 `业务需求方 → 某候选人`，
// 重新整理时这条会被解析成 { from: "业务需求方", to: "某候选人" }
export const ROLE_MAPPING_FIELDS = [
  NS_FM.participants, NS_FM.advisors, NS_FM.interviewee, NS_FM.interviewer,
  NS_FM.decisionMaker, "参会人", "与会人", "参与者", "出席人", "参谋",
  "受访者", "访问者", "面试官", "候选人", "当事人",
];

export function parseRoleMapItem(item) {
  const text = String(item == null ? "" : item).trim();
  if (!text) return null;
  // 支持 "代号 → 真名" / "代号 -> 真名" / "代号 => 真名" 三种箭头
  const m = text.match(/^(.+?)\s*(?:→|=>|->)\s*(.+)$/);
  if (!m) return null;
  const from = m[1].trim();
  const to = m[2].trim();
  if (!from || !to || from === to) return null;
  return { from, to };
}

export function extractRoleMappingFromFrontmatter(frontmatter) {
  if (!frontmatter || typeof frontmatter !== "object") return [];
  const mapping = [];
  const seen = new Set();
  for (const field of ROLE_MAPPING_FIELDS) {
    const v = frontmatter[field];
    if (Array.isArray(v)) {
      for (const item of v) {
        const m = parseRoleMapItem(item);
        if (m && !seen.has(m.from)) {
          mapping.push(m);
          seen.add(m.from);
        }
      }
    } else if (typeof v === "string") {
      const m = parseRoleMapItem(v);
      if (m && !seen.has(m.from)) {
        mapping.push(m);
        seen.add(m.from);
      }
    }
  }
  // 多声道说话人改名：把「说话人N」→ 已确认的真实姓名一并纳入，
  // 否则「重新整理（使用说话人姓名）」拿不到改名结果，正文里仍是说话人N。
  const speakers = readSpeakerMappings(frontmatter);
  if (speakers && typeof speakers === "object") {
    for (const [speakerId, item] of Object.entries(speakers)) {
      const channel = Number(String(speakerId).replace(/^spk-/, "")) || 0;
      if (!channel) continue;
      const personName = item && typeof item === "object"
        ? String((item as { personName?: string; name?: string }).personName || (item as { personName?: string; name?: string }).name || "").trim()
        : primitiveText(item).trim();
      if (!personName) continue;
      // 历史笔记可能写成「说话人 N」（带空格），两种写法都要能替换。
      for (const from of [speakerLabelForChannel(channel), `说话人 ${channel}`]) {
        if (from && from !== personName && !seen.has(from)) {
          mapping.push({ from, to: personName });
          seen.add(from);
        }
      }
    }
  }
  return mapping;
}

// 把映射应用到 segments 的 text（按 from 长度降序，避免短代号在长代号内部被错替换）
export function applyRoleMappingToSegments(segments, mapping) {
  if (!mapping || !mapping.length) return segments;
  const sorted = [...mapping].sort((a, b) => b.from.length - a.from.length);
  return segments.map(s => {
    let text = s.text || "";
    for (const m of sorted) {
      if (!m.from) continue;
      // 全局替换；用字符串而非正则，避免代号含正则元字符出错
      text = text.split(m.from).join(m.to);
    }
    return Object.assign({}, s, { text });
  });
}


export function cleanInlineMarkdown(text) {
  return String(text || "")
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateText(text, max = 220) {
  const cleaned = cleanInlineMarkdown(text);
  return cleaned.length > max ? cleaned.slice(0, max - 1).trimEnd() + "…" : cleaned;
}

export function extractBriefingSummary(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/\[!abstract\]|整体概要|概要|摘要/.test(lines[i])) {
      const collected = [];
      for (let j = i + 1; j < lines.length; j++) {
        const raw = lines[j];
        const t = raw.trim();
        if (!t) {
          if (collected.length) break;
          continue;
        }
        if (/^#{1,6}\s+/.test(t) || /^---+$/.test(t)) break;
        if (/^>\s*\[!/.test(t)) break;
        collected.push(t.replace(/^>\s?/, ""));
        if (collected.join("").length > 260) break;
      }
      const summary = truncateText(collected.join(" "), 240);
      if (summary) return summary;
    }
  }

  for (const line of lines) {
    const t = line.trim();
    if (!t || /^#{1,6}\s+/.test(t) || /^>/.test(t) || /^[-*]\s+/.test(t) || /^\|/.test(t) || /^---+$/.test(t)) continue;
    const summary = truncateText(t, 240);
    if (summary) return summary;
  }
  return "";
}

export function normalizeTaskText(line) {
  let t = String(line || "")
    .replace(/^>\s?/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
  t = cleanInlineMarkdown(t).replace(/[。；;，,]+$/, "").trim();
  if (!t || /^<.*>$/.test(t)) return "";
  if (/^(无|暂无|没有|未提及|不适用|跳过|待定)$/.test(t)) return "";
  return t;
}

export function cleanTodoFieldValue(value) {
  return String(value || "")
    .trim()
    .replace(/[，,。；;、\s]+$/g, "")
    .trim();
}

export function isEmptyTodoFieldValue(value) {
  const t = cleanTodoFieldValue(value);
  return !t || /^(无|暂无|没有|未提及|未明确|未指定|未知|不适用|跳过|待定|tbd|n\/a|na|null|none|-)$/i.test(t);
}

export function cleanTodoOwnerValue(value) {
  const parts = String(value || "")
    .split(/[/／、,，;；]|(?:\s+和\s+)/)
    .map(cleanTodoFieldValue)
    .filter(Boolean)
    .filter(part => !/^(主讲人|发言人\d*|说话人\d*|相关方|业务需求方|负责人|某负责人|某同学|参会人|参与者|人员|未提及|未明确|未指定|未知|待定)$/i.test(part));
  return parts.join("、");
}

export function scrubBriefingTodoPlaceholders(markdown) {
  return String(markdown || "").split(/\r?\n/).map(line => {
    const match = line.match(/^(\s*>?\s*[-*+]\s+\[[ xX]\]\s+)(.*)$/);
    if (!match) return line;
    let body = match[2] || "";
    body = body.replace(/责任人：\s*([^：\n]*?)(?=\s*(?:事项：|截止：|优先级：|$))/g, (_, value) => {
      const owner = cleanTodoOwnerValue(value);
      return owner ? `责任人：${owner} ` : "";
    });
    body = body.replace(/截止：\s*([^：\n]*?)(?=\s*(?:责任人：|事项：|优先级：|$))/g, (_, value) => {
      const due = cleanTodoFieldValue(value);
      return isEmptyTodoFieldValue(due) ? "" : `截止：${due} `;
    });
    body = body.replace(/优先级：\s*([^：\n]*?)(?=\s*(?:责任人：|事项：|截止：|$))/g, (_, value) => {
      const priority = cleanTodoFieldValue(value);
      return isEmptyTodoFieldValue(priority) ? "" : `优先级：${priority} `;
    });
    body = body.replace(/\s{2,}/g, " ").trim();
    return match[1] + body;
  }).join("\n");
}

export function extractActionItems(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const items = [];
  const seen = new Set();
  let inActionSection = false;
  const actionRe = /(待办|行动项|下一步|跟进|后续|TODO|To[- ]?do|Action\s*Items?)/i;

  function add(line) {
    const text = normalizeTaskText(line);
    if (!text || seen.has(text)) return;
    seen.add(text);
    items.push(`- [ ] ${text}`);
  }

  for (const raw of lines) {
    const line = raw.trim();
    const visible = line.replace(/^>\s?/, "");
    if (/^[-*+]\s+\[[ xX]\]\s+/.test(visible)) {
      add(visible);
      continue;
    }
    if (/^#{1,6}\s+/.test(visible) || /^>\s*\[!/.test(line)) {
      inActionSection = actionRe.test(visible);
      continue;
    }
    if (inActionSection && /^[-*+]\s+/.test(visible)) add(visible);
  }
  return items.slice(0, 12);
}

export function makeNoteLink(path) {
  const target = String(path || "").replace(/\.md$/i, "");
  const label = target.split("/").pop() || target;
  return `[[${target}|${label}]]`;
}

// 由代码注入的会话元信息前缀 —— LLM 不需要推断 qnalog_time/qnalog_duration。
// qnalog_mode、qnalog_time 和 qnalog_duration 由插件按会话状态写入。
export const FRONTMATTER_CONTENT_KEYS: Record<string, readonly NamespaceFrontmatterField[]> = {
  synthesis: ["topic", "coreQuestion", "participants"],
  learning: ["topic", "source", "language"],
  interview: ["topic", "interviewee", "interviewer"],
  meeting: ["topic", "participants"],
  seminar: ["topic", "seminarSubject", "participants"],
  huddle: ["topic", "decisionMaker", "advisors"],
  monologue: ["topic"],
};

// 把任意 mode（含 custom-xxx）映射到用于查 frontmatter schema 表的 baseKey。
// custom 模式天然带 baseMode（sanitize 强制落到内置模式）。
export function frontmatterBaseModeKey(plugin, mode) {
  if (FRONTMATTER_CONTENT_KEYS[mode]) return mode;
  const custom = plugin && getCustomPromptModeTemplate(plugin.settings, mode);
  if (custom && custom.baseMode && FRONTMATTER_CONTENT_KEYS[custom.baseMode]) return custom.baseMode;
  return "meeting"; // custom mode 使用 meeting 内容字段白名单，保留 qnalog_topic 与 qnalog_participants。
}

export function formatYamlDateTime(value) {
  if (!value) return "";
  const moment = window.moment;
  if (moment) {
    const m = moment(value);
    if (m && m.isValid && m.isValid()) return m.format("YYYY-MM-DDTHH:mm:ss");
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** frontmatter 的可写字段：字符串或字符串数组，键为 YAML 字段名。 */
export type FrontmatterFields = Record<string, string | string[] | undefined>;

export function normalizeBriefingFrontmatterFields(raw, mode, baseKey) {
  const source = (raw && typeof raw === "object") ? Object.assign({}, raw) : {};
  const keys = FRONTMATTER_CONTENT_KEYS[baseKey || mode] || ["topic"];
  const cleaned = {};
  for (const field of keys) {
    if (hasNamespaceFrontmatter(source, field)) cleaned[NS_FM[field]] = readNamespaceFrontmatter(source, field);
  }
  if (hasNamespaceFrontmatter(source, "people")) {
    cleaned[NS_FM.people] = readNamespaceFrontmatter(source, "people");
  }
  if (Object.prototype.hasOwnProperty.call(source, NS_FM_SPEAKERS)) {
    cleaned[NS_FM_SPEAKERS] = source[NS_FM_SPEAKERS];
  }
  return cleaned;
}

export function mergeLeadingFrontmatterIntoDocument(documentText, generatedMarkdown) {
  const generated = splitLeadingFrontmatter(generatedMarkdown || "");
  if (!generated.frontmatter) return { content: String(documentText || ""), body: String(generatedMarkdown || "") };
  const current = splitLeadingFrontmatter(documentText || "");
  return {
    content: generated.frontmatter.trimEnd() + "\n" + current.body.replace(/^\n+/, ""),
    body: generated.body.trim() || buildEmptyLlmOutputFallback(),
  };
}

// 解析 LLM 输出末尾的标签建议注释 <!-- qnalog-tags: 主题/实时转写, 项目/示例 -->
export function parseSuggestedTagsFromOutput(text) {
  if (!text) return { tags: [], cleaned: text || "" };
  const re = NS_TAGS_RE;
  const m = text.match(re);
  if (!m) return { tags: [], cleaned: text };
  const peopleFromTags = [];
  const tags = m[1]
    .split(/[,，;；、\n]+/)
    .map(s => s.trim())
    // 防御 LLM 可能带 # 前缀
    .map(s => s.replace(/^#+/, "").trim())
    // 防御内部出现空格或非法 tag 字符（Obsidian tag 不允许空格）
    .map(s => s.replace(/\s+/g, ""))
    .filter(Boolean)
    // 防御过长：nested tag 也很少超过 24 字
    .filter(s => s.length > 0 && s.length <= 24)
    // 防御和系统 tag 重复
    .filter(s => !new RegExp(`^${NS_TAG}/`, "i").test(s))
    // 人物/x 不再进 tags：剥前缀转入 people（吃掉旧 LLM 输出 / 旧笔记里残留的人物维度，是旧笔记平滑迁移的关键）
    .filter(s => {
      if (/^人物\//.test(s)) { peopleFromTags.push(s.replace(/^人物\//, "").trim()); return false; }
      return true;
    });
  // 去重
  const seen = new Set();
  const unique = [];
  for (const t of tags) {
    if (!seen.has(t)) { unique.push(t); seen.add(t); }
  }
  const cleaned = text.replace(re, "").replace(/\n{3,}$/, "\n\n").trimEnd() + "\n";
  return { tags: unique, people: peopleFromTags.filter(Boolean), cleaned };
}

// 解析 LLM 输出末尾的人员机器块 <!-- qnalog-people: 张三, 李四 -->（纯人名，不带前缀）。
// 与 tags 物理分离：人物单列成独立 frontmatter 属性，不再挤进 tags。

// 把 LLM 输出（含 frontmatter + 正文 + 末尾 tags 注释）规整成最终笔记内容：
//   - 强制覆盖 qnalog_mode / qnalog_time / qnalog_duration / qnalog_status
//   - 合并标签：[qnalog/<mode>] + LLM 标签建议 + (可选) 已有 tags
//   - 删除末尾的 qnalog-tags 注释
//   - originalFrontmatter 非空时（重新整理场景），按当前模式保留 canonical 内容字段与说话人映射；旧别名只读不写
export function postProcessBriefingOutput(rawOutput, mode, sessionMeta, originalFrontmatter, baseKey, topNotice = "") {
  if (!rawOutput) return rawOutput || "";
  // 先剥人员机器块、再剥标签机器块（cleaned 串联，保证注释不残留在正文末尾）。
  const { people: suggestedPeople, cleaned: afterPeople } = parsePeopleFromOutput(rawOutput);
  const { tags: suggested, people: peopleFromTags, cleaned: stripped } = parseSuggestedTagsFromOutput(afterPeople);

  // 解析 LLM 输出的 frontmatter（如有）
  const fmMatch = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let llmFm = null;
  let body = stripped;
  if (fmMatch) {
    try { llmFm = obsidian.parseYaml(fmMatch[1]); } catch { llmFm = null; }
    body = stripped.slice(fmMatch[0].length).replace(/^\n+/, "");
  }
  body = scrubBriefingTodoPlaceholders(normalizeCallouts(body));
  // 一级标题由插件按会话时间统一写入；模型自作主张输出的 # 标题（含连续多条）会在母本里叠成重复标题，剥掉。
  body = body.replace(/^(?:\s*#\s+[^\n]*(?:\n|$))+/, "");

  // base frontmatter 选择：重整时优先用 originalFrontmatter（保留用户改动），首次用 LLM 输出。
  // 随后只保留当前模式 schema 内的内容字段，避免 LLM 擅自加入 date/location/decision 等重复字段。
  const rawBase = (originalFrontmatter && typeof originalFrontmatter === "object")
    ? Object.assign({}, originalFrontmatter)
    : (llmFm && typeof llmFm === "object" ? Object.assign({}, llmFm) : {});
  const base: FrontmatterFields = normalizeBriefingFrontmatterFields(rawBase, mode, baseKey);

  base[NS_FM.mode] = mode;
  if (sessionMeta && sessionMeta.startedAt) {
    const time = formatYamlDateTime(sessionMeta.startedAt);
    if (time) base[NS_FM.time] = time;
  } else {
    const priorTime = readNamespaceFrontmatter(originalFrontmatter || llmFm || {}, "time");
    const time = formatYamlDateTime(priorTime);
    if (time) base[NS_FM.time] = time;
  }
  // 从旧日期字段、文件名或文件时间推断，最终回退当天，确保 qnalog_time 非空。
  if (!base[NS_FM.time]) {
    const inferred = formatYamlDateTime(inferNoteStartedAtIso(null, originalFrontmatter || llmFm || {}));
    if (inferred) base[NS_FM.time] = inferred;
  }
  if (sessionMeta && sessionMeta.duration) base[NS_FM.duration] = sessionMeta.duration;
  base[NS_FM.status] = "organized";

  // merge tags：[qnalog/<mode>] + 已有 + 建议；其中 人物/x 前缀一律剥出转入人物属性，不进 tags。
  const sysTag = NS_TAG_PREFIX + mode;
  const rawTags = (originalFrontmatter && originalFrontmatter.tags) || (rawBase && rawBase.tags);
  const existingTagsAll = Array.isArray(rawTags)
    ? rawTags.map(t => String(t).trim()).filter(Boolean)
    : (typeof rawTags === "string" && rawTags.trim() ? [rawTags.trim()] : []);
  const existingPeopleFromTags = [];
  const existingTags = existingTagsAll.filter(t => {
    if (/^人物\//.test(t)) { existingPeopleFromTags.push(t.replace(/^人物\//, "").trim()); return false; }
    return true;
  });
  const tags = [];
  const seen = new Set();
  const push = (t) => { if (t && !seen.has(t)) { tags.push(t); seen.add(t); } };
  push(sysTag);
  for (const t of existingTags) push(t);
  for (const t of suggested) push(t);
  base.tags = tags;

  // qnalog_people：合并机器块、标签里的 人物/ 值与已有属性，归一去重。
  // 重新整理时旧 tags 会在此按需迁入 canonical 属性。
  let people = splitPersonFieldValue(base[NS_FM.people] || []);
  people = mergeUniqueStrings(people, suggestedPeople);
  people = mergeUniqueStrings(people, peopleFromTags);
  people = mergeUniqueStrings(people, existingPeopleFromTags);
  if (people.length) base[NS_FM.people] = people; else delete base[NS_FM.people];

  // 字段输出顺序：系统字段、内容字段、tags。时间值使用 YAML 可识别的日期时间标量。
  const ordered: FrontmatterFields = {};
  ordered[NS_FM.mode] = base[NS_FM.mode];
  if (base[NS_FM.time]) ordered[NS_FM.time] = base[NS_FM.time];
  if (base[NS_FM.duration]) ordered[NS_FM.duration] = base[NS_FM.duration];
  if (base[NS_FM.people] && base[NS_FM.people].length) ordered[NS_FM.people] = base[NS_FM.people];
  const seenKeys = new Set([
    NS_FM.mode, NS_FM.time, NS_FM.duration, NS_FM.people, NS_FM.status,
    "mode", "模式", "模板", "time", "date", "日期", "时间", "时长", "duration",
    "人物", "people", "状态", "status", "tags",
  ]);
  for (const k of Object.keys(base)) {
    if (seenKeys.has(k)) continue;
    ordered[k] = base[k];
  }
  ordered[NS_FM.status] = base[NS_FM.status];
  ordered.tags = base.tags;

  let yamlBlock;
  try { yamlBlock = obsidian.stringifyYaml(ordered); } catch {
    // 兜底：手动拼
    yamlBlock = Object.entries(ordered).map(([k, v]) => {
      if (Array.isArray(v)) return k + ":\n" + v.map(x => "  - " + String(x)).join("\n");
      if (v === null || v === undefined) return k + ": ";
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
        return k + ": " + String(v);
      }
      return k + ": " + JSON.stringify(v);
    }).join("\n") + "\n";
  }
  // topNotice（如截断告警）插在 frontmatter 之后、正文之前——保证 frontmatter 不被破坏、告警最显眼。
  const noticeBlock = topNotice ? String(topNotice).trim() + "\n\n" : "";
  return "---\n" + yamlBlock + "---\n" + noticeBlock + body.trimStart();
}

export async function maybePreSummarizeTextImportForMerge(plugin, segments, mode, sessionMeta) {
  if (!sessionMeta || sessionMeta.source !== "text-import") return segments;
  const joined = (segments || []).map((s, i) => formatMergeSegmentForPrompt(s, i)).join("\n\n");
  if (joined.length <= TEXT_IMPORT_PRE_SUMMARY_THRESHOLD_CHARS) return segments;

  const chunkSize = Math.max(
    TEXT_IMPORT_PRE_SUMMARY_CHUNK_CHARS,
    Math.ceil(joined.length / TEXT_IMPORT_PRE_SUMMARY_MAX_CHUNKS),
  );
  const chunks = splitLongTextForLlm(joined, chunkSize);
  if (chunks.length <= 1) return segments;

  await logLlmRequestDiagnostic(plugin, "warn", "llm.merge_long_text_presummary_start", t("Long-text import started chunked pre-summarization"), {
    mode,
    source: sessionMeta.source,
    segmentCount: Array.isArray(segments) ? segments.length : 0,
    inputChars: joined.length,
    chunkCount: chunks.length,
    chunkSize,
  });

  const sys = "你是 QnALog 的长文本预处理助手。你的任务是把长文本片段压缩为可用于最终整理的结构化证据摘要。";
  const summaries = [];
  for (let i = 0; i < chunks.length; i++) {
    const user = [
      "## 任务",
      "",
      `这是导入文本的第 ${i + 1}/${chunks.length} 个片段。请生成结构化预摘要，供后续最终整理使用。`,
      "",
      "要求：",
      "- 只依据本片段，不补充片段外事实。",
      "- 保留人物、待办、决策、问题、概念、争议点和明确证据。",
      "- 输出 Markdown bullet，尽量短，但不要丢失关键事实。",
      "",
      "## 片段原文",
      "",
      chunks[i],
    ].filter(Boolean).join("\n");
    try {
      const summary = await callLlm(plugin, sys, user, { timeoutMs: 90000 });
      summaries.push(summary || "_[本片段预摘要为空]_");
    } catch (e) {
      await logLlmRequestDiagnostic(plugin, "error", "llm.merge_long_text_presummary_failed", t("Chunked pre-summarization for long-text import failed"), {
        mode,
        source: sessionMeta.source,
        chunkIndex: i + 1,
        chunkCount: chunks.length,
        chunkChars: chunks[i].length,
        error: diagnosticError(e),
      });
      throw e;
    }
  }

  await logLlmRequestDiagnostic(plugin, "info", "llm.merge_long_text_presummary_done", t("Chunked pre-summarization for long-text import completed"), {
    mode,
    source: sessionMeta.source,
    inputChars: joined.length,
    chunkCount: chunks.length,
    summaryChars: summaries.reduce((sum, text) => sum + String(text || "").length, 0),
  });

  return summaries.map((summary, i) => ({
    index: i,
    startOffsetMs: 0,
    endOffsetMs: 0,
    audioName: "",
    sourceName: `长文本预摘要 ${i + 1}`,
    sourcePath: "",
    rawText: "",
    text: t("[Long-text pre-summary {0}/{1}]\n{2}")
      .replace("{0}", String(i + 1))
      .replace("{1}", String(summaries.length))
      .replace("{2}", summary),
  }));
}

// 人物指认幻觉的机械兜底（软提示，不删改）：模型可能把转写里零星出现的称呼提升为贯穿全文的
// 核心人物（实测案例：把全场只提到三五次的"某称呼"指认为一号位）。这里按 qnalog-people 名单
// 比对"产出引用次数 vs 原始转写出现次数"，明显倒挂的在文末附核对 callout。
    // 字面计数会因转写错字低估真实人名（"李扣"被转写成"你扣"），所以只提示、绝不自动改写。
export function appendEntityEvidenceWarning(outputMd, transcript) {
  try {
    const md = String(outputMd || "");
    const parsed = parsePeopleFromOutput(md);
    const names = (parsed && parsed.people) || [];
    if (!names.length) return outputMd;
    const findings = findLowEvidenceEntities(names, md, String(transcript || ""));
    if (!findings.length) return outputMd;
    const lines = findings.map(f => `> - 「${f.name}」：正文引用 ${f.outputCount} 次，原始转写仅出现 ${f.transcriptCount} 次——其身份/角色可能是 AI 推断，请核对`);
    return `${md}\n\n> [!warning] 人物指认核对\n${lines.join("\n")}\n> 检测按字面计数，转写错字可能造成误报；确认无误后可删除本块。`;
  } catch (e) {
    console.error("[QnALog] entity evidence audit failed", e);
    return outputMd;
  }
}

export function parseBriefingPartResponse(raw, knowledgeContext = undefined) {
  const knowledgeResult = knowledgeContext
    ? parseSessionKnowledgeResponse(String(raw || ""), knowledgeContext)
    : { body: stripSessionKnowledgeBlocks(String(raw || "")), knowledge: null };
  const sedimentPreExtraction = extractSedimentPreExtractionBlock(knowledgeResult.body);
  const parsedPeople = parsePeopleFromOutput(sedimentPreExtraction.cleaned);
  const parsedTags = parseSuggestedTagsFromOutput(parsedPeople.cleaned);
  const envelope = extractBriefingPartEnvelope(parsedTags.cleaned);
  const body = stripModeSuggestionBlocks(envelope.body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")).trim();
  return {
    body,
    summary: envelope.summary,
    people: mergeUniqueStrings([], (parsedPeople.people || []).concat(parsedTags.people || [])),
    tags: mergeUniqueStrings([], parsedTags.tags || []),
    sedimentObjects: sedimentPreExtraction.objects || null,
    knowledge: knowledgeResult.knowledge,
  };
}

export async function generateTitleTag(plugin, polished, mode) {
  const prefix = getModePrefix(getModeMeta(plugin.settings, mode));
  const snippet = (polished || "").slice(0, 2500);
  if (!snippet.trim()) return "";
  // 标签会同时成为文件名与界面标题，因此跟随界面语言——
  // 英文用户拿到中文标签时，标题与文件名都是他读不懂的文字。
  const inEnglish = getActiveUiLanguage().id === "en";
  const sys = inEnglish
    ? "You name files and extract short topic tags from meeting notes."
    : "你是文件命名助手，擅长从中文内容中提取简洁的主题标签。";
  const user = inEnglish
    ? `Below is a ${prefix} record. Extract one topic tag of at most 15 characters.

[Requirements]
- Output only the tag itself, with no quotes, punctuation, prefix, explanation, or emoji.
- Prefer the "specific object - core topic" form, e.g. "contract review - supplier exclusivity" or "weekly sync - Q2 planning".
- Avoid broad words such as "discussion", "notes", "chat".
- Use English.

[Content]
  ${snippet}`
    : `下面是一段 ${prefix} 记录。请提取一个 ≤15 个字的主题标签。

【要求】
- 只输出标签本身，不加引号、标点、前缀、解释、emoji。
- 优先"具体对象-核心议题"格式，如"合同审查-供应商独家条款"、"周例会-Q2规划"。
- 避免宽泛词如"讨论"、"记录"、"聊天"。
- 使用中文。

【内容】
  ${snippet}`;
  try {
    const title = await callLlm(plugin, sys, user, { timeoutMs: 30 * 1000 });
    return sanitizeFilename(title);
  } catch (e) {
    console.error("[QnALog] generateTitleTag failed", e);
    return "";
  }
}

export function buildTitleSourceFromSegments(segments) {
  return (segments || [])
    .filter((s) => s && s.text && String(s.text).trim())
    .map((s, i) => {
      const n = Number.isFinite(s.index) ? s.index + 1 : i + 1;
      const start = formatElapsed(s.startOffsetMs || 0);
      const end = formatElapsed(s.endOffsetMs || 0);
      return `段落 ${n}（${start}-${end}）：${String(s.text || "").trim()}`;
    })
    .join("\n\n")
    .slice(0, 3000);
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
