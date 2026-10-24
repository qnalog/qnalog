import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class { path: string; constructor(path = "") { this.path = path; } },
  Notice: class {},
  normalizePath: (path: string) => path,
}));

import * as obsidian from "obsidian";
import { applySpeakerNames, findUnnamedSpeakerIds, offerSpeakerNaming, promptAndApplySpeakerNames } from "../src/notes/speaker-naming";
import type { SpeakerNamingPort } from "../src/notes/speaker-naming";
import { NS_FM_SPEAKERS } from "../src/shared/namespace";
import { attachTranscriptResult, getCurrentTranscript } from "../src/transcript/session-transcript";
import { readTranscriptBlocks, serializeTranscriptBlock } from "../src/transcript/transcript-markdown";

function transcriptBlock(index: number, speaker: 1 | 2, raw: string, visible: string): string {
  const display = `[说话人${speaker}] ${visible}`;
  const segment = attachTranscriptResult({ index, startOffsetMs: index * 1000, endOffsetMs: index * 1000 + 900, text: display }, "session-naming", {
    text: display,
    rawText: null,
    providerId: "test-asr",
    units: [{
      rawText: raw,
      normalizedText: display,
      speakerId: `channel:spk-${speaker}`,
      speakerName: `说话人${speaker}`,
      startMs: index * 1000,
      endMs: index * 1000 + 900,
      timing: "audio-span",
    }],
  }, "asr");
  return serializeTranscriptBlock(segment, `### Segment ${index + 1}`, display);
}

const ORGANIZED_BODY = [
  "## 摘要",
  "说话人1提出预算方案，说话人2回顾了排期。",
  "",
  "## 待办",
  "- 说话人2 确认供应商",
  "",
  "## 原始材料",
].join("\n");

function makeNote(extraFrontmatter = ""): string {
  return `---\ntitle: 会议\n${extraFrontmatter}---\n\n${ORGANIZED_BODY}\n\n${transcriptBlock(0, 1, "预算 方案", "预算方案已定。")}\n\n${transcriptBlock(1, 2, "排期 回顾", "排期需要回顾。")}\n`;
}

function makePort(initial: string, options: { frontmatter?: Record<string, unknown> } = {}) {
  const file = new obsidian.TFile("Notes/meeting.md");
  let content = initial;
  const frontmatter: Record<string, unknown> = options.frontmatter ?? {};
  const calls: string[] = [];
  const diagnostics: string[] = [];
  const notices: string[] = [];
  const prompts: Array<{ message: string; actionLabel: string; onAction: () => void }> = [];
  const modify = vi.fn(async (_file: unknown, next: string) => { calls.push("modify"); content = next; });
  const port: SpeakerNamingPort = {
    getVault: () => ({
      getAbstractFileByPath: vi.fn(() => file),
      read: vi.fn(async () => content),
      modify,
    }) as never,
    readFrontmatter: vi.fn(async () => frontmatter),
    writeSpeakerFrontmatter: vi.fn(async (_file, mappings) => { calls.push("frontmatter"); frontmatter[NS_FM_SPEAKERS] = mappings; }),
    promptSpeakerNames: vi.fn(async () => ({ "spk-1": "张三", "spk-2": "李四" })),
    showPrompt: vi.fn((message, actionLabel, onAction) => { prompts.push({ message, actionLabel, onAction }); }),
    notify: vi.fn((message) => { notices.push(message); }),
    resetNotePanelCache: vi.fn(),
    requestOutlineRefresh: vi.fn(),
    logDiagnostic: vi.fn(async (_level, code) => { diagnostics.push(code); }),
  };
  return { port, file, modify, frontmatter, calls, diagnostics, notices, prompts, getContent: () => content, setContent: (next: string) => { content = next; } };
}

function ledgerOf(markdown: string) {
  return readTranscriptBlocks(markdown).map((block) => {
    const unit = getCurrentTranscript(block.segment.transcript!).utterances[0];
    return { rawText: unit.rawText, speakerId: unit.speakerId, id: unit.id };
  });
}

describe("naming speakers after organizing", () => {
  it("finds speakers without a saved name", () => {
    const note = makeNote();
    expect(findUnnamedSpeakerIds(note, {})).toEqual(["spk-1", "spk-2"]);
    expect(findUnnamedSpeakerIds(note, { [NS_FM_SPEAKERS]: { "spk-1": { id: "spk-1", channel: 1, label: "说话人1", personName: "张三" } } })).toEqual(["spk-2"]);
  });

  it("writes properties, transcript display names and the whole organized body, leaving the ledger and raw text unchanged", async () => {
    const f = makePort(makeNote());
    const ledgerBefore = ledgerOf(f.getContent());
    const result = await applySpeakerNames(f.port, f.file, { "spk-1": { personName: "张三" }, "spk-2": { personName: "李四" } });

    expect(result.bodyUpdated).toBe(true);
    expect(result.bodyError).toBeUndefined();
    expect(f.calls).toEqual(["frontmatter", "modify"]);
    const mappings = f.frontmatter[NS_FM_SPEAKERS] as Record<string, { personName?: string }>;
    expect(mappings["spk-1"]?.personName).toBe("张三");
    expect(mappings["spk-2"]?.personName).toBe("李四");

    const body = f.getContent();
    expect(body).toContain("**张三：**");
    expect(body).toContain("**李四：**");
    // The summary and to-do sections (outside the transcript) no longer show the numbered names.
    const organized = body.slice(0, body.indexOf("## 原始材料"));
    expect(organized).not.toMatch(/说话人\s*\d/);
    expect(organized).toContain("张三");
    expect(organized).toContain("李四");
    // Transcript display names follow; the ledger identity and ASR text do not change.
    const after = readTranscriptBlocks(body);
    expect(after.map((block) => getCurrentTranscript(block.segment.transcript!).utterances[0].speakerName)).toEqual(["张三", "李四"]);
    expect(ledgerOf(body)).toEqual(ledgerBefore);
    // A second round (renaming again) still finds the same speaker through the stable anchors.
    const second = await applySpeakerNames(f.port, f.file, { "spk-1": { personName: "王五" } });
    expect(second.bodyUpdated).toBe(true);
    expect(f.getContent()).toContain("**王五：**");
    expect(f.getContent()).not.toContain("张三");
    expect(ledgerOf(f.getContent())).toEqual(ledgerBefore);
  });

  it("does not write anything when no name is entered", async () => {
    const f = makePort(makeNote());
    const result = await applySpeakerNames(f.port, f.file, { "spk-1": { personName: "  " }, "not-an-id": { personName: "x" } });
    expect(result).toEqual({ named: 0, replacements: 0, bodyUpdated: false });
    expect(f.calls).toEqual([]);
  });

  it("leaves the note unchanged when the user cancels the modal", async () => {
    const f = makePort(makeNote());
    vi.mocked(f.port.promptSpeakerNames).mockResolvedValueOnce(null);
    const before = f.getContent();
    expect(await promptAndApplySpeakerNames(f.port, f.file)).toBeNull();
    expect(f.getContent()).toBe(before);
    expect(f.calls).toEqual([]);
    expect(f.port.writeSpeakerFrontmatter).not.toHaveBeenCalled();
  });

  it("applies the names entered in the modal and reports the count", async () => {
    const f = makePort(makeNote());
    const result = await promptAndApplySpeakerNames(f.port, f.file);
    expect(result).toMatchObject({ named: 2, bodyUpdated: true });
    expect(f.port.promptSpeakerNames).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "spk-1" }), expect.objectContaining({ id: "spk-2" })],
      expect.any(Object),
      { unstableAcrossSegments: false },
    );
    expect(f.notices).toHaveLength(1);
  });

  it("keeps the saved properties and reports when the body cannot be written", async () => {
    const f = makePort(makeNote());
    f.modify.mockRejectedValueOnce(new Error("disk full"));
    const result = await applySpeakerNames(f.port, f.file, { "spk-1": { personName: "张三" }, "spk-2": { personName: "李四" } });
    expect(result.bodyUpdated).toBe(false);
    expect(result.bodyError).toBe("disk full");
    expect((f.frontmatter[NS_FM_SPEAKERS] as Record<string, { personName?: string }>)["spk-1"]?.personName).toBe("张三");
    expect(f.diagnostics).toContain("speaker.names_persist_failed");
    expect(f.diagnostics).not.toContain("speaker.names_persisted");
    expect(f.notices).toHaveLength(1);
    // The note body still has the numbers, so naming again can finish the job.
    expect(f.getContent()).toContain("说话人1");
    const retry = await applySpeakerNames(f.port, f.file, { "spk-1": { personName: "张三" }, "spk-2": { personName: "李四" } });
    expect(retry.bodyUpdated).toBe(true);
    expect(f.getContent()).not.toMatch(/说话人\s*\d/);
  });

  it("does not touch the body when writing properties fails", async () => {
    const f = makePort(makeNote());
    vi.mocked(f.port.writeSpeakerFrontmatter).mockRejectedValueOnce(new Error("frontmatter failed"));
    await expect(applySpeakerNames(f.port, f.file, { "spk-1": { personName: "张三" } })).rejects.toThrow("frontmatter failed");
    expect(f.modify).not.toHaveBeenCalled();
  });
});

describe("prompt after the note is written", () => {
  it("shows a prompt without opening the modal when two speakers are unnamed", async () => {
    const f = makePort(makeNote());
    expect(await offerSpeakerNaming(f.port, f.file.path)).toBe(true);
    expect(f.prompts).toHaveLength(1);
    expect(f.port.promptSpeakerNames).not.toHaveBeenCalled();
    expect(f.getContent()).toBe(makeNote());
    // The modal opens only when the user presses the action.
    f.prompts[0].onAction();
    await vi.waitFor(() => expect(f.port.promptSpeakerNames).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.calls).toEqual(["frontmatter", "modify"]));
  });

  it("shows no prompt when fewer than two speakers are unnamed", async () => {
    const named = { [NS_FM_SPEAKERS]: { "spk-1": { id: "spk-1", channel: 1, label: "说话人1", personName: "张三" } } };
    const f = makePort(makeNote(), { frontmatter: named });
    expect(await offerSpeakerNaming(f.port, f.file.path)).toBe(false);
    expect(f.prompts).toHaveLength(0);
  });
});
