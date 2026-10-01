/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：侧边栏「问一问」

import { cleanImportedTextForPrompt, extractRawTranscriptForImport, markdownQuoteBlock, stripImportAppendices } from "./note-markdown";

import { truncateForLlmPrompt } from "../shared/util-text";
import { NS_SEDIMENT_LINE_BEGIN_RE } from "../shared/namespace";
import { t } from "../shared/i18n";
import { findFirstNoteBoundary } from "./note-document";


export const NOTE_ASK_CONTEXT_MAX_CHARS = 18000;

export const NOTE_ASK_TIMEOUT_MS = 75 * 1000;

export const NOTE_ASK_MAX_TOKENS = 1400;

// 「试试这样问」快捷提问（无历史时显示在输入框下方，点击直接发起）。通用会议向，适配大多数纪要。
// 英文源；中文由词条表提供（渲染处包 t()）。
export const NOTE_ASK_SUGGESTIONS = [
  "What are the key conclusions of this meeting?",
  "What are the to-dos, and who owns each?",
  "Where do the parties disagree?",
  "What risks or open questions remain?",
];

export function stripAskBlocks(text) {
  // 中英双语标题都必须命中：词尾用 (?!\w)——中文词后接换行时 \b 不成立（前一字符非 \w），
  // (?!\w) 对中英文分支都给出同一种结果，切语言不改变解析结果。
  return String(text || "").replace(/\n##\s+(?:问一问|Q&A)(?![\w])[\s\S]*?(?=\n(?:---\s*\n+)?##\s+(?:📁\s*)?(?:原始材料|Original material)(?![\w])|\n<!--\s*(?:QNALOG|LEXVOICE)_SEDIMENT_BEGIN|$)/g, "\n");
}

export function buildAskContext(markdown) {
  const withoutFrontmatter = String(markdown || "")
    .replace(/^\uFEFF/, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .trim();
  const rawTranscript = cleanImportedTextForPrompt(extractRawTranscriptForImport(withoutFrontmatter));
  const noteBody = stripAskBlocks(stripImportAppendices(withoutFrontmatter))
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const sections = [];
  if (rawTranscript) sections.push(["【原始转写（优先依据）】", rawTranscript].join("\n"));
  if (noteBody) sections.push(["【纪要正文（辅助参考）】", noteBody].join("\n"));
  return truncateForLlmPrompt(sections.join("\n\n"), NOTE_ASK_CONTEXT_MAX_CHARS);
}

export function normalizeAskSections(text) {
  const heading = `## ${t("Q&A")}`;
  const source = String(text || "").replace(/\n##\s+(?:问一问|Q&A)(?![\w])/g, `\n\n${heading}`);
  const parts = source.split(new RegExp(`\\n##\\s+(?:问一问|Q&A)(?![\\w])`));
  if (parts.length <= 2) return source.replace(/\s+$/g, "");
  const before = parts.shift().replace(/\s+$/g, "");
  const merged = parts.map(part => part.trim()).filter(Boolean).join("\n\n");
  return merged
    ? `${before}\n\n${heading}\n\n${merged}`.replace(/^\s+/, "").replace(/\s+$/g, "")
    : `${before}\n\n${heading}`.replace(/^\s+/, "").replace(/\s+$/g, "");
}

export function findAskBoundary(markdown) {
  const text = String(markdown || "");
  const patterns = [
    /\n---\s*\n+##\s+(?:📁\s*)?(?:原始材料|Original material)(?![\w])/i,
    /\n##\s+(?:📁\s*)?(?:原始材料|Original material)(?![\w])/i,
    NS_SEDIMENT_LINE_BEGIN_RE,
  ];
  return findFirstNoteBoundary(text, patterns);
}

export function appendAskEntry(markdown, question, answer) {
  const text = String(markdown || "");
  const boundary = findAskBoundary(text);
  const head = normalizeAskSections(text.slice(0, boundary));
  const tail = text.slice(boundary).replace(/^\s*/g, "");
  const stamp = window.moment ? window.moment().format("YYYY-MM-DD HH:mm") : new Date().toISOString();
  const callout = [
    "**问：**",
    String(question || "").trim(),
    "",
    "---",
    "",
    "**答：**",
    String(answer || "").trim(),
  ].join("\n");
  const entry = [
    `### ${stamp}`,
    "",
    `> [!summary] ${t("Q&A")}`,
    markdownQuoteBlock(callout),
  ].join("\n");
  const hasAskSection = /\n##\s+(?:问一问|Q&A)(?![\w])/.test(`\n${head}`);
  const body = hasAskSection
    ? `${head}\n\n${entry}`
    : `${head}\n\n## ${t("Q&A")}\n\n${entry}`;
  return tail ? `${body}\n\n${tail}` : `${body}\n`;
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
