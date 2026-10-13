export interface MinutesKanbanFolderContents<T> {
  notes: T[];
  otherFileCount: number;
  childFolderCount: number;
}

export type MinutesKanbanFolderDeletePlan =
  | { allowed: false; reason: "root" | "other-content"; noteCount: number }
  | { allowed: true; kind: "empty"; noteCount: 0 }
  | { allowed: true; kind: "notes"; noteCount: number };

export interface MinutesKanbanFolderDeletePort<T> {
  inspectFolder(path: string): Promise<MinutesKanbanFolderContents<T>>;
  moveItem(item: T, folderPath: string): Promise<void>;
  deleteFolder(path: string): Promise<void>;
}

export function planMinutesKanbanFolderDeletion(
  path: string,
  rootPath: string,
  contents: Pick<MinutesKanbanFolderContents<unknown>, "notes" | "otherFileCount" | "childFolderCount">,
): MinutesKanbanFolderDeletePlan {
  if (path === rootPath) return { allowed: false, reason: "root", noteCount: contents.notes.length };
  if (contents.otherFileCount > 0 || contents.childFolderCount > 0) {
    return { allowed: false, reason: "other-content", noteCount: contents.notes.length };
  }
  if (contents.notes.length === 0) return { allowed: true, kind: "empty", noteCount: 0 };
  return { allowed: true, kind: "notes", noteCount: contents.notes.length };
}

export async function deleteMinutesKanbanFolder<T>(
  path: string,
  rootPath: string,
  port: MinutesKanbanFolderDeletePort<T>,
  expectedNoteCount: number,
): Promise<number> {
  const contents = await port.inspectFolder(path);
  const plan = planMinutesKanbanFolderDeletion(path, rootPath, contents);
  if (plan.allowed === false) throw new Error(plan.reason);
  if (plan.noteCount !== expectedNoteCount) throw new Error("folder-changed");

  if (plan.kind === "notes") {
    for (const item of contents.notes) await port.moveItem(item, rootPath);
  }

  const remaining = await port.inspectFolder(path);
  if (remaining.notes.length || remaining.otherFileCount || remaining.childFolderCount) {
    throw new Error("folder-not-empty");
  }
  await port.deleteFolder(path);
  return plan.noteCount;
}
