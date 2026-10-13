import * as obsidian from "obsidian";
import type { PluginSettings } from "../shared/types";
import { t } from "../shared/i18n";
import { ensureVaultFolder } from "../shared/util-vault";
import { formatVocabularyMarkdown, isStructuredVocabularyMarkdown, parseVocabularyGroups } from "./index";

type VocabularyFileSettings = Pick<PluginSettings, "vocabularyFile" | "industryProfile">;

export interface OpenVocabularyFileOptions {
  vault: Pick<obsidian.Vault, "getAbstractFileByPath" | "create" | "cachedRead" | "modify" | "createFolder">;
  workspace: Pick<obsidian.Workspace, "getLeaf" | "getLeavesOfType" | "setActiveLeaf" | "revealLeaf"> & {
    iterateAllLeaves?: (callback: (leaf: obsidian.WorkspaceLeaf) => void) => void;
  };
  getSettings: () => VocabularyFileSettings;
  notify: (message: string) => void;
  refreshStatus?: () => Promise<void> | void;
}

const openingByWorkspace = new WeakMap<object, Map<string, Promise<void>>>();

function findOpenVocabularyLeaf(workspace: OpenVocabularyFileOptions["workspace"], path: string): obsidian.WorkspaceLeaf | null {
  const leaves = workspace.getLeavesOfType("markdown");
  const matchesPath = (leaf: obsidian.WorkspaceLeaf): boolean => {
    const filePath = (leaf.view as { file?: { path?: string } | null }).file?.path;
    return !!filePath && obsidian.normalizePath(filePath) === path;
  };
  let existing = leaves.find(matchesPath);
  if (!existing && workspace.iterateAllLeaves) {
    workspace.iterateAllLeaves((leaf) => {
      if (!existing && matchesPath(leaf)) existing = leaf;
    });
  }
  return existing ?? null;
}

async function openOrFocusVocabularyFile(workspace: OpenVocabularyFileOptions["workspace"], file: obsidian.TFile): Promise<void> {
  const existing = findOpenVocabularyLeaf(workspace, file.path);
  if (existing) {
    await workspace.revealLeaf(existing);
    workspace.setActiveLeaf(existing, { focus: true });
    return;
  }
  await workspace.getLeaf(false).openFile(file);
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

  let workspaceTasks = openingByWorkspace.get(options.workspace);
  if (!workspaceTasks) {
    workspaceTasks = new Map();
    openingByWorkspace.set(options.workspace, workspaceTasks);
  }
  const pending = workspaceTasks.get(path);
  if (pending !== undefined) {
    await pending;
    return;
  }

  const operation = openVocabularyFileAtPath(options, path, settings);
  workspaceTasks.set(path, operation);
  try {
    await operation;
  } finally {
    if (workspaceTasks.get(path) === operation) workspaceTasks.delete(path);
  }
}

async function openVocabularyFileAtPath(
  options: OpenVocabularyFileOptions,
  path: string,
  settings: VocabularyFileSettings,
): Promise<void> {
  try {
    let file = options.vault.getAbstractFileByPath(path);
    if (!(file instanceof obsidian.TFile)) {
      const folderPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (folderPath) await ensureVaultFolder({ vault: options.vault }, folderPath);
      file = await options.vault.create(path, formatVocabularyMarkdown([], settings.industryProfile));
      options.notify(`${t("Created:")}${path}`);
    }
    if (!(file instanceof obsidian.TFile)) {
      throw new Error("Vault did not return a Markdown file");
    }

    const content = await options.vault.cachedRead(file);
    if (!isStructuredVocabularyMarkdown(content)) {
      await options.vault.modify(file, formatVocabularyMarkdown(parseVocabularyGroups(content), settings.industryProfile));
      options.notify(t("Organized into a sectioned hotword table"));
    }
    await options.refreshStatus?.();
    await openOrFocusVocabularyFile(options.workspace, file);
  } catch (error) {
    const message = error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message || error)
      : String(error);
    options.notify(t("Open transcription glossary failed: {0}").replace("{0}", message));
  }
}
