import { MODE_PREFIX_EN_TO_KEY, MODE_PREFIX_TO_KEY } from "../shared/catalog-modes";
import { isKnownPolishMode, getVisibleModeEntries } from "../shared/mode-meta";
import { escapeRegExp } from "../shared/util-common";
import { normalizeModeFromLabel } from "../shared/mode-label";

type ModeSettingsInput = Parameters<typeof isKnownPolishMode>[0];
const stringifyRecentBasename = String as (value: unknown) => string;

export function stripRecentDatePrefix(basename: unknown): string {
  return stringifyRecentBasename(basename || "")
    .replace(/^\d{4}-\d{2}-\d{2}(?:\s+\d{4})?\s*/, "")
    .replace(/^[-·\s]+/, "")
    .trim();
}

export function getRecentModePrefixEntries(settings: ModeSettingsInput): [string, string][] {
  // 中英两种前缀都要认：同一篇笔记可能是在另一种界面语言下命名的，
  // 只认当前语言会让另一种前缀留在标题里，或让模式判定落空。
  const entries = Object.entries(MODE_PREFIX_TO_KEY).map(([prefix, mode]): [string, string] => [prefix, mode]);
  for (const [prefix, mode] of Object.entries(MODE_PREFIX_EN_TO_KEY)) entries.push([prefix, mode]);
  for (const [mode, label] of getVisibleModeEntries(settings, false)) entries.push([label, mode]);
  return entries
    .filter(([prefix, mode]) => prefix && mode && isKnownPolishMode(settings, mode))
    .sort((a, b) => String(b[0]).length - String(a[0]).length);
}

export function detectRecentModeFromFilename(settings: ModeSettingsInput, basename: unknown): string {
  const stem = stripRecentDatePrefix(basename);
  if (!stem) return "off";
  const inlineTag = stem.match(/(?:^|·\s*)(访谈|会议|研讨会|研讨|沙龙|小会|手记|学习记录|学习|个人笔记|工作纪要|学术研讨|主题沙龙|访谈调研|圆桌讨论)(?=$|[-·\s])/);
  if (inlineTag) return normalizeModeFromLabel(settings, inlineTag[1]) || "off";
  for (const [prefix, mode] of getRecentModePrefixEntries(settings)) {
    const re = new RegExp("^" + escapeRegExp(prefix) + "(?:[-·\\s]|$)");
    if (re.test(stem)) return mode;
  }
  return "off";
}
