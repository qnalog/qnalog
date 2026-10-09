import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
  Notice: class Notice {},
  requestUrl: vi.fn(async () => ({ status: 200, text: "{}" })),
}));

import { QueueRetryService } from "../src/queue/queue-retry-service";
import { t } from "../src/shared/i18n";
import { migrateTaskPaths, removeTasksForDeletedPath } from "../src/queue/queue-task-paths";

function fixture() {
  const saveAll = vi.fn();
  const saveSettings = vi.fn();
  const requestOutlineRefresh = vi.fn();
  const queue = { tasks: [] as Array<Record<string, unknown> | null> };
  const service = new QueueRetryService({ queue, saveAll, saveSettings, requestOutlineRefresh } as never);
  return { service, queue, saveAll, saveSettings, requestOutlineRefresh };
}


describe("strict queue path helpers", () => {
  it("applies path rewrites and deletion preservation in the strict-core helpers", () => {
    const task = { type: "merge", mdPath: "Notes/old.md", temporarySourcePath: "Notes/old.md", continuation: { targetPath: "Notes/old.md" }, sourceMdPath: "Notes/old.md" };
    expect(migrateTaskPaths([task] as never, "Notes/old.md", "Notes/new.md")).toBe(3);
    expect(task).toEqual({
      type: "merge",
      mdPath: "Notes/new.md",
      temporarySourcePath: "Notes/new.md",
      continuation: { targetPath: "Notes/new.md" },
      sourceMdPath: "Notes/new.md",
    });
    const generated = { type: "generate-prompt", mdPath: "Notes/safe.md", temporarySourcePath: "Notes/deleted.md" };
    const result = removeTasksForDeletedPath([generated, null] as never, "Notes/deleted.md");
    expect(result).toMatchObject({ tasks: [generated], removed: 1, preservedContinuation: false });
    const continuation = { type: "merge", mdPath: "Notes/safe.md", continuation: { targetPath: "Notes/deleted.md" }, status: "failed" };
    const preserved = removeTasksForDeletedPath([continuation] as never, "Notes/deleted.md");
    expect(preserved).toMatchObject({ tasks: [continuation], removed: 0, preservedContinuation: true });
    expect(continuation).toMatchObject({
      status: "missing",
      lastError: t("The target or separate recording file was deleted; the remaining recovery material was kept."),
    });
  });
});

describe("queue task path changes", () => {
  it("renames typed paths, rewrites the legacy source path without counting it, and saves once", () => {
    const { service, queue, saveAll } = fixture();
    queue.tasks = [
      { type: "transcribe", mdPath: "Notes/old.md" },
      { type: "merge", mdPath: "Notes/other.md", temporarySourcePath: "Notes/old.md", continuation: { targetPath: "Notes\\old.md" } },
      { type: "merge", mdPath: "Notes/other.md", sourceMdPath: "Notes/old.md" },
    ];
    service.migrateQueueTasksAfterRename("Notes\\old.md", "Notes/new.md");
    expect(queue.tasks).toEqual([
      { type: "transcribe", mdPath: "Notes/new.md" },
      { type: "merge", mdPath: "Notes/other.md", temporarySourcePath: "Notes/new.md", continuation: { targetPath: "Notes/new.md" } },
      { type: "merge", mdPath: "Notes/other.md", sourceMdPath: "Notes/new.md" },
    ]);
    expect(saveAll).toHaveBeenCalledTimes(1);
  });

  it("does not save for legacy-only changes or normalized no-op and empty paths", () => {
    const { service, queue, saveAll } = fixture();
    queue.tasks = [{ type: "merge", mdPath: "Notes/other.md", sourceMdPath: "Notes/old.md" }];
    service.migrateQueueTasksAfterRename("Notes/old.md", "Notes/new.md");
    service.migrateQueueTasksAfterRename("Notes\\old.md", "Notes/old.md");
    service.migrateQueueTasksAfterRename("", "Notes/new.md");
    service.migrateQueueTasksAfterRename("Notes/old.md", "");
    expect(queue.tasks[0]?.sourceMdPath).toBe("Notes/new.md");
    expect(saveAll).not.toHaveBeenCalled();
  });

  it("uses saveSettings when saveAll is unavailable and swallows synchronous save failures", () => {
    const { service, queue, saveSettings } = fixture();
    queue.tasks = [{ type: "transcribe", mdPath: "old.md" }];
    (service as unknown as { host: Record<string, unknown> }).host.saveAll = undefined;
    service.migrateQueueTasksAfterRename("old.md", "new.md");
    expect(saveSettings).toHaveBeenCalledTimes(1);

    const next = fixture();
    next.queue.tasks = [{ type: "transcribe", mdPath: "old.md" }];
    (next.service as unknown as { host: { saveAll: () => void } }).host.saveAll = () => { throw new Error("save"); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => next.service.migrateQueueTasksAfterRename("old.md", "new.md")).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("removes deleted targets, retains continuation recovery material, and refreshes only on changes", () => {
    const { service, queue, saveAll, requestOutlineRefresh } = fixture();
    queue.tasks = [
      { type: "transcribe", mdPath: "Notes/deleted.md" },
      { type: "merge", mdPath: "Notes/other.md", temporarySourcePath: "Notes/deleted.md" },
      { type: "generate-prompt", mdPath: "Notes/deleted.md", temporarySourcePath: "Notes/deleted.md" },
      { type: "merge", mdPath: "Notes/other.md", continuation: { targetPath: "Notes/deleted.md" }, status: "failed" },
      null,
      { type: "transcribe", mdPath: "Notes/safe.md" },
    ];
    service.removeQueueTasksForDeletedMarkdown("Notes/deleted.md");
    expect(queue.tasks).toHaveLength(2);
    expect(queue.tasks[0]).toMatchObject({ type: "merge", status: "missing", lastError: t("The target or separate recording file was deleted; the remaining recovery material was kept.") });
    expect(queue.tasks[1]).toMatchObject({ type: "transcribe", mdPath: "Notes/safe.md" });
    expect(saveAll).toHaveBeenCalledTimes(1);
    expect(requestOutlineRefresh).toHaveBeenCalledTimes(1);

    const clean = fixture();
    clean.queue.tasks = [{ type: "transcribe", mdPath: "Notes/safe.md" }];
    clean.service.removeQueueTasksForDeletedMarkdown("");
    clean.service.removeQueueTasksForDeletedMarkdown("Notes/deleted.md");
    expect(clean.saveAll).not.toHaveBeenCalled();
    expect(clean.requestOutlineRefresh).not.toHaveBeenCalled();
  });

  it("retains a continuation when either its markdown or temporary source is deleted and swallows refresh errors", () => {
    const { service, queue, saveAll, requestOutlineRefresh } = fixture();
    queue.tasks = [
      { type: "merge", mdPath: "Notes/deleted.md", continuation: { targetPath: "Notes/target.md" }, status: "failed" },
      { type: "merge", mdPath: "Notes/target.md", temporarySourcePath: "Notes/deleted.md", continuation: { targetPath: "Notes/target.md" }, status: "failed" },
    ];
    requestOutlineRefresh.mockImplementation(() => { throw new Error("refresh"); });
    expect(() => service.removeQueueTasksForDeletedMarkdown("Notes/deleted.md")).not.toThrow();
    expect(queue.tasks).toHaveLength(2);
    expect(queue.tasks.every(task => task?.status === "missing")).toBe(true);
    expect(saveAll).toHaveBeenCalledTimes(1);
    expect(requestOutlineRefresh).toHaveBeenCalledTimes(1);
  });
});
