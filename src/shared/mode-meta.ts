/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。
import * as obsidian from "obsidian";
import { MODE_META } from './catalog-modes';

import { getActiveUiLanguage, t } from "../shared/i18n";
import type { PromptTemplate } from "./types";

interface ModeSettings {
  promptTemplates?: Record<string, unknown> | null;
  polishMode?: string;
}
interface ModeMetadata {
  prefix: string;
  label: string;
  emoji?: string;
  icon?: string;
  goal?: string;
  baseMode?: string;
  custom?: boolean;
  legacy?: boolean;
}
type ModePrefixInput = Partial<Pick<ModeMetadata, "prefix" | "label">>;
type ModePillInput = ModePrefixInput & Pick<ModeMetadata, "icon">;
type PromptTemplateInput = Omit<Partial<PromptTemplate>, "id" | "mode" | "name" | "description" | "prompt"> & {
  id?: unknown;
  mode?: unknown;
  name?: unknown;
  description?: unknown;
  prompt?: unknown;
};
const modeMetaByKey = MODE_META as Record<string, ModeMetadata>;
const stringifyModeValue = String as (value: unknown) => string;
export const STANDARD_POLISH_MODES = ["general", "synthesis", "meeting", "seminar", "interview", "monologue", "learning"];

// 曾用于"必须先解锁才可见"的模式（招聘评估 / 招聘需求挖掘 / 晋升评审），随 HR 场景一并移除；
// 现在所有可用模式都是标准模式，不再需要第二份清单与门控。

type CustomPromptModeTemplate = {
  id: string;
  mode: string;
  name?: string;
  description?: string;
  /** 自定义提示词的正文；由 sanitizePromptTemplate 写入并持久化。 */
  prompt?: string;
  baseMode?: string;
  customMode?: boolean;
};

export function isKnownPolishMode(settings: ModeSettings | null | undefined, mode: string): boolean {
  if (mode === "off") return true;
  return !!(modeMetaByKey[mode] || getCustomPromptModeTemplate(settings, mode));
}

export function isCustomPromptModeTemplate(t: unknown): t is CustomPromptModeTemplate {
  if (!t || typeof t !== "object") return false;
  const item = t as Partial<CustomPromptModeTemplate>;
  return !!(item.customMode === true && typeof item.id === "string" && typeof item.mode === "string" && item.id === item.mode);
}

export function makeCustomPromptModeId(seed: unknown): string {
  const slug = stringifyModeValue(seed || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return "custom-" + (slug || Date.now().toString(36)) + "-" + Math.random().toString(36).slice(2, 6);
}

export function getCustomPromptModeTemplate(settings: ModeSettings | null | undefined, mode: string): CustomPromptModeTemplate | null {
  const tpls = settings && settings.promptTemplates && typeof settings.promptTemplates === "object" ? settings.promptTemplates : {};
  const t = tpls[mode];
  return isCustomPromptModeTemplate(t) ? t : null;
}

export function getCustomPromptModeTemplates(settings: ModeSettings | null | undefined): CustomPromptModeTemplate[] {
  const tpls = settings && settings.promptTemplates && typeof settings.promptTemplates === "object" ? settings.promptTemplates : {};
  return Object.values(tpls)
    .filter(isCustomPromptModeTemplate)
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh"));
}

export function getBuiltInVisiblePolishModeKeys(settings: ModeSettings | null | undefined): string[] {
  void settings;
  return STANDARD_POLISH_MODES.slice();
}

export function getVisiblePolishModeKeys(settings: ModeSettings | null | undefined): string[] {
  const custom = getCustomPromptModeTemplates(settings).map((t) => t.id);
  return [...getBuiltInVisiblePolishModeKeys(settings), ...custom];
}

export function getModeMeta(settings: ModeSettings | null | undefined, mode: string): ModeMetadata {
  if (mode === "cleanscript") return { prefix: t("Clean transcript"), label: "Clean transcript", icon: "file-text" };
  if (modeMetaByKey[mode]) return modeMetaByKey[mode];
  const custom = getCustomPromptModeTemplate(settings, mode);
  if (custom) {
    const name = custom.name || t("Custom prompt");
    return { prefix: name, emoji: "🧩", icon: "puzzle", label: t("Custom prompt:") + name, goal: custom.description || t("User-defined prompt."), baseMode: custom.baseMode || "learning", custom: true };
  }
  return MODE_META.meeting;
}

/** 解析生效的纪要模式：requested 优先，其次设置里的 polishMode，最后用 fallback（默认 meeting）。 */
export function getEffectivePolishMode(settings: ModeSettings | null | undefined, requested: string | null | undefined, fallback: string | null = null): string {
  const fb = fallback == null ? "meeting" : fallback;
  const mode = requested || (settings && settings.polishMode) || fb;
  if (mode === "off") return mode;
  if (isKnownPolishMode(settings, mode)) return mode;
  return fb;
}

/**
 * 写入笔记标题用的模板前缀，跟随界面语言。
 *
 * MODE_META 的 prefix 是中文，用于解析既有笔记；界面语言为英文时，
 * 新笔记的标题与文件名应使用英文前缀，否则英文用户看到的是中文标题。
 * 两种前缀在读取时都能解析回同一个 mode（见 normalizeModeFromLabel）。
 */
export function getModePrefix(meta: ModePrefixInput | null | undefined): string {
  if (!meta) return "";
  return meta.label && getActiveUiLanguage().id === "en"
    ? meta.label
    : (meta.prefix || meta.label || "");
}

export function getVisibleModeEntries(settings: ModeSettings | null | undefined, includeOff: boolean): [string, string][] {
  const entries = getVisiblePolishModeKeys(settings).map((key): [string, string] => [key, getModeMeta(settings, key).prefix]);
  // 第二个元素是**前缀**（写进笔记文件名、供读取侧解析），不是界面显示名：
  // 需要显示的地方用 getModeDisplayName()，不要直接 setTitle(这个值)。
  return includeOff ? [["off", t("Off (transcription only)")], ...entries] : entries;
}

/**
 * 模板的界面显示名，跟随界面语言。
 *
 * MODE_META.label 是英文原文，同时是词条键（zh 表里有对应中文）；prefix 是中文前缀，
 * 写进笔记标题与文件名、供读取侧解析用，不参与界面显示。此前各处的做法不一致：
 * 侧栏模板下拉直接显示 label（中文界面下仍是英文），菜单与导入弹窗显示 prefix
 * （英文界面下仍是中文）。显示一律走这里，两种语言才对得上。
 */
export function getModeDisplayName(settings: ModeSettings | null | undefined, mode: string): string {
  const meta = getModeMeta(settings, mode);
  return t(meta.label || meta.prefix || mode);
}

export function setModePillIcon(el: HTMLElement, meta: ModePillInput | null | undefined, fallbackMeta?: ModePillInput | null): void {
  const source = meta || fallbackMeta || {};
  const fallback = fallbackMeta || {};
  const icon = source.icon || fallback.icon || "file-text";
  el.empty();
  el.addClass("is-lucide");
  try {
    obsidian.setIcon(el, icon);
  } catch {
    const label = source.prefix || source.label || fallback.prefix || fallback.label || "";
    el.setText(label ? label.trim().slice(0, 1) : "L");
  }
}
export function sanitizePromptTemplate(tpl: PromptTemplateInput | null | undefined, fallbackBaseMode: string | null | undefined): PromptTemplate {
  const now = new Date().toISOString();
  const clean = Object.assign({}, tpl || {}) as PromptTemplate;
  const rawId = stringifyModeValue(clean.id || "").trim();
  clean.id = rawId || makeCustomPromptModeId(clean.name || "scene");
  clean.mode = clean.id;
  clean.name = stringifyModeValue(clean.name || t("Custom prompt")).trim().slice(0, 80) || t("Custom prompt");
  clean.description = stringifyModeValue(clean.description || "").trim().slice(0, 240);
  const fallback = modeMetaByKey[fallbackBaseMode as keyof typeof MODE_META]
    ? fallbackBaseMode as keyof typeof MODE_META : "learning";
  clean.baseMode = modeMetaByKey[clean.baseMode as keyof typeof MODE_META]
    ? clean.baseMode : fallback;
  clean.prompt = stringifyModeValue(clean.prompt || "").trim();
  clean.isBuiltin = false;
  clean.customMode = true;
  clean.createdAt = clean.createdAt || now;
  clean.updatedAt = now;
  return clean;
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
