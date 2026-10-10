import * as obsidian from "obsidian";
import { getCustomPromptModeTemplate } from "../shared/mode-meta";
import { NS_FM, NS_FM_SPEAKERS, NS_TAG, NS_TAG_PREFIX, NS_TAGS_RE, hasNamespaceFrontmatter, readNamespaceFrontmatter } from "../shared/namespace";
import type { NamespaceFrontmatterField } from "../shared/namespace";
import { mergeUniqueStrings, parsePeopleFromOutput, splitPersonFieldValue } from "../people/person-text";
import { splitLeadingFrontmatter } from "./note-document";
import { inferNoteStartedAtIso } from "./note-source-metadata";
import { buildEmptyLlmOutputFallback } from "./note-write-content";
import { detectGeneralSourceLanguage, type GeneralSourceLanguage } from "../shared/util-text";
import { normalizeCallouts } from "./callout-normalize";

export type FrontmatterFields = Record<string, unknown>;
const stringifyBriefingValue = String as (value: unknown) => string;

function cleanTodoFieldValue(value: unknown): string {
  return stringifyBriefingValue(value || "")
    .trim()
    .replace(/[，,。；;、\s]+$/g, "")
    .trim();
}

function isEmptyTodoFieldValue(value: unknown): boolean {
  const t = cleanTodoFieldValue(value);
  return !t || /^(无|暂无|没有|未提及|未明确|未指定|未知|不适用|跳过|待定|tbd|n\/a|na|null|none|-)$/i.test(t);
}

function cleanTodoOwnerValue(value: unknown): string {
  const parts = stringifyBriefingValue(value || "")
    .split(/[/／、,，;；]|(?:\s+和\s+)/)
    .map(cleanTodoFieldValue)
    .filter(Boolean)
    .filter(part => !/^(主讲人|发言人\d*|说话人\d*|相关方|业务需求方|负责人|某负责人|某同学|参会人|参与者|人员|未提及|未明确|未指定|未知|待定)$/i.test(part));
  return parts.join("、");
}

export function scrubBriefingTodoPlaceholders(markdown: unknown): string {
  return stringifyBriefingValue(markdown || "").split(/\r?\n/).map(line => {
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
export function frontmatterBaseModeKey(settings: Parameters<typeof getCustomPromptModeTemplate>[0], mode: string): string {
  if (FRONTMATTER_CONTENT_KEYS[mode]) return mode;
  const custom = getCustomPromptModeTemplate(settings, mode);
  if (custom?.baseMode && FRONTMATTER_CONTENT_KEYS[custom.baseMode]) return custom.baseMode;
  return "meeting"; // custom mode 使用 meeting 内容字段白名单，保留 qnalog_topic 与 qnalog_participants。
}

export function formatYamlDateTime(value: unknown): string {
  if (!value) return "";
  const moment = window.moment;
  if (moment) {
    const m = moment(value);
    if (m && m.isValid && m.isValid()) return m.format("YYYY-MM-DDTHH:mm:ss");
  }
  const d = new Date(value as string | number | Date);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function normalizeBriefingFrontmatterFields(raw: unknown, mode: string, baseKey: string): FrontmatterFields {
  const source: Record<string, unknown> = (raw && typeof raw === "object") ? Object.assign({} as Record<string, unknown>, raw) : {};
  const keys = FRONTMATTER_CONTENT_KEYS[baseKey || mode] || ["topic"];
  const cleaned: FrontmatterFields = {};
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

export function mergeLeadingFrontmatterIntoDocument(documentText: string, generatedMarkdown: string): { content: string; body: string } {
  const generated = splitLeadingFrontmatter(generatedMarkdown || "");
  if (!generated.frontmatter) return { content: String(documentText || ""), body: String(generatedMarkdown || "") };
  const current = splitLeadingFrontmatter(documentText || "");
  return {
    content: generated.frontmatter.trimEnd() + "\n" + current.body.replace(/^\n+/, ""),
    body: generated.body.trim() || buildEmptyLlmOutputFallback(),
  };
}

// 解析 LLM 输出末尾的标签建议注释 <!-- qnalog-tags: 主题/实时转写, 项目/示例 -->
export function parseSuggestedTagsFromOutput(text: string | null | undefined): { tags: string[]; people?: string[]; cleaned: string } {
  if (!text) return { tags: [], cleaned: text || "" };
  const re = NS_TAGS_RE;
  const m = text.match(re);
  if (!m) return { tags: [], cleaned: text };
  const peopleFromTags: string[] = [];
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

const GENERAL_TODO_ZH_LABELS = {
  task: String.fromCharCode(0x4e8b, 0x9879),
  owner: String.fromCharCode(0x8d23, 0x4efb, 0x4eba),
  due: String.fromCharCode(0x622a, 0x6b62),
  colon: String.fromCharCode(0xff1a),
};
const GENERAL_TODO_LABELS: Record<"zh" | "en", Record<string, string>> = {
  zh: {
    task: `${GENERAL_TODO_ZH_LABELS.task}${GENERAL_TODO_ZH_LABELS.colon}`,
    owner: `${GENERAL_TODO_ZH_LABELS.owner}${GENERAL_TODO_ZH_LABELS.colon}`,
    due: `${GENERAL_TODO_ZH_LABELS.due}${GENERAL_TODO_ZH_LABELS.colon}`,
    deadline: `${GENERAL_TODO_ZH_LABELS.due}${GENERAL_TODO_ZH_LABELS.colon}`,
    [GENERAL_TODO_ZH_LABELS.task]: `${GENERAL_TODO_ZH_LABELS.task}${GENERAL_TODO_ZH_LABELS.colon}`,
    [GENERAL_TODO_ZH_LABELS.owner]: `${GENERAL_TODO_ZH_LABELS.owner}${GENERAL_TODO_ZH_LABELS.colon}`,
    [GENERAL_TODO_ZH_LABELS.due]: `${GENERAL_TODO_ZH_LABELS.due}${GENERAL_TODO_ZH_LABELS.colon}`,
  },
  en: {
    task: "Task:",
    owner: "Owner:",
    due: "Due:",
    deadline: "Due:",
    [GENERAL_TODO_ZH_LABELS.task]: "Task:",
    [GENERAL_TODO_ZH_LABELS.owner]: "Owner:",
    [GENERAL_TODO_ZH_LABELS.due]: "Due:",
  },
};
const GENERAL_TODO_LABEL_PATTERN = new RegExp(
  `^(Task|Owner|Due|Deadline|${GENERAL_TODO_ZH_LABELS.task}|${GENERAL_TODO_ZH_LABELS.owner}|${GENERAL_TODO_ZH_LABELS.due})(\\s*[:${GENERAL_TODO_ZH_LABELS.colon}])`,
  "i",
);
const GENERAL_TODO_CONTINUATION_PATTERN = new RegExp(
  `^(?:Task|Owner|Due|Deadline|${GENERAL_TODO_ZH_LABELS.task}|${GENERAL_TODO_ZH_LABELS.owner}|${GENERAL_TODO_ZH_LABELS.due})\\s*[:${GENERAL_TODO_ZH_LABELS.colon}]`,
  "i",
);

function normalizeGeneralTodoLabel(value: string, language: "zh" | "en"): string {
  return value.replace(GENERAL_TODO_LABEL_PATTERN, (match, label: string) => {
    const labels = GENERAL_TODO_LABELS[language];
    return labels[label.toLowerCase()] || labels[label] || match;
  });
}

function normalizeGeneralTodoLabels(markdown: string, language: GeneralSourceLanguage): string {
  if (language === "other") return markdown;
  const lines = markdown.split(/\r?\n/);
  let fence = "";
  let inTodo = false;
  let inQuoteCallout = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const quote = line.match(/^(\s*>\s?)(.*)$/);
    const prefix = quote?.[1] || "";
    const content = quote ? quote[2] : line;
    const fenceMatch = content.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = "";
      inTodo = false;
      continue;
    }
    if (fence) continue;
    if (quote) {
      const callout = content.match(/^\s*\[!([a-z][a-z0-9_-]*)/i);
      if (callout) inQuoteCallout = callout[1].toLowerCase() === "quote";
      if (inQuoteCallout) {
        inTodo = false;
        continue;
      }
    } else {
      inQuoteCallout = false;
    }
    const todo = content.match(/^(\s*[-*+]\s+\[[ xX]\]\s+)(.*)$/);
    if (todo) {
      lines[index] = `${prefix}${todo[1]}${normalizeGeneralTodoLabel(todo[2], language)}`;
      inTodo = true;
      continue;
    }
    const continuation = content.match(/^(\s{2,}(?:[-*+]\s+)?|[-*+]\s+)?(.*)$/);
    if (inTodo && continuation && GENERAL_TODO_CONTINUATION_PATTERN.test(continuation[2])) {
      lines[index] = `${prefix}${continuation[1] || ""}${normalizeGeneralTodoLabel(continuation[2], language)}`;
      continue;
    }
    inTodo = false;
  }
  return lines.join("\n");
}

// 把 LLM 输出（含 frontmatter + 正文 + 末尾 tags 注释）规整成最终笔记内容：
//   - 强制覆盖 qnalog_mode / qnalog_time / qnalog_duration / qnalog_status
//   - 合并标签：[qnalog/<mode>] + LLM 标签建议 + (可选) 已有 tags
//   - 删除末尾的 qnalog-tags 注释
//   - originalFrontmatter 非空时（重新整理场景），按当前模式保留 canonical 内容字段与说话人映射；旧别名只读不写
export function postProcessBriefingOutput(
  rawOutput: string | null | undefined,
  mode: string,
  sessionMeta: { startedAt?: unknown; duration?: unknown } | null | undefined,
  originalFrontmatter: unknown,
  baseKey: string,
  topNotice = "",
  sourceTranscript: unknown = "",
): string {
  if (!rawOutput) return rawOutput || "";
  // 先剥人员机器块、再剥标签机器块（cleaned 串联，保证注释不残留在正文末尾）。
  const { people: suggestedPeople, cleaned: afterPeople } = parsePeopleFromOutput(rawOutput);
  const { tags: suggested, people: peopleFromTags, cleaned: stripped } = parseSuggestedTagsFromOutput(afterPeople);

  // 解析 LLM 输出的 frontmatter（如有）
  const fmMatch = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let llmFm: unknown = null;
  let body = stripped;
  if (fmMatch) {
    try { llmFm = obsidian.parseYaml(fmMatch[1]) as unknown; } catch { llmFm = null; }
    body = stripped.slice(fmMatch[0].length).replace(/^\n+/, "");
  }
  const normalizedBody = normalizeCallouts(body);
  body = scrubBriefingTodoPlaceholders(mode === "general"
    ? normalizeGeneralTodoLabels(normalizedBody, detectGeneralSourceLanguage(sourceTranscript))
    : normalizedBody);
  // 一级标题由插件按会话时间统一写入；模型自作主张输出的 # 标题（含连续多条）会在母本里叠成重复标题，剥掉。
  body = body.replace(/^(?:\s*#\s+[^\n]*(?:\n|$))+/, "");

  // base frontmatter 选择：重整时优先用 originalFrontmatter（保留用户改动），首次用 LLM 输出。
  // 随后只保留当前模式 schema 内的内容字段，避免 LLM 擅自加入 date/location/decision 等重复字段。
  const rawBase: Record<string, unknown> = (originalFrontmatter && typeof originalFrontmatter === "object")
    ? Object.assign({} as Record<string, unknown>, originalFrontmatter)
    : (llmFm && typeof llmFm === "object" ? Object.assign({} as Record<string, unknown>, llmFm) : {});
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
    const inferred = formatYamlDateTime(inferNoteStartedAtIso(null, (originalFrontmatter || llmFm || {}) as Record<string, unknown>));
    if (inferred) base[NS_FM.time] = inferred;
  }
  if (sessionMeta && sessionMeta.duration) base[NS_FM.duration] = sessionMeta.duration;
  base[NS_FM.status] = "organized";

  // merge tags：[qnalog/<mode>] + 已有 + 建议；其中 人物/x 前缀一律剥出转入人物属性，不进 tags。
  const sysTag = NS_TAG_PREFIX + mode;
  const rawTags = (originalFrontmatter as Record<string, unknown> | null | undefined)?.tags || (rawBase && rawBase.tags);
  const existingTagsAll = Array.isArray(rawTags)
    ? rawTags.map(t => String(t).trim()).filter(Boolean)
    : (typeof rawTags === "string" && rawTags.trim() ? [rawTags.trim()] : []);
  const existingPeopleFromTags: string[] = [];
  const existingTags = existingTagsAll.filter(t => {
    if (/^人物\//.test(t)) { existingPeopleFromTags.push(t.replace(/^人物\//, "").trim()); return false; }
    return true;
  });
  const tags: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => { if (t && !seen.has(t)) { tags.push(t); seen.add(t); } };
  push(sysTag);
  for (const t of existingTags) push(t);
  for (const t of suggested) push(t);
  base.tags = tags;

  // qnalog_people：合并机器块、标签里的 人物/ 值与已有属性，归一去重。
  // 重新整理时旧 tags 会在此按需迁入 canonical 属性。
  let people: string[] = splitPersonFieldValue(base[NS_FM.people] || []);
  people = mergeUniqueStrings(people, suggestedPeople);
  people = mergeUniqueStrings(people, peopleFromTags);
  people = mergeUniqueStrings(people, existingPeopleFromTags);
  if (people.length) base[NS_FM.people] = people; else delete base[NS_FM.people];

  // 字段输出顺序：系统字段、内容字段、tags。时间值使用 YAML 可识别的日期时间标量。
  const ordered: FrontmatterFields = {};
  ordered[NS_FM.mode] = base[NS_FM.mode];
  if (base[NS_FM.time]) ordered[NS_FM.time] = base[NS_FM.time];
  if (base[NS_FM.duration]) ordered[NS_FM.duration] = base[NS_FM.duration];
  if (people.length) ordered[NS_FM.people] = people;
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
