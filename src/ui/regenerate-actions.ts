import * as obsidian from "obsidian";
import { t } from "../shared/i18n";
import type { PluginSettings } from "../shared/types";
import { getModeDisplayName, getVisibleModeEntries } from "../shared/mode-meta";
import { getRepolishPreferencePreset } from "../prompts/briefing-prompts";
import { extractTranscriptSegments } from "../notes/note-transcript-ledger";
import { qnalogConfirm } from "./helpers";

// 两个重新生成动作的共用入口：「重新整理」改写这篇笔记，「另存为新版本」不动这篇笔记。
// 笔记列表右键子菜单与命令面板都经这里，模式与偏好的选择方式保持一致。

/** 子菜单里可勾选的整理偏好；与侧栏历史上暴露的集合相同。 */
export const REGENERATE_PREFERENCE_KEYS = ["detailed", "concise", "structured", "natural", "expanded"] as const;

/** 整理偏好预设（`prompts/briefing-prompts.ts` 的 REPOLISH_PREFERENCE_PRESETS 条目加上 key）。 */
export type RegeneratePreference = { key: string; label: string } & Record<string, unknown>;

/** 按 key 取偏好预设；该模块无类型，在这里收窄。 */
export function getRegeneratePreference(key: string): RegeneratePreference | null {
  const preset: unknown = getRepolishPreferencePreset(key);
  if (!preset || typeof preset !== "object") return null;
  const record = preset as Record<string, unknown>;
  return typeof record.label === "string" ? { ...record, key, label: record.label } : null;
}

export interface RegenerateActionsPort {
  app: obsidian.App;
  settings: Pick<PluginSettings, "repolishPreference" | "promptTemplates" | "activeTemplateByMode" | "polishMode">;
  saveSettings(): Promise<void>;
  /** 笔记当前的模式；无法判断时返回 null。 */
  detectNoteMode(file: obsidian.TFile): string | null;
  reorganizeNoteInPlace(file: obsidian.TFile, options: { mode?: string; preference?: unknown }): Promise<boolean>;
  saveAsNewVersion(file: obsidian.TFile, mode: string, preference: RegeneratePreference | null): Promise<boolean>;
}

/** 当前勾选的偏好（设置里记住的上次选择）。 */
export function currentRegeneratePreference(port: Pick<RegenerateActionsPort, "settings">): RegeneratePreference | null {
  const key = port.settings.repolishPreference || "";
  return key ? getRegeneratePreference(key) : null;
}

/** 模式列表：笔记自己的模式排第一。 */
export function orderedRegenerateModes(settings: RegenerateActionsPort["settings"], noteMode: string | null): string[] {
  const modes = getVisibleModeEntries(settings, false).map(([mode]) => mode);
  if (!noteMode || !modes.includes(noteMode)) return modes;
  return [noteMode, ...modes.filter((mode) => mode !== noteMode)];
}

/**
 * 「重新整理」：笔记里有原始转写时先确认；没有时直接交给整理流程，由它询问并用录音重新转写。
 */
export async function confirmAndReorganize(
  port: RegenerateActionsPort, file: obsidian.TFile, options: { mode?: string; preference?: unknown } = {},
): Promise<boolean> {
  const markdown = await port.app.vault.cachedRead(file);
  if (extractTranscriptSegments(markdown).length) {
    const confirmed = await qnalogConfirm(
      port.app,
      t("Reorganize this note"),
      t("This will regenerate this note's organized body in the note's own mode and replace the current content. Before writing, the current note is saved to QnALog's hidden version folder (.versions). The original transcript stays unchanged."),
      t("Reorganize"),
    );
    if (!confirmed) return false;
  }
  return port.reorganizeNoteInPlace(file, options);
}

/**
 * 子菜单：模式列表（笔记自己的模式在前并打勾）+ 分隔线 + 可勾选的偏好。
 * 点偏好只切换勾选、菜单不关；点模式才执行 `onPick(mode, preference)`。
 */
export function fillModePreferenceMenu(
  sub: obsidian.Menu,
  port: Pick<RegenerateActionsPort, "settings" | "saveSettings">,
  noteMode: string | null,
  onPick: (mode: string, preference: RegeneratePreference | null) => void,
): void {
  for (const mode of orderedRegenerateModes(port.settings, noteMode)) {
    sub.addItem((item) => {
      item.setTitle(getModeDisplayName(port.settings, mode))
        .setChecked(mode === noteMode)
        .onClick(() => onPick(mode, currentRegeneratePreference(port)));
    });
  }
  sub.addSeparator();
  const prefItems: Array<[string, obsidian.MenuItem]> = [];
  const syncChecks = () => {
    const current = port.settings.repolishPreference || "";
    for (const [key, item] of prefItems) item.setChecked(current === key);
  };
  for (const key of REGENERATE_PREFERENCE_KEYS) {
    const preset = getRegeneratePreference(key);
    if (!preset) continue;
    sub.addItem((item) => {
      item.setTitle(t(preset.label)).setChecked((port.settings.repolishPreference || "") === key);
      prefItems.push([key, item]);
      // 捕获阶段拦掉点击，阻止 Obsidian 关闭菜单；勾选就地更新。
      const dom = (item as unknown as { dom?: HTMLElement }).dom;
      dom?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        port.settings.repolishPreference = (port.settings.repolishPreference || "") === key ? "" : key;
        void port.saveSettings();
        syncChecks();
      }, true);
    });
  }
}
