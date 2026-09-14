import * as obsidian from "obsidian";

/**
 * 逐级创建知识库内的文件夹；已存在的层级跳过。
 * 只依赖 app，因此是纯函数，不挂在插件对象上。
 */
export async function ensureVaultFolder(app: obsidian.App, folderPath: string): Promise<void> {
  const norm = obsidian.normalizePath(String(folderPath || "").trim());
  if (!norm || norm === "." || norm === "/") return;
  const parts = norm.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(cur);
    if (!existing) {
      try { await app.vault.createFolder(cur); } catch { /* intentionally empty */ }
    }
  }
}

/**
 * 目标路径被占用时依次追加 -2、-3…；尝试 99 次仍冲突则返回空串（调用方按失败处理）。
 */
export function findAvailableVaultPath(app: obsidian.App, targetPath: string): string {
  let candidate = obsidian.normalizePath(targetPath || "");
  if (!candidate) return "";
  const dot = candidate.lastIndexOf(".");
  const base = dot >= 0 ? candidate.slice(0, dot) : candidate;
  const ext = dot >= 0 ? candidate.slice(dot) : "";
  let i = 2;
  while (app.vault.getAbstractFileByPath(candidate)) {
    candidate = obsidian.normalizePath(`${base}-${i}${ext}`);
    i++;
    if (i > 99) return "";
  }
  return candidate;
}

  /**
 * 目标 Markdown 路径被占用时依次追加 -2、-3…；currentPath 指向的文件不算占用（自己改自己的名）。
 * 尝试 99 次仍冲突则返回空串，调用方按失败处理。
 */
export function findAvailableMarkdownPath(app: obsidian.App, targetPath: string, currentPath?: string): string {
    const current = obsidian.normalizePath(currentPath || "");
    let candidate = obsidian.normalizePath(targetPath || "");
    if (!candidate || candidate === current) return candidate;
    const dot = candidate.toLowerCase().endsWith(".md") ? candidate.length - 3 : candidate.length;
    const base = candidate.slice(0, dot);
    const ext = candidate.slice(dot) || ".md";
    let i = 2;
    while (true) {
      const existing = app.vault.getAbstractFileByPath(candidate);
      if (!existing || obsidian.normalizePath(existing.path) === current) return candidate;
      candidate = obsidian.normalizePath(`${base}-${i}${ext}`);
      i++;
      if (i > 99) return "";
    }
  }
