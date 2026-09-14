/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：侧边栏「问一问」

import { cleanImportedTextForPrompt, extractLexVoiceRawTranscriptForImport, markdownQuoteBlock, stripLexVoiceImportAppendices } from "./note-markdown";

import { truncateForLlmPrompt } from "../shared/util-text";

export const NOTE_ASK_CONTEXT_MAX_CHARS = 18000;

export const NOTE_ASK_TIMEOUT_MS = 75 * 1000;

export const NOTE_ASK_MAX_TOKENS = 1400;

// 「试试这样问」快捷提问（无历史时显示在输入框下方，点击直接发起）。通用会议向，适配大多数纪要。
export const NOTE_ASK_SUGGESTIONS = [
  "本次会议的核心结论？",
  "有哪些待办，分别谁负责？",
  "各方分歧点在哪里？",
  "还有哪些风险或待澄清的问题？",
];

export function stripLexVoiceAskBlocks(text) {
  return String(text || "").replace(/\n##\s+问一问\b[\s\S]*?(?=\n(?:---\s*\n+)?##\s+(?:📁\s*)?原始材料\b|\n<!--\s*LEXVOICE_SEDIMENT_BEGIN|$)/g, "\n");
}

export function buildLexVoiceAskContext(markdown) {
  const withoutFrontmatter = String(markdown || "")
    .replace(/^\uFEFF/, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .trim();
  const rawTranscript = cleanImportedTextForPrompt(extractLexVoiceRawTranscriptForImport(withoutFrontmatter));
  const noteBody = stripLexVoiceAskBlocks(stripLexVoiceImportAppendices(withoutFrontmatter))
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const sections = [];
  if (rawTranscript) sections.push(["【原始转写（优先依据）】", rawTranscript].join("\n"));
  if (noteBody) sections.push(["【纪要正文（辅助参考）】", noteBody].join("\n"));
  return truncateForLlmPrompt(sections.join("\n\n"), NOTE_ASK_CONTEXT_MAX_CHARS);
}

export function normalizeLexVoiceAskSections(text) {
  const source = String(text || "").replace(/\n##\s+问一问\b/g, "\n\n## 问一问");
  const parts = source.split(/\n##\s+问一问\b/);
  if (parts.length <= 2) return source.replace(/\s+$/g, "");
  const before = parts.shift().replace(/\s+$/g, "");
  const merged = parts.map(part => part.trim()).filter(Boolean).join("\n\n");
  return merged
    ? `${before}\n\n## 问一问\n\n${merged}`.replace(/^\s+/, "").replace(/\s+$/g, "")
    : `${before}\n\n## 问一问`.replace(/^\s+/, "").replace(/\s+$/g, "");
}

export function findLexVoiceAskBoundary(markdown) {
  const text = String(markdown || "");
  const patterns = [
    /\n---\s*\n+##\s+(?:📁\s*)?原始材料\b/i,
    /\n##\s+(?:📁\s*)?原始材料\b/i,
    /\n<!--\s*LEXVOICE_SEDIMENT_BEGIN/i,
  ];
  const indexes = patterns
    .map((re) => {
      const m = re.exec(text);
      return m ? m.index : -1;
    })
    .filter(idx => idx >= 0)
    .sort((a, b) => a - b);
  return indexes.length ? indexes[0] : text.length;
}

export function appendLexVoiceAskEntry(markdown, question, answer) {
  const text = String(markdown || "");
  const boundary = findLexVoiceAskBoundary(text);
  const head = normalizeLexVoiceAskSections(text.slice(0, boundary));
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
    "> [!summary] 问一问",
    markdownQuoteBlock(callout),
  ].join("\n");
  const hasAskSection = /\n##\s+问一问\b/.test(`\n${head}`);
  const body = hasAskSection
    ? `${head}\n\n${entry}`
    : `${head}\n\n## 问一问\n\n${entry}`;
  return tail ? `${body}\n\n${tail}` : `${body}\n`;
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
