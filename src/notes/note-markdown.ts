/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：笔记 Markdown 的解析与生成（版本块、frontmatter 后处理、逐字稿区块、标题与文件名、邮件草稿）——这几个关注点相互引用，合并为一个模块以避免循环导入

import { collectAudioRefs, getAudioLinkTarget, getDurationMs } from "./audio-refs";

import { QNALOG_ACTIVE_VERSION_END, QNALOG_ACTIVE_VERSION_START, QNALOG_EMPTY_SHORT_LIMIT_MS, TEXT_IMPORT_PRE_SUMMARY_MAX_CHUNKS, TEXT_IMPORT_PRE_SUMMARY_THRESHOLD_CHARS } from "../shared/limits";

import { normalizeCallouts } from "./callout-normalize";

import { buildEmptyLlmOutputFallback, formatMergeSegmentForPrompt } from "../prompts/briefing-prompts";

import * as obsidian from "obsidian";
import { findLowEvidenceEntities, hashRealtimeOutlineText } from "../outline-text";

import { stripFrontmatterSimple } from "../ui/helpers";

import { getCustomPromptModeTemplate, getCustomPromptModeTemplates, getModeMeta, getVisibleModeEntries, isKnownPolishMode } from "../shared/mode-meta";

import { TEXT_IMPORT_PRE_SUMMARY_CHUNK_CHARS, parseElapsedMsToken, splitLongTextForLlm } from "../shared/util-text";


import { mergeUniqueStrings, normalizePersonLookupText, normalizePersonNameForEmail, parsePeopleFromOutput, splitPersonFieldValue } from "../people";

import { extractSedimentPreExtractionBlock, stripSedimentPreExtractionBlocks } from "../sediment";

import { callLlm, logLlmRequestDiagnostic, stripModeSuggestionBlocks } from "../llm/core";

import { DEFAULT_SETTINGS } from "../shared/defaults";
import { NS_TAG, NS_ROOT, NS_SEDIMENT_BLOCK_RE, NS_SEDIMENT_LINE_BEGIN_RE, NS_SEGMENTS_BLOCK_RE, NS_SEGMENTS_START_RE, NS_SESSION_LINE_RE, NS_SESSION_RE, NS_SESSION_VALUE_RE, NS_TAGS_RE, NS_TAG_PREFIX, nsMarkerGlobalRe } from "../shared/namespace";

import { MODE_META, MODE_PREFIX_TO_KEY } from "../shared/catalog-modes";

import { escapeRegExp, formatElapsed, primitiveText, sanitizeFilename } from "../shared/util-common";

import { diagnosticError } from "../shared/util-key-diag";

import { replaceExistingActiveVersionBlock, sanitizeActiveVersionBody, splitLeadingFrontmatter } from "../version-content";

import { readSpeakerMappings, speakerLabelForChannel } from "../audio/channel-speakers";

import { extractBriefingPartEnvelope } from "../briefing/pipeline";

export function isTimeLabel(text) {
  const time = "(?:\\d{1,2}:)?\\d{1,2}:\\d{2}";
  return new RegExp("^" + time + "(?:\\s*[–-]\\s*" + time + ")?$").test(String(text || "").trim());
}

export function stripAutoTitleSuffix(stem, settings) {
  const prefixes = Object.values(MODE_META)
    .map(m => sanitizeFilename(m && m.prefix))
    .concat(getCustomPromptModeTemplates(settings || {}).map(t => sanitizeFilename(t.name)))
    .filter(Boolean);
  const unique = Array.from(new Set(prefixes)).sort((a, b) => b.length - a.length);
  if (!unique.length) return String(stem || "").trim();
  const re = new RegExp("\\s*·\\s*(?:" + unique.map(escapeRegExp).join("|") + ")-[^·/\\\\]+$");
  return String(stem || "").replace(re, "").trim();
}

export function buildRenamedMarkdownPath(currentPath, mode, titleTag, settings) {
  const norm = obsidian.normalizePath(String(currentPath || ""));
  const slash = norm.lastIndexOf("/");
  const dir = slash >= 0 ? norm.slice(0, slash) : "";
  const name = slash >= 0 ? norm.slice(slash + 1) : norm;
  const stem = stripAutoTitleSuffix(name.replace(/\.md$/i, ""), settings);
  const meta = getModeMeta(settings, mode);
  const modePrefix = sanitizeFilename(meta.prefix || "自定义") || "自定义";
  const tag = sanitizeFilename(titleTag) || "";
  if (!stem || !tag) return "";
  const nextName = `${stem} · ${modePrefix}-${tag}.md`;
  return obsidian.normalizePath(dir ? `${dir}/${nextName}` : nextName);
}

export function getSourceIdFromMarkdown(markdown, file) {
  const text = String(markdown || "");
  const sidMatch = text.match(NS_SESSION_VALUE_RE);
  if (sidMatch && sidMatch[1]) return sanitizeFilename(sidMatch[1]) || sidMatch[1];
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
  const label = String(versionMeta && versionMeta.label || versionMeta && versionMeta.kind || "当前版本");
  const mode = String(versionMeta && versionMeta.mode || "");
  const style = String(versionMeta && versionMeta.style || "");
  const created = String(versionMeta && versionMeta.createdAt || "");
  const sourceHash = String(versionMeta && versionMeta.sourceHash || "");
  const desc = [label, mode, style].filter(Boolean).join(" · ");
  const metaLines = [
    `> [!info] 当前显示版本：${desc || "当前版本"}`,
    created ? `> 生成时间：${created}` : "",
    sourceHash ? `> 源转写指纹：${sourceHash}` : "",
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

// ===== API 密钥本地存储混淆 =====
// 目标：data.json 里不出现可直接读取的明文密钥（满足"不是明文"承诺、防止截图/误分享 data.json 泄露）。
// 诚实说明：这是「混淆」不是「加密」—— 因为本插件开源，变换算法公开，能拿到 data.json + 读源码的人仍可还原。
// 但它消除了"密钥以 sk-xxx 明文躺在配置文件里"这一最常见的泄露面，且密钥从不离开本地（仅在调用 API 时发往对应服务端点）。
// 内存中 settings 始终保存明文密钥，所有调用大模型/转写的代码无需改动；只有落盘的 data.json 是混淆态。

export function normalizeModeFromLabel(settings, label) {
  const text = String(label || "").trim();
  if (!text) return "";
  if (isKnownPolishMode(settings, text)) return text;
  if (MODE_PREFIX_TO_KEY[text]) return MODE_PREFIX_TO_KEY[text];
  const normalized = text.replace(new RegExp(`^${NS_TAG}/`, "i"), "").trim();
  if (isKnownPolishMode(settings, normalized)) return normalized;
  if (MODE_PREFIX_TO_KEY[normalized]) return MODE_PREFIX_TO_KEY[normalized];
  for (const [mode, name] of getVisibleModeEntries(settings, false)) {
    if (text === name || normalized === name) return mode;
  }
  return "";
}

export function clampProgress(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function stripImportAppendices(text) {
  return stripSedimentPreExtractionBlocks(String(text || ""))
    .replace(/<details>\s*<summary>\s*导入文本信息[\s\S]*?<\/details>/gi, "\n")
    .replace(/<details>\s*<summary>\s*导入文本原文[\s\S]*?<\/details>/gi, "\n")
    .replace(/<details>\s*<summary>\s*录音中实时大纲[\s\S]*?<\/details>/gi, "\n")
    .replace(/<details>\s*<summary>\s*回听时间轴[\s\S]*?<\/details>/gi, "\n")
    .replace(/<details>\s*<summary>\s*分段原始转写[\s\S]*?<\/details>/gi, "\n");
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
  const matches = [...source.matchAll(/^##\s+(?:✨\s*)?整合版[^\n]*$/gm)];
  if (!matches.length) return "";
  const match = matches[matches.length - 1];
  const start = (match.index || 0) + match[0].length;
  const tail = source.slice(start);
  const stopPatterns = [
    /\n<details>\s*<summary>\s*导入文本信息/i,
    /\n<details>\s*<summary>\s*导入文本原文/i,
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
    || /##\s+(?:✨\s*)?整合版/.test(withoutFrontmatter);
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
  return [`【文本来源 ${index + 1}：${link}】`, "", body].join("\n");
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

export function isTextImportSession(session) {
  return !!(session && session.source === "text-import");
}

export const EMAIL_DRAFT_FOLDER = `${NS_ROOT}/邮件草稿`;

export const EMAIL_DRAFT_ATTACHMENT_FOLDER = `${EMAIL_DRAFT_FOLDER}/附件`;

export const EMAIL_ATTENDEE_FIELDS = ["参会人", "与会人", "参与者", "出席人", "受访者", "访问者", "面试官", "候选人", "当事人", "相关人员", "人员", "人物"];

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
      const direct = value["姓名"] || value.name || value["人员"] || value.person || value.label;
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
    `Subject: ${encodeMailHeader(subject || "Q&A Log 会议纪要")}`,
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
  const rawSplit = text.split(/\n(?=#{1,6}\s+(?:📁\s*)?(?:原始材料|原始转写|逐字稿|录音原文|回听时间轴|录音中实时大纲)\b)/);
  return (rawSplit[0] || text).trim();
}

export function cleanEmailMarkdownLine(line) {
  let s = String(line || "").trim();
  if (!s) return "";
  if (/^```/.test(s)) return "";
  s = s.replace(/^>\s?/, "").trim();
  s = s.replace(/^\[![^\]]+\][+-]?\s*/i, "").trim();
  s = s.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim();
  if (!s || /^(录音信息|回听时间轴|原始材料|原始转写|逐字稿|录音原文)$/i.test(s)) return "";
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
    `纪要：${file && file.basename ? file.basename : "Q&A Log 会议纪要"}.md`,
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
  body.push("此邮件草稿由 Q&A Log 在本地生成。发送前请确认收件人、正文和附件是否正确。");
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
    .replace(/^###\s+段落\s+\d+[^\n]*$/gm, "")
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/^_\[(?:转写失败|等待后台转写|此段尚未完成转写)[^\n]*$/gm, "")
    .replace(/^_\[此段无内容\]_$/gm, "")
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
    const labelIdx = text.indexOf("分段原始转写", searchFrom);
    if (labelIdx < 0) break;
    const summaryEnd = text.indexOf("</summary>", labelIdx);
    const detailsEnd = summaryEnd >= 0 ? text.indexOf("</details>", summaryEnd) : -1;
    if (summaryEnd >= 0 && detailsEnd > summaryEnd) {
      sections.push(text.slice(summaryEnd + "</summary>".length, detailsEnd));
      searchFrom = detailsEnd + "</details>".length;
    } else {
      searchFrom = labelIdx + 1;
    }
  }

  const startRe = nsMarkerGlobalRe("segments-start");
  while (startRe.exec(text)) {
    const endRe = nsMarkerGlobalRe("segments-end");
    endRe.lastIndex = startRe.lastIndex;
    const endMatch = endRe.exec(text);
    if (endMatch) sections.push(text.slice(startRe.lastIndex, endMatch.index));
  }

  if (!sections.length) {
    const rawIdx = text.lastIndexOf("原始转写：");
    if (rawIdx >= 0) sections.push(text.slice(rawIdx + "原始转写：".length));
  }
  return sections;
}

export function extractTranscriptSegments(markdown) {
  const sections = splitTranscriptSections(markdown);
  const segments = [];
  for (const section of sections) {
    const headingRe = /^###\s+段落\s+(\d+)([^\n]*)$/gm;
    const heads = [...String(section).matchAll(headingRe)];
    if (!heads.length) {
      const text = cleanTranscriptBlock(section);
      if (text) segments.push({ index: segments.length, startOffsetMs: 0, endOffsetMs: 0, text });
      continue;
    }
    for (let i = 0; i < heads.length; i++) {
      const head = heads[i];
      const bodyStart = head.index + head[0].length;
      const bodyEnd = i + 1 < heads.length ? heads[i + 1].index : section.length;
      const body = cleanTranscriptBlock(section.slice(bodyStart, bodyEnd));
      if (!body) continue;
      const timeMatch = head[2].match(/\(([^)]+?)[–-]([^)]+?)\)/);
      const startOffsetMs = timeMatch ? parseElapsedMsToken(timeMatch[1]) : 0;
      const endOffsetMs = timeMatch ? parseElapsedMsToken(timeMatch[2]) : startOffsetMs;
      const rawBlock = section.slice(bodyStart, bodyEnd);
      const audioMatch = rawBlock.match(/!\[\[([^\]]+)\]\]/);
      const audioName = audioMatch ? (getAudioLinkTarget(audioMatch[1]).split("/").pop() || getAudioLinkTarget(audioMatch[1])) : "";
      segments.push({
        index: segments.length,
        startOffsetMs,
        endOffsetMs,
        audioName,
        text: body,
      });
    }
  }
  return segments;
}

export function inferNoteStartedAtIso(file, frontmatter) {
  const moment = window.moment;
  const fm = frontmatter || {};
  const candidates = [
    fm.time,
    fm["time"],
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
    .replace(/_?\[(?:此段无内容|无输出|转写失败|等待后台转写|此段尚未完成转写|合并润色失败)[^\]\n]*\]_?/g, "")
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
    .replace(/^>\s*(?:开始|时间|合并自)[：:].*$/gm, "")
    .replace(/^>\s*.*(?:时长|模式|分段|模型).*$/gm, "")
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
export const ROLE_MAPPING_FIELDS = ["参会人", "参谋", "受访者", "访问者", "面试官", "候选人", "当事人"];

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

export function extractSessionId(content, fallback) {
  const match = String(content || "").match(NS_SESSION_VALUE_RE);
  return match ? match[1].trim() : fallback;
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

// 由代码注入的会话元信息前缀 —— LLM 不需要推断 frontmatter 里的 time/时长
// 这些字段从 session.startedAt / session 时长直接给定
export const FRONTMATTER_CONTENT_KEYS = {
  learning: ["主题", "来源", "语言"],
  interview: ["主题", "受访者", "访问者"],
  meeting: ["主题", "参会人"],
  seminar: ["主题", "研讨对象", "参与者"],
  huddle: ["主题", "当事人", "参谋"],
  monologue: ["主题"],
};

// 把任意 mode（含 custom-xxx）映射到用于查 frontmatter schema 表的 baseKey。
// custom 模式天然带 baseMode（sanitize 强制落到内置模式）。
export function frontmatterBaseModeKey(plugin, mode) {
  if (FRONTMATTER_CONTENT_KEYS[mode]) return mode;
  const custom = plugin && getCustomPromptModeTemplate(plugin.settings, mode);
  if (custom && custom.baseMode && FRONTMATTER_CONTENT_KEYS[custom.baseMode]) return custom.baseMode;
  return "meeting"; // 默认回退到 meeting（含 主题+参会人），而非裸 ["主题"]，避免 custom 内容字段被裁光
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
  if (source["录音主题"] && !source["主题"]) source["主题"] = source["录音主题"];
  if (source["与会人"] && !source["参会人"]) source["参会人"] = source["与会人"];

  const keys = FRONTMATTER_CONTENT_KEYS[baseKey || mode] || ["主题"];
  const allowed = new Set(keys);
  allowed.add("人物"); // 人物 = 独立人员属性，全模式恒定保留（重整时不被当非白名单字段裁掉）
  const cleaned = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) cleaned[key] = source[key];
  }
  if (Object.prototype.hasOwnProperty.call(source, "人物")) cleaned["人物"] = source["人物"];
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(cleaned, key)) cleaned[key] = source[key];
  }
  return cleaned;
}

// \u4ECE\u5168\u6587\u91CC\u628A\u6240\u6709"\u539F\u59CB / \u5143\u6570\u636E"\u5757\uFF08\u4EFB\u610F\u6DF1\u5EA6\uFF09\u62BD\u51FA\u6765\uFF0C\u4F5C\u4E3A rawTail \u4FDD\u7559\u5230\u672B\u5C3E\u3002
// \u8C03\u7528\u8005\u62FF\u5230 withoutRaw \u4E4B\u540E\u53EF\u4EE5\u5B89\u5168\u5730\u628A"\u5DF2\u6574\u7406\u5185\u5BB9"\u5377\u6210 <details>\u4E0A\u4E00\u7248\u7EAA\u8981>\uFF0C
// \u4E0D\u4F1A\u518D\u628A\u6BB5\u843D / \u539F\u59CB\u97F3\u9891 / \u6C89\u6DC0\u5757\u8FD9\u4E9B\u91CD\u578B\u5185\u5BB9\u5D4C\u5957\u8FDB details \u9020\u6210\u7206\u70B8\u5F0F\u589E\u957F\u3002
//
// \u89E3\u51B3\u7684\u5177\u4F53 bug\uFF1A
//   appendRepolishBlock \u539F\u672C\u53EA\u8BC6\u522B ## \uD83D\uDCC1 \u539F\u59CB\u6750\u6599 \u4F5C\u4E3A raw \u8FB9\u754C\uFF0C\u5BF9 appendPolishBlock
//   \u4EA7\u51FA\u7684 "## \u2728 \u6574\u5408\u7248 + \u2039details\u203A\u5F55\u97F3\u4FE1\u606F/\u539F\u59CB\u97F3\u9891/...\u2039/details\u203A" \u7ED3\u6784\u8BC6\u522B\u4E0D\u5230\uFF0C
//   \u5BFC\u81F4\u6BCF\u6B21\u91CD\u65B0\u6574\u7406\u90FD\u628A\u6574\u4E2A\u65E7\u6587\u4EF6\u5D4C\u5957\u8FDB\u65B0\u7684 \u2039details\u203A\u4E0A\u4E00\u7248\u7EAA\u8981\u203A\uFF0C\u91CD\u590D\u5B58\u653E\u6BB5\u843D\u548C\u5143\u6570\u636E\u3002
export function extractAllRawBlocksFromText(text) {
  let s = String(text || "");
  const seen = new Set();
  const tailParts = [];
  const stash = (block) => {
    const trimmed = String(block || "").trim();
    if (!trimmed) return "";
    if (seen.has(trimmed)) return "";
    seen.add(trimmed);
    tailParts.push(trimmed);
    return "";
  };

  // 1. \u4EFB\u610F\u6DF1\u5EA6\u7684 \u2039details\u203A \u5143\u6570\u636E\u5757\uFF08summary \u5173\u952E\u5B57\u767D\u540D\u5355\uFF09
  const detailsPatterns = [
    /<details>\s*\n?<summary>[^<\n]*?\u5F55\u97F3\u4FE1\u606F[^<\n]*?<\/summary>[\s\S]*?<\/details>/gi,
    /<details>\s*\n?<summary>[^<\n]*?\u539F\u59CB\u97F3\u9891[^<\n]*?<\/summary>[\s\S]*?<\/details>/gi,
    /<details>\s*\n?<summary>[^<\n]*?\u5F55\u97F3\u4E2D\u5B9E\u65F6\u5927\u7EB2[^<\n]*?<\/summary>[\s\S]*?<\/details>/gi,
    /<details>\s*\n?<summary>[^<\n]*?\u56DE\u542C\u65F6\u95F4\u8F74[^<\n]*?<\/summary>[\s\S]*?<\/details>/gi,
    /<details>\s*\n?<summary>[^<\n]*?\u5206\u6BB5\u539F\u59CB\u8F6C\u5199[^<\n]*?<\/summary>[\s\S]*?<\/details>/gi,
    /<details>\s*\n?<summary>[^<\n]*?\u6587\u672C\u5BFC\u5165\u6765\u6E90[^<\n]*?<\/summary>[\s\S]*?<\/details>/gi,
    /<details>\s*\n?<summary>[^<\n]*?\u4F1A\u8BAE\u5DE5\u4F5C\u53F0[^<\n]*?<\/summary>[\s\S]*?<\/details>/gi,
  ];
  // \u8FED\u4EE3\u62BD\u53D6\uFF0C\u9632\u6B62\u5D4C\u5957\u5305\u88F9\u672A\u4E00\u6B21\u6027\u6D88\u5E72\u51C0
  for (let iter = 0; iter < 32; iter++) {
    let changed = false;
    for (const re of detailsPatterns) {
      const before = s;
      s = s.replace(re, (m) => stash(m));
      if (s !== before) changed = true;
    }
    if (!changed) break;
  }

  // 2. \u6BB5\u843D\u539F\u6587\uFF1A<!-- qnalog-segments-start --> ... <!-- qnalog-segments-end -->
  s = s.replace(NS_SEGMENTS_BLOCK_RE,
    (m) => stash(m));

  // 3. session \u6807\u8BB0\uFF08\u5982\u679C\u8FD8\u6B8B\u7559\uFF09
  s = s.replace(NS_SESSION_LINE_RE,
    (m) => stash(m.trim()));

  // 4. \u6C89\u6DC0\u5757\uFF1A<!--LEXVOICE_SEDIMENT_BEGIN ... LEXVOICE_SEDIMENT_END-->
  s = s.replace(NS_SEDIMENT_BLOCK_RE,
    (m) => stash(m));

  // 5. \u65E7\u7248\u672C\u91CC"\u5931\u8D25\u7684\u6574\u5408\u7248"\u6B8B\u9AB8\uFF08\u5DF2\u88AB\u65B0\u7248\u672C\u66FF\u4EE3\uFF0C\u4E0D\u5FC5\u4FDD\u7559\uFF09
  s = s.replace(/##\s+\u2728\s+\u6574\u5408\u7248[^\n]*\n+_\[(?:\u5408\u5E76\u6DA6\u8272\u5931\u8D25|AI \u6574\u7406\u5931\u8D25)[^\]]*\]_\s*\n?/g, "");

  // 6. \u6E05\u7406\u53EF\u80FD\u6B8B\u7559\u7684\u7A7A details \u58F3
  s = s.replace(/<details>\s*<\/details>/gi, "");
  s = s.replace(/<details>\s*\n+\s*<\/details>/gi, "");

  return { tail: tailParts.join("\n\n"), withoutRaw: s };
}

export function mergeLeadingFrontmatterIntoDocument(documentText, generatedMarkdown) {
  const generated = splitLeadingFrontmatter(generatedMarkdown || "");
  if (!generated.frontmatter) return { content: String(documentText || ""), body: String(generatedMarkdown || "") };
  const current = splitLeadingFrontmatter(documentText || "");
  return {
    content: generated.frontmatter.trimEnd() + "\n\n" + current.body.replace(/^\n+/, ""),
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
//   - 强制覆盖系统字段：mode / time / 时长 / 状态
//   - merge tags：[qnalog/<mode>] + LLM 标签建议 + (可选) 已有 tags
//   - 删除末尾的 qnalog-tags 注释
//   - originalFrontmatter 非空时（重新整理场景），保留它的内容字段（用户改过的代号映射等），
//     不让 LLM 的 frontmatter 覆盖；只 merge 新的 tag 建议
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

  // base frontmatter 选择：重整时优先用 originalFrontmatter（保留用户改动），首次用 LLM 输出。
  // 随后只保留当前模式 schema 内的内容字段，避免 LLM 擅自加入 date/location/decision 等重复字段。
  const rawBase = (originalFrontmatter && typeof originalFrontmatter === "object")
    ? Object.assign({}, originalFrontmatter)
    : (llmFm && typeof llmFm === "object" ? Object.assign({}, llmFm) : {});
  const base: FrontmatterFields = normalizeBriefingFrontmatterFields(rawBase, mode, baseKey);

  // 强制覆盖系统字段
  base.mode = mode;
  if (sessionMeta && sessionMeta.startedAt) {
    const time = formatYamlDateTime(sessionMeta.startedAt);
    if (time) base.time = time;
  } else if (originalFrontmatter && originalFrontmatter.time) {
    const time = formatYamlDateTime(originalFrontmatter.time);
    if (time) base.time = time;
  }
  // time 第三路兜底：前两路都拿不到时（典型：重整一篇本就缺 time 的 custom 笔记），从 fm 的
  // 日期/时间/文件名线索推断，最终回退当天——保证 time 永远非空，打断 custom 模式"缺 time 自锁"。
  if (!base.time) {
    const inferred = formatYamlDateTime(inferNoteStartedAtIso(null, originalFrontmatter || llmFm || {}));
    if (inferred) base.time = inferred;
  }
  if (sessionMeta && sessionMeta.duration) {
    base["时长"] = sessionMeta.duration;
  }
  base["状态"] = "已整理";

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

  // 人物：独立人员属性。三源合并（机器块 qnalog-people + tags 里 人物/ + base 旧人物），归一去重。
  // 这也是"重整一次旧笔记，人物从 tags 自动迁出到 人物 属性"的落点。
  let people = splitPersonFieldValue(base["人物"] || rawBase["人物"] || rawBase.people || []);
  people = mergeUniqueStrings(people, suggestedPeople);
  people = mergeUniqueStrings(people, peopleFromTags);
  people = mergeUniqueStrings(people, existingPeopleFromTags);
  if (people.length) base["人物"] = people; else delete base["人物"];

  // 字段输出顺序：mode → time → 时长 → 人物 → 内容字段 → 状态 → tags。
  // time 使用 YAML 可识别的日期时间标量，例如 2026-05-08T12:55:00；不再保留 date/日期。
  const ordered: FrontmatterFields = {};
  ordered.mode = base.mode;
  if (base.time) ordered.time = base.time;
  if (base["时长"]) ordered["时长"] = base["时长"];
  if (base["人物"] && base["人物"].length) ordered["人物"] = base["人物"];
  // 中间字段：base 自身按插入顺序，但跳过已写入和末尾要写的（含 人物/people，防二次写入）
  const seenKeys = new Set(["mode", "time", "date", "日期", "时间", "时长", "人物", "people", "状态", "status", "tags"]);
  for (const k of Object.keys(base)) {
    if (seenKeys.has(k)) continue;
    ordered[k] = base[k];
  }
  ordered["状态"] = base["状态"];
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
  return "---\n" + yamlBlock + "---\n\n" + noticeBlock + body.trimStart();
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

  await logLlmRequestDiagnostic(plugin, "warn", "llm.merge_long_text_presummary_start", "长文本导入启动分段预摘要", {
    mode,
    source: sessionMeta.source,
    segmentCount: Array.isArray(segments) ? segments.length : 0,
    inputChars: joined.length,
    chunkCount: chunks.length,
    chunkSize,
  });

  const sys = "你是 Q&A Log 的长文本预处理助手。你的任务是把长文本片段压缩为可用于最终整理的结构化证据摘要。";
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
      await logLlmRequestDiagnostic(plugin, "error", "llm.merge_long_text_presummary_failed", "长文本导入分段预摘要失败", {
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

  await logLlmRequestDiagnostic(plugin, "info", "llm.merge_long_text_presummary_done", "长文本导入分段预摘要完成", {
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
    text: `【长文本预摘要 ${i + 1}/${summaries.length}】\n${summary}`,
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

export function parseBriefingPartResponse(raw) {
  const sedimentPreExtraction = extractSedimentPreExtractionBlock(String(raw || ""));
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
  };
}

export async function generateTitleTag(plugin, polished, mode) {
  const prefix = getModeMeta(plugin.settings, mode).prefix;
  const snippet = (polished || "").slice(0, 2500);
  if (!snippet.trim()) return "";
  const sys = "你是文件命名助手，擅长从中文内容中提取简洁的主题标签。";
  const user = `下面是一段 ${prefix} 记录。请提取一个 ≤15 个字的主题标签。

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
