import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"), TFile: class TFile {} }));
import * as obsidian from "obsidian";
import { nsMarkerLegacyVariants } from "../src/shared/namespace";
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
function makeVaultService(markdown: string) {
  const file = Object.assign(new obsidian.TFile(), { path: "QnALog/meeting.md" });
  const modify = vi.fn(async (_file: unknown, content: string) => { markdown = content; });
  const service = new MeetingWorkbenchService({
    app: {
      vault: {
        getAbstractFileByPath: vi.fn(() => file),
        read: vi.fn(async () => markdown),
        modify,
      },
    },
  } as never);
  return { service, modify, readSaved: () => markdown };
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
describe("MeetingWorkbenchService live transcript cleanup", () => {
  const oldStartMarker = nsMarkerLegacyVariants("live-start", "meeting-1")[0]!;
  const oldEndMarker = nsMarkerLegacyVariants("live-end", "meeting-1")[0]!;
  it("removes an old-marker block without dropping directly following body text", async () => {
    const markdown = [
      "KEEP_BEFORE",
      oldStartMarker,
      "transcript",
      oldEndMarker,
      "KEEP_AFTER_BLOCK",
      "",
    ].join("\n");
    const { service, modify, readSaved } = makeVaultService(markdown);

    await service.removeLiveTranscriptBlock("QnALog/meeting.md", "meeting-1");

    expect(readSaved()).toBe("KEEP_BEFORE\nKEEP_AFTER_BLOCK\n");
    expect(modify).toHaveBeenCalledTimes(1);
  });

  it("preserves a Unicode and multiline tail exactly and prefers the new markers", async () => {
    const markdown = [
      "KEEP_BEFORE",
      "<!-- qnalog-live-start:meeting-1 -->",
      "transcript",
      "<!-- qnalog-live-end:meeting-1 -->",
      "",
      "尾部 🌿",
      "第二行",
      "",
    ].join("\n");
    const { service, modify, readSaved } = makeVaultService(markdown);

    await service.removeLiveTranscriptBlock("QnALog/meeting.md", "meeting-1");

    expect(readSaved()).toBe("KEEP_BEFORE\n尾部 🌿\n第二行\n");
    expect(modify).toHaveBeenCalledTimes(1);
  });

  it("preserves another session and does not write when either required marker is missing", async () => {
    const markdown = [
      "KEEP_BEFORE",
      "<!-- qnalog-live-start:meeting-1 -->",
      "transcript",
      "<!-- qnalog-live-end:meeting-1 -->",
      "OTHER_SESSION",
      "<!-- qnalog-live-start:meeting-2 -->",
      "other transcript",
      "<!-- qnalog-live-end:meeting-2 -->",
      "KEEP_AFTER",
    ].join("\n");
    const { service, modify, readSaved } = makeVaultService(markdown);

    await service.removeLiveTranscriptBlock("QnALog/meeting.md", "meeting-1");

    expect(readSaved()).toBe("KEEP_BEFORE\nOTHER_SESSION\n<!-- qnalog-live-start:meeting-2 -->\nother transcript\n<!-- qnalog-live-end:meeting-2 -->\nKEEP_AFTER");
    expect(modify).toHaveBeenCalledTimes(1);

    const missingEnd = "KEEP\n<!-- qnalog-live-start:meeting-1 -->\ntranscript\n";
    const missingEndHarness = makeVaultService(missingEnd);
    await missingEndHarness.service.removeLiveTranscriptBlock("QnALog/meeting.md", "meeting-1");
    expect(missingEndHarness.readSaved()).toBe(missingEnd);
    expect(missingEndHarness.modify).not.toHaveBeenCalled();

    const missingStart = "KEEP\n<!-- qnalog-live-end:meeting-1 -->\n";
    const missingStartHarness = makeVaultService(missingStart);
    await missingStartHarness.service.removeLiveTranscriptBlock("QnALog/meeting.md", "meeting-1");
    expect(missingStartHarness.readSaved()).toBe(missingStart);
    expect(missingStartHarness.modify).not.toHaveBeenCalled();
  });
});
