/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。
import * as obsidian from "obsidian";
import { MODE_META } from './catalog-modes';

export const STANDARD_POLISH_MODES = ["synthesis", "meeting", "seminar", "interview", "monologue", "learning"];

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

export function isKnownPolishMode(settings, mode) {
  if (mode === "off") return true;
  return !!(MODE_META[mode] || getCustomPromptModeTemplate(settings, mode));
}

export function isCustomPromptModeTemplate(t: unknown): t is CustomPromptModeTemplate {
  if (!t || typeof t !== "object") return false;
  const item = t as Partial<CustomPromptModeTemplate>;
  return !!(item.customMode === true && typeof item.id === "string" && typeof item.mode === "string" && item.id === item.mode);
}

export function makeCustomPromptModeId(seed) {
  const slug = String(seed || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return "custom-" + (slug || Date.now().toString(36)) + "-" + Math.random().toString(36).slice(2, 6);
}

export function getCustomPromptModeTemplate(settings, mode) {
  const tpls = settings && settings.promptTemplates && typeof settings.promptTemplates === "object" ? settings.promptTemplates : {};
  const t = tpls[mode];
  return isCustomPromptModeTemplate(t) ? t : null;
}

export function getCustomPromptModeTemplates(settings) {
  const tpls = settings && settings.promptTemplates && typeof settings.promptTemplates === "object" ? settings.promptTemplates : {};
  return Object.values(tpls)
    .filter(isCustomPromptModeTemplate)
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh"));
}

export function getBuiltInVisiblePolishModeKeys(settings) {
  void settings;
  return STANDARD_POLISH_MODES.slice();
}

export function getVisiblePolishModeKeys(settings) {
  const custom = getCustomPromptModeTemplates(settings).map((t) => t.id);
  return [...getBuiltInVisiblePolishModeKeys(settings), ...custom];
}

export function getModeMeta(settings, mode) {
  if (MODE_META[mode]) return MODE_META[mode];
  const custom = getCustomPromptModeTemplate(settings, mode);
  if (custom) {
    const name = custom.name || "自定义提示词";
    return { prefix: name, emoji: "🧩", icon: "puzzle", label: "自定义提示词：" + name, goal: custom.description || "用户自定义提示词。", baseMode: custom.baseMode || "learning", custom: true };
  }
  return MODE_META.meeting;
}

/** 解析生效的纪要模式：requested 优先，其次设置里的 polishMode，最后用 fallback（默认 meeting）。 */
export function getEffectivePolishMode(settings, requested, fallback = null) {
  const fb = fallback == null ? "meeting" : fallback;
  const mode = requested || (settings && settings.polishMode) || fb;
  if (mode === "off") return mode;
  if (isKnownPolishMode(settings, mode)) return mode;
  return fb;
}

export function getVisibleModeEntries(settings, includeOff) {
  const entries = getVisiblePolishModeKeys(settings).map((key) => [key, getModeMeta(settings, key).prefix]);
  return includeOff ? [["off", "关闭，仅转写"], ...entries] : entries;
}

export function setModePillIcon(el, meta, fallbackMeta) {
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

export function sanitizePromptTemplate(tpl, fallbackBaseMode) {
  const now = new Date().toISOString();
  const clean = Object.assign({}, tpl || {});
  const rawId = String(clean.id || "").trim();
  clean.id = rawId || makeCustomPromptModeId(clean.name || "scene");
  clean.mode = clean.id;
  clean.name = String(clean.name || "自定义提示词").trim().slice(0, 80) || "自定义提示词";
  clean.description = String(clean.description || "").trim().slice(0, 240);
  const fallback = MODE_META[fallbackBaseMode] ? fallbackBaseMode : "learning";
  clean.baseMode = MODE_META[clean.baseMode] ? clean.baseMode : fallback;
  clean.prompt = String(clean.prompt || "").trim();
  clean.isBuiltin = false;
  clean.customMode = true;
  clean.createdAt = clean.createdAt || now;
  clean.updatedAt = now;
  return clean;
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
