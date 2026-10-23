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
import { reorganizeNoteInPlace, type ReorganizeInPlacePort } from "../src/notes/reorganize-in-place-flow";

afterEach(() => { notices.length = 0; vi.restoreAllMocks(); });

const backfilled = readFileSync(new URL("./fixtures/backfilled-note-general.md", import.meta.url), "utf8");
// 原始材料部分取自已有夹具：最后一段结束于 00:13。
const rawSection = backfilled.slice(backfilled.indexOf("---\n\n## 原始材料"));
const generated = "## ✨ 整合版（通用）\n\n新的整理正文。";
const modes = [{ value: "general", label: "通用" }, { value: "meeting", label: "会议" }];

function neverOrganized(title = "（录音中…）"): string {
  return `# 2026-10-17 12:50 · 通用${title}\n\n${rawSection}`;
}

function organized(title = "（录音中…）"): string {
  return `# 2026-10-17 12:50 · 通用${title}\n\n## ✨ 整合版（通用）\n\n上一次整理的正文。\n\n${rawSection}`;
}

function run(content: string, name: string, options: { autoRename?: boolean; reorganize?: { firstOrganizing?: boolean } } = {}) {
  const file = new obsidian.TFile(`QnALog/转写纪要/${name}.md`);
  const renamed = new obsidian.TFile(`QnALog/转写纪要/${name} · 通用-标题.md`);
  let stored = content;
  const raw = {
    getVault: () => ({
      read: async () => stored,
      process: async (_target: unknown, transform: (latest: string) => string) => { stored = transform(stored); },
    }),
    getCachedFrontmatter: () => null,
    loadErrata: vi.fn(async () => null),
    getDefaultMode: vi.fn(() => "general"),
    detectNoteMode: vi.fn(() => null),
    saveReorganizeSnapshot: vi.fn(async () => undefined),
    getModeDisplayName: () => "",
    getModeOptions: vi.fn(() => modes),
    resolveLinkPath: vi.fn(() => null),
    // 与 noteFileNameFormatNew 默认值 "YYYY-MM-DD HHmm" 的结果一致。
    formatNoteFileName: vi.fn((time: string) => `${time.slice(0, 10)} ${time.slice(11, 13)}${time.slice(14, 16)}`),
    getAutoRenameWithTitle: vi.fn(() => options.autoRename ?? true),
    renameWithGeneratedTitle: vi.fn(async () => renamed),
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
  const done = reorganizeNoteInPlace(raw as unknown as ReorganizeInPlacePort, file, options.reorganize ?? {});
  return { raw, file, renamed, done, read: () => stored };
}

const firstLine = (text: string) => text.split("\n").find((line) => line.startsWith("# ")) ?? "";

describe("manual reorganize of a note whose first organize never finished", () => {
  it("replaces the recording placeholder in the title with the recorded length", async () => {
    const h = run(neverOrganized(), "2026-10-17 1250");
    await h.done;
    expect(firstLine(h.read())).toBe("# 2026-10-17 12:50 · 通用（00:13）");
    expect(h.read()).not.toContain("录音中");
    expect(h.read()).toContain("新的整理正文");
  });

  it("is treated as a first organize: session keys are added and the file is renamed", async () => {
    const h = run(neverOrganized(), "2026-10-17 1250");
    await h.done;
    expect(h.read()).toContain("qnalog_status: organized");
    expect(h.raw.renameWithGeneratedTitle).toHaveBeenCalledTimes(1);
    expect(h.raw.refreshNoteIndex.mock.calls[0]?.[0]).toBe(h.renamed);
  });

  it("keeps the English placeholder style", async () => {
    const h = run(neverOrganized("(recording…)"), "2026-10-17 1250");
    await h.done;
    expect(firstLine(h.read())).toBe("# 2026-10-17 12:50 · 通用(00:13)");
  });

  it("an explicit firstOrganizing:false does not add session keys", async () => {
    const h = run(neverOrganized(), "2026-10-17 1250", { reorganize: { firstOrganizing: false } });
    await h.done;
    expect(h.read()).not.toContain("qnalog_status");
  });
});

describe("reorganize of a note that already has an organized body", () => {
  it("still removes a leftover recording placeholder and adds no session keys", async () => {
    const h = run(organized(), "2026-10-17 1250");
    await h.done;
    expect(firstLine(h.read())).toBe("# 2026-10-17 12:50 · 通用（00:13）");
    expect(h.read()).not.toContain("qnalog_status");
  });

  it("renames a note whose file name is still the bare timestamp name", async () => {
    const h = run(organized(), "2026-10-17 1250");
    await h.done;
    expect(h.raw.renameWithGeneratedTitle).toHaveBeenCalledTimes(1);
    expect(notices).toContain("Note body reorganized");
  });

  it("does not rename when automatic title rename is off", async () => {
    const h = run(organized(), "2026-10-17 1250", { autoRename: false });
    await h.done;
    expect(h.raw.renameWithGeneratedTitle).not.toHaveBeenCalled();
  });

  it("does not rename a note that already carries a generated title", async () => {
    const h = run(organized("（00:13）"), "2026-10-17 1250 · 通用-会议纪要");
    await h.done;
    expect(h.raw.renameWithGeneratedTitle).not.toHaveBeenCalled();
    expect(firstLine(h.read())).toBe("# 2026-10-17 12:50 · 通用（00:13）");
  });

  it("does not rename a note the user named themselves", async () => {
    const h = run(organized("（00:13）"), "我的访谈记录");
    await h.done;
    expect(h.raw.renameWithGeneratedTitle).not.toHaveBeenCalled();
  });

  it("a rename failure does not undo the written body", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = run(organized(), "2026-10-17 1250");
    h.raw.renameWithGeneratedTitle.mockRejectedValueOnce(new Error("blocked"));
    await h.done;
    expect(h.read()).toContain("新的整理正文");
    expect(notices).toContain("Note body reorganized");
  });
});
