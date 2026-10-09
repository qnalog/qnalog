import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => {
  class TFile {
    path: string;
    name: string;
    basename: string;
    extension: string;
    parent: { path: string };
    constructor(path: string) {
      this.path = path;
      this.name = path.split("/").pop() || path;
      this.basename = this.name.replace(/\.md$/i, "");
      this.extension = this.name.includes(".") ? this.name.split(".").pop() || "" : "";
      this.parent = { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" };
    }
  }
  return {
    TFile,
    Notice: class Notice { constructor(message: string) { notices.push(String(message)); } },
    normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  };
});

import * as obsidian from "obsidian";
import type { Segment } from "../src/shared/types";
import { generateCleanScript, type CleanScriptFlowPort } from "../src/notes/clean-script-flow";
import { repolishMarkdownFile, type RepolishFlowBasePort } from "../src/notes/repolish-flow";

afterEach(() => { notices.length = 0; vi.restoreAllMocks(); });
beforeEach(() => { vi.stubGlobal("window", { moment: null }); });

const sourceText = [
  "# source",
  "<details><summary>分段原始转写</summary>",
  "### Segment 1",
  "甲方和甲方项目已确认。",
  "</details>",
  "<!-- qnalog-session:repolish-test -->",
].join("\n");

function fixture(overrides: Record<string, unknown> = {}) {
  const file = new obsidian.TFile("QnALog/Minutes/source.md");
  const contents = new Map<string, string>([[file.path, sourceText]]);
  const fileByPath = new Map<string, InstanceType<typeof obsidian.TFile>>([[file.path, file]]);
  const frontmatter = new Map<string, Record<string, unknown>>([[file.path, { "参会人": ["甲方 → 张三"] }]]);
  const inFlight = new Set<string>();
  const cleanInFlight = new Set<string>();
  const order: string[] = [];
  const taskRecords: Array<{ id: string; stage: string; detail: string }> = [];
  const calls: { merge: unknown[][]; clean: unknown[][]; modify: unknown[][]; derived: unknown[][]; save: unknown[][] } = {
    merge: [], clean: [], modify: [], derived: [], save: [],
  };
  const port = {
    getVault: () => ({
      read: async (target: InstanceType<typeof obsidian.TFile>) => {
        const text = contents.get(target.path);
        if (text === undefined) throw new Error(`missing ${target.path}`);
        return text;
      },
      modify: async (target: InstanceType<typeof obsidian.TFile>, text: string) => {
        order.push("modify"); calls.modify.push([target, text]); contents.set(target.path, text);
      },
      getAbstractFileByPath: (path: string) => fileByPath.get(path) || null,
    }),
    getCachedFrontmatter: (target: InstanceType<typeof obsidian.TFile>) => frontmatter.get(target.path) || null,
    getModeMeta: () => ({ prefix: "工作纪要", label: "工作纪要", custom: false }),
    getModeDisplayName: () => "工作纪要",
    getModePrefix: () => "工作纪要",
    detectNoteMode: () => "meeting",
    getInFlight: () => inFlight,
    getCleanInFlight: () => cleanInFlight,
    tasks: {
      setBusyLabel: vi.fn(), setBusyContext: vi.fn(), updateBusyStatus: vi.fn(),
      startTaskActivity: vi.fn((input: { id: string }) => { taskRecords.push({ id: input.id, stage: "llm", detail: "" }); }),
      patchTaskActivity: vi.fn((id: string, patch: { stage?: string; detail?: string }) => {
        const record = taskRecords.find((item) => item.id === id);
        if (record) Object.assign(record, patch);
      }),
      completeTaskActivity: vi.fn((id: string, patch: { stage?: string; detail?: string }) => {
        const record = taskRecords.find((item) => item.id === id);
        if (record) Object.assign(record, patch);
      }),
      failTaskActivity: vi.fn(), beginTaskMeter: vi.fn(() => ({ meter: true })),
      endTaskMeter: vi.fn(), logCompletedWork: vi.fn(),
    },
    mergeAndPolish: vi.fn(async (...args: unknown[]) => { order.push("merge"); calls.merge.push(args); return "Polished"; }),
    stripModeSuggestionBlocks: (text: string) => text,
    clearCommittedBriefingCheckpoint: vi.fn(async () => { order.push("checkpoint"); }),
    ensureOriginalVersionForSource: vi.fn(async () => { order.push("original"); }),
    createDerivedNote: vi.fn(async (...args: unknown[]) => {
      order.push("derived"); calls.derived.push(args);
      const created = new obsidian.TFile("QnALog/Minutes/derived.md");
      return created;
    }),
    saveVersion: vi.fn(async (...args: unknown[]) => { order.push("save"); calls.save.push(args); }),
    requestOutlineRefresh: vi.fn(() => { order.push("refresh"); }),
    findDerivedNoteForSource: vi.fn(() => null),
    switchVersion: vi.fn(async () => { order.push("switch"); }),
    getLearnedOutputCeiling: () => 4096,
    cleanTranscript: vi.fn(async (...args: unknown[]) => { calls.clean.push(args); return { text: "Readable transcript.", truncated: false }; }),
    contents, fileByPath, frontmatter, file, inFlight, cleanInFlight, order, taskRecords, calls,
    ...overrides,
  };
  return { port: port as unknown as RepolishFlowBasePort & CleanScriptFlowPort, file, contents, fileByPath, frontmatter, inFlight, cleanInFlight, order, taskRecords, calls };
}

describe("repolish execution flow", () => {
  it("ignores invalid files without reading the vault", async () => {
    const { port, file } = fixture();
    const read = vi.spyOn(port.getVault(), "read");
    await repolishMarkdownFile(port, {}, "meeting");
    const other = new obsidian.TFile("QnALog/Minutes/source.txt");
    await repolishMarkdownFile(port, other, "meeting");
    expect(read).not.toHaveBeenCalled();
    expect(port.tasks.startTaskActivity).not.toHaveBeenCalled();
    expect(file.extension).toBe("md");
  });

  it("reconciles legacy transcript blocks before merge and preserves role mapping order", async () => {
    const { port, file, calls, order, contents, taskRecords } = fixture();
    await repolishMarkdownFile(port, file, "meeting", { label: "简洁" });
    expect(calls.modify).toHaveLength(1);
    expect(order.indexOf("modify")).toBeLessThan(order.indexOf("merge"));
    expect(calls.merge).toHaveLength(1);
    const [segments, , sessionMeta, frontmatter] = calls.merge[0] as [Segment[], string, Record<string, unknown>, Record<string, unknown>];
    expect(segments[0].text).toBe("张三和张三项目已确认。");
    expect(frontmatter["参会人"]).toEqual(["张三"]);
    expect(sessionMeta).toHaveProperty("_previousKnowledge");
    expect(sessionMeta).toHaveProperty("_utteranceProjections");
    expect(sessionMeta._utteranceProjections).toEqual(expect.arrayContaining([
      expect.objectContaining({ normalizedText: "张三和张三项目已确认。" }),
    ]));
    expect(sessionMeta).toHaveProperty("_taskActivityId");
    expect(sessionMeta).toHaveProperty("_taskMeter");
    expect(order).toEqual(["modify", "merge", "original", "derived", "checkpoint", "save", "refresh"]);
    expect(calls.save[0][3]).toMatchObject({ kind: "minutes", activate: false, idLabel: "工作纪要-简洁" });
    expect(taskRecords[0].stage).toBe("done");
    expect(contents.get(file.path)).toContain("甲方和甲方项目已确认。");
  });

  it("does not start a task when no transcript is present", async () => {
    const { port, file, calls, contents } = fixture();
    contents.set(file.path, "# no transcript\n");
    await repolishMarkdownFile(port, file, "meeting");
    expect(port.tasks.startTaskActivity).not.toHaveBeenCalled();
    expect(port.mergeAndPolish).not.toHaveBeenCalled();
    expect(calls.merge).toHaveLength(0);
    expect(port.getInFlight().size).toBe(0);
    expect(notices.some((notice) => notice.includes("No QnALog original transcript"))).toBe(true);
  });

  it("releases the source lock after a failed merge so a later request can run", async () => {
    const { port, file, inFlight } = fixture();
    vi.mocked(port.mergeAndPolish).mockRejectedValueOnce(new Error("model failed"));
    await repolishMarkdownFile(port, file, "meeting");
    expect(inFlight.size).toBe(0);
    expect(port.tasks.failTaskActivity).toHaveBeenCalledTimes(1);
    await repolishMarkdownFile(port, file, "meeting");
    expect(port.mergeAndPolish).toHaveBeenCalledTimes(2);
  });
  it("rejects a concurrent same-source request and releases the lock for a later request", async () => {
    const { port, file, inFlight, calls } = fixture();
    let releaseMerge: (() => void) | undefined;
    let blockFirst = true;
    vi.mocked(port.mergeAndPolish).mockImplementation(async (...args: unknown[]) => {
      calls.merge.push(args);
      if (blockFirst) {
        blockFirst = false;
        await new Promise<void>((resolve) => { releaseMerge = resolve; });
      }
      return "Polished";
    });
    const first = repolishMarkdownFile(port, file, "meeting");
    await vi.waitFor(() => expect(port.mergeAndPolish).toHaveBeenCalledTimes(1));
    await repolishMarkdownFile(port, file, "meeting");
    expect(notices.some((notice) => notice.includes("being reorganized"))).toBe(true);
    expect(port.mergeAndPolish).toHaveBeenCalledTimes(1);
    releaseMerge?.();
    await first;
    expect(inFlight.size).toBe(0);
    await repolishMarkdownFile(port, file, "meeting");
    expect(port.mergeAndPolish).toHaveBeenCalledTimes(2);
  });

  it("does not save a version when derived-note creation fails and clears task state", async () => {
    const { port, file, inFlight } = fixture();
    vi.mocked(port.createDerivedNote).mockRejectedValueOnce(new Error("create denied"));
    await repolishMarkdownFile(port, file, "meeting");
    expect(port.saveVersion).not.toHaveBeenCalled();
    expect(port.tasks.failTaskActivity).toHaveBeenCalledTimes(1);
    expect(notices.some((notice) => notice.includes("Re-organize failed: create denied"))).toBe(true);
    expect(port.tasks.setBusyLabel).toHaveBeenLastCalledWith(null);
    expect(port.tasks.setBusyContext).toHaveBeenLastCalledWith(null);
    expect(inFlight.size).toBe(0);
  });

  it("completes after version-cache failure and tolerates outline refresh failure", async () => {
    const { port, file, taskRecords } = fixture();
    vi.mocked(port.saveVersion).mockRejectedValueOnce(new Error("disk full"));
    vi.mocked(port.requestOutlineRefresh).mockImplementation(() => { throw new Error("sidebar unavailable"); });
    await repolishMarkdownFile(port, file, "meeting");
    expect(port.tasks.completeTaskActivity).toHaveBeenCalledTimes(1);
    expect(port.tasks.failTaskActivity).not.toHaveBeenCalled();
    expect(taskRecords[0].detail).toContain("Version index not synced: disk full");
    expect(notices.some((notice) => notice.includes("version index can be rebuilt later"))).toBe(true);
  });

  it("notifies on an early vault read failure without failing an unstarted task", async () => {
    const { port, file } = fixture({
      getVault: () => ({
        read: vi.fn(async () => { throw new Error("vault read denied"); }),
        modify: vi.fn(async () => undefined),
        getAbstractFileByPath: () => null,
      }),
    });
    await repolishMarkdownFile(port, file, "meeting");
    expect(port.tasks.startTaskActivity).not.toHaveBeenCalled();
    expect(port.tasks.failTaskActivity).not.toHaveBeenCalled();
    expect(notices.some((notice) => notice.includes("vault read denied"))).toBe(true);
    expect(port.tasks.setBusyLabel).toHaveBeenLastCalledWith(null);
  });
});

describe("clean transcript execution flow", () => {
  it("writes the truncation warning and releases clean-task busy state", async () => {
    const { port, file, calls, cleanInFlight } = fixture();
    vi.mocked(port.cleanTranscript).mockResolvedValue({ text: "Readable transcript.", truncated: true });
    await generateCleanScript(port, file);
    const version = calls.derived[0][2] as { body?: string };
    expect(version.body).toContain("> [!warning] 清稿可能被截断");
    expect(port.tasks.completeTaskActivity).toHaveBeenCalledTimes(1);
    expect(cleanInFlight.size).toBe(0);
    expect(port.tasks.setBusyLabel).toHaveBeenLastCalledWith(null);
    expect(port.tasks.setBusyContext).toHaveBeenLastCalledWith(null);
  });

  it("reuses an existing clean copy unless regeneration is requested", async () => {
    const { port, file } = fixture();
    const clean = new obsidian.TFile("QnALog/Minutes/clean.md");
    vi.mocked(port.findDerivedNoteForSource).mockReturnValue(clean);
    await generateCleanScript(port, file);
    expect(port.switchVersion).toHaveBeenCalledTimes(1);
    expect(port.cleanTranscript).not.toHaveBeenCalled();
    vi.mocked(port.findDerivedNoteForSource).mockReturnValue(null);
    await generateCleanScript(port, file, { regenerateExisting: true });
    expect(port.cleanTranscript).toHaveBeenCalledTimes(1);
  });

  it("fails an empty clean response and records the task failure", async () => {
    const { port, file, cleanInFlight } = fixture();
    vi.mocked(port.cleanTranscript).mockResolvedValue({ text: "", truncated: false });
    await generateCleanScript(port, file);
    expect(port.tasks.failTaskActivity).toHaveBeenCalledTimes(1);
    expect(notices.some((notice) => notice.includes("Clean copy generation failed"))).toBe(true);
    expect(cleanInFlight.size).toBe(0);
  });
  it("routes a derived note to its original source before cleaning", async () => {
    const { port, file, contents, fileByPath, frontmatter, calls } = fixture();
    const derived = new obsidian.TFile("QnALog/Minutes/derived.md");
    contents.set(derived.path, "# derived copy\n");
    fileByPath.set(derived.path, derived);
    frontmatter.set(derived.path, {
      qnalog_type: "QnALog派生版本",
      qnalog_source_path: file.path,
    });
    await generateCleanScript(port, derived);
    expect(calls.clean).toHaveLength(1);
    expect(calls.derived[0][0]).toBe(file);
    expect(port.switchVersion).toHaveBeenCalledWith(expect.anything(), file.path);
  });

  it("notifies when a derived note's source was moved without acquiring the clean lock", async () => {
    const { port, contents, fileByPath, frontmatter, cleanInFlight } = fixture();
    const derived = new obsidian.TFile("QnALog/Minutes/orphan.md");
    contents.set(derived.path, "# derived copy\n");
    fileByPath.set(derived.path, derived);
    frontmatter.set(derived.path, {
      qnalog_type: "QnALog派生版本",
      qnalog_source_path: "QnALog/Minutes/moved.md",
    });
    await generateCleanScript(port, derived);
    expect(notices.some((notice) => notice.includes("renamed or moved"))).toBe(true);
    expect(port.tasks.startTaskActivity).not.toHaveBeenCalled();
    expect(cleanInFlight.size).toBe(0);
    expect(port.tasks.setBusyLabel).not.toHaveBeenCalled();
  });

  it("releases the acquired clean lock even when the source has no transcript", async () => {
    const { port, file, contents } = fixture();
    contents.set(file.path, "# no transcript\n");
    await generateCleanScript(port, file);
    expect(port.tasks.startTaskActivity).not.toHaveBeenCalled();
    expect(port.tasks.setBusyLabel).toHaveBeenLastCalledWith(null);
    expect(port.getCleanInFlight().size).toBe(0);
  });
});
