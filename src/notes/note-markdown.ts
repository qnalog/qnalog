/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：笔记 Markdown 的解析与生成（版本块、frontmatter 后处理、逐字稿区块、标题与文件名、邮件草稿）——这几个关注点相互引用，合并为一个模块以避免循环导入


import { TEXT_IMPORT_PRE_SUMMARY_MAX_CHUNKS, TEXT_IMPORT_PRE_SUMMARY_THRESHOLD_CHARS } from "../shared/limits";

import { formatMergeSegmentForPrompt } from "../prompts/briefing-prompts";


import { findLowEvidenceEntities } from "./outline-text";


import { getModeMeta, getModePrefix } from "../shared/mode-meta";

import { TEXT_IMPORT_PRE_SUMMARY_CHUNK_CHARS, splitLongTextForLlm } from "../shared/util-text";


import { mergeUniqueStrings, parsePeopleFromOutput } from "../people/person-text";

import { extractSedimentPreExtractionBlock } from "../sediment";
import { stripSedimentPreExtractionBlocks } from "../sediment/text-blocks";
import { removeNoteIndex } from "../indexing/note-index";
import { stripTranscriptMetadata } from "../transcript/transcript-markdown";

import { callLlm, logLlmRequestDiagnostic, stripModeSuggestionBlocks } from "../llm/core";

import { labelText, labelPattern } from "../shared/note-labels";
import { NS_SEDIMENT_LINE_BEGIN_RE, NS_MACHINE_SHELL_RE, NS_SEGMENTS_START_RE, NS_SESSION_RE } from "../shared/namespace";
import { extractTranscriptSegments } from "./note-transcript-ledger";


import { formatElapsed, sanitizeFilename } from "../shared/util-common";

import { diagnosticError } from "../shared/util-key-diag";

import { parseSuggestedTagsFromOutput } from "./note-briefing-output";


import { extractBriefingPartEnvelope } from "../briefing/pipeline";

import { getActiveUiLanguage, t } from "../shared/i18n";
import { parseSessionKnowledgeResponse, stripSessionKnowledgeBlocks } from "../briefing/session-knowledge";

export function isTimeLabel(text) {
  const time = "(?:\\d{1,2}:)?\\d{1,2}:\\d{2}";
  return new RegExp("^" + time + "(?:\\s*[–-]\\s*" + time + ")?$").test(String(text || "").trim());
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
  /<details>\s*<summary>\s*(?:分段原始转写|Segmented raw transcript|原始转写\s*·\s*段落|Raw transcript\s*·\s*Segment)[\s\S]*?<\/details>/gi,
];

export function stripImportAppendices(text) {
  // 索引块（标记+折叠壳）整块剥掉：后面喂提示词的路径未必再剥 HTML 注释。
  let out = removeNoteIndex(stripSedimentPreExtractionBlocks(String(text || "")))
    .replace(NS_MACHINE_SHELL_RE, "\n");
  for (const re of IMPORT_APPENDIX_DETAILS_RES) out = out.replace(re, "\n");
  return stripTranscriptMetadata(out);
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
      .replace("{2}", () => summary),
  }));
}

// 人物指认幻觉的机械兜底（软提示，不删改）：模型可能把转写里零星出现的称呼提升为贯穿全文的
// 核心人物（实测案例：把全场只提到三五次的"某称呼"指认为一号位）。这里按 qnalog-people 名单
// 比对"产出引用次数 vs 原始转写出现次数"，明显倒挂的在文末附核对 callout。
    // 字面计数会因转写错字低估真实人名（"李扣"被转写成"你扣"），所以只提示、绝不自动改写。
const ENTITY_WARNING_LINE_RE = /^> - 「(.+?)」：/;
const MENTION_WRAPPED_RE = /^\\?[『[](.+)[』\]]$/;
const NUMBERED_SPEAKER_RE = /^(?:说话人|Speaker)\s*\d+$/i;

/**
 * 从「人物指认核对」中去掉本篇已知的说话人（编号标签与已命名的说话人）：它们来自说话人分离或用户命名，
 * 原始转写里本来只写编号，按字面计数必然为 0，不是模型推断。其余条目去掉提及标记，只保留「」。
 * 去掉后没有条目时整块删除。
 */
export function dropKnownSpeakersFromEntityWarning(markdown: string, speakerNames: readonly string[]): string {
  const md = String(markdown || "");
  const start = md.indexOf("> [!warning] 人物指认核对");
  if (start < 0) return md;
  const known = new Set(speakerNames.map((name) => String(name).trim()).filter(Boolean));
  const lines = md.slice(start).split("\n");
  let end = 1;
  while (end < lines.length && lines[end].startsWith(">")) end += 1;
  const block = lines.slice(0, end);
  const kept: string[] = [];
  let findings = 0;
  for (const line of block.slice(1)) {
    const match = line.match(ENTITY_WARNING_LINE_RE);
    if (!match) { kept.push(line); continue; }
    const name = match[1].replace(MENTION_WRAPPED_RE, "$1").trim();
    if (known.has(name) || NUMBERED_SPEAKER_RE.test(name)) continue;
    kept.push(line.replace(match[0], `> - 「${name}」：`));
    findings += 1;
  }
  const rest = lines.slice(end).join("\n");
  const before = md.slice(0, start);
  if (!findings) return `${before.replace(/\s+$/, "")}${rest ? `\n${rest}` : ""}`;
  return `${before}${[block[0], ...kept].join("\n")}${rest ? `\n${rest}` : ""}`;
}

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
