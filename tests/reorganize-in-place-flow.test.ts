import { afterEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({
  TFile: class TFile {
    path: string; name: string; basename: string; extension: string; parent: { path: string };
    constructor(path: string) {
      this.path = path; this.name = path.split("/").pop() || path;
      this.basename = this.name.replace(/\.md$/i, ""); this.extension = "md";
      this.parent = { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" };
    }
  },
  Notice: class Notice { constructor(message: string) { notices.push(String(message)); } },
  parseYaml: (yaml: string) => Object.fromEntries(yaml.split("\n").filter(Boolean).map((line) => {
    const index = line.indexOf(":");
    return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")];
  })),
  stringifyYaml: (value: Record<string, unknown>) => Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`).join("\n"),
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import * as obsidian from "obsidian";
import { reorganizeNoteInPlace, type ReorganizeInPlacePort } from "../src/notes/reorganize-in-place-flow";

afterEach(() => { notices.length = 0; vi.restoreAllMocks(); });

const transcriptBlock = [
  "<details><summary>分段原始转写</summary>",
  "### Segment 1",
  "录音原文：今天确认项目下周启动。",
  "</details>",
  "<!-- qnalog-session:reorganize-test -->",
].join("\n");
const original = [
  "---", "title: Old title", "tags: old", "user_custom: keep-me", "qnalog_time: 2026-10-13T10:00:00", "---",
  "# 2026-10-13 10:00 · 工作纪要", "", "Old organized body", "", "---", "", "## 原始材料", transcriptBlock,
].join("\n");
const generated = "---\ntitle: New title\ntags: new\nqnalog_topic: New topic\n---\nNew organized body";

function fixture(overrides: Record<string, unknown> = {}) {
  const file = new obsidian.TFile("QnALog/Minutes/source.md");
  const contents = new Map([[file.path, original]]);
  const calls: { order: string[]; refresh: unknown[][]; created: unknown[][]; snapshots: unknown[][]; switched: unknown[][] } = { order: [], refresh: [], created: [], snapshots: [], switched: [] };
  const create = vi.fn();
  const activities = new Map<string, { stage: string; detail?: string }>();
  const port = {
    getVault: () => ({
      read: async () => contents.get(file.path) || "",
      process: async (_file: unknown, transform: (latest: string) => string) => {
        const latest = contents.get(file.path) || "";
        const next = transform(latest);
        if (next !== latest) { calls.order.push("write"); contents.set(file.path, next); }
      },
      create,
    }),
    getCachedFrontmatter: () => ({ "qnalog_time": "2026-10-13T10:00:00", user_custom: "keep-me", tags: ["old"] }),
    getDefaultMode: () => "general",
    getModeDisplayName: () => "General",
    getInFlight: () => new Set<string>(),
    mergeAndPolish: vi.fn(async () => { calls.order.push("merge"); return generated; }),
    stripModeSuggestionBlocks: (text: string) => text,
    validateOriginalVersionForReorganization: vi.fn(async () => { calls.order.push("validate-cache"); }),
    replaceOriginalVersionBody: vi.fn(async (...args: unknown[]) => {
      calls.order.push("replace-original"); calls.snapshots.push(args);
      return { path: "QnALog/.versions/source/original.md", previousPayload: "old-payload" };
    }),
    restoreOriginalVersionBody: vi.fn(async (...args: unknown[]) => { calls.order.push("restore-original"); calls.snapshots.push(args); }),
    switchVersion: vi.fn(async (...args: unknown[]) => { calls.order.push("switch-version"); calls.switched.push(args); }),
    saveVersion: vi.fn(),
    refreshNoteIndex: vi.fn(async (...args: unknown[]) => { calls.order.push("refresh-index"); calls.refresh.push(args); }),
    tasks: {
      startTaskActivity: vi.fn((input: { id: string; stage: string }) => { calls.order.push("start-task"); activities.set(input.id, { stage: input.stage }); }),
      patchTaskActivity: vi.fn((id: string, patch: { stage?: string; detail?: string }) => { Object.assign(activities.get(id) || {}, patch); }),
      completeTaskActivity: vi.fn((id: string, patch: { stage?: string; detail?: string }) => { calls.order.push("done"); Object.assign(activities.get(id) || {}, patch); }),
      failTaskActivity: vi.fn((id: string, _error: unknown, patch: { stage?: string; detail?: string }) => { Object.assign(activities.get(id) || {}, patch); }),
    },
    ...overrides,
  };
  return { port: port as unknown as ReorganizeInPlacePort, file, contents, calls, activities, create, portRaw: port };
}

describe("in-place note reorganization", () => {
  it("applies errata to the source transcript and forwards the prompt to merge", async () => {
    const { port, file, portRaw } = fixture({
      loadErrata: vi.fn(async () => ({
        replacements: [{ from: "下周启动", to: "本周启动" }],
        noise: [], prompt: "## 勘误表\n替换：下周启动 => 本周启动",
      })),
    });
    await reorganizeNoteInPlace(port, file);
    const [segments, , sessionMeta] = vi.mocked(portRaw.mergeAndPolish).mock.calls[0] as unknown as [Array<{ text: string }>, string, Record<string, unknown>];
    expect(segments[0].text).toContain("本周启动");
    expect(sessionMeta._errata).toContain("下周启动 => 本周启动");
  });

  it("replaces the organized body while preserving source material and user fields", async () => {
    const { port, file, contents, calls, activities, portRaw, create } = fixture();
    await reorganizeNoteInPlace(port, file);
    const result = contents.get(file.path) || "";
    expect(result).toContain("user_custom: keep-me");
    expect(result).toContain("qnalog_time: 2026-10-13T10:00:00");
    expect(result).toContain("qnalog_topic: New topic");
    expect(result).toContain("tags: new");
    expect(result).toContain("New organized body");
    expect(result).not.toContain("Old organized body");
    expect(result.slice(result.indexOf("## 原始材料"))).toBe(original.slice(original.indexOf("## 原始材料")));
    expect(calls.order.indexOf("validate-cache")).toBeLessThan(calls.order.indexOf("merge"));
    expect(calls.snapshots[0][1]).toContain("New organized body");
    expect(calls.order.indexOf("refresh-index")).toBeLessThan(calls.order.indexOf("done"));
    expect(portRaw.saveVersion).not.toHaveBeenCalled();
    expect(portRaw.refreshNoteIndex).toHaveBeenCalledWith(file, { reason: "reorganize" });
    expect(portRaw.mergeAndPolish).toHaveBeenCalledWith(expect.any(Array), "general", expect.any(Object), expect.any(Object));
    expect((vi.mocked(portRaw.mergeAndPolish).mock.calls[0][2] as Record<string, unknown>)).not.toHaveProperty("_errata");
    expect(activities.get(`reorganize-in-place:${file.path}`)?.stage).toBe("done");
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the note unchanged when model generation fails", async () => {
    const { port, file, contents, portRaw, activities } = fixture();
    vi.mocked(port.mergeAndPolish).mockRejectedValueOnce(new Error("model unavailable"));
    await reorganizeNoteInPlace(port, file);
    expect(contents.get(file.path)).toBe(original);
    expect(portRaw.tasks.failTaskActivity).toHaveBeenCalledTimes(1);
    expect(activities.get(`reorganize-in-place:${file.path}`)?.stage).toBe("failed");
    expect(notices.some((message) => message.includes("model unavailable"))).toBe(true);
  });

  it("does not overwrite edits made while the model is running", async () => {
    const { port, file, contents, portRaw } = fixture();
    const userEdit = original.replace("Old organized body", "User edit during generation");
    vi.mocked(port.mergeAndPolish).mockImplementationOnce(async () => {
      contents.set(file.path, userEdit);
      return generated;
    });
    await reorganizeNoteInPlace(port, file);
    expect(contents.get(file.path)).toBe(userEdit);
    expect(portRaw.replaceOriginalVersionBody).not.toHaveBeenCalled();
    expect(notices.some((message) => message.includes("the result was not written"))).toBe(true);
    expect(portRaw.tasks.failTaskActivity).toHaveBeenCalledTimes(1);
  });

  it("does not create a pre-reorganization version", async () => {
    const { port, file, portRaw } = fixture();
    await reorganizeNoteInPlace(port, file);
    expect(portRaw.saveVersion).not.toHaveBeenCalled();
  });

  it("stops before model generation when cached version metadata cannot be read", async () => {
    const { port, file, contents, portRaw } = fixture({
      validateOriginalVersionForReorganization: vi.fn(async () => { throw new Error("Could not read version metadata"); }),
    });
    await reorganizeNoteInPlace(port, file);
    expect(contents.get(file.path)).toBe(original);
    expect(portRaw.mergeAndPolish).not.toHaveBeenCalled();
    expect(portRaw.replaceOriginalVersionBody).not.toHaveBeenCalled();
  });

  it("rolls the mother note back when updating the original snapshot fails", async () => {
    const { port, file, contents, portRaw } = fixture({
      replaceOriginalVersionBody: vi.fn(async () => { throw new Error("snapshot write failed"); }),
    });
    await reorganizeNoteInPlace(port, file);
    expect(contents.get(file.path)).toBe(original);
    expect(portRaw.restoreOriginalVersionBody).not.toHaveBeenCalled();
    expect(portRaw.refreshNoteIndex).not.toHaveBeenCalled();
    expect(notices.some((message) => message.includes("snapshot write failed"))).toBe(true);
  });

  it("activates the updated original snapshot when the source already uses an active version block", async () => {
    const activeOriginal = original.replace("Old organized body", [
      "<!-- qnalog-active-version-start -->",
      "Old active body",
      "<!-- qnalog-active-version-end -->",
    ].join("\n"));
    const { port, file, contents, portRaw, calls } = fixture();
    contents.set(file.path, activeOriginal);
    await reorganizeNoteInPlace(port, file);
    expect(portRaw.switchVersion).toHaveBeenCalledWith("QnALog/.versions/source/original.md", file.path);
    expect(calls.order.indexOf("replace-original")).toBeLessThan(calls.order.indexOf("switch-version"));
    expect(contents.get(file.path)).toContain("New organized body");
  });

  it("preserves a legacy prior-version frontmatter field as an ordinary user field", async () => {
    const noteWithLegacyKey = original.replace("user_custom: keep-me", "user_custom: keep-me\nqnalog_pre_reorganize_version: legacy-version-id");
    const { port, file, contents, portRaw } = fixture();
    contents.set(file.path, noteWithLegacyKey);
    await reorganizeNoteInPlace(port, file);
    expect(contents.get(file.path)).toContain("qnalog_pre_reorganize_version: legacy-version-id");
    expect(contents.get(file.path)).toContain("New organized body");
    expect(portRaw.saveVersion).not.toHaveBeenCalled();
  });

  it("does not create an original snapshot when none exists and no active version block is present", async () => {
    const { port, file, portRaw } = fixture({
      replaceOriginalVersionBody: vi.fn(async () => null),
    });
    await reorganizeNoteInPlace(port, file);
    expect(portRaw.saveVersion).not.toHaveBeenCalled();
    expect(portRaw.replaceOriginalVersionBody).toHaveBeenCalledOnce();
  });

  it("stops before model generation when an active version block has no readable snapshot", async () => {
    const activeSource = original.replace("Old organized body", "<!-- qnalog-active-version-start -->\nOld active body\n<!-- qnalog-active-version-end -->");
    const { port, file, contents, portRaw } = fixture({
      validateOriginalVersionForReorganization: vi.fn(async () => { throw new Error("Could not read version metadata"); }),
    });
    contents.set(file.path, activeSource);
    await reorganizeNoteInPlace(port, file);
    expect(contents.get(file.path)).toBe(activeSource);
    expect(portRaw.mergeAndPolish).not.toHaveBeenCalled();
  });

  it("rejects a second invocation while the first model request is active", async () => {
    let resolveGate!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { resolveGate = resolve; });
    const inFlight = new Set<string>();
    const { port, file, portRaw } = fixture({
      getInFlight: () => inFlight,
      mergeAndPolish: vi.fn(() => gate.promise),
    });
    const first = reorganizeNoteInPlace(port, file);
    await Promise.resolve();
    await reorganizeNoteInPlace(port, file);
    expect(portRaw.tasks.startTaskActivity).toHaveBeenCalledTimes(1);
    expect(notices.some((message) => message.includes("wait for the current task"))).toBe(true);
    resolveGate(generated);
    await first;
  });
});
