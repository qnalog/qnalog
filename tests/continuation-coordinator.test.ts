import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  TFile: class TFile {
    path: string;
    extension: string;
    constructor(path: string) { this.path = path; this.extension = path.split(".").pop() || ""; }
  },
  normalizePath: (path: string) => path,
}));
import * as obsidian from "obsidian";
import { ContinuationService } from "../src/session/continuation-service";
import type { RecordingSession } from "../src/shared/types";

describe("continuation target coordination", () => {
  it("tracks an active target session and serializes finalizers for that target", async () => {
    const target = new obsidian.TFile("meeting.md");
    const service = new ContinuationService({
      vault: {} as never,
      fileManager: {} as never,
      getSettings: () => ({ mdFolder: "QnALog", noteFileNameFormatNew: "YYYY-MM-DD HHmm", consolidatedLayout: false, polishMode: "synthesis" }),
      detectModeFromMarkdown: () => "synthesis",
      queueTasks: () => [],
      queueRecoveryEntries: () => [],
      addTask: async () => { throw new Error("unexpected queue write"); },
      removeTask: async () => undefined,
      scheduleTaskQueueRetry: () => undefined,
    });
    const session = { id: "session-a", continuation: undefined } as RecordingSession;
    service.trackSession(session, target);
    expect(service.hasActiveSessions(target)).toBe(true);
    expect(service.getTrackedSessionIds(target)).toEqual(["session-a"]);

    const order: string[] = [];
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>(resolve => { signalFirstStarted = resolve; });
    const first = service.runOnTarget(target, async () => {
      order.push("first-start");
      signalFirstStarted();
      await firstGate;
      order.push("first-end");
    });
    const second = service.runOnTarget(target, async () => { order.push("second"); });
    await firstStarted;
    expect(order).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
    service.releaseSession(session.id);
    expect(service.hasActiveSessions(target)).toBe(false);
  });
});
