import { getVisibleModeEntries, isKnownPolishMode } from "./mode-meta";
import { MODE_PREFIX_EN_TO_KEY, MODE_PREFIX_TO_KEY } from "./catalog-modes";
import { NS_TAG } from "./namespace";

type ModeSettingsInput = Parameters<typeof isKnownPolishMode>[0];
const prefixToKey = MODE_PREFIX_TO_KEY as Record<string, string>;
const englishPrefixToKey = MODE_PREFIX_EN_TO_KEY as Record<string, string>;
const stringifyModeLabel = String as (value: unknown) => string;

export function normalizeModeFromLabel(settings: ModeSettingsInput, label: unknown): string {
  const text = stringifyModeLabel(label || "").trim();
  if (!text) return "";
  if (isKnownPolishMode(settings, text)) return text;
  if (prefixToKey[text]) return prefixToKey[text];
  const normalized = text.replace(new RegExp(`^${NS_TAG}/`, "i"), "").trim();
  if (isKnownPolishMode(settings, normalized)) return normalized;
  if (prefixToKey[normalized]) return prefixToKey[normalized];
  // 界面语言为英文时写出的笔记标题用英文前缀，同样要能认回。
  if (englishPrefixToKey[text]) return englishPrefixToKey[text];
  if (englishPrefixToKey[normalized]) return englishPrefixToKey[normalized];
  for (const [mode, name] of getVisibleModeEntries(settings, false)) {
    if (text === name || normalized === name) return mode;
  }
  return "";
}
