import { beforeEach, describe, expect, it, vi } from "vitest";

const { modalArgs, modalOpen, modalResult, notices } = vi.hoisted(() => ({
  modalArgs: [] as unknown[][],
  modalOpen: vi.fn(),
  modalResult: vi.fn<(done: (value: Record<string, string> | null) => void) => void>(),
  notices: [] as Array<[string, number | undefined]>,
}));
vi.mock("obsidian", () => ({
  TFile: class { path: string; constructor(path: string) { this.path = path; } },
  Notice: class { constructor(message: string, timeout?: number) { notices.push([String(message), timeout]); } },
  normalizePath: (path: string) => path,
}));
vi.mock("../src/ui/modals", () => ({
  SpeakerNameConfirmModal: class {
    args: unknown[];
    constructor(...args: unknown[]) { this.args = args; modalArgs.push(args); }
    open() { modalOpen(); queueMicrotask(() => modalResult(this.args[5] as (value: Record<string, string> | null) => void)); }
  },
}));

import * as obsidian from "obsidian";
import { SessionFinalizeService } from "../src/notes/session-finalize-service";
import { NS_FM_SPEAKERS } from "../src/shared/namespace";
import { t } from "../src/shared/i18n";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import { readTranscriptBlocks } from "../src/transcript/transcript-markdown";

function makeFixture(options: { frontmatter?: Record<string, unknown> | null; file?: boolean; content?: string } = {}) {
  const file = options.file === false ? null : new obsidian.TFile("Notes/speakers.md");
  let content = options.content ?? "[说话人1] 负责产品方案。\n[说话人2] 确认预算。";
  const frontmatter = options.frontmatter ?? {};
  const progress: unknown[] = [];
  const diagnostics: unknown[][] = [];
  const host = {
    app: {
      vault: {
        getAbstractFileByPath: vi.fn(() => file),
        read: vi.fn(async () => content),
        modify: vi.fn(async (_file, next) => { content = next; }),
      },
      metadataCache: { getFileCache: vi.fn(() => ({ frontmatter })) },
      fileManager: { processFrontMatter: vi.fn(async (_file, update) => { update(frontmatter); }) },
    },
    settings: { activeTranscribeProvider: "siliconflow", transcribeProviders: {} },
    profiles: { getTranscribeProviderProfile: vi.fn(() => undefined) },
    asrPipeline: { setSessionWorkProgress: vi.fn((_session, patch) => progress.push(patch)) },
    diagnostics: { logDiagnostic: vi.fn(async (...args) => { diagnostics.push(args); }) },
    requestOutlineRefresh: vi.fn(),
  };
  const session = { id: "s1", mdPath: "Notes/speakers.md", speakerChannels: undefined } as never;
  const segments = [
    { index: 0, text: "[说话人1] 负责产品方案。" },
    { index: 1, text: "[说话人2] 确认预算。" },
  ] as never[];
  const service = new SessionFinalizeService(host as never);
  return { host, session, segments, service, progress, diagnostics, file, getContent: () => content, getFrontmatter: () => frontmatter };
}

const NAMED = {
  "spk-1": { id: "spk-1", channel: 1, label: "说话人1", personName: "张三" },
  "spk-2": { id: "spk-2", channel: 2, label: "说话人2", personName: "李四" },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  modalArgs.length = 0;
  notices.length = 0;
  modalResult.mockImplementation((done) => done({ "spk-1": "张三", "spk-2": "李四" }));
});

describe("known speaker names are applied without prompting", () => {
  it("returns the original segments when fewer than two candidates exist", async () => {
    const f = makeFixture();
    const segments = [{ text: "普通对话，没有说话人标记" }] as never[];
    const result = await f.service.applyKnownSpeakerNamesBeforeFinal(f.session, segments);
    expect(result).toEqual({ segments, frontmatter: null });
    expect(f.host.app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
    expect(modalOpen).not.toHaveBeenCalled();
  });

  it("returns without opening a modal when the note is absent or not a TFile", async () => {
    const f = makeFixture({ file: false });
    const result = await f.service.applyKnownSpeakerNamesBeforeFinal(f.session, f.segments);
    expect(result).toEqual({ segments: f.segments, frontmatter: null });
    expect(modalOpen).not.toHaveBeenCalled();
  });

  it("never opens the naming modal for unnamed speakers and leaves the note and ledger untouched", async () => {
    const f = makeFixture();
    const result = await f.service.applyKnownSpeakerNamesBeforeFinal(f.session, f.segments);
    expect(modalOpen).not.toHaveBeenCalled();
    expect(f.progress).toEqual([]);
    expect(f.host.requestOutlineRefresh).not.toHaveBeenCalled();
    expect(f.host.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(f.host.app.vault.modify).not.toHaveBeenCalled();
    expect(f.getContent()).toBe("[说话人1] 负责产品方案。\n[说话人2] 确认预算。");
    expect(result.segments).toEqual(f.segments);
    expect(result.frontmatter).toBeNull();
  });

  it("completes with three unnamed speakers without calling promptSpeakerNames", async () => {
    const texts = ["[说话人1] 讨论产品。", "[说话人2] 确认预算。", "[说话人3] 安排排期。"];
    const f = makeFixture({ content: texts.join("\n") });
    const segments = texts.map((text, index) => ({ index, text })) as never[];
    const result = await f.service.applyKnownSpeakerNamesBeforeFinal(f.session, segments);
    expect(modalOpen).not.toHaveBeenCalled();
    expect(modalArgs).toHaveLength(0);
    expect(result.segments.map((segment) => segment.text)).toEqual(texts);
    expect(f.progress).toEqual([]);
    expect(f.getContent()).toBe(texts.join("\n"));
  });

  it("applies names already confirmed in properties or channels before organizing", async () => {
    const f = makeFixture();
    f.session.speakerChannels = NAMED;
    const result = await f.service.applyKnownSpeakerNamesBeforeFinal(f.session, f.segments);
    expect(modalOpen).not.toHaveBeenCalled();
    expect(f.host.app.fileManager.processFrontMatter).toHaveBeenCalledOnce();
    const mappings = f.getFrontmatter()[NS_FM_SPEAKERS] as Record<string, { personName?: string }>;
    expect(mappings["spk-1"]?.personName).toBe("张三");
    expect(mappings["spk-2"]?.personName).toBe("李四");
    expect(f.host.app.vault.modify).toHaveBeenCalledOnce();
    expect(f.getContent()).toContain("**张三：**");
    expect(f.getContent()).toContain("**李四：**");
    expect(result.segments[0].text).toContain("[张三]");
    expect(result.frontmatter).toEqual({ [NS_FM_SPEAKERS]: mappings });
    expect(f.diagnostics.some((call) => call[1] === "speaker.names_persisted" && (call[3] as { replacements: number }).replacements === 2)).toBe(true);
  });

  it("applies the named speakers and keeps the others numbered when only some are named", async () => {
    const f = makeFixture();
    f.session.speakerChannels = { "spk-1": NAMED["spk-1"] } as never;
    const result = await f.service.applyKnownSpeakerNamesBeforeFinal(f.session, f.segments);
    expect(modalOpen).not.toHaveBeenCalled();
    expect(result.segments[0].text).toContain("[张三]");
    expect(result.segments[1].text).toContain("[说话人2]");
    expect(f.getContent()).toContain("**张三：**");
    expect(f.getContent()).toContain("[说话人2]");
  });

  it("normalizes a legacy grouped transcript when confirmed speaker names rewrite the note", async () => {
    const segment = attachTextTranscript({ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "原始转写文本。" }, "speaker-layout-fixture", "text-import");
    const { transcript, ...storedSegment } = segment;
    const id = transcript!.id;
    const oldTranscript = [
      "<details><summary>分段原始转写（1 段）</summary>",
      "### 段落 1 (00:00–00:01)",
      `<!-- qnalog-transcript-start:${id} -->`,
      `<!-- qnalog-transcript-text-start:${id} -->`, "原始转写文本。",
      `<!-- qnalog-transcript-text-end:${id} -->`,
      `<!-- qnalog-transcript-data ${JSON.stringify({ schemaVersion: 2, segment: storedSegment, transcript })} -->`,
      `<!-- qnalog-transcript-end:${id} -->`, "</details>",
    ].join("\n");
    const f = makeFixture({ content: `[说话人1] 负责产品方案。\n${oldTranscript}` });
    f.session.speakerChannels = NAMED;
    await f.service.applyKnownSpeakerNamesBeforeFinal(f.session, f.segments);
    const rewritten = f.getContent();
    expect(rewritten).not.toMatch(/^\*\*(?:分段原始转写（\d+ 段）|Segmented raw transcript \(\d+ segments?\))\*\*$/m);
    expect(rewritten).toMatch(/<summary>(?:原始转写 · 段落|Raw transcript · Segment) 1 \(00:00–00:01\)<\/summary>/);
    expect(readTranscriptBlocks(rewritten).map((block) => block.visibleBlock)).toEqual(["原始转写文本。"]);
    expect(rewritten).not.toContain("<!-- qnalog-transcript-data ");
  });
  it("does not prompt when every candidate already has a saved name", async () => {
    const f = makeFixture();
    f.session.speakerChannels = {
      "spk-1": { id: "spk-1", channel: 1, label: "说话人1", personName: "张三" },
      "spk-2": { id: "spk-2", channel: 2, label: "说话人2", personName: "李四" },
    };
    await f.service.applyKnownSpeakerNamesBeforeFinal(f.session, f.segments);
    expect(modalOpen).not.toHaveBeenCalled();
    expect(f.progress).toHaveLength(0);
    expect(f.host.app.fileManager.processFrontMatter).toHaveBeenCalledOnce();
  });

  it("does not rewrite note text when no speaker label remains to replace", async () => {
    const f = makeFixture({ content: "The transcript body already uses names." });
    f.session.speakerChannels = NAMED;
    await f.service.applyKnownSpeakerNamesBeforeFinal(f.session, f.segments);
    expect(f.host.app.fileManager.processFrontMatter).toHaveBeenCalledOnce();
    expect(f.host.app.vault.read).toHaveBeenCalledOnce();
    expect(f.host.app.vault.modify).not.toHaveBeenCalled();
  });


  it("keeps confirmed names when updating the transcript body fails", async () => {
    const f = makeFixture();
    f.session.speakerChannels = NAMED;
    f.host.app.vault.read.mockRejectedValueOnce(new Error("read failed"));
    const result = await f.service.applyKnownSpeakerNamesBeforeFinal(f.session, f.segments);
    expect(f.host.app.fileManager.processFrontMatter).toHaveBeenCalledOnce();
    expect(f.session.speakerChannels).toEqual(f.getFrontmatter()[NS_FM_SPEAKERS]);
    expect(result.segments[0].text).toContain("[张三]");
    expect(f.diagnostics.some((call) => call[1] === "speaker.names_persist_failed")).toBe(true);
    expect(f.diagnostics.some((call) => call[1] === "speaker.names_persisted")).toBe(false);
    expect(notices).toContainEqual([t("Speaker names were saved, but the display names in the original transcript could not be updated; you can save again from the outline."), 8000]);
  });

  it("propagates frontmatter write failures without mutating session mappings", async () => {
    const f = makeFixture();
    f.session.speakerChannels = NAMED;
    const failure = new Error("frontmatter write failed");
    f.host.app.fileManager.processFrontMatter.mockRejectedValueOnce(failure);
    await expect(f.service.applyKnownSpeakerNamesBeforeFinal(f.session, f.segments)).rejects.toBe(failure);
    expect(f.session.speakerChannels).toEqual(NAMED);
    expect(f.host.app.vault.modify).not.toHaveBeenCalled();
  });
});
