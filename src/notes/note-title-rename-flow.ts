import * as obsidian from "obsidian";

export type NoteTitleRenameVault = Pick<obsidian.Vault, "getAbstractFileByPath">;

export interface NoteTitleRenameFlowHost {
  getAutoRenameWithTitle(): boolean;
  getVault(): NoteTitleRenameVault;
  generateTitleTag(polished: string, mode: string): Promise<string>;
  buildTargetPath(currentPath: string, mode: string, tag: string): string;
  findAvailableMarkdownPath(targetPath: string, currentPath: string): string;
  renameFile(file: obsidian.TFile, path: string): Promise<void>;
}

export async function renameMarkdownWithGeneratedTitleFlow(
  host: NoteTitleRenameFlowHost,
  fileOrPath: unknown,
  polished: string,
  mode: string,
): Promise<obsidian.TFile | null> {
  if (!host.getAutoRenameWithTitle() || !polished || mode === "off") return null;
  const file = typeof fileOrPath === "string"
    ? host.getVault().getAbstractFileByPath(fileOrPath)
    : fileOrPath;
  if (!(file instanceof obsidian.TFile)) return null;

  try {
    const tag = await host.generateTitleTag(polished, mode);
    if (!tag) return file;
    const target = host.buildTargetPath(file.path, mode, tag);
    const newPath = host.findAvailableMarkdownPath(target, file.path);
    if (!newPath || obsidian.normalizePath(newPath) === obsidian.normalizePath(file.path)) return file;
    await host.renameFile(file, newPath);
    const renamed = host.getVault().getAbstractFileByPath(newPath);
    return renamed instanceof obsidian.TFile ? renamed : file;
  } catch (error) {
    console.error("[QnALog] rename failed", error);
    return file;
  }
}
