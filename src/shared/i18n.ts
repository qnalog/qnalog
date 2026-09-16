/**
 * 界面语言支持。
 *
 * ## 与 Obsidian 的原生约定对齐
 *
 * Obsidian 通过 `getLanguage()` 返回**当前界面语言的 ISO 639-1 码**
 * （`en` / `zh` / `zh-TW` / `ja` / `pt-BR` …），语言清单见
 * `obsidianmd/obsidian-translations`。因此这里的语言标识直接沿用该码，
 * 不自造 `zh`/`en` 这类二分联合类型——那样每加一种语言都要改类型定义，
 * 且无法表达 `zh-TW`（繁體）与 `zh`（简体）是两种语言这一事实。
 *
 * Obsidian 的翻译文件以**英文为源**（"English is the source of truth"），
 * 其余语言是它的译文。本模块沿用同一方向：
 *   - 代码里写英文原文，经 `t()` 取出当前语言的译文；
 *   - 英文表为空（源即英文），中文等语言表提供译文；
 *   - 某条缺译时回退英文原文，而不是显示裸露的键名。
 *
 * ## 不涉及的两项"语言"
 *
 *   - 服务侧语言（`provider.language`、`briefingTargetLanguage`）是转写与整理参数；
 *   - 提示词文本（`src/prompts/`）是发给模型的指令。
 * 两者都与界面语言无关，本模块不碰。
 */

import { EN } from "./i18n/locales/en";
import { ZH } from "./i18n/locales/zh";

/** 词条表：键为英文原文，值为该语言的译文。 */
export type MessageTable = Record<string, string>;

/**
 * 一种界面语言。
 *
 * `id` 为 ISO 639-1 码（与 `getLanguage()` 同源）；
 * `name` 是英文名，`nativeName` 是该语言自己的写法——
 * 语言下拉里显示 nativeName，用户不必先读懂英文才能找到自己的语言。
 */
export interface UiLanguageDescriptor {
  id: string;
  /** 英文名，如 "Chinese (Simplified)"。 */
  name: string;
  /** 本地名，如 "简体中文"。下拉里显示这个。 */
  nativeName: string;
  /** 该语言的词条表；英文表为空对象（源即英文）。 */
  table: MessageTable;
  /**
   * 词条表被视为完整的语言。用于设置页提示「本语言尚未完整翻译」。
   * 英文是源，天然完整。
   */
  complete?: boolean;
}

/**
 * 支持的语言清单。
 *
 * 顺序即设置页下拉的展示顺序：英文在前（源语言），其余按使用量排。
 * 新增一种语言＝在 `i18n/locales/` 下加一个文件并在此登记，不改任何类型定义。
 */
export const UI_LANGUAGES: ReadonlyArray<UiLanguageDescriptor> = [
  { id: "en", name: "English", nativeName: "English", table: EN, complete: true },
  { id: "zh", name: "Chinese (Simplified)", nativeName: "简体中文", table: ZH, complete: true },
];

/** 找不到任何语言线索时使用。英文是源语言，也是回退目标。 */
export const DEFAULT_UI_LANGUAGE = "en";

/** 按 id 查语言描述符；id 大小写不敏感。 */
function findByLangId(id: string): UiLanguageDescriptor | null {
  const key = id.toLowerCase();
  return UI_LANGUAGES.find((l) => l.id.toLowerCase() === key) || null;
}

const DEFAULT_DESCRIPTOR = UI_LANGUAGES.find((l) => l.id === DEFAULT_UI_LANGUAGE) || UI_LANGUAGES[0];

/**
 * 把任意语言标识收敛到已登记的语言。
 *
 * 先精确匹配，再按主语言码降级：`getLanguage()` 可能返回
 * `zh-TW`、`en-GB`、`pt-BR` 这类带地区的值。未登记 `zh-TW` 时
 * 回退到 `zh`，比直接落到英文更贴近用户预期。
 *
 * 认不出的语言返回 `null` 而不是默认值：调用方需要区分
 * 「用户明确选了一个不支持的语言」与「没有语言线索」。
 */
export function matchUiLanguage(input: string | null | undefined): UiLanguageDescriptor | null {
  const raw = (typeof input === "string" ? input : "").trim().toLowerCase();
  if (!raw) return null;
  const exact = findByLangId(raw);
  if (exact) return exact;
  // zh-TW → zh；en-GB → en；pt-BR → pt
  const primary = raw.split(/[-_]/)[0];
  if (primary && primary !== raw) {
    const fallback = findByLangId(primary);
    if (fallback) return fallback;
  }
  return null;
}

/** 语言标识是否已登记（供设置页判断保存的值还有没有效）。 */
export function isSupportedUiLanguage(input: string | null | undefined): boolean {
  return matchUiLanguage(input) !== null;
}

/**
 * 决定当前使用的界面语言。
 *
 * `configured` 为设置里保存的值；空串表示"跟随 Obsidian"。
 * `hostLanguage` 是 Obsidian 的界面语言。两者都认不出时用默认语言。
 */
export function resolveUiLanguage(
  configured: string | null | undefined,
  hostLanguage: string | null | undefined,
): UiLanguageDescriptor {
  const explicit = (typeof configured === "string" ? configured : "").trim();
  if (explicit) {
    const hit = matchUiLanguage(explicit);
    if (hit) return hit;
  }
  const host = (typeof hostLanguage === "string" ? hostLanguage : "").trim();
  if (host) {
    const hit = matchUiLanguage(host);
    if (hit) return hit;
  }
  return DEFAULT_DESCRIPTOR;
}

/**
 * 取词条。
 *
 * 查不到译文时返回英文原文——英文是源语言，回退到它是显示未翻译，
 * 回退到中文（或任何其他语言）会让英文用户看到读不懂的文字。
 */
export function translateInto(lang: UiLanguageDescriptor | null | undefined, source: string): string {
  if (!lang) return source;
  const hit = lang.table[source];
  return typeof hit === "string" && hit ? hit : source;
}

/** `translateInto` 的柯里化形式：绑定语言后反复调用，避免每次传语言。 */
export interface Translator {
  (source: string): string;
}

export function createTranslator(lang: UiLanguageDescriptor | null | undefined): Translator {
  return (source) => translateInto(lang, source);
}

/**
 * 当前生效的语言，供不便层层传参的深层模块读取。
 *
 * 这是本模块的可变状态，只在插件加载与用户切换语言时写一次；
 * 不放进 settings 对象是因为它被近百个模块读取，穿参会污染所有中间层。
 */
export let activeUiLanguage: UiLanguageDescriptor = DEFAULT_DESCRIPTOR;

export function setActiveUiLanguage(lang: UiLanguageDescriptor): void {
  activeUiLanguage = lang || DEFAULT_DESCRIPTOR;
}

/** 当前生效的界面语言。需要按语言分支时用它（例如给不同地区选默认服务商）。 */
export function getActiveUiLanguage(): UiLanguageDescriptor {
  return activeUiLanguage;
}

/** 用当前生效语言翻译。参数层级太深时用这个，避免把语言一路穿参。 */
export function t(source: string): string {
  return translateInto(activeUiLanguage, source);
}

/** 已登记的翻译条目数，供测试与自检使用。 */
export function translationCount(langId: string): number {
  const lang = matchUiLanguage(langId);
  return lang ? Object.keys(lang.table).length : 0;
}
