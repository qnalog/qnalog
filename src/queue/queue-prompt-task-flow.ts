import * as obsidian from "obsidian";
import type { GeneratePromptQueueTaskPayload } from "../shared/types";
import { t } from "../shared/i18n";

export interface QueuePromptTaskPort {
  generateAndApplyIndustryPrompt(mode: string, options: { activate: boolean }): Promise<{ name: string }>;
  getSettingTab(): { display(): void } | null;
}

export async function runGeneratePromptTask(port: QueuePromptTaskPort, task: GeneratePromptQueueTaskPayload): Promise<void> {
  const mode = task.mode;
  if (!mode) throw new Error(t("Missing mode"));
  const tpl = await port.generateAndApplyIndustryPrompt(mode, { activate: task.activate !== false });
  const activated = task.activate !== false;
  new obsidian.Notice(activated
    ? t("Created custom prompt \"{0}\", and it has been set as the current default.").replace("{0}", tpl.name)
    : t("Created custom prompt \"{0}\".").replace("{0}", tpl.name), 7000);
  const tab = port.getSettingTab();
  if (tab) {
    try { tab.display(); } catch { /* intentionally empty */ }
  }
}
