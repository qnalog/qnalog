import * as obsidian from "obsidian";
import { MODE_META, MODE_PREFIX_EN_TO_KEY, MODE_PREFIX_TO_KEY } from "../shared/catalog-modes";
import { getCustomPromptModeTemplates, getModeMeta, getModePrefix } from "../shared/mode-meta";
import { escapeRegExp, sanitizeFilename } from "../shared/util-common";

type ModeSettingsInput = Parameters<typeof getCustomPromptModeTemplates>[0];
const stringifyTitleValue = String as (value: unknown) => string;

export function stripAutoTitleSuffix(stem: unknown, settings: ModeSettingsInput): string {
  // 中英两种前缀都要剥：同一篇笔记可能在不同语言下被重命名过，
  // 只认一种会让另一种残留，后缀越叠越长。
  const prefixes = Object.values(MODE_META)
    .flatMap((m) => [sanitizeFilename(m && m.prefix), sanitizeFilename(m && m.label)])
    .concat(getCustomPromptModeTemplates(settings || {}).map((template) => sanitizeFilename(template.name)))
    .filter(Boolean);
  const unique = Array.from(new Set(prefixes)).sort((a, b) => b.length - a.length);
  if (!unique.length) return stringifyTitleValue(stem || "").trim();
  const re = new RegExp("\\s*·\\s*(?:" + unique.map(escapeRegExp).join("|") + ")-[^·/\\\\]+$");
  return stringifyTitleValue(stem || "").replace(re, "").trim();
}

/**
 * 去掉标题开头的模板名前缀（含历史别名与另一种语言的前缀），保留其后的主题标签。
 *
 * 与 stripAutoTitleSuffix 的区别：后者连主题一起剥掉，用于重命名前取回纯日期 stem；
 * 这里只剥前缀，用于「日期 · 主题」这类标题显示。
 */
export function stripModePrefixFromTitle(title: unknown, settings: ModeSettingsInput): string {
  let out = stringifyTitleValue(title || "").trim();
  const prefixes = Object.entries(MODE_PREFIX_TO_KEY).map(([prefix]): string | undefined => prefix)
    .concat(Object.keys(MODE_PREFIX_EN_TO_KEY))
    .concat(getCustomPromptModeTemplates(settings || {}).map((template) => template.name))
    .map((prefix) => stringifyTitleValue(prefix || "").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  // 前缀可能出现在行首，也可能跟在一个分隔符之后（`2026-09-16 0852 · 个人笔记-主题`）。
  for (const prefix of prefixes) {
    const atStart = new RegExp("^" + escapeRegExp(prefix) + "[-·\\s]+");
    const afterSep = new RegExp("(\\s*[·•]\\s*)" + escapeRegExp(prefix) + "[-·\\s]*");
    if (atStart.test(out)) { out = out.replace(atStart, "").trim(); break; }
    if (afterSep.test(out)) { out = out.replace(afterSep, "$1"); break; }
  }
  return out;
}

export function buildRenamedMarkdownPath(
  currentPath: unknown,
  mode: string,
  titleTag: unknown,
  settings: ModeSettingsInput,
): string {
  const norm = obsidian.normalizePath(stringifyTitleValue(currentPath || ""));
  const slash = norm.lastIndexOf("/");
  const dir = slash >= 0 ? norm.slice(0, slash) : "";
  const name = slash >= 0 ? norm.slice(slash + 1) : norm;
  const stem = stripAutoTitleSuffix(name.replace(/\.md$/i, ""), settings);
  const meta = getModeMeta(settings, mode);
  // 文件名与界面标题一致，随界面语言；两种前缀在读取时都能解析回同一 mode。
  const modePrefixFallback = "\u81ea\u5b9a\u4e49";
  const modePrefix = sanitizeFilename(getModePrefix(meta) || modePrefixFallback) || modePrefixFallback;
  const tag = sanitizeFilename(titleTag) || "";
  if (!stem || !tag) return "";
  const nextName = `${stem} · ${modePrefix}-${tag}.md`;
  return obsidian.normalizePath(dir ? `${dir}/${nextName}` : nextName);
}
