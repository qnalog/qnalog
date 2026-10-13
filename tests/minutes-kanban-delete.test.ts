import { describe, expect, it, vi } from "vitest";
import { deleteMinutesKanbanFolder, planMinutesKanbanFolderDeletion } from "../src/kanban/minutes-kanban-delete";

describe("minutes kanban folder deletion policy", () => {
  it("allows an empty non-root folder", () => {
    expect(planMinutesKanbanFolderDeletion("QnALog/Group", "QnALog", {
      notes: [], otherFileCount: 0, childFolderCount: 0,
    })).toEqual({ allowed: true, kind: "empty", noteCount: 0 });
  });

  it("allows moving only notes from a non-root folder", () => {
    expect(planMinutesKanbanFolderDeletion("QnALog/Group", "QnALog", {
      notes: [{ path: "QnALog/Group/a.md" }], otherFileCount: 0, childFolderCount: 0,
    })).toEqual({ allowed: true, kind: "notes", noteCount: 1 });
  });

  it("rejects a folder containing a child folder", () => {
    expect(planMinutesKanbanFolderDeletion("QnALog/Group", "QnALog", {
      notes: [], otherFileCount: 0, childFolderCount: 1,
    })).toEqual({ allowed: false, reason: "other-content", noteCount: 0 });
  });

  it("rejects a folder containing a non-note file", () => {
    expect(planMinutesKanbanFolderDeletion("QnALog/Group", "QnALog", {
      notes: [], otherFileCount: 1, childFolderCount: 0,
    })).toEqual({ allowed: false, reason: "other-content", noteCount: 0 });
  });

  it("rejects the root folder", () => {
    expect(planMinutesKanbanFolderDeletion("QnALog", "QnALog", {
      notes: [], otherFileCount: 0, childFolderCount: 0,
    })).toEqual({ allowed: false, reason: "root", noteCount: 0 });
  });

  it("moves notes sequentially, checks the folder again, then trashes it", async () => {
    const first = { path: "QnALog/Group/a.md" };
    const second = { path: "QnALog/Group/b.md" };
    const inspectFolder = vi.fn()
      .mockResolvedValueOnce({ notes: [first, second], otherFileCount: 0, childFolderCount: 0 })
      .mockResolvedValueOnce({ notes: [], otherFileCount: 0, childFolderCount: 0 });
    const moveItem = vi.fn(async () => undefined);
    const deleteFolder = vi.fn(async () => undefined);
    const port = { inspectFolder, moveItem, deleteFolder };
    await expect(deleteMinutesKanbanFolder("QnALog/Group", "QnALog", port, 2)).resolves.toBe(2);
    expect(moveItem.mock.calls).toEqual([[first, "QnALog"], [second, "QnALog"]]);
    expect(deleteFolder).toHaveBeenCalledWith("QnALog/Group");
  });

  it("stops after a move fails and keeps the folder", async () => {
    const note = { path: "QnALog/Group/a.md" };
    const inspectFolder = vi.fn().mockResolvedValue({ notes: [note], otherFileCount: 0, childFolderCount: 0 });
    const deleteFolder = vi.fn(async () => undefined);
    const port = {
      inspectFolder,
      moveItem: vi.fn(async () => { throw new Error("move failed"); }),
      deleteFolder,
    };
    await expect(deleteMinutesKanbanFolder("QnALog/Group", "QnALog", port, 1)).rejects.toThrow("move failed");
    expect(inspectFolder).toHaveBeenCalledOnce();
    expect(deleteFolder).not.toHaveBeenCalled();
  });

  it("stops before moving notes when the confirmed count changed", async () => {
    const note = { path: "QnALog/Group/a.md" };
    const inspectFolder = vi.fn().mockResolvedValue({ notes: [note], otherFileCount: 0, childFolderCount: 0 });
    const moveItem = vi.fn(async () => undefined);
    const port = { inspectFolder, moveItem, deleteFolder: vi.fn(async () => undefined) };
    await expect(deleteMinutesKanbanFolder("QnALog/Group", "QnALog", port, 2)).rejects.toThrow("folder-changed");
    expect(moveItem).not.toHaveBeenCalled();
  });
});
