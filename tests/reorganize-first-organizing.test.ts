import { readFileSync } from "node:fs";
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
  // 只支持本测试用到的 YAML 子集：`key: value` 与 `key:` 后跟 `  - item` 列表。
  parseYaml: (yaml: string) => {
    const out: Record<string, unknown> = {};
    let listKey = "";
    for (const line of yaml.split("\n")) {
      if (!line.trim()) continue;
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (item && listKey) { (out[listKey] as string[]).push(item[1].trim()); continue; }
      const kv = /^([^\s:][^:]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      listKey = kv[1].trim();
      out[listKey] = kv[2].trim() ? kv[2].trim().replace(/^['"]|['"]$/g, "") : [];
    }
    return out;
  },
  stringifyYaml: (value: Record<string, unknown>) => Object.entries(value).map(([key, item]) => (
    Array.isArray(item) ? `${key}:\n${item.map((x) => `  - ${String(x)}`).join("\n")}` : `${key}: ${String(item)}`
  )).join("\n") + "\n",
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import * as obsidian from "obsidian";
import { reorganizeNoteInPlace, buildReorganizedNote, type ReorganizeInPlacePort } from "../src/notes/reorganize-in-place-flow";
import { buildAbsentSessionFrontmatter, readSessionFieldsFromNote, type SessionModeOption } from "../src/notes/first-organizing-session";
import { splitLeadingFrontmatter } from "../src/notes/note-document";
import { extractTranscriptSegments } from "../src/notes/note-transcript-ledger";

afterEach(() => { notices.length = 0; vi.restoreAllMocks(); });

const firstOrganized = readFileSync(new URL("./fixtures/first-organized-note-general.md", import.meta.url), "utf8");
const backfilled = readFileSync(new URL("./fixtures/backfilled-note-general.md", import.meta.url), "utf8");
const modes: SessionModeOption[] = [{ value: "general", label: "通用" }, { value: "meeting", label: "会议" }];
const identity = (text: string) => text;
const generated = "## ✨ 整合版（通用）\n\n新的整理正文。";
const audioPath = "QnALog/录音/qnalog-20261017-125032.m4a";
const SESSION_KEYS = ["qnalog_mode", "qnalog_time", "qnalog_duration", "qnalog_audio", "qnalog_status"];

function frontmatterKeys(markdown: string): string[] {
  return splitLeadingFrontmatter(markdown).frontmatter.split("\n")
    .filter((line) => /^[^\s-][^:]*:/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")));
}

function frontmatterValue(markdown: string, key: string): string | undefined {
  const line = splitLeadingFrontmatter(markdown).frontmatter.split("\n").find((item) => item.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim();
}

/** 与 reorganize-in-place-flow 内的调用顺序一致：读取现有 frontmatter，只生成缺失的会话键。 */
function absentSessionKeysFor(markdown: string) {
  const fields = readSessionFieldsFromNote(markdown, modes);
  const existing = obsidian.parseYaml(splitLeadingFrontmatter(markdown).frontmatter.replace(/^---\s*\n?/, "").replace(/\n?---\s*$/, "")) as Record<string, unknown>;
  return buildAbsentSessionFrontmatter(existing, {
    mode: fields.mode, time: fields.time, duration: fields.duration,
    audioPath: fields.audioLink ? audioPath : null,
  });
}

describe("session fields read from the note itself", () => {
  it("reads time, duration, mode and audio from the backfilled note recording-info block", () => {
    expect(readSessionFieldsFromNote(backfilled, modes)).toEqual({
      mode: "general",
      time: "2026-10-17T12:50:32",
      duration: "00:13",
      audioLink: "qnalog-20261017-125032.m4a",
    });
  });

  it("reads the same fields from the first-time organized note", () => {
    expect(readSessionFieldsFromNote(firstOrganized, modes)).toEqual({
      mode: "general",
      time: "2026-10-17T12:07:36",
      duration: "00:09",
      audioLink: "qnalog-20261017-120736.m4a",
    });
  });

  it("falls back to the recording-info mode label when the system tag is absent", () => {
    const withoutTag = backfilled.replace("  - qnalog/general\n", "");
    expect(readSessionFieldsFromNote(withoutTag, modes).mode).toBe("general");
  });

  it("returns null for fields that the note does not contain", () => {
    expect(readSessionFieldsFromNote("# Plain note\n\nbody", modes)).toEqual({ mode: null, time: null, duration: null, audioLink: null });
  });
});

describe("backfilled note gets the same session keys as a first-time organized note", () => {
  it("produces the first-time key set and order", () => {
    const next = buildReorganizedNote(backfilled, generated, identity, absentSessionKeysFor(backfilled));
    expect(frontmatterKeys(next)).toEqual([...SESSION_KEYS, "tags"]);
    expect(frontmatterKeys(firstOrganized)).toEqual([...SESSION_KEYS, "tags"]);
  });

  it("takes each value from the note and the linked audio path", () => {
    const next = buildReorganizedNote(backfilled, generated, identity, absentSessionKeysFor(backfilled));
    expect(frontmatterValue(next, "qnalog_mode")).toBe("general");
    expect(frontmatterValue(next, "qnalog_time")).toBe("2026-10-17T12:50:32");
    expect(frontmatterValue(next, "qnalog_duration")).toBe("00:13");
    expect(frontmatterValue(next, "qnalog_audio")).toBe(audioPath);
    expect(frontmatterValue(next, "qnalog_status")).toBe("organized");
    expect(next).toContain("  - qnalog/general");
  });

  it("does not add an audio key when the audio link cannot be resolved", () => {
    const fields = readSessionFieldsFromNote(backfilled, modes);
    const leading = buildAbsentSessionFrontmatter({}, { mode: fields.mode, time: fields.time, duration: fields.duration, audioPath: null });
    expect(Object.keys(leading)).toEqual(["qnalog_mode", "qnalog_time", "qnalog_duration", "qnalog_status"]);
  });
});

describe("existing frontmatter values are never overwritten", () => {
  it("keeps existing session keys, including legacy aliases, and adds only the missing ones", () => {
    const note = backfilled.replace("tags:\n", "qnalog_mode: meeting\nqnalog_duration: \"00:99\"\ntags:\n");
    const leading = absentSessionKeysFor(note);
    expect(leading).not.toHaveProperty("qnalog_mode");
    expect(leading).not.toHaveProperty("qnalog_duration");
    expect(leading).toHaveProperty("qnalog_time", "2026-10-17T12:50:32");
    const next = buildReorganizedNote(note, generated, identity, leading);
    expect(frontmatterValue(next, "qnalog_mode")).toBe("meeting");
    expect(frontmatterValue(next, "qnalog_duration")).toBe("00:99");
  });
});

describe("running the in-place organize twice does not duplicate keys", () => {
  it("second pass adds no session keys and keeps the text", () => {
    const once = buildReorganizedNote(backfilled, generated, identity, absentSessionKeysFor(backfilled));
    const secondLeading = absentSessionKeysFor(once);
    expect(secondLeading).toEqual({});
    const twice = buildReorganizedNote(once, generated, identity, secondLeading);
    expect(twice).toBe(once);
    const keys = frontmatterKeys(twice);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

function makePort(content: string, options: { autoRename?: boolean; rename?: (file: obsidian.TFile) => Promise<unknown> } = {}) {
  const file = new obsidian.TFile("QnALog/转写纪要/2026-10-17 1250.md");
  const renamed = new obsidian.TFile("QnALog/转写纪要/2026-10-17 1250 · 通用-测试标题.md");
  let stored = content;
  const raw = {
    getVault: () => ({
      read: async () => stored,
      process: async (_target: unknown, transform: (latest: string) => string) => { stored = transform(stored); },
    }),
    getCachedFrontmatter: () => null,
    loadErrata: vi.fn(async () => null),
    getDefaultMode: vi.fn(() => "meeting"),
    detectNoteMode: vi.fn(() => null),
    saveReorganizeSnapshot: vi.fn(async () => undefined),
    getModeDisplayName: () => "",
    getModeOptions: vi.fn(() => modes),
    resolveLinkPath: vi.fn((link: string) => (link === "qnalog-20261017-125032.m4a" ? audioPath : null)),
    formatNoteFileName: vi.fn(() => null),
    getAutoRenameWithTitle: vi.fn(() => options.autoRename ?? true),
    renameWithGeneratedTitle: vi.fn(options.rename ?? (async () => renamed)),
    getInFlight: () => new Set<string>(),
    mergeAndPolish: vi.fn(async () => generated),
    clearCommittedBriefingCheckpoint: vi.fn(async () => undefined),
    recoverOriginalTranscript: vi.fn(async () => false),
    stripModeSuggestionBlocks: (text: string) => text,
    validateOriginalVersionForReorganization: vi.fn(async () => undefined),
    replaceOriginalVersionBody: vi.fn(async () => null),
    restoreOriginalVersionBody: vi.fn(async () => undefined),
    switchVersion: vi.fn(async () => undefined),
    refreshNoteIndex: vi.fn(async () => undefined),
    tasks: { startTaskActivity: vi.fn(), patchTaskActivity: vi.fn(), completeTaskActivity: vi.fn(), failTaskActivity: vi.fn() },
  };
  return { port: raw as unknown as ReorganizeInPlacePort, raw, file, renamed, read: () => stored };
}

describe("in-place reorganize flow for a backfilled note", () => {
  it("first organizing: writes session keys, renames once with the generated text and mode, and indexes the renamed file", async () => {
    const h = makePort(backfilled);
    await reorganizeNoteInPlace(h.port, h.file, { firstOrganizing: true });
    expect(h.raw.mergeAndPolish.mock.calls[0]?.[1]).toBe("general");
    expect(h.raw.renameWithGeneratedTitle).toHaveBeenCalledTimes(1);
    expect(h.raw.renameWithGeneratedTitle).toHaveBeenCalledWith(h.file, generated, "general");
    expect(frontmatterKeys(h.read())).toEqual([...SESSION_KEYS, "tags"]);
    expect(h.raw.refreshNoteIndex.mock.calls[0]?.[0]).toBe(h.renamed);
    expect(notices).toContain("Note body reorganized");
  });

  it("auto-rename off: session keys are still written, rename is not called", async () => {
    const h = makePort(backfilled, { autoRename: false });
    await reorganizeNoteInPlace(h.port, h.file, { firstOrganizing: true });
    expect(h.raw.renameWithGeneratedTitle).not.toHaveBeenCalled();
    expect(frontmatterKeys(h.read())).toEqual([...SESSION_KEYS, "tags"]);
    expect(h.raw.refreshNoteIndex.mock.calls[0]?.[0]).toBe(h.file);
  });

  it("rename throws: the reorganize still succeeds and the failure is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = makePort(backfilled, { rename: async () => { throw new Error("rename blocked"); } });
    await reorganizeNoteInPlace(h.port, h.file, { firstOrganizing: true });
    expect(notices).toContain("Note body reorganized");
    expect(notices.some((message) => message.startsWith("Reorganize failed"))).toBe(false);
    expect(warn).toHaveBeenCalledWith("[QnALog] reorganize-in-place title rename failed", expect.any(Error));
    expect(h.raw.refreshNoteIndex.mock.calls[0]?.[0]).toBe(h.file);
    expect(h.read()).toContain("新的整理正文");
  });

  it("manual in-place reorganize (no options): no session keys, no rename, no mode lookup", async () => {
    const h = makePort(backfilled);
    await reorganizeNoteInPlace(h.port, h.file);
    expect(h.raw.renameWithGeneratedTitle).not.toHaveBeenCalled();
    expect(h.raw.getModeOptions).not.toHaveBeenCalled();
    expect(h.raw.resolveLinkPath).not.toHaveBeenCalled();
    expect(h.raw.mergeAndPolish.mock.calls[0]?.[1]).toBe("meeting");
    expect(frontmatterKeys(h.read())).toEqual(["tags"]);
    expect(h.raw.refreshNoteIndex.mock.calls[0]?.[0]).toBe(h.file);
  });

  it("the backfilled note still has its raw transcript segments after organizing", async () => {
    const h = makePort(backfilled);
    await reorganizeNoteInPlace(h.port, h.file, { firstOrganizing: true });
    expect(extractTranscriptSegments(h.read()).length).toBeGreaterThanOrEqual(2);
  });
});
