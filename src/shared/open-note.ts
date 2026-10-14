import { normalizePath, type App, type TFile, type WorkspaceLeaf } from "obsidian";

/** The Markdown leaf that already shows `path`, or null when the note is not open. */
export function findOpenMarkdownLeaf(leaves: readonly WorkspaceLeaf[], path: string): WorkspaceLeaf | null {
  const target = normalizePath(path);
  return leaves.find((leaf) => {
    const file = (leaf.view as { file?: { path?: string } | null }).file;
    return !!file?.path && normalizePath(file.path) === target;
  }) ?? null;
}

/**
 * Opens a note in a new leaf, or reveals and focuses the leaf that already shows it,
 * so repeated clicks on the same topic or source note do not open duplicate tabs.
 */
export async function openOrRevealFile(app: App, file: TFile): Promise<void> {
  const existing = findOpenMarkdownLeaf(app.workspace.getLeavesOfType("markdown"), file.path);
  if (existing) {
    await app.workspace.revealLeaf(existing);
    app.workspace.setActiveLeaf(existing, { focus: true });
    return;
  }
  await app.workspace.getLeaf(true).openFile(file);
}
