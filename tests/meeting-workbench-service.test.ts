import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (path: string) => String(path || "").replace(/\\/g, "/") }));
import { MeetingWorkbenchService } from "../src/notes/meeting-workbench-service";
import type { RecordingSession } from "../src/shared/types";

function makeSession(): RecordingSession {
  return {
    id: "meeting-1",
    segments: [],
    mdPath: "QnALog/meeting.md",
    meetingWorkbench: { notes: "Keep this", draft: "unfinished", materials: [], entries: [] },
  } as RecordingSession;
}

function makeService(): MeetingWorkbenchService {
  return new MeetingWorkbenchService({} as never);
}

describe("MeetingWorkbenchService state operations", () => {
  it("normalizes for reading without writing and changes only the requested draft", () => {
    const session = makeSession();
    session.meetingWorkbench.entries = [{ id: "kept", text: "decision", atMs: 12 }];
    const service = makeService();

    const before = session.meetingWorkbench;
    expect(service.readWorkbench(session).entries[0]?.id).toBe("kept");
    expect(session.meetingWorkbench).toBe(before);

    service.setDraft(session, "new draft");
    expect(service.readWorkbench(session)).toMatchObject({ notes: "Keep this", draft: "new draft" });
  });

  it("creates timeline entries, marks metadata without AI work, and removes by identity", () => {
    const session = makeSession();
    const service = makeService();
    const question = service.addTextEntry(session, "? When is the review?", 1250);
    const todo = service.addTextEntry(session, "/ Prepare the report @Mina", 1800);
    const attachment = service.addMaterialEntry(session, [{ path: "QnALog/materials/slides.pdf", name: "slides.pdf", kind: "file", addedAt: "now" }], 2200, "file");

    expect(question).toMatchObject({ atMs: 1250, text: "? When is the review?", interaction: { kind: "question", status: "pending" } });
    expect(todo).toMatchObject({ interaction: { kind: "todo", status: "done", task: "Prepare the report", assignee: "Mina" } });
    expect(attachment).toMatchObject({ source: "material", materials: [{ path: "QnALog/materials/slides.pdf" }] });
    expect(service.removeEntry(session, String(todo?.id))).toBe(true);
    expect(service.removeEntry(session, String(todo?.id))).toBe(false);
    expect(service.readWorkbench(session).entries.map((entry) => entry.id)).toEqual([question?.id, attachment?.id]);
  });
});
