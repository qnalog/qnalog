import * as obsidian from "obsidian";
import type { QueueTask } from "../shared/types";
import { t } from "../shared/i18n";

export interface QueueTaskPathPort {
  getQueue(): { tasks: unknown } | null;
  save(): unknown;
  requestOutlineRefresh(): void;
}

export function migrateQueueTasksAfterRename(port: QueueTaskPathPort, oldPath: string, newPath: string): void {
  const queue = port.getQueue();
  if (!queue || !Array.isArray(queue.tasks)) return;
  const migrated = migrateTaskPaths(queue.tasks as (QueueTask | null | undefined)[], oldPath, newPath);
  if (migrated > 0) {
    try { void port.save(); } catch (e) {
      console.warn("[QnALog] queue migrate save failed", e);
    }
  }
}

export function removeQueueTasksForDeletedMarkdown(port: QueueTaskPathPort, path: string): void {
  const queue = port.getQueue();
  if (!queue || !Array.isArray(queue.tasks)) return;
  const result = removeTasksForDeletedPath(queue.tasks as (QueueTask | null | undefined)[], path);
  if (!result) return;
  queue.tasks = result.tasks;
  if (result.removed > 0 || result.preservedContinuation) {
    try { void port.save(); } catch (e) {
      console.warn("[QnALog] queue delete cleanup save failed", e);
    }
    try { port.requestOutlineRefresh(); } catch { /* intentionally empty */ }
  }
}

function coercePath(value: unknown): string {
  // Retain the coercion used by the previous dynamic queue implementation.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve legacy String coercion for unknown queue paths
  return String(value || "");
}

export function migrateTaskPaths(tasks: readonly (QueueTask | null | undefined)[], oldPath: unknown, newPath: unknown): number {
  const oldNorm = obsidian.normalizePath(coercePath(oldPath));
  const newNorm = obsidian.normalizePath(coercePath(newPath));
  if (!oldNorm || !newNorm || oldNorm === newNorm) return 0;
  let migrated = 0;
  for (const task of tasks) {
    if (!task) continue;
    if (task.mdPath && obsidian.normalizePath(task.mdPath) === oldNorm) {
      task.mdPath = newNorm;
      migrated++;
    }
    const temporarySourcePath = task.type === "generate-prompt" ? "" : task.temporarySourcePath;
    if ((task.type === "merge" || task.type === "transcribe")
      && temporarySourcePath && obsidian.normalizePath(temporarySourcePath) === oldNorm) {
      task.temporarySourcePath = newNorm;
      migrated++;
    }
    if (task.type === "merge" && task.continuation
      && obsidian.normalizePath(task.continuation.targetPath) === oldNorm) {
      task.continuation.targetPath = newNorm;
      migrated++;
    }
    const legacyTask = task as QueueTask & { sourceMdPath?: unknown };
    if ("sourceMdPath" in task && typeof legacyTask.sourceMdPath === "string" && obsidian.normalizePath(legacyTask.sourceMdPath) === oldNorm) {
      legacyTask.sourceMdPath = newNorm;
    }
  }
  return migrated;
}

export function removeTasksForDeletedPath(
  tasks: readonly (QueueTask | null | undefined)[],
  path: unknown,
): { tasks: QueueTask[]; removed: number; preservedContinuation: boolean } | null {
  const norm = obsidian.normalizePath(coercePath(path));
  if (!norm) return null;
  let preservedContinuation = false;
  const kept = tasks.filter((task): task is QueueTask => {
    if (!task) return false;
    const continuation = task.type === "merge" ? task.continuation : undefined;
    const temporarySourcePath = task.type === "generate-prompt" ? "" : task.temporarySourcePath;
    const referencesPath = (task.mdPath && obsidian.normalizePath(task.mdPath) === norm)
      || (temporarySourcePath && obsidian.normalizePath(temporarySourcePath) === norm)
      || (continuation && obsidian.normalizePath(continuation.targetPath) === norm);
    const continuationTask = task.type === "merge" && !!continuation;
    if (continuationTask && referencesPath) {
      task.status = "missing";
      task.lastError = t("The target or separate recording file was deleted; the remaining recovery material was kept.");
      preservedContinuation = true;
      return true;
    }
    return !referencesPath;
  });
  return { tasks: kept, removed: tasks.length - kept.length, preservedContinuation };
}
