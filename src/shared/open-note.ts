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

interface LineEditor {
  setCursor(pos: { line: number; ch: number }): void;
  scrollIntoView(range: { from: { line: number; ch: number }; to: { line: number; ch: number } }, center?: boolean): void;
}

function leafEditor(leaf: WorkspaceLeaf): LineEditor | null {
  const editor = (leaf.view as { editor?: Partial<LineEditor> | null }).editor;
  return editor && typeof editor.setCursor === "function" && typeof editor.scrollIntoView === "function"
    ? editor as LineEditor
    : null;
}

/**
 * Opens a note (reusing the tab that already shows it) and puts the cursor on a 0-based line,
 * scrolled to the middle of the view. Reading view scrolls to the line through the open state.
 */
export async function openFileAtLine(app: App, file: TFile, line: number): Promise<void> {
  const target = Math.max(0, Math.floor(line));
  const leaf = findOpenMarkdownLeaf(app.workspace.getLeavesOfType("markdown"), file.path) ?? app.workspace.getLeaf(true);
  await leaf.openFile(file, { active: true, eState: { line: target } });
  await app.workspace.revealLeaf(leaf);
  app.workspace.setActiveLeaf(leaf, { focus: true });
  const editor = leafEditor(leaf);
  if (!editor) return;
  const pos = { line: target, ch: 0 };
  editor.setCursor(pos);
  editor.scrollIntoView({ from: pos, to: pos }, true);
}
