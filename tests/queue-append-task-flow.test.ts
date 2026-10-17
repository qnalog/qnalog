import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => {
  const yaml = await import("yaml");
  return {
    TFile: class TFile { path: string; basename: string; constructor(path: string) { this.path = path; this.basename = path.split("/").pop()?.replace(/\.md$/, "") || ""; } },
    TFolder: class TFolder { path: string; constructor(path: string) { this.path = path; } },
    Notice: class Notice {},
    normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
    parseYaml: (text: string) => yaml.parse(text),
    stringifyYaml: (value: unknown) => yaml.stringify(value),
  };
});
const { mergeMock, clearMock } = vi.hoisted(() => ({ mergeMock: vi.fn(), clearMock: vi.fn(async () => undefined) }));
vi.mock("../src/briefing/merge-pipeline", () => ({ mergeAndPolish: mergeMock }));
vi.mock("../src/prompts/briefing-prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/prompts/briefing-prompts")>()),
  clearCommittedBriefingCheckpoint: clearMock,
}));

import * as obsidian from "obsidian";
import { QueueRetryService } from "../src/queue/queue-retry-service";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import { serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
import type { Segment } from "../src/shared/types";
import { postProcessBriefingOutput } from "../src/notes/note-briefing-output";
import { appendPolishNoteContent, prepareNotePolishParts } from "../src/notes/note-write-content";

afterEach(() => { vi.unstubAllGlobals(); mergeMock.mockReset(); clearMock.mockReset().mockResolvedValue(undefined); });
const targetPath = "Minutes/target.md";
const stagePath = "Minutes/stage.md";
function segment(index = 0, sourceId = "session"): Segment {
  return attachTextTranscript({ index, startOffsetMs: index * 1000, endOffsetMs: (index + 1) * 1000, audioStartOffsetMs: 0, audioEndOffsetMs: 1000, audioName: "s.webm", audioPath: "s.webm", text: "new transcript" }, sourceId, "text-import");
}
function setup(options: { targetText?: string; stageText?: string; task?: Record<string, unknown>; tracked?: string[]; active?: boolean; dependencyTasks?: unknown[]; recovery?: unknown[]; stageKind?: "file" | "folder" | "missing"; onTarget?: (operation: () => Promise<unknown>) => Promise<unknown> } = {}) {
  const target = new obsidian.TFile(targetPath);
  const stage = options.stageKind === "folder" ? new obsidian.TFolder(stagePath) : new obsidian.TFile(stagePath);
  const files = new Map<string, object>([[targetPath, target]]);
  if (options.stageKind !== "missing") files.set(stagePath, stage);
  const contents = new Map([[targetPath, options.targetText ?? "# Target\n<!-- qnalog-session:target -->"], [stagePath, options.stageText ?? ""]]);
  const log: string[] = [];
  const queueTask = { id: "append", sessionId: "session", type: "merge", mdPath: stagePath, temporarySourcePath: stagePath, mode: "meeting", status: "pending", retries: 0, segments: [segment()], continuation: { targetPath, targetSourceId: "target", recordedAt: "2026-10-09T12:00:00.000Z" }, ...(options.task ?? {}) };
  const queue = { tasks: options.dependencyTasks ?? [queueTask], recoveryEntries: vi.fn(() => options.recovery ?? []), update: vi.fn(async (_id: string, patch: Record<string, unknown>) => { log.push(`queue:${Object.keys(patch).join(",")}`); Object.assign(queueTask, patch); }) };
  const vault = {
    getAbstractFileByPath: vi.fn((path: string) => files.get(path) ?? null),
    read: vi.fn(async (file: { path: string }) => { log.push(`read:${file.path}`); return contents.get(file.path) ?? ""; }),
  };
  const host = {
    app: { vault, metadataCache: { getFileCache: vi.fn(() => ({ frontmatter: {} })) }, fileManager: { trashFile: vi.fn(async (file: { path: string }) => { log.push(`trash:${file.path}`); files.delete(file.path); }) } },
    continuations: { isSessionTracked: vi.fn((id: string) => (options.tracked ?? []).includes(id)), hasActiveSessions: vi.fn(() => options.active ?? false), runOnTarget: vi.fn(async (_target: unknown, operation: () => Promise<unknown>) => { log.push("runOnTarget"); return options.onTarget ? options.onTarget(operation) : operation(); }) },
    queue, settings: { enableRealtimeOutline: false },
    outline: { completeRealtimeOutlineForMergedSegments: vi.fn(async () => null), mergeContinuationOutlineText: vi.fn((base: string, fresh: string) => `${base}\n${fresh}`) },
    noteWriter: { commitContinuation: vi.fn(async (_session: unknown, _text: string) => { log.push("commit"); }) },
    tasks: { queueTaskActivityId: vi.fn(() => "activity"), patchTaskActivity: vi.fn(() => { log.push("activity"); }) },
    versions: { saveVersion: vi.fn(async () => { log.push("version"); }) },
    noteIndex: { refreshNoteIndexSafely: vi.fn(async () => { log.push("refresh"); }) },
    asrPipeline: {
      cleanupSuccessfulSegmentAudio: vi.fn(async () => { log.push("cleanup"); }),
      discardShortRecordingNote: vi.fn(async () => { log.push("discard"); }),
      discardShortRecordingAudio: vi.fn(async (session: { masterAudioPath?: string }) => { log.push(`discard-audio:${session.masterAudioPath || ""}`); }),
    },
  };
  mergeMock.mockImplementation(async () => { log.push("merge"); return "Organized transcript"; });
  vi.stubGlobal("window", { moment: (value?: unknown) => ({ format: (format: string) => `moment:${String(value ?? "now")}:${format}` }) });
  return { service: new QueueRetryService(host as never), host, target, stage, files, contents, queueTask, log };
}
function validTask(task: Record<string, unknown> = {}) {
  return { id: "append", sessionId: "session", type: "merge", mdPath: stagePath, temporarySourcePath: stagePath, mode: "meeting", status: "pending", segments: [segment()], continuation: { targetPath, targetSourceId: "target", recordedAt: "2026-10-09T12:00:00.000Z" }, ...task };
}
function stageMarkdown() { const fresh = segment(); return `# Stage\n${serializeTranscriptBlock(fresh, "### Segment 1", fresh.text)}`; }

describe("append task recovery consumer contract", () => {
  it.each([undefined, { targetPath }, { targetPath, targetSourceId: "" }])("blocks invalid continuation without vault access (%s)", async (continuation) => {
    const { service, host } = setup({ task: { continuation } });
    await expect(service.runAppendTask(validTask({ continuation }) as never)).resolves.toMatchObject({ deferred: true, status: "blocked" });
    expect(host.app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
  });
  it("rejects unsupported disposition before vault access", async () => {
    const { service, host } = setup();
    await expect(service.runAppendTask(validTask({ continuationDisposition: "keep" }) as never)).resolves.toMatchObject({ deferred: true, status: "blocked" });
    expect(host.app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
  });
  it("cleans a discarded staged file only when the session is no longer tracked", async () => {
    const waiting = setup({ tracked: ["session"], task: { continuationDisposition: "discard" } });
    await expect(waiting.service.runAppendTask(validTask({ continuationDisposition: "discard" }) as never)).resolves.toMatchObject({ deferred: true });
    expect(waiting.host.asrPipeline.discardShortRecordingNote).not.toHaveBeenCalled();
    const ready = setup({ task: { continuationDisposition: "discard" } });
    await expect(ready.service.runAppendTask(validTask({ continuationDisposition: "discard" }) as never)).resolves.toBeUndefined();
    expect(ready.host.asrPipeline.discardShortRecordingNote).toHaveBeenCalledWith({ id: "session", mdPath: stagePath });
    expect(ready.host.asrPipeline.discardShortRecordingAudio).toHaveBeenCalledWith({ id: "session", mdPath: stagePath, masterAudioPath: undefined });
    expect(ready.log).toEqual(["discard-audio:", "discard"]);
  });
  it("blocks unsafe discard paths and folders, but permits a missing staged note", async () => {
    const same = setup({ task: { continuationDisposition: "discard", temporarySourcePath: targetPath } });
    await expect(same.service.runAppendTask(validTask({ continuationDisposition: "discard", temporarySourcePath: targetPath }) as never)).resolves.toMatchObject({ status: "blocked" });
    const folder = setup({ task: { continuationDisposition: "discard" }, stageKind: "folder" });
    await expect(folder.service.runAppendTask(validTask({ continuationDisposition: "discard" }) as never)).resolves.toMatchObject({ status: "blocked" });
    const missing = setup({ task: { continuationDisposition: "discard" }, stageKind: "missing" });
    await expect(missing.service.runAppendTask(validTask({ continuationDisposition: "discard" }) as never)).resolves.toBeUndefined();
    expect(missing.host.asrPipeline.discardShortRecordingNote).not.toHaveBeenCalled();
  });
  it("defers a missing target and active session", async () => {
    const missing = setup(); missing.files.delete(targetPath);
    await expect(missing.service.runAppendTask(validTask() as never)).resolves.toMatchObject({ deferred: true, status: "missing" });
    const tracked = setup({ tracked: ["session"] });
    await expect(tracked.service.runAppendTask(validTask() as never)).resolves.toMatchObject({ deferred: true, reason: expect.any(String) });
    expect(tracked.host.queue.recoveryEntries).not.toHaveBeenCalled();
  });
  it("checks dependency tasks and retained recovery entries, ignoring prompt-only entries", async () => {
    const dependency = setup({ task: { dependsOnSessionIds: ["prior"] }, dependencyTasks: [{ type: "transcribe", sessionId: "prior" }] });
    await expect(dependency.service.runAppendTask(validTask({ dependsOnSessionIds: ["prior"] }) as never)).resolves.toMatchObject({ deferred: true });
    expect(dependency.host.queue.recoveryEntries).toHaveBeenCalledTimes(1);
    const promptOnly = setup({ task: { dependsOnSessionIds: ["prior"] }, dependencyTasks: [{ type: "generate-prompt", sessionId: "prior" }], recovery: [{ taskType: "generate-prompt", sessionId: "prior" }] });
    await promptOnly.service.runAppendTask(validTask({ dependsOnSessionIds: ["prior"] }) as never);
    expect(promptOnly.host.queue.recoveryEntries).toHaveBeenCalledTimes(1);
  });
  it("rechecks target state and identity inside target serialization", async () => {
    const gone = setup({ onTarget: async (operation) => { gone.files.delete(targetPath); return operation(); } });
    await expect(gone.service.runAppendTask(validTask() as never)).resolves.toMatchObject({ status: "missing" });
    const active = setup({ active: true });
    await expect(active.service.runAppendTask(validTask() as never)).resolves.toMatchObject({ deferred: true });
    const changed = setup({ targetText: "# Changed\n<!-- qnalog-session:other -->" });
    await expect(changed.service.runAppendTask(validTask() as never)).resolves.toMatchObject({ status: "blocked" });
  });
  it("recovers a committed continuation in ordered cleanup without merging again", async () => {
    const markdown = `# Target\n<!-- qnalog-session:target -->\n${serializeTranscriptBlock(segment(0, "target"), "### Segment 1", "old transcript")}\n<!-- qnalog-continuation-committed:session -->`;
    const setupValue = setup({ targetText: markdown, task: { sessionMeta: { _briefingCheckpointId: "checkpoint" } } });
    await expect(setupValue.service.runAppendTask(validTask({ sessionMeta: { _briefingCheckpointId: "checkpoint" } }) as never)).resolves.toBeUndefined();
    expect(setupValue.log).toEqual(["runOnTarget", `read:${targetPath}`, "activity", "commit", "refresh", "cleanup", `trash:${stagePath}`]);
    expect(mergeMock).not.toHaveBeenCalled();
    expect(setupValue.host.noteWriter.commitContinuation).toHaveBeenCalledTimes(1);
  });
  it("commits a fresh staged transcript and retains persisted task metadata", async () => {
    const setupValue = setup({ stageText: stageMarkdown(), task: { sessionMeta: { custom: "keep" } } });
    const task = validTask({ sessionMeta: { custom: "keep" } });
    await setupValue.service.runAppendTask(task as never);
    expect(setupValue.queueTask.segments).toEqual(expect.any(Array));
    expect(setupValue.host.queue.update).toHaveBeenCalledWith("append", { sessionMeta: task.sessionMeta });
    expect(task.sessionMeta).toMatchObject({ custom: "keep", startedAt: expect.any(String) });
    expect(setupValue.queueTask.sessionMeta).not.toHaveProperty("_taskActivityId");
    expect(setupValue.log.indexOf("merge")).toBeLessThan(setupValue.log.indexOf("version"));
    expect(setupValue.log.indexOf("commit")).toBeLessThan(setupValue.log.indexOf("cleanup"));
    expect(setupValue.host.app.fileManager.trashFile).toHaveBeenCalledWith(setupValue.stage);
  });
  it("persists filtered session metadata before propagating merge failures", async () => {
    const failure = new Error("merge failed");
    const setupValue = setup({ stageText: stageMarkdown(), task: { sessionMeta: { custom: true } } });
    mergeMock.mockRejectedValueOnce(failure);
    const task = validTask({ sessionMeta: { custom: true } });
    await expect(setupValue.service.runAppendTask(task as never)).rejects.toBe(failure);
    expect(setupValue.host.queue.update).toHaveBeenCalledWith("append", { sessionMeta: task.sessionMeta });
    expect(setupValue.queueTask.sessionMeta).toMatchObject({ custom: true });
    expect(setupValue.log).not.toContain("version");
    expect(setupValue.host.noteWriter.commitContinuation).not.toHaveBeenCalled();
  });
  it("does not persist metadata for empty merge output", async () => {
    const setupValue = setup({ stageText: stageMarkdown() });
    mergeMock.mockResolvedValueOnce("");
    await expect(setupValue.service.runAppendTask(validTask() as never)).rejects.toThrow("Merge returned an empty result");
    expect(setupValue.queueTask.sessionMeta).toBeUndefined();
  });
});

describe("append keeps the target note's frontmatter properties", () => {
  const audio = "QnALog/录音/qnalog-20261017-223207.m4a";
  const targetWith = (extra: string[]) => ["---", "qnalog_mode: meeting", "qnalog_time: 2026-10-17T22:32:07", "qnalog_duration: 00:12", ...extra, "qnalog_status: organized", "tags:", "  - qnalog/meeting", "---", "# Target", "<!-- qnalog-session:target -->"].join("\n");
  const frontmatterKeys = (markdown: string) => markdown.slice(0, markdown.indexOf("\n---", 4)).split("\n").filter(line => /^[^\s-][^:]*:/.test(line)).map(line => line.slice(0, line.indexOf(":")));
  const frontmatterValue = (markdown: string, key: string) => markdown.slice(0, markdown.indexOf("\n---", 4)).split("\n").find(line => line.startsWith(`${key}:`))?.slice(key.length + 1).trim();
  function runAppend(targetText: string) {
    const setupValue = setup({ targetText, stageText: stageMarkdown() });
    mergeMock.mockImplementation(async (_plugin: unknown, _segments: unknown, mode: string, sessionMeta: unknown) =>
      postProcessBriefingOutput("## 摘要\n续录正文", mode, sessionMeta as never, null, "meeting", "", ""));
    setupValue.host.noteWriter.commitContinuation.mockImplementation(async (_session: unknown, polished: string) => {
      const parts = prepareNotePolishParts(polished, "");
      setupValue.contents.set(targetPath, appendPolishNoteContent({
        currentMarkdown: setupValue.contents.get(targetPath) ?? "", block: "", polishedFrontmatter: parts.frontmatter,
        hasMergeError: false, textImport: false, totalMs: 0, continuationSessionId: "",
      }));
    });
    return { setupValue, run: () => setupValue.service.runAppendTask(validTask() as never) };
  }
  it("keeps qnalog_audio unchanged and key order mode, time, duration, audio, status", async () => {
    const { setupValue, run } = runAppend(targetWith([`qnalog_audio: ${audio}`]));
    await run();
    const after = setupValue.contents.get(targetPath) ?? "";
    expect(frontmatterValue(after, "qnalog_audio")).toBe(audio);
    expect(after.match(/qnalog_audio:/g)).toHaveLength(1);
    expect(frontmatterKeys(after)).toEqual(["qnalog_mode", "qnalog_time", "qnalog_duration", "qnalog_audio", "qnalog_status", "tags"]);
  });
  it("keeps existing people and speaker mapping when the model output omits them", async () => {
    const { setupValue, run } = runAppend(targetWith([`qnalog_audio: ${audio}`, "qnalog_people:", "  - 李四", "qnalog_speakers:", "  SPEAKER_0: 张三"]));
    await run();
    const after = setupValue.contents.get(targetPath) ?? "";
    expect(after).toContain("qnalog_people:\n  - 李四");
    expect(after).toContain("qnalog_speakers:\n  SPEAKER_0: 张三");
    expect(after.match(/qnalog_people:/g)).toHaveLength(1);
    expect(after.match(/qnalog_speakers:/g)).toHaveLength(1);
    expect(frontmatterValue(after, "qnalog_audio")).toBe(audio);
  });
  it("adds no qnalog_audio when the target note has none", async () => {
    const { setupValue, run } = runAppend(targetWith([]));
    await run();
    const after = setupValue.contents.get(targetPath) ?? "";
    expect(after).not.toContain("qnalog_audio");
    expect(frontmatterKeys(after)).toEqual(["qnalog_mode", "qnalog_time", "qnalog_duration", "qnalog_status", "tags"]);
  });
});
