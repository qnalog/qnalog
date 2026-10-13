import * as obsidian from "obsidian";
import type { PluginSettings } from "../shared/types";
import { t } from "../shared/i18n";
import { ensureVaultFolder } from "../shared/util-vault";
import { formatVocabularyMarkdown, isStructuredVocabularyMarkdown, parseVocabularyGroups } from "./index";

type VocabularyFileSettings = Pick<PluginSettings, "vocabularyFile" | "industryProfile">;

export interface OpenVocabularyFileOptions {
  vault: Pick<obsidian.Vault, "getAbstractFileByPath" | "create" | "cachedRead" | "modify" | "createFolder">;
  workspace: Pick<obsidian.Workspace, "getLeaf">;
  getSettings: () => VocabularyFileSettings;
  notify: (message: string) => void;
  refreshStatus?: () => Promise<void> | void;
}

export async function openVocabularyFile(options: OpenVocabularyFileOptions): Promise<void> {
  const settings = options.getSettings();
  const rawPath = String(settings.vocabularyFile || "").trim();
  if (!rawPath) {
    options.notify(t("Please fill in the file path first"));
    return;
  }

  let path: string;
  try {
    path = obsidian.normalizePath(rawPath);
  } catch {
    options.notify(t("Invalid transcription glossary path"));
    return;
  }
  if (!path || path === "." || path === "/" || path.split("/").some((part) => part === "..")) {
    options.notify(t("Invalid transcription glossary path"));
    return;
  }

  try {
    let file = options.vault.getAbstractFileByPath(path);
    if (!(file instanceof obsidian.TFile)) {
      const folderPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (folderPath) await ensureVaultFolder({ vault: options.vault }, folderPath);
      file = await options.vault.create(path, formatVocabularyMarkdown([], settings.industryProfile));
      options.notify(`${t("Created:")}${path}`);
    }
    if (!(file instanceof obsidian.TFile)) {
      options.notify(t("Invalid transcription glossary path"));
      return;
    }

    const content = await options.vault.cachedRead(file);
    if (!isStructuredVocabularyMarkdown(content)) {
      await options.vault.modify(file, formatVocabularyMarkdown(parseVocabularyGroups(content), settings.industryProfile));
      options.notify(t("Organized into a sectioned hotword table"));
    }
    await options.refreshStatus?.();
    await options.workspace.getLeaf(false).openFile(file);
  } catch {
    options.notify(t("Invalid transcription glossary path"));
  }
}
