/**
 * 说话人提及标记：笔记可见正文里每次提到说话人，都写成固定的括号形式，命名前后一致。
 * 中文笔记用 `『说话人3』`、`『张华』`，英文笔记用 `[Speaker 3]`、`[Alice]`。
 *
 * 括号由编号标签的语言决定（`说话人N` → 『』，`Speaker N` → []）；有名字的说话人沿用本篇笔记
 * 编号标签的语言，找不到编号标签时取界面语言下 `t("Speaker ")` 生成的标签。
 *
 * 英文方括号可能被 Markdown 解析成链接：提及后面紧跟 `(`、`[` 或 `:` 时，写成 `\[Alice]`
 * （转义左括号）。`\[` 在 Markdown 与 Obsidian 中显示为普通的 `[`，不会形成链接或链接定义。
 *
 * 只处理可见正文：跳过 frontmatter、代码块与行内代码、`<details>` 折叠块（原始转写保留
 * `**姓名：**` 锚点）、HTML 注释与标签、wiki 链接、Markdown 链接、网址与 qnalog 机器数据行。
 *
 * 纯函数模块：不依赖 Obsidian、DOM 或文件读写。
 */
import { t } from "../shared/i18n";
import { NS_FM_SPEAKERS, nsRe } from "../shared/namespace";
import type { Segment } from "../shared/types";
import { getCurrentTranscript } from "../transcript/session-transcript";

export interface MentionBrackets { open: string; close: string; escapeLinks: boolean }

const CJK_BRACKETS: MentionBrackets = { open: "『", close: "』", escapeLinks: false };
const LATIN_BRACKETS: MentionBrackets = { open: "[", close: "]", escapeLinks: true };

/** 编号标签：`说话人3`、`说话人 3`、`Speaker 3`；数字后不能再接数字。 */
const NUMBERED_SOURCE = "(?:说话人[ \\t]*\\d+|[Ss]peaker[ \\t]+\\d+)(?!\\d)";
const NUMBERED_EXACT_RE = /^(?:说话人[ \t]*(\d+)|[Ss]peaker[ \t]+(\d+))$/;
const NUMBERED_FIND_RE = /说话人[ \t]*\d|[Ss]peaker[ \t]+\d/;
/** 有名字的说话人至少 2 个字符，避免单字误配。 */
export const MIN_SPEAKER_NAME_CHARS = 2;

/** 编号标签对应的括号；不是编号标签时返回 null。 */
export function bracketsForNumberedLabel(label: string): MentionBrackets | null {
  const text = String(label || "").trim();
  if (/^说话人/.test(text)) return CJK_BRACKETS;
  if (/^[Ss]peaker\b/.test(text)) return LATIN_BRACKETS;
  return null;
}

/** 当前界面语言生成编号标签（`t("Speaker ")`）时对应的括号。 */
export function localeMentionBrackets(): MentionBrackets {
  return bracketsForNumberedLabel(`${t("Speaker ")}1`) ?? LATIN_BRACKETS;
}

/** 依次在给出的文字里找第一个编号标签并取其括号；都没有时取界面语言。 */
export function noteMentionBrackets(...samples: readonly string[]): MentionBrackets {
  for (const sample of samples) {
    const found = NUMBERED_FIND_RE.exec(String(sample || ""));
    if (found) return bracketsForNumberedLabel(found[0]) ?? localeMentionBrackets();
  }
  return localeMentionBrackets();
}

/** 按笔记正文（不含 frontmatter：说话人映射的默认标签总是中文）里第一个编号标签取括号。 */
export function noteBodyMentionBrackets(markdown: string): MentionBrackets {
  return noteMentionBrackets(String(markdown || "").replace(LEADING_FRONTMATTER_RE, ""));
}

/** 编号标签统一写法：中文去掉空格（说话人3），英文保留一个空格（Speaker 3）。 */
function canonicalName(name: string): string {
  const numbered = NUMBERED_EXACT_RE.exec(name.trim());
  if (!numbered) return name.trim();
  return numbered[1] !== undefined ? `说话人${Number(numbered[1])}` : `Speaker ${Number(numbered[2])}`;
}

/** 写出一次提及。`nextChar` 是提及后面的字符，用于英文方括号的链接转义。 */
export function formatSpeakerMention(name: string, brackets: MentionBrackets, nextChar = ""): string {
  const text = canonicalName(String(name || "").replace(/\s+/g, " "));
  const open = brackets.escapeLinks && /^[([:]/.test(nextChar) ? `\\${brackets.open}` : brackets.open;
  return `${open}${text}${brackets.close}`;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function usableName(name: string): string {
  const text = String(name || "").replace(/\s+/g, " ").trim();
  if (Array.from(text).length < MIN_SPEAKER_NAME_CHARS) return "";
  if (/[[\]『』<>`|\r\n]/.test(text)) return "";
  return text;
}

// —— 可见正文范围 ——

type Range = [number, number];

const LEADING_FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const INLINE_PROTECTED_RES: RegExp[] = [
  /<!--[\s\S]*?-->/g,
  /&lt;!--[\s\S]*?--&gt;/g,
  /`[^`\n]*`/g,
  /!?\[\[[^\]\n]*\]\]/g,
  /(?<!\\)!?\[[^\]\n]*\]\([^)\n]*\)/g,
  /<\/?[A-Za-z][^>\n]*>/g,
  /https?:\/\/[^\s)>\]]+/g,
  new RegExp(`^[ \\t]*>?[ \\t]*${nsRe("")}(?:people|tags|part-summary)\\b[^\\n]*`, "gim"),
];

/** 行首的说话人行标签（旧版整篇转写的 `**说话人1：**`、`[说话人1]`），由改名流程的行规则处理。 */
const LINE_LABEL_RE = /^[ \t]*(?:\[\d{1,2}:\d{2}(?::\d{2})?\][ \t]*)?(?:\*\*[^*\n]{1,80}[：:]\*\*|\[说话人[ \t]*\d+\])/gm;

export interface MentionScope {
  /** 跳过行首说话人行标签；用于没有「原始材料」标题、转写与正文混在一起的旧笔记。 */
  protectLineLabels?: boolean;
}

function blockRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const frontmatter = LEADING_FRONTMATTER_RE.exec(text);
  if (frontmatter) ranges.push([0, frontmatter[0].length]);
  // 代码块：``` 或 ~~~ 起止。
  let fenceStart = -1;
  let fenceMark = "";
  let offset = 0;
  for (const line of text.split("\n")) {
    const fence = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceStart < 0) { fenceStart = offset; fenceMark = fence[1][0]; }
      else if (fence[1][0] === fenceMark) { ranges.push([fenceStart, offset + line.length]); fenceStart = -1; }
    }
    offset += line.length + 1;
  }
  if (fenceStart >= 0) ranges.push([fenceStart, text.length]);
  // <details> 折叠块，允许嵌套。
  let depth = 0;
  let detailsStart = 0;
  for (const tag of text.matchAll(/<details\b[^>]*>|<\/details\s*>/gi)) {
    const at = tag.index || 0;
    if (/^<\//.test(tag[0])) {
      if (depth > 0 && --depth === 0) ranges.push([detailsStart, at + tag[0].length]);
    } else if (depth++ === 0) {
      detailsStart = at;
    }
  }
  if (depth > 0) ranges.push([detailsStart, text.length]);
  return ranges;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

interface TextContext { before(index: number): string; after(index: number): string }

/**
 * 对可见正文的每一段调用 `transform`。`inline` 为 false 时只跳过块级范围
 * （frontmatter、代码块、折叠块），用于改写行内 HTML 注释形式的旧标记。
 */
function mapVisibleText(markdown: string, inline: boolean, transform: (segment: string, context: TextContext) => string, scope: MentionScope = {}): string {
  const text = String(markdown || "");
  const ranges = blockRanges(text);
  if (scope.protectLineLabels) for (const match of text.matchAll(LINE_LABEL_RE)) ranges.push([match.index || 0, (match.index || 0) + match[0].length]);
  if (inline) for (const re of INLINE_PROTECTED_RES) for (const match of text.matchAll(re)) ranges.push([match.index || 0, (match.index || 0) + match[0].length]);
  const protectedRanges = mergeRanges(ranges);
  let result = "";
  let cursor = 0;
  const gaps: Range[] = [];
  for (const [start, end] of protectedRanges) {
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) gaps.push([cursor, text.length]);
  cursor = 0;
  for (const [start, end] of gaps) {
    result += text.slice(cursor, start);
    const segment = text.slice(start, end);
    result += transform(segment, {
      before: (index) => (index > 0 ? segment[index - 1] : text[start - 1]) ?? "",
      after: (index) => (index < segment.length ? segment[index] : text[end]) ?? "",
    });
    cursor = end;
  }
  return result + text.slice(cursor);
}

// —— 包裹与改名 ——

function namedAlternation(names: readonly string[]): string {
  const usable = [...new Set(names.map(usableName).filter((name) => name && !NUMBERED_EXACT_RE.test(name)))];
  usable.sort((a, b) => Array.from(b).length - Array.from(a).length);
  return usable.map(escapeRe).join("|");
}

function mentionPattern(core: string): RegExp {
  return new RegExp(`『(${core})』|\\\\?\\[(${core})\\]|(${core})`, "g");
}

/** 拉丁字母或数字结尾的名字不能紧贴其他字母数字，避免包住单词的一部分。 */
function bareBoundaryOk(name: string, before: string, after: string): boolean {
  if (/^[A-Za-z0-9]/.test(name) && /[A-Za-z0-9_]/.test(before)) return false;
  if (/[A-Za-z0-9]$/.test(name) && /[A-Za-z0-9_]/.test(after)) return false;
  return true;
}

function bracketsOf(match: string, name: string, named: MentionBrackets): MentionBrackets {
  if (match.startsWith("『")) return CJK_BRACKETS;
  if (match.startsWith("[") || match.startsWith("\\[")) return LATIN_BRACKETS;
  return bracketsForNumberedLabel(name) ?? named;
}

/**
 * 把可见正文里每个编号标签与 `names` 中的姓名写成提及标记。已经是标记的提及保持原样
 * （只重新判断英文方括号是否需要转义），因此重复调用结果不变。
 */
export function wrapSpeakerMentions(markdown: string, names: readonly string[], namedBrackets: MentionBrackets, scope: MentionScope = {}): string {
  const namedCore = namedAlternation(names);
  const core = namedCore ? `${NUMBERED_SOURCE}|${namedCore}` : NUMBERED_SOURCE;
  const pattern = mentionPattern(core);
  return mapVisibleText(markdown, true, (segment, context) => segment.replace(pattern, (match: string, a: string | undefined, b: string | undefined, bare: string | undefined, offset: number) => {
    const name = a ?? b ?? bare ?? "";
    if (bare !== undefined && !bareBoundaryOk(name, context.before(offset), context.after(offset + match.length))) return match;
    return formatSpeakerMention(name, bracketsOf(match, name, namedBrackets), context.after(offset + match.length));
  }), scope);
}

/**
 * 把旧版行内注释标记 `<!-- qnalog-speaker-ref:spk-N -->名字<!-- qnalog-speaker-ref-end:spk-N -->`
 * 换成可见提及标记；`renamed` 给出的说话人改用新名字。返回替换次数。
 */
export function convertInlineSpeakerRefs(markdown: string, brackets: MentionBrackets, renamed: { speakerId: string; name: string } | null = null, scope: MentionScope = {}): { markdown: string; replacements: number } {
  let replacements = 0;
  const pair = new RegExp(`<!--\\s*${nsRe("speaker-ref")}:(spk-\\d+)\\s*-->([^\\n]*?)<!--\\s*${nsRe("speaker-ref-end")}:\\1\\s*-->`, "gi");
  const next = mapVisibleText(markdown, false, (segment) => segment.replace(pair, (_match, id: string, name: string, offset: number, whole: string) => {
    replacements += 1;
    const shown = renamed && renamed.speakerId === id ? renamed.name : name.replace(/^[『[]|[』\]]$/g, "");
    const after = whole[offset + _match.length] ?? "";
    return formatSpeakerMention(shown, bracketsForNumberedLabel(shown) ?? brackets, after);
  }), scope);
  return { markdown: next, replacements };
}

/**
 * 改名：把可见正文里属于该说话人的提及（标记形式的旧名字、编号标签，含不带标记的编号标签）
 * 改成 `newName` 的标记形式。返回实际改变的提及数。
 */
export function renameSpeakerMentions(markdown: string, channel: number, previousNames: readonly string[], newName: string, namedBrackets: MentionBrackets, scope: MentionScope = {}): { markdown: string; replacements: number } {
  const numbered = `(?:说话人[ \\t]*${channel}|[Ss]peaker[ \\t]+${channel})(?!\\d)`;
  const namedCore = namedAlternation([...previousNames, newName]);
  const wrappedCore = namedCore ? `${numbered}|${namedCore}` : numbered;
  const pattern = new RegExp(`『(${wrappedCore})』|\\\\?\\[(${wrappedCore})\\]|(${numbered})`, "g");
  let replacements = 0;
  const next = mapVisibleText(markdown, true, (segment, context) => segment.replace(pattern, (match: string, a: string | undefined, b: string | undefined, bare: string | undefined, offset: number) => {
    const name = a ?? b ?? bare ?? "";
    if (bare !== undefined && !bareBoundaryOk(name, context.before(offset), context.after(offset + match.length))) return match;
    const brackets = match.startsWith("『") ? CJK_BRACKETS
      : match.startsWith("[") || match.startsWith("\\[") ? LATIN_BRACKETS
        : bracketsForNumberedLabel(name) ?? namedBrackets;
    const out = formatSpeakerMention(newName, brackets, context.after(offset + match.length));
    if (out !== match) replacements += 1;
    return out;
  }), scope);
  return { markdown: next, replacements };
}

/** 读 frontmatter 里的说话人映射：姓名与编号标签。 */
function mappingNames(frontmatter: unknown): string[] {
  if (!frontmatter || typeof frontmatter !== "object") return [];
  const raw = (frontmatter as Record<string, unknown>)[NS_FM_SPEAKERS];
  if (!raw || typeof raw !== "object") return [];
  const names: string[] = [];
  for (const item of Object.values(raw as Record<string, unknown>)) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    for (const key of ["personName", "name", "label"]) if (typeof entry[key] === "string") names.push(entry[key]);
  }
  return names;
}

function transcriptNames(segments: readonly Segment[], projections: readonly { speakerName: string | null }[]): string[] {
  const names: string[] = [];
  for (const segment of segments || []) {
    if (!segment || !segment.transcript) continue;
    for (const utterance of getCurrentTranscript(segment.transcript).utterances) if (utterance.speakerName) names.push(utterance.speakerName);
  }
  for (const projection of projections || []) if (projection && projection.speakerName) names.push(projection.speakerName);
  return names;
}

/** 本篇笔记已知的说话人显示名：说话人映射、转写账本里的显示名与本次整理的投影，去重。 */
export function collectSpeakerMentionNames(
  segments: readonly Segment[],
  frontmatter: unknown,
  projections: readonly { speakerName: string | null }[] = [],
): string[] {
  const all = [...mappingNames(frontmatter), ...transcriptNames(segments, projections)];
  return [...new Set(all.map((name) => String(name).trim()).filter(Boolean))];
}

/**
 * 整理与重新整理之后：给模型输出里的说话人提及加标记（正文、待办行与原话出处区块）。
 * 已知名字来自说话人映射、转写账本里的显示名与本次整理的投影；括号按转写里的编号标签、
 * 正文、映射标签的顺序取第一个编号标签决定。
 */
export function markSpeakerMentionsInOrganizedBody(
  markdown: string,
  segments: readonly Segment[],
  frontmatter: unknown,
  projections: readonly { speakerName: string | null }[] = [],
): string {
  const fromTranscript = transcriptNames(segments, projections);
  const fromMapping = mappingNames(frontmatter);
  const names = collectSpeakerMentionNames(segments, frontmatter, projections);
  const brackets = noteMentionBrackets(fromTranscript.join("\n"), String(markdown || "").replace(LEADING_FRONTMATTER_RE, ""), fromMapping.join("\n"));
  return wrapSpeakerMentions(markdown, names, brackets);
}
